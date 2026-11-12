//! `tests/test_ai_runs_v2.py`: a team's lead on a ticket against the stand-in CLI (mode v2): steps as rows with the
//! subagent's own rows, the final report, the comment and work log, lessons, a question and its answer, messages,
//! cancel.
//!
//! The Python tests go through the routes of `api/ai.py`, which a later task ports; here each request is the service
//! call its handler makes (`PATCH /tickets/{id}` with an assignee: `tickets.update_ticket` and
//! `runs.wake_new_assignee`; `POST /tickets/{id}/ai/run`: `runs.start_on_ticket`; `/ai/runs/{id}/answer`, `/message`,
//! `/cancel`: `runs.answer`, `runs.send_message`, `runs.cancel`), and what a route answered is read from the rows.
//! `test_hooks_record_subagents_and_plans` is in `kb-ai-api/tests/test_ai_hooks.rs` (it needs the route), and
//! `test_a_subagents_task_events_land_on_the_row_the_stream_made` in `kb-ai/tests/test_ai_runs_v2.rs`. Left for the
//! routes task: the checks of `GET /projects/{id}/ai/board` and `/ai/overview` at the end of the first test.

mod common;

use common::runs_env::{Env, assign, last_run, steps_of, wait};
use kb_ai::guard;
use kb_ai_run::runs;
use kb_db::database;
use kb_db::entities::{ai_run, ai_run_message, ticket};
use kb_db::sea_orm::ActiveValue::Set;
use kb_db::sea_orm::{ColumnTrait, EntityTrait, QueryFilter, QueryOrder};
use serde_json::{Value, json};

async fn ticket_row(ticket_id: &str) -> ticket::Model {
    let session = database::session();
    ticket::Entity::find_by_id(ticket_id).one(&session).await.expect("query").expect("the ticket")
}

fn list(text: &str) -> Vec<Value> {
    serde_json::from_str(text).expect("a JSON list")
}

#[tokio::test]
async fn test_assigning_a_ticket_to_a_team_runs_its_lead_and_records_the_report() {
    let _guard = common::init().await;
    let env = Env::start(&[("FAKE_CLAUDE_MODE", "v2")]).await;
    let (pid, _) = common::project().await;
    let team = common::team_of(&pid, "Claude Code · Backend", json!({})).await;
    let team_id = team["id"].as_str().expect("id");
    let tid = common::ticket(&pid, "Fix add()", "todo").await.id;
    assign(&tid, team_id).await;
    let run = wait(&tid, &["finished"], 30.0).await;
    assert_eq!(run["state"], "finished", "{run}");
    assert_eq!(run["report"]["status"], "done");
    assert_eq!(run["report"]["branch"], "ai/test");
    assert!(run["summary"].as_str().expect("summary").starts_with("Fixed add()"));
    assert_eq!(run["session_name"], json!(tid));
    assert!(run["steps_count"].as_i64().expect("count") >= 6);
    let run_id = run["id"].as_str().expect("id");
    let rows = steps_of(run_id).await;
    let kinds: Vec<&str> = rows.iter().map(|s| s["kind"].as_str().expect("kind")).collect();
    assert!(kinds[0] == "start" && kinds[kinds.len() - 1] == "end", "{kinds:?}");
    assert!(kinds.contains(&"command") && kinds.contains(&"subagent") && kinds.contains(&"report"), "{kinds:?}");
    let lead_cmd = rows
        .iter()
        .find(|s| s["kind"] == "command" && s["agent_id"].is_null() && s["title"] == "Ran pytest -q")
        .expect("the lead's command");
    assert_eq!(lead_cmd["has_output"], true);
    assert_eq!(lead_cmd["detail"]["tests"]["passed"], 4);
    // the board also marks a role's stretches of work with `role` steps (the run panel hides them)
    let sub: Vec<&str> = rows
        .iter()
        .filter(|s| s["agent_id"] == "v2agent" && s["kind"] != "role")
        .map(|s| s["kind"].as_str().expect("kind"))
        .collect();
    assert_eq!(sub, ["command", "text"]);
    let session = database::session();
    let agents = kb_ai::steps::agents(&session, run_id).await.expect("agents");
    assert_eq!(agents[0]["agent_type"], "reviewer");
    assert!(agents[0]["last_text"].as_str().expect("text").starts_with("Looks good"));
    let seq = i32::try_from(lead_cmd["seq"].as_i64().expect("seq")).expect("seq");
    let out = kb_ai::steps::output(&session, run_id, seq).await.expect("output").expect("the step");
    assert!(out["output"].as_str().expect("output").contains("4 passed"));
    let page = kb_ai::steps::read(&session, run_id, 0, 200, Some("v2agent"), false).await.expect("page");
    assert_eq!(page.len(), 2);
    // the report reached the ticket: a summary comment and a work log entry; the lesson was kept
    let ticket = ticket_row(&tid).await;
    let comments = list(&ticket.comments);
    let last = comments.last().expect("a comment");
    assert_eq!(last["author"], team["name"]);
    let text = last["text"].as_str().expect("text");
    assert!(text.contains("Fixed add()") && text.contains("ai/test"), "{text}");
    let log = list(&ticket.work_log);
    assert!(log.iter().any(|e| e["note"].as_str().unwrap_or("").contains("Run #1")), "{log:?}");
    let lessons = kb_ai_know::knowledge::lessons(&session, &pid, None).await.expect("lessons");
    let kept: Vec<_> = lessons.iter().filter(|x| x.text.contains("pytest -q")).collect();
    assert!(!kept.is_empty() && kept[0].state == "kept");
    drop(session);
    env.stop().await;
}

#[tokio::test]
async fn test_a_second_turn_resumes_the_conversation() {
    let _guard = common::init().await;
    let env = Env::start(&[("FAKE_CLAUDE_MODE", "v2")]).await;
    let (pid, _) = common::project().await;
    let team = common::team_of(&pid, "Claude Code · Backend", json!({})).await;
    let tid = common::ticket(&pid, "Fix add()", "todo").await.id;
    assign(&tid, team["id"].as_str().expect("id")).await;
    let first = wait(&tid, &["finished"], 30.0).await;
    let record = common::tmp_path("record").join("args.jsonl");
    env.setenv(&[("FAKE_CLAUDE_MODE", "v2"), ("FAKE_CLAUDE_RECORD", &record.to_string_lossy())]);
    let second = {
        let session = database::session();
        runs::start_on_ticket(&session, &tid, None, "user", "Also add tests for sub().", "work").await.expect("run")
    };
    assert!(json!(second.id) != first["id"] && second.number == 2);
    let done = wait(&tid, &["finished"], 30.0).await;
    assert_eq!(done["id"], json!(second.id));
    assert_eq!(done["session_id"], first["session_id"]);
    let text = std::fs::read_to_string(&record).expect("the recorded arguments");
    let args: Vec<String> = serde_json::from_str(text.lines().last().expect("a line")).expect("a list");
    let after = |flag: &str| common::flag(&args, flag);
    assert_eq!(json!(after("--resume")), first["session_id"]);
    for flag in ["--agents", "--json-schema", "--append-system-prompt-file"] {
        assert!(args.iter().any(|a| a == flag), "{flag} in {args:?}");
    }
    assert_eq!(after("--permission-mode"), "bypassPermissions");
    assert!(args.iter().any(|a| a.starts_with("--plugin-dir")));
    let agents: Value =
        serde_json::from_str(&std::fs::read_to_string(after("--agents")).expect("agents file")).expect("json");
    let mut names: Vec<&String> = agents.as_object().expect("agents").keys().collect();
    names.sort();
    assert_eq!(names, ["dev", "qa", "reviewer"]);
    let rows = steps_of(&second.id).await;
    assert!(rows[0]["title"].as_str().expect("title").starts_with("Resumed"));
    env.stop().await;
}

#[tokio::test]
async fn test_a_question_parks_the_run_and_the_answer_resumes_it() {
    let _guard = common::init().await;
    let env = Env::start(&[("FAKE_CLAUDE_MODE", "v2_ask")]).await;
    let (pid, _) = common::project().await;
    let team = common::team_of(&pid, "Claude Code · Backend", json!({})).await;
    let tid = common::ticket(&pid, "Fix add()", "todo").await.id;
    assign(&tid, team["id"].as_str().expect("id")).await;
    let run = wait(&tid, &["needs_input"], 30.0).await;
    assert!(run["question"]["text"].as_str().expect("question").starts_with("Which database"));
    let ticket = ticket_row(&tid).await;
    assert!(ticket.pending && ticket.pending_note.as_deref().unwrap_or("").contains("asks:"));
    env.setenv(&[("FAKE_CLAUDE_MODE", "v2")]);
    let run_id = run["id"].as_str().expect("id");
    runs::answer(run_id, "user", "PostgreSQL").await.expect("answer");
    let done = wait(&tid, &["finished"], 30.0).await;
    assert!(done["id"] == run["id"] && done["answer"] == "PostgreSQL");
    assert!(done["report"]["summary"].as_str().expect("summary").starts_with("Done with your answer"));
    let ticket = ticket_row(&tid).await;
    assert!(!ticket.pending);
    let comments = list(&ticket.comments);
    assert!(comments.iter().any(|cm| cm["text"].as_str().unwrap_or("").contains("**Answer:** PostgreSQL")));
    env.stop().await;
}

#[tokio::test]
async fn test_a_message_reaches_a_live_lead() {
    let _guard = common::init().await;
    let env = Env::start(&[("FAKE_CLAUDE_MODE", "v2"), ("FAKE_CLAUDE_V2_WAIT_MESSAGE", "1")]).await;
    let (pid, _) = common::project().await;
    let team = common::team_of(&pid, "Claude Code · Backend", json!({})).await;
    let tid = common::ticket(&pid, "Fix add()", "todo").await.id;
    assign(&tid, team["id"].as_str().expect("id")).await;
    let run = wait(&tid, &["running"], 20.0).await;
    let run_id = run["id"].as_str().expect("id");
    // wait until the lead listens (the fake has emitted its steps)
    for _ in 0..100 {
        if steps_of(run_id).await.iter().any(|s| s["kind"] == "subagent") {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
    let sent = runs::send_message(run_id, "Also bump the version.", "user", None, true).await.expect("send");
    assert_eq!(sent["delivered"], "live");
    let done = wait(&tid, &["finished"], 30.0).await;
    let summary = done["summary"].as_str().expect("summary");
    assert!(summary.contains("Heard: user says:") && summary.contains("bump the version"), "{summary}");
    let session = database::session();
    let msgs = ai_run_message::Entity::find()
        .filter(ai_run_message::Column::RunId.eq(run_id))
        .order_by_asc(ai_run_message::Column::At)
        .all(&session)
        .await
        .expect("messages");
    assert!(!msgs.is_empty() && msgs[0].direction == "in" && msgs[0].delivered_at.is_some());
    drop(session);
    env.stop().await;
}

#[tokio::test]
async fn test_cancel_stops_the_run_and_a_second_run_is_refused_while_one_goes() {
    let _guard = common::init().await;
    let env = Env::start(&[
        ("FAKE_CLAUDE_MODE", "v2"),
        ("FAKE_CLAUDE_V2_WAIT_MESSAGE", "1"),
        ("FAKE_CLAUDE_WAIT", "30"),
    ])
    .await;
    let (pid, _) = common::project().await;
    let team = common::team_of(&pid, "Claude Code · Backend", json!({})).await;
    let team_id = team["id"].as_str().expect("id");
    let tid = common::ticket(&pid, "Fix add()", "todo").await.id;
    assign(&tid, team_id).await;
    let run = wait(&tid, &["running"], 20.0).await;
    let run_id = run["id"].as_str().expect("id");
    // the lead hears the note instead of a second run
    let again = {
        let session = database::session();
        runs::start_on_ticket(&session, &tid, Some(team_id), "user", "", "work").await.expect("the same run")
    };
    assert_eq!(again.id, run_id);
    let pid_of_cli = runs::RT.proc(run_id).and_then(|p| p.pid()).expect("the CLI runs");
    let ended = runs::cancel(run_id, "user", None, None, false).await.expect("cancel").expect("the run");
    assert_eq!(ended.state, "cancelled");
    let rows = steps_of(run_id).await;
    let last = rows.last().expect("steps");
    assert!(last["kind"] == "end" && last["title"].as_str().expect("title").contains("Cancelled"), "{last}");
    assert!(!runs::RT.has_proc(run_id));
    common::until("the CLI to stop", 10.0, || !common::alive(pid_of_cli)).await;
    env.stop().await;
}

#[tokio::test]
async fn test_the_lead_can_ask_through_the_tool_and_message_another_ticket() {
    let _guard = common::init().await;
    let env = Env::start(&[("FAKE_CLAUDE_MODE", "v2")]).await;
    let (pid, _) = common::project().await;
    let team = common::team_of(&pid, "Claude Code · Backend", json!({})).await;
    let team_id = team["id"].as_str().expect("id");
    let tid = common::ticket(&pid, "Fix add()", "todo").await.id;
    let other = common::ticket(&pid, "The other one", "todo").await.id;
    let token = guard::new_token();
    let hash = guard::token_hash(&token);
    let run = common::run(&pid, team_id, Some(&tid), "running", |r| {
        r.started_by = Set("An Nguyen".into());
        r.token_hash = Set(Some(hash));
    })
    .await;
    let ctx = guard::context_for_token(&token).await.expect("the run's context");
    let options = [json!("Red"), json!({"label": "Blue", "recommended": true})];
    let out = runs::record_question(&ctx, "Which colour?", Some(&options)).await.expect("asked");
    assert!(out["posted"] == true && out["next"].as_str().expect("next").contains("Stop now"));
    let session = database::session();
    let stored = ai_run::Entity::find_by_id(run.id.as_str()).one(&session).await.expect("query").expect("the run");
    let question: Value = serde_json::from_str(stored.question.as_deref().expect("question")).expect("json");
    assert_eq!(question["options"], json!(["Red", "Blue"]));
    drop(session);
    let name = team["name"].as_str().expect("name");
    let delivered = runs::deliver_to_ticket(&other, "FYI the API changed.", name, "message", 0).await.expect("note");
    // the other ticket has no team yet: the note is a comment
    assert_eq!(delivered["delivered"], "comment");
    let comments = list(&ticket_row(&other).await.comments);
    assert_eq!(comments.last().expect("a comment")["text"], "FYI the API changed.");
    env.stop().await;
}

#[tokio::test]
async fn test_a_team_can_be_assigned_without_starting() {
    // PATCH /tickets/{id}?start=false gives the ticket to the team; nothing runs until someone starts it.
    let _guard = common::init().await;
    let env = Env::start(&[("FAKE_CLAUDE_MODE", "v2")]).await;
    let (pid, _) = common::project().await;
    let team = common::team_of(&pid, "Claude Code · Backend", json!({})).await;
    let team_id = team["id"].as_str().expect("id");
    let tid = common::ticket(&pid, "Fix add()", "todo").await.id;
    {
        let session = database::session();
        let update = kb_board::tickets::TicketUpdate::of("assignee", json!(team_id));
        let updated = kb_board::tickets::update_ticket(&session, &tid, &update).await.expect("update").expect("ticket");
        assert_eq!(updated.assignee.as_deref(), Some(team_id));
    }
    assert!(last_run(&tid).await.is_none());
    // the person starts it later: the assigned team runs
    let run = {
        let session = database::session();
        runs::start_on_ticket(&session, &tid, None, "user", "", "work").await.expect("run")
    };
    assert_eq!(run.member_id, team_id);
    runs::cancel(&run.id, "user", None, None, false).await.expect("cancel");
    env.stop().await;
}

// ---------------------------------------------------------------------------------------------------------------
// Not in the Python file: what the fake CLI's other endings make of a run (a crash, an error result, a CLI that
// cannot be started), the queue behind a team's one slot, and what a restart of the board recovers.
// ---------------------------------------------------------------------------------------------------------------

#[tokio::test]
async fn a_cli_that_crashes_fails_the_run_and_says_what_it_printed() {
    let _guard = common::init().await;
    let env = Env::start(&[("FAKE_CLAUDE_MODE", "crash")]).await;
    let (pid, _) = common::project().await;
    let team = common::team_of(&pid, "Claude Code · Backend", json!({})).await;
    let tid = common::ticket(&pid, "Fix add()", "todo").await.id;
    assign(&tid, team["id"].as_str().expect("id")).await;
    let run = wait(&tid, &["failed"], 30.0).await;
    assert_eq!(run["exit_code"], 139);
    assert_eq!(run["ended_reason"], "Claude Code exited with code 139: Segmentation fault (core dumped)");
    assert!(run["pid"].is_null() && run["live"] == false);
    let comments = list(&ticket_row(&tid).await.comments);
    let text = comments.last().expect("a comment")["text"].as_str().expect("text").to_string();
    assert!(text.starts_with("Run #1 failed: Claude Code exited with code 139"), "{text}");
    assert!(text.contains("Partial work is kept; Retry starts a new run."));
    let rows = steps_of(run["id"].as_str().expect("id")).await;
    assert_eq!(rows.last().expect("steps")["kind"], "end");
    env.stop().await;
}

#[tokio::test]
async fn an_error_result_fails_the_run_with_what_the_cli_said() {
    let _guard = common::init().await;
    let env = Env::start(&[("FAKE_CLAUDE_MODE", "rate_limit")]).await;
    let (pid, _) = common::project().await;
    let team = common::team_of(&pid, "Claude Code · Backend", json!({})).await;
    let tid = common::ticket(&pid, "Fix add()", "todo").await.id;
    assign(&tid, team["id"].as_str().expect("id")).await;
    let run = wait(&tid, &["failed"], 30.0).await;
    assert_eq!(run["ended_reason"], "API Error: 429 rate_limit_error. Retry after 30 seconds.");
    assert!(run["stop_code"].is_null());
    env.stop().await;
}

#[tokio::test]
async fn two_tickets_of_a_team_with_one_slot_run_one_after_the_other() {
    let _guard = common::init().await;
    let env = Env::start(&[
        ("FAKE_CLAUDE_MODE", "v2"),
        ("FAKE_CLAUDE_V2_WAIT_MESSAGE", "1"),
        ("FAKE_CLAUDE_WAIT", "30"),
    ])
    .await;
    let (pid, _) = common::project().await;
    let team = common::team_of(&pid, "Claude Code · Backend", json!({"max_parallel": 1})).await;
    let team_id = team["id"].as_str().expect("id");
    let first = common::ticket(&pid, "Fix add()", "todo").await.id;
    let second = common::ticket(&pid, "Fix sub()", "todo").await.id;
    assign(&first, team_id).await;
    let running = wait(&first, &["running"], 20.0).await;
    assign(&second, team_id).await;
    let mut waiting = wait(&second, &["queued"], 10.0).await;
    for _ in 0..100 {
        if !waiting["waiting_reason"].is_null() {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        waiting = wait(&second, &["queued"], 10.0).await;
    }
    assert_eq!(waiting["waiting_reason"], "Waiting for a free slot (1 of 1 in use)");
    // the first run ends: the second starts in the next look at the queue
    env.setenv(&[("FAKE_CLAUDE_MODE", "v2")]);
    runs::cancel(running["id"].as_str().expect("id"), "user", None, None, false).await.expect("cancel");
    let done = wait(&second, &["finished"], 30.0).await;
    assert!(done["waiting_reason"].is_null());
    env.stop().await;
}

#[tokio::test]
async fn a_restart_of_the_board_puts_a_run_in_flight_back_in_the_queue_with_its_conversation() {
    let _guard = common::init().await;
    let env = Env::start(&[
        ("FAKE_CLAUDE_MODE", "v2"),
        ("FAKE_CLAUDE_V2_WAIT_MESSAGE", "1"),
        ("FAKE_CLAUDE_WAIT", "30"),
    ])
    .await;
    let (pid, _) = common::project().await;
    let team = common::team_of(&pid, "Claude Code · Backend", json!({})).await;
    let tid = common::ticket(&pid, "Fix add()", "todo").await.id;
    assign(&tid, team["id"].as_str().expect("id")).await;
    let run = wait(&tid, &["running"], 20.0).await;
    let run_id = run["id"].as_str().expect("id").to_string();
    let cli_pid = i32::try_from(run["pid"].as_i64().expect("pid")).expect("pid");
    // the board dies: its tasks are gone, the CLI (a process group of its own) and the row stay
    env.crash();
    assert!(common::alive(cli_pid));
    env.setenv(&[("FAKE_CLAUDE_MODE", "v2")]);
    runs::recover_on_startup().await.expect("recover");
    common::until("the leftover CLI to stop", 10.0, || !common::alive(cli_pid)).await;
    let session = database::session();
    let row = ai_run::Entity::find_by_id(run_id.as_str()).one(&session).await.expect("query").expect("the run");
    drop(session);
    assert!(row.state == "queued" && row.pid.is_none() && row.token_hash.is_none());
    assert!(row.instruction.ends_with("The board restarted while you were working: continue from where you were."));
    runs::start_scheduler().await.expect("scheduler");
    let done = wait(&tid, &["finished"], 30.0).await;
    assert_eq!(done["id"], json!(run_id));
    assert_eq!(done["number"], 1);
    env.stop().await;
}
