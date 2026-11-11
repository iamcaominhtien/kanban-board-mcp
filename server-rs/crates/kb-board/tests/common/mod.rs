//! Shared by the board's ported tests: rows the tests add straight to the server's SQLite file, in the stored
//! formats, where the Python test used a route or a model that is not ported yet.
#![allow(dead_code)]

use std::time::Duration;

use serde_json::{Value, json};
use sqlx::sqlite::{SqliteArguments, SqliteConnectOptions};
use sqlx::{Arguments, ConnectOptions, Connection, Row, SqliteConnection};
use testkit::{Client, Server};

/// `datetime.now(timezone.utc).isoformat()`, near enough for a row a test adds.
pub const NOW: &str = "2026-11-11T08:00:00.000000+00:00";

/// A connection to the running server's SQLite file (WAL: the server keeps serving).
pub async fn db(server: &Server) -> SqliteConnection {
    SqliteConnectOptions::new()
        .filename(server.db_path())
        .busy_timeout(Duration::from_secs(10))
        .disable_statement_logging()
        .connect()
        .await
        .unwrap_or_else(|e| panic!("open {}: {e}", server.db_path().display()))
}

fn arguments(params: &[Value]) -> SqliteArguments {
    let mut args = SqliteArguments::default();
    for p in params {
        match p {
            Value::Null => args.add(Option::<String>::None),
            Value::Bool(b) => args.add(*b),
            Value::Number(n) if n.is_i64() => args.add(n.as_i64()),
            Value::Number(n) => args.add(n.as_f64()),
            Value::String(s) => args.add(s.clone()),
            other => args.add(other.to_string()),
        }
        .expect("bind");
    }
    args
}

/// Run one statement with `?` parameters and commit.
pub async fn exec(server: &Server, sql: &str, params: &[Value]) {
    let mut c = db(server).await;
    sqlx::query_with(sqlx::AssertSqlSafe(sql.to_string()), arguments(params))
        .execute(&mut c)
        .await
        .unwrap_or_else(|e| panic!("{sql}: {e}"));
    let _ = c.close().await;
}

/// `SELECT COUNT(*) ...` with `?` parameters.
pub async fn count(server: &Server, sql: &str, params: &[Value]) -> i64 {
    let mut c = db(server).await;
    let row = sqlx::query_with(sqlx::AssertSqlSafe(sql.to_string()), arguments(params))
        .fetch_one(&mut c)
        .await
        .unwrap_or_else(|e| panic!("{sql}: {e}"));
    let n: i64 = row.get(0);
    let _ = c.close().await;
    n
}

/// One value of one row, as JSON (Null when there is no row).
pub async fn scalar(server: &Server, sql: &str, params: &[Value]) -> Value {
    let mut c = db(server).await;
    let wrapped = format!("SELECT json_array(({sql}))");
    let row = sqlx::query_with(sqlx::AssertSqlSafe(wrapped), arguments(params))
        .fetch_one(&mut c)
        .await
        .unwrap_or_else(|e| panic!("{sql}: {e}"));
    let text: String = row.get(0);
    let _ = c.close().await;
    serde_json::from_str::<Value>(&text).expect("json")[0].clone()
}

/// `POST /projects`, returning the project.
pub async fn project(c: &Client, name: &str, prefix: &str) -> Value {
    let r = c.post("/projects", json!({"name": name, "prefix": prefix, "color": "#123456"})).await;
    r.assert_status(201);
    r.json()
}

/// `POST /projects/{pid}/members`, returning the member.
pub async fn member(c: &Client, pid: &str, name: &str, role: &str) -> Value {
    let r = c.post(&format!("/projects/{pid}/members"), json!({"name": name, "role": role})).await;
    r.assert_status(201);
    r.json()
}

/// The `id` of a reply.
pub fn id(value: &Value) -> String {
    value["id"].as_str().unwrap_or_else(|| panic!("no id in {value}")).to_string()
}

/// A `Ticket` row as the Python model stores a new one (`Ticket(id=..., project_id=..., title=...)`), with the
/// given columns on top (`{"status": "done", "assignee": "..."}`).
pub async fn ticket(server: &Server, ticket_id: &str, project_id: &str, title: &str, extra: Value) {
    let mut columns = json!({
        "id": ticket_id, "project_id": project_id, "title": title, "description": "", "type": "task",
        "status": "backlog", "priority": "medium", "tags": "[]", "comments": "[]", "acceptance_criteria": "[]",
        "sub_tasks": "[]", "activity_log": "[]", "work_log": "[]", "test_cases": "[]", "blocks": "[]",
        "blocked_by": "[]", "block_done_if_acs_incomplete": false, "block_done_if_tcs_incomplete": false,
        "links": "[]", "branches": "[]", "reopen_count": 0, "reopen_history": "[]", "pending": false,
        "created_at": NOW, "updated_at": NOW,
    });
    for (key, value) in extra.as_object().expect("extra columns") {
        columns[key] = value.clone();
    }
    insert(server, "ticket", &columns).await;
}

/// Insert one row given as `{column: value}`.
pub async fn insert(server: &Server, table: &str, columns: &Value) {
    let columns = columns.as_object().expect("columns");
    let names: Vec<String> = columns.keys().map(|k| format!("\"{k}\"")).collect();
    let marks = vec!["?"; names.len()].join(", ");
    let values: Vec<Value> = columns.values().cloned().collect();
    exec(server, &format!("INSERT INTO \"{table}\" ({}) VALUES ({marks})", names.join(", ")), &values).await;
}
