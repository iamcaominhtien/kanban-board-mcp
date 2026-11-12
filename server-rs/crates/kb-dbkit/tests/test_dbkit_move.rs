//! `tests/test_dbkit_move.py`: moving a board between databases (design/screens/ai-databases.md D, E): check, copy,
//! verify, stop and resume. These call the copy code directly, as the Python tests did.
//!
//! SQLite to SQLite always runs. With `KANBAN_TEST_POSTGRES_URL` and `KANBAN_TEST_MYSQL_URL` the round trip
//! SQLite → PostgreSQL → MySQL → SQLite runs too, compared row by row.
//!
//! `test_text_in_a_number_column_is_converted` and `test_errors_never_carry_the_row` are unit tests of
//! `move_db::values` and `move_db::errors`.

mod common;

use std::path::Path;

use common::{FTS_TABLES, assert_same_dump, board, board_tables, dump_sqlite, own_database, server_urls, sqlite_exec, sqlite_scalar, wipe};
use kb_db::sea_orm::{ConnectionTrait, DatabaseTransaction, DbErr};
use kb_db::targets::{self, Target};
use kb_dbkit::move_db::{Error, Mover};
use serde_json::{Map, Value, json};

/// Stands in for the Docs area (`docs_search.backfill_sync`): one row per live page.
struct DocsSearch;

#[async_trait::async_trait]
impl kb_dbkit::hooks::DocsSearchHook for DocsSearch {
    async fn backfill(&self, txn: &DatabaseTransaction) -> Result<(), DbErr> {
        txn.execute_unprepared("DELETE FROM docs_fts").await?;
        txn.execute_unprepared(
            "INSERT INTO docs_fts (page_id, project_id, title, headings, body) \
             SELECT id, project_id, 'indexed', '', '' FROM docs_page WHERE deleted_at IS NULL",
        )
        .await?;
        Ok(())
    }
}

fn target(path: &Path) -> Target {
    Target::sqlite(path.to_string_lossy().into_owned())
}

/// `_rows(target)` for a SQLite file: the app's tables and the search tables, row by row.
async fn rows(path: &Path) -> Map<String, Value> {
    board_tables(&dump_sqlite(path).await)
}

/// `_move(source, target, **kw)`.
async fn move_board(source: &Target, target: &Target, empty_first: bool) -> Value {
    let mut m = Mover::new(source.clone(), target.clone(), None).await.expect("mover");
    m.open().await.expect("open");
    let plan = m.plan().await.expect("plan");
    assert!(plan.rows > 0);
    m.prepare_target(empty_first, false).await.expect("prepare");
    m.copy(None, None).await.expect("copy");
    let result = m.verify(None).await.expect("verify");
    m.close().await;
    result
}

#[tokio::test]
async fn test_sqlite_to_sqlite_copies_and_proves_it() {
    let tmp = tempfile::tempdir().expect("tmp");
    let src = board(&tmp.path().join("source.db")).await;
    let dst = target(&tmp.path().join("copy.db"));
    let result = move_board(&src, &dst, false).await;
    assert_eq!(result["ok"], true, "{}", result["checks"]);
    let keys: Vec<&str> = result["checks"].as_array().expect("checks").iter().filter_map(|c| c["key"].as_str()).collect();
    assert_eq!(keys, ["counts", "content", "links", "counters", "search"]);
    assert_same_dump("copy", &rows(Path::new(&src.path)).await, &rows(Path::new(&dst.path)).await);
    // the copy's docs search works (the index was copied)
    let hits =
        sqlite_scalar(Path::new(&dst.path), "SELECT COUNT(*) FROM docs_fts WHERE docs_fts MATCH 'PostgreSQL'").await;
    assert!(hits.as_i64().expect("count") >= 1);
}

#[tokio::test]
async fn test_a_target_that_is_not_empty_is_refused_then_emptied() {
    let tmp = tempfile::tempdir().expect("tmp");
    let src = board(&tmp.path().join("source.db")).await;
    let dst = target(&tmp.path().join("copy.db"));
    move_board(&src, &dst, false).await;
    let mut m = Mover::new(src.clone(), dst.clone(), None).await.expect("mover");
    m.open().await.expect("open");
    let err = m.prepare_target(false, false).await.expect_err("a target that holds a board");
    m.close().await;
    match err {
        Error::Move(err) => assert_eq!(err.code, "target_not_empty"),
        other => panic!("{other:?}"),
    }
    let result = move_board(&src, &dst, true).await;
    assert_eq!(result["ok"], true);
}

#[tokio::test]
async fn test_source_and_target_must_differ() {
    let tmp = tempfile::tempdir().expect("tmp");
    let t = target(&tmp.path().join("a.db"));
    let err = Mover::new(t.clone(), t, None).await.err().expect("the same database twice");
    assert!(matches!(err, Error::Move(ref e) if e.code == "same"), "{err:?}");
    assert_eq!(err.to_string(), "The source and the target are the same database.");
}

#[tokio::test]
async fn test_a_stop_names_the_table_row_and_column_and_resume_finishes() {
    let tmp = tempfile::tempdir().expect("tmp");
    let src = board(&tmp.path().join("source.db")).await;
    let dst = target(&tmp.path().join("copy.db"));
    let dst_path = Path::new(&dst.path);
    let mut m = Mover::new(src.clone(), dst.clone(), None).await.expect("mover");
    m.open().await.expect("open");
    m.plan().await.expect("plan");
    m.prepare_target(false, false).await.expect("prepare");
    // a CHECK on the target that one source row breaks, as a too-short column would on MySQL
    sqlite_exec(
        dst_path,
        "CREATE TRIGGER no_long BEFORE INSERT ON idea_ticket WHEN length(NEW.body) > 255 \
         BEGIN SELECT RAISE(ABORT, 'Data too long for column ''body'' at row 1'); END",
        &[],
    )
    .await;
    let stop = match m.copy(None, None).await {
        Err(Error::Stopped(stop)) => stop,
        other => panic!("the copy did not stop: {other:?}"),
    };
    assert_eq!(stop.table, "idea_ticket");
    assert_eq!(stop.column.as_deref(), Some("body"));
    assert_eq!(stop.row, 1);
    assert!(stop.value_length.expect("a length") > 255);
    assert!(stop.error.contains("Data too long"));
    // what the board knows about the column on both sides
    assert_eq!(stop.source_type.as_deref(), Some("VARCHAR"));
    assert_eq!(stop.target_type.as_deref(), Some("VARCHAR"));
    assert_eq!(stop.target_nullable, Some(false));
    assert!(stop.target_version.starts_with("SQLite 3."), "{}", stop.target_version);
    assert_eq!((stop.source_engine.as_str(), stop.target_engine.as_str(), stop.code.as_str()), ("SQLite", "SQLite", ""));
    // tables before it are complete, the one it stopped in is empty (resume re-reads it from the start)
    let done: Vec<&str> = m.tables().iter().filter(|s| s.state == "done").map(|s| s.name).collect();
    assert!(done.contains(&"project") && !done.contains(&"idea_ticket"));
    assert_eq!(m.tables().iter().find(|s| s.name == "idea_ticket").map(|s| s.state), Some("stopped"));
    assert_eq!(sqlite_scalar(dst_path, "SELECT COUNT(*) FROM idea_ticket").await, 0);
    sqlite_exec(dst_path, "DROP TRIGGER no_long", &[]).await; // the fix
    m.copy(Some("idea_ticket"), None).await.expect("the copy resumes");
    let result = m.verify(None).await.expect("verify");
    m.close().await;
    assert_eq!(result["ok"], true, "{}", result["checks"]);
    assert_same_dump("resumed copy", &rows(Path::new(&src.path)).await, &rows(dst_path).await);
}

#[tokio::test]
async fn test_round_trip_sqlite_postgres_mysql_sqlite() {
    let Some((pg, my)) = server_urls("test_round_trip_sqlite_postgres_mysql_sqlite") else { return };
    kb_dbkit::hooks::set_docs_search_hook(Box::new(DocsSearch));
    let tmp = tempfile::tempdir().expect("tmp");
    let src = board(&tmp.path().join("source.db")).await;
    let pg_url = own_database(&pg, "kanban_dbkit_move_rt").await;
    let my_url = own_database(&my, "kanban_dbkit_move_rt").await;
    let pg = targets::from_url(&pg_url).expect("pg");
    let my = targets::from_url(&my_url).expect("mysql");
    let back = target(&tmp.path().join("back.db"));
    for (a, b) in [(&src, &pg), (&pg, &my), (&my, &back)] {
        let result = move_board(a, b, false).await;
        assert_eq!(result["ok"], true, "{} -> {}: {}", a.engine, b.engine, result["checks"]);
    }
    let first = rows(Path::new(&src.path)).await;
    let mut last = rows(Path::new(&back.path)).await;
    // The search indexes of a file that was copied from a server database are built again, not copied: the knowledge
    // index from its table (the same rows), the Docs index by the Docs area (here: the stand-in below), and the
    // history index is left empty, as the Python copy left it.
    assert_eq!(last["ai_run_fts"], json!([]));
    assert_eq!(
        last["docs_fts"],
        json!([{"page_id": "docs_page:id:1", "project_id": "project:id:1", "title": "indexed", "headings": "", "body": ""}])
    );
    for fts in ["ai_run_fts", "docs_fts"] {
        last.insert(fts.into(), first[fts].clone());
    }
    assert_eq!(FTS_TABLES.iter().filter(|f| first[**f].as_array().is_some_and(|r| !r.is_empty())).count(), 3);
    assert_same_dump("round trip", &first, &last);
    wipe(&pg_url).await;
    wipe(&my_url).await;
}
