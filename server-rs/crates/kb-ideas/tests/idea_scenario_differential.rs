//! One idea's whole life on both servers: captured, moved through the stages, given assumptions, evidence, comments,
//! votes and a research log, merged with another, promoted into tickets, and then its tickets changed and deleted so
//! that the idea promotion hook runs. The `idea_*` tables and `ticket` of the database are dumped after the promotion
//! and at the end, and must be what the Python server stored (`contract/golden/idea_scenario.json`, written with
//! `KANBAN_WRITE_GOLDEN=1 PARITY_TARGET=python`), ids and times normalized.
//!
//! The Rust server runs the hook once the app calls `kb_ideas::register()`; until then the second dump is not
//! compared (a notice is printed). `idea_scenario_in_process` runs the same script against the app's router in this
//! process with the hook registered here, and compares both dumps.

mod common;

use std::sync::Mutex;

use common::scenario::{Http, part_one, part_two, stable};
use common::{hook_is_registered, skipped_without_the_hook};
use serde_json::{Value, json};
use testkit::{Client, Server, Target, skip_unless_available, target};

const GOLDEN: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../contract/golden/idea_scenario.json");

static GOLDEN_FILE: Mutex<()> = Mutex::new(());

impl Http for Client {
    async fn call(&self, method: &str, path: &str, actor: Option<&str>, body: Option<Value>) -> (u16, Value) {
        let mut headers: Vec<(&str, &str)> = Vec::new();
        if let Some(actor) = actor {
            headers.push(("x-actor", actor));
        }
        let bytes = body.as_ref().map(|b| {
            headers.push(("content-type", "application/json"));
            serde_json::to_vec(b).expect("json")
        });
        let r = self.request(method, path, &headers, bytes).await;
        let answer = serde_json::from_slice(&r.body).unwrap_or(Value::Null);
        (r.status, answer)
    }
}

/// Compare a dump with the part of the golden file under `key`, writing it first when the golden file is written.
fn check(key: &str, got: &Value) {
    let _one = GOLDEN_FILE.lock().unwrap_or_else(|e| e.into_inner());
    let read = || -> Value {
        std::fs::read_to_string(GOLDEN).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or(json!({}))
    };
    if std::env::var("KANBAN_WRITE_GOLDEN").is_ok_and(|v| v == "1") {
        assert_eq!(target(), Target::Python, "the golden file is what the Python server stores");
        let mut golden = read();
        golden[key] = got.clone();
        std::fs::write(GOLDEN, serde_json::to_string_pretty(&golden).expect("json") + "\n").expect("write golden");
    }
    let golden = read();
    let want = &golden[key];
    for (table, rows) in want.as_object().unwrap_or_else(|| panic!("golden file has no {key}")) {
        let got_rows = got[table].as_array().expect("rows");
        assert_eq!(got_rows.len(), rows.as_array().expect("rows").len(), "{key}: rows of {table}");
        for (got, want) in got_rows.iter().zip(rows.as_array().expect("rows")) {
            assert_eq!(got, want, "{key}: {table} {}", want["id"]);
        }
    }
}

#[tokio::test]
async fn idea_scenario_leaves_the_same_tables_on_both_servers() {
    if !skip_unless_available("idea_scenario_leaves_the_same_tables_on_both_servers") {
        return;
    }
    let s = Server::start().await;
    let c = s.client();
    part_one(&c).await;
    check("after_promote", &stable(&s.dump_db().await));
    if target() == Target::Rust && !hook_is_registered(&c).await {
        skipped_without_the_hook(
            "idea_scenario_leaves_the_same_tables_on_both_servers (the dump after the ticket changes)",
        );
        s.stop().await;
        return;
    }
    // the probe above added a project, an idea and a ticket on the Rust server: the scenario goes on in a new server
    // without it, so that the dump is what the script made
    s.stop().await;
    let s = Server::start().await;
    let c = s.client();
    let made = part_one(&c).await;
    part_two(&c, &made).await;
    check("after_tickets", &stable(&s.dump_db().await));
    s.stop().await;
}

/// The app's router in this process, with the idea promotion hook registered here.
struct InProcess(axum::Router);

impl Http for InProcess {
    async fn call(&self, method: &str, path: &str, actor: Option<&str>, body: Option<Value>) -> (u16, Value) {
        use tower::ServiceExt;
        let mut request = axum::http::Request::builder().method(method).uri(path);
        if let Some(actor) = actor {
            request = request.header("x-actor", actor);
        }
        let request = match body {
            Some(body) => request
                .header("content-type", "application/json")
                .body(axum::body::Body::from(serde_json::to_vec(&body).expect("json"))),
            None => request.body(axum::body::Body::empty()),
        }
        .expect("request");
        let response = self.0.clone().oneshot(request).await.expect("the router answers");
        let status = response.status().as_u16();
        let bytes = axum::body::to_bytes(response.into_body(), 64 << 20).await.expect("body");
        (status, serde_json::from_slice(&bytes).unwrap_or(Value::Null))
    }
}

/// The same script against the app's router in this process, where `kb_ideas::register()` is called here: both
/// dumps must be what the Python server stored.
#[tokio::test]
#[allow(unsafe_code)]
async fn idea_scenario_in_process() {
    let dir = tempfile::tempdir().expect("temporary folder");
    // This test is the only one in its process; the folders are set before anything reads them.
    unsafe {
        std::env::set_var("KANBAN_CONFIG_DIR", dir.path().join("config"));
        std::env::set_var("KANBAN_DB_PATH", dir.path().join("data").join("kanban.db"));
        std::env::set_var("KANBAN_WORKSPACE_ROOT", dir.path().join("workspace"));
        std::env::remove_var("KANBAN_DATABASE_URL");
    }
    kb_db::database::setup().await.expect("database setup");
    kb_db::database::init_db().await.expect("schema");
    kb_ideas::register();
    let http = InProcess(kb_app::app());
    let db = dir.path().join("data").join("kanban.db");
    kb_base::ctx::scope(async {
        let made = part_one(&http).await;
        check("after_promote", &stable(&common::dump::dump(&db).await));
        part_two(&http, &made).await;
        check("after_tickets", &stable(&common::dump::dump(&db).await));
    })
    .await;
}
