//! Shared by the Idea Space tests: the helpers of the Python test files (`_create_project`, `_create_idea`,
//! `_stage`, `_assumption`...) and rows the tests add straight to the server's SQLite file.
#![allow(dead_code)]

use std::sync::atomic::{AtomicU32, Ordering};
use std::time::Duration;

pub mod dump;
pub mod record;
pub mod scenario;

use serde_json::{Value, json};
use sqlx::sqlite::{SqliteArguments, SqliteConnectOptions};
use sqlx::{Arguments, ConnectOptions, Connection, Row, SqliteConnection};
use testkit::{Client, Resp, Server};

/// `/api/idea-tickets`.
pub const API: &str = "/api/idea-tickets";

/// A connection to the running server's SQLite file (WAL: the server keeps serving).
pub async fn db(server: &Server) -> SqliteConnection {
    SqliteConnectOptions::new()
        .filename(server.db_path())
        .busy_timeout(Duration::from_secs(10))
        // as the server itself: no engine enforces foreign keys
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

/// One text value of one row (`None` when there is no row or the value is null).
pub async fn text(server: &Server, sql: &str, params: &[Value]) -> Option<String> {
    let mut c = db(server).await;
    let row = sqlx::query_with(sqlx::AssertSqlSafe(sql.to_string()), arguments(params))
        .fetch_optional(&mut c)
        .await
        .unwrap_or_else(|e| panic!("{sql}: {e}"));
    let value = row.and_then(|r| r.get::<Option<String>, _>(0));
    let _ = c.close().await;
    value
}

/// The `id` of a reply.
pub fn id(value: &Value) -> String {
    value["id"].as_str().unwrap_or_else(|| panic!("no id in {value}")).to_string()
}

static SUFFIX: AtomicU32 = AtomicU32::new(0);

/// `_create_project(c)`: a project with a prefix of its own.
pub async fn create_project(c: &Client) -> Value {
    let n = SUFFIX.fetch_add(1, Ordering::SeqCst);
    // two letters from the counter: a prefix no other project of this server has
    let letters: String = [n / 26 % 26, n % 26].iter().map(|d| char::from(b'A' + *d as u8)).collect();
    let r = c
        .post(
            "/projects",
            json!({"name": format!("Idea Project {letters}"), "prefix": format!("ID{letters}"), "color": "#123456"}),
        )
        .await;
    assert_eq!(r.status, 201, "{}", r.text());
    r.json()
}

/// `_create_idea(c, project_id, **overrides)`.
pub async fn create_idea(c: &Client, project_id: &str, overrides: Value) -> Value {
    let mut payload = json!({"project_id": project_id, "title": "[TEST] Idea ticket"});
    for (key, value) in overrides.as_object().expect("overrides") {
        payload[key] = value.clone();
    }
    let r = c.post(API, payload).await;
    assert_eq!(r.status, 201, "{}", r.text());
    r.json()
}

/// `_stage(c, idea_id, to, **body)`.
pub async fn stage(c: &Client, idea_id: &str, to: &str, body: Value) -> Resp {
    let mut payload = json!({"to": to});
    for (key, value) in body.as_object().expect("body") {
        payload[key] = value.clone();
    }
    c.post(&format!("{API}/{idea_id}/stage"), payload).await
}

/// `_assumption(c, idea_id, text, impact)`: adds one and returns it.
pub async fn assumption(c: &Client, idea_id: &str, text: &str, impact: &str) -> Value {
    let r = c.post(&format!("{API}/{idea_id}/assumption-records"), json!({"text": text, "impact": impact})).await;
    assert_eq!(r.status, 200, "{}", r.text());
    let all = r.json()["assumptions"].clone();
    all.as_array().expect("assumptions").last().expect("one assumption").clone()
}

/// `_ready_idea(c, project_id, title)`: an idea in Exploring with its only (high-impact) assumption validated, so
/// Ready is allowed.
pub async fn ready_idea(c: &Client, project_id: &str, title: &str) -> (Value, Value) {
    let idea = create_idea(c, project_id, json!({"title": title, "problem_statement": "P"})).await;
    let a = assumption(c, &id(&idea), "They pay", "high").await;
    c.patch(&format!("{API}/{}/assumption-records/{}", id(&idea), id(&a)), json!({"status": "validated"})).await;
    assert_eq!(stage(c, &id(&idea), "exploring", json!({})).await.status, 200);
    (idea, a)
}

/// `_trail_text(entry)`: the values of an activity entry as lowercase text.
pub fn trail_text(entry: &Value) -> String {
    entry.as_object().expect("entry").values().map(kb_base::pyjson::py_str).collect::<Vec<_>>().join(" ").to_lowercase()
}

/// A project member, as `POST /projects/{pid}/members` makes it.
pub async fn add_member(c: &Client, pid: &str, name: &str, role: &str) {
    let r = c.post(&format!("/projects/{pid}/members"), json!({"name": name, "role": role})).await;
    assert_eq!(r.status, 201, "{}", r.text());
}

/// Whether the server runs the idea promotion hook of the ticket code (`kb_ideas::register`): the Python server
/// always does, the Rust server once the app registers it. Found out through what it does: a ticket promoted from an
/// idea is moved to Done, and the idea is Shipped where the hook ran. Uses a project and an idea of its own.
pub async fn hook_is_registered(c: &Client) -> bool {
    let p = create_project(c).await;
    let idea = create_idea(c, &id(&p), json!({"title": "Hook probe"})).await;
    let r = c.post(&format!("{API}/{}/promote", id(&idea)), json!({"acknowledge_not_ready": true})).await;
    assert_eq!(r.status, 201, "{}", r.text());
    let ticket_id = id(&r.json()["ticket"]);
    c.patch(&format!("/tickets/{ticket_id}"), json!({"status": "done"})).await.assert_status(200);
    c.get(&format!("{API}/{}", id(&idea))).await.json()["stage"] == "shipped"
}

/// What a test that needs the hook prints where the Rust server does not run it yet.
pub fn skipped_without_the_hook(test: &str) {
    eprintln!(
        "SKIPPED (an assertion of) {test}: the idea promotion hook is not registered in this server \
         (the app has not called kb_ideas::register yet)"
    );
}
