//! `tests/test_runner.py`: the runner process (AI v2 stage 6). A second process starts the CLIs and reads their
//! streams; the API queues runs and sends commands through `ai_run_command`; events come back over HTTP.
//!
//! This process is the API (in `process` mode it only queues and writes commands); the runner is the real program,
//! `kanban-server --runner`, on this process's database. As in the Python file the requests are the service calls
//! their routes make (the routes of `api/ai.py` come with a later task). The first test needs the server program
//! (`cargo build -p kanban-server`, or `KANBAN_SERVER_BIN`) and says so when it is not there.

// Unix only: it starts shell scripts, makes files executable or links them (Windows CI only compiles the tests).
#![cfg(unix)]

mod common;

use std::path::PathBuf;
use std::process::Stdio;
use std::time::Duration;

use common::runs_env::{Env, assign, last_run, wait};
use kb_ai::runner_link;
use kb_ai_run::{runner, runs};
use kb_db::database;
use kb_db::entities::{ai_run, ai_run_command};
use kb_db::sea_orm::ActiveValue::Set;
use kb_db::sea_orm::{ActiveModelTrait, EntityTrait, QueryOrder};
use serde_json::{Value, json};

/// The `process_mode` fixture: this process is the API of a board whose CLIs run in a runner process. Nothing here
/// starts a runner: the board's URL is never given, so `runner_link::ensure_started` has nothing to start one with
/// (the Python fixture replaces that function).
async fn process_mode() -> Env {
    let env = Env::prepare(&[("FAKE_CLAUDE_MODE", "v2")]).await;
    runner_link::reset();
    runner_link::set_mode(Some("process"));
    env
}

async fn leave(env: Env) {
    runner_link::set_command_wait(8.0);
    env.stop().await;
    runner_link::set_mode(None);
}

/// The server program: `KANBAN_SERVER_BIN`, else the one in this build's folder.
fn server_program() -> Option<PathBuf> {
    if let Some(path) = std::env::var_os("KANBAN_SERVER_BIN").filter(|v| !v.is_empty()) {
        return Some(PathBuf::from(path));
    }
    let exe = std::env::current_exe().ok()?;
    let dir = exe.parent()?;
    let profile = if dir.file_name().is_some_and(|n| n == "deps") { dir.parent()? } else { dir };
    Some(profile.join("kanban-server"))
}

/// The real runner, as `kanban-server --runner`, on the test's database.
fn runner_process(program: &PathBuf) -> std::process::Child {
    let tmp = common::tmp_path("runner");
    let log = std::fs::File::create(tmp.join("runner.log")).expect("log file");
    let mut command = std::process::Command::new(program);
    command
        .arg("--runner")
        .env("KANBAN_DB_PATH", database::get_db_path())
        // never the developer's own ~/.kanban-board (its database is real)
        .env("KANBAN_CONFIG_DIR", tmp.join("runner-config"))
        .env("KANBAN_LOG_DIR", tmp.join("runner-logs"))
        .env("KANBAN_RUNNER", "process")
        .env("KANBAN_IN_RUNNER", "1")
        // no API listens: events fail quietly, rows still land
        .env("KANBAN_BOARD_URL", "http://127.0.0.1:1")
        .env("KANBAN_INTERNAL_TOKEN", "t")
        .env("KANBAN_PARENT_PID", std::process::id().to_string())
        .env("FAKE_CLAUDE_MODE", "v2")
        // every CLI of this runner waits for one message (or 30 s) before it answers
        .env("FAKE_CLAUDE_V2_WAIT_MESSAGE", "1")
        .env("FAKE_CLAUDE_WAIT", "30")
        .env_remove("KANBAN_API_SECRET_STDIN")
        .stdin(Stdio::null())
        .stdout(Stdio::from(log.try_clone().expect("log file")))
        .stderr(Stdio::from(log));
    command.spawn().expect("the runner starts")
}

/// `proc.terminate()`, then `proc.wait(timeout=15)` or `proc.kill()`.
fn stop_runner(mut child: std::process::Child) {
    let _ = std::process::Command::new("kill").args(["-TERM", &child.id().to_string()]).status();
    let end = std::time::Instant::now() + Duration::from_secs(15);
    loop {
        match child.try_wait() {
            Ok(Some(_)) | Err(_) => return,
            Ok(None) if std::time::Instant::now() < end => std::thread::sleep(Duration::from_millis(50)),
            Ok(None) => {
                let _ = child.kill();
                let _ = child.wait();
                return;
            }
        }
    }
}

async fn commands() -> Vec<ai_run_command::Model> {
    let session = database::session();
    ai_run_command::Entity::find().order_by_asc(ai_run_command::Column::Id).all(&session).await.expect("commands")
}

#[tokio::test]
async fn test_the_runner_process_runs_what_the_api_queues_and_takes_its_commands() {
    let _guard = common::init().await;
    let Some(program) = server_program().filter(|p| p.is_file()) else {
        eprintln!("SKIPPED test_the_runner_process_runs_what_the_api_queues_and_takes_its_commands: no kanban-server");
        return;
    };
    let env = process_mode().await;
    let (pid, _) = common::project().await;
    let team = common::team_of(&pid, "Claude Code · Backend", json!({})).await;
    let team_id = team["id"].as_str().expect("id");
    let tid = common::ticket(&pid, "Fix add()", "todo").await.id;
    assert_eq!(runner_link::status()["mode"], "process");
    let child = runner_process(&program);
    let runner_pid = child.id();
    let outcome = tokio::spawn({
        let (tid, team_id) = (tid.clone(), team_id.to_string());
        async move {
            // the API only queues: the runner picks the run up and starts the fake CLI, which waits for a message
            assign(&tid, &team_id).await;
            let mut run = wait(&tid, &["running"], 40.0).await;
            for _ in 0..100 {
                // until the runner marked the CLI live (its stdin open)
                run = last_run(&tid).await.expect("the run");
                if run["live"] == true {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
            assert_eq!(run["live"], true, "{run}");
            let run_id = run["id"].as_str().expect("id").to_string();
            // a message from the API is a command the runner takes and writes into the CLI's input
            let sent = runs::send_message(&run_id, "Also bump the version.", "user", None, true).await.expect("send");
            assert_eq!(sent["delivered"], "runner");
            let done = wait(&tid, &["finished"], 40.0).await;
            assert_eq!(done["report"]["status"], "done");
            assert!(done["summary"].as_str().expect("summary").contains("bump the version"));
            assert!(done["live"] == false && done["pid"].is_null() && done["steps_count"].as_i64() >= Some(6));
            let agents = {
                let session = database::session();
                kb_ai::steps::agents(&session, &run_id).await.expect("agents")
            };
            assert_eq!(agents[0]["agent_type"], "reviewer");
            // a second run, cancelled from the API: again a command the runner takes
            let second = {
                let session = database::session();
                runs::start_on_ticket(&session, &tid, None, "user", "once more", "work").await.expect("second run")
            };
            let running = wait(&tid, &["running"], 40.0).await;
            assert_eq!(running["id"], json!(second.id));
            runs::cancel(&second.id, "user", None, None, false).await.expect("cancel");
            let ended = wait(&tid, &["cancelled"], 40.0).await;
            assert_eq!(ended["id"], json!(second.id));
            let cmds = commands().await;
            let names: Vec<&str> = cmds.iter().map(|c| c.command.as_str()).collect();
            assert_eq!(names, ["message", "cancel"]);
            assert!(cmds.iter().all(|c| c.taken_at.is_some()));
        }
    })
    .await;
    stop_runner(child);
    // the runner stopped its CLIs before it went
    common::until("the runner to be gone", 5.0, || !common::alive(runner_pid as i32)).await;
    leave(env).await;
    if let Err(failed) = outcome {
        std::panic::resume_unwind(failed.into_panic());
    }
}

#[tokio::test]
async fn test_commands_are_taken_once_and_unknown_ones_are_logged() {
    let _guard = common::init().await;
    let env = process_mode().await;
    {
        let session = database::session();
        for (run_id, command, payload) in [("run_x", "unknown", json!({})), ("run_y", "cancel", json!({"by": "t"}))] {
            let mut row = ai_run_command::new();
            row.run_id = Set(run_id.to_string());
            row.command = Set(command.to_string());
            row.payload = Set(kb_base::pyjson::dumps(&payload));
            row.insert(&session).await.expect("command");
        }
        session.commit().await.expect("commit");
    }
    assert_eq!(runner::poll_commands(true).await.expect("poll"), 2);
    assert_eq!(runner::poll_commands(true).await.expect("poll"), 0);
    assert!(commands().await.iter().all(|r| r.taken_at.is_some()));
    leave(env).await;
}

#[tokio::test]
async fn test_the_api_defers_cancel_to_the_runner_in_process_mode() {
    let _guard = common::init().await;
    let env = process_mode().await;
    runner_link::set_command_wait(0.3);
    let (pid, _) = common::project().await;
    let team = common::team_of(&pid, "Claude Code · Backend", json!({})).await;
    let tid = common::ticket(&pid, "Fix add()", "todo").await.id;
    let run = common::run(&pid, team["id"].as_str().expect("id"), Some(&tid), "running", |r| {
        r.started_by = Set("An".into());
    })
    .await;
    let out = runs::cancel(&run.id, "An", None, None, false).await.expect("cancel").expect("the run");
    // nothing ran it here: the command waits for the runner
    assert_eq!(out.state, "running");
    let cmds = commands().await;
    let cmd = cmds.first().expect("a command");
    let payload: Value = serde_json::from_str(&cmd.payload).expect("json");
    assert!(cmd.command == "cancel" && payload["by"] == "An" && cmd.taken_at.is_none());
    assert!(runs::defers_to_runner());
    let session = database::session();
    let row = ai_run::Entity::find_by_id(run.id.as_str()).one(&session).await.expect("query").expect("the run");
    assert_eq!(row.state, "running");
    drop(session);
    leave(env).await;
}
