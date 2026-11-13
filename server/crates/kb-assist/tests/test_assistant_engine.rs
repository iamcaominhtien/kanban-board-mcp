//! The assistant engine (AI v2 stage 7): one turn is a Claude Code session with a feature skill, an AiRun of kind
//! `assistant`, the conversation kept per name, the person's authority through a chat token
//! (`server/tests/test_assistant_engine.py`, the same tests at service level with the stand-in CLI).

// Unix only: it starts shell scripts, makes files executable or links them (Windows CI only compiles the tests).
#![cfg(unix)]

mod common;

use kb_ai::steps;
use kb_assist::assistant::engine::{self, OneshotOpts, Schema, TurnOpts};
use kb_assist::assistant::{sessions, skills};
use kb_db::database;
use kb_db::entities::{ai_run, ai_usage};
use kb_db::sea_orm::EntityTrait;
use serde_json::{Map, Value, json};

fn inputs(value: Value) -> Map<String, Value> {
    value.as_object().expect("an object").clone()
}

#[tokio::test]
async fn test_a_turn_runs_the_skill_and_records_a_run() {
    let _guard = common::init().await;
    let (pid, _team) = common::board().await;
    common::clear::<ai_usage::Entity>().await;
    let record = common::record_file();
    common::fake(&[
        ("FAKE_CLAUDE_PROMPTS", &record),
        ("FAKE_CLAUDE_ASSISTANT_JSON", &json!({"text": "Short.", "title": "API"}).to_string()),
    ]);
    let mut opts = TurnOpts::new("docs:p1", "docs-summarise", inputs(json!({"page_id": "p1"})), "An Nguyen");
    opts.feature = "docs";
    let out = engine::turn(&pid, opts).await.expect("the turn");
    assert_eq!(out.state, "finished");
    assert_eq!(Value::Object(out.data()), json!({"text": "Short.", "title": "API"}));
    assert!(out.tokens_in == 200 && out.cost == 0.02 && out.member == "Docs AI");
    let sent = common::prompts(&record).pop().expect("a recorded turn");
    let prompt = sent["prompt"].as_str().expect("prompt");
    assert!(prompt.contains("Use the skill `kanban-assistant:docs-summarise`"));
    assert!(prompt.contains("An Nguyen is asking.") && prompt.contains("page_id: p1"));
    let args = common::args_of(&sent);
    assert_eq!(common::flag(&args, "--permission-mode"), "bypassPermissions");
    let has = |name: &str| args.iter().any(|a| a == name);
    assert!(has("--json-schema") && has("--session-id") && !has("--agents"));
    assert_eq!(common::flag(&args, "--name"), "docs:p1");
    let plugin_dirs: Vec<&String> =
        args.iter().enumerate().filter(|(_, a)| *a == "--plugin-dir").map(|(i, _)| &args[i + 1]).collect();
    assert!(plugin_dirs.iter().any(|d| d.contains("assistant-skills")));
    assert!(plugin_dirs.iter().any(|d| d.contains("board-plugin")));
    let mcp: Value = serde_json::from_str(&common::flag(&args, "--mcp-config")).expect("the MCP config");
    let auth = mcp["mcpServers"]["kanban"]["headers"]["Authorization"].as_str().expect("the header");
    assert!(auth.starts_with("Bearer kbr_chat_"));
    let s = database::session();
    let run = ai_run::Entity::find_by_id(out.run_id.as_str()).one(&s).await.expect("query").expect("the run");
    let rows = steps::read(&s, &out.run_id, 0, 200, None, false).await.expect("steps");
    let usage = ai_usage::Entity::find().all(&s).await.expect("usage");
    assert!(run.kind == "assistant" && run.target.as_deref() == Some("docs:p1") && run.state == "finished");
    assert!(run.trigger == "docs-summarise" && run.tokens_in == 200);
    assert_eq!(serde_json::from_str::<Value>(&run.report).expect("report")["title"], "API");
    assert!(rows[0]["kind"] == "start" && rows[rows.len() - 1]["kind"] == "end");
    assert!(rows.iter().any(|r| r["kind"] == "board"));
    assert!(usage.len() == 1 && usage[0].feature == "docs" && usage[0].person.as_deref() == Some("An Nguyen"));
}

#[tokio::test]
async fn test_the_conversation_is_resumed_by_name() {
    let _guard = common::init().await;
    let (pid, _team) = common::board().await;
    let record = common::record_file();
    common::fake(&[("FAKE_CLAUDE_PROMPTS", &record)]);
    let name = format!("board:{pid}");
    let ask = |question: &str, fresh: bool| {
        let mut opts = TurnOpts::new(&name, "board-ask", inputs(json!({"question": question})), "An");
        opts.schema = Schema::Plain;
        opts.fresh = fresh;
        engine::turn(&pid, opts)
    };
    let first = ask("What is open?", false).await.expect("the first turn");
    assert!(first.text == "Here is the answer." && first.structured.is_none());
    let second = ask("And blocked?", false).await.expect("the second turn");
    assert_eq!(second.session_id, first.session_id);
    let args = common::args_of(&common::prompts(&record).pop().expect("a recorded turn"));
    assert_eq!(Some(common::flag(&args, "--resume")), first.session_id);
    assert!(!args.iter().any(|a| a == "--json-schema"));
    let fresh = ask("New", true).await.expect("the fresh turn");
    assert_ne!(fresh.session_id, first.session_id);
    assert_eq!(sessions::lookup(&name, None).await.expect("lookup"), fresh.session_id);
}

#[tokio::test]
async fn test_a_silent_turn_is_stopped_and_fails() {
    let _guard = common::init().await;
    let (pid, _team) = common::board().await;
    common::fake(&[("FAKE_CLAUDE_ASSISTANT_WAIT", "20")]);
    let mut opts = TurnOpts::new("idea:i1", "idea-ask", inputs(json!({"question": "?"})), "An");
    opts.timeout_s = 0.5;
    let out = engine::turn(&pid, opts).await.expect("the turn");
    assert!(out.state == "failed" && out.error.as_deref().is_some_and(|e| e.contains("said nothing")));
    let s = database::session();
    let run = ai_run::Entity::find_by_id(out.run_id.as_str()).one(&s).await.expect("query").expect("the run");
    assert_eq!(run.state, "failed");
    assert!(!engine::is_running(&out.run_id));
}

#[tokio::test]
async fn test_files_are_saved_for_the_turn_and_an_unknown_project_is_refused() {
    let _guard = common::init().await;
    let (pid, _team) = common::board().await;
    common::fake(&[]);
    let mut opts = TurnOpts::new("sketch:s1", "sketch-ask", inputs(json!({"text": "What is this?"})), "An");
    opts.files = vec![("drawing.png".to_string(), b"\x89PNG".to_vec())];
    let out = engine::turn(&pid, opts).await.expect("the turn");
    assert!(out.state == "finished" && out.files.first().is_some_and(|f| f.ends_with("drawing.png")));
    let exc = engine::turn("nope", TurnOpts::new("board:nope", "board-ask", Map::new(), "An"))
        .await
        .expect_err("an unknown project");
    assert_eq!(exc.code(), Some("not_found"));
}

#[test]
fn test_every_skill_has_a_file_and_json_skills_have_a_schema() {
    let names = skills::names();
    for wanted in ["docs-check", "docs-ask", "docs-write", "board-ask", "idea-triage", "editor-write", "sketch-ask"] {
        assert!(names.contains(&wanted), "{wanted}");
    }
    for n in names {
        let text = skills::text_of(n).expect("the skill's text");
        assert!(text.starts_with(&format!("---\nname: {n}\n")) && text.contains("description:"));
        if text.contains("Answer with JSON") {
            assert!(skills::schema_for(n).is_some(), "{n}");
        }
    }
    assert!(skills::schema_for("board-ask").is_none());
}

#[tokio::test]
async fn test_a_oneshot_answer_writes_nothing_to_the_board() {
    let _guard = common::init().await;
    let (_pid, _team) = common::board().await;
    common::clear::<ai_run::Entity>().await;
    common::clear::<ai_usage::Entity>().await;
    let record = common::record_file();
    common::fake(&[
        ("FAKE_CLAUDE_PROMPTS", &record),
        (
            "FAKE_CLAUDE_ASSISTANT_JSON",
            &json!({"cause": "Too small.", "statements": ["ALTER TABLE project ADD COLUMN x TEXT"]}).to_string(),
        ),
    ]);
    let asked = inputs(json!({"stop": {"table": "project", "column": "name"}}));
    let out = engine::oneshot("db-fix", &asked, OneshotOpts::default()).await.expect("the answer");
    assert!(out.state == "finished" && out.data()["cause"] == "Too small." && out.run_id.is_empty());
    let sent = common::prompts(&record).pop().expect("a recorded turn");
    let prompt = sent["prompt"].as_str().expect("prompt");
    assert!(prompt.contains("kanban-assistant:db-fix") && prompt.contains("\"table\": \"project\""));
    let args = common::args_of(&sent);
    let mcp: Value = serde_json::from_str(&common::flag(&args, "--mcp-config")).expect("the MCP config");
    assert!(mcp == json!({"mcpServers": {}}) && args.iter().any(|a| a == "--json-schema"));
    let s = database::session();
    assert!(ai_run::Entity::find().all(&s).await.expect("runs").is_empty());
    assert!(ai_usage::Entity::find().all(&s).await.expect("usage").is_empty());
}
