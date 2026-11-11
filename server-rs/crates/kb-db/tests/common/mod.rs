//! The scenario every engine must pass: a new database gets the schema, and sessions follow the Python rules.

use kb_db::entities::project;
use kb_db::sea_orm::{ActiveModelTrait, ColumnTrait, ConnectionTrait, EntityTrait, QueryFilter, Set, Statement};
use kb_db::{database, schema, sql};

/// Empty a server database (every table of the current schema), so the scenario starts from nothing.
#[allow(dead_code)] // the SQLite test starts from a new file
pub async fn drop_everything() {
    let conn = database::conn();
    let backend = conn.get_database_backend();
    for table in schema::table_names(&conn).await.unwrap() {
        let quoted = if database::dialect() == "mysql" { format!("`{table}`") } else { format!("\"{table}\"") };
        conn.execute_raw(Statement::from_string(backend, format!("DROP TABLE {quoted}"))).await.unwrap();
    }
}

fn demo() -> project::ActiveModel {
    let mut row = project::new();
    row.name = Set("Demo".into());
    row.prefix = Set("DEMO".into());
    row.color = Set("#112233".into());
    row
}

pub async fn scenario() {
    let conn = database::conn();
    let state = schema::schema_state(&conn).await.unwrap();
    assert_eq!(state.state, "board");
    assert_eq!(state.revision.as_deref(), Some(schema::head_revision()));
    // on SQLite the three FTS tables and their five shadow tables each are counted, as SQLAlchemy listed them
    assert_eq!(state.tables, if database::is_sqlite() { 77 + 3 * 6 } else { 77 }, "{state:?}");
    // a second start changes nothing
    database::init_db().await.unwrap();

    // a session: reads need no transaction, the first write opens one, a drop without commit rolls back
    let session = database::session();
    assert!(project::Entity::find().all(&session).await.unwrap().is_empty());
    assert!(!session.in_transaction().await);
    let saved = demo().insert(&session).await.unwrap();
    assert!(session.in_transaction().await);
    assert_eq!(saved.ticket_counter, 0);
    assert!(saved.docs_enabled);
    // another session does not see it before the commit
    assert!(project::Entity::find().all(&database::session()).await.unwrap().is_empty());
    drop(session);
    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    assert!(project::Entity::find().all(&conn).await.unwrap().is_empty());

    let session = database::session();
    let saved = demo().insert(&session).await.unwrap();
    session.commit().await.unwrap();
    assert!(!session.in_transaction().await);
    let found = project::Entity::find().filter(project::Column::Prefix.eq("DEMO")).one(&conn).await.unwrap().unwrap();
    assert_eq!(found.id, saved.id);

    // the unique prefix: a second project with it is refused, and the session can go on after a rollback
    let session = database::session();
    let refused = demo().insert(&session).await.unwrap_err();
    assert!(matches!(refused.sql_err(), Some(kb_db::sea_orm::SqlErr::UniqueConstraintViolation(_))), "{refused:?}");
    session.rollback().await.unwrap();
    assert_eq!(project::Entity::find().all(&session).await.unwrap().len(), 1);

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
    let mut again = demo();
    again.id = Set(saved.id.clone());
    again.name = Set("Other".into());
    again.prefix = Set("OTH".into());
    database::insert_missing(&session, again).await.unwrap();
    session.commit().await.unwrap();
    let rows = project::Entity::find().all(&conn).await.unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].name, "Demo");
    assert_eq!(rows[0].ticket_counter, 1);
}
