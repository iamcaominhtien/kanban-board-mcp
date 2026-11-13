//! `server/tests/test_ai_runs_v2.py` through the routes: a team's lead on a ticket against the stand-in CLI (mode v2):
//! steps as rows with the subagent's own rows, the final report, the comment and work log, lessons, a question and
//! its answer, messages, cancel. `crates/kb-ai-run/tests/test_ai_runs_v2.rs` ports the file at service level.
//!
//! Not repeated here: `test_hooks_record_subagents_and_plans` (`test_ai_hooks.rs`),
//! `test_the_lead_can_ask_through_the_tool_and_message_another_ticket` and
//! `test_a_subagents_task_events_land_on_the_row_the_stream_made` (they call `runs` and `steps` directly: service
//! level, in `kb-ai-run` and `kb-ai`).

// Unix only: it starts shell scripts, makes files executable or links them (Windows CI only compiles the tests).
#![cfg(unix)]

mod common;

use std::time::Duration;

use common::{id, project, runner, sign_in, start, start_ctl, ticket, wait_run};
use serde_json::{Value, json};

/// `_steps(run_id)`: every step of the run.
async fn steps_of(c: &testkit::Client, run_id: &str) -> Vec<Value> {
    c.get(&format!("/ai/runs/{run_id}/steps?limit=500")).await.json().as_array().cloned().expect("a list")
}

#[tokio::test]
async fn test_assigning_a_ticket_to_a_team_runs_its_lead_and_records_the_report() {
    let name = "test_assigning_a_ticket_to_a_team_runs_its_lead_and_records_the_report";
    let Some(f) = start(name, true, &[("FAKE_CLAUDE_MODE", "v2")]).await else { return };
    sign_in(&f);
    let c = &f.c;
    let (pid, _) = project(c).await;
    let team = runner(&f, &pid, "Claude Code · Backend", json!({})).await;
    let tid = ticket(c, &pid, "Fix add()", "todo").await;
    c.patch(&format!("/tickets/{tid}"), json!({"assignee": team["id"]})).await.assert_status(200);
    let run = wait_run(c, &tid, &["finished"]).await;
    assert_eq!(run["state"], "finished", "{run}");
    assert_eq!(run["report"]["status"], "done");
    assert_eq!(run["report"]["branch"], "ai/test");
    assert!(run["summary"].as_str().unwrap_or_default().starts_with("Fixed add()"));
    assert_eq!(run["session_name"], json!(tid));
    assert!(run["steps_count"].as_i64().unwrap_or(0) >= 6, "{run}");
    let rid = id(&run);
    // (the run's `end` step is written just after the run is marked finished: wait for it)
    let mut rows = steps_of(c, &rid).await;
    for _ in 0..100 {
        if rows.last().is_some_and(|s| s["kind"] == "end") {
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
        rows = steps_of(c, &rid).await;
    }
    let kinds: Vec<&str> = rows.iter().filter_map(|s| s["kind"].as_str()).collect();
    // (the "start" step is written while the stand-in's first lines arrive: on either server the first lines can be
    // stored before it, so that it is among the first steps and not always the very first)
    assert!(kinds.contains(&"start") && kinds[kinds.len() - 1] == "end", "{kinds:?}");
    assert!(kinds.contains(&"command") && kinds.contains(&"subagent") && kinds.contains(&"report"));
    let lead_cmd = rows
        .iter()
        .find(|s| s["kind"] == "command" && s["agent_id"].is_null() && s["title"] == "Ran pytest -q")
        .expect("the lead's command");
    assert_eq!(lead_cmd["has_output"], true);
    assert_eq!(lead_cmd["detail"]["tests"]["passed"], 4);
    let sub: Vec<&Value> = rows.iter().filter(|s| s["agent_id"] == "v2agent").collect();
    // the board also marks a role's stretches of work with `role` steps (the run panel hides them)
    let sub_kinds: Vec<&str> = sub.iter().filter_map(|s| s["kind"].as_str()).filter(|k| *k != "role").collect();
    assert_eq!(sub_kinds, ["command", "text"]);
    let detail = c.get(&format!("/ai/runs/{rid}")).await.json();
    assert!(
        detail["agents"][0]["agent_type"] == "reviewer"
            && detail["agents"][0]["last_text"].as_str().unwrap_or_default().starts_with("Looks good")
    );
    let out = c.get(&format!("/ai/runs/{rid}/steps/{}/output", lead_cmd["seq"])).await.json();
    assert!(out["output"].as_str().unwrap_or_default().contains("4 passed"));
    let page = c.get(&format!("/ai/runs/{rid}/steps?agent=v2agent")).await.json();
    // (the stand-in CLI of the Rust tests also sends the role's task events: its `role` marks come with the page, and
    // whether the stop mark is there yet when the page is read is a race, as it is for `sub` above)
    let page_work = page.as_array().expect("a page").iter().filter(|s| s["kind"] != "role").count();
    assert_eq!(page_work, 2);
    // the report reached the ticket: a summary comment and a work log entry; the lesson was kept
    let ticket_now = c.get(&format!("/tickets/{tid}")).await.json();
    let last = ticket_now["comments"].as_array().and_then(|c| c.last()).expect("a comment");
    assert!(last["author"] == team["name"]);
    let text = last["text"].as_str().unwrap_or_default();
    assert!(text.contains("Fixed add()") && text.contains("ai/test"), "{text}");
    let log = ticket_now.get("work_log").or_else(|| ticket_now.get("workLog")).cloned().unwrap_or(json!([]));
    assert!(
        log.as_array().expect("log").iter().any(|e| e["note"].as_str().unwrap_or_default().contains("Run #1")),
        "{log}"
    );
    let lessons = c.get(&format!("/projects/{pid}/ai/knowledge")).await.json();
    let kept = lessons["lessons"]
        .as_array()
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .find(|x| x["text"].as_str().unwrap_or_default().contains("pytest -q"));
    assert!(kept.is_some_and(|l| l["state"] == "kept"), "{lessons}");
    // the board chip and the overview see the run without steps
    let board = c.get(&format!("/projects/{pid}/ai/board")).await.json();
    assert!(board["tickets"][&tid]["state"] == "finished" && board["tickets"][&tid].get("steps").is_none());
    assert_eq!(c.get(&format!("/projects/{pid}/ai/overview")).await.json()["runs"], json!({"finished": 1}));
}

#[tokio::test]
async fn test_a_second_turn_resumes_the_conversation() {
    let dir = tempfile::Builder::new().prefix("kb-ai-api-record-").tempdir().expect("temporary folder");
    let record = dir.path().join("args.jsonl");
    let extra = [("FAKE_CLAUDE_MODE", "v2"), ("FAKE_CLAUDE_RECORD", record.to_str().expect("a path"))];
    let Some(f) = start("test_a_second_turn_resumes_the_conversation", true, &extra).await else { return };
    sign_in(&f);
    let c = &f.c;
    let (pid, _) = project(c).await;
    let team = runner(&f, &pid, "Claude Code · Backend", json!({})).await;
    let tid = ticket(c, &pid, "Fix add()", "todo").await;
    c.patch(&format!("/tickets/{tid}"), json!({"assignee": team["id"]})).await;
    let first = wait_run(c, &tid, &["finished"]).await;
    let first_lines = std::fs::read_to_string(&record).map(|t| t.lines().count()).unwrap_or(0);
    let r = c.post(&format!("/tickets/{tid}/ai/run"), json!({"instruction": "Also add tests for sub()."})).await;
    r.assert_status(200);
    let second = r.json();
    assert!(second["id"] != first["id"] && second["number"] == 2);
    let done = wait_run(c, &tid, &["finished"]).await;
    assert_eq!(done["id"], second["id"]);
    assert_eq!(done["session_id"], first["session_id"]);
    let text = std::fs::read_to_string(&record).expect("the record");
    assert!(text.lines().count() > first_lines);
    let args: Vec<String> = serde_json::from_str::<Value>(text.lines().last().expect("a line"))
        .expect("JSON")
        .as_array()
        .expect("args")
        .iter()
        .map(|a| a.as_str().unwrap_or_default().to_string())
        .collect();
    let at = |flag: &str| args.iter().position(|a| a == flag);
    let resume = at("--resume").expect("--resume");
    assert_eq!(Some(args[resume + 1].as_str()), first["session_id"].as_str());
    assert!(at("--agents").is_some() && at("--json-schema").is_some() && at("--append-system-prompt-file").is_some());
    assert_eq!(args[at("--permission-mode").expect("--permission-mode") + 1], "bypassPermissions");
    assert!(args.iter().any(|a| a.starts_with("--plugin-dir")));
    let agents: Value = serde_json::from_str(
        &std::fs::read_to_string(&args[at("--agents").expect("--agents") + 1]).expect("agents file"),
    )
    .expect("JSON");
    let mut keys: Vec<&String> = agents.as_object().expect("agents").keys().collect();
    keys.sort();
    assert_eq!(keys, ["dev", "qa", "reviewer"]);
    let rows = steps_of(c, &id(&second)).await;
    assert!(rows[0]["title"].as_str().unwrap_or_default().starts_with("Resumed"));
}

#[tokio::test]
async fn test_a_question_parks_the_run_and_the_answer_resumes_it() {
    let name = "test_a_question_parks_the_run_and_the_answer_resumes_it";
    let Some((f, ctl)) = start_ctl(name, &[("FAKE_CLAUDE_MODE", "v2_ask")]).await else { return };
    sign_in(&f);
    let c = &f.c;
    let (pid, _) = project(c).await;
    let team = runner(&f, &pid, "Claude Code · Backend", json!({})).await;
    let tid = ticket(c, &pid, "Fix add()", "todo").await;
    c.patch(&format!("/tickets/{tid}"), json!({"assignee": team["id"]})).await;
    let run = wait_run(c, &tid, &["needs_input"]).await;
    assert!(run["question"]["text"].as_str().unwrap_or_default().starts_with("Which database"));
    let ticket_now = c.get(&format!("/tickets/{tid}")).await.json();
    assert!(ticket_now["pending"] == true && ticket_now["pending_note"].as_str().unwrap_or_default().contains("asks:"));
    ctl.set(&[("FAKE_CLAUDE_MODE", "v2")]);
    let r = c.post(&format!("/ai/runs/{}/answer", id(&run)), json!({"text": "PostgreSQL"})).await;
    r.assert_status(200);
    let done = wait_run(c, &tid, &["finished"]).await;
    assert!(done["id"] == run["id"] && done["answer"] == "PostgreSQL");
    assert!(done["report"]["summary"].as_str().unwrap_or_default().starts_with("Done with your answer"));
    let ticket_now = c.get(&format!("/tickets/{tid}")).await.json();
    assert!(ticket_now["pending"] != true);
    assert!(
        ticket_now["comments"]
            .as_array()
            .expect("comments")
            .iter()
            .any(|cm| cm["text"].as_str().unwrap_or_default().contains("**Answer:** PostgreSQL"))
    );
}

#[tokio::test]
async fn test_a_message_reaches_a_live_lead() {
    let name = "test_a_message_reaches_a_live_lead";
    let Some(f) = start(name, true, &[("FAKE_CLAUDE_MODE", "v2"), ("FAKE_CLAUDE_V2_WAIT_MESSAGE", "1")]).await else {
        return;
    };
    sign_in(&f);
    let c = &f.c;
    let (pid, _) = project(c).await;
    let team = runner(&f, &pid, "Claude Code · Backend", json!({})).await;
    let tid = ticket(c, &pid, "Fix add()", "todo").await;
    c.patch(&format!("/tickets/{tid}"), json!({"assignee": team["id"]})).await;
    let run = wait_run(c, &tid, &["running"]).await;
    // wait until the lead listens (the fake has emitted its steps)
    for _ in 0..100 {
        if steps_of(c, &id(&run)).await.iter().any(|s| s["kind"] == "subagent") {
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    let r = c.post(&format!("/ai/runs/{}/message", id(&run)), json!({"text": "Also bump the version."})).await;
    r.assert_status(200);
    assert_eq!(r.json()["delivered"], "live");
    let done = wait_run(c, &tid, &["finished"]).await;
    let summary = done["summary"].as_str().unwrap_or_default();
    assert!(summary.contains("Heard: user says:") && summary.contains("bump the version"), "{summary}");
    let msgs = c.get(&format!("/ai/runs/{}/messages", id(&run))).await.json();
    assert!(msgs[0]["direction"] == "in" && msgs[0]["delivered_at"].is_string(), "{msgs}");
}

#[tokio::test]
async fn test_cancel_stops_the_run_and_a_second_run_is_refused_while_one_goes() {
    let name = "test_cancel_stops_the_run_and_a_second_run_is_refused_while_one_goes";
    let extra = [("FAKE_CLAUDE_MODE", "v2"), ("FAKE_CLAUDE_V2_WAIT_MESSAGE", "1"), ("FAKE_CLAUDE_WAIT", "30")];
    let Some(f) = start(name, true, &extra).await else { return };
    sign_in(&f);
    let c = &f.c;
    let (pid, _) = project(c).await;
    let team = runner(&f, &pid, "Claude Code · Backend", json!({})).await;
    let tid = ticket(c, &pid, "Fix add()", "todo").await;
    c.patch(&format!("/tickets/{tid}"), json!({"assignee": team["id"]})).await;
    let run = wait_run(c, &tid, &["running"]).await;
    let conflict = c.post(&format!("/tickets/{tid}/ai/run"), json!({"team_id": team["id"]})).await;
    // the lead hears the note instead of a second run
    assert_eq!(conflict.status, 200);
    let r = c.post_empty(&format!("/ai/runs/{}/cancel", id(&run))).await;
    r.assert_status(200);
    assert_eq!(r.json()["state"], "cancelled");
    let rows = steps_of(c, &id(&run)).await;
    let last = rows.last().expect("a step");
    assert!(last["kind"] == "end" && last["title"].as_str().unwrap_or_default().contains("Cancelled"), "{last}");
}

/// `PATCH /tickets/{id}?start=false` gives the ticket to the team; nothing runs until someone starts it.
#[tokio::test]
async fn test_a_team_can_be_assigned_without_starting() {
    let Some(f) = start("test_a_team_can_be_assigned_without_starting", true, &[("FAKE_CLAUDE_MODE", "v2")]).await
    else {
        return;
    };
    sign_in(&f);
    let c = &f.c;
    let (pid, _) = project(c).await;
    let team = runner(&f, &pid, "Claude Code · Backend", json!({})).await;
    let tid = ticket(c, &pid, "Fix add()", "todo").await;
    let r = c
        .request(
            "PATCH",
            &format!("/tickets/{tid}?start=false"),
            &[("content-type", "application/json")],
            Some(json!({"assignee": team["id"]}).to_string().into_bytes()),
        )
        .await;
    assert!(r.status == 200 && r.json()["assignee"] == team["id"], "{}", r.text());
    assert_eq!(c.get(&format!("/tickets/{tid}/ai/runs")).await.json(), json!([]));
    // the person starts it later: the assigned team runs
    let r = c.post(&format!("/tickets/{tid}/ai/run"), json!({})).await;
    r.assert_status(200);
    assert_eq!(r.json()["member_id"], team["id"]);
    c.post_empty(&format!("/ai/runs/{}/cancel", id(&r.json()))).await;
}
