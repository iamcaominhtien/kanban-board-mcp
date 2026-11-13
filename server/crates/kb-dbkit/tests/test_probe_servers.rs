//! The connection test (`dbkit/probe.py`) on real servers, through `POST /database/test`: what the test finds, word
//! for word, for a database that is fine, one that is not there, a user the server refuses, a user that may not
//! create tables, a database that holds a board or something else, and for SQLite files. Each expected report was
//! taken from the Python server; the Rust server must give the same from its own driver's errors.
//!
//! Needs `KANBAN_TEST_POSTGRES_URL` and `KANBAN_TEST_MYSQL_URL` (`scripts/dev-databases.sh start`); the SQLite cases
//! always run.

mod common;

use common::{options, own_database, server_urls, sqlite_exec, wipe, with_database};
use kb_db::sea_orm::ConnectionTrait;
use kb_db::targets::{self, Target};
use kb_dbkit::move_db::Mover;
use serde_json::{Value, json};
use testkit::{Server, skip_unless_available};

/// A finding as the tests write it: key, level, title, detail, fix.
fn finding(key: &str, level: &str, title: &str, detail: &str, fix: &str) -> Value {
    json!({
        "key": key, "level": level, "title": title, "detail": detail, "fix": fix,
        "fix_label": if fix.is_empty() { "" } else { "Copy the statement" },
    })
}

/// The findings of a report with what changes from run to run taken out: the milliseconds and the server's version.
fn findings(report: &Value) -> Value {
    let version = report["version"].as_str().unwrap_or("").to_string();
    let number = version.rsplit(' ').next().unwrap_or("").to_string();
    let mut out = report["findings"].clone();
    for f in out.as_array_mut().expect("findings") {
        let mut title = f["title"].as_str().unwrap_or("").to_string();
        if let Some((head, tail)) = title.rsplit_once(" · ") {
            if tail.ends_with(" ms") && tail.trim_end_matches(" ms").bytes().all(|b| b.is_ascii_digit()) {
                title = format!("{head} · N ms");
            }
        }
        if !number.is_empty() {
            title = title.replace(&number, "X.Y");
        }
        f["title"] = json!(title);
    }
    out
}

async fn test_url(s: &Server, url: &str) -> Value {
    let r = s.client().post("/database/test", json!({"url": url})).await;
    assert_eq!(r.status, 200, "{}", r.text());
    r.json()
}

const EMPTY: &str = "Database is empty · 0 tables, so a copy can go straight in";
const NOT_ENCRYPTED: (&str, &str) = (
    "No secure connection · this connection is not encrypted",
    "Fine on the same computer, not across a network: choose Require or Verify the server.",
);
const SIGNIN_DETAIL: &str =
    "The server refused the user name or the password. Check both; the password is case-sensitive.";

#[tokio::test]
async fn test_postgresql_databases() {
    let Some((pg, _)) = server_urls("test_postgresql_databases") else { return };
    if !skip_unless_available("test_postgresql_databases") {
        return;
    }
    let tmp = tempfile::tempdir().expect("tmp");
    let s = Server::start_with(options(tmp.path())).await;
    let own = own_database(&pg, "kanban_dbkit_probe").await;
    let place = "127.0.0.1:55432";
    let port = targets::from_url(&pg).expect("url").port.expect("port");
    let place = place.replace("55432", &port.to_string());

    // an empty database
    let report = test_url(&s, &own).await;
    assert_eq!(
        findings(&report),
        json!([
            finding("reach", "ok", &format!("Reached the server · {place} · N ms"), "", ""),
            finding("signin", "ok", "Signed in · as kanban", "", ""),
            finding("version", "ok", "Version · PostgreSQL X.Y (needs 14 or newer)", "", ""),
            finding("encoding", "ok", "Encoding · UTF8", "", ""),
            finding("create", "ok", "Can create tables · tried a table in a transaction and rolled it back", "", ""),
            finding("ssl", "info", NOT_ENCRYPTED.0, NOT_ENCRYPTED.1, ""),
            finding("empty", "ok", EMPTY, "", ""),
        ])
    );
    assert_eq!(
        (
            &report["ok"],
            &report["reached"],
            &report["state"],
            &report["tables"],
            &report["secure"],
            &report["other_apps"]
        ),
        (&json!(true), &json!(true), &json!("empty"), &json!(0), &json!(false), &json!(0))
    );
    assert!(report["version"].as_str().expect("version").starts_with("PostgreSQL 1"));
    assert!(report["latency_ms"].is_u64());
    assert_eq!(report["target"]["name"], "kanban_dbkit_probe");

    // nothing is left behind by the test
    let target = targets::from_url(&own).expect("url");
    let conn = targets::make_engine(&target, None).await.expect("engine");
    assert!(kb_db::schema::table_names(&conn).await.expect("tables").is_empty());

    // a database that holds something else, then a board
    conn.execute_unprepared("CREATE TABLE notes (x TEXT)").await.expect("create");
    let report = test_url(&s, &own).await;
    assert_eq!(
        findings(&report)[6],
        finding(
            "empty",
            "warn",
            "Not empty · 1 tables that are not a Kanban board",
            "The board will not write into a database that already holds something, because it cannot tell what \
             is yours. Choose another database, or empty this one in the next step.",
            ""
        )
    );
    assert_eq!((&report["ok"], &report["state"], &report["tables"]), (&json!(true), &json!("foreign"), &json!(1)));
    let _ = conn.close().await;
    wipe(&own).await;
    let mut m = Mover::new(Target::sqlite("/nonexistent/x.db"), target.clone(), None).await.expect("mover");
    m.prepare_target(false, false).await.expect("the board's tables");
    m.close().await;
    let report = test_url(&s, &own).await;
    assert_eq!(
        findings(&report)[6],
        finding(
            "empty",
            "warn",
            "Already holds a Kanban board · 77 tables, 0 tickets",
            "Use it as it is (Use this database), or empty it in the next step to copy your data in.",
            ""
        )
    );
    assert_eq!(
        (&report["ok"], &report["state"], &report["tables"], &report["tickets"]),
        (&json!(true), &json!("board"), &json!(77), &json!(0))
    );
    assert_eq!(report["revision"], include_str!("../../kb-db/schema/head.txt").trim());

    // one made by a newer app
    let conn = targets::make_engine(&target, None).await.expect("engine");
    conn.execute_unprepared("UPDATE alembic_version SET version_num = 'ffffffffffff'").await.expect("stamp");
    let report = test_url(&s, &own).await;
    assert_eq!(
        findings(&report)[6],
        finding(
            "newer",
            "error",
            "A newer database · made by a newer version of the app (migration ffffffff…)",
            "Update the app first; the board will not touch it.",
            ""
        )
    );
    assert_eq!((&report["ok"], &report["state"]), (&json!(false), &json!("newer")));

    // a user that may not create tables
    conn.execute_unprepared(
        "DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kanban_dbkit_reader') THEN \
         CREATE ROLE kanban_dbkit_reader LOGIN; END IF; END $$",
    )
    .await
    .expect("role");
    let _ = conn.close().await;
    wipe(&own).await;
    let report = test_url(&s, &own.replace("kanban@", "kanban_dbkit_reader@")).await;
    assert_eq!(
        findings(&report)[4],
        finding(
            "create",
            "error",
            "Cannot create tables · kanban_dbkit_reader has no CREATE right on the schema",
            "Run this as the owner of the database, or use a user that owns it.",
            "GRANT CREATE ON SCHEMA public TO \"kanban_dbkit_reader\";"
        )
    );
    assert_eq!(findings(&report)[1], finding("signin", "ok", "Signed in · as kanban_dbkit_reader", "", ""));
    assert_eq!(findings(&report)[6], finding("empty", "ok", EMPTY, "", ""));
    assert_eq!((&report["ok"], &report["reached"], &report["state"]), (&json!(false), &json!(true), &json!("empty")));

    // a database that is not there
    let report = test_url(&s, &with_database(&pg, "kanban_dbkit_nowhere")).await;
    assert_eq!(
        findings(&report),
        json!([
            finding("reach", "ok", &format!("Reached the server · {place}"), "", ""),
            finding(
                "database",
                "error",
                &format!("No database “kanban_dbkit_nowhere” on {place}"),
                "Create it on the server (as an administrator), then test again.",
                "CREATE DATABASE \"kanban_dbkit_nowhere\" OWNER \"kanban\" ENCODING 'UTF8';"
            ),
        ])
    );
    assert_eq!(
        (&report["ok"], &report["reached"], &report["state"]),
        (&json!(false), &json!(false), &json!("unknown"))
    );

    // a user the server does not know
    let report = test_url(&s, &own.replace("kanban@", "kanban_dbkit_nobody@")).await;
    assert_eq!(
        findings(&report),
        json!([
            finding("reach", "ok", &format!("Reached the server · {place}"), "", ""),
            finding("signin", "error", "Cannot sign in · as kanban_dbkit_nobody", SIGNIN_DETAIL, ""),
        ])
    );

    // a server that does not speak TLS, asked for it: each driver says it in its own words
    let report = test_url(&s, &own.replace("sslmode=disable", "sslmode=require")).await;
    let found = findings(&report);
    assert_eq!(found.as_array().expect("findings").len(), 1);
    assert_eq!(
        (&found[0]["key"], &found[0]["level"], &found[0]["title"]),
        (&json!("ssl"), &json!("error"), &json!("The secure connection failed"))
    );
    assert!(
        found[0]["detail"].as_str().expect("detail").ends_with(
            " · Choose “Require” to encrypt without checking the certificate, or install the \
             server’s certificate authority on this computer."
        ),
        "{found}"
    );
}

#[tokio::test]
async fn test_mysql_databases() {
    let Some((_, my)) = server_urls("test_mysql_databases") else { return };
    if !skip_unless_available("test_mysql_databases") {
        return;
    }
    let tmp = tempfile::tempdir().expect("tmp");
    let s = Server::start_with(options(tmp.path())).await;
    let own = own_database(&my, "kanban_dbkit_probe").await;
    let target = targets::from_url(&own).expect("url");
    let place = format!("{}:{}", target.host, target.port.expect("port"));

    let report = test_url(&s, &own).await;
    let label = if report["version"].as_str().expect("version").starts_with("MariaDB") { "MariaDB" } else { "MySQL" };
    let need = if label == "MariaDB" { "10.6" } else { "8.0" };
    assert_eq!(
        findings(&report),
        json!([
            finding("reach", "ok", &format!("Reached the server · {place} · N ms"), "", ""),
            finding("signin", "ok", "Signed in · as kanban", "", ""),
            finding("version", "ok", &format!("Version · {label} X.Y (needs {need} or newer)"), "", ""),
            finding("charset", "ok", "Character set · utf8mb4 (utf8mb4_bin)", "", ""),
            finding("create", "ok", "Can create tables · created a test table and dropped it again", "", ""),
            finding("ssl", "info", NOT_ENCRYPTED.0, NOT_ENCRYPTED.1, ""),
            finding("empty", "ok", EMPTY, "", ""),
        ])
    );
    assert_eq!(
        (&report["ok"], &report["reached"], &report["state"], &report["secure"], &report["other_apps"]),
        (&json!(true), &json!(true), &json!("empty"), &json!(false), &json!(0))
    );
    let conn = targets::make_engine(&target, None).await.expect("engine");
    assert!(kb_db::schema::table_names(&conn).await.expect("tables").is_empty());
    let _ = conn.close().await;

    // a board
    let mut m = Mover::new(Target::sqlite("/nonexistent/x.db"), target.clone(), None).await.expect("mover");
    m.prepare_target(false, false).await.expect("the board's tables");
    m.close().await;
    let report = test_url(&s, &own).await;
    assert_eq!(
        findings(&report)[6],
        finding(
            "empty",
            "warn",
            "Already holds a Kanban board · 77 tables, 0 tickets",
            "Use it as it is (Use this database), or empty it in the next step to copy your data in.",
            ""
        )
    );
    assert_eq!((&report["state"], &report["tables"], &report["tickets"]), (&json!("board"), &json!(77), &json!(0)));
    wipe(&own).await;

    // a wrong password, and a database this user may not use
    let refused = json!([
        finding("reach", "ok", &format!("Reached the server · {place}"), "", ""),
        finding("signin", "error", "Cannot sign in · as kanban", SIGNIN_DETAIL, ""),
    ]);
    let report = test_url(&s, &own.replace("kanban:kanban@", "kanban:wrong@")).await;
    assert_eq!(findings(&report), refused);
    assert_eq!((&report["ok"], &report["reached"]), (&json!(false), &json!(false)));
    let report = test_url(&s, &with_database(&my, "another_database")).await;
    assert_eq!(findings(&report), refused);
}

#[tokio::test]
async fn test_sqlite_files() {
    if !skip_unless_available("test_sqlite_files") {
        return;
    }
    let tmp = tempfile::tempdir().expect("tmp");
    let s = Server::start_with(options(tmp.path())).await;
    let test = |path: std::path::PathBuf| {
        let client = s.client();
        async move {
            let r = client.post("/database/test", json!({"engine": "sqlite", "path": path.to_string_lossy()})).await;
            assert_eq!(r.status, 200, "{}", r.text());
            r.json()
        }
    };

    // no file yet, in a folder that is made for it
    let new = tmp.path().join("deep").join("er").join("board.db");
    let report = test(new.clone()).await;
    assert_eq!(
        report["findings"],
        json!([
            finding("reach", "ok", &format!("A file on this computer · {}", new.display()), "", ""),
            finding("empty", "ok", "No file yet · the board will create it", "", ""),
        ])
    );
    assert_eq!(
        (&report["ok"], &report["reached"], &report["state"], &report["latency_ms"], &report["secure"]),
        (&json!(true), &json!(true), &json!("empty"), &json!(0), &json!(true))
    );
    assert_eq!(report["target"], json!({"engine": "sqlite", "path": new.to_string_lossy()}));
    assert!(report["version"].as_str().expect("version").starts_with("SQLite 3."));
    assert!(new.parent().expect("folder").is_dir() && !new.exists());

    // a file that is not a database
    let garbage = tmp.path().join("notes.txt");
    std::fs::write(&garbage, "this is not a database, it is a note that is long enough to look like one\n".repeat(40))
        .expect("write");
    let report = test(garbage.clone()).await;
    assert_eq!(
        report["findings"],
        json!([
            finding("reach", "ok", &format!("A file on this computer · {}", garbage.display()), "", ""),
            finding(
                "integrity",
                "error",
                "This file is not a SQLite database",
                "(sqlite3.DatabaseError) file is not a database\n\
                 (Background on this error at: https://sqlalche.me/e/20/4xp6)",
                ""
            ),
        ])
    );
    assert_eq!((&report["ok"], &report["reached"], &report["state"]), (&json!(false), &json!(true), &json!("unknown")));

    // the server's own board, and a file of something else
    let report = test(s.db_path()).await;
    assert_eq!(
        report["findings"][1],
        finding(
            "empty",
            "warn",
            "Already holds a Kanban board · 95 tables, 0 tickets",
            "Use it as it is (Use this database), or empty it in the next step to copy your data in.",
            ""
        )
    );
    assert_eq!((&report["state"], &report["tables"], &report["tickets"]), (&json!("board"), &json!(95), &json!(0)));
    let foreign = tmp.path().join("other.db");
    sqlite_exec(&foreign, "CREATE TABLE a (x)", &[]).await;
    sqlite_exec(&foreign, "CREATE TABLE b (y)", &[]).await;
    let report = test(foreign).await;
    assert_eq!(report["findings"][1]["title"], "Not empty · 2 tables that are not a Kanban board");
    assert_eq!((&report["ok"], &report["state"], &report["tables"]), (&json!(true), &json!("foreign"), &json!(2)));

    // a folder that cannot be made
    let blocked = tmp.path().join("notes.txt").join("sub").join("board.db");
    let report = test(blocked.clone()).await;
    assert_eq!(
        report["findings"],
        json!([finding(
            "reach",
            "error",
            &format!("Cannot create the folder {}", blocked.parent().expect("folder").display()),
            &format!("[Errno 20] Not a directory: '{}'", blocked.parent().expect("folder").display()),
            ""
        )])
    );
    assert_eq!((&report["ok"], &report["reached"]), (&json!(false), &json!(false)));
}
