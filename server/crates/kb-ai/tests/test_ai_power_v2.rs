//! The computer's sleep (`services/ai/power.py`): runs that need the machine awake, and the check after it woke, against
//! v2 runs of a team. The routes (`/ai/power`, `/ai/power/wake`) are not ported here: the tests call the service functions
//! the routes call. `runs.RT.procs` and `runs.RT.tasks` are the `seams::RunsRuntime` of this crate; the tests fill it
//! with a fake the way the Python tests put fake process objects into `RT`.

mod common;

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};

use kb_ai::seams::{self, BOARD_CLOSED, RunsRuntime};
use kb_ai::{power, runner_link, steps};
use kb_db::database;
use kb_db::entities::{ai_run, ai_run_command, ai_run_step};
use kb_db::sea_orm::ActiveValue::Set;
use kb_db::sea_orm::EntityTrait;
use serde_json::{Value, json};

/// `runs.RT` with fake process objects: `procs[run id]` is the CLI's return code (None while it runs), `killed` the runs
/// whose `proc.kill()` was called, `tasks` the runs with a task of their own.
#[derive(Default)]
struct FakeRuntime {
    procs: Mutex<HashMap<String, Option<i32>>>,
    killed: Mutex<HashSet<String>>,
    tasks: Mutex<HashSet<String>>,
}

impl RunsRuntime for FakeRuntime {
    fn proc_alive(&self, run_id: &str) -> Option<bool> {
        self.procs.lock().expect("lock").get(run_id).map(|code| code.is_none())
    }
    fn kill_proc(&self, run_id: &str) {
        self.killed.lock().expect("lock").insert(run_id.to_string());
    }
    fn has_task(&self, run_id: &str) -> bool {
        self.tasks.lock().expect("lock").contains(run_id)
    }
    fn looks_like_cli(&self, _pid: i64) -> bool {
        false
    }
}

/// The fixture of `_run(env, state, pid)`: a project and a team once, a ticket and a run in `state` each time.
async fn run(env: &mut Option<(String, String)>, state: &str, pid: Option<i32>) -> String {
    if env.is_none() {
        let (project, _) = common::project().await;
        let (team, _) = common::team(&project, "Claude Code · Backend", common::TeamOpts::default()).await;
        *env = Some((project, team.id));
    }
    let (project, team) = env.as_ref().expect("set above");
    let ticket = common::ticket(project, "Fix add()", "todo").await;
    common::run(project, team, Some(&ticket.id), state, |r| r.pid = Set(pid)).await.id
}

async fn fresh() -> (tokio::sync::MutexGuard<'static, ()>, Arc<FakeRuntime>) {
    let lock = common::init().await;
    common::clear::<ai_run::Entity>().await;
    common::clear::<ai_run_step::Entity>().await;
    common::clear::<ai_run_command::Entity>().await;
    runner_link::set_mode(None);
    runner_link::set_in_runner(None);
    let fake = Arc::new(FakeRuntime::default());
    seams::set_runs_runtime(Some(fake.clone()));
    (lock, fake)
}

#[tokio::test]
async fn test_active_counts_starting_and_running_only() {
    let (_lock, _fake) = fresh().await;
    let mut env = None;
    let session = database::session();
    assert_eq!(power::active_runs(&session).await.expect("count"), 0);
    for state in ["queued", "starting", "running", "needs_input", "finished"] {
        run(&mut env, state, None).await;
    }
    assert_eq!(power::active_runs(&database::session()).await.expect("count"), 2);
}

#[tokio::test]
async fn test_wake_ends_a_run_with_no_process_like_after_a_crash() {
    let (_lock, _fake) = fresh().await;
    let mut env = None;
    let run_id = run(&mut env, "running", Some(999_999)).await;
    let body = power::after_wake(&database::session()).await.expect("wake");
    assert_eq!(body["orphans"], json!([run_id]));
    assert_eq!(body["checked"], json!(1));
    let row = ai_run::Entity::find_by_id(run_id.as_str()).one(&database::session()).await.expect("run").expect("row");
    assert!(row.state == "failed" && row.stop_code.as_deref() == Some(BOARD_CLOSED));
    assert!(row.ended_by.as_deref() == Some("board") && row.token_hash.is_none());
    assert!(row.ended_reason.as_deref().expect("reason").contains("slept") && row.ended_at.is_some());
}

#[tokio::test]
async fn test_wake_stops_a_dead_cli_and_leaves_a_live_one() {
    let (_lock, fake) = fresh().await;
    let mut env = None;
    let (dead, live) = (run(&mut env, "running", None).await, run(&mut env, "starting", None).await);
    fake.procs.lock().expect("lock").insert(dead.clone(), Some(-9));
    fake.procs.lock().expect("lock").insert(live.clone(), None);
    let out = power::after_wake(&database::session()).await.expect("wake");
    assert_eq!(out["dead"], json!([dead]));
    assert_eq!(out["alive"], json!([live]));
    assert_eq!(out["orphans"], json!([]));
    {
        let killed = fake.killed.lock().expect("lock");
        assert!(killed.contains(&dead) && !killed.contains(&live));
    }
    // the dead run got a visible step so the reader sees why it ended
    let rows = steps::read(&database::session(), &dead, 0, 10, None, false).await.expect("steps");
    assert!(rows.iter().any(|r| r["title"].as_str().is_some_and(|t| t.contains("did not survive"))));
}

#[tokio::test]
async fn test_wake_leaves_a_run_whose_task_is_being_started() {
    let (_lock, fake) = fresh().await;
    let mut env = None;
    let run_id = run(&mut env, "starting", None).await;
    fake.tasks.lock().expect("lock").insert(run_id.clone());
    let out = power::after_wake(&database::session()).await.expect("wake");
    assert_eq!(out["alive"], json!([run_id]));
    assert_eq!(out["orphans"], json!([]));
    let row = ai_run::Entity::find_by_id(run_id.as_str()).one(&database::session()).await.expect("run").expect("row");
    assert_eq!(row.state, "starting");
}

#[tokio::test]
async fn test_wake_with_nothing_running_is_quiet() {
    let (_lock, _fake) = fresh().await;
    let out = power::after_wake(&database::session()).await.expect("wake");
    assert_eq!(Value::Object(out), json!({"checked": 0, "alive": [], "dead": [], "orphans": []}));
    assert!(ai_run::Entity::find().all(&database::session()).await.expect("runs").is_empty());
}

#[tokio::test]
async fn test_wake_is_handed_to_the_runner_in_process_mode() {
    let (_lock, _fake) = fresh().await;
    let mut env = None;
    // KANBAN_RUNNER=process and no KANBAN_IN_RUNNER; Python replaces `runner_link.command` with a recorder, the port
    // reads the command row the real one writes
    runner_link::set_mode(Some("process"));
    runner_link::set_in_runner(Some(false));
    let run_id = run(&mut env, "running", Some(999_999)).await;
    let out = power::after_wake(&database::session()).await.expect("wake");
    assert_eq!(out["deferred"], json!(true));
    assert_eq!(out["checked"], json!(0));
    let commands = ai_run_command::Entity::find().all(&database::session()).await.expect("commands");
    assert_eq!(commands.len(), 1);
    assert_eq!(
        (commands[0].run_id.as_str(), commands[0].command.as_str(), commands[0].payload.as_str()),
        ("*", "wake", "{}")
    );
    assert!(commands[0].taken_at.is_none(), "wait=False: the call did not wait for the runner");
    let row = ai_run::Entity::find_by_id(run_id.as_str()).one(&database::session()).await.expect("run").expect("row");
    assert_eq!(row.state, "running");
    runner_link::set_mode(None);
    runner_link::set_in_runner(None);
}
