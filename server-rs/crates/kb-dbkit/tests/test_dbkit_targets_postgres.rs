//! `test_a_write_by_another_process_is_announced_on_postgres` of `tests/test_dbkit_targets.py`: the change log that
//! lets the board hear another process's writes on a server database. The whole process is pointed at a PostgreSQL
//! database of its own, so this test is alone in its file. Skipped unless `KANBAN_TEST_POSTGRES_URL` is set.

mod common;

use std::time::Duration;

use kb_base::events;
use kb_db::database;
use kb_db::sea_orm::ConnectionTrait;

#[tokio::test]
#[allow(unsafe_code)]
async fn test_a_write_by_another_process_is_announced_on_postgres() {
    let Ok(pg) = std::env::var("KANBAN_TEST_POSTGRES_URL") else {
        println!(
            "SKIPPED test_a_write_by_another_process_is_announced_on_postgres: KANBAN_TEST_POSTGRES_URL is not set"
        );
        return;
    };
    let url = common::own_database(&pg, "kanban_dbkit_changes").await;
    let dir = tempfile::tempdir().expect("tmp");
    // This test is the only one in its process; the settings are in place before anything reads them.
    unsafe {
        std::env::set_var("KANBAN_CONFIG_DIR", dir.path().join("config"));
        std::env::set_var("KANBAN_DB_PATH", dir.path().join("data").join("kanban.db"));
        std::env::set_var("KANBAN_DATABASE_URL", &url);
    }
    database::setup().await.expect("setup");
    let engine = database::conn();
    kb_db::changes::create(&engine).await.expect("the change log");
    let q = events::subscribe();
    let task = tokio::spawn(database::watch_database(None, Duration::from_millis(50), Duration::from_millis(10)));
    tokio::time::sleep(Duration::from_millis(300)).await;
    // this process's own write (any session commit) is logged but not announced again
    let s = database::session();
    s.execute_unprepared("UPDATE kanban_change SET at = at WHERE id < 0").await.expect("write");
    s.commit().await.expect("commit");
    let count = |sql: &'static str| {
        let engine = engine.clone();
        async move {
            let stmt = kb_db::sea_orm::Statement::from_string(engine.get_database_backend(), sql);
            engine.query_one_raw(stmt).await.expect("count").expect("a row").try_get_by_index::<i64>(0).expect("number")
        }
    };
    assert_eq!(count("SELECT COUNT(*) FROM kanban_change").await, 1);
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert!(q.try_recv().is_none());
    // the stdio MCP process writes
    engine
        .execute_unprepared("INSERT INTO kanban_change (origin, at) VALUES ('other-process', 0.0)")
        .await
        .expect("insert");
    let heard = tokio::time::timeout(Duration::from_secs(3), q.recv()).await.expect("an announcement");
    assert!(heard.contains(events::INVALIDATE), "{heard}");
    task.abort();
    events::unsubscribe(&q);
    let _ = engine.close().await;
    common::wipe(&url).await;
}
