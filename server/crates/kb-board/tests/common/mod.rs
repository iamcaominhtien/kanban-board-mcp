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
        // as the server itself: no engine enforces foreign keys, and tests add rows that point at nothing
        .foreign_keys(false)
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

/// An `IdeaTicket` row as the Python model stores a new one, with the given columns on top.
pub async fn idea(server: &Server, idea_id: &str, extra: Value) {
    let mut columns = json!({
        "id": idea_id, "title": "an idea", "description": "", "idea_status": "draft", "stage": "inbox",
        "source": "manual", "source_ref": "{}", "prev_state": "{}", "merge_undo": "{}",
        "workspace_retention": "open_then_30", "body": "", "details": "", "idea_color": "yellow",
        "idea_emoji": "💡", "tags": "[]", "ice_impact": 3, "ice_effort": 3, "ice_confidence": 3,
        "activity_trail": "[]", "microthoughts": "[]", "assumptions": "[]", "created_at": NOW, "updated_at": NOW,
    });
    for (key, value) in extra.as_object().expect("extra columns") {
        columns[key] = value.clone();
    }
    insert(server, "idea_ticket", &columns).await;
}

/// `os.utime(path, (t, t))` on a path and everything under it (`_age` of the Python tests, with a fixed time).
pub fn set_mtime(path: &std::path::Path, secs: u64, nanos: u32) {
    let when = std::time::UNIX_EPOCH + std::time::Duration::new(secs, nanos);
    let mut todo = vec![path.to_path_buf()];
    while let Some(p) = todo.pop() {
        if p.is_dir() && !p.is_symlink() {
            for entry in std::fs::read_dir(&p).expect("read_dir") {
                todo.push(entry.expect("entry").path());
            }
        }
        if !p.is_symlink() {
            std::fs::File::open(&p).expect("open").set_modified(when).expect("set_modified");
        }
    }
}

/// `os.utime` to `days` days ago, for a folder and everything in it.
pub fn age(path: &std::path::Path, days: u64) {
    let old =
        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).expect("clock").as_secs() - days * 86400;
    set_mtime(path, old, 0);
}

/// `PATCH /workspace/settings`.
pub async fn workspace_settings(c: &Client, body: Value) -> Value {
    let r = c.patch("/workspace/settings", body).await;
    r.assert_status(200);
    r.json()
}

/// `POST /projects/{pid}/tickets` with `body` (`{"title": ...}` and whatever else), returning the ticket.
pub async fn new_ticket(c: &Client, pid: &str, body: Value) -> Value {
    let r = c.post(&format!("/projects/{pid}/tickets"), body).await;
    r.assert_status(201);
    r.json()
}

/// `GET /tickets/{id}`.
pub async fn get_ticket(c: &Client, ticket_id: &str) -> Value {
    let r = c.get(&format!("/tickets/{ticket_id}")).await;
    r.assert_status(200);
    r.json()
}

/// `c.patch(path)` of the Python tests: a PATCH without a body (the toggle routes).
pub async fn patch_empty(c: &Client, path: &str) -> testkit::Resp {
    c.request("PATCH", path, &[], None).await
}

/// Whether the server serves the Docs routes. The Python server always does; the Rust server does once `kb-docs`
/// is ported. A test that needs a Docs page runs its Docs part only where this is true. Asked of the route that
/// makes a page: a body without a title is refused (422) where the route is served, and unknown (404, or 405 when
/// only another method of the path is served) where it is not.
pub async fn docs_served(c: &Client, project_id: &str) -> bool {
    let r = c.post(&format!("/projects/{project_id}/docs/pages"), json!({})).await;
    r.status != 404 && r.status != 405
}

/// A git repository with one commit on `branch` (the `repo_dir` fixture of the Python tests).
pub fn repo_dir(branch: &str, user: &str) -> tempfile::TempDir {
    let dir = tempfile::tempdir().expect("temporary folder");
    git(dir.path(), &["init", "-b", branch]);
    git(dir.path(), &["config", "user.email", "t@example.com"]);
    git(dir.path(), &["config", "user.name", user]);
    std::fs::write(dir.path().join("a.txt"), "a").expect("write a.txt");
    git(dir.path(), &["add", "."]);
    git(dir.path(), &["commit", "-m", "init"]);
    dir
}

/// `subprocess.run(["git", *args], cwd=cwd, check=True, capture_output=True, text=True).stdout`.
pub fn git(cwd: &std::path::Path, args: &[&str]) -> String {
    let out = std::process::Command::new("git").args(args).current_dir(cwd).output().expect("git runs");
    assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
    String::from_utf8_lossy(&out.stdout).into_owned()
}
