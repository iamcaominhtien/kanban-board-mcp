//! The migration differential on SQLite (docs/specs/rust-migration.md, "How parity is checked", point 5).
//!
//! `contract/migrations/gen_fixtures.py` built, with the Python server's Alembic chain, a database at each of the 80
//! revisions, filled it with sample rows and saved it (`fixtures/sqlite/<revision>.db.gz`), then let Alembic upgrade
//! a copy to the head and saved what it held (`expected/sqlite/<revision>.json.gz`). Here the Rust server upgrades
//! the same fixtures, through `database::setup` and `init_db` as at startup, and what the database holds afterwards
//! must be the same: every table's columns (order, declared type, NOT NULL, default, primary key), indexes (name,
//! columns, unique, partial and its WHERE), foreign keys, the FTS tables, and every row of every table.
//!
//! Besides the 80 revisions there are fixtures for an empty file, a file with only an unstamped `alembic_version`,
//! and eight databases that are not what the chain makes (`<revision>+<what>`: stamped with a removed revision, or
//! left half-made by a pre-release build).
//!
//! With `MIGRATION_EXPECT_FROM_PYTHON=1` the expected results are not read from the saved files but made again by
//! the Python server (`server/.venv/bin/python`), in its own temporary folders.

mod differential;

use std::path::Path;
use std::sync::LazyLock;

use kb_db::{database, migrations, schema};
use regex::Regex;
use serde_json::Value;

/// A v4 UUID as `str(uuid.uuid4())` writes it.
const UUID: &str = "[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
/// `datetime.now(timezone.utc).isoformat()`.
const NOW_ISO: &str = r"20\d\d-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{6})?\+00:00";

// The differences that are allowed, each with its reason. They are values a migration takes from the clock or from
// the random number generator, so the Python run and the Rust run cannot agree on them. Each is replaced by a mark
// on both sides, only in the column named, and only where the value has the shape the migration writes. Every time
// in the sample rows is in 2025, so a time from the clock (2026 or later) cannot be mistaken for one.

/// f4a6b8c0d2e4 adds one entry to each idea's `activity_trail`: `{"id": str(uuid4()), "label": "Converted to the
/// new Idea Space...", "at": now, "author": "system"}`. The id and the time are replaced; the rest of the JSON text
/// is compared byte for byte.
static CONVERTED_ENTRY: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(&format!(
        r#"\{{"id": "{UUID}", "label": "Converted to the new Idea Space([^"]*)", "at": "{NOW_ISO}", "author": "system"\}}"#
    ))
    .unwrap()
});
/// f4a6b8c0d2e4 sets `idea_ticket.stage_changed_at` to the clock when the idea's `updated_at` is empty.
static QUOTED_NOW_ISO: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^'(?:202[6-9]|20[3-9]\d)-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{6})?\+00:00'$").unwrap());
/// A row id a migration minted with `uuid.uuid4()`: f4a6b8c0d2e4 for a quick thought or an assumption that had no
/// id (`idea_comment.id`, `idea_assumption.id`), a1b2c3d4e5f7 for each Docs follower it moves (`notify_follow.id`).
static QUOTED_UUID: LazyLock<Regex> = LazyLock::new(|| Regex::new(&format!("^'{UUID}'$")).unwrap());
/// a1b2c3d4e5f7 writes `notify_prefs.updated_at` with SQLite's `datetime('now')`.
static QUOTED_SQLITE_NOW: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^'20\d\d-\d\d-\d\d \d\d:\d\d:\d\d'$").unwrap());

/// `(table, column, what is replaced)`.
fn allowed_differences() -> Vec<(&'static str, &'static str, &'static Regex, &'static str)> {
    vec![
        (
            "idea_ticket",
            "activity_trail",
            &CONVERTED_ENTRY,
            r#"{"id": "<uuid>", "label": "Converted to the new Idea Space${1}", "at": "<now>", "author": "system"}"#,
        ),
        ("idea_ticket", "stage_changed_at", &QUOTED_NOW_ISO, "'<now>'"),
        ("idea_comment", "id", &QUOTED_UUID, "'<uuid>'"),
        ("idea_assumption", "id", &QUOTED_UUID, "'<uuid>'"),
        ("notify_follow", "id", &QUOTED_UUID, "'<uuid>'"),
        ("notify_prefs", "updated_at", &QUOTED_SQLITE_NOW, "'<now>'"),
    ]
}

fn normalize(dump: &mut Value) {
    for (table, column, pattern, mark) in allowed_differences() {
        let Some(entry) = dump["data"].get_mut(table) else { continue };
        let Some(at) = entry["columns"].as_array().and_then(|c| c.iter().position(|name| name == column)) else {
            continue;
        };
        for row in entry["rows"].as_array_mut().unwrap() {
            if let Some(text) = row[at].as_str() {
                let replaced = pattern.replace_all(text, mark).into_owned();
                row[at] = Value::String(replaced);
            }
        }
    }
    differential::sort(dump);
}

/// The expected result made again by the Python server, from the fixture.
fn expected_from_python(fixture: &Path) -> Value {
    let server = differential::contract_dir().join("../../../server").canonicalize().unwrap();
    let out = std::process::Command::new(server.join(".venv/bin/python"))
        .arg(differential::contract_dir().join("gen_fixtures.py"))
        .arg("expect")
        .arg(fixture)
        .current_dir(&server)
        .output()
        .expect("the Python server's virtualenv");
    assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
    serde_json::from_slice(&out.stdout).unwrap()
}

#[test]
fn the_runner_plans_the_revisions_in_alembics_order() {
    let plans: Value =
        serde_json::from_slice(&std::fs::read(differential::contract_dir().join("plans.json")).unwrap()).unwrap();
    let plans = plans.as_object().unwrap();
    // from nothing, from each of the 80 revisions, and from the states with two branches open
    assert!(plans.len() > 100);
    for (start, order) in plans {
        let current: Vec<String> = start.split(',').filter(|s| !s.is_empty()).map(str::to_string).collect();
        let planned: Vec<&str> = migrations::plan(&current).unwrap().into_iter().map(|r| r.id).collect();
        let order: Vec<&str> = order.as_array().unwrap().iter().map(|v| v.as_str().unwrap()).collect();
        assert_eq!(planned, order, "from {start:?}");
    }
}

#[tokio::test]
#[allow(unsafe_code)]
async fn every_revision_upgrades_to_what_the_python_server_made_of_it() {
    let from_python = std::env::var("MIGRATION_EXPECT_FROM_PYTHON").is_ok_and(|v| v == "1");
    let names = differential::fixture_names("sqlite");
    // none dropped: a fixture for each of the 80 revisions
    for revision in differential::revisions() {
        assert!(names.iter().any(|n| n == revision), "no fixture for {revision}");
    }
    assert_eq!(differential::revisions().len(), 80);

    let dir = tempfile::tempdir().unwrap();
    let mut failures: Vec<String> = Vec::new();
    let mut started = false;
    for name in &names {
        let folder = dir.path().join(name);
        std::fs::create_dir_all(&folder).unwrap();
        let file = folder.join("kanban.db");
        let packed = differential::contract_dir().join("fixtures/sqlite").join(format!("{name}.db.gz"));
        std::fs::write(&file, differential::read_gz(&packed)).unwrap();

        let upgraded = if started {
            database::reinit_db(Some(file.clone())).await
        } else {
            // The database in use is one per process: the first fixture is opened as at startup, the others by
            // re-pointing the process at their file. The folders are set before anything reads them.
            unsafe {
                std::env::set_var("KANBAN_CONFIG_DIR", dir.path().join("config"));
                std::env::set_var("KANBAN_DB_PATH", &file);
                std::env::remove_var("KANBAN_DATABASE_URL");
            }
            started = true;
            database::setup().await.unwrap();
            database::init_db().await
        };
        if let Err(err) = upgraded {
            failures.push(format!("{name}: the upgrade failed: {err}"));
            continue;
        }
        assert_eq!(database::get_db_path(), file);
        let conn = database::conn();
        assert_eq!(schema::current_revisions(&conn).await.unwrap(), [schema::head_revision()], "{name}");
        let mut actual = differential::dump(&conn, "sqlite").await;
        let mut expected =
            if from_python { expected_from_python(&packed) } else { differential::expected("sqlite", name) };
        normalize(&mut actual);
        normalize(&mut expected);
        let differences = differential::differences(&expected, &actual);
        if !differences.is_empty() {
            failures.push(format!("{name}:\n    {}", differences.join("\n    ")));
        }
        // a second start changes nothing
        database::init_db().await.unwrap();
    }
    let shown: Vec<&str> = failures.iter().take(6).map(String::as_str).collect();
    assert!(
        failures.is_empty(),
        "{} of {} fixtures differ; the first:\n{}",
        failures.len(),
        names.len(),
        shown.join("\n")
    );
    println!("{} SQLite fixtures upgraded to the same database as under Python", names.len());
}
