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

    the_metadata_matches_the_schema().await;
    common::scenario().await;
    common::saving().await;
    common::two_writers_of_one_run().await;
    common::read_for_edit_puts_writers_in_line().await;
    common::memo_lasts_until_the_session_writes().await;
    common::floats().await;
    common::savepoints().await;
}

/// `entities::META` (what project delete and the database copy walk) lists every table of the schema and every column
/// of each, with the same NOT NULL as the database.
async fn the_metadata_matches_the_schema() {
    use kb_db::entities::{META, TABLES};
    let conn = database::conn();
    assert_eq!(TABLES, META.iter().map(|t| t.name).collect::<Vec<_>>());
    let in_database = kb_db::schema::table_names(&conn).await.unwrap();
    for name in &in_database {
        let own = name == "alembic_version"
            || ["docs_fts", "ai_run_fts", "kb_fts"].iter().any(|f| name == f || name.starts_with(&format!("{f}_")));
        assert!(own || META.iter().any(|t| t.name == name), "table {name} is not in META");
    }
    for table in META {
        assert!(in_database.iter().any(|n| n == table.name), "META lists {}, the schema has no such table", table.name);
        let rows = conn
            .query_all_raw(Statement::from_string(
                conn.get_database_backend(),
                format!("SELECT name, \"notnull\", pk FROM pragma_table_info('{}')", table.name),
            ))
            .await
            .unwrap();
        let found: Vec<(String, bool, bool)> = rows
            .iter()
            .map(|r| {
                (
                    r.try_get_by_index::<String>(0).unwrap(),
                    r.try_get_by_index::<i32>(1).unwrap() != 0,
                    r.try_get_by_index::<i32>(2).unwrap() != 0,
                )
            })
            .collect();
        let mut have: Vec<&str> = found.iter().map(|(n, _, _)| n.as_str()).collect();
        let mut listed: Vec<&str> = table.columns.iter().map(|c| c.name).collect();
        have.sort_unstable();
        listed.sort_unstable();
        assert_eq!(listed, have, "columns of {}", table.name);
        for column in table.columns {
            let (_, not_null, pk) = found.iter().find(|(n, _, _)| n == column.name).unwrap();
            assert_eq!(column.primary_key, *pk, "{}.{} primary key", table.name, column.name);
            if !pk {
                assert_eq!(!column.nullable, *not_null, "{}.{} NOT NULL", table.name, column.name);
            }
        }
    }
}
