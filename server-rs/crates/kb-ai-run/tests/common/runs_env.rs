//! Added for `runs`: the `env` fixture of `tests/ai_helpers.py` at service level. Python gives every test a new
//! database, a new `runs.RT` and a started scheduler; here the database is the process's, so `Env::start` empties the
//! tables of runs (a run an earlier test left would be recovered and started, or would hold a slot), replaces the
//! runtime and starts the scheduler. `FAKE_CLAUDE_*` variables, which the Python tests set in the environment, are
//! given to every CLI a run starts (`runs::set_cli_env`).

use kb_ai_run::runs;
use kb_board::hooks::NewAssignee;
use kb_db::database;
use kb_db::entities::{ai_account_state, ai_run, ai_run_command};
use kb_db::sea_orm::{ColumnTrait, EntityTrait, QueryFilter, QueryOrder};
use serde_json::{Value, json};

/// The scheduler of this process, running for one test.
pub struct Env;

fn vars(list: &[(&str, &str)]) -> Vec<(String, String)> {
    list.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect()
}

impl Env {
    /// A new runtime and a started scheduler; `fake` is what the CLIs of the test find in their environment.
    pub async fn start(fake: &[(&str, &str)]) -> Env {
        let env = Env::prepare(fake).await;
        runs::start_scheduler().await.expect("the scheduler starts");
        env
    }

    /// `start` without the scheduler (a test that starts it itself, or runs in `process` mode).
    pub async fn prepare(fake: &[(&str, &str)]) -> Env {
        kb_ai_run::register();
        runs::RT.reset();
        kb_ai_run::resources::MON.reset();
        kb_ai::runner_link::set_mode(Some("inprocess"));
        kb_ai::runner_link::set_in_runner(None);
        super::clear::<ai_run::Entity>().await;
        super::clear::<ai_run_command::Entity>().await;
        super::clear::<ai_account_state::Entity>().await;
        runs::set_cli_env(vars(fake));
        Env
    }

    /// `monkeypatch.setenv(...)` in the middle of a test: what the CLIs started from now on find.
    pub fn setenv(&self, fake: &[(&str, &str)]) {
        runs::set_cli_env(vars(fake));
    }

    /// The board dies: its tasks are gone, its CLIs and rows stay.
    pub fn crash(&self) {
        runs::RT.abandon();
        kb_ai_run::resources::MON.reset();
    }

    /// The end of the fixture: `runs.stop_scheduler()`.
    pub async fn stop(self) {
        runs::stop_scheduler().await;
        runs::set_cli_env(Vec::new());
        kb_ai::runner_link::set_mode(None);
    }
}

/// `PATCH /tickets/{id}` with `{"assignee": team}` as the route does it: the runs hear of the change, the ticket is
/// updated, the team's lead is woken.
pub async fn assign(ticket_id: &str, team_id: &str) {
    runs::before_ticket_change(ticket_id, None, NewAssignee::To(Some(team_id)), false, Some("user"))
        .await
        .expect("before the change");
    {
        let session = database::session();
        let update = kb_board::tickets::TicketUpdate::of("assignee", json!(team_id));
        kb_board::tickets::update_ticket(&session, ticket_id, &update).await.expect("update").expect("the ticket");
    }
    runs::wake_new_assignee(ticket_id, Some(team_id), Some("user"), "").await.expect("wake");
}

/// The newest run of a ticket as `GET /tickets/{id}/ai/runs` lists it first.
pub async fn last_run(ticket_id: &str) -> Option<Value> {
    let session = database::session();
    let run = ai_run::Entity::find()
        .filter(ai_run::Column::TicketId.eq(ticket_id))
        .order_by_desc(ai_run::Column::Number)
        .one(&session)
        .await
        .expect("runs");
    run.map(|r| Value::Object(runs::to_dict(&r)))
}

/// `_wait(c, ticket_id, states, timeout)`: the ticket's newest run once it is in one of the states.
pub async fn wait(ticket_id: &str, states: &[&str], timeout: f64) -> Value {
    let end = std::time::Instant::now() + std::time::Duration::from_secs_f64(timeout);
    loop {
        let run = last_run(ticket_id).await;
        if let Some(run) = &run {
            if states.contains(&run["state"].as_str().unwrap_or("")) {
                return run.clone();
            }
        }
        assert!(
            std::time::Instant::now() < end,
            "run never reached {states:?}: {}",
            run.map_or(Value::Null, |r| json!({"state": r["state"], "reason": r["ended_reason"],
                "waiting": r["waiting_reason"]}))
        );
        runs::RT.wake.set();
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
}

/// `_steps(run_id)`: the steps of a run, oldest first.
pub async fn steps_of(run_id: &str) -> Vec<Value> {
    let session = database::session();
    kb_ai::steps::read(&session, run_id, 0, 500, None, false).await.expect("steps")
}
