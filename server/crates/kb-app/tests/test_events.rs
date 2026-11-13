//! Port of `server/tests/test_events.py`: the SSE hub keeps a slow subscriber's stream, and changes made by another
//! process are announced.
//!
//! The two tests that call `events.subscribe()` and `watch_database()` in process are unit tests of the Rust modules
//! (`kb_base::events`, `kb_db::database::watch_database`): they do not go through a server, so `PARITY_TARGET` does not
//! matter to them. They share the process-wide event bus, so they run one at a time.

mod common;

use std::time::Duration;

use kb_base::events;
use sqlx::Connection;
use testkit::{Server, skip_unless_available};
use tokio::sync::Mutex;

/// The event bus is one per process: the in-process tests take turns.
static BUS: Mutex<()> = Mutex::const_new(());

fn drain(subscriber: &events::Subscriber) -> Vec<String> {
    std::iter::from_fn(|| subscriber.try_recv()).collect()
}

async fn sqlite_writer(path: &std::path::Path, wal: bool) -> sqlx::SqliteConnection {
    let options = sqlx::sqlite::SqliteConnectOptions::new().filename(path).create_if_missing(true);
    let mut writer = sqlx::SqliteConnection::connect_with(&options).await.expect("open the database");
    if wal {
        sqlx::query("PRAGMA journal_mode=WAL").execute(&mut writer).await.expect("WAL");
    }
    sqlx::query("CREATE TABLE IF NOT EXISTS t (x)").execute(&mut writer).await.expect("create table");
    writer
}

#[tokio::test]
async fn test_full_queue_keeps_the_subscriber_and_drops_the_oldest() {
    let _turn = BUS.lock().await;
    let before = events::subscriber_count();
    let q = events::subscribe();
    for i in 0..100 {
        events::publish(&format!("e{i}"), &[]).await;
    }
    events::publish("latest", &[]).await;
    // the subscriber is still registered
    assert_eq!(events::subscriber_count(), before + 1);
    let got = drain(&q);
    assert_eq!(got.len(), 100);
    assert!(got[0] == "e1" && got[got.len() - 1] == "latest");
    events::unsubscribe(&q);
    assert_eq!(events::subscriber_count(), before);
}

/// A change another process made to the server's own SQLite file reaches `/events` as one invalidation.
#[tokio::test]
async fn test_change_from_another_process_is_published() {
    if !skip_unless_available("test_change_from_another_process_is_published") {
        return;
    }
    let s = Server::start().await;
    let mut ev = s.events().await;
    // the server's own start-up work may announce itself: wait until it is quiet (the watcher's first reading too)
    let mut quiet_for = 0;
    while quiet_for < 3 {
        match ev.next(Duration::from_millis(500)).await {
            Some(_) => quiet_for = 0,
            None => quiet_for += 1,
        }
    }
    let mut writer = sqlite_writer(&s.db_path(), false).await;
    // the creation of the table is a change too
    let first = ev.next(Duration::from_secs(5)).await;
    assert_eq!(first.as_deref(), Some("invalidate"));
    assert_eq!(ev.next(Duration::from_millis(1500)).await, None, "one announcement per change");
    sqlx::query("INSERT INTO t VALUES (1)").execute(&mut writer).await.expect("insert");
    assert_eq!(ev.next(Duration::from_secs(5)).await.as_deref(), Some("invalidate"));
    writer.close().await.expect("close");
    s.stop().await;
}

#[tokio::test]
async fn test_change_from_another_process_is_published_in_process() {
    let _turn = BUS.lock().await;
    let dir = tempfile::tempdir().expect("temp dir");
    let db = dir.path().join("kanban.db");
    let mut writer = sqlite_writer(&db, true).await;
    let q = events::subscribe();
    let task = tokio::spawn(kb_db::database::watch_database(
        Some(db.clone()),
        Duration::from_millis(20),
        Duration::from_millis(20),
    ));
    // the watcher takes its first reading
    tokio::time::sleep(Duration::from_millis(150)).await;
    assert!(drain(&q).is_empty());
    sqlx::query("INSERT INTO t VALUES (1)").execute(&mut writer).await.expect("insert");
    let got = tokio::time::timeout(Duration::from_secs(2), q.recv()).await.expect("an announcement");
    assert_eq!(got, events::INVALIDATE);
    task.abort();
    events::unsubscribe(&q);
    writer.close().await.expect("close");
}

#[tokio::test]
async fn test_change_this_process_already_announced_is_not_repeated() {
    let _turn = BUS.lock().await;
    let dir = tempfile::tempdir().expect("temp dir");
    let db = dir.path().join("kanban.db");
    let mut writer = sqlite_writer(&db, true).await;
    let q = events::subscribe();
    let task = tokio::spawn(kb_db::database::watch_database(
        Some(db.clone()),
        Duration::from_millis(20),
        Duration::from_millis(100),
    ));
    tokio::time::sleep(Duration::from_millis(150)).await;
    sqlx::query("INSERT INTO t VALUES (1)").execute(&mut writer).await.expect("insert");
    // the watcher saw it and is in its grace period
    tokio::time::sleep(Duration::from_millis(40)).await;
    // what a REST handler does right after its commit
    events::publish(events::INVALIDATE, &[]).await;
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(drain(&q), vec![events::INVALIDATE.to_string()]);
    task.abort();
    events::unsubscribe(&q);
    writer.close().await.expect("close");
}
