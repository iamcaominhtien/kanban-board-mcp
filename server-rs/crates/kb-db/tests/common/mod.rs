//! The scenario every engine must pass: a new database gets the schema, and sessions follow the Python rules.

use kb_db::entities::{ai_run, project};
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

/// A run of the demo project, stored.
async fn a_run(project_id: &str) -> ai_run::Model {
    let session = database::session();
    let mut row = ai_run::new();
    row.project_id = Set(project_id.to_string());
    row.member_id = Set("team".into());
    let run = row.insert(&session).await.unwrap();
    session.commit().await.unwrap();
    run
}

/// Writing a loaded row back sends the columns that changed and nothing else (`kb_db::save`).
pub async fn saving() {
    let conn = database::conn();
    let found = project::Entity::find().filter(project::Column::Prefix.eq("DEMO")).one(&conn).await.unwrap().unwrap();

    // nothing changed: no statement, so no transaction is opened
    let session = database::session();
    let before = project::Entity::find_by_id(found.id.clone()).one(&session).await.unwrap().unwrap();
    let same = kb_db::save_model(&session, &before, before.clone()).await.unwrap();
    assert_eq!(same, before);
    assert!(!session.in_transaction().await, "an unchanged row sends no UPDATE");
    // a column set to the value it already has is no change either
    let mut row = kb_db::edit(before.clone());
    row.name = Set(before.name.clone());
    assert!(!row.is_changed());
    assert_eq!(row.update(&session).await.unwrap(), before);
    assert!(!session.in_transaction().await, "a column set to its own value sends no UPDATE");

    // one column changed: only that column is written. The other writer's change to another column, made after
    // this session read the row, is still there (a whole-row UPDATE would put the old color back).
    let mut after = before.clone();
    after.name = "Renamed".into();
    let other = database::session();
    let mut theirs = kb_db::edit(project::Entity::find_by_id(found.id.clone()).one(&other).await.unwrap().unwrap());
    theirs.color = Set("#445566".into());
    theirs.update(&other).await.unwrap();
    other.commit().await.unwrap();
    let stored = kb_db::save_model(&session, &before, after).await.unwrap();
    assert!(session.in_transaction().await);
    session.commit().await.unwrap();
    assert_eq!((stored.name.as_str(), stored.color.as_str()), ("Renamed", "#445566"), "the stored row is returned");
    let now = project::Entity::find_by_id(found.id.clone()).one(&conn).await.unwrap().unwrap();
    assert_eq!((now.name.as_str(), now.color.as_str(), now.ticket_counter), ("Renamed", "#445566", 1));

    // the same through an `Edit`: a column set to a new value is written, one set to its old value is not
    let session = database::session();
    let mut mine = kb_db::edit(project::Entity::find_by_id(found.id.clone()).one(&session).await.unwrap().unwrap());
    let other = database::session();
    let mut theirs = kb_db::edit(project::Entity::find_by_id(found.id.clone()).one(&other).await.unwrap().unwrap());
    theirs.color = Set("#778899".into());
    theirs.update(&other).await.unwrap();
    other.commit().await.unwrap();
    mine.name = Set("Demo".into());
    mine.color = Set("#445566".into()); // what this session read: not a change
    assert!(mine.is_changed());
    assert_eq!(mine.before().name, "Renamed");
    mine.update(&session).await.unwrap();
    session.commit().await.unwrap();
    let now = project::Entity::find_by_id(found.id.clone()).one(&conn).await.unwrap().unwrap();
    assert_eq!((now.name.as_str(), now.color.as_str()), ("Demo", "#778899"));

    // a row that is gone: the UPDATE finds nothing and says so
    let session = database::session();
    let run = a_run(&found.id).await;
    ai_run::Entity::delete_by_id(run.id.clone()).exec(&session).await.unwrap();
    session.commit().await.unwrap();
    let mut changed = run.clone();
    changed.state = "running".into();
    let gone = kb_db::save_model(&session, &run, changed).await.unwrap_err();
    assert!(matches!(gone, kb_db::sea_orm::DbErr::RecordNotUpdated), "{gone:?}");
    session.rollback().await.unwrap();
}

/// Two writers of one `ai_run` row that change different columns both keep their change: the runner's process
/// (state, tokens, cost) and the board's process (the answer to a question, a pause).
pub async fn two_writers_of_one_run() {
    let conn = database::conn();
    let found = project::Entity::find().filter(project::Column::Prefix.eq("DEMO")).one(&conn).await.unwrap().unwrap();
    let run = a_run(&found.id).await;

    // both read the row before either writes
    let runner = database::session();
    let board = database::session();
    let runner_read = ai_run::Entity::find_by_id(run.id.clone()).one(&runner).await.unwrap().unwrap();
    let board_read = ai_run::Entity::find_by_id(run.id.clone()).one(&board).await.unwrap().unwrap();

    // the board: an answer and a pause, on the row it read
    let mut answered = board_read.clone();
    answered.answer = Some("Use the second option".into());
    answered.paused = true;
    answered.paused_at = Some("2026-01-02T03:04:05+00:00".into());
    kb_db::save_model(&board, &board_read, answered).await.unwrap();
    board.commit().await.unwrap();

    // the runner: state, tokens and cost, on the row it read before the board wrote
    let mut progress = runner_read.clone();
    progress.state = "running".into();
    progress.tokens_in = 1200;
    progress.tokens_out = 340;
    progress.cost_usd = 0.5;
    progress.started_at = Some("2026-01-02T03:04:00+00:00".into());
    let stored = kb_db::save_model(&runner, &runner_read, progress).await.unwrap();
    runner.commit().await.unwrap();
    assert_eq!(stored.answer.as_deref(), Some("Use the second option"), "the stored row has the other's change");

    // and once more the other way round: the board cancels on a stale row, the runner's numbers stay
    let board_read = board_read.clone(); // as read at the start: state queued, no tokens
    let mut cancelled = kb_db::edit(board_read);
    cancelled.ended_by = Set(Some("user".into()));
    cancelled.stop_code = Set(Some("deleted".into()));
    cancelled.tokens_in = Set(0); // what the board read: not a change, so the runner's 1200 stays
    cancelled.update(&board).await.unwrap();
    board.commit().await.unwrap();

    let now = ai_run::Entity::find_by_id(run.id.clone()).one(&conn).await.unwrap().unwrap();
    assert_eq!(now.state, "running");
    assert_eq!((now.tokens_in, now.tokens_out, now.cost_usd), (1200, 340, 0.5));
    assert_eq!(now.started_at.as_deref(), Some("2026-01-02T03:04:00+00:00"));
    assert_eq!(now.answer.as_deref(), Some("Use the second option"));
    assert!(now.paused);
    assert_eq!(now.paused_at.as_deref(), Some("2026-01-02T03:04:05+00:00"));
    assert_eq!((now.ended_by.as_deref(), now.stop_code.as_deref()), (Some("user"), Some("deleted")));
    // everything neither of them touched is as it was stored
    let mut expected = run.clone();
    expected.state = now.state.clone();
    expected.tokens_in = 1200;
    expected.tokens_out = 340;
    expected.cost_usd = 0.5;
    expected.started_at = now.started_at.clone();
    expected.answer = now.answer.clone();
    expected.paused = true;
    expected.paused_at = now.paused_at.clone();
    expected.ended_by = now.ended_by.clone();
    expected.stop_code = now.stop_code.clone();
    assert_eq!(now, expected);
}
