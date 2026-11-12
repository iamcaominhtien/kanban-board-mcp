//! `tests/test_dbkit_api.py`: the Settings routes of the move (design D, E): test, check, copy, a stop, apply and
//! resume, verify, switch and back. The source is the server's own database; the target is a SQLite file, so this
//! runs everywhere (the engines themselves are covered by `test_dbkit_move.rs` and `differential_move.rs`).
//!
//! The Python test reached into the server to make a copy stop (a trigger added right after the target's tables
//! were made) and to answer for the AI. Here the server is a process: the target is made with the wizard itself
//! (mode "empty"), the trigger is added to its file, and the copy is one "an interruption left" (`db-move.json`),
//! which the server offers to resume. What the AI proposes is in `tests/assist_in_process.rs`: a real Claude Code on
//! this computer must never be asked by a test.

mod common;

use std::path::Path;

use common::{options, sqlite_exec, wait};
use serde_json::{Value, json};
use testkit::{Server, skip_unless_available};

async fn start(key_dir: &Path) -> Server {
    Server::start_with(options(key_dir)).await
}

#[tokio::test]
async fn test_the_card_says_what_the_board_uses() {
    if !skip_unless_available("test_the_card_says_what_the_board_uses") {
        return;
    }
    let tmp = tempfile::tempdir().expect("tmp");
    let s = start(tmp.path()).await;
    let r = s.client().get("/database").await;
    let body = r.json();
    assert_eq!(r.status, 200);
    assert_eq!(body["engine"], "sqlite");
    assert_eq!(body["reachable"], true);
    assert!(body["tables"].as_i64().expect("tables") >= 60);
    assert_eq!(body["locked"], false);
    assert!(!body["settings"].to_string().contains("password"));
    // every key of the card, on both servers
    let mut keys: Vec<&str> = body.as_object().expect("card").keys().map(String::as_str).collect();
    keys.sort_unstable();
    assert_eq!(
        keys,
        [
            "ai_members", "at_head", "data_folder", "display", "engine", "env_var", "label", "latency_ms", "locked",
            "move", "password_saved", "password_store", "projects", "reachable", "revision", "settings", "size",
            "source", "sqlite_file", "tables", "tickets", "unreachable", "version",
        ]
    );
    let db = s.db_path().to_string_lossy().into_owned();
    assert_eq!(body["tables"], 77);
    assert_eq!(body["label"], "SQLite");
    assert_eq!(body["display"], db);
    assert_eq!(body["settings"], json!({"engine": "sqlite", "path": db}));
    assert_eq!((&body["source"], &body["env_var"]), (&json!("default"), &json!("KANBAN_DATABASE_URL")));
    assert_eq!((&body["password_store"], &body["password_saved"]), (&json!("file"), &json!(false)));
    assert_eq!(body["data_folder"], s.db_path().parent().expect("folder").to_string_lossy().into_owned());
    assert_eq!((&body["sqlite_file"]["path"], &body["sqlite_file"]["exists"]), (&json!(db), &json!(true)));
    assert!(body["sqlite_file"]["size"].as_i64().expect("size") > 0 && body["sqlite_file"]["modified"].is_f64());
    assert_eq!((&body["tickets"], &body["projects"], &body["ai_members"]), (&json!(0), &json!(0), &json!(0)));
    assert_eq!((&body["at_head"], &body["unreachable"], &body["move"]), (&json!(true), &Value::Null, &Value::Null));
    assert_eq!(body["revision"], include_str!("../../kb-db/schema/head.txt").trim());
    assert!(body["version"].as_str().expect("version").starts_with("SQLite 3."));
    assert!(body["size"].as_i64() >= body["sqlite_file"]["size"].as_i64());

    let health = s.client().get("/database/health").await;
    assert_eq!(health.status, 200);
    let health = health.json();
    assert_eq!((&health["ok"], &health["unreachable"], &health["retry_s"]), (&json!(true), &Value::Null, &json!(8)));
    assert!(health["latency_ms"].is_u64());
}

#[tokio::test]
async fn test_testing_a_database_that_is_not_there() {
    if !skip_unless_available("test_testing_a_database_that_is_not_there") {
        return;
    }
    let tmp = tempfile::tempdir().expect("tmp");
    let s = start(tmp.path()).await;
    let r = s
        .client()
        .post(
            "/database/test",
            json!({"engine": "postgresql", "host": "127.0.0.1", "port": 1, "name": "x", "user": "u", "password": "p"}),
        )
        .await;
    let body = r.json();
    assert_eq!(body["ok"], false);
    assert_eq!(body["findings"][0]["level"], "error");
    assert!(body["findings"][0]["title"].as_str().expect("title").contains("Cannot reach"));
    // the whole report, word for word
    assert_eq!(
        body,
        json!({
            "target": {"engine": "postgresql", "host": "127.0.0.1", "port": 1, "name": "x", "user": "u", "ssl": "prefer"},
            "findings": [{
                "key": "reach",
                "level": "error",
                "title": "Cannot reach the server · 127.0.0.1:1",
                "detail": "[Errno 111] Connection refused · Check the host name and the port, and that the server is \
                           running and accepts connections from this computer.",
                "fix": "",
                "fix_label": "",
            }],
            "reached": false,
            "version": "",
            "latency_ms": null,
            "state": "unknown",
            "tables": 0,
            "revision": null,
            "tickets": null,
            "secure": null,
            "other_apps": 0,
            "ok": false,
        })
    );
    let r = s
        .client()
        .post("/database/test", json!({"engine": "mysql", "host": "127.0.0.1", "port": 1, "name": "x", "user": "u"}))
        .await;
    assert_eq!(
        r.json()["findings"],
        json!([{
            "key": "reach",
            "level": "error",
            "title": "Cannot reach the server · 127.0.0.1:1",
            "detail": "(2003, \"Can't connect to MySQL server on '127.0.0.1'\") · Check the host name and the port, and \
                       that the server is running and accepts connections from this computer.",
            "fix": "",
            "fix_label": "",
        }])
    );
}

#[tokio::test]
async fn test_redis_is_refused_with_the_reason() {
    if !skip_unless_available("test_redis_is_refused_with_the_reason") {
        return;
    }
    let tmp = tempfile::tempdir().expect("tmp");
    let s = start(tmp.path()).await;
    let r = s.client().post("/database/test", json!({"url": "redis://localhost:6379/0"})).await;
    assert_eq!(r.status, 422);
    assert!(r.json()["detail"].as_str().expect("detail").contains("relational"));
    assert_eq!(
        r.json()["detail"],
        "Redis and MongoDB cannot hold the board: it is relational (tables that refer to each other). \
         Use SQLite, PostgreSQL or MySQL/MariaDB."
    );
    for (body, detail) in [
        (json!({}), "Choose SQLite, PostgreSQL or MySQL/MariaDB."),
        (json!({"engine": "postgresql", "name": "x"}), "Enter the server’s host name."),
        (json!({"engine": "mysql", "host": "h"}), "Enter the database name."),
        (json!({"url": "postgresql:///nohost"}), "The connection string has no host."),
    ] {
        let r = s.client().post("/database/test", body.clone()).await;
        assert_eq!((r.status, r.json()["detail"].as_str()), (422, Some(detail)), "{body}");
    }
}

#[tokio::test]
async fn test_copy_stops_the_ai_proposes_the_board_applies_and_checks() {
    if !skip_unless_available("test_copy_stops_the_ai_proposes_the_board_applies_and_checks") {
        return;
    }
    let tmp = tempfile::tempdir().expect("tmp");
    let s = start(tmp.path()).await;
    let client = s.client();
    let target = tmp.path().join("moved.db");

    let made = client.post("/projects", json!({"name": "Move me", "prefix": "MOV", "color": "#2E6F40"})).await;
    assert_eq!(made.status, 201);
    let body = json!({"engine": "sqlite", "path": target.to_string_lossy()});
    let check = client.post("/database/move/check", body).await;
    assert_eq!(check.status, 200, "{}", check.text());
    let plan = check.json()["plan"].clone();
    assert!(plan["rows"].as_i64().expect("rows") > 0 && plan["tables_count"].as_i64().expect("tables") >= 60);
    assert_eq!(check.json()["state"], "ready");
    assert_eq!(plan["source"]["projects"], 1);
    assert_eq!(
        plan["notes"],
        json!([{
            "key": "search",
            "title": "Docs search is rebuilt",
            "detail": "The search index is built again on the new file after the copy.",
        }])
    );
    assert_eq!((&plan["problems"], &plan["extra_tables"]), (&json!([]), &json!([])));
    assert_eq!(plan["attachments"]["files"], 0);

    // the target's tables, made by the wizard; then a column the target is too small for, as VARCHAR(255) on MySQL
    let r = client.post("/database/move/start", json!({"mode": "empty"})).await;
    assert_eq!(r.status, 200);
    let job = wait(&client, &["verified", "failed"]).await;
    assert_eq!(job["state"], "verified", "{}", job["error"]);
    assert_eq!(client.delete("/database/move").await.status, 200);
    sqlite_exec(
        &target,
        "CREATE TRIGGER too_small BEFORE INSERT ON project WHEN 1 \
         BEGIN SELECT RAISE(ABORT, 'Data too long for column ''name'' at row 1'); END",
        &[],
    )
    .await;
    // a copy that an interruption left: the server offers to resume it
    let state = json!({
        "id": "abcdef012345",
        "state": "copying",
        "target": {"engine": "sqlite", "path": target.to_string_lossy()},
        "done": [],
        "stopped_in": null,
        "saved_at": 0.0,
    });
    let state_file = s.db_path().with_file_name("db-move.json");
    std::fs::write(&state_file, state.to_string()).expect("state file");
    let job = client.get("/database/move").await.json();
    assert_eq!((&job["id"], &job["state"], &job["resume_at"]), (&json!("abcdef012345"), &json!("interrupted"), &json!("ai_account")));
    assert_eq!(job["tables_total"], 77);

    let r = client.post("/database/move/resume", json!({})).await;
    assert_eq!(r.status, 200, "{}", r.text());
    let job = wait(&client, &["stopped", "verified", "failed"]).await;
    assert_eq!(job["state"], "stopped", "{}", job["error"]);
    let stop = &job["stop"];
    assert_eq!((&stop["table"], &stop["column"]), (&json!("project"), &json!("name")));
    assert_eq!(stop["value_length"], 7);
    assert_eq!(
        (&stop["row"], &stop["copied"], &stop["total"], &stop["tables_total"]),
        (&json!(1), &json!(0), &json!(1), &json!(77))
    );
    assert_eq!((&stop["error"], &stop["code"]), (&json!("Data too long for column 'name' at row 1"), &json!("")));
    assert_eq!((&stop["source_type"], &stop["target_type"]), (&json!("VARCHAR"), &json!("VARCHAR")));
    assert_eq!((&stop["source_engine"], &stop["target_engine"]), (&json!("SQLite"), &json!("SQLite")));
    assert_eq!((&stop["target_nullable"], &stop["target_default"], &stop["value_null"]), (&json!(false), &Value::Null, &json!(false)));
    assert_eq!(stop["target_indexes"], json!([]));
    assert_eq!(job["resume_at"], "project");
    // the copy's progress was written down as it went
    let saved: Value = serde_json::from_str(&std::fs::read_to_string(&state_file).expect("state file")).expect("json");
    assert_eq!(saved["state"], "stopped");
    assert_eq!(saved["stopped_in"], "project");
    assert!(saved["done"].as_array().expect("done").contains(&json!("ai_account")));

    let refused = client.post("/database/move/apply", json!({"statements": ["DROP TRIGGER too_small"]})).await;
    assert_eq!(refused.status, 422);
    assert_eq!(
        refused.json()["detail"],
        json!({"code": "refused", "message": "Only ALTER TABLE statements can be applied here: DROP TRIGGER too_small"})
    );

    // Edit it myself: an ALTER TABLE the board accepts runs on the target, and the copy resumes (and stops again
    // here, because the stand-in limit is still there)
    let applied = client
        .post("/database/move/apply", json!({"statements": ["ALTER TABLE project ADD COLUMN extra TEXT;"]}))
        .await;
    assert_eq!(applied.status, 200);
    let job = wait(&client, &["stopped", "verified", "failed"]).await;
    assert_eq!(job["applied"], json!(["ALTER TABLE project ADD COLUMN extra TEXT"]));
    assert_eq!(job["state"], "stopped");

    // what a person would do: the fix the board can run is an ALTER TABLE; the trigger stands in for a too-small
    // column, so drop it directly and resume without a change
    sqlite_exec(&target, "DROP TRIGGER too_small", &[]).await;
    client.post("/database/move/resume", json!({})).await;
    let job = wait(&client, &["verified", "verified_with_differences", "failed"]).await;
    assert_eq!(job["state"], "verified", "{}", job["verify"]);
    let checks = job["verify"]["checks"].as_array().expect("checks");
    assert!(checks.iter().all(|c| c["ok"] == true));
    let titles: Vec<&str> = checks.iter().filter_map(|c| c["title"].as_str()).collect();
    // the board's own first rows (the idea counter, settings) are copied with the project
    let rows = job["rows_total"].as_i64().expect("rows");
    assert!(rows >= 2, "{rows}");
    assert_eq!(
        titles,
        [
            "Row counts · equal in all 77 tables".to_string(),
            format!("Content · {rows} rows read back and compared (500 at random per big table)"),
            "Links between rows · the same 52 kinds of link on both sides".to_string(),
            "Counters · the next ticket number carries on from MOV-1".to_string(),
            "Docs search · 0 of 0 pages indexed".to_string(),
        ]
    );
    assert_eq!((&job["tables_done"], &job["rows_done"]), (&json!(77), &json!(rows)));
    assert_eq!(job["verify"]["rows"], rows);

    client.delete(&format!("/projects/{}", made.json()["id"].as_str().expect("id"))).await;
    let keep = client.delete("/database/move").await;
    assert_eq!(keep.status, 200);
    assert_eq!(keep.json(), json!({"ok": true}));
    assert_eq!(client.get("/database/move").await.json(), Value::Null);
    assert!(!state_file.exists());
}

#[tokio::test]
async fn test_a_target_with_tables_must_be_confirmed_by_name() {
    if !skip_unless_available("test_a_target_with_tables_must_be_confirmed_by_name") {
        return;
    }
    let tmp = tempfile::tempdir().expect("tmp");
    let s = start(tmp.path()).await;
    let client = s.client();
    let target = tmp.path().join("busy.db");
    sqlite_exec(&target, "CREATE TABLE notes (x)", &[]).await;
    // steps that need a move, before there is one
    let none = json!({"code": "none", "message": "No move is in progress."});
    for step in ["start", "pause", "resume", "cancel", "ask", "switch"] {
        let r = client.post(&format!("/database/move/{step}"), json!({})).await;
        assert_eq!((r.status, r.json()["detail"].clone()), (404, none.clone()), "{step}");
    }
    let r = client.post("/database/move/apply", json!({"statements": []})).await;
    assert_eq!((r.status, r.json()["detail"].clone()), (404, none));

    let check = client.post("/database/move/check", json!({"engine": "sqlite", "path": target.to_string_lossy()})).await.json();
    assert_eq!(check["report"]["state"], "foreign");
    assert_eq!(
        check["report"]["findings"],
        json!([
            {"key": "reach", "level": "ok", "title": format!("A file on this computer · {}", target.display()),
             "detail": "", "fix": "", "fix_label": ""},
            {"key": "empty", "level": "warn", "title": "Not empty · 1 tables that are not a Kanban board",
             "detail": "The board will not write into a database that already holds something, because it cannot tell \
                        what is yours. Choose another database, or empty this one in the next step.",
             "fix": "", "fix_label": ""},
        ])
    );
    // steps that the move is not ready for
    let r = client.post("/database/move/pause", json!({})).await;
    assert_eq!((r.status, r.json()["detail"].clone()), (409, json!({"code": "state", "message": "Nothing is being copied."})));
    let r = client.post("/database/move/resume", json!({})).await;
    assert_eq!((r.status, r.json()["detail"].clone()), (409, json!({"code": "state", "message": "The move is ready."})));
    let r = client.post("/database/move/switch", json!({})).await;
    assert_eq!(
        (r.status, r.json()["detail"].clone()),
        (409, json!({"code": "state", "message": "Verify the copy before switching."}))
    );
    let r = client.post("/database/move/ask", json!({})).await;
    assert_eq!((r.status, r.json()["detail"].clone()), (409, json!({"code": "state", "message": "The copy has not stopped."})));
    let r = client.post("/database/move/apply", json!({"statements": ["ALTER TABLE project ADD x INT"]})).await;
    assert_eq!((r.status, r.json()["detail"].clone()), (409, json!({"code": "state", "message": "The copy has not stopped."})));
    let r = client.post("/database/move/start", json!({"mode": "move"})).await;
    assert_eq!((r.status, r.json()["detail"].clone()), (422, json!("mode is copy or empty")));

    let wrong = client.post("/database/move/start", json!({"mode": "copy", "empty_first": true, "confirm": "nope"})).await;
    assert_eq!(wrong.status, 422);
    assert_eq!(wrong.json()["detail"], json!({"code": "confirm", "message": "Type busy.db to confirm."}));
    // without emptying it, the copy is refused when it starts
    let r = client.post("/database/move/start", json!({"mode": "copy"})).await;
    assert_eq!(r.status, 200);
    let job = wait(&client, &["verified", "failed"]).await;
    assert_eq!(job["error"], json!({"code": "target_not_empty", "message": "The target already has 1 tables."}));
    let ok = client.post("/database/move/start", json!({"mode": "empty", "empty_first": true, "confirm": "busy.db"})).await;
    assert_eq!(ok.status, 200);
    let job = wait(&client, &["verified", "failed"]).await;
    assert_eq!(job["state"], "verified");
    assert_eq!(job["verify"]["empty"], true);
    assert_eq!(
        job["verify"],
        json!({"ok": true, "empty": true, "checks": [
            {"key": "schema", "ok": true, "title": "The board's tables were made · no data copied"},
        ]})
    );
    // cancel clears the new database: the file goes
    let cancelled = client.post("/database/move/cancel", json!({})).await;
    assert_eq!((cancelled.status, cancelled.json()["state"].clone()), (200, json!("cancelled")));
    assert!(!target.exists());
}

#[tokio::test]
async fn test_command_for_the_script() {
    if !skip_unless_available("test_command_for_the_script") {
        return;
    }
    let tmp = tempfile::tempdir().expect("tmp");
    let s = start(tmp.path()).await;
    let body = s.client().get_query("/database/command", &[("target", "postgresql://k@h/db")]).await.json();
    assert!(body["dry_run"].as_str().expect("dry_run").contains("--dry-run"));
    assert!(body["run"].as_str().expect("run").contains("--verify"));
    assert_eq!(body["password_env"], "KANBAN_DB_PASSWORD");
    let db = s.db_path().to_string_lossy().into_owned();
    assert_eq!(
        body["dry_run"],
        format!("uv run python -m dbkit.cli migrate --from sqlite:///{db} --to postgresql://k@h/db --dry-run")
    );
    assert_eq!(
        body["run"],
        format!("uv run python -m dbkit.cli migrate --from sqlite:///{db} --to postgresql://k@h/db --verify")
    );
    assert!(body["at"].is_f64());
    let body = s.client().get("/database/command").await.json();
    assert!(body["run"].as_str().expect("run").ends_with("--to postgresql://USER@HOST:5432/DATABASE --verify"));
}

/// Switch after a copy to another SQLite file. The setting only says "SQLite", which is the file in the data folder:
/// the board goes on with the file it had (the copy is a backup), as the Python server did.
#[tokio::test]
async fn test_switch_after_a_copy_to_a_sqlite_file() {
    if !skip_unless_available("test_switch_after_a_copy_to_a_sqlite_file") {
        return;
    }
    let tmp = tempfile::tempdir().expect("tmp");
    let s = start(tmp.path()).await;
    let client = s.client();
    let target = tmp.path().join("other").join("moved.db");
    let made = client.post("/projects", json!({"name": "Move me", "prefix": "MOV", "color": "#2E6F40"})).await;
    assert_eq!(made.status, 201);
    let check = client.post("/database/move/check", json!({"url": format!("sqlite:///{}", target.display())})).await;
    assert_eq!(check.status, 200, "{}", check.text());
    assert_eq!(client.post("/database/move/start", json!({})).await.status, 200);
    let job = wait(&client, &["verified", "verified_with_differences", "failed"]).await;
    assert_eq!(job["state"], "verified", "{job}");
    assert_eq!(common::sqlite_scalar(&target, "SELECT name FROM project").await, "Move me");
    let switched = client.post("/database/move/switch", json!({})).await;
    assert_eq!(switched.status, 200, "{}", switched.text());
    let switched = switched.json();
    assert_eq!(switched["move"]["state"], "switched");
    assert_eq!(switched["database"]["display"], s.db_path().to_string_lossy().into_owned());
    assert_eq!((&switched["database"]["source"], &switched["database"]["projects"]), (&json!("default"), &json!(1)));
    assert_eq!(switched["database"]["move"]["state"], "switched");
    let config: Value =
        serde_json::from_str(&std::fs::read_to_string(s.config_dir().join("config.json")).expect("config")).expect("json");
    assert_eq!(config["database"], json!({"engine": "sqlite"}));
    // the board still reads and writes
    let second = client.post("/projects", json!({"name": "After", "prefix": "AFT", "color": "#2E6F40"})).await;
    assert_eq!(second.status, 201);
    assert_eq!(client.get("/projects").await.json().as_array().expect("projects").len(), 2);

    let back = client.post("/database/use-sqlite", json!({})).await;
    assert_eq!(back.status, 200, "{}", back.text());
    assert_eq!(back.json()["display"], s.db_path().to_string_lossy().into_owned());
    assert_eq!(client.get("/projects").await.json().as_array().expect("projects").len(), 2);

    // a database that does not hold this board is not one to "edit the connection" to
    let foreign = tmp.path().join("notes.db");
    sqlite_exec(&foreign, "CREATE TABLE notes (x)", &[]).await;
    let r = client.post("/database/connection", json!({"engine": "sqlite", "path": foreign.to_string_lossy()})).await;
    assert_eq!(r.status, 422);
    assert_eq!(r.json()["detail"]["code"], "not_this_board");
    assert_eq!(
        r.json()["detail"]["message"],
        "That database does not hold this board; use Move to another database to copy it."
    );
    assert_eq!(r.json()["detail"]["report"]["state"], "foreign");
    // one that does is taken as it is
    let r = client.post("/database/connection", json!({"engine": "sqlite", "path": target.to_string_lossy()})).await;
    assert_eq!(r.status, 200, "{}", r.text());
    assert_eq!(r.json()["engine"], "sqlite");
}
