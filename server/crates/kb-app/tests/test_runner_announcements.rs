//! Port of `server/tests/test_runner_announcements.py`: while an AI runs in the runner process, the windows must not
//! be told "anything changed" over and over.
//!
//! `ai.resources` (RAM and CPU every 2 s) is a reading, not an announcement; the runner tells the API when it wrote
//! (`own_change`), so the database watcher does not take the runner's commits for another app's; on a server
//! database the runner's rows of the change log are not "another process's".
//!
//! The Python tests call the modules in process (and patch their internals), so most of these are tests of the Rust
//! modules (`kb_base::events`, `kb_db::database::watch_database`, `kb_db::changes`, `kb_ai_run::runner::Forwarder`,
//! `kb_mcp::common`), where `PARITY_TARGET` does not matter. `test_ai_resources_reaches_the_windows_but_is_not_an_
//! announcement` is a unit test of `kb_base::events`, `test_an_mcp_tool_announces_what_it_wrote` one of
//! `kb_mcp::common` and the in-process half of `test_own_change_over_http_counts_and_reaches_nobody` one of
//! `kb_ai_api::api::ai_hooks` (the runner's token is not known outside the server). They share the process-wide
//! event bus, so they run one at a time.

use std::collections::BTreeSet;
use std::sync::{Arc, Mutex as StdMutex};
use std::time::Duration;

use kb_base::{events, time};
use kb_db::sea_orm::{ConnectionTrait, DbBackend, Statement};
use serde_json::{Value, json};
use sqlx::Connection;
use testkit::{Server, skip_unless_available};
use tokio::sync::Mutex;

/// The event bus is one per process: the in-process tests take turns.
static BUS: Mutex<()> = Mutex::const_new(());

const MASK: &str = r#"{"type": "invalidate", "topics": ["docs", "tickets"]}"#;

fn drain(subscriber: &events::Subscriber) -> Vec<String> {
    std::iter::from_fn(|| subscriber.try_recv()).collect()
}

/// Nothing told every window to refetch everything; at most the occasional refetch of tickets and Docs that stands in
/// for another app's change hidden behind the runner's (`events::RUNNER_MASK_REFRESH_S`).
fn no_global(got: &[String]) -> bool {
    got.iter().all(|g| g == MASK)
}

async fn sqlite_writer(path: &std::path::Path) -> sqlx::SqliteConnection {
    let options = sqlx::sqlite::SqliteConnectOptions::new().filename(path).create_if_missing(true);
    let mut writer = sqlx::SqliteConnection::connect_with(&options).await.expect("open the database");
    sqlx::query("PRAGMA journal_mode=WAL").execute(&mut writer).await.expect("WAL");
    sqlx::query("CREATE TABLE t (x)").execute(&mut writer).await.expect("create table");
    writer
}

async fn insert(writer: &mut sqlx::SqliteConnection, x: i64) {
    sqlx::query("INSERT INTO t VALUES (?)").bind(x).execute(writer).await.expect("insert");
}

fn watch(db: &std::path::Path, interval_ms: u64, grace_ms: u64) -> tokio::task::JoinHandle<()> {
    tokio::spawn(kb_db::database::watch_database(
        Some(db.to_path_buf()),
        Duration::from_millis(interval_ms),
        Duration::from_millis(grace_ms),
    ))
}

async fn sleep_ms(ms: u64) {
    tokio::time::sleep(Duration::from_millis(ms)).await;
}

#[tokio::test]
async fn test_another_apps_change_is_announced_while_readings_keep_coming() {
    let _turn = BUS.lock().await;
    let dir = tempfile::tempdir().expect("temp dir");
    let db = dir.path().join("kanban.db");
    let mut writer = sqlite_writer(&db).await;
    let q = events::subscribe();
    let task = watch(&db, 20, 100);
    sleep_ms(150).await;
    insert(&mut writer, 1).await;
    // readings during the grace period explain nothing
    for _ in 0..5 {
        sleep_ms(30).await;
        let mut payload = serde_json::Map::new();
        payload.insert("project_id".into(), json!("p"));
        events::publish_typed("ai.resources", &payload).await;
    }
    sleep_ms(300).await;
    assert!(drain(&q).iter().any(|e| e == events::INVALIDATE));
    task.abort();
    events::unsubscribe(&q);
    writer.close().await.expect("close");
}

#[tokio::test]
async fn test_the_runners_own_change_is_not_announced_as_another_apps() {
    let _turn = BUS.lock().await;
    let dir = tempfile::tempdir().expect("temp dir");
    let db = dir.path().join("kanban.db");
    let mut writer = sqlite_writer(&db).await;
    let q = events::subscribe();
    let task = watch(&db, 20, 100);
    sleep_ms(150).await;
    insert(&mut writer, 1).await;
    // what POST /internal/ai/events does
    events::mark_own_change_at(&[time::epoch()]);
    sleep_ms(300).await;
    let got = drain(&q);
    assert!(no_global(&got), "{got:?}");
    task.abort();
    events::unsubscribe(&q);
    writer.close().await.expect("close");
}

/// The watcher sees a change and waits for its announcement; the runner commits again meanwhile and says so at once.
/// That second commit is only seen at the next reading, and must not be taken for another app's.
#[tokio::test]
async fn test_a_runner_commit_told_while_the_watcher_waits_is_still_the_runners() {
    let _turn = BUS.lock().await;
    let dir = tempfile::tempdir().expect("temp dir");
    let db = dir.path().join("kanban.db");
    let mut writer = sqlite_writer(&db).await;
    let q = events::subscribe();
    let task = watch(&db, 50, 300);
    sleep_ms(200).await;
    insert(&mut writer, 1).await;
    events::mark_own_change_at(&[time::epoch()]);
    // the watcher saw the first commit and waits
    sleep_ms(150).await;
    insert(&mut writer, 2).await;
    events::mark_own_change_at(&[time::epoch()]);
    sleep_ms(800).await;
    let got = drain(&q);
    assert!(no_global(&got), "{got:?}");
    // another app's commit, long after the runner's, is announced
    insert(&mut writer, 3).await;
    let got = tokio::time::timeout(Duration::from_secs(2), q.recv()).await.expect("an announcement");
    assert_eq!(got, events::INVALIDATE);
    task.abort();
    events::unsubscribe(&q);
    writer.close().await.expect("close");
}

/// The HTTP half of the Python test (the timed half, which needs the runner's token, is a unit test of the handler,
/// `kb_ai_api::api::ai_hooks`): a body from anyone but the runner is refused, and tells the windows nothing.
#[tokio::test]
async fn test_own_change_over_http_counts_and_reaches_nobody() {
    if !skip_unless_available("test_own_change_over_http_counts_and_reaches_nobody") {
        return;
    }
    let s = Server::start().await;
    let c = s.client();
    let mut ev = s.events().await;
    while ev.next(Duration::from_millis(500)).await.is_some() {}
    let body = json!({"own_change": true}).to_string().into_bytes();
    let refused = c.request("POST", "/internal/ai/events", &[("content-type", "application/json")], Some(body)).await;
    assert_eq!(refused.status, 403);
    let now = time::epoch();
    let body = json!({"own_change": true, "at": [now - 0.2, now]}).to_string().into_bytes();
    let headers = [("content-type", "application/json"), ("x-kanban-internal", "not-the-runner")];
    let refused = c.request("POST", "/internal/ai/events", &headers, Some(body)).await;
    assert_eq!(refused.status, 403);
    assert_eq!(ev.next(Duration::from_millis(800)).await, None);
    s.stop().await;
}

#[tokio::test]
async fn test_a_writing_commit_is_told_and_a_reading_one_is_not() {
    let _turn = BUS.lock().await;
    let calls: Arc<StdMutex<Vec<BTreeSet<String>>>> = Arc::default();
    let seen = calls.clone();
    kb_db::changes::on_write_commit("test_a_writing_commit_is_told", move |tables| {
        seen.lock().unwrap_or_else(|e| e.into_inner()).push(tables.clone());
    });
    let dir = tempfile::tempdir().expect("temp dir");
    let target = kb_db::targets::Target::sqlite(dir.path().join("board.db").to_string_lossy().into_owned());
    let engine = kb_db::targets::make_engine(&target, None).await.expect("an engine");
    engine.execute_unprepared("CREATE TABLE project (id TEXT, name TEXT)").await.expect("a table");
    {
        let session = kb_db::Session::new(engine.clone());
        let read = Statement::from_string(DbBackend::Sqlite, "SELECT * FROM project WHERE id = 'nope'");
        session.query_one_raw(read).await.expect("a read");
        session.commit().await.expect("commit");
    }
    assert!(calls.lock().unwrap_or_else(|e| e.into_inner()).is_empty());
    {
        let session = kb_db::Session::new(engine.clone());
        let add = Statement::from_sql_and_values(
            DbBackend::Sqlite,
            r#"INSERT INTO "project" ("id", "name") VALUES (?, ?)"#,
            ["p1".into(), "Told".into()],
        );
        session.execute_raw(add).await.expect("an insert");
        session.commit().await.expect("commit");
    }
    let got = calls.lock().unwrap_or_else(|e| e.into_inner()).clone();
    kb_db::changes::remove_write_listener("test_a_writing_commit_is_told");
    assert!(got.len() == 1 && got[0].contains("project"), "{got:?}");
}

#[tokio::test]
async fn test_the_runners_rows_of_the_change_log_are_not_another_apps() {
    // its commits reach the write listeners other tests count
    let _turn = BUS.lock().await;
    let dir = tempfile::tempdir().expect("temp dir");
    let target = kb_db::targets::Target::sqlite(dir.path().join("log.db").to_string_lossy().into_owned());
    let engine = kb_db::targets::make_engine(&target, None).await.expect("an engine");
    // SQLite never has the table (`changes::create` skips it): the one of a server database, made by hand
    engine
        .execute_unprepared(
            "CREATE TABLE kanban_change (id INTEGER PRIMARY KEY AUTOINCREMENT, origin VARCHAR(32) NOT NULL, at FLOAT NOT NULL)",
        )
        .await
        .expect("the change log");
    let runner: &str = &kb_ai::runner_link::RUNNER_ORIGIN;
    let ours: String = kb_db::targets::PROCESS_TOKEN.chars().take(32).collect();
    for (origin, at) in [("other-app", 1.0), (runner, 2.0), (ours.as_str(), 3.0)] {
        let row = Statement::from_sql_and_values(
            DbBackend::Sqlite,
            "INSERT INTO kanban_change (origin, at) VALUES (?, ?)",
            [origin.into(), at.into()],
        );
        engine.execute_raw(row).await.expect("a row");
    }
    kb_db::changes::ignore_origin(runner);
    let newest = kb_db::changes::latest_from_others(&engine).await;
    kb_db::changes::forget_origin(runner);
    assert_eq!(newest.expect("the newest row"), 1);
}

/// What the runner's Forwarder posted, and a gate that holds every post until it opens.
#[derive(Clone, Default)]
struct Posts {
    posted: Arc<StdMutex<Vec<Value>>>,
    gate: Arc<tokio::sync::Notify>,
    open: Arc<std::sync::atomic::AtomicBool>,
}

impl Posts {
    fn forwarder(&self, held: bool) -> Arc<kb_ai_run::runner::Forwarder> {
        self.open.store(!held, std::sync::atomic::Ordering::SeqCst);
        let me = self.clone();
        let fwd = kb_ai_run::runner::Forwarder::with_post(Arc::new(move |body| {
            let me = me.clone();
            Box::pin(async move {
                me.posted.lock().unwrap_or_else(|e| e.into_inner()).push(body);
                while !me.open.load(std::sync::atomic::Ordering::SeqCst) {
                    let opened = me.gate.notified();
                    if me.open.load(std::sync::atomic::Ordering::SeqCst) {
                        break;
                    }
                    opened.await;
                }
            })
        }));
        let fwd = Arc::new(fwd);
        fwd.bind(tokio::runtime::Handle::current());
        fwd
    }

    fn release(&self) {
        self.open.store(true, std::sync::atomic::Ordering::SeqCst);
        self.gate.notify_waiters();
    }

    fn got(&self) -> Vec<Value> {
        self.posted.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }
}

fn tables(names: &[&str]) -> BTreeSet<String> {
    names.iter().map(|n| n.to_string()).collect()
}

#[tokio::test]
async fn test_the_runner_tells_its_writes_in_few_posts() {
    // its commits reach the write listeners other tests count
    let _turn = BUS.lock().await;
    let posts = Posts::default();
    let fwd = posts.forwarder(true);
    for _ in 0..10 {
        fwd.note_write(Some(&tables(&["ai_run_step"])));
    }
    sleep_ms(10).await;
    let posted = posts.got();
    // one on its way
    assert!(posted.len() == 1 && posted[0]["own_change"] == json!(true), "{posted:?}");
    assert_eq!(posted[0]["at"].as_array().map(Vec::len), Some(10));
    for _ in 0..3 {
        fwd.note_write(Some(&tables(&["ai_run"])));
    }
    posts.release();
    sleep_ms(50).await;
    let posted = posts.got();
    // the writes meanwhile, in one more
    assert!(posted.len() == 2 && posted[1]["at"].as_array().map(Vec::len) == Some(3), "{posted:?}");
}

/// A run's closing comment, its question, Pending, the work log: the windows refetch the tickets.
#[tokio::test]
async fn test_a_ticket_the_runner_wrote_is_announced_once_for_a_burst() {
    // its commits reach the write listeners other tests count
    let _turn = BUS.lock().await;
    let posts = Posts::default();
    let fwd = posts.forwarder(false);
    fwd.note_write(Some(&tables(&["ai_run_step"])));
    sleep_ms(20).await;
    assert!(posts.got().iter().all(|b| b.get("event").is_none()));
    for _ in 0..5 {
        fwd.note_write(Some(&tables(&["ticket", "ai_run"])));
    }
    sleep_ms(50).await;
    let told: Vec<Value> = posts.got().iter().filter_map(|b| b.get("event").cloned()).collect();
    assert!(!told.is_empty() && told.len() <= 2, "{told:?}");
    assert!(told.iter().all(|t| t == r#"{"type": "invalidate", "topics": ["tickets"]}"#), "{told:?}");
}

/// On a server database the change log gets its row even when the commit is the only thing after the write (the
/// Python test pretends a SQLite file is a server; here the server is a real one when `KANBAN_TEST_POSTGRES_URL` is
/// set).
#[tokio::test]
async fn test_the_change_log_is_written_by_a_plain_add_then_commit() {
    // its commits reach the write listeners other tests count
    let _turn = BUS.lock().await;
    let Ok(url) = std::env::var("KANBAN_TEST_POSTGRES_URL") else {
        eprintln!(
            "SKIPPED test_the_change_log_is_written_by_a_plain_add_then_commit: KANBAN_TEST_POSTGRES_URL is not set"
        );
        return;
    };
    let target = kb_db::targets::from_url(&url).expect("a PostgreSQL target");
    let engine = kb_db::targets::make_engine(&target, None).await.expect("an engine");
    let table = format!("t_{}", time::uuid4_hex());
    kb_db::changes::create(&engine).await.expect("the change log");
    engine.execute_unprepared(&format!("CREATE TABLE {table} (name TEXT)")).await.expect("a table");
    let count = async || -> i64 {
        let row = engine
            .query_one_raw(Statement::from_string(DbBackend::Postgres, "SELECT count(*) AS n FROM kanban_change"))
            .await
            .expect("a count")
            .expect("a row");
        row.try_get::<i64>("", "n").expect("a number")
    };
    let before = count().await;
    let session = kb_db::Session::new(engine.clone());
    let add = Statement::from_string(DbBackend::Postgres, format!("INSERT INTO {table} (name) VALUES ('Logged')"));
    session.execute_raw(add).await.expect("an insert");
    session.commit().await.expect("commit");
    let after = count().await;
    engine.execute_unprepared(&format!("DROP TABLE {table}")).await.expect("drop");
    assert_eq!(after, before + 1);
}

/// The runner commits about once a second; another app (an editor's MCP server) edits a ticket at the same moment.
/// SQLite cannot tell the two apart, so the tickets and Docs are refetched now and then (not everything).
#[tokio::test]
async fn test_another_apps_change_hidden_by_the_runners_still_refreshes_tickets_and_docs() {
    let _turn = BUS.lock().await;
    events::set_runner_mask_refresh(Some(0.5));
    let dir = tempfile::tempdir().expect("temp dir");
    let db = dir.path().join("kanban.db");
    let mut writer = sqlite_writer(&db).await;
    let q = events::subscribe();
    let task = watch(&db, 50, 50);
    sleep_ms(200).await;
    for i in 0..8 {
        // the runner's commit and, once, another app's with it
        insert(&mut writer, i).await;
        events::mark_own_change_at(&[time::epoch()]);
        sleep_ms(150).await;
    }
    let got = drain(&q);
    task.abort();
    events::unsubscribe(&q);
    events::set_runner_mask_refresh(None);
    writer.close().await.expect("close");
    assert!(got.iter().any(|g| g == MASK), "{got:?}");
    assert!(!got.iter().any(|g| g == events::INVALIDATE), "{got:?}");
}
