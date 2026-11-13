//! The part of `test_copy_stops_the_ai_proposes_the_board_applies_and_checks` (`tests/test_dbkit_api.py`) that the
//! Python test made by answering for the AI inside the server: a copy stops, the board's assistant is asked, and its
//! proposal is checked by the board. Here the move runs in this process (`jobs`), on a database of its own, and the
//! assistant is a stand-in registered through `hooks::AssistantHook`.

mod common;

use std::sync::{Arc, Mutex};
use std::time::Duration;

use common::sqlite_exec;
use kb_db::database;
use kb_db::sea_orm::{ActiveModelTrait, Set};
use kb_db::targets::Target;
use kb_dbkit::hooks::{self, AssistantHook, Turn};
use kb_dbkit::jobs::{self, Failure, Job};
use serde_json::{Value, json};

/// What the assistant was shown.
static SHOWN: Mutex<Vec<(String, Value)>> = Mutex::new(Vec::new());

struct Assistant;

#[async_trait::async_trait]
impl AssistantHook for Assistant {
    async fn any_cli(&self) -> Option<String> {
        Some("/usr/local/bin/claude".into())
    }

    async fn oneshot(&self, skill: &str, inputs: &Value) -> Result<Turn, String> {
        SHOWN.lock().expect("shown").push((skill.to_string(), inputs.clone()));
        if inputs["question"] == "fail" {
            return Err("Claude Code was not found on this computer. Install it, then ask again.".into());
        }
        let statements = if inputs["question"].is_null() {
            json!(["DROP TABLE ticket", "ALTER TABLE project RENAME TO x"])
        } else {
            json!(["ALTER TABLE project ADD COLUMN extra TEXT;"])
        };
        Ok(Turn {
            structured: json!({
                "cause": "The target column is too small.",
                "statements": statements,
                "affects": "project.name",
                "other_columns": [],
                "confidence": "high",
                "answer": "",
            })
            .as_object()
            .cloned(),
            elapsed_s: 1.5,
            cost: 0.25,
            ..Turn::default()
        })
    }
}

async fn wait(job: &Arc<Job>, states: &[&str]) -> Value {
    for _ in 0..600 {
        let now = job.as_dict();
        if states.contains(&now["state"].as_str().unwrap_or("")) && now["ai"]["state"] != "asking" {
            return now;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    panic!("still {}", job.as_dict()["state"]);
}

#[tokio::test]
#[allow(unsafe_code)]
async fn test_copy_stops_the_ai_proposes_the_board_applies_and_checks() {
    let dir = tempfile::tempdir().expect("tmp");
    // This test is the only one in its process; the folders are set before anything reads them.
    unsafe {
        std::env::set_var("KANBAN_CONFIG_DIR", dir.path().join("config"));
        std::env::set_var("KANBAN_DB_PATH", dir.path().join("data").join("kanban.db"));
        std::env::set_var("KANBAN_UPLOADS_DIR", dir.path().join("uploads"));
        std::env::set_var("KANBAN_AI_KEY_FILE", dir.path().join("key"));
        std::env::remove_var("KANBAN_DATABASE_URL");
    }
    database::setup().await.expect("setup");
    database::init_db().await.expect("init");
    let mut project = kb_db::entities::project::new();
    project.name = Set("Move me".into());
    project.prefix = Set("MOV".into());
    project.color = Set("#2E6F40".into());
    let session = database::session();
    project.insert(&session).await.expect("project");
    session.commit().await.expect("commit");

    // before the assistant is there, nobody can answer
    let target_path = dir.path().join("moved.db");
    let target = Target::sqlite(target_path.to_string_lossy().into_owned());
    assert_eq!(
        kb_dbkit::assist::pick_member().await.expect_err("no assistant").0,
        "No AI can answer: install Claude Code on this computer (or add an AI team in a project), then ask again."
    );
    hooks::set_assistant_hook(Box::new(Assistant));

    // the target's tables, then a column the target is too small for, as VARCHAR(255) on MySQL
    let job = jobs::new(target.clone()).await.expect("a new move");
    let checked = job.check().await.expect("check");
    assert!(checked["plan"]["rows"].as_i64().expect("rows") > 0 && checked["plan"]["tables_count"] == 77);
    job.start("empty", false).await.expect("start");
    assert_eq!(wait(&job, &["verified", "failed"]).await["state"], "verified");
    jobs::forget().await.expect("forget");
    sqlite_exec(
        &target_path,
        "CREATE TRIGGER too_small BEFORE INSERT ON project WHEN 1 \
         BEGIN SELECT RAISE(ABORT, 'Data too long for column ''name'' at row 1'); END",
        &[],
    )
    .await;
    let state_file = database::get_data_dir().join(jobs::STATE_FILE);
    std::fs::write(
        &state_file,
        json!({"state": "copying", "target": {"engine": "sqlite", "path": target.path}, "done": []}).to_string(),
    )
    .expect("state file");
    let job = jobs::current().await.expect("the interrupted move");
    assert_eq!(job.state(), "interrupted");
    job.resume(None).await.expect("resume");
    let now = wait(&job, &["stopped", "verified", "failed"]).await;
    assert_eq!(now["state"], "stopped", "{}", now["error"]);
    let stop = &now["stop"];
    assert_eq!(
        (&stop["table"], &stop["column"], &stop["value_length"]),
        (&json!("project"), &json!("name"), &json!(7))
    );

    job.ask_ai(None).await.expect("ask");
    let now = wait(&job, &["stopped"]).await;
    assert_eq!(now["ai"]["state"], "answered", "{}", now["ai"]);
    let proposal = &now["ai"]["proposal"];
    assert_eq!(proposal["member"], "Board AI");
    assert_eq!(proposal["applicable"], false);
    assert_eq!(proposal["refused"], "Only ALTER TABLE statements can be applied here: DROP TABLE ticket");
    assert_eq!(proposal["cause"], "The target column is too small.");
    assert_eq!(proposal["statements"], json!(["DROP TABLE ticket", "ALTER TABLE project RENAME TO x"]));
    assert_eq!(
        (&proposal["elapsed_s"], &proposal["cost"], &proposal["confidence"]),
        (&json!(1.5), &json!(0.25), &json!("high"))
    );
    // the AI is shown names, types, counts and the error, never a value of the row
    {
        let shown = SHOWN.lock().expect("shown");
        let (skill, inputs) = shown.last().expect("asked");
        assert_eq!(skill, "db-fix");
        assert_eq!(inputs["stop"]["table"], "project");
        assert_eq!(inputs["stop"]["value_length_chars"], 7);
        assert_eq!((&inputs["previous"], &inputs["question"]), (&Value::Null, &Value::Null));
        assert!(!inputs.to_string().contains("Move me"));
        assert_eq!(proposal["shown"], inputs["stop"]);
    }

    // a follow-up question gets the previous proposal, and an answer the board can apply
    job.ask_ai(Some("  What else?  ".into())).await.expect("ask");
    let now = wait(&job, &["stopped"]).await;
    let proposal = &now["ai"]["proposal"];
    assert_eq!((&proposal["applicable"], &proposal["refused"]), (&json!(true), &Value::Null));
    assert_eq!(proposal["statements"], json!(["ALTER TABLE project ADD COLUMN extra TEXT"]));
    assert_eq!(now["ai"]["question"], "  What else?  ");
    {
        let shown = SHOWN.lock().expect("shown");
        let (_, inputs) = shown.last().expect("asked");
        assert_eq!(inputs["question"], "What else?");
        assert_eq!(
            inputs["previous"],
            json!({"cause": "The target column is too small.",
                   "statements": ["DROP TABLE ticket", "ALTER TABLE project RENAME TO x"], "affects": "project.name"})
        );
    }
    // an assistant that cannot answer says so
    job.ask_ai(Some("fail".into())).await.expect("ask");
    let now = wait(&job, &["stopped"]).await;
    assert_eq!(
        now["ai"],
        json!({"state": "failed", "question": "fail",
               "message": "Board AI could not answer: Claude Code was not found on this computer. Install it, then ask again."})
    );

    // what the board will not run, and what it runs: the copy resumes and stops again (the stand-in limit is still
    // there)
    match job.apply(&["DROP TRIGGER too_small".into()]).await {
        Err(Failure::Assist(exc)) => {
            assert_eq!(exc.0, "Only ALTER TABLE statements can be applied here: DROP TRIGGER too_small");
        }
        other => panic!("{other:?}"),
    }
    job.apply(&["ALTER TABLE project ADD COLUMN extra TEXT;".into()]).await.expect("apply");
    let now = wait(&job, &["stopped", "verified", "failed"]).await;
    assert_eq!(now["applied"], json!(["ALTER TABLE project ADD COLUMN extra TEXT"]));
    assert_eq!((&now["state"], &now["ai"]), (&json!("stopped"), &json!({"state": "idle"})));
    // a statement the database refuses is said as it is
    match job.apply(&["ALTER TABLE project ADD COLUMN extra TEXT".into()]).await {
        Err(Failure::Job(exc)) => {
            assert_eq!((exc.code, exc.status), ("apply", 422));
            assert_eq!(exc.message, "The database refused it: duplicate column name: extra");
        }
        other => panic!("{other:?}"),
    }

    sqlite_exec(&target_path, "DROP TRIGGER too_small", &[]).await;
    job.resume(None).await.expect("resume");
    let now = wait(&job, &["verified", "verified_with_differences", "failed"]).await;
    assert_eq!(now["state"], "verified", "{}", now["verify"]);
    assert!(now["verify"]["checks"].as_array().expect("checks").iter().all(|c| c["ok"] == true));

    jobs::forget().await.expect("forget");
    assert!(jobs::current().await.is_none());
    assert!(!state_file.exists());
    assert_eq!(jobs::require().err().map(|exc| (exc.code, exc.status)), Some(("none", 404)));
}
