//! Port of `server/tests/test_sqlite_gate.py`: many writers on one SQLite file. Writers wait in line (first come,
//! first served), none fails with "database is locked", readers never wait for the line, and two changes of one ticket
//! at once both stay (`kb_db::sqlite_gate`, `tickets._for_edit`).
//!
//! What the Python file checks of `aiosqlite` itself (`test_aiosqlite_still_sends_every_call_through_execute`) and of
//! its call lock (`test_reads_take_turns_only_in_wal_mode`) has no counterpart: the Rust gate has no call lock (see
//! the module). The gate's own tests use `kb_db::sqlite_gate` with transactions of a `make_engine` pool, as the
//! Python ones use the engine's connections; `test_comments_and_criteria_added_at_once_are_all_kept` goes through the
//! server (either target).

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::{Duration, Instant};

use kb_db::sea_orm::{ConnectionTrait, DatabaseConnection, DbBackend, Statement, TransactionTrait};
use kb_db::sqlite_gate;
use serde_json::json;
use testkit::{Server, skip_unless_available};

/// A board file in WAL mode (as `init_db` leaves it) and an engine on it, with a table to write.
async fn engine(dir: &Path) -> (PathBuf, DatabaseConnection) {
    let path = dir.join("board.db");
    let target = kb_db::targets::Target::sqlite(path.to_string_lossy().into_owned());
    let engine = kb_db::targets::make_engine(&target, None).await.expect("an engine");
    engine.execute_unprepared("PRAGMA journal_mode=WAL").await.expect("WAL");
    engine.execute_unprepared("CREATE TABLE IF NOT EXISTS gate_t (n INTEGER)").await.expect("a table");
    (path, engine)
}

fn insert(n: i64) -> Statement {
    Statement::from_sql_and_values(DbBackend::Sqlite, "INSERT INTO gate_t VALUES (?)", [n.into()])
}

#[test]
fn test_which_statements_can_wait_for_the_write_lock() {
    for (sql, waits) in [
        ("SELECT 1", false),
        ("  select * from ticket", false),
        ("WITH a AS (SELECT 1) SELECT * FROM a", false),
        ("WITH a AS (SELECT 1) INSERT INTO t SELECT * FROM a", true),
        ("PRAGMA data_version", false),
        ("PRAGMA busy_timeout=30000", false),
        ("PRAGMA journal_mode=WAL", true),
        ("PRAGMA wal_checkpoint(TRUNCATE)", true),
        ("INSERT INTO ticket VALUES (1)", true),
        ("UPDATE ticket SET title = 'x'", true),
        ("BEGIN IMMEDIATE", true),
        ("CREATE TABLE t (a)", true),
    ] {
        assert_eq!(sqlite_gate::may_wait(sql), waits, "{sql}");
    }
}

#[tokio::test]
async fn test_the_write_gate_is_held_for_the_transaction_and_let_go_after() {
    let dir = tempfile::tempdir().expect("temp dir");
    let (path, engine) = engine(dir.path()).await;
    assert_eq!(sqlite_gate::file_of(&engine).as_deref(), Some(path.as_path()));
    {
        let permit = sqlite_gate::enter_for(&engine).await.expect("a turn");
        assert!(permit.is_some());
        let txn = engine.begin().await.expect("a transaction");
        txn.execute_raw(insert(1)).await.expect("an insert");
        assert!(sqlite_gate::is_held(&path));
        txn.rollback().await.expect("rollback");
        drop(permit);
        assert!(!sqlite_gate::is_held(&path));
    }
    // a second writer waits for the first instead of failing, and gets in once it commits
    let order: Arc<StdMutex<Vec<String>>> = Arc::default();
    let writer = |name: &'static str, hold: u64| {
        let (engine, order) = (engine.clone(), order.clone());
        async move {
            let _turn = sqlite_gate::enter_for(&engine).await.expect("a turn");
            let txn = engine.begin().await.expect("a transaction");
            txn.execute_raw(insert(2)).await.expect("an insert");
            order.lock().unwrap_or_else(|e| e.into_inner()).push(format!("{name} in"));
            tokio::time::sleep(Duration::from_millis(hold)).await;
            order.lock().unwrap_or_else(|e| e.into_inner()).push(format!("{name} out"));
            txn.commit().await.expect("commit");
        }
    };
    tokio::join!(writer("first", 200), writer("second", 0));
    assert_eq!(*order.lock().unwrap_or_else(|e| e.into_inner()), ["first in", "first out", "second in", "second out"]);
}

/// First come, first served: writers that arrive one after the other while the gate is taken get in in that order
/// (SQLite's own lock, which they poll, gives no such promise).
#[tokio::test]
async fn writers_are_served_in_the_order_they_came() {
    let dir = tempfile::tempdir().expect("temp dir");
    let (_, engine) = engine(dir.path()).await;
    let first = sqlite_gate::enter_for(&engine).await.expect("a turn");
    let order: Arc<StdMutex<Vec<i64>>> = Arc::default();
    let mut writers = Vec::new();
    for n in 0..12 {
        let (engine, order) = (engine.clone(), order.clone());
        writers.push(tokio::spawn(async move {
            let _turn = sqlite_gate::enter_for(&engine).await.expect("a turn");
            let txn = engine.begin().await.expect("a transaction");
            txn.execute_raw(insert(n)).await.expect("an insert");
            order.lock().unwrap_or_else(|e| e.into_inner()).push(n);
            txn.commit().await.expect("commit");
        }));
        // the next one comes a little later
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    drop(first);
    for w in writers {
        w.await.expect("a writer");
    }
    assert_eq!(*order.lock().unwrap_or_else(|e| e.into_inner()), (0..12).collect::<Vec<_>>());
}

/// A transaction dropped without a commit or a rollback (a session dropped) lets the next writer in.
#[tokio::test]
async fn test_a_connection_closed_without_a_call_lets_the_next_writer_in() {
    let dir = tempfile::tempdir().expect("temp dir");
    let (path, engine) = engine(dir.path()).await;
    let permit = sqlite_gate::enter_for(&engine).await.expect("a turn");
    let txn = engine.begin().await.expect("a transaction");
    // a transaction is open
    txn.execute_raw(insert(1)).await.expect("an insert");
    assert!(sqlite_gate::is_held(&path));
    drop(txn);
    drop(permit);
    assert!(!sqlite_gate::is_held(&path));
    let next = sqlite_gate::enter_within(&path, Duration::from_millis(100)).await;
    assert!(next.is_ok());
}

#[tokio::test]
async fn test_a_writer_that_never_gets_its_turn_fails_like_a_locked_database() {
    let dir = tempfile::tempdir().expect("temp dir");
    let (path, engine) = engine(dir.path()).await;
    let _first = sqlite_gate::enter_for(&engine).await.expect("a turn");
    let txn = engine.begin().await.expect("a transaction");
    txn.execute_raw(insert(1)).await.expect("an insert");
    let err = sqlite_gate::enter_within(&path, Duration::from_millis(100)).await.expect_err("no turn");
    assert!(err.to_string().contains("database is locked"), "{err}");
    txn.rollback().await.expect("rollback");
}

/// Readers never take the gate: a read is served at once while a writer holds it with its transaction open (WAL).
#[tokio::test]
async fn readers_do_not_wait_for_the_writers() {
    let dir = tempfile::tempdir().expect("temp dir");
    let (_, engine) = engine(dir.path()).await;
    let _turn = sqlite_gate::enter_for(&engine).await.expect("a turn");
    let txn = engine.begin().await.expect("a transaction");
    txn.execute_raw(insert(1)).await.expect("an insert");
    let started = Instant::now();
    let row = engine
        .query_one_raw(Statement::from_string(DbBackend::Sqlite, "SELECT count(*) AS n FROM gate_t"))
        .await
        .expect("a read")
        .expect("a row");
    assert_eq!(row.try_get::<i64>("", "n").expect("a number"), 0);
    assert!(started.elapsed() < Duration::from_secs(1));
    txn.commit().await.expect("commit");
}

/// Forty sessions writing at once on one file: every write is kept, none fails with "database is locked".
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn many_writers_at_once_all_get_in() {
    let dir = tempfile::tempdir().expect("temp dir");
    let (_, engine) = engine(dir.path()).await;
    let writers: Vec<_> = (0..40)
        .map(|n| {
            let engine = engine.clone();
            tokio::spawn(async move {
                let session = kb_db::Session::new(engine);
                session.execute_raw(insert(n)).await?;
                tokio::time::sleep(Duration::from_millis(5)).await;
                session.commit().await
            })
        })
        .collect();
    for w in writers {
        w.await.expect("a writer").expect("a write");
    }
    let row = engine
        .query_one_raw(Statement::from_string(DbBackend::Sqlite, "SELECT count(*) AS n FROM gate_t"))
        .await
        .expect("a read")
        .expect("a row");
    assert_eq!(row.try_get::<i64>("", "n").expect("a number"), 40);
}

/// Ten AIs commenting on one ticket at once: every comment stays (the second writer no longer overwrites the first
/// one's list).
#[tokio::test]
async fn test_comments_and_criteria_added_at_once_are_all_kept() {
    if !skip_unless_available("test_comments_and_criteria_added_at_once_are_all_kept") {
        return;
    }
    let s = Server::start().await;
    let c = s.client();
    let r = c.post("/projects", json!({"name": "Load", "prefix": "LD", "color": "#123456"})).await;
    let pid = r.json()["id"].as_str().expect("a project id").to_string();
    let tid = c.post(&format!("/projects/{pid}/tickets"), json!({"title": "Shared"})).await.json()["id"]
        .as_str()
        .expect("a ticket id")
        .to_string();
    let n = 20;
    let comments = (0..n).map(|i| {
        let c = c.clone();
        let path = format!("/tickets/{tid}/comments");
        async move { c.post(&path, json!({"text": format!("note {i}"), "author": format!("AI {i}")})).await }
    });
    let criteria = (0..n).map(|i| {
        let c = c.clone();
        let path = format!("/tickets/{tid}/acceptance-criteria");
        async move { c.post(&path, json!({"text": format!("crit {i}")})).await }
    });
    let (comments, criteria) = tokio::join!(futures::future::join_all(comments), futures::future::join_all(criteria));
    let failed: Vec<String> = comments.iter().chain(&criteria).filter(|r| r.status >= 300).map(|r| r.text()).collect();
    assert!(failed.is_empty(), "{failed:?}");
    let ticket = c.get(&format!("/tickets/{tid}")).await.json();
    let mut texts: Vec<String> = ticket["comments"]
        .as_array()
        .expect("the comments")
        .iter()
        .map(|c| c["text"].as_str().unwrap_or_default().to_string())
        .collect();
    texts.sort();
    let mut wanted: Vec<String> = (0..n).map(|i| format!("note {i}")).collect();
    wanted.sort();
    assert_eq!(texts, wanted);
    assert_eq!(ticket["acceptance_criteria"].as_array().map(Vec::len), Some(n));
    s.stop().await;
}
