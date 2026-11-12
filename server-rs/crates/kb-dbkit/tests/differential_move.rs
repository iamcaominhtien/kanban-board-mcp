//! The check that matters most for the copy code: a board with rows in every table goes
//! SQLite → PostgreSQL → MySQL → SQLite, and every step is made twice from the same source: once by the server under
//! test through the wizard's routes (check, start, verify, switch), once by the Rust copy code called directly, each
//! into a database of its own. After every step the two results are compared table by table. With
//! `PARITY_TARGET=python` this proves the Rust copy writes what the Python copy writes on each engine; with
//! `PARITY_TARGET=rust` that the Rust server's routes run the same copy.
//!
//! The source of each step is the database the server uses at that moment. A running server keeps house in it (it
//! prunes old notifications, for one), so a step is repeated when its source changed while the two copies were made.
//!
//! Needs `KANBAN_TEST_POSTGRES_URL` and `KANBAN_TEST_MYSQL_URL` (`scripts/dev-databases.sh start`).

mod common;

use std::path::Path;

use common::{
    assert_same_dump, board_tables, dump_server, dump_server_schema, dump_sqlite, dump_sqlite_schema, fill, options,
    own_database, server_urls, wait, wipe,
};
use kb_db::sea_orm::{ConnectionTrait, DatabaseTransaction, DbErr};
use kb_db::targets::{self, Target};
use kb_dbkit::move_db::Mover;
use serde_json::{Map, Value, json};
use testkit::{Client, Server, skip_unless_available};

/// Stands in for the Docs area in the direct copy (`docs_search.backfill_sync`): one row per live page.
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

/// One step by the copy code itself (what the target held is deleted first).
async fn direct(source: &Target, target: &Target) -> Value {
    let mut m = Mover::new(source.clone(), target.clone(), None).await.expect("mover");
    m.open().await.expect("open");
    m.plan().await.expect("plan");
    m.prepare_target(true, false).await.expect("prepare");
    m.copy(None, None).await.expect("copy");
    let result = m.verify(None).await.expect("verify");
    m.close().await;
    result
}

/// One step by the server: check, copy (what the target held is deleted first), verify. Returns the move.
async fn by_routes(client: &Client, target: &Target) -> Value {
    let body = if target.is_sqlite() {
        json!({"engine": "sqlite", "path": target.path})
    } else {
        let mut body = Value::Object(target.public());
        body["password"] = json!(target.password);
        body
    };
    let check = client.post("/database/move/check", body).await;
    assert_eq!(check.status, 200, "{}", check.text());
    assert_eq!(check.json()["plan"]["problems"], json!([]), "the check found values the target cannot take");
    let confirm = if target.is_sqlite() {
        Path::new(&target.path).file_name().expect("file name").to_string_lossy().into_owned()
    } else {
        target.name.clone()
    };
    let started =
        client.post("/database/move/start", json!({"mode": "copy", "empty_first": true, "confirm": confirm})).await;
    assert_eq!(started.status, 200, "{}", started.text());
    wait(client, &["verified", "verified_with_differences", "failed", "stopped"]).await
}

/// What a database holds, for telling whether it changed.
async fn dump(target: &Target, url: &str) -> Map<String, Value> {
    if target.is_sqlite() { board_tables(&dump_sqlite(Path::new(&target.path)).await) } else { dump_server(url).await }
}

/// One step, made by the server and by the copy code from the same source. Returns the server's move and the
/// direct copy's verification.
async fn step(
    client: &Client,
    source: (&Target, &str),
    server_target: (&Target, &str),
    direct_target: (&Target, &str),
) -> (Value, Value) {
    for attempt in 1..=5 {
        let before = dump(source.0, source.1).await;
        let job = by_routes(client, server_target.0).await;
        let verified = direct(source.0, direct_target.0).await;
        if dump(source.0, source.1).await == before {
            return (job, verified);
        }
        println!(
            "the source changed during step {} -> {} (attempt {attempt}); again",
            source.0.engine, server_target.0.engine
        );
    }
    panic!("the source {} kept changing", source.0.engine);
}

async fn switch(client: &Client, engine: &str) {
    let switched = client.post("/database/move/switch", json!({})).await;
    assert_eq!(switched.status, 200, "{}", switched.text());
    assert_eq!(switched.json()["database"]["engine"], engine);
    assert_eq!(switched.json()["database"]["reachable"], true);
    assert_eq!(switched.json()["database"]["at_head"], true);
}

#[tokio::test]
async fn test_the_server_and_the_rust_copy_write_the_same_on_every_engine() {
    let name = "test_the_server_and_the_rust_copy_write_the_same_on_every_engine";
    let Some((pg, my)) = server_urls(name) else { return };
    if !skip_unless_available(name) {
        return;
    }
    kb_dbkit::hooks::set_docs_search_hook(Box::new(DocsSearch));
    let tmp = tempfile::tempdir().expect("tmp");
    let python = testkit::target() == testkit::Target::Python;

    let s = Server::start_with(options(tmp.path())).await;
    let client = s.client();
    fill(&s.db_path()).await;
    let filled = board_tables(&dump_sqlite(&s.db_path()).await);
    let sqlite_url = s.db_path().to_string_lossy().into_owned();
    let sqlite = Target::sqlite(sqlite_url.clone());

    let pg_server_url = own_database(&pg, "kanban_dbkit_diff_server").await;
    let pg_direct_url = own_database(&pg, "kanban_dbkit_diff_direct").await;
    let my_server_url = own_database(&my, "kanban_dbkit_diff_server").await;
    let my_direct_url = own_database(&my, "kanban_dbkit_diff_direct").await;
    let pg_server = targets::from_url(&pg_server_url).expect("pg");
    let pg_direct = targets::from_url(&pg_direct_url).expect("pg");
    let my_server = targets::from_url(&my_server_url).expect("mysql");
    let my_direct = targets::from_url(&my_direct_url).expect("mysql");
    let back_server = Target::sqlite(tmp.path().join("back-server.db").to_string_lossy().into_owned());
    let back_direct = Target::sqlite(tmp.path().join("back-direct.db").to_string_lossy().into_owned());
    let all_ok = |what: &str, checks: &Value| {
        assert!(checks.as_array().expect("checks").iter().all(|c| c["ok"] == true), "{what}: {checks}");
    };

    // SQLite → PostgreSQL
    let (job, verified) =
        step(&client, (&sqlite, &sqlite_url), (&pg_server, &pg_server_url), (&pg_direct, &pg_direct_url)).await;
    assert_eq!(job["state"], "verified", "{} {}", job["error"], job["stop"]);
    all_ok("the server's copy to PostgreSQL", &job["verify"]["checks"]);
    all_ok("the direct copy to PostgreSQL", &verified["checks"]);
    assert_eq!(job["verify"]["tables"], verified["tables"]);
    assert_same_dump("on PostgreSQL", &dump_server(&pg_server_url).await, &dump_server(&pg_direct_url).await);
    // and the two databases are made the same way: column types, defaults, keys and indexes
    assert_eq!(dump_server_schema(&pg_server_url).await, dump_server_schema(&pg_direct_url).await);
    switch(&client, "postgresql").await;

    // PostgreSQL → MySQL
    let (job, verified) =
        step(&client, (&pg_server, &pg_server_url), (&my_server, &my_server_url), (&my_direct, &my_direct_url)).await;
    assert_eq!(job["state"], "verified", "{} {}", job["error"], job["stop"]);
    all_ok("the server's copy to MySQL", &job["verify"]["checks"]);
    all_ok("the direct copy to MySQL", &verified["checks"]);
    assert_eq!(job["verify"]["tables"], verified["tables"]);
    assert_same_dump("on MySQL", &dump_server(&my_server_url).await, &dump_server(&my_direct_url).await);
    assert_eq!(dump_server_schema(&my_server_url).await, dump_server_schema(&my_direct_url).await);
    switch(&client, "mysql").await;

    // MySQL → SQLite. The Docs search index of the new file is built by the Docs area: by the Python server, and not
    // yet by the Rust server (its copy then says that the index is behind, and nothing else).
    let (job, verified) = step(&client, (&my_server, &my_server_url), (&back_server, ""), (&back_direct, "")).await;
    assert_eq!(
        job["state"],
        if python { "verified" } else { "verified_with_differences" },
        "{} {}",
        job["error"],
        job["stop"]
    );
    let failed: Vec<&str> = job["verify"]["checks"]
        .as_array()
        .expect("checks")
        .iter()
        .filter(|c| c["ok"] != true)
        .filter_map(|c| c["key"].as_str())
        .collect();
    assert_eq!(failed, if python { vec![] } else { vec!["search"] });
    all_ok("the direct copy back to SQLite", &verified["checks"]);
    let mut from_server = board_tables(&dump_sqlite(Path::new(&back_server.path)).await);
    let mut from_direct = board_tables(&dump_sqlite(Path::new(&back_direct.path)).await);
    let live = from_direct["docs_page"].as_array().expect("pages").iter().filter(|p| p["deleted_at"].is_null()).count();
    let indexed = from_server.remove("docs_fts").expect("docs_fts");
    assert_eq!(indexed.as_array().expect("rows").len(), if python { live } else { 0 });
    assert_eq!(from_direct.remove("docs_fts").expect("docs_fts").as_array().expect("rows").len(), live);
    assert_same_dump("back on SQLite", &from_server, &from_direct);
    let (made_by_server, made_directly) = (
        dump_sqlite_schema(Path::new(&back_server.path)).await,
        dump_sqlite_schema(Path::new(&back_direct.path)).await,
    );
    for (a, b) in made_by_server.iter().zip(&made_directly) {
        assert_eq!(a, b);
    }
    assert_eq!(made_by_server.len(), made_directly.len());

    // and what came back is what went in, but for what the server did to its own board on the way (it prunes
    // notifications) and the history index, which a copy from a server database does not rebuild
    assert_eq!(from_direct["ai_run_fts"], json!([]));
    let mut same = 0;
    for (name, rows) in &filled {
        if !matches!(name.as_str(), "docs_fts" | "ai_run_fts") && from_direct[name] == *rows {
            same += 1;
        }
    }
    assert!(same >= filled.len() - 8, "only {same} of {} tables came back as they went in", filled.len());
    assert_eq!(from_direct["ticket"], filled["ticket"]);
    assert_eq!(from_direct["docs_version"], filled["docs_version"]);
    assert_eq!(from_direct["kb_fts"], filled["kb_fts"]);

    drop(s);
    for url in [&pg_server_url, &pg_direct_url, &my_server_url, &my_direct_url] {
        wipe(url).await;
    }
}
