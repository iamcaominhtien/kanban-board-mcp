//! The two tests of `server/tests/test_ai_audit_ops_v2.py` that go through HTTP routes (the audit trail
//! (`services/ai/audit.py`) and the project's settings column (`services/ai/ops.py`), written by the routes). The
//! rest of the file calls `record` and `ops` directly and is in `crates/kb-ai/tests/test_ai_audit_ops_v2.rs`.

mod common;

use common::{project, runner, scalar, sign_in, start, ticket, wait_run};
use serde_json::{Value, json};

/// `_entries(project_id)`: the audit rows of the project in order.
async fn entries(f: &common::Fixture, project_id: &str) -> Vec<Value> {
    let text = scalar(
        &f.server,
        "SELECT json_group_array(json_object('seq', seq, 'action', action, 'member_id', member_id, \
         'member_name', member_name, 'run_id', run_id, 'target', target)) \
         FROM (SELECT * FROM ai_audit WHERE project_id = ? ORDER BY seq)",
        &[json!(project_id)],
    )
    .await;
    text.as_array().cloned().expect("a JSON list")
}

#[tokio::test]
async fn test_creating_a_team_and_running_it_leave_audit_entries() {
    let Some(f) = start("test_creating_a_team_and_running_it_leave_audit_entries", true, &[]).await else { return };
    sign_in(&f);
    let c = &f.c;
    let (pid, _) = project(c).await;
    let team = runner(&f, &pid, "Claude Code · Backend", json!({})).await;
    let tid = ticket(c, &pid, "Fix add()", "todo").await;
    let r = c.post(&format!("/tickets/{tid}/ai/run"), json!({})).await;
    assert!(r.status == 200 || r.status == 201, "{}", r.text());
    wait_run(c, &tid, &["finished", "failed"]).await;
    let rows = entries(&f, &pid).await;
    let actions: Vec<&str> = rows.iter().filter_map(|r| r["action"].as_str()).collect();
    assert_eq!(actions[0], "team_created");
    assert!(rows[0]["member_id"] == team["id"] && rows[0]["member_name"] == team["name"]);
    assert!(actions.contains(&"run_queued"));
    let ended: Vec<&Value> =
        rows.iter().filter(|r| matches!(r["action"].as_str(), Some("run_finished" | "run_failed"))).collect();
    let last = ended.last().expect("an ended run");
    assert!(last["run_id"].as_str().is_some_and(|r| !r.is_empty()) && last["target"] == json!(tid));
    let seqs: Vec<i64> = rows.iter().filter_map(|r| r["seq"].as_i64()).collect();
    assert_eq!(seqs, (1..=rows.len() as i64).collect::<Vec<_>>());
}

#[tokio::test]
async fn test_the_settings_route_saves_ops_and_reads_them_back() {
    let Some(f) = start("test_the_settings_route_saves_ops_and_reads_them_back", true, &[]).await else { return };
    let c = &f.c;
    let (pid, _) = project(c).await;
    let r = c
        .patch(
            &format!("/projects/{pid}/ai/settings"),
            json!({"ops": {"commands": {"test": "pytest -q"}, "nope": true}}),
        )
        .await;
    r.assert_status(200);
    assert_eq!(r.json()["ops"], json!({"commands": {"test": "pytest -q"}}));
    c.patch(&format!("/projects/{pid}/ai/settings"), json!({"ops": {"commands": {"lint": "ruff"}}})).await;
    let got = c.get(&format!("/projects/{pid}/ai/settings")).await.json()["ops"].clone();
    assert_eq!(got, json!({"commands": {"test": "pytest -q", "lint": "ruff"}}));
}
