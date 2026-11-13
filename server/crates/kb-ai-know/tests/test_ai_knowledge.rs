//! Project knowledge (design/screens/ai-operations.md, H): the project's instructions and the kept lessons go into every
//! run's system prompt; an AI only proposes a lesson, a person keeps it (`tests/test_ai_knowledge.py`).
//!
//! Left for later tasks: the routes in `test_lessons_are_kept_edited_dropped_and_never_duplicated` (`PATCH` and `DELETE
//! /ai/lessons/{id}`, `POST .../ai/lessons` answering 409 and 422, `GET .../ai/knowledge`) and in
//! `test_instructions_keep_their_history` (`PUT .../ai/knowledge/instructions`): the AI routers. The service calls
//! behind them are tested here. `_system_of` and the run fixtures: the launcher (`kb-ai-run`).

mod common;

use kb_ai::config_model::estimate_tokens;
use kb_ai_know::knowledge::{self, Error, LessonOpts};
use kb_db::database;
use kb_db::entities::ai_lesson;
use kb_db::sea_orm::{EntityTrait, ModelTrait};
use serde_json::{Value, json};

#[tokio::test]
async fn test_lessons_are_kept_edited_dropped_and_never_duplicated() {
    let _guard = common::init().await;
    let (pid, _an) = common::project().await;
    let session = database::session();
    let proposal = knowledge::add_lesson(
        &session,
        &pid,
        "Use uv run alembic revision --autogenerate.",
        "model",
        LessonOpts { state: "proposed", ..Default::default() },
    )
    .await
    .expect("lesson")
    .expect("a lesson");
    assert_eq!(
        (proposal.state.as_str(), proposal.kept_by.as_deref(), proposal.proposed_by.as_deref()),
        ("proposed", None, Some("model"))
    );
    let edited = knowledge::update_lesson(
        &session,
        &proposal.id,
        "An",
        Some("Migrations: uv run alembic revision --autogenerate."),
        Some("kept"),
    )
    .await
    .expect("edited");
    assert_eq!(edited.state, "kept");
    assert!(edited.text.starts_with("Migrations:"));
    assert_eq!(edited.kept_by.as_deref(), Some("An"));
    // the same text again is no new lesson (the route answers 409)
    let dup = knowledge::add_lesson(
        &session,
        &pid,
        "Migrations: uv run alembic revision --autogenerate.",
        "An",
        LessonOpts::default(),
    )
    .await
    .expect("lesson");
    assert!(dup.is_none());
    // the route that drops a lesson deletes its row
    let row = ai_lesson::Entity::find_by_id(proposal.id.clone()).one(&session).await.expect("row").expect("a row");
    row.delete(&session).await.expect("deleted");
    session.commit().await.expect("commit");
    let page = knowledge::summary(&session, &pid).await.expect("page");
    assert_eq!(page["lessons"], json!([]));
    // an empty lesson is refused (the route answers 422)
    let empty = knowledge::add_lesson(&session, &pid, "   ", "An", LessonOpts::default()).await;
    assert!(matches!(empty, Err(Error::Value(text)) if text == "Write the lesson."));
    assert!(matches!(
        knowledge::update_lesson(&session, "nope", "An", None, None).await,
        Err(Error::Lookup(text)) if text == "Lesson not found."
    ));
    let again = knowledge::add_lesson(&session, &pid, "Keep it short.", "An", LessonOpts::default())
        .await
        .expect("lesson")
        .expect("a lesson");
    assert!(matches!(
        knowledge::update_lesson(&session, &again.id, "An", Some("  "), None).await,
        Err(Error::Value(text)) if text == "A lesson cannot be empty."
    ));
    assert!(matches!(
        knowledge::update_lesson(&session, &again.id, "An", None, Some("pinned")).await,
        Err(Error::Value(text)) if text == "A lesson is proposed, kept or dropped."
    ));
    // a dropped lesson may be written again
    knowledge::update_lesson(&session, &again.id, "An", None, Some("dropped")).await.expect("dropped");
    let back =
        knowledge::add_lesson(&session, &pid, "Keep it short.", "An", LessonOpts::default()).await.expect("lesson");
    assert!(back.is_some());
}

#[tokio::test]
async fn test_instructions_keep_their_history() {
    let _guard = common::init().await;
    let (pid, _an) = common::project().await;
    let session = database::session();
    knowledge::set_instructions(&session, &pid, "v1", "An").await.expect("v1");
    let row = knowledge::set_instructions(&session, &pid, "v2", "An").await.expect("v2");
    assert_eq!(row.instructions, "v2");
    let page = knowledge::summary(&session, &pid).await.expect("page");
    assert_eq!(page["instructions"], "v2");
    let texts: Vec<&Value> = page["history"].as_array().expect("history").iter().map(|h| &h["text"]).collect();
    assert_eq!(texts, [&json!("v1")]);
}

#[tokio::test]
async fn test_lessons_over_the_cap_stay_out_of_the_prompt() {
    let _guard = common::init().await;
    let (pid, _an) = common::project().await;
    let session = database::session();
    for i in 0..40 {
        knowledge::add_lesson(
            &session,
            &pid,
            &format!("Lesson {i}: {}", "word ".repeat(60)),
            "An",
            LessonOpts::default(),
        )
        .await
        .expect("lesson");
    }
    let block = knowledge::prompt_block(&session, &pid, false).await.expect("block");
    assert!(estimate_tokens(Some(&block)) <= knowledge::LESSON_TOKEN_CAP + 200);
}

#[test]
fn test_the_digest_keeps_commands_errors_and_words() {
    let records = vec![
        json!({"k": "event", "e": {"type": "assistant", "message": {"content": [
            {"type": "text", "text": "I will run the tests"},
            {"type": "tool_use", "name": "Bash", "input": {"command": "npm test"}},
        ]}}}),
        json!({"k": "event", "e": {"type": "user", "message": {"content": [
            {"type": "tool_result", "is_error": true, "content": "watch mode never ends"},
        ]}}}),
        json!({"k": "note", "text": "Stopped `npm run dev`"}),
    ];
    let text = knowledge::digest(&records, 12000);
    assert!(text.contains("AI: I will run the tests"));
    assert!(text.contains("tool Bash: npm test"));
    assert!(text.contains("error: watch mode never ends"));
    assert!(text.contains("[board] Stopped"));
}

/// A script that records its own pid and then never answers, as `FAKE_CLAUDE_JSON_HANG` does.
#[cfg(unix)]
#[tokio::test]
async fn test_a_light_model_that_never_answers_is_stopped() {
    let _guard = common::init().await;
    let tmp = tempfile::tempdir().expect("temp");
    let pidfile = tmp.path().join("haiku.pid");
    let script = tmp.path().join("claude");
    std::fs::write(&script, format!("#!/bin/sh\necho $$ > '{}'\nexec sleep 60\n", pidfile.display())).expect("script");
    common::make_executable(&script);
    common::use_script_cli(&script);
    knowledge::set_light_model_timeout_s(1.0);
    let (pid, _an) = common::project().await;
    let (_m, mut team) = common::team(&pid, "Claude Code · Backend", Default::default()).await;
    team.provider = "claude-code".into();
    team.cli_path = Some(script.to_string_lossy().into_owned());
    let started = std::time::Instant::now();
    assert_eq!(knowledge::ask_light_model("x", &team, None).await, None);
    assert!(started.elapsed() < std::time::Duration::from_secs(20));
    let child: u32 = std::fs::read_to_string(&pidfile).expect("the script ran").trim().parse().expect("a pid");
    // it was killed and waited for: no process, or at most a zombie
    let stat = std::fs::read_to_string(format!("/proc/{child}/stat")).ok();
    assert!(
        stat.as_deref().is_none_or(|s| s.rsplit(')').next().is_some_and(|rest| rest.trim_start().starts_with('Z'))),
        "{stat:?}"
    );
    kb_ai_know::seams::set_cli(None);
    knowledge::set_light_model_timeout_s(180.0);
}

/// With nothing filling the `cli` seam there is no CLI: no light model is asked and `describe` writes the card by code.
#[tokio::test]
async fn without_a_cli_the_light_model_is_not_asked_and_a_document_is_described_by_code() {
    let _guard = common::init().await;
    kb_ai_know::seams::set_cli(None);
    let (pid, _an) = common::project().await;
    common::team(&pid, "Claude Code · Backend", Default::default()).await;
    let info = kb_ai_know::kb::describe("# A title long enough\nSome body words words words.", &pid, "Doc")
        .await
        .expect("describe");
    assert_eq!(info.by, "code");
    assert_eq!(info.summary, "A title long enough");
    assert_eq!(info.keywords[0], "words");
}
