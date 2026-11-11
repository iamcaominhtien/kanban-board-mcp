//! A new SQLite database, sessions and the hand-written statements, in one process with its own folders.

use kb_db::entities::{idea_counter, project};
use kb_db::sea_orm::{ActiveModelTrait, ColumnTrait, ConnectionTrait, EntityTrait, QueryFilter, Set, Statement};
use kb_db::{database, schema, sql};

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
    let state = schema::schema_state(&conn).await.unwrap();
    assert_eq!(state.state, "board");
    assert_eq!(state.revision.as_deref(), Some(schema::head_revision()));
    let mode = conn
        .query_one_raw(Statement::from_string(conn.get_database_backend(), "PRAGMA journal_mode"))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(mode.try_get_by_index::<String>(0).unwrap(), "wal");
    let fk = conn
        .query_one_raw(Statement::from_string(conn.get_database_backend(), "PRAGMA foreign_keys"))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(fk.try_get_by_index::<i32>(0).unwrap(), 0);
    // a second start changes nothing
    database::init_db().await.unwrap();
    assert_eq!(idea_counter::Entity::find().all(&conn).await.unwrap().len(), 1);

    // a session: reads need no transaction, the first write opens one, a drop without commit rolls back
    let session = database::session();
    assert!(project::Entity::find().all(&session).await.unwrap().is_empty());
    assert!(!session.in_transaction().await);
    let mut row = project::new();
    row.name = Set("Demo".into());
    row.prefix = Set("DEMO".into());
    row.color = Set("#112233".into());
    let saved = row.insert(&session).await.unwrap();
    assert!(session.in_transaction().await);
    assert_eq!(saved.ticket_counter, 0);
    assert!(saved.docs_enabled);
    // another session does not see it before the commit
    assert!(project::Entity::find().all(&database::session()).await.unwrap().is_empty());
    drop(session);
    assert!(project::Entity::find().all(&conn).await.unwrap().is_empty());

    let session = database::session();
    let mut row = project::new();
    row.name = Set("Demo".into());
    row.prefix = Set("DEMO".into());
    row.color = Set("#112233".into());
    let saved = row.insert(&session).await.unwrap();
    session.commit().await.unwrap();
    assert!(!session.in_transaction().await);
    let found = project::Entity::find().filter(project::Column::Prefix.eq("DEMO")).one(&conn).await.unwrap().unwrap();
    assert_eq!(found.id, saved.id);

    // the ticket counter: one step for every other writer
    let session = database::session();
    let bumped = sql::bump_counter(&session, "project", "ticket_counter", "id", saved.id.clone().into(), &["prefix"])
        .await
        .unwrap()
        .unwrap();
    assert_eq!(bumped.try_get_by_index::<i32>(0).unwrap(), 1);
    assert_eq!(bumped.try_get_by_index::<String>(1).unwrap(), "DEMO");
    assert!(
        sql::bump_counter(&session, "project", "ticket_counter", "id", "nope".into(), &[]).await.unwrap().is_none()
    );
    session.commit().await.unwrap();

    // a row made on first use: the second insert does nothing
    let session = database::session();
    let mut again = project::new();
    again.id = Set(saved.id.clone());
    again.name = Set("Other".into());
    again.prefix = Set("OTH".into());
    again.color = Set("#000000".into());
    database::insert_missing(&session, again).await.unwrap();
    session.commit().await.unwrap();
    let rows = project::Entity::find().all(&conn).await.unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].name, "Demo");
    assert_eq!(rows[0].ticket_counter, 1);
}
