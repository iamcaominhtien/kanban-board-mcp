//! `test_hooks_record_subagents_and_plans` of `tests/test_ai_runs_v2.py` (the hook route, `api/ai_hooks.py`), and the
//! two other routes of that file: what the runner posts (`POST /internal/ai/events`) and where the CLIs run
//! (`GET /ai/runner`). The run of the test is a row (the Python test adds it through its session).

// Unix only: it starts shell scripts, makes files executable or links them (Windows CI only compiles the tests).
#![cfg(unix)]

mod common;

use common::{exec, project, run, scalar, start, team, ticket};
use serde_json::{Value, json};

/// The run's token (the board keeps only its hash: `guard.token_hash`, SHA-256 in hex).
const TOKEN: &str = "kbr_test_hooks_token";

#[tokio::test]
async fn test_hooks_record_subagents_and_plans() {
    let Some(f) = start("test_hooks_record_subagents_and_plans", true, &[]).await else { return };
    let c = &f.c;
    let (pid, _) = project(c).await;
    let team_id = team(&f.server, &pid, "Claude Code · Backend", json!({})).await;
    let tid = ticket(c, &pid, "Fix add()", "todo").await;
    let run_id = run(&f.server, &pid, &team_id, &tid, "running", None).await;
    let hash = sha256_hex(TOKEN);
    exec(
        &f.server,
        "UPDATE ai_run SET token_hash = ?, started_by = 'An Nguyen' WHERE id = ?",
        &[json!(hash), json!(run_id)],
    )
    .await;
    let auth = format!("Bearer {}", TOKEN);
    let post = async |body: Value, authorization: &str| -> Value {
        let headers = [("authorization", authorization), ("content-type", "application/json")];
        let r = c.request("POST", "/ai/hooks", &headers, Some(body.to_string().into_bytes())).await;
        r.assert_status(200);
        r.json()
    };
    // a role's start and end come from the stream's task events, not from a hook: the hooks are ignored
    let r = post(json!({"hook_event_name": "SubagentStart", "agent_id": "a1", "agent_type": "qa"}), &auth).await;
    assert_eq!(r, json!({"ignored": "roles come from the stream"}));
    let r = post(
        json!({"hook_event_name": "PostToolUse", "tool_name": "TaskCreate", "tool_input": {"subject": "Write the tests"}}),
        &auth,
    )
    .await;
    assert_eq!(r, json!({"ok": true}));
    let r = post(json!({"hook_event_name": "SubagentStop", "agent_id": "a1", "agent_type": "qa"}), &auth).await;
    assert_eq!(r, json!({"ignored": "roles come from the stream"}));
    assert_eq!(post(json!({"hook_event_name": "Stop"}), "Bearer kbr_nope").await, json!({"ignored": "run ended"}));
    // the hooks made no role row
    let agents = scalar(&f.server, "SELECT count(*) FROM ai_run_agent WHERE run_id = ?", &[json!(run_id)]).await;
    assert_eq!(agents, 0);
    let plans = scalar(
        &f.server,
        "SELECT group_concat(title, '|') FROM ai_run_step WHERE run_id = ? AND kind = 'plan'",
        &[json!(run_id)],
    )
    .await;
    assert_eq!(plans, "Write the tests");

    // what the Python file answers besides (not in the Python test): the other endings of a hook
    assert_eq!(post(json!({"hook_event_name": "Stop"}), "Basic abc").await, json!({"ignored": "no token"}));
    assert_eq!(post(json!([1]), &auth).await, json!({"ignored": "not an object"}));
    assert_eq!(post(json!({"hook_event_name": "PreToolUse"}), &auth).await, json!({"ignored": "PreToolUse"}));
    assert_eq!(post(json!({}), &auth).await, json!({"ignored": "unknown"}));
    let headers = [("authorization", auth.as_str())];
    let r = c.request("POST", "/ai/hooks", &headers, Some(b"{not json".to_vec())).await;
    assert_eq!(r.json(), json!({"ignored": "not json"}));
    assert_eq!(post(json!({"hook_event_name": "Stop"}), &auth).await, json!({"ok": true}));
    let hooks = scalar(
        &f.server,
        "SELECT group_concat(title || ':' || detail, '|') FROM ai_run_step WHERE run_id = ? AND kind = 'hook'",
        &[json!(run_id)],
    )
    .await;
    assert_eq!(hooks, "The lead ended its turn:{\"hook_event_name\": \"Stop\"}");
}

#[tokio::test]
async fn an_event_is_taken_from_the_runner_only_and_the_runner_is_described() {
    let Some(f) = start("an_event_is_taken_from_the_runner_only_and_the_runner_is_described", true, &[]).await else {
        return;
    };
    let c = &f.c;
    let body = json!({"event": "invalidate"}).to_string().into_bytes();
    let r = c.request("POST", "/internal/ai/events", &[("content-type", "application/json")], Some(body.clone())).await;
    assert_eq!((r.status, r.json()), (403, json!({"detail": "Not the runner"})));
    let headers = [("content-type", "application/json"), ("x-kanban-internal", "not-the-token")];
    let r = c.request("POST", "/internal/ai/events", &headers, Some(body)).await;
    assert_eq!((r.status, r.json()), (403, json!({"detail": "Not the runner"})));
    let status = c.get("/ai/runner").await;
    status.assert_status(200);
    let status = status.json();
    let mut keys: Vec<&String> = status.as_object().expect("an object").keys().collect();
    keys.sort();
    assert_eq!(keys, ["alive", "app_version", "claude_found", "host", "local", "mode", "pid", "platform", "starts"]);
    assert_eq!(status["mode"], "inprocess");
    assert_eq!(status["alive"], false);
    assert_eq!(status["pid"], Value::Null);
    assert_eq!(status["local"], true);
    assert_eq!(status["platform"], "Linux");
    assert_eq!(status["claude_found"], true);
    let host = std::fs::read_to_string("/proc/sys/kernel/hostname").expect("hostname");
    assert_eq!(status["host"], host.trim());
}

/// SHA-256 of a text in hex, with the `sha256sum` of the system (this crate's tests have no hashing crate).
fn sha256_hex(text: &str) -> String {
    use std::io::Write;
    let mut child = std::process::Command::new("sha256sum")
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .spawn()
        .expect("sha256sum");
    child.stdin.take().expect("stdin").write_all(text.as_bytes()).expect("write");
    let out = child.wait_with_output().expect("sha256sum ends");
    String::from_utf8_lossy(&out.stdout).split_whitespace().next().expect("a hash").to_string()
}
