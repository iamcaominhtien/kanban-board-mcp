//! The same scenario on a server database. Skipped unless `KANBAN_TEST_MYSQL_URL` names an empty test database
//! (`scripts/dev-databases.sh start` prints one).

mod common;

use kb_db::database;

#[tokio::test]
#[allow(unsafe_code)]
async fn a_new_database_gets_the_schema_and_sessions_follow_the_python_rules() {
    let Ok(url) = std::env::var("KANBAN_TEST_MYSQL_URL") else {
        println!("SKIPPED: KANBAN_TEST_MYSQL_URL is not set");
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
    // every pooled connection reads what was committed, not a snapshot (five at once, so the pool opens several)
    let checks: Vec<_> = (0..5)
        .map(|_| {
            tokio::spawn(async {
                use kb_db::sea_orm::{ConnectionTrait, Statement, TransactionTrait};
                let txn = database::conn().begin().await.unwrap();
                let backend = txn.get_database_backend();
                let row = txn
                    .query_one_raw(Statement::from_string(backend, "SELECT @@tx_isolation AS level"))
                    .await
                    .unwrap()
                    .unwrap();
                tokio::time::sleep(std::time::Duration::from_millis(300)).await;
                row.try_get::<String>("", "level").unwrap()
            })
        })
        .collect();
    for check in checks {
        assert_eq!(check.await.unwrap(), "READ-COMMITTED");
    }
    common::drop_everything().await;
    database::init_db().await.unwrap();
    common::scenario().await;
    common::saving().await;
    common::two_writers_of_one_run().await;
    common::floats().await;
    common::savepoints().await;
    common::drop_everything().await;
}
