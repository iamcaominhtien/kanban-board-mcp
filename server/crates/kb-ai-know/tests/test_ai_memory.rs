//! AI memory (issue #274): a run keeps its own notes (its role's, and on its ticket), they reach the next run, and stale
//! memory is flagged for a person (`tests/test_ai_memory.py`).
//!
//! Left for later tasks, by what they wait for:
//! - `test_an_outside_agent_reads_the_memory_proposes_a_lesson_and_leaves_a_ticket_note`: the `knowledge` MCP tool
//!   (`kb-mcp`); its service calls (`propose`, `write`, `forget`, `summary`) are exercised below.
//! - the routes of `test_notes_are_capped_deduplicated_replaced_and_editable_by_a_person`
//!   (`PATCH /ai/notes/{id}`, `DELETE`, `POST /projects/{id}/ai/notes`) and of `test_stale_memory_is_flagged_for_a_person`
//!   (`POST .../ai/lessons`, `GET .../ai/knowledge`): the AI routers.
//! - `_system_of` and the run fixtures of the Python file: the launcher and the runs (`kb-ai-run`).

mod common;

use kb_ai_know::board_skills;
use kb_ai_know::knowledge::{self, LessonOpts};
use kb_ai_know::memory::{self, Error, WriteOpts};
use kb_db::database;
use kb_db::entities::{ai_lesson, ai_memory_note, notify_event};
use kb_db::sea_orm::ActiveValue::Set;
use kb_db::sea_orm::{ActiveModelTrait, ColumnTrait, EntityTrait, PaginatorTrait, QueryFilter};
use kb_skills::shared_skills;
use serde_json::Value;

#[tokio::test]
async fn test_notes_are_capped_deduplicated_replaced_and_editable_by_a_person() {
    let _guard = common::init().await;
    let (pid, _an) = common::project().await;
    let tk = common::ticket(&pid, "Fix add()", "todo").await;
    let session = database::session();
    let (first, what) =
        memory::write(&session, &pid, "ticket", &tk.id, "One", "Dev An", WriteOpts::default()).await.expect("note");
    assert_eq!(what, "added");
    let (_same, what) =
        memory::write(&session, &pid, "ticket", &tk.id, "one", "Dev An", WriteOpts::default()).await.expect("note");
    assert_eq!(what, "unchanged");
    for i in 0..memory::max_notes("ticket") - 1 {
        memory::write(&session, &pid, "ticket", &tk.id, &format!("Fact {i}"), "Dev An", WriteOpts::default())
            .await
            .expect("note");
    }
    let full = memory::write(&session, &pid, "ticket", &tk.id, "One too many", "Dev An", WriteOpts::default()).await;
    match full {
        Err(Error::Value(text)) => {
            assert!(text.contains("memory is full"), "{text}");
            assert!(text.starts_with(
                "This memory is full (15 notes). Replace one (note_id) or forget one first; the least used: "
            ));
        }
        other => panic!("{other:?}"),
    }
    let (row, what) = memory::write(
        &session,
        &pid,
        "ticket",
        &tk.id,
        "One, corrected",
        "Dev An",
        WriteOpts { note_id: Some(&first.id), ..Default::default() },
    )
    .await
    .expect("note");
    assert_eq!(what, "updated");
    assert_eq!(row.text, "One, corrected");
    // what the routes do for a person: edit a note, drop one, add feedback to a role
    let (edited, _) = memory::write(
        &session,
        &pid,
        "ticket",
        &tk.id,
        "Edited by An",
        "An",
        WriteOpts { note_id: Some(&first.id), ..Default::default() },
    )
    .await
    .expect("note");
    assert!(edited.written_by.as_deref().is_some_and(|w| !w.is_empty()));
    memory::forget(&session, &pid, &first.id).await.expect("forgotten");
    assert!(matches!(memory::forget(&session, &pid, &first.id).await, Err(Error::Lookup(_))));
    let (feedback, _) = memory::write(
        &session,
        &pid,
        "role",
        "designer",
        "Use the colour tokens.",
        "An",
        WriteOpts { kind: Some("feedback"), ..Default::default() },
    )
    .await
    .expect("note");
    assert_eq!(feedback.kind, "feedback");
    // a note of another project is not found; a bad scope and an empty note are refused
    let (other, _) = common::project().await;
    let wrong = memory::write(
        &session,
        &other,
        "ticket",
        &tk.id,
        "x",
        "An",
        WriteOpts { note_id: Some(&feedback.id), ..Default::default() },
    )
    .await;
    assert!(matches!(wrong, Err(Error::Lookup(text)) if text == "No such note in this project."));
    assert!(matches!(
        memory::write(&session, &pid, "team", "k", "x", "An", Default::default()).await,
        Err(Error::Value(_))
    ));
    assert!(matches!(
        memory::write(&session, &pid, "role", "", "x", "An", Default::default()).await,
        Err(Error::Value(_))
    ));
    assert!(matches!(
        memory::write(&session, &pid, "role", "dev", "   ", "An", Default::default()).await,
        Err(Error::Value(_))
    ));
    session.commit().await.expect("commit");
}

#[tokio::test]
async fn test_stale_memory_is_flagged_for_a_person() {
    let _guard = common::init().await;
    let (pid, _an) = common::project().await;
    let tmp = tempfile::tempdir().expect("temp");
    let repo = tmp.path().join("repo");
    std::fs::create_dir_all(repo.join("server")).expect("folder");
    std::fs::write(repo.join("server").join("models.py"), "").expect("file");
    common::team(
        &pid,
        "Claude Code · Backend",
        common::TeamOpts { working_dir: Some(repo.to_string_lossy().into_owned()), ..Default::default() },
    )
    .await;
    let session = database::session();
    let gone = knowledge::add_lesson(
        &session,
        &pid,
        "Settings live in server/old_config.py, not in server/models.py.",
        "An",
        LessonOpts::default(),
    )
    .await
    .expect("lesson")
    .expect("a lesson");
    let fine =
        knowledge::add_lesson(&session, &pid, "The models are in server/models.py.", "An", LessonOpts::default())
            .await
            .expect("lesson")
            .expect("a lesson");
    let (old, _) = memory::write(
        &session,
        &pid,
        "role",
        "dev",
        "Always run the dev server with npm run dev in the foreground.",
        "Dev An",
        WriteOpts::default(),
    )
    .await
    .expect("note");
    let (new, _) = memory::write(
        &session,
        &pid,
        "role",
        "dev",
        "Never run the dev server with npm run dev in the foreground.",
        "Dev Binh",
        WriteOpts::default(),
    )
    .await
    .expect("note");
    // make the order certain
    for (row, at) in [(&old, "2026-01-01T00:00:00"), (&new, "2026-02-01T00:00:00")] {
        let mut active = ai_memory_note::ActiveModel::from(row.clone());
        active.created_at = Set(at.to_string());
        active.update(&session).await.expect("created_at");
    }
    session.commit().await.expect("commit");
    // the knowledge page lists the flags as `[{id, kind, text, ...}]`
    let page = knowledge::summary(&session, &pid).await.expect("page");
    let mut flags: std::collections::HashMap<String, Vec<Value>> = Default::default();
    for f in page["flags"].as_array().expect("flags") {
        flags.entry(f["id"].as_str().expect("id").to_string()).or_default().push(f.clone());
    }
    assert_eq!(flags[&gone.id][0]["kind"], "missing_path");
    assert_eq!(flags[&gone.id][0]["paths"], serde_json::json!(["server/old_config.py"]));
    assert!(!flags.contains_key(&fine.id));
    assert_eq!(flags[&old.id][0]["kind"], "newer");
    assert!(flags[&old.id][0]["text"].as_str().expect("text").contains("contradict"));
    assert!(!flags.contains_key(&new.id));
    assert_eq!(page["note_caps"], serde_json::json!({"role": 30, "member": 30, "ticket": 15}));
}

#[test]
fn test_paths_in_finds_files_and_folders_not_urls() {
    assert_eq!(
        memory::paths_in("Edit `ui/src/App.tsx` and server/models.py; see https://x.io/a/b.py and docs/."),
        ["ui/src/App.tsx", "server/models.py", "docs"]
    );
}

#[test]
fn test_the_keeping_memory_skill_is_shared_by_every_role_and_served_to_outside_agents() {
    let names: Vec<&str> = shared_skills::SKILLS.iter().map(|(n, _d, _b)| n.as_str()).collect();
    assert!(names.contains(&"keeping-memory"));
    let none = serde_json::Map::new();
    assert!(board_skills::enabled_for(&none, Some("mem_x"), "qa").contains(&"keeping-memory".to_string()));
    assert!(board_skills::enabled_for(&none, Some("mem_x"), None::<&str>).contains(&"keeping-memory".to_string()));
    let text = board_skills::skill_text("keeping-memory").expect("a skill");
    let guide = shared_skills::guides().into_iter().find(|(n, _)| n == "keeping-memory").expect("a guide").1;
    assert!(text.ends_with(&guide));
    assert!(shared_skills::CORE_RULES.iter().any(|r| r.contains("knowledge(action='remember'")));
}

#[tokio::test]
async fn a_lesson_proposed_by_an_ai_waits_for_a_person_and_tells_the_owners() {
    let _guard = common::init().await;
    let (pid, _an) = common::project().await;
    let tk = common::ticket(&pid, "Fix add()", "todo").await;
    let session = database::session();
    let before = notify_event::Entity::find()
        .filter(notify_event::Column::Kind.eq("lesson"))
        .count(&session)
        .await
        .expect("count");
    let row = knowledge::propose(
        &session,
        &pid,
        "Migrations need uv run alembic revision --autogenerate.",
        "Dev An",
        "Dev An",
        Some(&tk.id),
        Some("run_1"),
        None,
    )
    .await
    .expect("proposed")
    .expect("a lesson");
    assert_eq!(
        (row.state.as_str(), row.proposed_by.as_deref(), row.kept_by.as_deref()),
        ("proposed", Some("Dev An"), None)
    );
    assert_eq!(row.source_ticket_id.as_deref(), Some(tk.id.as_str()));
    let after = notify_event::Entity::find()
        .filter(notify_event::Column::Kind.eq("lesson"))
        .count(&session)
        .await
        .expect("count");
    assert_eq!(after, before + 1);
    let event = notify_event::Entity::find()
        .filter(notify_event::Column::TargetId.eq(row.id.as_str()))
        .one(&session)
        .await
        .expect("event")
        .expect("an event");
    assert_eq!(event.title, format!("A lesson proposed by Dev An on {}", tk.id));
    assert_eq!(event.target_kind.as_deref(), Some("lesson"));
    assert_eq!(serde_json::from_str::<Value>(&event.data).expect("data"), serde_json::json!({"run_id": "run_1"}));
    // the same lesson again is not proposed twice, and nobody is told twice
    let dup = knowledge::propose(
        &session,
        &pid,
        "Migrations  need uv run alembic revision --autogenerate.",
        "Dev An",
        "Dev An",
        None,
        None,
        None,
    )
    .await
    .expect("proposed");
    assert!(dup.is_none());
    let page = knowledge::summary(&session, &pid).await.expect("page");
    assert_eq!(page["proposals"], 1);
    let rows = ai_lesson::Entity::find()
        .filter(ai_lesson::Column::ProjectId.eq(pid.as_str()))
        .count(&session)
        .await
        .expect("count");
    assert_eq!(rows, 1);
}
