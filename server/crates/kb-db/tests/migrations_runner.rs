//! The migration runner itself: a step that fails leaves the database at the revision it had, and the stamp follows
//! the chain's branches as Alembic's does. Each test has its own file and connection.

use std::path::Path;

use kb_db::sea_orm::{ConnectionTrait, DatabaseConnection, Statement, TransactionTrait};
use kb_db::{migrations, schema, targets};

async fn connect(db_file: &Path) -> DatabaseConnection {
    // the engine the app itself opens a SQLite file with (no engine enforces foreign keys)
    targets::make_engine(&targets::Target::sqlite(db_file.to_string_lossy().into_owned()), None).await.unwrap()
}

async fn column(conn: &DatabaseConnection, sql: &str) -> Vec<String> {
    let rows = conn.query_all_raw(Statement::from_string(conn.get_database_backend(), sql)).await.unwrap();
    let mut out: Vec<String> = rows.iter().map(|row| row.try_get_by_index::<String>(0).unwrap()).collect();
    out.sort();
    out
}

async fn upgrade_to(conn: &DatabaseConnection, revision: &str) {
    let txn = conn.begin().await.unwrap();
    migrations::upgrade_to(&txn, revision).await.unwrap_or_else(|e| panic!("upgrade to {revision}: {e}"));
    txn.commit().await.unwrap();
}

/// Everything `sqlite_master` holds: the schema, statement by statement.
async fn schema_text(conn: &DatabaseConnection) -> Vec<String> {
    column(conn, "SELECT type || ' ' || name || ' ' || COALESCE(sql, '') FROM sqlite_master").await
}

#[tokio::test]
async fn a_step_that_fails_leaves_the_database_at_its_old_revision() {
    let dir = tempfile::tempdir().unwrap();
    let conn = connect(&dir.path().join("kanban.db")).await;
    upgrade_to(&conn, "a9b8c7d6e5f4").await;
    // Two revisions further on, c2d3e4f5a6b7 makes ai_schedule: a table of that name in the way makes it fail, after
    // b1c2d3e4f5a6 has made seven tables and changed the stamp in the same transaction
    conn.execute_unprepared("CREATE TABLE ai_schedule (id INTEGER PRIMARY KEY)").await.unwrap();
    conn.execute_unprepared(
        "INSERT INTO project (id, name, prefix, color, ticket_counter) VALUES ('p', 'P', 'P', '#000', 0)",
    )
    .await
    .unwrap();
    let before = schema_text(&conn).await;

    let txn = conn.begin().await.unwrap();
    let failed = migrations::upgrade(&txn).await.unwrap_err();
    assert!(failed.to_string().contains("ai_schedule"), "{failed}");
    drop(txn);
    // the transaction ends when it is dropped; wait for the rollback the pool sends
    tokio::time::sleep(std::time::Duration::from_millis(200)).await;

    assert_eq!(schema::current_revisions(&conn).await.unwrap(), ["a9b8c7d6e5f4"]);
    assert_eq!(schema_text(&conn).await, before);
    assert!(!before.iter().any(|line| line.contains("ai_chat")));
    assert_eq!(column(&conn, "SELECT name FROM project").await, ["P"]);

    // with the obstacle gone the same database upgrades
    conn.execute_unprepared("DROP TABLE ai_schedule").await.unwrap();
    upgrade_to(&conn, schema::head_revision()).await;
    assert_eq!(schema::current_revisions(&conn).await.unwrap(), [schema::head_revision()]);
}

#[tokio::test]
async fn the_stamp_has_one_row_per_open_branch_and_one_at_the_end() {
    let dir = tempfile::tempdir().unwrap();
    let conn = connect(&dir.path().join("kanban.db")).await;
    let stamps =
        |conn: DatabaseConnection| async move { column(&conn, "SELECT version_num FROM alembic_version").await };

    // the chain forks after c3d9a1b7e5f2: the AI branch ends at b8d0f2a4c678, the accounts and canvas branch starts
    // at a7c1e3f5b9d2
    upgrade_to(&conn, "b8d0f2a4c678").await;
    assert_eq!(stamps(conn.clone()).await, ["b8d0f2a4c678"]);
    // the first revision of the second branch follows a revision that is no longer stamped: a second row
    upgrade_to(&conn, "c1d2e3f4a5b7").await;
    assert_eq!(stamps(conn.clone()).await, ["b8d0f2a4c678", "c1d2e3f4a5b7"]);
    // the first merge replaces the row of the branch it closes; the canvas revision stays open beside it
    upgrade_to(&conn, "03a006e7b66e").await;
    assert_eq!(stamps(conn.clone()).await, ["03a006e7b66e", "c1d2e3f4a5b7"]);
    // the second merge leaves one row
    upgrade_to(&conn, "fd73ce3d5800").await;
    assert_eq!(stamps(conn.clone()).await, ["fd73ce3d5800"]);
    upgrade_to(&conn, schema::head_revision()).await;
    assert_eq!(stamps(conn.clone()).await, [schema::head_revision()]);

    // the database made revision by revision this way is the one a new database gets from the schema snapshot
    let made = column(&conn, "SELECT m.name || '.' || p.name || ' ' || p.type || ' ' || p.\"notnull\" || ' ' || COALESCE(p.dflt_value, '-') || ' ' || p.pk FROM sqlite_master m JOIN pragma_table_info(m.name) p WHERE m.type = 'table' AND m.name NOT LIKE 'sqlite_%'").await;
    let fresh = connect(&dir.path().join("fresh.db")).await;
    let txn = fresh.begin().await.unwrap();
    schema::create_schema(&txn).await.unwrap();
    txn.commit().await.unwrap();
    let snapshot = column(&fresh, "SELECT m.name || '.' || p.name || ' ' || p.type || ' ' || p.\"notnull\" || ' ' || COALESCE(p.dflt_value, '-') || ' ' || p.pk FROM sqlite_master m JOIN pragma_table_info(m.name) p WHERE m.type = 'table' AND m.name NOT LIKE 'sqlite_%'").await;
    assert_eq!(made, snapshot);
}
