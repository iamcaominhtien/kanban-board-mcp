//! The same scenario on a server database. Skipped unless `KANBAN_TEST_POSTGRES_URL` names an empty test database
//! (`scripts/dev-databases.sh start` prints one).

mod common;

use kb_db::database;

#[tokio::test]
#[allow(unsafe_code)]
async fn a_new_database_gets_the_schema_and_sessions_follow_the_python_rules() {
    let Ok(url) = std::env::var("KANBAN_TEST_POSTGRES_URL") else {
        println!("SKIPPED: KANBAN_TEST_POSTGRES_URL is not set");
        return;
    };
    let dir = tempfile::tempdir().unwrap();
    // This test is the only one in its process; the settings are in place before anything reads them.
    unsafe {
        std::env::set_var("KANBAN_CONFIG_DIR", dir.path().join("config"));
        std::env::set_var("KANBAN_DB_PATH", dir.path().join("data").join("kanban.db"));
        std::env::set_var("KANBAN_DATABASE_URL", url);
    }
    database::setup().await.unwrap();
    assert!(!database::is_sqlite());
    assert_eq!(database::target_source(), "environment");
    common::drop_everything().await;
    database::init_db().await.unwrap();
    common::scenario().await;
    common::saving().await;
    common::two_writers_of_one_run().await;
    common::read_for_edit_puts_writers_in_line().await;
    common::memo_lasts_until_the_session_writes().await;
    common::floats().await;
    common::savepoints().await;
    common::drop_everything().await;
}
