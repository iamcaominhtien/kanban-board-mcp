//! `tests/test_data_import_and_legacy_db.py`: the test that needs only the database layer. A database stamped by a
//! pre-release build with a migration that was later removed from the chain must still open.
//!
//! The file's other tests are in `kb-board` (`tests/test_data_import_and_legacy_db.rs` for the import helpers and
//! routes, `tests/test_legacy_db_migrations.rs` for the database without `docs_ai_ignore`, which deletes a project).

use kb_db::sea_orm::{ConnectionTrait, Statement, TransactionTrait};
use kb_db::{database, migrations, targets};

/// Pre-release builds stamped f6a7b8c9d0e1, a migration that no longer exists.
#[tokio::test]
#[allow(unsafe_code)]
async fn test_database_stamped_with_a_removed_migration_still_upgrades() {
    let dir = tempfile::tempdir().unwrap();
    let db_file = dir.path().join("kanban.db");

    // `command.upgrade(cfg, "1e1bb4aa5fa4")`, then what the removed migration left behind
    let target = targets::Target::sqlite(db_file.to_string_lossy().into_owned());
    let conn = targets::make_engine(&target, None).await.unwrap();
    let txn = conn.begin().await.unwrap();
    migrations::upgrade_to(&txn, "1e1bb4aa5fa4").await.unwrap();
    for statement in [
        "UPDATE alembic_version SET version_num = 'f6a7b8c9d0e1'",
        "ALTER TABLE ticket ADD COLUMN board TEXT NOT NULL DEFAULT 'main'",
        "INSERT INTO project (id, name, prefix, color, ticket_counter) VALUES ('p1', 'Old project', 'OLD', '#2E6F40', 0)",
    ] {
        txn.execute_unprepared(statement).await.unwrap();
    }
    txn.commit().await.unwrap();
    conn.close().await.unwrap();

    // This test is the only one in its process; the folders are set before anything reads them.
    unsafe {
        std::env::set_var("KANBAN_CONFIG_DIR", dir.path().join("config"));
        std::env::set_var("KANBAN_DB_PATH", &db_file);
        std::env::remove_var("KANBAN_DATABASE_URL");
    }
    database::setup().await.unwrap();
    // used to fail with "Can't locate revision identified by 'f6a7b8c9d0e1'"
    database::init_db().await.unwrap();

    let conn = database::conn();
    let column = |sql: &'static str| {
        let conn = conn.clone();
        async move {
            let rows = conn.query_all_raw(Statement::from_string(conn.get_database_backend(), sql)).await.unwrap();
            rows.iter().map(|row| row.try_get_by_index::<String>(0).unwrap()).collect::<Vec<String>>()
        }
    };
    let version = column("SELECT version_num FROM alembic_version").await;
    let projects = column("SELECT name FROM project").await;
    let tables = column("SELECT name FROM sqlite_master WHERE type='table'").await;

    assert_eq!(version.len(), 1);
    assert_ne!(version[0], "f6a7b8c9d0e1");
    assert_eq!(version[0], kb_db::schema::head_revision());
    assert_eq!(projects, ["Old project"]);
    assert!(tables.contains(&"idea_ticket".to_string()));
    // the column the removed migration added is still there, unused
    assert!(column("SELECT name FROM pragma_table_info('ticket')").await.contains(&"board".to_string()));
}
