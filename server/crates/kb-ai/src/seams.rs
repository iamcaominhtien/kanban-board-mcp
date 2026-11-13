//! Places where this crate's modules call AI-team modules that a later task ports (`runs`, `teams`, `accounts`, `cli`,
//! `worktrees`...). Python imports those late, inside a function; here each call goes through a slot the later task
//! fills when it ports that module. A slot that is not filled behaves as the Python call would on an empty system
//! (no running process, nothing to do); each seam says which Python call it stands for.
//!
//! List of seams (the Python call, the module that fills it):
//!
//! | seam | stands for | filled by |
//! |---|---|---|
//! | `RunsRuntime::proc_alive`, `kill_proc`, `has_task` | `runs.RT.procs.get(run_id)`, `proc.proc.returncode`, `proc.kill()`, `run_id in runs.RT.tasks` (`power.after_wake`) | `runs` |
//! | `RunsRuntime::looks_like_cli` | `cli.looks_like_cli(pid)` (`power.after_wake`) | `cli` |
//! | `TicketRuns::before_ticket_change` | `ai_runs.before_ticket_change(...)` (the board's `AiRunsHook`) | `runs` |
//! | `TicketRuns::note_person_edit` | `ai_runs.note_person_edit(...)` | `runs` |
//! | `TicketRuns::wake_new_assignee` | `ai_runs.wake_new_assignee(...)` | `runs` |
//! | `TicketRuns::on_status` | `ai_worktrees.on_status(...)` | `worktrees` |
//! | `TeamNames::check_name` | `teams.check_name(...)` (the board's `AiTeamsHook`) | `teams` |

use std::sync::{Arc, RwLock};

/// `runs.BOARD_CLOSED`: the stop code of a run ended because the board (or the computer) closed under it.
pub const BOARD_CLOSED: &str = "board_closed";

/// What `power` asks of the runs' runtime (`services/ai/runs.py`'s `RT`) and of `cli`.
pub trait RunsRuntime: Send + Sync {
    /// `runs.RT.procs.get(run_id)`: `None` when the board holds no process object for the run, else whether the CLI
    /// behind it still runs (`proc.proc is not None and proc.proc.returncode is None`).
    fn proc_alive(&self, run_id: &str) -> Option<bool>;
    /// `runs.RT.procs[run_id].kill()`.
    fn kill_proc(&self, run_id: &str);
    /// `run_id in runs.RT.tasks`: the run's own task is starting or finishing it right now.
    fn has_task(&self, run_id: &str) -> bool;
    /// `cli.looks_like_cli(pid)`: `pid` is still one of our CLI processes.
    fn looks_like_cli(&self, pid: i64) -> bool;
}

static RUNS: RwLock<Option<Arc<dyn RunsRuntime>>> = RwLock::new(None);

/// Fill the runs' runtime seam (a later call replaces the earlier one, which tests use).
pub fn set_runs_runtime(runtime: Option<Arc<dyn RunsRuntime>>) {
    *RUNS.write().unwrap_or_else(|e| e.into_inner()) = runtime;
}

/// The runs' runtime, when `runs` has been ported and registered.
pub fn runs_runtime() -> Option<Arc<dyn RunsRuntime>> {
    RUNS.read().unwrap_or_else(|e| e.into_inner()).clone()
}

/// What the board's ticket code asks of the AI team's runs and worktrees (`kb_board::hooks::AiRunsHook`) beyond
/// `in_run`, which this crate answers from the guard. Python: `ai_runs.before_ticket_change`, `ai_runs.note_person_edit`,
/// `ai_runs.wake_new_assignee` and `ai_worktrees.on_status`.
#[async_trait::async_trait]
pub trait TicketRuns: Send + Sync {
    /// `ai_runs.before_ticket_change(ticket_id, status=, assignee=, deleting=, by=)`.
    async fn before_ticket_change(
        &self,
        ticket_id: &str,
        status: Option<&str>,
        assignee: kb_board::hooks::NewAssignee<'_>,
        deleting: bool,
        by: &str,
    ) -> kb_base::ApiResult<()>;
    /// `ai_runs.note_person_edit(ticket_id, by=, what=, tell_lead=)`.
    async fn note_person_edit(&self, ticket_id: &str, by: &str, what: &str, tell_lead: bool) -> kb_base::ApiResult<()>;
    /// `ai_runs.wake_new_assignee(ticket_id, assignee_id, by=)`.
    async fn wake_new_assignee(&self, ticket_id: &str, assignee_id: &str, by: &str) -> kb_base::ApiResult<()>;
    /// `ai_worktrees.on_status(ticket_id, status, previous, by_ai=)`: started in the background.
    fn on_status(&self, ticket_id: &str, status: &str, previous: &str, by_ai: bool);
}

static TICKET_RUNS: RwLock<Option<Arc<dyn TicketRuns>>> = RwLock::new(None);

/// Fill the ticket-runs seam (a later call replaces the earlier one).
pub fn set_ticket_runs(runs: Option<Arc<dyn TicketRuns>>) {
    *TICKET_RUNS.write().unwrap_or_else(|e| e.into_inner()) = runs;
}

/// The ticket-runs seam, when `runs` has been ported and registered.
pub fn ticket_runs() -> Option<Arc<dyn TicketRuns>> {
    TICKET_RUNS.read().unwrap_or_else(|e| e.into_inner()).clone()
}
