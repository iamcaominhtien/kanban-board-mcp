//! `tests/test_idea_space_model.py`, the tests of the one-time conversion (migration `f4a6b8c0d2e4`): old ideas are
//! given a stage, a page body, details and assumption records, and a copy of the database is made first.
//!
//! As in Python, each test builds a database at the revision before the conversion with the chain itself
//! (`alembic upgrade b3e5f7a9c1d2` is `migrations::upgrade_to`), adds the old ideas and upgrades one revision. Each
//! test has its own file and connection, so nothing here touches the database the process uses.
//!
//! `test_downgrade_writes_assumptions_back_and_upgrade_again_works` went down a revision and up again. The Rust
//! server has no downgrade, so only its upgrade half is ported: see the test.

use std::path::{Path, PathBuf};

use kb_db::sea_orm::{ConnectionTrait, DatabaseConnection, QueryResult, Statement, TransactionTrait, Value as DbValue};
use kb_db::{migrations, targets};
use serde_json::{Value, json};

const OLD_HEAD: &str = "b3e5f7a9c1d2";
const NEW_HEAD: &str = "f4a6b8c0d2e4";
const PAST: &str = "2020-01-01";
const FUTURE: &str = "2999-01-01";

async fn connect(db_file: &Path) -> DatabaseConnection {
    // the engine the app itself opens a SQLite file with (no engine enforces foreign keys)
    targets::make_engine(&targets::Target::sqlite(db_file.to_string_lossy().into_owned()), None).await.unwrap()
}

/// `_migrate(db_file, revision)`: `alembic upgrade <revision>`, in one transaction.
async fn migrate(db_file: &Path, revision: &str) {
    let conn = connect(db_file).await;
    let txn = conn.begin().await.unwrap();
    migrations::upgrade_to(&txn, revision).await.unwrap();
    txn.commit().await.unwrap();
    conn.close().await.unwrap();
}

async fn execute(conn: &DatabaseConnection, sql: &str, values: Vec<DbValue>) {
    conn.execute_raw(Statement::from_sql_and_values(conn.get_database_backend(), sql, values))
        .await
        .unwrap_or_else(|e| panic!("{sql}: {e}"));
}

/// `_rows(db_file, sql)`.
async fn rows(db_file: &Path, sql: &str) -> Vec<QueryResult> {
    let conn = connect(db_file).await;
    let found = conn.query_all_raw(Statement::from_string(conn.get_database_backend(), sql)).await.unwrap();
    conn.close().await.unwrap();
    found
}

fn text(row: &QueryResult, column: &str) -> Option<String> {
    row.try_get::<Option<String>>("", column).unwrap()
}

/// `_trail(*labels)`.
fn trail(labels: &[&str]) -> String {
    let entries: Vec<Value> = labels
        .iter()
        .enumerate()
        .map(|(i, label)| json!({"id": format!("t{i}"), "label": label, "at": "2026-01-01"}))
        .collect();
    kb_base::pyjson::dumps(&entries)
}

/// One old idea: the columns the Python test listed, in its order.
struct Idea {
    id: &'static str,
    title: &'static str,
    description: &'static str,
    status: &'static str,
    energy: Option<&'static str>,
    tags: &'static str,
    problem: Option<&'static str>,
    ice: (i32, i32, i32),
    revisit: Option<&'static str>,
    promoted_to: Option<&'static str>,
    promoted_at: Option<&'static str>,
    trail: String,
    microthoughts: String,
    assumptions: String,
}

fn idea(id: &'static str, title: &'static str, status: &'static str) -> Idea {
    Idea {
        id,
        title,
        description: "",
        status,
        energy: None,
        tags: "[]",
        problem: None,
        ice: (3, 3, 3),
        revisit: None,
        promoted_to: None,
        promoted_at: None,
        trail: trail(&["Idea created", "x"]),
        microthoughts: "[]".to_string(),
        assumptions: "[]".to_string(),
    }
}

/// `_seed_old_ideas`: the ideas of the old model, one of each kind the conversion has to place.
async fn seed_old_ideas(db_file: &Path) {
    let conn = connect(db_file).await;
    execute(
        &conn,
        "INSERT INTO project (id, name, prefix, color, ticket_counter) VALUES ('p1', 'P', 'PP', '#000', 2)",
        vec![],
    )
    .await;
    // every column the ticket table requires and does not default
    let mut required: Vec<(String, DbValue)> = Vec::new();
    for column in conn
        .query_all_raw(Statement::from_string(conn.get_database_backend(), "PRAGMA table_info(ticket)"))
        .await
        .unwrap()
    {
        let name: String = column.try_get("", "name").unwrap();
        let kind: String = column.try_get("", "type").unwrap();
        let not_null: i32 = column.try_get("", "notnull").unwrap();
        let default: Option<String> = column.try_get("", "dflt_value").unwrap();
        let pk: i32 = column.try_get("", "pk").unwrap();
        if not_null != 0 && default.is_none() && pk == 0 {
            let numeric = kind.to_uppercase().contains("INT") || kind.to_uppercase().contains("FLOAT");
            required.push((name, if numeric { 0.into() } else { "".into() }));
        }
    }
    for (ticket_id, status) in [("PP-1", "done"), ("PP-2", "in-progress"), ("PP-3", "wont_do")] {
        let mut values = required.clone();
        for (name, value) in [("id", ticket_id), ("project_id", "p1"), ("title", "t"), ("status", status)] {
            match values.iter_mut().find(|(column, _)| column == name) {
                Some(entry) => entry.1 = value.into(),
                None => values.push((name.to_string(), value.into())),
            }
        }
        let names: Vec<&str> = values.iter().map(|(name, _)| name.as_str()).collect();
        let marks = vec!["?"; values.len()].join(", ");
        let sql = format!("INSERT INTO ticket ({}) VALUES ({marks})", names.join(", "));
        execute(&conn, &sql, values.into_iter().map(|(_, value)| value).collect()).await;
    }
    execute(&conn, "INSERT INTO idea_counter (id, counter) VALUES (1, 0) ON CONFLICT DO NOTHING", vec![]).await;

    let ideas = vec![
        // untouched draft -> Inbox
        Idea { trail: trail(&["Idea created"]), ..idea("IDEA-1", "Untouched", "draft") },
        // edited draft -> Exploring; keeps assumptions, microthoughts, ICE and energy notes
        Idea {
            description: "Some text",
            energy: Some("hot"),
            tags: r#"["a"]"#,
            problem: Some("The problem"),
            ice: (5, 2, 4),
            trail: trail(&["Idea created", "Fields updated: title"]),
            microthoughts: kb_base::pyjson::dumps(&json!([{"id": "m1", "text": "thought", "at": "x"}])),
            assumptions: kb_base::pyjson::dumps(&json!([
                {"id": "a1", "text": "Users care", "status": "untested", "at": "2026-02-01"},
                {"id": "a2", "text": "It is cheap", "status": "validated", "at": "2026-02-02"},
                {"id": "a3", "text": "They pay", "status": "invalidated", "at": "2026-02-03"},
            ])),
            ..idea("IDEA-2", "Worked on", "draft")
        },
        Idea { trail: trail(&["Idea created", "Status changed"]), ..idea("IDEA-3", "In review", "in_review") },
        // approved, not promoted -> Ready
        Idea { problem: Some("P"), ..idea("IDEA-4", "Approved", "approved") },
        // promoted: ticket done -> Shipped, in progress -> Building, wont_do -> Exploring, gone -> Ready
        Idea {
            problem: Some("P"),
            promoted_to: Some("PP-1"),
            promoted_at: Some("2026-03-01"),
            ..idea("IDEA-5", "Shipped", "approved")
        },
        Idea {
            problem: Some("P"),
            promoted_to: Some("PP-2"),
            promoted_at: Some("2026-03-01"),
            ..idea("IDEA-6", "Building", "approved")
        },
        Idea {
            problem: Some("P"),
            promoted_to: Some("PP-3"),
            promoted_at: Some("2026-03-01"),
            ..idea("IDEA-7", "Dropped ticket", "approved")
        },
        Idea {
            problem: Some("P"),
            promoted_to: Some("PP-99"),
            promoted_at: Some("2026-03-01"),
            ..idea("IDEA-8", "Ticket deleted", "approved")
        },
        idea("IDEA-9", "Dropped", "dropped"),
        // revisit dates: future -> Parked until then, past -> Parked now and back in the Inbox on first open
        Idea { revisit: Some(FUTURE), ..idea("IDEA-10", "Later", "in_review") },
        Idea { revisit: Some(PAST), ..idea("IDEA-11", "Overdue", "in_review") },
    ];
    for i in ideas {
        execute(
            &conn,
            "INSERT INTO idea_ticket (id, project_id, title, description, idea_status, idea_energy, tags, \
             problem_statement, ice_impact, ice_effort, ice_confidence, revisit_date, promoted_to_ticket_id, \
             promoted_at, activity_trail, microthoughts, assumptions, idea_color, idea_emoji, created_at, updated_at) \
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            vec![
                i.id.into(),
                "p1".into(),
                i.title.into(),
                i.description.into(),
                i.status.into(),
                i.energy.map(str::to_string).into(),
                i.tags.into(),
                i.problem.map(str::to_string).into(),
                i.ice.0.into(),
                i.ice.1.into(),
                i.ice.2.into(),
                i.revisit.map(str::to_string).into(),
                i.promoted_to.map(str::to_string).into(),
                i.promoted_at.map(str::to_string).into(),
                i.trail.into(),
                i.microthoughts.into(),
                i.assumptions.into(),
                "yellow".into(),
                "💡".into(),
                "2026-01-01".into(),
                "2026-01-01".into(),
            ],
        )
        .await;
    }
    conn.close().await.unwrap();
}

/// The `converted` fixture: a database at the old head with the old ideas, upgraded by one revision.
async fn converted() -> (tempfile::TempDir, PathBuf) {
    let dir = tempfile::tempdir().unwrap();
    let db_file = dir.path().join("kanban.db");
    migrate(&db_file, OLD_HEAD).await;
    seed_old_ideas(&db_file).await;
    migrate(&db_file, NEW_HEAD).await;
    (dir, db_file)
}

fn backups(folder: &Path, start: &str) -> Vec<PathBuf> {
    std::fs::read_dir(folder)
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .filter(|path| {
            let name = path.file_name().unwrap().to_string_lossy().into_owned();
            name.starts_with(start) && name.contains(".before-idea-space-") && name.ends_with(".db")
        })
        .collect()
}

#[tokio::test]
async fn test_ideas_are_placed_in_the_stage_the_design_gives_them() {
    let (_dir, converted) = converted().await;
    let mut stages: Vec<(String, String)> = rows(&converted, "SELECT id, stage FROM idea_ticket")
        .await
        .iter()
        .map(|r| (text(r, "id").unwrap(), text(r, "stage").unwrap()))
        .collect();
    stages.sort();
    let mut expected: Vec<(String, String)> = [
        ("IDEA-1", "inbox"),
        ("IDEA-2", "exploring"),
        ("IDEA-3", "exploring"),
        ("IDEA-4", "ready"),
        ("IDEA-5", "shipped"),
        ("IDEA-6", "building"),
        ("IDEA-7", "exploring"),
        ("IDEA-8", "ready"),
        ("IDEA-9", "archived"),
        ("IDEA-10", "parked"),
        ("IDEA-11", "parked"),
    ]
    .iter()
    .map(|(id, stage)| (id.to_string(), stage.to_string()))
    .collect();
    expected.sort();
    assert_eq!(stages, expected);
}

#[tokio::test]
async fn test_archived_parked_and_unlinked_details() {
    let (_dir, converted) = converted().await;
    let all = rows(&converted, "SELECT * FROM idea_ticket").await;
    let row = |id: &str| all.iter().find(|r| text(r, "id").as_deref() == Some(id)).unwrap();
    assert_eq!(text(row("IDEA-9"), "archive_reason").as_deref(), Some("Imported from the old Idea Space"));
    assert_eq!(text(row("IDEA-10"), "park_until").as_deref(), Some(FUTURE));
    assert_eq!(text(row("IDEA-11"), "park_until").as_deref(), Some(PAST));
    assert_eq!(text(row("IDEA-1"), "park_until"), None);
    // a deleted ticket clears the link; the others keep it
    assert_eq!(text(row("IDEA-8"), "promoted_to_ticket_id"), None);
    assert_eq!(text(row("IDEA-6"), "promoted_to_ticket_id").as_deref(), Some("PP-2"));
    assert!(all.iter().all(|r| text(r, "source").as_deref() == Some("import")));
}

#[tokio::test]
async fn test_tickets_of_building_and_shipped_ideas_point_back_to_them() {
    let (_dir, converted) = converted().await;
    let mut marks: Vec<(String, Option<String>)> = rows(&converted, "SELECT id, from_idea_id FROM ticket")
        .await
        .iter()
        .map(|r| (text(r, "id").unwrap(), text(r, "from_idea_id")))
        .collect();
    marks.sort();
    assert_eq!(
        marks,
        [
            ("PP-1".to_string(), Some("IDEA-5".to_string())),
            ("PP-2".to_string(), Some("IDEA-6".to_string())),
            ("PP-3".to_string(), None)
        ]
    );
}

#[tokio::test]
async fn test_page_body_and_details_are_built_from_the_old_fields() {
    let (_dir, converted) = converted().await;
    let all = rows(&converted, "SELECT * FROM idea_ticket").await;
    let idea = all.iter().find(|r| text(r, "id").as_deref() == Some("IDEA-2")).unwrap();
    assert_eq!(text(idea, "body").as_deref(), Some("## Problem\n\nThe problem\n\nSome text"));
    assert_eq!(text(idea, "details").as_deref(), Some("Energy: hot\nICE: impact 5, effort 2, confidence 4"));
    // the old fields stay where they were
    assert_eq!(text(idea, "description").as_deref(), Some("Some text"));
    assert_eq!(text(idea, "problem_statement").as_deref(), Some("The problem"));
    let microthoughts: Value = serde_json::from_str(&text(idea, "microthoughts").unwrap()).unwrap();
    assert_eq!(microthoughts[0]["text"], "thought");
    // ... and they are comments on the idea page now
    let comments: Vec<(String, String, String)> = rows(&converted, "SELECT id, idea_id, body FROM idea_comment")
        .await
        .iter()
        .map(|c| (text(c, "id").unwrap(), text(c, "idea_id").unwrap(), text(c, "body").unwrap()))
        .collect();
    assert_eq!(comments, [("m1".to_string(), "IDEA-2".to_string(), "thought".to_string())]);
}

#[tokio::test]
async fn test_assumptions_become_records_with_medium_impact() {
    let (_dir, converted) = converted().await;
    let found =
        rows(&converted, "SELECT id, idea_id, position, text, impact, status FROM idea_assumption ORDER BY position")
            .await;
    let records: Vec<(String, String, String, String, i32)> = found
        .iter()
        .map(|r| {
            (
                text(r, "id").unwrap(),
                text(r, "text").unwrap(),
                text(r, "status").unwrap(),
                text(r, "impact").unwrap(),
                r.try_get::<i32>("", "position").unwrap(),
            )
        })
        .collect();
    let expected: Vec<(String, String, String, String, i32)> = [
        ("a1", "Users care", "untested", "medium", 0),
        ("a2", "It is cheap", "validated", "medium", 1),
        ("a3", "They pay", "disproved", "medium", 2),
    ]
    .iter()
    .map(|(a, b, c, d, e)| (a.to_string(), b.to_string(), c.to_string(), d.to_string(), *e))
    .collect();
    assert_eq!(records, expected);
    assert!(found.iter().all(|r| text(r, "idea_id").as_deref() == Some("IDEA-2")));
}

#[tokio::test]
async fn test_conversion_is_recorded_in_the_activity_and_nothing_is_lost() {
    let (_dir, converted) = converted().await;
    let all = rows(&converted, "SELECT id, activity_trail FROM idea_ticket").await;
    assert_eq!(all.len(), 11);
    for r in &all {
        let trail: Value = serde_json::from_str(&text(r, "activity_trail").unwrap()).unwrap();
        let last = trail.as_array().unwrap().last().unwrap();
        assert!(last["label"].as_str().unwrap().starts_with("Converted to the new Idea Space"));
        assert_eq!(last["author"], "system");
    }
}

#[tokio::test]
async fn test_a_backup_is_made_before_converting() {
    let (dir, _converted) = converted().await;
    let backups = backups(dir.path(), "kanban.");
    assert_eq!(backups.len(), 1);
    // the copy is the database as it was: old shape, all ideas
    let columns: Vec<String> =
        rows(&backups[0], "PRAGMA table_info(idea_ticket)").await.iter().map(|r| text(r, "name").unwrap()).collect();
    assert!(!columns.contains(&"stage".to_string()));
    let count = rows(&backups[0], "SELECT COUNT(*) AS n FROM idea_ticket").await;
    assert_eq!(count[0].try_get::<i64>("", "n").unwrap(), 11);
}

#[tokio::test]
async fn test_no_backup_when_there_are_no_ideas() {
    let dir = tempfile::tempdir().unwrap();
    let db_file = dir.path().join("kanban.db");
    migrate(&db_file, OLD_HEAD).await;
    migrate(&db_file, NEW_HEAD).await;
    assert!(backups(dir.path(), "").is_empty());
}

/// The Python test downgraded the converted database to the old head (the assumption records are written back
/// into the old JSON column, with their old status names), then upgraded it again. There is no downgrade in the
/// Rust server, so the first half is not ported. The second half is: a database in the old shape that has been
/// converted before (the backup the conversion made is exactly that database) converts again without error, and
/// the old column still holds the assumptions with their old status names.
#[tokio::test]
async fn test_downgrade_writes_assumptions_back_and_upgrade_again_works() {
    let (dir, converted) = converted().await;
    // already there: upgrading to the same revision again does nothing
    migrate(&converted, NEW_HEAD).await;
    assert_eq!(rows(&converted, "SELECT id FROM idea_assumption").await.len(), 3);

    let old_shape = backups(dir.path(), "kanban.").remove(0);
    let again = dir.path().join("again").join("kanban.db");
    std::fs::create_dir_all(again.parent().unwrap()).unwrap();
    std::fs::copy(&old_shape, &again).unwrap();
    let found = rows(&again, "SELECT assumptions FROM idea_ticket WHERE id = 'IDEA-2'").await;
    let assumptions: Value = serde_json::from_str(&text(&found[0], "assumptions").unwrap()).unwrap();
    let statuses: Vec<&str> = assumptions.as_array().unwrap().iter().map(|a| a["status"].as_str().unwrap()).collect();
    assert_eq!(statuses, ["untested", "validated", "invalidated"]);
    assert_eq!(rows(&again, "SELECT id FROM idea_ticket").await.len(), 11);
    migrate(&again, NEW_HEAD).await;
    assert_eq!(rows(&again, "SELECT id FROM idea_ticket WHERE stage IS NOT NULL").await.len(), 11);
}
