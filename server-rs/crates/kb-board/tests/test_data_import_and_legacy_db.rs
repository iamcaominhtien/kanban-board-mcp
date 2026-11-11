//! `tests/test_data_import_and_legacy_db.py`, and the routes of `api/data.py` (`GET /data/export`, `POST
//! /data/import`) answered the same by both servers.
//!
//! Left out, because the Rust server cannot upgrade an older database yet (`kb_db::database::init_db` refuses one; the
//! migration chain is phase P6): `test_database_stamped_with_a_removed_migration_still_upgrades` and
//! `test_database_missing_docs_ai_ignore_is_repaired_and_a_project_deletes` (both build a database at an older
//! revision and call `init_db`).

mod common;

use std::io::{Cursor, Read, Write};
use std::path::Path;

use common::{id, project};
use kb_board::api::data::{check_sqlite_file, remove_wal_files};
use serde_json::{Value, json};
use sqlx::sqlite::SqliteConnectOptions;
use sqlx::{ConnectOptions, Connection, Row};
use testkit::{Client, Server, Target, skip_unless_available, target};
use zip::write::SimpleFileOptions;

/// `_make_db`: a table `t` with `rows` rows.
async fn make_db(path: &Path, rows: usize) {
    let mut conn = SqliteConnectOptions::new()
        .filename(path)
        .create_if_missing(true)
        .journal_mode(sqlx::sqlite::SqliteJournalMode::Delete)
        .disable_statement_logging()
        .connect()
        .await
        .unwrap();
    sqlx::query("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)").execute(&mut conn).await.unwrap();
    for i in 0..rows {
        sqlx::query("INSERT INTO t (v) VALUES (?)").bind(format!("row {i}")).execute(&mut conn).await.unwrap();
    }
    conn.close().await.unwrap();
}

// ---------------------------------------------------------------------------
// tests/test_data_import_and_legacy_db.py: the helpers of the route
// ---------------------------------------------------------------------------

#[tokio::test]
async fn test_check_sqlite_file_accepts_a_healthy_database() {
    let dir = tempfile::tempdir().unwrap();
    let db_file = dir.path().join("ok.db");
    make_db(&db_file, 3).await;
    assert_eq!(check_sqlite_file(&db_file).await, None);
}

#[tokio::test]
async fn test_check_sqlite_file_rejects_garbage_and_truncated_files() {
    let dir = tempfile::tempdir().unwrap();
    let garbage = dir.path().join("garbage.db");
    std::fs::write(&garbage, b"this is not a database".repeat(500)).unwrap();
    assert_eq!(check_sqlite_file(&garbage).await.as_deref(), Some("file is not a database"));

    let good = dir.path().join("good.db");
    make_db(&good, 2000).await;
    let truncated = dir.path().join("truncated.db");
    std::fs::write(&truncated, &std::fs::read(&good).unwrap()[..5000]).unwrap();
    assert!(check_sqlite_file(&truncated).await.is_some());
    // a file that is not there is a reason too
    assert!(check_sqlite_file(&dir.path().join("missing.db")).await.is_some());
}

#[test]
fn test_remove_wal_files_only_touches_the_sidecar_files() {
    let dir = tempfile::tempdir().unwrap();
    let db_file = dir.path().join("kanban.db");
    std::fs::write(&db_file, b"x").unwrap();
    let wal = dir.path().join("kanban.db-wal");
    let shm = dir.path().join("kanban.db-shm");
    std::fs::write(&wal, b"old wal").unwrap();
    std::fs::write(&shm, b"old shm").unwrap();

    remove_wal_files(&db_file);

    assert!(db_file.exists());
    assert!(!wal.exists() && !shm.exists());
    remove_wal_files(&db_file); // nothing left: must not raise
}

// ---------------------------------------------------------------------------
// The routes
// ---------------------------------------------------------------------------

/// A ZIP of `(name, bytes)` entries, deflated like the export.
fn zip_of(entries: &[(&str, &[u8])]) -> Vec<u8> {
    let mut zip = zip::ZipWriter::new(Cursor::new(Vec::new()));
    let options = SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
    for (name, data) in entries {
        if name.ends_with('/') {
            zip.add_directory(*name, options).unwrap();
        } else {
            zip.start_file(*name, options).unwrap();
            zip.write_all(data).unwrap();
        }
    }
    zip.finish().unwrap().into_inner()
}

/// The entries of a ZIP, by name.
fn unzip(bytes: &[u8]) -> Vec<(String, Vec<u8>)> {
    let mut archive = zip::ZipArchive::new(Cursor::new(bytes)).expect("a ZIP");
    let mut out = Vec::new();
    for i in 0..archive.len() {
        let mut file = archive.by_index(i).unwrap();
        let mut data = Vec::new();
        file.read_to_end(&mut data).unwrap();
        out.push((file.name().to_string(), data));
    }
    out.sort();
    out
}

async fn import(c: &Client, filename: &str, bytes: Vec<u8>) -> testkit::Resp {
    c.upload("/data/import", "file", filename, "application/zip", bytes, &[]).await
}

async fn project_names(c: &Client) -> Vec<String> {
    let list = c.get("/projects").await.json();
    list.as_array().unwrap().iter().map(|p| p["name"].as_str().unwrap().to_string()).collect()
}

fn files_in(dir: &Path) -> Vec<String> {
    let mut found: Vec<String> = Vec::new();
    let mut todo = vec![dir.to_path_buf()];
    while let Some(d) = todo.pop() {
        let Ok(read) = std::fs::read_dir(&d) else { continue };
        for entry in read.flatten() {
            if entry.path().is_dir() {
                todo.push(entry.path());
            } else {
                found.push(entry.path().strip_prefix(dir).unwrap().to_string_lossy().into_owned());
            }
        }
    }
    found.sort();
    found
}

fn header(r: &testkit::Resp, name: &str) -> String {
    r.headers.get(name).map(|v| v.to_str().unwrap().to_string()).unwrap_or_default()
}

#[tokio::test]
async fn export_is_a_zip_of_the_database_and_the_uploads() {
    if !skip_unless_available("export_is_a_zip_of_the_database_and_the_uploads") {
        return;
    }
    let s = Server::start().await;
    let c = s.client();
    // no uploads folder yet: the ZIP holds the database alone
    let _ = std::fs::remove_dir_all(s.uploads_dir());
    project(&c, "Backed up", "BAK").await;
    let r = c.get("/data/export").await;
    assert_eq!(r.status, 200);
    assert_eq!(header(&r, "content-type"), "application/zip");
    assert_eq!(header(&r, "content-disposition"), "attachment; filename=kanban-export.zip");
    let entries = unzip(&r.body);
    assert_eq!(entries.iter().map(|(n, _)| n.as_str()).collect::<Vec<_>>(), vec!["kanban.db"]);

    std::fs::create_dir_all(s.uploads_dir().join("sub")).unwrap();
    std::fs::write(s.uploads_dir().join("a.png"), b"\x89PNG data").unwrap();
    std::fs::write(s.uploads_dir().join("sub").join("b.txt"), "bee").unwrap();
    project(&c, "Added later", "LAT").await;
    let r = c.get("/data/export").await;
    assert_eq!(r.status, 200);
    let entries = unzip(&r.body);
    let names: Vec<&str> = entries.iter().map(|(n, _)| n.as_str()).collect();
    assert_eq!(names, vec!["kanban.db", "uploads/a.png", "uploads/sub/b.txt"]);
    assert_eq!(entries[1].1, b"\x89PNG data");
    assert_eq!(entries[2].1, b"bee");

    // the database in it is whole and holds what was written a moment ago (the WAL is folded in first)
    let dir = tempfile::tempdir().unwrap();
    let copy = dir.path().join("kanban.db");
    std::fs::write(&copy, &entries[0].1).unwrap();
    assert_eq!(check_sqlite_file(&copy).await, None);
    let mut conn = SqliteConnectOptions::new().filename(&copy).connect().await.unwrap();
    let rows = sqlx::query("SELECT name FROM project ORDER BY name").fetch_all(&mut conn).await.unwrap();
    let names: Vec<String> = rows.iter().map(|row| row.get::<String, _>(0)).collect();
    assert_eq!(names, vec!["Added later", "Backed up"]);
    let version = sqlx::query("SELECT version_num FROM alembic_version").fetch_one(&mut conn).await.unwrap();
    assert!(!version.get::<String, _>(0).is_empty());
    conn.close().await.unwrap();
}

#[tokio::test]
async fn import_replaces_the_database_and_the_uploads() {
    if !skip_unless_available("import_replaces_the_database_and_the_uploads") {
        return;
    }
    let s = Server::start().await;
    let c = s.client();
    std::fs::create_dir_all(s.uploads_dir()).unwrap();
    std::fs::write(s.uploads_dir().join("keep.png"), b"png").unwrap();
    let backed_up = project(&c, "Backed up", "BAK").await;
    let backup = c.get("/data/export").await;
    assert_eq!(backup.status, 200);

    // what is there now goes away with the import
    project(&c, "Added later", "LAT").await;
    std::fs::write(s.uploads_dir().join("extra.txt"), "extra").unwrap();
    assert_eq!(project_names(&c).await.len(), 2);

    let r = import(&c, "kanban-export.zip", backup.body.to_vec()).await;
    assert_eq!((r.status, r.json()), (200, json!({"status": "ok", "imported_uploads": 1})), "{}", r.text());
    assert_eq!(project_names(&c).await, vec!["Backed up"]);
    assert_eq!(c.get(&format!("/projects/{}", id(&backed_up))).await.status, 200);
    assert_eq!(files_in(&s.uploads_dir()), vec!["keep.png"]);
    // the server goes on working on the new file, and leaves nothing of the import beside it
    let again = project(&c, "After the import", "AFT").await;
    assert_eq!(c.get(&format!("/projects/{}", id(&again))).await.status, 200);
    let beside = files_in(s.db_path().parent().unwrap());
    assert!(!beside.iter().any(|f| f.ends_with(".import") || f.ends_with(".bak")), "{beside:?}");

    // the export of the imported board loads again
    let r = import(&c, "second.zip", c.get("/data/export").await.body.to_vec()).await;
    assert_eq!(r.status, 200, "{}", r.text());
    assert_eq!(project_names(&c).await, vec!["Backed up", "After the import"]);
}

#[tokio::test]
async fn import_answers_each_refusal_the_same() {
    if !skip_unless_available("import_answers_each_refusal_the_same") {
        return;
    }
    let s = Server::start().await;
    let c = s.client();
    project(&c, "Mine", "MIN").await;
    let good_db = {
        let zipped = c.get("/data/export").await.body.to_vec();
        unzip(&zipped).into_iter().find(|(n, _)| n == "kanban.db").unwrap().1
    };
    std::fs::create_dir_all(s.uploads_dir()).unwrap();
    std::fs::write(s.uploads_dir().join("mine.png"), b"png").unwrap();

    let refused = |r: &testkit::Resp, status: u16, detail: &str| {
        assert_eq!((r.status, r.json()), (status, json!({"detail": detail})), "{}", r.text());
    };
    refused(&import(&c, "backup.tar", zip_of(&[("kanban.db", &good_db)])).await, 400, "Only .zip files are accepted");
    refused(&import(&c, "backup.ZIP", zip_of(&[("kanban.db", &good_db)])).await, 400, "Only .zip files are accepted");
    refused(&import(&c, "backup.zip", Vec::new()).await, 400, "Empty file");
    refused(&import(&c, "backup.zip", b"this is not a zip".to_vec()).await, 400, "Invalid ZIP file");
    refused(
        &import(&c, "backup.zip", zip_of(&[("uploads/a.png", b"x")])).await,
        400,
        "ZIP must contain kanban.db",
    );
    refused(
        &import(&c, "backup.zip", zip_of(&[("sub/kanban.db", &good_db)])).await,
        400,
        "ZIP must contain kanban.db",
    );
    refused(
        &import(&c, "backup.zip", zip_of(&[("kanban.db", &b"this is not a database".repeat(500))])).await,
        400,
        "kanban.db in the ZIP is not a valid database: file is not a database",
    );
    // a database cut short
    let truncated = import(&c, "backup.zip", zip_of(&[("kanban.db", &good_db[..good_db.len().min(5000)])])).await;
    assert_eq!(truncated.status, 400, "{}", truncated.text());
    assert!(truncated.detail().as_str().unwrap().starts_with("kanban.db in the ZIP is not a valid database: "));
    // no file part, or a field that is not a file
    let r = c.post("/data/import", json!({})).await;
    assert_eq!(r.status, 422);
    let r = c.upload("/data/import", "other", "backup.zip", "application/zip", zip_of(&[("kanban.db", &good_db)]), &[]).await;
    assert_eq!(r.status, 422);
    assert_eq!(r.detail()[0]["loc"], json!(["body", "file"]));
    // too many entries
    let many: Vec<(String, Vec<u8>)> = std::iter::once(("kanban.db".to_string(), good_db.clone()))
        .chain((0..50_000).map(|i| (format!("uploads/f{i}"), Vec::new())))
        .collect();
    let many: Vec<(&str, &[u8])> = many.iter().map(|(n, d)| (n.as_str(), d.as_slice())).collect();
    refused(&import(&c, "backup.zip", zip_of(&many)).await, 400, "Too many files in ZIP");

    // none of it touched the board
    assert_eq!(project_names(&c).await, vec!["Mine"]);
    assert_eq!(files_in(&s.uploads_dir()), vec!["mine.png"]);
    let beside = files_in(s.db_path().parent().unwrap());
    assert!(!beside.iter().any(|f| f.ends_with(".import") || f.ends_with(".bak")), "{beside:?}");
}

#[tokio::test]
async fn import_reads_upload_names_by_their_last_part_only() {
    if !skip_unless_available("import_reads_upload_names_by_their_last_part_only") {
        return;
    }
    let s = Server::start().await;
    let c = s.client();
    let good_db = {
        let zipped = c.get("/data/export").await.body.to_vec();
        unzip(&zipped).into_iter().find(|(n, _)| n == "kanban.db").unwrap().1
    };
    std::fs::create_dir_all(s.uploads_dir()).unwrap();
    std::fs::write(s.uploads_dir().join("old.png"), b"old").unwrap();

    // a ZIP with no uploads leaves the folder as it is
    let r = import(&c, "backup.zip", zip_of(&[("kanban.db", &good_db)])).await;
    assert_eq!((r.status, r.json()), (200, json!({"status": "ok", "imported_uploads": 0})));
    assert_eq!(files_in(&s.uploads_dir()), vec!["old.png"]);
    // one with a folder entry only does too
    let r = import(&c, "backup.zip", zip_of(&[("kanban.db", &good_db), ("uploads/", b"")])).await;
    assert_eq!((r.status, r.json()), (200, json!({"status": "ok", "imported_uploads": 0})));
    assert_eq!(files_in(&s.uploads_dir()), vec!["old.png"]);

    // folders are flattened, `..` cannot leave the folder, and a name that is no file name is skipped
    let r = import(
        &c,
        "backup.zip",
        zip_of(&[
            ("kanban.db", &good_db),
            ("uploads/x/y.txt", b"why"),
            ("uploads/../evil.txt", b"evil"),
            ("uploads/sub/..", b"dots"),
            ("uploads/", b""),
            ("uploads/dir/", b""),
            ("elsewhere/z.txt", b"zed"),
        ]),
    )
    .await;
    assert_eq!((r.status, r.json()), (200, json!({"status": "ok", "imported_uploads": 2})), "{}", r.text());
    assert_eq!(files_in(&s.uploads_dir()), vec!["evil.txt", "y.txt"]);
    assert_eq!(std::fs::read(s.uploads_dir().join("y.txt")).unwrap(), b"why");
    assert!(!s.uploads_dir().parent().unwrap().join("evil.txt").exists());
}

#[tokio::test]
async fn a_failed_import_puts_the_previous_data_back() {
    if !skip_unless_available("a_failed_import_puts_the_previous_data_back") {
        return;
    }
    let s = Server::start().await;
    let c = s.client();
    project(&c, "Mine", "MIN").await;
    std::fs::create_dir_all(s.uploads_dir()).unwrap();
    std::fs::write(s.uploads_dir().join("mine.png"), b"png").unwrap();
    // a healthy SQLite file that is not a board of this version: stamped with a migration this build does not know
    let dir = tempfile::tempdir().unwrap();
    let foreign = dir.path().join("foreign.db");
    make_db(&foreign, 1).await;
    {
        let mut conn = SqliteConnectOptions::new().filename(&foreign).connect().await.unwrap();
        sqlx::query("CREATE TABLE alembic_version (version_num VARCHAR(32) NOT NULL)").execute(&mut conn).await.unwrap();
        sqlx::query("INSERT INTO alembic_version VALUES ('ffffffffffff')").execute(&mut conn).await.unwrap();
        conn.close().await.unwrap();
    }
    let r = import(
        &c,
        "backup.zip",
        zip_of(&[("kanban.db", &std::fs::read(&foreign).unwrap()), ("uploads/new.txt", b"new")]),
    )
    .await;
    assert_eq!(r.status, 500, "{}", r.text());
    let detail = r.detail();
    let detail = detail.as_str().unwrap();
    assert!(detail.starts_with("Import failed: ") && detail.ends_with(". Previous data restored."), "{detail}");

    // the board is as it was, and answers
    assert_eq!(project_names(&c).await, vec!["Mine"]);
    project(&c, "Still works", "STI").await;
    assert_eq!(project_names(&c).await, vec!["Mine", "Still works"]);
    let beside = files_in(s.db_path().parent().unwrap());
    assert!(!beside.iter().any(|f| f.ends_with(".import") || f.ends_with(".bak")), "{beside:?}");
}

/// Not in the Python suite: the ZIP one server exports is the one the other loads. Run a ZIP made by one server into
/// the other: `KB_PEER_EXPORT_TO=/tmp/x.zip PARITY_TARGET=python ...` writes the export, then
/// `KB_PEER_IMPORT_FROM=/tmp/x.zip PARITY_TARGET=rust ...` imports it (and the other way round).
#[tokio::test]
async fn the_other_servers_export_can_be_imported() {
    let (export_to, import_from) =
        (std::env::var("KB_PEER_EXPORT_TO").ok(), std::env::var("KB_PEER_IMPORT_FROM").ok());
    if export_to.is_none() && import_from.is_none() {
        return;
    }
    if !skip_unless_available("the_other_servers_export_can_be_imported") {
        return;
    }
    let s = Server::start().await;
    let c = s.client();
    if let Some(to) = export_to {
        std::fs::create_dir_all(s.uploads_dir()).unwrap();
        std::fs::write(s.uploads_dir().join("peer.png"), b"peer png").unwrap();
        project(&c, &format!("Made by {:?}", target() == Target::Python), "PER").await;
        let r = c.get("/data/export").await;
        assert_eq!(r.status, 200);
        std::fs::write(to, &r.body).unwrap();
    }
    if let Some(from) = import_from {
        project(&c, "Replaced", "REP").await;
        let r = import(&c, "peer.zip", std::fs::read(from).unwrap()).await;
        assert_eq!((r.status, r.json()), (200, json!({"status": "ok", "imported_uploads": 1})), "{}", r.text());
        let names = project_names(&c).await;
        assert_eq!(names.len(), 1);
        assert!(names[0].starts_with("Made by "), "{names:?}");
        assert_eq!(files_in(&s.uploads_dir()), vec!["peer.png"]);
        let _ = Value::Null;
    }
}
