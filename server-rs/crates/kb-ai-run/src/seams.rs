//! Places where the modules of this crate meet AI-team modules that a later task ports. A slot that is not filled
//! behaves as the Python call would on a board with no run going.
//!
//! | seam | stands for | filled by |
//! |---|---|---|
//! | `RunProcs::proc_alive`, `kill_proc`, `has_task` | `runs.RT.procs.get(run_id)`, `proc.proc.returncode`, `proc.kill()`, `run_id in runs.RT.tasks` (asked by `kb_ai::power` through `kb_ai::seams::RunsRuntime`) | `runs` |
//! | `Runs::cancel` | `runs.cancel(run_id, by=, reason=)` (`teams.set_paused` with `cancel_current`, `teams.remove`); a `runs.RunError` is `CancelError::Run` | `runs` |
//! | `Runs::wake` | `runs.RT.wake.set()` (`teams.set_paused`, `teams.health_check`) | `runs` |
//! | `SessionHistory::prompt_block` | `session_history.prompt_block(session, ticket.id)` (`launch.build_prompt`, a new conversation on a ticket) | `session_history` |
//!
//! `kb_ai::seams::RunsRuntime` is one trait with four calls: `looks_like_cli` belongs to `cli` (ported here), the
//! other three to `runs` (not yet). `register()` of this crate fills the whole trait with `Runtime`, which answers
//! `looks_like_cli` itself and hands the three others to the `RunProcs` slot below; `runs` then only calls
//! `set_run_procs`.
//!
//! Filled here for the crates below: `kb_ai_know::seams::Cli` with `KnowCli` (`cli.find_cli`, `cli.child_env`,
//! `cli.kill_tree`, `accounts.env_for`), and `kb_board::hooks::AiTeamsHook` with `TeamNames` (`teams.check_name`).
//!
//! Not seams, but set by `runs` when it is ported: `resources::MON.set_on_breach` and `set_on_child_breach` (Python
//! assigns `resources.MON.on_breach` and `on_child_breach`).
//!
//! `launch` needs nothing of `worktrees`: the folder a run works in (`cwd`) and the ticket's Workspace are arguments
//! of `launch::prepare`, which `runs` gives.

use std::collections::HashMap;
use std::sync::{Arc, RwLock};

use async_trait::async_trait;
use kb_ai::seams::RunsRuntime;
use kb_db::Session;
use kb_db::entities::ai_account;
use kb_db::sea_orm::DbErr;
use serde_json::{Map, Value};

/// What `kb_ai::power` asks of the runs' runtime (`services/ai/runs.py`'s `RT`).
pub trait RunProcs: Send + Sync {
    /// `runs.RT.procs.get(run_id)`: `None` when the board holds no process object for the run, else whether the CLI
    /// behind it still runs (`proc.proc is not None and proc.proc.returncode is None`).
    fn proc_alive(&self, run_id: &str) -> Option<bool>;
    /// `runs.RT.procs[run_id].kill()`.
    fn kill_proc(&self, run_id: &str);
    /// `run_id in runs.RT.tasks`: the run's own task is starting or finishing it right now.
    fn has_task(&self, run_id: &str) -> bool;
}

static RUN_PROCS: RwLock<Option<Arc<dyn RunProcs>>> = RwLock::new(None);

/// Fill the runs' part of the runtime (a later call replaces the earlier one, which tests use).
pub fn set_run_procs(procs: Option<Arc<dyn RunProcs>>) {
    *RUN_PROCS.write().unwrap_or_else(|e| e.into_inner()) = procs;
}

/// The runs' part of the runtime, when `runs` has been ported and registered.
pub fn run_procs() -> Option<Arc<dyn RunProcs>> {
    RUN_PROCS.read().unwrap_or_else(|e| e.into_inner()).clone()
}

/// The `kb_ai::seams::RunsRuntime` this crate registers: `cli` answers for itself, `runs` through `RunProcs`.
pub struct Runtime;

impl RunsRuntime for Runtime {
    fn proc_alive(&self, run_id: &str) -> Option<bool> {
        run_procs().and_then(|procs| procs.proc_alive(run_id))
    }

    fn kill_proc(&self, run_id: &str) {
        if let Some(procs) = run_procs() {
            procs.kill_proc(run_id);
        }
    }

    fn has_task(&self, run_id: &str) -> bool {
        run_procs().is_some_and(|procs| procs.has_task(run_id))
    }

    fn looks_like_cli(&self, pid: i64) -> bool {
        crate::cli::looks_like_cli(pid, None)
    }
}

/// Why `Runs::cancel` did not cancel.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum CancelError {
    /// `runs.RunError`: the run cannot be cancelled (it already ended); the callers here carry on.
    #[error("{0}")]
    Run(String),
    /// Any other exception of `runs.cancel`: it reaches the caller.
    #[error("{0}")]
    Other(String),
}

/// What `teams` asks of the runs (`services/ai/runs.py`).
#[async_trait]
pub trait Runs: Send + Sync {
    /// `runs.cancel(run_id, by=by, reason=reason)`.
    async fn cancel(&self, run_id: &str, by: &str, reason: &str) -> Result<(), CancelError>;
    /// `runs.RT.wake.set()`: the scheduler looks at the queue now.
    fn wake(&self);
}

static RUNS: RwLock<Option<Arc<dyn Runs>>> = RwLock::new(None);

/// Fill the runs seam of `teams` (a later call replaces the earlier one, which tests use).
pub fn set_runs(runs: Option<Arc<dyn Runs>>) {
    *RUNS.write().unwrap_or_else(|e| e.into_inner()) = runs;
}

/// The runs seam of `teams`, when `runs` has been ported and registered.
pub fn runs() -> Option<Arc<dyn Runs>> {
    RUNS.read().unwrap_or_else(|e| e.into_inner()).clone()
}

/// What `launch` asks of the closed conversations of a ticket (`services/ai/session_history.py`).
#[async_trait]
pub trait SessionHistory: Send + Sync {
    /// `session_history.prompt_block(session, ticket_id)`: what a new conversation is told about the closed ones,
    /// or an empty text.
    async fn prompt_block(&self, session: &Session, ticket_id: &str) -> Result<String, DbErr>;
}

static SESSION_HISTORY: RwLock<Option<Arc<dyn SessionHistory>>> = RwLock::new(None);

/// Fill the session-history seam of `launch` (a later call replaces the earlier one, which tests use).
pub fn set_session_history(history: Option<Arc<dyn SessionHistory>>) {
    *SESSION_HISTORY.write().unwrap_or_else(|e| e.into_inner()) = history;
}

/// The session-history seam of `launch`, when `session_history` has been ported and registered.
pub fn session_history() -> Option<Arc<dyn SessionHistory>> {
    SESSION_HISTORY.read().unwrap_or_else(|e| e.into_inner()).clone()
}

/// Wait for a future of this crate from a function that is not async (the seam of `kb-ai-know` is not): it runs on a
/// thread and a small runtime of its own, so it works whatever runtime the caller is on. None when that runtime
/// cannot be made.
fn wait_for<T: Send>(fut: impl Future<Output = T> + Send) -> Option<T> {
    std::thread::scope(|scope| {
        let worker = scope.spawn(|| {
            let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().ok()?;
            Some(runtime.block_on(fut))
        });
        worker.join().ok().flatten()
    })
}

/// The `kb_ai_know::seams::Cli` this crate registers: the light model's calls into `cli` and `accounts`.
pub struct KnowCli;

impl kb_ai_know::seams::Cli for KnowCli {
    fn find_cli(&self, kind: &str, cli_path: Option<&str>) -> Option<String> {
        wait_for(crate::cli::find_cli(kind, cli_path)).and_then(|(path, _checked)| path)
    }

    fn child_env(&self) -> HashMap<String, String> {
        crate::cli::child_env(None).into_iter().collect()
    }

    fn env_for_account(&self, account: &ai_account::Model, env: HashMap<String, String>) -> HashMap<String, String> {
        let base: kb_ai::profiles::Env = env.iter().map(|(k, v)| (k.clone(), v.clone())).collect();
        match wait_for(crate::accounts::env_for(account, &base)) {
            Some(Ok(with_account)) => with_account.into_iter().collect(),
            // Python lets the exception end the light-model call; its callers then fall back to code, as they do
            // with the account left out here
            Some(Err(err)) => {
                tracing::warn!(target: "kanban.ai.kb", "The environment of account {} could not be built: {err}", account.id);
                env
            }
            None => env,
        }
    }

    fn kill_tree(&self, pid: u32) {
        crate::cli::kill_tree(i32::try_from(pid).ok());
    }
}

/// The `kb_board::hooks::AiTeamsHook` this crate registers: `teams.check_name`.
pub struct TeamNames;

#[async_trait]
impl kb_board::hooks::AiTeamsHook for TeamNames {
    async fn check_name(
        &self,
        session: &Session,
        project_id: &str,
        name: &str,
        exclude_id: Option<&str>,
    ) -> Result<Map<String, Value>, DbErr> {
        crate::teams::check_name(session, project_id, name, exclude_id).await
    }
}
