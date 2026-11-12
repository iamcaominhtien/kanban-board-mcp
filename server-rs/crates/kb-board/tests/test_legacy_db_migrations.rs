//! `tests/test_data_import_and_legacy_db.py`, the test that needs a server on an older database:
//! `test_database_missing_docs_ai_ignore_is_repaired_and_a_project_deletes`.
//!
//! A pre-release build ran the docs_ai migration without `docs_ai_ignore`, so deleting a project was a 500. The
//! migration `c4e6a8b0d2f1` repairs such a database when the server starts. The Python test called `init_db` and
//! the project service; here the server is started on the old database and the project is made and deleted through
//! its routes, so the same test runs against either server (`PARITY_TARGET`).
//!
//! (`test_database_stamped_with_a_removed_migration_still_upgrades` needs only the database layer and is in
//! `kb-db/tests/test_data_import_and_legacy_db.rs`.)

mod common;

use std::path::{Path, PathBuf};
use std::time::Duration;

use common::{id, project};
use sqlx::sqlite::SqliteConnectOptions;
use sqlx::{ConnectOptions, Connection, Row, SqliteConnection};
use testkit::{Options, Server, skip_unless_available};

/// A folder of this test's own, removed when the test ends.
struct OwnFolder(PathBuf);

impl OwnFolder {
    fn new() -> OwnFolder {
        let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
        let path = std::env::temp_dir().join(format!("kanban-legacy-db-{}-{nanos}", std::process::id()));
        std::fs::create_dir_all(&path).expect("temporary folder");
        OwnFolder(path)
    }
}

impl Drop for OwnFolder {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

async fn open(path: &Path) -> SqliteConnection {
    SqliteConnectOptions::new()
        .filename(path)
        .busy_timeout(Duration::from_secs(10))
        .foreign_keys(false)
        .disable_statement_logging()
        .connect()
        .await
        .unwrap_or_else(|e| panic!("open {}: {e}", path.display()))
}

async fn names(path: &Path, sql: &'static str) -> Vec<String> {
    let mut conn = open(path).await;
    let rows = sqlx::query(sql).fetch_all(&mut conn).await.unwrap();
    let _ = conn.close().await;
    rows.iter().map(|row| row.get::<String, _>(0)).collect()
}

/// A pre-release build ran the docs_ai migration without docs_ai_ignore: deleting a project was a 500.
#[tokio::test]
async fn test_database_missing_docs_ai_ignore_is_repaired_and_a_project_deletes() {
    if !skip_unless_available("test_database_missing_docs_ai_ignore_is_repaired_and_a_project_deletes") {
        return;
    }
    let folder = OwnFolder::new();
    let db_file = folder.0.join("kanban.db");

    // `await database.init_db()`: a database at the head, as a server makes it; this test takes a copy of it
    let first = Server::start().await;
    let mut conn = open(&first.db_path()).await;
    sqlx::query("VACUUM INTO ?").bind(db_file.to_string_lossy().into_owned()).execute(&mut conn).await.unwrap();
    let _ = conn.close().await;
    first.stop().await;
    let head = names(&db_file, "SELECT version_num FROM alembic_version").await;

    // what the pre-release build left: no docs_ai_ignore, stamped at the revision before the repair
    let mut conn = open(&db_file).await;
    sqlx::query("DROP TABLE docs_ai_ignore").execute(&mut conn).await.unwrap();
    sqlx::query("UPDATE alembic_version SET version_num = 'a3c5e7f9b1d4'").execute(&mut conn).await.unwrap();
    let _ = conn.close().await;

    // the second `await database.init_db()`: the server starts on that database and upgrades it
    let server = Server::start_with(Options {
        env: vec![("KANBAN_DB_PATH".to_string(), db_file.to_string_lossy().into_owned())],
        ..Options::default()
    })
    .await;
    assert_eq!(names(&db_file, "SELECT version_num FROM alembic_version").await, head);
    assert_eq!(names(&db_file, "SELECT name FROM sqlite_master WHERE name = 'docs_ai_ignore'").await, ["docs_ai_ignore"]);

    let c = server.client();
    let doomed = project(&c, "Doomed", "DOO").await;
    assert_eq!(names(&db_file, "SELECT name FROM project").await, ["Doomed"]);
    c.delete(&format!("/projects/{}", id(&doomed))).await.assert_status(204);
    assert!(names(&db_file, "SELECT name FROM project").await.is_empty());
    assert_eq!(c.get("/projects").await.json(), serde_json::json!([]));
    server.stop().await;
}
