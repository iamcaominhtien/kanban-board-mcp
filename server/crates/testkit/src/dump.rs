//! Read a SQLite file into JSON, and checkpoint its WAL.

use serde_json::{Map, Value};
use sqlx::sqlite::SqliteConnectOptions;
use sqlx::{ConnectOptions, Connection, Row, SqliteConnection};
use std::path::Path;

async fn open(path: &Path, read_only: bool) -> SqliteConnection {
    SqliteConnectOptions::new()
        .filename(path)
        .read_only(read_only)
        .disable_statement_logging()
        .connect()
        .await
        .unwrap_or_else(|e| panic!("open {}: {e}", path.display()))
}

/// Fold the WAL into the main file so that copying `kanban.db` alone is complete.
pub async fn checkpoint(path: &Path) {
    let mut c = open(path, false).await;
    sqlx::query("PRAGMA wal_checkpoint(TRUNCATE)").execute(&mut c).await.expect("wal checkpoint");
    let _ = c.close().await;
}

/// Take out of a template database what the server that made it wrote about its own folders: the workspace
/// settings row holds the workspace root of that server (a temporary folder that is gone), and it is only there when
/// the server's sweeper ran before the server was stopped. Without the row every server makes its own, with its own
/// root.
pub async fn forget_own_folders(path: &Path) {
    let mut c = open(path, false).await;
    sqlx::query("DELETE FROM workspace_settings").execute(&mut c).await.expect("clear the workspace settings");
    sqlx::query("PRAGMA wal_checkpoint(TRUNCATE)").execute(&mut c).await.expect("wal checkpoint");
    let _ = c.close().await;
}

/// Every table -> rows as objects, tables sorted by name, rows sorted by all columns. Blobs are hex strings.
pub async fn dump(path: &Path) -> Value {
    let mut c = open(path, true).await;
    let tables: Vec<String> =
        sqlx::query("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
            .fetch_all(&mut c)
            .await
            .expect("list tables")
            .iter()
            .map(|r| r.get::<String, _>(0))
            .collect();
    let mut out = Map::new();
    for t in tables {
        let cols: Vec<String> = sqlx::query(sqlx::AssertSqlSafe(format!("PRAGMA table_info(\"{t}\")")))
            .fetch_all(&mut c)
            .await
            .expect("table_info")
            .iter()
            .map(|r| r.get::<String, _>("name"))
            .collect();
        let pairs: Vec<String> = cols
            .iter()
            .map(|n| {
                format!(
                    "'{}', CASE WHEN typeof(\"{n}\")='blob' THEN hex(\"{n}\") ELSE \"{n}\" END",
                    n.replace('\'', "''")
                )
            })
            .collect();
        let order: Vec<String> = cols.iter().map(|n| format!("\"{n}\"")).collect();
        let sql = format!(
            "SELECT json_object({}) FROM \"{t}\" ORDER BY {}",
            pairs.join(", "),
            if order.is_empty() { "1".to_string() } else { order.join(", ") }
        );
        let rows: Vec<Value> = sqlx::query(sqlx::AssertSqlSafe(sql))
            .fetch_all(&mut c)
            .await
            .unwrap_or_else(|e| panic!("dump {t}: {e}"))
            .iter()
            .map(|r| serde_json::from_str(&r.get::<String, _>(0)).expect("row json"))
            .collect();
        out.insert(t, Value::Array(rows));
    }
    let _ = c.close().await;
    Value::Object(out)
}
