//! Read a SQLite file into JSON (every table, rows sorted by all columns), as `testkit`'s `dump_db` does.
#![allow(dead_code)]

use std::path::Path;

use serde_json::{Map, Value};
use sqlx::sqlite::SqliteConnectOptions;
use sqlx::{ConnectOptions, Connection, Row, SqliteConnection};

pub async fn dump(path: &Path) -> Value {
    let mut c: SqliteConnection = SqliteConnectOptions::new()
        .filename(path)
        .read_only(true)
        .disable_statement_logging()
        .connect()
        .await
        .expect("open");
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
        let sql = format!("SELECT json_object({}) FROM \"{t}\" ORDER BY {}", pairs.join(", "), order.join(", "));
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
