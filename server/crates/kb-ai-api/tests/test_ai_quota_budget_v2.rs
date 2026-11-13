//! The test of `server/tests/test_ai_quota_budget_v2.py` that runs a CLI through the routes: a weekly limit that
//! shows in a run's stream holds the account, and the next run waits. The tests that call `services.ai.quota` and
//! `services.ai.budget` directly are in `crates/kb-ai/tests/test_ai_quota_budget_v2.rs`.

mod common;

use std::time::Duration;

use common::{project, runner, scalar, sign_in, start, ticket, wait_run};
use serde_json::json;

#[tokio::test]
async fn test_a_weekly_limit_in_a_run_holds_the_account_and_the_next_run_waits() {
    let name = "test_a_weekly_limit_in_a_run_holds_the_account_and_the_next_run_waits";
    let Some(f) = start(name, true, &[("FAKE_CLAUDE_MODE", "window")]).await else { return };
    sign_in(&f);
    let c = &f.c;
    let (pid, _) = project(c).await;
    let team = runner(&f, &pid, "Claude Code · Backend", json!({})).await;
    let first = ticket(c, &pid, "First", "todo").await;
    let r = c.post(&format!("/tickets/{first}/ai/run"), json!({})).await;
    assert!(r.status == 200 || r.status == 201, "{}", r.text());
    wait_run(c, &first, &["failed", "finished"]).await;
    // `quota.held(row)`: the account is held until a time that has not come yet
    let row = scalar(
        &f.server,
        "SELECT json_object('held_until', held_until, 'used', seven_day_used, 'status', seven_day_status) \
         FROM ai_account_state WHERE key = 'local'",
        &[],
    )
    .await;
    assert!(row.is_object(), "{row}");
    let held_until = row["held_until"].as_str().expect("the account is held");
    let until = chrono::DateTime::parse_from_rfc3339(held_until).expect("a time");
    assert!(until > chrono::Utc::now());
    assert!(row["used"] == 1.0 && row["status"] == "rejected", "{row}");
    // the next run of the same account is not started: it waits, and says for which window
    let second = ticket(c, &pid, "Second", "todo").await;
    let r = c.post(&format!("/tickets/{second}/ai/run"), json!({})).await;
    assert!(r.status == 200 || r.status == 201, "{}", r.text());
    wait_run(c, &second, &["queued"]).await;
    tokio::time::sleep(Duration::from_millis(500)).await;
    let run = c.get(&format!("/tickets/{second}/ai/runs")).await.json()[0].clone();
    assert_eq!(run["state"], "queued");
    assert!(run["waiting_reason"].as_str().unwrap_or_default().starts_with("Waiting for the next window"), "{run}");
    assert!(team["id"].is_string());
}
