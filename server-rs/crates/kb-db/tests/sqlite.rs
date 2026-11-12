//! A new SQLite database, sessions and the hand-written statements, in one process with its own folders.

mod common;

use kb_db::database;
use kb_db::entities::idea_counter;
use kb_db::sea_orm::{ConnectionTrait, EntityTrait, Statement};

#[tokio::test]
#[allow(unsafe_code)]
async fn a_new_database_gets_the_schema_and_sessions_follow_the_python_rules() {
    let dir = tempfile::tempdir().unwrap();
    // This test is the only one in its process; the folders are set before anything reads them.
    unsafe {
        std::env::set_var("KANBAN_CONFIG_DIR", dir.path().join("config"));
        std::env::set_var("KANBAN_DB_PATH", dir.path().join("data").join("kanban.db"));
        std::env::remove_var("KANBAN_DATABASE_URL");
    }
    database::setup().await.unwrap();
    database::init_db().await.unwrap();
    assert!(database::is_sqlite());
    assert_eq!(database::target_source(), "default");
    assert_eq!(database::get_db_path().file_name().unwrap(), "kanban.db");

    let conn = database::conn();
    let pragma = |name: &'static str| {
        let conn = conn.clone();
        async move {
            conn.query_one_raw(Statement::from_string(conn.get_database_backend(), format!("PRAGMA {name}")))
                .await
                .unwrap()
                .unwrap()
        }
    };
    assert_eq!(pragma("journal_mode").await.try_get_by_index::<String>(0).unwrap(), "wal");
    assert_eq!(pragma("foreign_keys").await.try_get_by_index::<i32>(0).unwrap(), 0);
    assert_eq!(idea_counter::Entity::find().all(&conn).await.unwrap().len(), 1);

    common::scenario().await;
    common::saving().await;
    common::two_writers_of_one_run().await;
}
