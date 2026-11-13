//! The part of `server/tests/test_board_ai_v2.py` that goes through the schedules' routes: a schedule's dry run is a
//! plan written by the assistant (`POST /projects/{id}/ai/schedules/dry-run`, `api/schedules.py`). The other tests of
//! the file are in `crates/kb-assist/tests/{test_board_ai_v2,routes_board_ai_v2}.rs`.
//!
//! The Python test sets `FAKE_CLAUDE_ASSISTANT_JSON` with `monkeypatch.setenv` before its request; the server here
//! starts with it (nothing else in the test changes it).

mod common;

use common::{project, start, ticket};
use serde_json::json;

#[tokio::test]
async fn test_a_schedule_dry_run_is_a_plan_from_the_assistant() {
    let name = "test_a_schedule_dry_run_is_a_plan_from_the_assistant";
    let plan = json!({"text": "1) Fix the operator in calc.py."}).to_string();
    let Some(f) = start(name, true, &[("FAKE_CLAUDE_MODE", "assistant"), ("FAKE_CLAUDE_ASSISTANT_JSON", &plan)]).await
    else {
        return;
    };
    let c = &f.c;
    std::fs::write(f.claude.join(".fake-login"), "an@work.example").expect("login file");
    // `_board`: a project and a team on the stand-in CLI
    let (pid, _an) = project(c).await;
    let repo = f.accounts.parent().expect("the test's folder").join("repo");
    std::fs::create_dir_all(&repo).expect("repo folder");
    std::fs::write(repo.join("calc.py"), "def add(a, b):\n    return a - b\n").expect("calc.py");
    let made = c
        .post(
            &format!("/projects/{pid}/ai/teams"),
            json!({"name": "Claude Code · Backend", "working_dir": repo.to_string_lossy(),
                   "cli_path": f.bin.join("claude").to_string_lossy()}),
        )
        .await;
    made.assert_status(201);
    let tid = ticket(c, &pid, "Fix add()", "todo").await;
    let team = c.get(&format!("/projects/{pid}/ai/teams")).await.json()[0].clone();
    let r = c
        .post(&format!("/projects/{pid}/ai/schedules/dry-run"), json!({"ticket_id": tid, "member_id": team["id"]}))
        .await;
    r.assert_status(200);
    assert_eq!(
        r.json(),
        json!({"text": "1) Fix the operator in calc.py.", "member_name": team["name"], "cost": 0.02, "metered": false})
    );
    let missing = c
        .post(&format!("/projects/{pid}/ai/schedules/dry-run"), json!({"ticket_id": "nope", "member_id": team["id"]}))
        .await;
    assert!(matches!(missing.status, 404 | 422), "{}", missing.text());
}
