//! How the board hears about changes another process made, on PostgreSQL and MySQL.
//!
//! On SQLite the board reads `PRAGMA data_version` (`database::watch_database`). A server database has nothing like
//! it, so every write transaction of every app process adds one row to `kanban_change` (in the same transaction, so
//! it is there exactly when the change is): who wrote. The board polls the newest row written by another process,
//! which is an index lookup on a table kept to about a thousand rows. Appending, rather than bumping one counter
//! row, means two writers never wait on each other's lock.
//!
//! The table is not one of the entities: it is not data, it is not copied or exported, and SQLite never has it.
//!
//! The module also tells listeners of this process when it wrote (`on_write_commit`): the AI runner tells the API,
//! and an MCP tool names what it wrote in its announcement.
//!
//! Ported differently: SQLAlchemy calls the listeners from its `after_commit` event, with the tables the session
//! wrote. The pools here have no commit event, so the listeners are called from the pool's statement callback
//! (`after_statement`, installed by `targets::make_engine`) right after each statement that wrote succeeded, in the
//! task that ran it, with that statement's table. A transaction that writes three rows tells three times, a little
//! before its commit, and a write that is rolled back afterwards was told all the same.

use std::collections::BTreeSet;
use std::sync::{Arc, LazyLock, RwLock};

use sea_orm::{ConnectionTrait, DatabaseConnection, DbBackend, DbErr, Statement, TransactionTrait, Value};

use crate::targets;

pub const TABLE: &str = "kanban_change";
pub const KEEP_ROWS: i64 = 1000;

/// What `on_write_commit` calls: `callback(tables)`.
pub type WriteListener = Arc<dyn Fn(&BTreeSet<String>) + Send + Sync>;

/// Called (synchronously, cheaply) after each write of this process (the runner tells the API), by key.
static ON_WRITE_COMMIT: LazyLock<RwLock<Vec<(&'static str, WriteListener)>>> =
    LazyLock::new(|| RwLock::new(Vec::new()));
/// Origins whose rows are not "another process": the AI runner this API started announces its own changes.
static IGNORED_ORIGINS: RwLock<BTreeSet<String>> = RwLock::new(BTreeSet::new());

fn origin() -> String {
    targets::PROCESS_TOKEN.chars().take(32).collect()
}

/// Call `callback(tables)` after every commit of this process that wrote: `tables` names the tables written
/// (`"*"` when a statement's table is not known). It runs inside the write: keep it cheap. `key` names the listener,
/// so registering it twice keeps one (`if callback not in _on_write_commit`).
pub fn on_write_commit(key: &'static str, callback: impl Fn(&BTreeSet<String>) + Send + Sync + 'static) {
    let mut listeners = ON_WRITE_COMMIT.write().unwrap_or_else(|e| e.into_inner());
    if !listeners.iter().any(|(k, _)| *k == key) {
        listeners.push((key, Arc::new(callback)));
    }
}

/// Remove the listener registered under `key` (tests: `_on_write_commit.remove(listener)`).
pub fn remove_write_listener(key: &str) {
    ON_WRITE_COMMIT.write().unwrap_or_else(|e| e.into_inner()).retain(|(k, _)| *k != key);
}

/// Treat the rows of this process token as this process's own (the AI runner, whose changes come as events).
pub fn ignore_origin(token: &str) {
    if !token.is_empty() {
        IGNORED_ORIGINS.write().unwrap_or_else(|e| e.into_inner()).insert(token.chars().take(32).collect());
    }
}

/// Forget an origin `ignore_origin` named (tests: `_ignored_origins.discard`).
pub fn forget_origin(token: &str) {
    let token: String = token.chars().take(32).collect();
    IGNORED_ORIGINS.write().unwrap_or_else(|e| e.into_inner()).remove(&token);
}

/// The table a statement writes, or `None` when it does not write (`_orm_execute`): an INSERT, UPDATE, DELETE or
/// REPLACE, read from the statement's head; `"*"` when its table cannot be read.
pub fn written_table(sql: &str) -> Option<String> {
    let mut words = sql.trim_start().split(|c: char| c.is_whitespace() || c == '(');
    let head = words.next()?.to_ascii_uppercase();
    let mut word = || words.by_ref().find(|w| !w.is_empty());
    let name = match head.as_str() {
        "INSERT" | "REPLACE" => {
            // INSERT [OR action] INTO name
            let mut next = word();
            while next.is_some_and(|w| !w.eq_ignore_ascii_case("INTO")) {
                next = word();
            }
            word()
        }
        "UPDATE" => match word() {
            Some(w) if w.eq_ignore_ascii_case("OR") => {
                word();
                word()
            }
            other => other,
        },
        "DELETE" => match word() {
            Some(w) if w.eq_ignore_ascii_case("FROM") => word(),
            other => other,
        },
        _ => return None,
    };
    let name =
        name.map(|n| n.rsplit('.').next().unwrap_or(n).trim_matches(|c| c == '"' || c == '`' || c == '[' || c == ']'));
    Some(name.filter(|n| !n.is_empty()).unwrap_or("*").to_string())
}

/// The pool's statement callback: after a statement that wrote succeeded, tell the `on_write_commit` listeners
/// which table it wrote. It runs in the task that ran the statement (an MCP tool's task sees its own writes).
pub fn after_statement(sql: &str, failed: bool) {
    if failed {
        return;
    }
    let listeners: Vec<WriteListener> = {
        let listeners = ON_WRITE_COMMIT.read().unwrap_or_else(|e| e.into_inner());
        if listeners.is_empty() {
            return;
        }
        listeners.iter().map(|(_, cb)| cb.clone()).collect()
    };
    let Some(table) = written_table(sql) else { return };
    let tables = BTreeSet::from([table]);
    for cb in listeners {
        // a listener never fails a commit
        let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| cb(&tables)));
    }
}

/// Make the table when it is missing (server databases only).
pub async fn create<C: ConnectionTrait>(conn: &C) -> Result<(), DbErr> {
    let sql = match conn.get_database_backend() {
        DbBackend::Postgres => {
            "CREATE TABLE IF NOT EXISTS kanban_change (id BIGSERIAL NOT NULL, origin VARCHAR(32) NOT NULL, \
             at FLOAT NOT NULL, PRIMARY KEY (id))"
        }
        DbBackend::MySql => {
            "CREATE TABLE IF NOT EXISTS kanban_change (id BIGINT NOT NULL AUTO_INCREMENT, origin VARCHAR(32) NOT NULL, \
             at FLOAT NOT NULL, PRIMARY KEY (id))"
        }
        _ => return Ok(()),
    };
    conn.execute_unprepared(sql).await.map(|_| ())
}

/// Note, inside the transaction that is about to commit, that this process wrote.
pub async fn mark<C: ConnectionTrait>(conn: &C) -> Result<(), DbErr> {
    let backend = conn.get_database_backend();
    let sql = match backend {
        DbBackend::Postgres => "INSERT INTO kanban_change (origin, at) VALUES ($1, $2)",
        DbBackend::MySql => "INSERT INTO kanban_change (origin, at) VALUES (?, ?)",
        _ => return Ok(()),
    };
    conn.execute_raw(Statement::from_sql_and_values(backend, sql, [origin().into(), kb_base::time::epoch().into()]))
        .await
        .map(|_| ())
}

/// The id of the newest change another process wrote (0 when none): not this process's rows, nor those of an
/// origin `ignore_origin` named.
pub async fn latest_from_others<C: ConnectionTrait>(conn: &C) -> Result<i64, DbErr> {
    let backend = conn.get_database_backend();
    let mut origins: Vec<Value> = vec![origin().into()];
    origins.extend(IGNORED_ORIGINS.read().unwrap_or_else(|e| e.into_inner()).iter().map(|o| Value::from(o.clone())));
    let marks: Vec<String> = (1..=origins.len())
        .map(|i| if backend == DbBackend::Postgres { format!("${i}") } else { "?".to_string() })
        .collect();
    let sql = format!("SELECT max(id) AS newest FROM kanban_change WHERE origin NOT IN ({})", marks.join(", "));
    let row = conn.query_one_raw(Statement::from_sql_and_values(backend, sql, origins)).await?;
    Ok(row.and_then(|r| r.try_get::<Option<i64>>("", "newest").ok().flatten()).unwrap_or(0))
}

/// Keep only the newest rows; nobody reads further back.
pub async fn trim(conn: &DatabaseConnection) -> Result<(), DbErr> {
    let backend = conn.get_database_backend();
    let txn = conn.begin().await?;
    let row = txn.query_one_raw(Statement::from_string(backend, "SELECT max(id) AS newest FROM kanban_change")).await?;
    let newest = row.and_then(|r| r.try_get::<Option<i64>>("", "newest").ok().flatten()).unwrap_or(0);
    if newest != 0 {
        let sql = match backend {
            DbBackend::Postgres => "DELETE FROM kanban_change WHERE id < $1",
            _ => "DELETE FROM kanban_change WHERE id < ?",
        };
        txn.execute_raw(Statement::from_sql_and_values(backend, sql, [(newest - KEEP_ROWS).into()])).await?;
    }
    txn.commit().await
}

#[cfg(test)]
mod tests {
    use super::written_table;

    #[test]
    fn the_table_a_statement_writes() {
        let t = |sql: &str| written_table(sql);
        assert_eq!(t(r#"INSERT INTO "ticket" ("id") VALUES ($1)"#).as_deref(), Some("ticket"));
        assert_eq!(t("  insert or ignore into ai_run_step(a) values (1)").as_deref(), Some("ai_run_step"));
        assert_eq!(t("REPLACE INTO `docs_page` (`id`) VALUES (?)").as_deref(), Some("docs_page"));
        assert_eq!(t(r#"UPDATE "ticket" SET "title" = ?"#).as_deref(), Some("ticket"));
        assert_eq!(t("UPDATE OR REPLACE main.project SET a = 1").as_deref(), Some("project"));
        assert_eq!(t(r#"DELETE FROM "notification" WHERE 1"#).as_deref(), Some("notification"));
        assert_eq!(t("INSERT INTO docs_fts(docs_fts) VALUES('rebuild')").as_deref(), Some("docs_fts"));
        assert_eq!(t("INSERT").as_deref(), Some("*"));
        assert_eq!(t("SELECT * FROM ticket"), None);
        assert_eq!(t("WITH a AS (SELECT 1) INSERT INTO t SELECT * FROM a"), None);
        assert_eq!(t("CREATE TABLE t (a)"), None);
        assert_eq!(t("PRAGMA journal_mode=WAL"), None);
    }
}
