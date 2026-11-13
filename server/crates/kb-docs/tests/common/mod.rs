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

/// `POST /projects/{pid}/tickets` with `body` (`{"title": ...}` and whatever else), returning the ticket.
pub async fn new_ticket(c: &Client, pid: &str, body: Value) -> Value {
    let r = c.post(&format!("/projects/{pid}/tickets"), body).await;
    r.assert_status(201);
    r.json()
}

/// Insert one row given as `{column: value}`.
pub async fn insert(server: &Server, table: &str, columns: &Value) {
    let columns = columns.as_object().expect("columns");
    let names: Vec<String> = columns.keys().map(|k| format!("\"{k}\"")).collect();
    let marks = vec!["?"; names.len()].join(", ");
    let values: Vec<Value> = columns.values().cloned().collect();
    exec(server, &format!("INSERT INTO \"{table}\" ({}) VALUES ({marks})", names.join(", ")), &values).await;
}

/// A page of Docs: `POST /projects/{pid}/docs/pages` with `{"title": title, **extra}`; the page detail.
pub async fn mk(c: &Client, pid: &str, title: &str, extra: Value) -> Value {
    let mut body = json!({"title": title});
    if let Some(extra) = extra.as_object() {
        for (k, v) in extra {
            body[k] = v.clone();
        }
    }
    let r = c.post(&format!("/projects/{pid}/docs/pages"), body).await;
    assert_eq!(r.status, 201, "{}", r.text());
    r.json()
}

/// `publish` of the Python tests: save the draft, then publish it as the next version; the published page.
pub async fn publish(c: &Client, page: &Value, markdown: &str, note: Option<&str>) -> Value {
    let id = page["id"].as_str().expect("page id");
    c.put(&format!("/docs/pages/{id}/draft"), json!({"markdown": markdown})).await;
    let cur = c.get(&format!("/docs/pages/{id}")).await.json();
    let r = c.post(&format!("/docs/pages/{id}/publish"), json!({"base_version": cur["version"], "note": note})).await;
    assert_eq!(r.status, 200, "{}", r.text());
    r.json()
}

/// A ticket made through the ticket routes (`_ticket` of the Python tests): type task, title "T".
pub async fn ticket(c: &Client, pid: &str, extra: Value) -> Value {
    let mut body = json!({"title": "T", "type": "task"});
    if let Some(extra) = extra.as_object() {
        for (k, v) in extra {
            body[k] = v.clone();
        }
    }
    new_ticket(c, pid, body).await
}

/// The `id` of a reply.
pub fn id(value: &Value) -> String {
    value["id"].as_str().unwrap_or_else(|| panic!("no id in {value}")).to_string()
}

/// A project through `POST /projects` (`pid` fixture: name Kanban, prefix KAN).
pub async fn pid(c: &Client) -> String {
    let r = c.post("/projects", json!({"name": "Kanban", "prefix": "KAN", "color": "#0a0"})).await;
    r.json()["id"].as_str().expect("project id").to_string()
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

/// A multipart body of the Docs import: `files` are `(path, bytes)` (the part's file name is the last segment of the
/// path and the path itself goes in the `paths` fields, as the Python test's `upload` sends them); `fields` are text
/// fields. Returns the `content-type` and the body.
pub fn multipart(files: &[(&str, &[u8])], fields: &[(&str, &str)]) -> (String, Vec<u8>) {
    let boundary = "----kb-docs-test-boundary-7d4a6d158c9";
    let mut body: Vec<u8> = Vec::new();
    for (path, data) in files {
        let name = path.rsplit('/').next().unwrap_or(path);
        body.extend(
            format!("--{boundary}\r\nContent-Disposition: form-data; name=\"files\"; filename=\"{name}\"\r\n")
                .as_bytes(),
        );
        body.extend(b"Content-Type: application/octet-stream\r\n\r\n");
        body.extend(*data);
        body.extend(b"\r\n");
    }
    let paths = files.iter().map(|(p, _)| ("paths", *p));
    for (name, value) in paths.chain(fields.iter().copied()) {
        body.extend(format!("--{boundary}\r\nContent-Disposition: form-data; name=\"{name}\"\r\n\r\n").as_bytes());
        body.extend(value.as_bytes());
        body.extend(b"\r\n");
    }
    body.extend(format!("--{boundary}--\r\n").as_bytes());
    (format!("multipart/form-data; boundary={boundary}"), body)
}

/// `POST /projects/{pid}/docs/import` with these files and fields.
pub async fn import(c: &Client, pid: &str, files: &[(&str, &[u8])], fields: &[(&str, &str)]) -> testkit::Resp {
    let (content_type, body) = multipart(files, fields);
    c.request("POST", &format!("/projects/{pid}/docs/import"), &[("content-type", content_type.as_str())], Some(body))
        .await
}
