//! The scenario every engine must pass: a new database gets the schema, and sessions follow the Python rules.

use kb_db::Float;
use kb_db::entities::{ai_run, project};
use kb_db::sea_orm::{
    ActiveModelTrait, ColumnTrait, ConnectionTrait, DbErr, EntityTrait, QueryFilter, QueryOrder, Set, Statement,
};
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
    progress.cost_usd = Float(0.5);
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
    assert_eq!((now.tokens_in, now.tokens_out, now.cost_usd.get()), (1200, 340, 0.5));
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
    expected.cost_usd = Float(0.5);
    expected.started_at = now.started_at.clone();
    expected.answer = now.answer.clone();
    expected.paused = true;
    expected.paused_at = now.paused_at.clone();
    expected.ended_by = now.ended_by.clone();
    expected.stop_code = now.stop_code.clone();
    assert_eq!(now, expected);
}

/// The values the float test stores: the awkward ones for a single-precision column.
const FLOATS: [f64; 14] = [
    0.1,
    1234.5678,
    1e-7,
    16_777_217.0,
    -0.002_5,
    0.0,
    123_456_789.0,
    1.0 / 3.0,
    2.5,
    3.0e38,
    // exactly between two six-digit numbers
    1_000_005.0,
    1_000_015.0,
    -98_765.432_1,
    0.300_000_011_920_928_96,
];

/// What the Python server reads for `ids` (`contract/read_floats.py`, the SQLAlchemy model on this database), or
/// `None` when the reference is not there any more.
fn python_floats(ids: &[String]) -> Option<serde_json::Value> {
    let server = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../server");
    let python = server.join(".venv/bin/python");
    if !python.exists() {
        println!("SKIPPED the comparison with Python: {} is not there", python.display());
        return None;
    }
    let own = tempfile::tempdir().unwrap();
    let out = std::process::Command::new(python)
        .arg("../server/contract/read_floats.py")
        .args(ids)
        .current_dir(&server)
        // the database of this test (the URL, or the SQLite file), and folders of its own for everything else
        .env("KANBAN_CONFIG_DIR", own.path().join("config"))
        .env("KANBAN_LOG_DIR", own.path().join("logs"))
        .env("KANBAN_DB_PATH", database::get_db_path())
        .output()
        .unwrap();
    assert!(out.status.success(), "read_floats.py: {}", String::from_utf8_lossy(&out.stderr));
    let text = String::from_utf8_lossy(&out.stdout);
    Some(serde_json::from_str(text.lines().last().unwrap_or("")).unwrap_or_else(|e| panic!("{e}: {text}")))
}

/// A float column gives the number the Python server read (`kb_db::float`): what was stored on SQLite and
/// PostgreSQL, the server's six significant digits on MySQL and MariaDB.
pub async fn floats() {
    let conn = database::conn();
    let backend = conn.get_database_backend();
    let found = project::Entity::find().filter(project::Column::Prefix.eq("DEMO")).one(&conn).await.unwrap().unwrap();

    // stored through the port: a column that cannot be empty and two that can (one left empty)
    let session = database::session();
    let mut ids = Vec::new();
    for (n, value) in FLOATS.iter().enumerate() {
        let mut row = ai_run::new();
        row.id = Set(format!("run_float_{n:02}"));
        row.project_id = Set(found.id.clone());
        row.member_id = Set("team".into());
        row.cost_usd = Set(Float(*value));
        row.peak_rss_mb = Set(Some(Float(*value)));
        row.last_rss_mb = Set(None);
        ids.push(row.insert(&session).await.unwrap().id);
    }
    session.commit().await.unwrap();

    // read back through the port: the entity, a hand-written statement, and what the database adds up
    let rows = ai_run::Entity::find()
        .filter(ai_run::Column::Id.is_in(ids.clone()))
        .order_by_asc(ai_run::Column::Id)
        .all(&conn)
        .await
        .unwrap();
    assert_eq!(rows.len(), FLOATS.len());
    let raw = conn
        .query_all_raw(Statement::from_string(
            backend,
            "SELECT cost_usd, peak_rss_mb, last_rss_mb FROM ai_run WHERE id LIKE 'run_float_%' ORDER BY id",
        ))
        .await
        .unwrap();
    for (row, by_hand) in rows.iter().zip(&raw) {
        assert_eq!(by_hand.try_get_by_index::<Float>(0).unwrap(), row.cost_usd, "{}", row.id);
        assert_eq!(by_hand.try_get_by_index::<Option<Float>>(1).unwrap(), row.peak_rss_mb, "{}", row.id);
        assert_eq!(by_hand.try_get_by_index::<Option<Float>>(2).unwrap(), None, "{}", row.id);
        assert_eq!(row.last_rss_mb, None);
    }
    let totals = conn
        .query_one_raw(Statement::from_string(
            backend,
            "SELECT SUM(cost_usd), AVG(cost_usd), MAX(cost_usd), MIN(cost_usd) FROM ai_run WHERE id LIKE 'run_float_%'",
        ))
        .await
        .unwrap()
        .unwrap();
    let total = |i: usize| totals.try_get_by_index::<Float>(i).unwrap().get();

    if database::dialect() == "mysql" {
        // six significant digits of the single-precision value, as the server prints it
        let read = [
            0.1,
            1234.57,
            1e-7,
            16_777_200.0,
            -0.002_5,
            0.0,
            123_457_000.0,
            0.333_333,
            2.5,
            3.0e38,
            1_000_000.0,
            1_000_020.0,
            -98_765.4,
            0.3,
        ];
        for (row, want) in rows.iter().zip(read) {
            assert_eq!(row.cost_usd.to_bits(), f64::to_bits(want), "{}: {} for {want}", row.id, row.cost_usd);
            assert_eq!(row.peak_rss_mb.map(|v| v.to_bits()), Some(f64::to_bits(want)), "{}", row.id);
        }
    } else {
        // double precision: exactly what was stored
        for (row, stored) in rows.iter().zip(FLOATS) {
            assert_eq!(row.cost_usd.to_bits(), stored.to_bits(), "{}: {} for {stored}", row.id, row.cost_usd);
            assert_eq!(row.peak_rss_mb.map(|v| v.to_bits()), Some(stored.to_bits()), "{}", row.id);
        }
    }

    // and the Python server reads the same numbers through its own model and driver
    if let Some(python) = python_floats(&ids) {
        let bits = |v: &serde_json::Value| v.as_f64().map(f64::to_bits);
        for row in &rows {
            let theirs = &python["rows"][&row.id];
            assert_eq!(bits(&theirs[0]), Some(row.cost_usd.to_bits()), "{} cost_usd: Python {theirs}", row.id);
            assert_eq!(bits(&theirs[1]), row.peak_rss_mb.map(|v| v.to_bits()), "{} peak: Python {theirs}", row.id);
            assert!(theirs[2].is_null(), "{}: Python {theirs}", row.id);
        }
        for (i, name) in ["sum", "avg", "max", "min"].into_iter().enumerate() {
            let theirs = python[name].as_f64().unwrap();
            // PostgreSQL adds floats up in an order of its own choosing between two statements only when rows
            // change; these are the same rows, so the same number
            assert_eq!(total(i).to_bits(), theirs.to_bits(), "{name}: {} here, {theirs} in Python", total(i));
        }
    }

    // a write of what was read changes nothing (the diff sees equal numbers)
    let session = database::session();
    let first = ai_run::Entity::find_by_id("run_float_01").one(&session).await.unwrap().unwrap();
    kb_db::save_model(&session, &first, first.clone()).await.unwrap();
    let mut same = kb_db::edit(first.clone());
    same.cost_usd = Set(first.cost_usd);
    same.update(&session).await.unwrap();
    assert!(!session.in_transaction().await);
    ai_run::Entity::delete_many().filter(ai_run::Column::Id.is_in(ids)).exec(&session).await.unwrap();
    session.commit().await.unwrap();
}

/// `session.begin_nested()`: a savepoint that fails undoes only its own writes, one that succeeds joins the
/// transaction, and a statement after a failed one still runs (`Session::nested`).
pub async fn savepoints() {
    let conn = database::conn();
    let backend = conn.get_database_backend();
    let found = project::Entity::find().filter(project::Column::Prefix.eq("DEMO")).one(&conn).await.unwrap().unwrap();
    let rename = |name: &str| {
        Statement::from_sql_and_values(
            backend,
            match backend {
                kb_db::sea_orm::DbBackend::Postgres => "UPDATE project SET name = $1 WHERE id = $2",
                _ => "UPDATE project SET name = ? WHERE id = ?",
            },
            [name.into(), found.id.clone().into()],
        )
    };
    let name_now =
        || async { project::Entity::find_by_id(found.id.clone()).one(&database::conn()).await.unwrap().unwrap().name };

    let session = database::session();
    session.execute_raw(rename("outer")).await.unwrap();
    // a nested part that writes and then fails: its write is undone, the outer one stays
    let failed: Result<Result<(), DbErr>, DbErr> = session
        .nested(async {
            session.execute_raw(rename("inner, undone")).await?;
            session.execute_unprepared("INSERT INTO no_such_table VALUES (1)").await?;
            Ok(())
        })
        .await;
    assert!(matches!(failed, Ok(Err(_))), "the error of the nested part is given back: {failed:?}");
    // the transaction is still usable after the failed statement
    let kept = session.nested(async { session.execute_raw(rename("inner, kept")).await.map(|_| ()) }).await;
    assert!(matches!(kept, Ok(Ok(()))), "{kept:?}");
    session.commit().await.unwrap();
    assert_eq!(name_now().await, "inner, kept");

    // a savepoint in a session that had not written yet opens its transaction; a rollback undoes everything
    let session = database::session();
    let undone = session.nested(async { session.execute_raw(rename("rolled back")).await.map(|_| ()) }).await.unwrap();
    assert!(undone.is_ok());
    assert!(session.in_transaction().await);
    session.rollback().await.unwrap();
    assert_eq!(name_now().await, "inner, kept");

    // put the name back for the scenarios that follow
    let session = database::session();
    session.execute_raw(rename(&found.name)).await.unwrap();
    session.commit().await.unwrap();
}

/// `Session::read_for_edit`: two writers of one row's text, each reading it and then rewriting the whole text, go in
/// line (the second reads what the first committed), and a row that does not exist gives nothing and keeps no lock.
pub async fn read_for_edit_puts_writers_in_line() {
    let conn = database::conn();
    let found = project::Entity::find().filter(project::Column::Prefix.eq("DEMO")).one(&conn).await.unwrap().unwrap();
    let run = a_run(&found.id).await;

    let mut tasks = Vec::new();
    for word in ["alpha", "beta", "gamma", "delta"] {
        let id = run.id.clone();
        tasks.push(tokio::spawn(async move {
            let session = database::session();
            let row = session.read_for_edit::<ai_run::Entity, _>(id.clone()).await.unwrap().unwrap();
            // a slow writer: without the lock, the others read the same text meanwhile
            tokio::time::sleep(std::time::Duration::from_millis(80)).await;
            let mut changed = row.clone();
            changed.answer = Some(format!("{}{word};", row.answer.clone().unwrap_or_default()));
            kb_db::save_model(&session, &row, changed).await.unwrap();
            session.commit().await.unwrap();
        }));
    }
    for task in tasks {
        task.await.unwrap();
    }
    let now = ai_run::Entity::find_by_id(run.id.clone()).one(&conn).await.unwrap().unwrap();
    let answer = now.answer.unwrap();
    for word in ["alpha", "beta", "gamma", "delta"] {
        assert!(answer.contains(&format!("{word};")), "{word} was lost: {answer}");
    }

    // a row that is not there: nothing, and the lock is not kept (another session can write at once)
    let session = database::session();
    assert!(session.read_for_edit::<ai_run::Entity, _>("no-such-run".to_string()).await.unwrap().is_none());
    if database::is_sqlite() {
        assert!(!session.in_transaction().await);
    }
    drop(session);
    let other = database::session();
    let row = other.read_for_edit::<ai_run::Entity, _>(run.id.clone()).await.unwrap().unwrap();
    assert_eq!(row.id, run.id);
    other.rollback().await.unwrap();
}

/// `Session::memo_get` / `memo_set`: kept until the session writes, commits or rolls back (SQLAlchemy's `session.info`
/// as `docs._ticket_mentions` uses it).
pub async fn memo_lasts_until_the_session_writes() {
    let conn = database::conn();
    let found = project::Entity::find().filter(project::Column::Prefix.eq("DEMO")).one(&conn).await.unwrap().unwrap();
    let session = database::session();
    assert!(session.memo_get::<Vec<String>>("k").is_none());
    session.memo_set("k", vec!["a".to_string()]);
    assert_eq!(session.memo_get::<Vec<String>>("k").as_deref(), Some(&vec!["a".to_string()]));
    // another type under the key is not that value
    assert!(session.memo_get::<u32>("k").is_none());
    // reads keep it
    project::Entity::find_by_id(found.id.clone()).one(&session).await.unwrap();
    assert!(session.memo_get::<Vec<String>>("k").is_some());
    // a write forgets it
    let mut row = kb_db::edit(found.clone());
    row.color = Set("#665544".to_string());
    row.update(&session).await.unwrap();
    assert!(session.memo_get::<Vec<String>>("k").is_none());
    // and so do a commit and a rollback
    session.memo_set("k", 1u32);
    session.commit().await.unwrap();
    assert!(session.memo_get::<u32>("k").is_none());
    session.memo_set("k", 1u32);
    session.rollback().await.unwrap();
    assert!(session.memo_get::<u32>("k").is_none());
}
