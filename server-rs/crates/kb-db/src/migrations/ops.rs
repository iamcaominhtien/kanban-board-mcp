//! What the migrations are written with: statements, what a database already has (Alembic's inspector), and the
//! table rebuild of Alembic's batch mode on SQLite.

use sea_orm::{ConnectionTrait, DbBackend, DbErr, QueryResult, Value};

use crate::database::DatabaseError;
use crate::{schema, sql};

/// What one migration returns.
pub(super) type StepResult = Result<(), DatabaseError>;

/// The engine as the Python migrations name it (`op.get_bind().dialect.name`).
pub(super) fn dialect<C: ConnectionTrait>(conn: &C) -> &'static str {
    crate::session::dialect_name(conn.get_database_backend())
}

/// `op.execute("...")`: one statement without values.
pub(super) async fn exec<C: ConnectionTrait>(conn: &C, statement: &str) -> Result<(), DbErr> {
    conn.execute_unprepared(statement).await.map(|_| ())
}

/// `bind.execute(sa.text("... :name ..."), {...})`: one statement with `?` placeholders.
pub(super) async fn exec_with<C: ConnectionTrait>(conn: &C, statement: &str, values: Vec<Value>) -> Result<(), DbErr> {
    conn.execute_raw(sql::statement(conn.get_database_backend(), statement, values)).await.map(|_| ())
}

/// The rows of a query with `?` placeholders.
pub(super) async fn rows<C: ConnectionTrait>(
    conn: &C,
    query: &str,
    values: Vec<Value>,
) -> Result<Vec<QueryResult>, DbErr> {
    conn.query_all_raw(sql::statement(conn.get_database_backend(), query, values)).await
}

/// `sa.inspect(bind).has_table(name)`.
pub(super) async fn has_table<C: ConnectionTrait>(conn: &C, name: &str) -> Result<bool, DbErr> {
    schema::has_table(conn, name).await
}

async fn names<C: ConnectionTrait>(conn: &C, query: &str, values: Vec<Value>) -> Result<Vec<String>, DbErr> {
    let mut out = Vec::new();
    for row in rows(conn, query, values).await? {
        out.push(row.try_get::<String>("", "name")?);
    }
    Ok(out)
}

/// `{c["name"] for c in sa.inspect(bind).get_columns(table)}`, in the table's order. `table` is a name written in
/// the code.
pub(super) async fn columns<C: ConnectionTrait>(conn: &C, table: &str) -> Result<Vec<String>, DbErr> {
    match conn.get_database_backend() {
        DbBackend::Postgres => {
            names(
                conn,
                "SELECT CAST(column_name AS TEXT) AS name FROM information_schema.columns \
                 WHERE table_schema = current_schema() AND table_name = ? ORDER BY ordinal_position",
                vec![table.into()],
            )
            .await
        }
        DbBackend::MySql => {
            names(
                conn,
                "SELECT column_name AS name FROM information_schema.columns \
                 WHERE table_schema = DATABASE() AND table_name = ? ORDER BY ordinal_position",
                vec![table.into()],
            )
            .await
        }
        _ => names(conn, &format!("PRAGMA table_info(\"{table}\")"), vec![]).await,
    }
}

/// `{i["name"] for i in sa.inspect(bind).get_indexes(table)}`.
pub(super) async fn index_names<C: ConnectionTrait>(conn: &C, table: &str) -> Result<Vec<String>, DbErr> {
    match conn.get_database_backend() {
        DbBackend::Postgres => {
            names(
                conn,
                "SELECT CAST(indexname AS TEXT) AS name FROM pg_indexes \
                 WHERE schemaname = current_schema() AND tablename = ?",
                vec![table.into()],
            )
            .await
        }
        DbBackend::MySql => {
            names(
                conn,
                "SELECT DISTINCT index_name AS name FROM information_schema.statistics \
                 WHERE table_schema = DATABASE() AND table_name = ?",
                vec![table.into()],
            )
            .await
        }
        _ => {
            // the inspector leaves out the indexes SQLite makes itself for UNIQUE and PRIMARY KEY
            let all = names(conn, &format!("PRAGMA index_list(\"{table}\")"), vec![]).await?;
            Ok(all.into_iter().filter(|name| !name.starts_with("sqlite_autoindex_")).collect())
        }
    }
}

/// `op.create_index(name, table, columns)` unless the table has an index with that name.
pub(super) async fn create_index_if_missing<C: ConnectionTrait>(
    conn: &C,
    name: &str,
    table: &str,
    columns: &[&str],
) -> Result<(), DbErr> {
    if index_names(conn, table).await?.iter().any(|n| n == name) {
        return Ok(());
    }
    let types = Types::of(conn);
    let columns: Vec<String> = columns.iter().map(|c| types.spell(c)).collect();
    exec(conn, &format!("CREATE INDEX {name} ON {table} ({})", columns.join(", "))).await
}

/// `batch_alter_table(table)` with `add_column` for each column the table lacks: `(name, definition)` pairs, the
/// definition being what follows the name in `ALTER TABLE ... ADD COLUMN`.
pub(super) async fn add_missing_columns<C: ConnectionTrait>(
    conn: &C,
    table: &str,
    wanted: &[(&str, &str)],
) -> Result<(), DbErr> {
    let have = columns(conn, table).await?;
    for (name, definition) in wanted {
        if !have.iter().any(|c| c == name) {
            exec(conn, &format!("ALTER TABLE {table} ADD COLUMN {name} {definition}")).await?;
        }
    }
    Ok(())
}

/// How the three engines spell the column types the newer migrations use (they run on PostgreSQL and MySQL too).
pub(super) struct Types {
    /// `AutoString`: a key or an indexed text column.
    pub s: &'static str,
    /// `LongText`: text of any length.
    pub t: &'static str,
    /// `sa.Boolean()`.
    pub b: &'static str,
    /// An integer primary key the database numbers.
    pub serial: &'static str,
    quote: char,
}

impl Types {
    /// The spelling for the engine of `conn`.
    pub fn of<C: ConnectionTrait>(conn: &C) -> Self {
        match conn.get_database_backend() {
            DbBackend::Postgres => Types { s: "VARCHAR", t: "VARCHAR", b: "BOOLEAN", serial: "SERIAL NOT NULL", quote: '"' },
            DbBackend::MySql => Types {
                s: "VARCHAR(255)",
                t: "LONGTEXT",
                b: "BOOL",
                serial: "INTEGER NOT NULL AUTO_INCREMENT",
                quote: '`',
            },
            _ => Types { s: "VARCHAR", t: "VARCHAR", b: "BOOLEAN", serial: "INTEGER NOT NULL", quote: '"' },
        }
    }

    /// A column name that is a reserved word (`trigger`, `key`), quoted for the engine.
    pub fn q(&self, name: &str) -> String {
        format!("{}{name}{}", self.quote, self.quote)
    }

    /// A column name as Alembic wrote it: quoted when it is a reserved word.
    pub fn spell(&self, name: &str) -> String {
        if matches!(name, "trigger" | "key") { self.q(name) } else { name.to_string() }
    }

    /// A column added with a default: MySQL wants `NOT NULL` before `DEFAULT`, as Alembic wrote it there.
    pub fn not_null_default(&self, default: &str) -> String {
        if self.quote == '`' { format!("NOT NULL DEFAULT {default}") } else { format!("DEFAULT {default} NOT NULL") }
    }
}

/// The type of a column in a table the newer migrations make.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum Kind {
    /// `AutoString`.
    S,
    /// `LongText`.
    T,
    Int,
    Float,
    Bool,
    /// The integer primary key of a table the database numbers.
    Serial,
}

/// `op.create_table(name, *columns, sa.PrimaryKeyConstraint(pk))` unless the table is there (a database made from
/// the models already has it). Columns are `(name, type, nullable)`; the statement is the one Alembic wrote on
/// each engine.
pub(super) async fn create_table_if_missing<C: ConnectionTrait>(
    conn: &C,
    name: &str,
    columns: &[(&str, Kind, bool)],
    pk: &str,
) -> Result<(), DbErr> {
    if has_table(conn, name).await? {
        return Ok(());
    }
    let types = Types::of(conn);
    let spell = |column: &str| types.spell(column);
    let mut lines = Vec::new();
    for (column, kind, nullable) in columns {
        let kind_sql = match kind {
            Kind::S => types.s,
            Kind::T => types.t,
            Kind::Int => "INTEGER",
            Kind::Float => "FLOAT",
            Kind::Bool => types.b,
            Kind::Serial => types.serial,
        };
        let not_null = if *nullable || *kind == Kind::Serial { "" } else { " NOT NULL" };
        lines.push(format!("{} {kind_sql}{not_null}", spell(column)));
    }
    lines.push(format!("PRIMARY KEY ({})", spell(pk)));
    exec(conn, &format!("CREATE TABLE {name} (
	{}
)", lines.join(", 
	"))).await
}

// ---------------------------------------------------------------------------
// The table rebuild of Alembic's batch mode (SQLite only)
// ---------------------------------------------------------------------------

/// One column of a table as SQLite describes it (`PRAGMA table_info`).
#[derive(Debug, Clone)]
pub(super) struct Column {
    pub name: String,
    /// The declared type, as written.
    pub kind: String,
    pub not_null: bool,
    /// The default as written (`'draft'`, `0`), `None` when there is none.
    pub default: Option<String>,
    /// Position in the primary key (1-based), 0 when not part of it.
    pub pk: i32,
}

/// A table read back from the database, to be written again with changes.
#[derive(Debug, Clone)]
pub(super) struct Table {
    pub name: String,
    pub columns: Vec<Column>,
    /// UNIQUE constraints: the name it was given (if any) and its columns.
    pub uniques: Vec<(Option<String>, Vec<String>)>,
    /// FOREIGN KEY clauses, as SQL.
    foreign_keys: Vec<String>,
    /// The columns the table had when it was read: the ones copied over.
    old_columns: Vec<String>,
    /// `CREATE INDEX` statements of the table's indexes, made again after the rebuild.
    indexes: Vec<String>,
}

fn ident(name: &str) -> String {
    let plain = name.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_')
        && !matches!(name, "trigger" | "key" | "order" | "group" | "index" | "table" | "column" | "check" | "references");
    if plain { name.to_string() } else { format!("\"{}\"", name.replace('"', "\"\"")) }
}

/// The names given to UNIQUE constraints in a `CREATE TABLE` text, by their column list.
fn unique_names(create: &str) -> Vec<(String, Vec<String>)> {
    let mut out = Vec::new();
    let mut rest = create;
    while let Some(at) = rest.find("CONSTRAINT ") {
        rest = &rest[at + "CONSTRAINT ".len()..];
        let Some((name, after)) = rest.split_once(' ') else { break };
        let Some(columns) = after.strip_prefix("UNIQUE (").and_then(|tail| tail.split_once(')')).map(|(cols, _)| cols)
        else {
            continue;
        };
        let columns = columns.split(',').map(|c| c.trim().trim_matches('"').to_string()).collect();
        out.push((name.trim_matches('"').to_string(), columns));
    }
    out
}

impl Table {
    /// Read `table` (SQLite): columns, primary key, UNIQUE and FOREIGN KEY constraints and indexes, which is what
    /// Alembic's batch mode reflects before it rebuilds a table.
    pub async fn reflect<C: ConnectionTrait>(conn: &C, table: &str) -> Result<Self, DbErr> {
        let mut columns = Vec::new();
        for row in rows(conn, &format!("PRAGMA table_info(\"{table}\")"), vec![]).await? {
            columns.push(Column {
                name: row.try_get("", "name")?,
                kind: row.try_get("", "type")?,
                not_null: row.try_get::<i32>("", "notnull")? != 0,
                default: row.try_get("", "dflt_value")?,
                pk: row.try_get("", "pk")?,
            });
        }
        if columns.is_empty() {
            return Err(DbErr::Custom(format!("no such table: {table}")));
        }
        let created: Vec<(String, Option<String>)> = {
            let mut out = Vec::new();
            for row in rows(
                conn,
                "SELECT type, sql FROM sqlite_master WHERE tbl_name = ? AND type IN ('table', 'index') ORDER BY rowid",
                vec![table.into()],
            )
            .await?
            {
                out.push((row.try_get("", "type")?, row.try_get("", "sql")?));
            }
            out
        };
        let create = created.iter().find(|(kind, _)| kind == "table").and_then(|(_, sql)| sql.clone());
        let named = unique_names(create.as_deref().unwrap_or(""));
        let indexes = created.iter().filter(|(kind, _)| kind == "index").filter_map(|(_, sql)| sql.clone()).collect();

        let mut uniques = Vec::new();
        for row in rows(conn, &format!("PRAGMA index_list(\"{table}\")"), vec![]).await? {
            if row.try_get::<String>("", "origin")? != "u" {
                continue;
            }
            let index: String = row.try_get("", "name")?;
            let mut cols = Vec::new();
            for col in rows(conn, &format!("PRAGMA index_info(\"{index}\")"), vec![]).await? {
                cols.push(col.try_get::<String>("", "name")?);
            }
            let name = named.iter().find(|(_, c)| *c == cols).map(|(n, _)| n.clone());
            uniques.push((name, cols));
        }
        // index_list gives the newest first; keep the order they were declared in
        uniques.reverse();

        // one FOREIGN KEY clause per id, its columns by seq
        let mut keys: Vec<(i32, String, Vec<String>, Vec<Option<String>>, String, String)> = Vec::new();
        for row in rows(conn, &format!("PRAGMA foreign_key_list(\"{table}\")"), vec![]).await? {
            let id: i32 = row.try_get("", "id")?;
            let from: String = row.try_get("", "from")?;
            let to: Option<String> = row.try_get("", "to")?;
            match keys.iter_mut().find(|k| k.0 == id) {
                Some(key) => {
                    key.2.push(from);
                    key.3.push(to);
                }
                None => keys.push((
                    id,
                    row.try_get("", "table")?,
                    vec![from],
                    vec![to],
                    row.try_get("", "on_update")?,
                    row.try_get("", "on_delete")?,
                )),
            }
        }
        keys.sort_by_key(|k| std::cmp::Reverse(k.0));
        let foreign_keys = keys
            .into_iter()
            .map(|(_, target, from, to, on_update, on_delete)| {
                let from = from.iter().map(|c| ident(c)).collect::<Vec<_>>().join(", ");
                let mut clause = format!("FOREIGN KEY({from}) REFERENCES {}", ident(&target));
                if to.iter().all(Option::is_some) {
                    let to = to.iter().flatten().map(|c| ident(c)).collect::<Vec<_>>().join(", ");
                    clause.push_str(&format!(" ({to})"));
                }
                if on_update != "NO ACTION" {
                    clause.push_str(&format!(" ON UPDATE {on_update}"));
                }
                if on_delete != "NO ACTION" {
                    clause.push_str(&format!(" ON DELETE {on_delete}"));
                }
                clause
            })
            .collect();
        let old_columns = columns.iter().map(|c| c.name.clone()).collect();
        Ok(Table { name: table.to_string(), columns, uniques, foreign_keys, old_columns, indexes })
    }

    /// The column `name`, to change it (`batch_op.alter_column`).
    pub fn column(&mut self, name: &str) -> Result<&mut Column, DbErr> {
        let table = self.name.clone();
        self.columns
            .iter_mut()
            .find(|c| c.name == name)
            .ok_or_else(|| DbErr::Custom(format!("no such column: {table}.{name}")))
    }

    /// `batch_op.add_column`: a new column at the end.
    pub fn add_column(&mut self, name: &str, kind: &str, not_null: bool, default: Option<&str>) {
        self.columns.push(Column {
            name: name.to_string(),
            kind: kind.to_string(),
            not_null,
            default: default.map(str::to_string),
            pk: 0,
        });
    }

    fn create_statement(&self, name: &str) -> String {
        let mut parts = Vec::new();
        for column in &self.columns {
            let mut line = format!("{} {}", ident(&column.name), column.kind);
            if let Some(default) = &column.default {
                line.push_str(&format!(" DEFAULT {default}"));
            }
            if column.not_null {
                line.push_str(" NOT NULL");
            }
            parts.push(line);
        }
        let mut pk: Vec<&Column> = self.columns.iter().filter(|c| c.pk > 0).collect();
        pk.sort_by_key(|c| c.pk);
        if !pk.is_empty() {
            parts.push(format!("PRIMARY KEY ({})", pk.iter().map(|c| ident(&c.name)).collect::<Vec<_>>().join(", ")));
        }
        for (constraint, columns) in &self.uniques {
            let columns = columns.iter().map(|c| ident(c)).collect::<Vec<_>>().join(", ");
            match constraint {
                Some(constraint) => parts.push(format!("CONSTRAINT {constraint} UNIQUE ({columns})")),
                None => parts.push(format!("UNIQUE ({columns})")),
            }
        }
        parts.extend(self.foreign_keys.iter().cloned());
        format!("CREATE TABLE {name} (\n\t{}\n)", parts.join(", \n\t"))
    }

    /// Write the table again with its changes, as Alembic's batch mode does: a new table, the rows copied over, the
    /// old table dropped, the new one renamed, the indexes made again.
    pub async fn rebuild<C: ConnectionTrait>(&self, conn: &C) -> Result<(), DbErr> {
        let tmp = format!("_alembic_tmp_{}", self.name);
        exec(conn, &self.create_statement(&tmp)).await?;
        let kept: Vec<String> = self
            .old_columns
            .iter()
            .filter(|old| self.columns.iter().any(|c| c.name == **old))
            .map(|c| ident(c))
            .collect();
        let kept = kept.join(", ");
        exec(conn, &format!("INSERT INTO {tmp} ({kept}) SELECT {kept} FROM {}", ident(&self.name))).await?;
        exec(conn, &format!("DROP TABLE {}", ident(&self.name))).await?;
        exec(conn, &format!("ALTER TABLE {tmp} RENAME TO {}", ident(&self.name))).await?;
        for index in &self.indexes {
            exec(conn, index).await?;
        }
        Ok(())
    }
}
