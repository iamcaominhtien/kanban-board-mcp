//! `tests/test_ai_power_v2.py`, the routes of `api/ai_power.py`: runs that need the machine awake, and the check after it
//! woke, against v2 runs of a team. The tests that put fake process objects into `runs.RT` or call the module's own
//! functions are unit tests of `kb-ai` (`tests/test_ai_power_v2.rs` there). A team and its runs are rows added to the
//! server's database.

// Unix only: it starts shell scripts, makes files executable or links them (Windows CI only compiles the tests).
#![cfg(unix)]

mod common;

use common::{project, run, scalar, start, team, ticket};
use serde_json::{Value, json};

/// `_run(env, state, pid)`: a ticket and a run in `state` of one team (made the first time).
struct World {
    pid: String,
    team: String,
}

async fn world(f: &common::Fixture) -> World {
    let (pid, _) = project(&f.c).await;
    let team = team(&f.server, &pid, "Claude Code · Backend", json!({})).await;
    World { pid, team }
}

async fn a_run(f: &common::Fixture, w: &World, state: &str, pid: Option<i64>) -> String {
    let t = ticket(&f.c, &w.pid, "Fix add()", "todo").await;
    run(&f.server, &w.pid, &w.team, &t, state, pid).await
}

#[tokio::test]
async fn test_active_counts_starting_and_running_only() {
    let Some(f) = start("test_active_counts_starting_and_running_only", true, &[]).await else { return };
    let c = &f.c;
    assert_eq!(c.get("/ai/power").await.json(), json!({"active": 0}));
    let w = world(&f).await;
    for state in ["queued", "starting", "running", "needs_input", "finished"] {
        a_run(&f, &w, state, None).await;
    }
    assert_eq!(c.get("/ai/power").await.json(), json!({"active": 2}));
}

#[tokio::test]
async fn test_wake_ends_a_run_with_no_process_like_after_a_crash() {
    let Some(f) = start("test_wake_ends_a_run_with_no_process_like_after_a_crash", true, &[]).await else { return };
    let c = &f.c;
    let w = world(&f).await;
    let run_id = a_run(&f, &w, "running", Some(999_999)).await;
    let r = c.post_empty("/ai/power/wake").await;
    assert_eq!(r.status, 200, "{}", r.text());
    let body = r.json();
    assert!(body["orphans"] == json!([run_id]) && body["checked"] == 1);
    let row = |column: &str| {
        let sql = format!("SELECT {column} FROM ai_run WHERE id = ?");
        let (server, run_id) = (&f.server, run_id.clone());
        async move { scalar(server, &sql, &[json!(run_id)]).await }
    };
    assert_eq!(row("state").await, "failed");
    assert_eq!(row("stop_code").await, "board_closed");
    assert_eq!(row("ended_by").await, "board");
    assert_eq!(row("token_hash").await, Value::Null);
    assert!(row("ended_reason").await.as_str().expect("reason").contains("slept"));
    assert!(row("ended_at").await.as_str().is_some_and(|t| !t.is_empty()));
}

#[tokio::test]
async fn test_wake_with_nothing_running_is_quiet() {
    let Some(f) = start("test_wake_with_nothing_running_is_quiet", true, &[]).await else { return };
    let r = f.c.post_empty("/ai/power/wake").await;
    assert_eq!(r.status, 200);
    assert_eq!(r.json(), json!({"checked": 0, "alive": [], "dead": [], "orphans": []}));
    assert_eq!(scalar(&f.server, "SELECT COUNT(*) FROM ai_run", &[]).await, json!(0));
}
