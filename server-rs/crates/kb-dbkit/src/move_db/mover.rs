//! `Mover`: one move from a source to a target (check, make the tables, copy).

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Instant;

use futures::StreamExt;
use futures::future::BoxFuture;
use kb_db::entities::{ColumnMeta, META, TableMeta};
use kb_db::schema::{self, SchemaState};
use kb_db::sea_orm::{
    ConnectionTrait, DatabaseConnection, DatabaseTransaction, DbBackend, DbErr, Statement, TransactionTrait,
    Value as DbValue,
};
use kb_db::targets::{self, Target};
use kb_db::changes;
use serde::Serialize;
use serde_json::{Map, Value, json};

use super::defaults::{DEFAULTS, Default as ModelDefault};
use super::errors::{Error, MoveError, Stop, clean_error, error_column};
use super::raw::{self, Direct, Reader, Sea, quote};
use super::values::{Cell, coerce, commas, row_bytes};

pub const BATCH_ROWS: usize = 1000;
pub const BATCH_BYTES: usize = 4 * 1024 * 1024;
pub const SAMPLE_ROWS: usize = 500;
pub const FTS_TABLES: [&str; 3] = ["docs_fts", "ai_run_fts", "kb_fts"];
pub const NOT_COPIED: [&str; 3] = ["alembic_version", changes::TABLE, "sqlite_sequence"];

/// What a copy reports as it goes.
#[derive(Debug, Clone, PartialEq)]
pub enum Event {
    /// A table is about to be copied (`{"type": "table"}`).
    Table { table: &'static str, index: usize },
    /// A table is complete (`{"type": "table_done"}`).
    TableDone { table: &'static str, rows: i64 },
    /// A batch went in (`{"type": "rows"}`).
    Rows { table: &'static str, copied: i64, rows: i64 },
}

/// Who hears the copy's progress.
pub type Progress = Arc<dyn Fn(Event) -> BoxFuture<'static, ()> + Send + Sync>;

/// One table's progress.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct TableState {
    pub name: &'static str,
    pub rows: i64,
    pub copied: i64,
    /// waiting | copying | done | stopped
    pub state: &'static str,
}

impl TableState {
    fn new(name: &'static str) -> Self {
        Self { name, rows: 0, copied: 0, state: "waiting" }
    }
}

/// Step 2: what will be copied, and what to expect.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Plan {
    pub source: Map<String, Value>,
    pub target: Map<String, Value>,
    pub tables: Vec<TableState>,
    pub rows: i64,
    pub extra_tables: Vec<String>,
    pub notes: Vec<Value>,
    pub problems: Vec<Value>,
}

impl Plan {
    /// For the API.
    pub fn as_dict(&self) -> Map<String, Value> {
        let mut out = match serde_json::to_value(self) {
            Ok(Value::Object(map)) => map,
            _ => Map::new(),
        };
        out.insert("tables_count".into(), json!(self.tables.len()));
        out
    }
}

/// The app's tables, parents before children (the copy order).
pub fn app_tables() -> &'static [TableMeta] {
    META
}

/// The value the Python model gives a required column of a new row, when it is a plain value (`c.default.arg` where
/// `c.default.is_scalar`): what a copy fills in where a source row has none.
pub fn model_default(table: &str, column: &str) -> Option<Cell> {
    DEFAULTS.iter().find(|(t, name, _)| *t == table && *name == column).map(|(_, _, default)| match default {
        ModelDefault::Bool(b) => Cell::Bool(*b),
        ModelDefault::Int(n) => Cell::Int(*n),
        ModelDefault::Float(f) => Cell::Float(*f),
        ModelDefault::Str(s) => Cell::Text((*s).to_string()),
    })
}

/// The columns of a table's primary key.
pub(crate) fn primary_key(table: &TableMeta) -> Vec<&'static ColumnMeta> {
    table.columns.iter().filter(|c| c.primary_key).collect()
}

/// The primary key of a table whose key is one whole number the database counts up itself.
pub(crate) fn serial_key(table: &TableMeta) -> Option<&'static ColumnMeta> {
    match primary_key(table).as_slice() {
        [only] if only.kind == "int" || only.kind == "bigint" => Some(*only),
        _ => None,
    }
}

/// "a, b, c" with each name quoted for the engine.
pub(crate) fn column_list(backend: DbBackend, table: &TableMeta) -> String {
    table.columns.iter().map(|c| quote(backend, c.name)).collect::<Vec<_>>().join(", ")
}

/// The target and what people call it, for the API.
pub(crate) fn described(target: &Target) -> Map<String, Value> {
    let mut out = target.public();
    out.insert("label".into(), json!(target.label()));
    out.insert("display".into(), json!(target.display()));
    out
}

/// `database._run_upgrade` on a file the copy makes: a new file gets the tables of the newest migration, an older
/// board its pending migrations.
pub(crate) async fn run_upgrade<C: ConnectionTrait>(conn: &C) -> Result<(), Error> {
    let state = schema::schema_state(conn).await?;
    if state.state == "empty" {
        schema::create_schema(conn).await?;
        return Ok(());
    }
    schema::restamp_legacy_revision(conn).await?;
    kb_db::migrations::upgrade(conn).await.map_err(|err| Error::Other(err.to_string()))
}

/// Remove a SQLite file and what SQLite keeps next to it.
pub(crate) fn remove_sqlite_file(path: &str) {
    for suffix in ["", "-wal", "-shm"] {
        let _ = std::fs::remove_file(PathBuf::from(format!("{path}{suffix}")));
    }
}

/// Why a table's copy ended early (inside `copy_rows`, before the stop is described).
enum CopyFail {
    /// One row would not go in: how many went in before it, the row, and what the database said.
    Row { copied: i64, values: Vec<Cell>, err: DbErr },
    Other(Error),
}

impl From<DbErr> for CopyFail {
    fn from(err: DbErr) -> Self {
        CopyFail::Other(Error::Db(err))
    }
}

/// One move from `source` to `target`. Open it with `open`, and `close` it when done.
pub struct Mover {
    pub source: Target,
    pub target: Target,
    on_progress: Option<Progress>,
    pub batch_rows: usize,
    /// The pools of both ends, made when they are first used (making a pool of a SQLite file opens the file).
    src: Option<DatabaseConnection>,
    dst: Option<DatabaseConnection>,
    pub(crate) snap: Option<Direct>,
    tables: Arc<Mutex<Vec<TableState>>>,
    /// Set: stop at the next batch (pause or cancel).
    paused: Arc<AtomicBool>,
    stop_reason: Arc<Mutex<Option<&'static str>>>,
    pub(crate) started: Option<Instant>,
    pub created_target: bool,
}

impl Mover {
    /// Name both ends; nothing is opened yet.
    pub async fn new(source: Target, target: Target, on_progress: Option<Progress>) -> Result<Mover, Error> {
        if source.display() == target.display() && source.engine == target.engine {
            return Err(MoveError::new("same", "The source and the target are the same database.").into());
        }
        Ok(Mover {
            source,
            target,
            on_progress,
            batch_rows: BATCH_ROWS,
            src: None,
            dst: None,
            snap: None,
            tables: Arc::new(Mutex::new(app_tables().iter().map(|t| TableState::new(t.name)).collect())),
            paused: Arc::new(AtomicBool::new(false)),
            stop_reason: Arc::new(Mutex::new(None)),
            started: None,
            created_target: false,
        })
    }

    /// The source's pool (`self.src`).
    pub(crate) async fn src(&mut self) -> Result<DatabaseConnection, Error> {
        if self.src.is_none() {
            self.src = Some(targets::make_engine(&self.source, Some("copy")).await?);
        }
        self.src.clone().ok_or_else(|| Error::Other("The source is not open.".into()))
    }

    /// The target's pool (`self.dst`).
    pub(crate) async fn dst(&mut self) -> Result<DatabaseConnection, Error> {
        if self.dst.is_none() {
            self.dst = Some(targets::make_engine(&self.target, Some("copy")).await?);
        }
        self.dst.clone().ok_or_else(|| Error::Other("The target is not open.".into()))
    }

    /// Read the source from one consistent moment.
    pub async fn open(&mut self) -> Result<(), Error> {
        if self.snap.is_none() {
            let src = self.src().await?;
            self.snap = Some(raw::snapshot(&src).await?);
        }
        Ok(())
    }

    /// Let go of both databases.
    pub async fn close(&mut self) {
        if let Some(snap) = self.snap.take() {
            snap.close().await;
        }
        if let Some(src) = self.src.take() {
            let _ = src.close().await;
        }
        if let Some(dst) = self.dst.take() {
            let _ = dst.close().await;
        }
    }

    /// Stop reading the source (a long read transaction keeps SQLite's WAL from shrinking); `open` reads again.
    pub async fn release(&mut self) {
        if let Some(snap) = self.snap.take() {
            snap.close().await;
        }
    }

    /// Read the source as it is now (a new snapshot), e.g. before resuming.
    pub async fn refresh(&mut self) -> Result<(), Error> {
        if let Some(snap) = self.snap.take() {
            snap.close().await;
        }
        self.open().await
    }

    /// Per-table progress, as it is now.
    pub fn tables(&self) -> Vec<TableState> {
        self.with_tables(|tables| tables.clone())
    }

    /// The per-table progress itself, readable while the copy runs in another task.
    pub fn tables_handle(&self) -> Arc<Mutex<Vec<TableState>>> {
        self.tables.clone()
    }

    /// The flag that stops the copy at the next batch, settable while the copy runs in another task.
    pub fn paused_handle(&self) -> Arc<AtomicBool> {
        self.paused.clone()
    }

    /// Why the copy was asked to stop ("pause" or "cancel"), settable while the copy runs in another task.
    pub fn stop_reason_handle(&self) -> Arc<Mutex<Option<&'static str>>> {
        self.stop_reason.clone()
    }

    /// `self.paused.is_set()`.
    pub fn is_paused(&self) -> bool {
        self.paused.load(Ordering::SeqCst)
    }

    /// `self.stop_reason`.
    pub fn stop_reason(&self) -> Option<&'static str> {
        *self.stop_reason.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub(crate) fn with_tables<T>(&self, f: impl FnOnce(&mut Vec<TableState>) -> T) -> T {
        f(&mut self.tables.lock().unwrap_or_else(|e| e.into_inner()))
    }

    async fn emit(&self, event: Event) {
        if let Some(on_progress) = &self.on_progress {
            on_progress(event).await;
        }
    }

    pub(crate) fn snap(&mut self) -> Result<&mut Direct, Error> {
        self.snap.as_mut().ok_or_else(|| Error::Other("The source is not open.".into()))
    }

    /// `engine.dispose()` of the target: every connection is closed, and the next use opens new ones (`remove` also
    /// removes a SQLite file, once nothing holds it open).
    async fn dispose_dst(&mut self, remove: bool) {
        if let Some(dst) = self.dst.take() {
            let _ = dst.close().await;
        }
        if remove {
            remove_sqlite_file(&self.target.path);
        }
    }

    // -- step 2: check ----------------------------------------------------

    async fn source_state(&mut self) -> Result<SchemaState, Error> {
        let state = raw::schema_state(self.snap()?).await?;
        if state.state != "board" {
            return Err(MoveError::new("source", "The source does not hold a Kanban board.")
                .with("state", raw::state_json(&state))
                .into());
        }
        let head = schema::head_revision();
        if state.revision.as_deref() != Some(head) {
            return Err(MoveError::new(
                "source",
                "The source is not at the newest migration. Open it with this version of the app once (it updates \
                 it), then copy it.",
            )
            .with("revision", json!(state.revision))
            .with("head", head)
            .into());
        }
        Ok(state)
    }

    /// What the copy will do: per-table rows, what stays behind, and values the target will not take.
    pub async fn plan(&mut self) -> Result<Plan, Error> {
        self.source_state().await?;
        let names = raw::table_names(self.snap()?).await?;
        let mut total = 0;
        for (i, t) in app_tables().iter().enumerate() {
            if !names.iter().any(|n| n == t.name) {
                return Err(MoveError::new("source", format!("The source has no table {}.", t.name))
                    .with("table", t.name)
                    .into());
            }
            let rows = raw::count(self.snap()?, t.name).await?;
            self.with_tables(|tables| tables[i].rows = rows);
            total += rows;
        }
        let mut extra: Vec<String> = names
            .iter()
            .filter(|n| {
                !app_tables().iter().any(|t| t.name == n.as_str())
                    && !NOT_COPIED.contains(&n.as_str())
                    && !FTS_TABLES.iter().any(|f| n.as_str() == *f || n.starts_with(&format!("{f}_")))
            })
            .cloned()
            .collect();
        extra.sort();
        let tables = self.tables();
        let counted = |name: &str| tables.iter().find(|s| s.name == name).map(|s| s.rows).unwrap_or(0);
        let size = if self.source.is_sqlite() {
            std::fs::metadata(&self.source.path).ok().map(|m| m.len())
        } else {
            None
        };
        let mut source = described(&self.source);
        source.insert("size".into(), json!(size));
        source.insert("tables".into(), json!(tables.len()));
        source.insert("rows".into(), json!(total));
        source.insert("tickets".into(), json!(counted("ticket")));
        source.insert("projects".into(), json!(counted("project")));
        source.insert("ai_members".into(), json!(counted("ai_team")));
        source.insert("at_head".into(), json!(true));
        let mut plan = Plan {
            source,
            target: described(&self.target),
            tables,
            rows: total,
            extra_tables: extra.clone(),
            notes: Vec::new(),
            problems: Vec::new(),
        };
        if !extra.is_empty() {
            plan.notes.push(json!({
                "key": "extra",
                "title": format!("{} table(s) are not part of the app and are not copied", extra.len()),
                "detail": extra.iter().take(10).cloned().collect::<Vec<_>>().join(", "),
            }));
        }
        if self.target.is_sqlite() {
            plan.notes.push(json!({
                "key": "search",
                "title": "Docs search is rebuilt",
                "detail": "The search index is built again on the new file after the copy.",
            }));
        } else {
            plan.notes.push(json!({
                "key": "search",
                "title": "Docs and history search use the plain search",
                "detail": format!(
                    "The full-text index is a SQLite feature; on {} search reads the \
                     pages themselves (the same results, slower on very large boards).",
                    self.target.label()
                ),
            }));
        }
        plan.problems = self.scan().await?;
        Ok(plan)
    }

    /// Values the target cannot take as they are, found before anything is written: text longer than 255 characters
    /// in a key or indexed column on MySQL (VARCHAR(255) there), and empty values in columns the app declares
    /// required.
    pub async fn scan(&mut self) -> Result<Vec<Value>, Error> {
        let mut problems = Vec::new();
        let to_mysql = self.target.engine == "mysql";
        let states = self.tables();
        for (t, state) in app_tables().iter().zip(states) {
            if state.rows == 0 {
                continue;
            }
            let backend = self.snap()?.backend();
            let integer = if backend == DbBackend::MySql { "SIGNED INTEGER" } else { "INTEGER" };
            let mut exprs = Vec::new();
            let mut labels = Vec::new();
            for c in t.columns {
                let name = quote(backend, c.name);
                if !c.nullable && !c.primary_key {
                    exprs.push(format!("sum(coalesce(CAST({name} IS NULL AS {integer}), 0))"));
                    labels.push(("null", c));
                }
                // a string column that stays VARCHAR(255) on MySQL (keys and indexed columns)
                if to_mysql && c.kind == "str" && !c.long_text {
                    exprs.push(format!("max(length({name}))"));
                    labels.push(("long", c));
                }
            }
            if exprs.is_empty() {
                continue;
            }
            let statement = format!("SELECT {} FROM {}", exprs.join(", "), quote(backend, t.name));
            let row = self.snap()?.rows(&statement, Vec::new()).await?.into_iter().next().unwrap_or_default();
            for ((kind, c), value) in labels.into_iter().zip(row) {
                let value = value.as_i64().unwrap_or(0);
                if kind == "null" && value != 0 {
                    problems.push(json!({
                        "key": format!("null:{}.{}", t.name, c.name),
                        "level": "warn",
                        "table": t.name,
                        "column": c.name,
                        "count": value,
                        "title": format!("{value} row(s) of {} have no {}", t.name, c.name),
                        "detail": "The app requires a value there; the copy fills in the app's default where it \
                                   has one, and otherwise stops at that row.",
                    }));
                }
                if kind == "long" && value > 255 {
                    problems.push(json!({
                        "key": format!("long:{}.{}", t.name, c.name),
                        "level": "warn",
                        "table": t.name,
                        "column": c.name,
                        "length": value,
                        "title": format!("{}.{} holds text of {} characters", t.name, c.name, commas(value)),
                        "detail": "On MySQL this column is VARCHAR(255) because it is indexed; the copy will stop \
                                   there unless the column is widened first.",
                    }));
                }
            }
        }
        Ok(problems)
    }

    // -- the target --------------------------------------------------------

    /// What the target holds now.
    pub async fn target_state(&mut self) -> Result<SchemaState, Error> {
        let mut conn = Direct::connect(&self.dst().await?).await?;
        let state = raw::schema_state(&mut conn).await;
        conn.close().await;
        Ok(state?)
    }

    /// Make the app's tables on the target. A target that holds anything is refused unless `empty_first` (delete it
    /// all) or `resume` (our own tables from an interrupted copy).
    pub async fn prepare_target(&mut self, empty_first: bool, resume: bool) -> Result<(), Error> {
        let state = self.target_state().await?;
        if state.state == "board" {
            if let Some(revision) = state.revision.as_deref().filter(|r| !r.is_empty()) {
                if !schema::known_revision(revision) {
                    return Err(MoveError::new(
                        "newer",
                        "The target was made by a newer version of the app; the board will not touch it.",
                    )
                    .with("state", raw::state_json(&state))
                    .into());
                }
            }
        }
        if state.state != "empty" {
            if resume && state.state == "board" {
                return Ok(());
            }
            if !empty_first {
                return Err(MoveError::new(
                    "target_not_empty",
                    format!("The target already has {} tables.", state.tables),
                )
                .with("state", raw::state_json(&state))
                .into());
            }
            self.empty_target().await?;
        }
        self.create_target().await?;
        self.created_target = true;
        Ok(())
    }

    /// Delete every table on the target (after the person typed its name), or the SQLite file.
    pub async fn empty_target(&mut self) -> Result<(), Error> {
        self.dispose_dst(self.target.is_sqlite()).await;
        if self.target.is_sqlite() {
            return Ok(());
        }
        let dst = self.dst().await?;
        let mut conn = Direct::connect(&dst).await?;
        let names = raw::table_names(&mut conn).await;
        conn.close().await;
        let names = names?;
        let txn = dst.begin().await?;
        if self.target.engine == "mysql" {
            txn.execute_unprepared("SET FOREIGN_KEY_CHECKS = 0").await?;
            for name in &names {
                txn.execute_unprepared(&format!("DROP TABLE IF EXISTS `{name}`")).await?;
            }
            txn.execute_unprepared("SET FOREIGN_KEY_CHECKS = 1").await?;
        } else {
            for name in &names {
                txn.execute_unprepared(&format!("DROP TABLE IF EXISTS \"{name}\" CASCADE")).await?;
            }
        }
        txn.commit().await?;
        Ok(())
    }

    pub(crate) async fn create_target(&mut self) -> Result<(), Error> {
        if self.target.is_sqlite() {
            if let Some(parent) = Path::new(&self.target.path).parent() {
                std::fs::create_dir_all(parent)?;
            }
            let dst = self.dst().await?;
            dst.execute_unprepared("PRAGMA journal_mode=WAL").await?;
            let txn = dst.begin().await?;
            run_upgrade(&txn).await?;
            txn.commit().await?;
            return Ok(());
        }
        let dst = self.dst().await?;
        // a server that is away says so at once
        Direct::connect(&dst).await?.close().await;
        let txn = dst.begin().await?;
        schema::create_schema(&txn).await?;
        txn.commit().await?;
        Ok(())
    }

    /// Undo a copy that was cancelled: the tables it made on the target (or the SQLite file) go.
    pub async fn clear_target(&mut self) -> Result<(), Error> {
        self.dispose_dst(self.target.is_sqlite()).await;
        if self.target.is_sqlite() {
            return Ok(());
        }
        let dst = self.dst().await?;
        let backend = dst.get_database_backend();
        Direct::connect(&dst).await?.close().await;
        let txn = dst.begin().await?;
        let ours = app_tables().iter().rev().map(|t| t.name).chain(["alembic_version", changes::TABLE]);
        for name in ours {
            txn.execute_unprepared(&format!("DROP TABLE IF EXISTS {}", quote(backend, name))).await?;
        }
        txn.commit().await?;
        Ok(())
    }

    // -- step 3: copy ------------------------------------------------------

    /// Copy every table (from `start_at`, or just `only`). Fails with `Error::Stopped` when a value will not go in;
    /// returns early with the stop reason set when paused or cancelled.
    pub async fn copy(&mut self, start_at: Option<&str>, only: Option<&[&str]>) -> Result<(), Error> {
        self.started = self.started.or_else(|| Some(Instant::now()));
        if !self.with_tables(|tables| tables.iter().any(|s| s.rows != 0)) {
            self.plan().await?;
        }
        let begin = start_at.and_then(|name| app_tables().iter().position(|t| t.name == name)).unwrap_or(0);
        for (i, table) in app_tables().iter().enumerate() {
            match only {
                Some(only) => {
                    if !only.contains(&table.name) {
                        continue;
                    }
                }
                None => {
                    if i < begin {
                        self.with_tables(|tables| {
                            tables[i].state = "done";
                            tables[i].copied = tables[i].rows;
                        });
                        continue;
                    }
                }
            }
            if self.is_paused() {
                return Ok(());
            }
            self.copy_table(table, i).await?;
            if self.is_paused() && self.with_tables(|tables| tables[i].state != "done") {
                return Ok(());
            }
        }
        self.after_copy().await
    }

    async fn copy_table(&mut self, table: &'static TableMeta, index: usize) -> Result<(), Error> {
        self.with_tables(|tables| {
            tables[index].state = "copying";
            tables[index].copied = 0;
        });
        self.emit(Event::Table { table: table.name, index }).await;
        let dst = self.dst().await?;
        let mut snap = self.snap.take().ok_or_else(|| Error::Other("The source is not open.".into()))?;
        let copied = self.copy_rows(&dst, &mut snap, table, index).await;
        self.snap = Some(snap);
        match copied {
            Ok(true) => {
                self.with_tables(|tables| tables[index].state = "done");
                let rows = self.with_tables(|tables| tables[index].copied);
                self.emit(Event::TableDone { table: table.name, rows }).await;
                Ok(())
            }
            // paused in the middle: the table was rolled back
            Ok(false) => Ok(()),
            Err(CopyFail::Other(err)) => Err(err),
            Err(CopyFail::Row { copied, values, err }) => {
                Err(Error::Stopped(Box::new(self.stop(table, index, copied, &values, &err).await)))
            }
        }
    }

    /// One table, in one transaction on the target that first empties it. `false` when a pause ended it early.
    async fn copy_rows(
        &self,
        dst: &DatabaseConnection,
        snap: &mut Direct,
        table: &'static TableMeta,
        index: usize,
    ) -> Result<bool, CopyFail> {
        let required: Vec<(usize, Cell)> = table
            .columns
            .iter()
            .enumerate()
            .filter(|(_, c)| !c.nullable)
            .filter_map(|(i, c)| model_default(table.name, c.name).map(|default| (i, default)))
            .collect();
        let target_backend = dst.get_database_backend();
        let txn = dst.begin().await?;
        txn.execute_unprepared(&format!("DELETE FROM {}", quote(target_backend, table.name))).await?;
        let source_backend = snap.backend();
        let select = format!("SELECT {} FROM {}", column_list(source_backend, table), quote(source_backend, table.name));
        let mut stream = snap.stream(&select);
        let mut batch: Vec<Vec<Cell>> = Vec::new();
        let mut size = 0;
        while let Some(row) = stream.next().await {
            let mut values: Vec<Cell> = row?.into_iter().zip(table.columns).map(|(v, c)| coerce(c.kind, v)).collect();
            for (i, default) in &required {
                if values.get(*i).is_some_and(Cell::is_null) {
                    values[*i] = default.clone();
                }
            }
            size += row_bytes(&values);
            batch.push(values);
            if batch.len() >= self.batch_rows || size >= BATCH_BYTES {
                self.insert(&txn, table, &batch, index).await?;
                batch.clear();
                size = 0;
                if self.is_paused() {
                    drop(stream);
                    txn.rollback().await?;
                    self.with_tables(|tables| {
                        tables[index].state = "waiting";
                        tables[index].copied = 0;
                    });
                    return Ok(false);
                }
            }
        }
        drop(stream);
        if !batch.is_empty() {
            self.insert(&txn, table, &batch, index).await?;
        }
        txn.commit().await?;
        Ok(true)
    }

    async fn insert(
        &self,
        txn: &DatabaseTransaction,
        table: &'static TableMeta,
        batch: &[Vec<Cell>],
        index: usize,
    ) -> Result<(), CopyFail> {
        let save = txn.begin().await?;
        match insert_rows(&save, table, batch).await {
            Ok(()) => save.commit().await?,
            Err(_) => {
                save.rollback().await?;
                self.find_bad_row(txn, table, batch, index).await?;
            }
        }
        let (copied, rows) = self.with_tables(|tables| {
            tables[index].copied += batch.len() as i64;
            (tables[index].copied, tables[index].rows)
        });
        self.emit(Event::Rows { table: table.name, copied, rows }).await;
        Ok(())
    }

    async fn find_bad_row(
        &self,
        txn: &DatabaseTransaction,
        table: &'static TableMeta,
        batch: &[Vec<Cell>],
        index: usize,
    ) -> Result<(), CopyFail> {
        let before = self.with_tables(|tables| tables[index].copied);
        for (offset, values) in batch.iter().enumerate() {
            let save = txn.begin().await?;
            match insert_rows(&save, table, std::slice::from_ref(values)).await {
                Ok(()) => save.commit().await?,
                Err(err) => {
                    save.rollback().await?;
                    return Err(CopyFail::Row { copied: before + offset as i64, values: values.clone(), err });
                }
            }
        }
        // every row went in on its own (a batch-only limit): keep them
        Ok(())
    }

    async fn stop(
        &mut self,
        table: &'static TableMeta,
        index: usize,
        copied: i64,
        values: &[Cell],
        err: &DbErr,
    ) -> Stop {
        let (message, code) = clean_error(err);
        let mut column = error_column(&message).filter(|name| table.column(name).is_some());
        if column.is_none() {
            column = guess_column(table, values, &message);
        }
        let value = column.as_deref().and_then(|name| table.columns.iter().position(|c| c.name == name)).map(|i| &values[i]);
        let total = self.with_tables(|tables| tables[index].rows);
        let mut stop = Stop {
            table: table.name.to_string(),
            row: copied + 1,
            copied,
            total,
            tables_done: index,
            tables_total: app_tables().len(),
            error: message,
            code,
            value_length: value.and_then(Cell::length),
            value_null: column.is_some() && value.is_none_or(Cell::is_null),
            source_engine: self.source.label().to_string(),
            target_engine: self.target.label().to_string(),
            ..Stop::default()
        };
        // only for the explanation: a database that cannot say leaves these empty
        let connected = match self.dst().await {
            Ok(dst) => Direct::connect(&dst).await.ok(),
            Err(_) => None,
        };
        if let Some(mut conn) = connected {
            stop.target_version = raw::server_version(&mut conn).await;
            if let Some(column) = column.as_deref() {
                stop.target_type = raw::column_type(&mut conn, table.name, column).await.ok().flatten();
                if let Ok((nullable, default, indexes)) = raw::column_facts(&mut conn, table.name, column).await {
                    stop.target_nullable = nullable;
                    stop.target_default = default;
                    stop.target_indexes = indexes;
                }
            }
            conn.close().await;
        }
        if let (Some(column), Some(snap)) = (column.as_deref(), self.snap.as_mut()) {
            stop.source_type = raw::column_type(snap, table.name, column).await.ok().flatten();
        }
        stop.column = column;
        self.with_tables(|tables| tables[index].state = "stopped");
        stop
    }

    async fn after_copy(&mut self) -> Result<(), Error> {
        if self.target.engine == "postgresql" {
            self.reset_sequences().await?;
        }
        if self.target.is_sqlite() {
            self.rebuild_search().await?;
        }
        Ok(())
    }

    /// Make PostgreSQL's next id carry on after the copied rows (explicit ids do not move a sequence).
    async fn reset_sequences(&mut self) -> Result<(), Error> {
        let txn = self.dst().await?.begin().await?;
        for t in app_tables() {
            let Some(pk) = serial_key(t) else { continue };
            let seq = Sea(&txn)
                .scalar("SELECT pg_get_serial_sequence(?, ?)", vec![t.name.into(), pk.name.into()])
                .await?;
            if let Cell::Text(seq) = seq {
                let top = format!("SELECT MAX(\"{}\") FROM \"{}\"", pk.name, t.name);
                Sea(&txn)
                    .rows(
                        &format!("SELECT setval(CAST(? AS regclass), COALESCE(({top}), 1), ({top}) IS NOT NULL)"),
                        vec![seq.into()],
                    )
                    .await?;
            }
        }
        txn.commit().await?;
        Ok(())
    }

    // -- a fix the person approved ------------------------------------------

    /// Run statements on the target (a fix for a stop, after `assist::check_statements`).
    pub async fn apply(&mut self, statements: &[String]) -> Result<(), Error> {
        let txn = self.dst().await?.begin().await?;
        for s in statements {
            txn.execute_unprepared(s).await?;
        }
        txn.commit().await?;
        Ok(())
    }

    /// Something that changes when anyone writes to the source (to tell whether a copy is still current).
    pub async fn source_fingerprint(&mut self) -> Result<String, Error> {
        if self.source.is_sqlite() {
            let mut parts = Vec::new();
            for suffix in ["", "-wal"] {
                if let Ok(st) = std::fs::metadata(format!("{}{suffix}", self.source.path)) {
                    let mtime_ns = st
                        .modified()
                        .ok()
                        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                        .map(|d| d.as_nanos())
                        .unwrap_or(0);
                    parts.push(format!("{}:{mtime_ns}", st.len()));
                }
            }
            return Ok(parts.join("|"));
        }
        let mut conn = Direct::connect(&self.src().await?).await?;
        let top = conn.scalar("SELECT max(id) FROM kanban_change", Vec::new()).await;
        conn.close().await;
        Ok(top.ok().and_then(|v| v.as_i64()).unwrap_or(0).to_string())
    }
}

/// `conn.execute(table.insert(), batch)`: every row of the batch, in as few statements as the engine's limit on
/// parameters allows.
async fn insert_rows<C: ConnectionTrait>(conn: &C, table: &TableMeta, batch: &[Vec<Cell>]) -> Result<(), DbErr> {
    let backend = conn.get_database_backend();
    let width = table.columns.len().max(1);
    let limit = if backend == DbBackend::Sqlite { 32_000 } else { 65_000 };
    let head = format!("INSERT INTO {} ({}) VALUES ", quote(backend, table.name), column_list(backend, table));
    for rows in batch.chunks((limit / width).max(1)) {
        let mut statement = String::with_capacity(head.len() + rows.len() * width * 4);
        statement.push_str(&head);
        let mut values: Vec<DbValue> = Vec::with_capacity(rows.len() * width);
        for (r, row) in rows.iter().enumerate() {
            statement.push_str(if r == 0 { "(" } else { ", (" });
            for (c, (value, column)) in row.iter().zip(table.columns).enumerate() {
                if c > 0 {
                    statement.push_str(", ");
                }
                values.push(value.to_db_value(column.kind));
                if backend == DbBackend::Postgres {
                    statement.push('$');
                    statement.push_str(&values.len().to_string());
                } else {
                    statement.push('?');
                }
            }
            statement.push(')');
        }
        conn.execute_raw(Statement::from_sql_and_values(backend, statement, values)).await?;
    }
    Ok(())
}

/// `_guess_column`: the column a message means when it does not name one.
fn guess_column(table: &TableMeta, values: &[Cell], message: &str) -> Option<String> {
    let low = message.to_lowercase();
    if low.contains("too long") || low.contains("data too long") {
        let mut longest: Option<(&str, usize)> = None;
        for (c, v) in table.columns.iter().zip(values) {
            if let Cell::Text(text) = v {
                let length = text.chars().count();
                if longest.is_none_or(|(_, best)| length > best) {
                    longest = Some((c.name, length));
                }
            }
        }
        return longest.map(|(name, _)| name.to_string());
    }
    if low.contains("null") {
        for (c, v) in table.columns.iter().zip(values) {
            if !c.nullable && v.is_null() {
                return Some(c.name.to_string());
            }
        }
    }
    None
}

/// '87 tables · about 61,000 rows'.
pub fn summary_line(plan: &Plan) -> String {
    let approx = if plan.rows < 1000 {
        plan.rows
    } else {
        // `round(rows, -3)`: to the nearest thousand, a half going to the even one
        let (whole, rest) = (plan.rows / 1000, plan.rows % 1000);
        let up = rest > 500 || (rest == 500 && whole % 2 == 1);
        (whole + i64::from(up)) * 1000
    };
    format!("{} tables · {}{} rows", plan.tables.len(), if plan.rows >= 1000 { "about " } else { "" }, commas(approx))
}

/// Make the sample repeatable in tests. The Python code seeded its own random numbers here; the sample itself is
/// drawn by the database (`ORDER BY random()`), so there is nothing to seed.
pub fn sample_seed() {}

#[cfg(test)]
mod tests {
    use super::*;

    fn plan(rows: i64) -> Plan {
        Plan {
            source: Map::new(),
            target: Map::new(),
            tables: vec![TableState::new("a"), TableState::new("b")],
            rows,
            extra_tables: Vec::new(),
            notes: Vec::new(),
            problems: Vec::new(),
        }
    }

    #[test]
    fn the_summary_rounds_as_python_rounds() {
        assert_eq!(summary_line(&plan(0)), "2 tables · 0 rows");
        assert_eq!(summary_line(&plan(999)), "2 tables · 999 rows");
        assert_eq!(summary_line(&plan(1000)), "2 tables · about 1,000 rows");
        assert_eq!(summary_line(&plan(1500)), "2 tables · about 2,000 rows");
        assert_eq!(summary_line(&plan(2500)), "2 tables · about 2,000 rows");
        assert_eq!(summary_line(&plan(61_499)), "2 tables · about 61,000 rows");
        assert_eq!(plan(5).as_dict()["tables_count"], 2);
    }

    #[test]
    fn the_copy_order_is_the_metadata_order_and_every_table_has_a_key() {
        assert_eq!(app_tables().len(), 77);
        assert_eq!(app_tables()[0].name, "ai_account");
        assert!(app_tables().iter().all(|t| !primary_key(t).is_empty()));
        assert_eq!(app_tables().iter().filter(|t| serial_key(t).is_some()).count(), 8);
        // every default belongs to a required column of a table
        for (table, column, _) in DEFAULTS {
            let meta = kb_db::entities::table_meta(table).unwrap_or_else(|| panic!("{table}"));
            assert!(meta.column(column).is_some_and(|c| !c.nullable), "{table}.{column}");
        }
    }

    #[test]
    fn a_column_is_guessed_from_the_words_of_the_error() {
        let table = kb_db::entities::table_meta("project").expect("project");
        let mut values: Vec<Cell> = table.columns.iter().map(|_| Cell::Null).collect();
        values[0] = Cell::Text("id".into());
        values[1] = Cell::Text("a long name".into());
        assert_eq!(guess_column(table, &values, "Data too long").as_deref(), Some("name"));
        assert_eq!(guess_column(table, &values, "NOT NULL constraint failed: project.prefix").as_deref(), Some("prefix"));
        assert_eq!(guess_column(table, &values, "disk full"), None);
    }
}
