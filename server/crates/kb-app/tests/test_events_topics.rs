//! Port of `server/tests/test_events_topics.py`: announcements with topics, and the typed events of AI v2 runs.
//! These call the event bus (`kb_base::events`) and the database watcher in process, so they are unit tests of the
//! Rust modules, not requests to a server; they share one event bus and run one at a time.

use std::time::Duration;

use kb_base::events;
use serde_json::{Map, Value, json};
use sqlx::Connection;
use tokio::sync::Mutex;

static BUS: Mutex<()> = Mutex::const_new(());

#[tokio::test]
async fn test_a_topic_makes_the_announcement_say_what_changed() {
    let _turn = BUS.lock().await;
    let q = events::subscribe();
    events::publish(events::INVALIDATE, &[]).await;
    events::publish(events::INVALIDATE, &["ai", "ai"]).await;
    assert_eq!(q.try_recv().as_deref(), Some("invalidate"));
    let second: Value = serde_json::from_str(&q.try_recv().expect("an announcement")).expect("json");
    assert_eq!(second, json!({"type": "invalidate", "topics": ["ai"]}));
    events::unsubscribe(&q);
}

#[tokio::test]
async fn test_a_runs_steps_are_one_typed_event_not_a_refetch() {
    // AI v2: the app patches its cache from `ai.step`; nothing asks every screen to refetch.
    let _turn = BUS.lock().await;
    let q = events::subscribe();
    let mut payload = Map::new();
    payload.insert("run_id".into(), json!("r1"));
    payload.insert("steps".into(), json!([{"seq": 1}]));
    events::publish_typed("ai.step", &payload).await;
    let got: Value = serde_json::from_str(&q.try_recv().expect("an event")).expect("json");
    assert_eq!(got, json!({"type": "ai.step", "run_id": "r1", "steps": [{"seq": 1}]}));
    assert!(q.try_recv().is_none());
    events::unsubscribe(&q);
}

#[tokio::test]
async fn test_a_typed_event_counts_as_this_process_changing_the_database() {
    let _turn = BUS.lock().await;
    let before = events::published();
    let q = events::subscribe();
    let mut payload = Map::new();
    payload.insert("run".into(), json!({"id": "r1"}));
    events::publish_typed("ai.run", &payload).await;
    assert_eq!(events::published(), before + 1);
    events::unsubscribe(&q);
}

#[tokio::test]
async fn test_the_watcher_announces_another_process_but_not_a_change_this_one_announced() {
    let _turn = BUS.lock().await;
    let dir = tempfile::tempdir().expect("temp dir");
    let path = dir.path().join("w.db");
    let options = sqlx::sqlite::SqliteConnectOptions::new().filename(&path).create_if_missing(true);
    let mut conn = sqlx::SqliteConnection::connect_with(&options).await.expect("open");
    sqlx::query("create table t (x)").execute(&mut conn).await.expect("create");
    let watcher = tokio::spawn(kb_db::database::watch_database(
        Some(path.clone()),
        Duration::from_millis(50),
        Duration::from_millis(20),
    ));
    let q = events::subscribe();
    tokio::time::sleep(Duration::from_millis(200)).await;
    // this process commits and announces: one announcement, not two
    sqlx::query("insert into t values (1)").execute(&mut conn).await.expect("insert");
    events::publish(events::INVALIDATE, &[]).await;
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(drain(&q).len(), 1);
    // another process commits and says nothing: the watcher announces it
    sqlx::query("insert into t values (2)").execute(&mut conn).await.expect("insert");
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(drain(&q).len(), 1);
    watcher.abort();
    events::unsubscribe(&q);
    conn.close().await.expect("close");
}

fn drain(q: &events::Subscriber) -> Vec<String> {
    std::iter::from_fn(|| q.try_recv()).collect()
}
