//! The two functions the data backup calls when PostgreSQL or MySQL is in use (`kb_board::hooks::DbMoveHook`): the
//! export is a SQLite copy of every table, and an import replaces the server's tables with a file's. The whole
//! process is pointed at a PostgreSQL database of its own, so this test is alone in its file. Skipped unless
//! `KANBAN_TEST_POSTGRES_URL` is set.

mod common;

use common::{sqlite_exec, sqlite_scalar};
use kb_db::database;
use kb_db::entities::project;
use kb_db::sea_orm::{ActiveModelTrait, EntityTrait, Set};
use kb_dbkit::data;

#[tokio::test]
#[allow(unsafe_code)]
async fn test_the_export_is_a_sqlite_copy_and_an_import_replaces_the_tables() {
    let Ok(pg) = std::env::var("KANBAN_TEST_POSTGRES_URL") else {
        println!(
            "SKIPPED test_the_export_is_a_sqlite_copy_and_an_import_replaces_the_tables: KANBAN_TEST_POSTGRES_URL is not set"
        );
        return;
    };
    let url = common::own_database(&pg, "kanban_dbkit_data").await;
    let dir = tempfile::tempdir().expect("tmp");
    // This test is the only one in its process; the settings are in place before anything reads them.
    unsafe {
        std::env::set_var("KANBAN_CONFIG_DIR", dir.path().join("config"));
        std::env::set_var("KANBAN_DB_PATH", dir.path().join("data").join("kanban.db"));
        std::env::set_var("KANBAN_DATABASE_URL", &url);
    }
    database::setup().await.expect("setup");
    database::init_db().await.expect("init");
    let mut row = project::new();
    row.name = Set("On the server — 移动应用 🎯".into());
    row.prefix = Set("SRV".into());
    row.color = Set("#2E6F40".into());
    let session = database::session();
    let saved = row.insert(&session).await.expect("project");
    session.commit().await.expect("commit");

    // export: every table of the database in use, in a SQLite file at the newest migration
    let export = dir.path().join(".db-tmp").join("export-1a2b3c4d.db");
    std::fs::create_dir_all(export.parent().expect("folder")).expect("folder");
    data::copy_current_to_sqlite(&export).await.expect("the export");
    assert_eq!(sqlite_scalar(&export, "SELECT name FROM project").await, "On the server — 移动应用 🎯");
    assert_eq!(
        sqlite_scalar(&export, "SELECT version_num FROM alembic_version").await,
        include_str!("../../kb-db/schema/head.txt").trim()
    );
    assert_eq!(sqlite_scalar(&export, "SELECT COUNT(*) FROM sqlite_master WHERE name = 'docs_fts'").await, 1);
    // a second export into a file that is there is refused, as the copy code refuses any target that holds something
    assert_eq!(
        data::copy_current_to_sqlite(&export).await.expect_err("not empty"),
        "The target already has 95 tables."
    );

    // import: the file's tables replace the server's
    sqlite_exec(&export, "UPDATE project SET name = 'From the file'", &[]).await;
    sqlite_exec(
        &export,
        "INSERT INTO project (id, name, prefix, color, ticket_counter, worktree_by_default, docs_enabled, docs_edit_policy) \
         VALUES ('p2', 'Second', 'SEC', '#000000', 41, 0, 1, 'members')",
        &[],
    )
    .await;
    data::copy_sqlite_into_current(&export).await.expect("the import");
    database::reinit_db(None).await.expect("reinit");
    let mut rows = project::Entity::find().all(&database::conn()).await.expect("projects");
    rows.sort_by(|a, b| a.prefix.cmp(&b.prefix));
    assert_eq!(rows.len(), 2);
    assert_eq!((rows[0].prefix.as_str(), rows[0].ticket_counter, rows[0].docs_enabled), ("SEC", 41, true));
    assert_eq!((rows[1].id.as_str(), rows[1].name.as_str()), (saved.id.as_str(), "From the file"));
    // a file that is not a board is refused, and the server keeps what it had
    let other = dir.path().join("other.db");
    sqlite_exec(&other, "CREATE TABLE notes (x)", &[]).await;
    assert_eq!(
        data::copy_sqlite_into_current(&other).await.expect_err("not a board"),
        "The source does not hold a Kanban board."
    );
    assert_eq!(project::Entity::find().all(&database::conn()).await.expect("projects").len(), 2);

    let _ = database::conn().close().await;
    common::wipe(&url).await;
}
