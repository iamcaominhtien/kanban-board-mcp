//! Places where the modules of this crate meet modules of crates above it (the assistant, Docs comments), and the
//! slots tests fill to replace a module of this crate. A slot that is not filled behaves as the Python call would on
//! a board with no run going.
//!
//! `touches` and `compact` (part 3) live in this crate now: `runs` calls `touches::carry_answer`,
//! `touches::record_edit` and `compact::after_run` directly, and their slots are gone.
//!
//! | seam | stands for | filled by |
//! |---|---|---|
//! | `RunProcs::proc_alive`, `kill_proc`, `has_task` | `runs.RT.procs.get(run_id)`, `proc.proc.returncode`, `proc.kill()`, `run_id in runs.RT.tasks` (asked by `kb_ai::power` through `kb_ai::seams::RunsRuntime`) | `runs` |
//! | `Runs::cancel` | `runs.cancel(run_id, by=, reason=)` (`teams.set_paused` with `cancel_current`, `teams.remove`); a `runs.RunError` is `CancelError::Run` | `runs` |
//! | `Runs::wake` | `runs.RT.wake.set()` (`teams.set_paused`, `teams.health_check`) | `runs` |
//! | `SessionHistory::prompt_block` | `session_history.prompt_block(session, ticket.id)` (`launch.build_prompt`, a new conversation on a ticket) | nobody: `session_history` is called directly; a test puts its own in the slot, as the Python tests patch the function |
//! | `SessionHistory::closed_session_ids` | `session_history.closed_session_ids(session, ticket_id)` (`runs.create_run`, `runs._session_for`) | as above |
//! | `Assistant::oneshot` | `engine.oneshot(skill, inputs, by=by, model=model)` of `services/assistant/engine.py` (`session_history.start_over`, the skill `session-summary`) | the assistant (`kb-assist`) |
//! | `Assistant::turn` | `engine.turn(project_id, name=, skill=, inputs=, by=, feature=, ticket_id=, fresh=True, timeout_s=300.0)` (`schedules.dry_run`, the skill `schedule-dry-run`); an `AssistError` is `AssistFailure::Assist` | the assistant (`kb-assist`) |
//! | `PageNotes::create_thread` | `docs_comments.create_thread(session, page_id, kind="page", body=text)` (`messaging.deliver_to_page`) | Docs comments |
//! | `PageNotes::docs_ai_on` | `assistant_docs.docs_ai_on(session, project_id)` (`messaging.deliver_to_page`, and `kb_draw::hooks::CanvasDelivery::docs_ai_on`) | the assistant |
//! | `PageNotes::ready_state` | `(await engine.ready(project_id))["state"]` | the assistant |
//! | `PageNotes::start_thread_reply` | `jobs.start(session, project_id=, kind="thread_reply", ...)` of `services/docs_ai/jobs.py` | Docs AI |
//!
//! `runs` (part 2b) fills `RunProcs` and `Runs` (`RunsSeam`), `kb_ai::seams::TicketRuns` (`TicketSeam`),
//! `kb_ai_work::seams::Runs` (`WorkRuns`) and `kb_draw::hooks::CanvasDelivery` (`CanvasNotes`): see `register()`.
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

/// What `launch` and `runs` ask of the closed conversations of a ticket (`services/ai/session_history.py`). The slot
/// is empty unless a test fills it: the callers go through `prompt_block` and `closed_session_ids` below, which call
/// the module itself when nothing replaces it.
#[async_trait]
pub trait SessionHistory: Send + Sync {
    /// `session_history.prompt_block(session, ticket_id)`: what a new conversation is told about the closed ones,
    /// or an empty text.
    async fn prompt_block(&self, session: &Session, ticket_id: &str) -> Result<String, DbErr>;
    /// `session_history.closed_session_ids(session, ticket_id)`: every Claude Code session id that a history row of
    /// the ticket has closed; none of them is resumed again. (A ticket with no history row: none.)
    async fn closed_session_ids(
        &self,
        _session: &Session,
        _ticket_id: &str,
    ) -> Result<std::collections::HashSet<String>, DbErr> {
        Ok(std::collections::HashSet::new())
    }
}

static SESSION_HISTORY: RwLock<Option<Arc<dyn SessionHistory>>> = RwLock::new(None);

/// Replace `session_history` for `launch` and `runs` (a later call replaces the earlier one; None puts the module
/// back). Tests use it as the Python tests patch `session_history.prompt_block`.
pub fn set_session_history(history: Option<Arc<dyn SessionHistory>>) {
    *SESSION_HISTORY.write().unwrap_or_else(|e| e.into_inner()) = history;
}

/// What a test put in place of `session_history`, if anything.
pub fn session_history() -> Option<Arc<dyn SessionHistory>> {
    SESSION_HISTORY.read().unwrap_or_else(|e| e.into_inner()).clone()
}

/// `session_history.prompt_block(session, ticket_id)`: the module's, unless a test replaced it.
pub(crate) async fn prompt_block(session: &Session, ticket_id: &str) -> Result<String, DbErr> {
    match session_history() {
        Some(history) => history.prompt_block(session, ticket_id).await,
        None => crate::session_history::prompt_block(session, ticket_id, 5).await,
    }
}

/// `session_history.closed_session_ids(session, ticket_id)`: the module's, unless a test replaced it.
pub(crate) async fn closed_session_ids(
    session: &Session,
    ticket_id: &str,
) -> Result<std::collections::HashSet<String>, DbErr> {
    match session_history() {
        Some(history) => history.closed_session_ids(session, ticket_id).await,
        None => crate::session_history::closed_session_ids(session, ticket_id).await,
    }
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

// ---------------------------------------------------------------------------------------------------------------
// Slots of `messaging`, `session_history` and `schedules` for the assistant and Docs comments (crates above)
// ---------------------------------------------------------------------------------------------------------------

/// What a turn of the board's assistant gave back, as far as this crate reads it (`engine.Turn`).
#[derive(Debug, Clone, Default)]
pub struct AssistTurn {
    /// finished | failed | cancelled
    pub state: String,
    /// Why it failed or stopped.
    pub error: Option<String>,
    /// The answer as text.
    pub text: String,
    /// The answer in the skill's JSON schema, when it was asked in one (`turn.structured` when it is a dict).
    pub structured: Option<Map<String, Value>>,
    /// `turn.data()`: the structured answer, else the text parsed as JSON, else `{}`.
    pub data: Map<String, Value>,
    /// Who answered, as the UI names it.
    pub member: String,
    /// The model that answered.
    pub model: Option<String>,
    /// What the turn cost.
    pub cost: f64,
}

/// Why the assistant gave no turn.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum AssistFailure {
    /// `AssistError`: the request was refused; the text is its message.
    #[error("{0}")]
    Assist(String),
    /// Any other exception.
    #[error("{0}")]
    Other(String),
}

/// The keyword arguments of `engine.turn` that `schedules.dry_run` gives (`fresh=True`, `timeout_s=300.0` and the
/// skill's own schema are part of the call).
#[derive(Debug, Clone)]
pub struct AssistAsk {
    /// The conversation (`schedule:<id>:dry-run`).
    pub name: String,
    /// The feature skill of the turn.
    pub skill: String,
    /// The skill's inputs, in the order they are shown.
    pub inputs: Map<String, Value>,
    /// The person who asks.
    pub by: String,
    /// The feature the turn is metered as.
    pub feature: String,
    /// The ticket the turn's tools act on.
    pub ticket_id: Option<String>,
    /// Start a new conversation instead of resuming the one of `name`.
    pub fresh: bool,
    /// How long the turn may say nothing, in seconds.
    pub timeout_s: f64,
}

/// What `session_history` and `schedules` ask of the board's assistant (`services/assistant/engine.py`, a late import
/// in Python; `kb-assist` is above this crate).
#[async_trait]
pub trait Assistant: Send + Sync {
    /// `engine.oneshot(skill, inputs, by=by, model=model)`: one answer with a skill and nothing else.
    async fn oneshot(
        &self,
        skill: &str,
        inputs: Map<String, Value>,
        by: &str,
        model: &str,
    ) -> Result<AssistTurn, AssistFailure>;
    /// `engine.turn(project_id, name=, skill=, inputs=, by=, feature=, ticket_id=, fresh=, timeout_s=)`.
    async fn turn(&self, project_id: &str, ask: AssistAsk) -> Result<AssistTurn, AssistFailure>;
}

static ASSISTANT: RwLock<Option<Arc<dyn Assistant>>> = RwLock::new(None);

/// Fill the assistant seam (a later call replaces the earlier one, which tests use).
pub fn set_assistant(assistant: Option<Arc<dyn Assistant>>) {
    *ASSISTANT.write().unwrap_or_else(|e| e.into_inner()) = assistant;
}

/// The assistant seam, when the assistant has been registered.
pub fn assistant() -> Option<Arc<dyn Assistant>> {
    ASSISTANT.read().unwrap_or_else(|e| e.into_inner()).clone()
}

/// What `messaging.deliver_to_page` asks of Docs comments, the assistant and the Docs AI jobs (late imports there).
#[async_trait]
pub trait PageNotes: Send + Sync {
    /// `docs_comments.create_thread(session, page_id, kind="page", body=text)`: the thread as a dict (`id`, and
    /// `project_id` when it has one). The error is the text of the exception.
    async fn create_thread(&self, session: &Session, page_id: &str, body: &str) -> Result<Map<String, Value>, String>;
    /// `assistant_docs.docs_ai_on(session, project_id)`: whether the Docs assistant is on for the project.
    async fn docs_ai_on(&self, session: &Session, project_id: &str) -> Result<bool, DbErr>;
    /// `(await engine.ready(project_id))["state"]`.
    async fn ready_state(&self, project_id: &str) -> Result<String, String>;
    /// `jobs.start(session, project_id=, kind="thread_reply", started_by=by, page_id=, thread_id=,
    /// instruction=text[:300], result={"input": {"depth": depth}})`: the id of the job.
    async fn start_thread_reply(
        &self,
        session: &Session,
        project_id: &str,
        by: &str,
        page_id: &str,
        thread_id: &str,
        instruction: &str,
        depth: i64,
    ) -> Result<String, String>;
}

static PAGE_NOTES: RwLock<Option<Arc<dyn PageNotes>>> = RwLock::new(None);

/// Fill the page seam of `messaging` (a later call replaces the earlier one, which tests use).
pub fn set_page_notes(notes: Option<Arc<dyn PageNotes>>) {
    *PAGE_NOTES.write().unwrap_or_else(|e| e.into_inner()) = notes;
}

/// The page seam of `messaging`, when Docs comments and the assistant have been ported and registered.
pub fn page_notes() -> Option<Arc<dyn PageNotes>> {
    PAGE_NOTES.read().unwrap_or_else(|e| e.into_inner()).clone()
}

// ---------------------------------------------------------------------------------------------------------------
// Filled by `runs` and `messaging` for this crate and the crates below
// ---------------------------------------------------------------------------------------------------------------

/// `RunProcs` and `Runs` as `runs` backs them (`runs.RT.procs`, `runs.RT.tasks`, `runs.cancel`, `runs.RT.wake`).
pub struct RunsSeam;

impl RunProcs for RunsSeam {
    fn proc_alive(&self, run_id: &str) -> Option<bool> {
        crate::runs::RT.proc(run_id).map(|proc| proc.running())
    }

    fn kill_proc(&self, run_id: &str) {
        if let Some(proc) = crate::runs::RT.proc(run_id) {
            proc.kill();
        }
    }

    fn has_task(&self, run_id: &str) -> bool {
        crate::runs::RT.has_task(run_id)
    }
}

#[async_trait]
impl Runs for RunsSeam {
    async fn cancel(&self, run_id: &str, by: &str, reason: &str) -> Result<(), CancelError> {
        match crate::runs::cancel(run_id, by, Some(reason), None, false).await {
            Ok(_) => Ok(()),
            Err(err) if err.is_run_error() => Err(CancelError::Run(err.to_string())),
            Err(err) => Err(CancelError::Other(err.to_string())),
        }
    }

    fn wake(&self) {
        crate::runs::RT.wake.set();
    }
}

/// `kb_ai::seams::TicketRuns` as `runs` backs it. `on_status` is `worktrees.on_status` (what `kb_ai_work::register()`
/// installs), called directly, so the result is the same whichever of the two crates registers first: this object
/// never asks an earlier one, and `kb_ai_work`'s hands the three run calls to whatever was there before it.
pub struct TicketSeam;

fn api_error(err: crate::runs::RunError) -> kb_base::ApiError {
    match err {
        crate::runs::RunError::Db(err) => err.into(),
        other => kb_base::ApiError::internal(other),
    }
}

#[async_trait]
impl kb_ai::seams::TicketRuns for TicketSeam {
    async fn before_ticket_change(
        &self,
        ticket_id: &str,
        status: Option<&str>,
        assignee: kb_board::hooks::NewAssignee<'_>,
        deleting: bool,
        by: &str,
    ) -> kb_base::ApiResult<()> {
        let by = Some(by).filter(|b| !b.is_empty());
        crate::runs::before_ticket_change(ticket_id, status, assignee, deleting, by).await.map_err(api_error)
    }

    async fn note_person_edit(&self, ticket_id: &str, by: &str, what: &str, tell_lead: bool) -> kb_base::ApiResult<()> {
        let by = Some(by).filter(|b| !b.is_empty());
        crate::runs::note_person_edit(ticket_id, by, what, tell_lead).await.map_err(api_error)
    }

    async fn wake_new_assignee(&self, ticket_id: &str, assignee_id: &str, by: &str) -> kb_base::ApiResult<()> {
        let by = Some(by).filter(|b| !b.is_empty());
        crate::runs::wake_new_assignee(ticket_id, Some(assignee_id), by, "").await.map(|_| ()).map_err(api_error)
    }

    fn on_status(&self, ticket_id: &str, status: &str, previous: &str, by_ai: bool) {
        kb_ai_work::worktrees::on_status(ticket_id, status, previous, by_ai);
    }
}

/// `kb_ai_work::seams::Runs` as `runs` backs it (`runs.deliver_to_ticket` for the GitHub watcher).
pub struct WorkRuns;

#[async_trait]
impl kb_ai_work::seams::Runs for WorkRuns {
    async fn deliver_to_ticket(&self, ticket_id: &str, text: &str, by: &str, trigger: &str) -> Result<Value, String> {
        crate::runs::deliver_to_ticket(ticket_id, text, by, trigger, 0)
            .await
            .map(Value::Object)
            .map_err(|err| err.to_string())
    }
}

/// `kb_draw::hooks::CanvasDelivery` as `messaging` backs it. `docs_ai_on` belongs to the assistant: it answers
/// through the `PageNotes` slot, and "off" until the assistant fills it (what the canvas code did with no hook).
pub struct CanvasNotes;

fn deliver_error(err: crate::runs::RunError) -> kb_draw::hooks::DeliverError {
    use kb_draw::hooks::DeliverError;
    if err.is_run_error() {
        DeliverError::Run(err.to_string())
    } else if err.is_value_error() {
        DeliverError::Value(err.to_string())
    } else {
        DeliverError::Other(err.to_string())
    }
}

#[async_trait]
impl kb_draw::hooks::CanvasDelivery for CanvasNotes {
    async fn docs_ai_on(&self, session: &Session, project_id: &str) -> kb_draw::Result<bool> {
        match page_notes() {
            Some(notes) => Ok(notes.docs_ai_on(session, project_id).await?),
            None => Ok(false),
        }
    }

    async fn deliver_to_ticket(
        &self,
        ticket_id: &str,
        note: &str,
        by: &str,
        trigger: &str,
        depth: i32,
    ) -> Result<(), kb_draw::hooks::DeliverError> {
        crate::messaging::deliver_to_ticket(ticket_id, note, by, trigger, i64::from(depth))
            .await
            .map(|_| ())
            .map_err(deliver_error)
    }

    async fn deliver_to_page(
        &self,
        page_id: &str,
        note: &str,
        by: &str,
        depth: i32,
    ) -> Result<Option<String>, kb_draw::hooks::DeliverError> {
        crate::messaging::deliver_to_page(page_id, note, by, i64::from(depth))
            .await
            .map(|out| out.get("delivered").and_then(Value::as_str).map(str::to_string))
            .map_err(deliver_error)
    }
}
