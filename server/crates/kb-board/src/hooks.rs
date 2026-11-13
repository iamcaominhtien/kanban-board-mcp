//! Calls into areas that are above this crate (the Python code imports them late, inside a function). The upper
//! crate registers itself at startup; while a hook is not set the call is skipped.

use std::path::Path;
use std::sync::OnceLock;

use async_trait::async_trait;
use kb_base::ApiResult;
use kb_db::Session;
use kb_db::entities::ticket;
use kb_db::sea_orm::DbErr;
use serde_json::{Map, Value};

/// The AI team (`services/ai/teams.py`), as far as the board calls it.
#[async_trait]
pub trait AiTeamsHook: Send + Sync {
    /// `teams.check_name(session, project_id, name, exclude_id)`: names are unique across people and teams in a
    /// project. Returns the dict of the Python function: `{ok, conflict, message, suggestion}`.
    async fn check_name(
        &self,
        session: &Session,
        project_id: &str,
        name: &str,
        exclude_id: Option<&str>,
    ) -> Result<Map<String, Value>, DbErr>;
}

static AI_TEAMS: OnceLock<Box<dyn AiTeamsHook>> = OnceLock::new();

/// Register the AI team (once, at startup; a second call is ignored).
pub fn set_ai_teams_hook(hook: Box<dyn AiTeamsHook>) {
    let _ = AI_TEAMS.set(hook);
}

/// The AI team, when its crate has registered itself.
pub fn ai_teams() -> Option<&'static dyn AiTeamsHook> {
    AI_TEAMS.get().map(|hook| hook.as_ref())
}

/// The copy code that moves a board between databases (`dbkit/move.py`'s `Mover`), as far as the data backup calls it
/// when PostgreSQL or MySQL is in use (the export is a SQLite copy of every table; an import replaces them).
#[async_trait]
pub trait DbMoveHook: Send + Sync {
    /// `Mover(db.current_target(), Target("sqlite", path=path))`: `plan()`, `prepare_target()`, `copy()`. Writes a
    /// SQLite file with every table of the database in use; the error is the message of the failure.
    async fn copy_current_to_sqlite(&self, path: &Path) -> Result<(), String>;

    /// `Mover(Target("sqlite", path=source), db.current_target())`: `plan()`, `prepare_target(empty_first=True)`,
    /// `copy()`. Replaces the data of the database in use with the tables of the SQLite file.
    async fn copy_sqlite_into_current(&self, source: &Path) -> Result<(), String>;
}

static DB_MOVE: OnceLock<Box<dyn DbMoveHook>> = OnceLock::new();

/// Register the database kit (once, at startup; a second call is ignored).
pub fn set_db_move_hook(hook: Box<dyn DbMoveHook>) {
    let _ = DB_MOVE.set(hook);
}

/// The database kit, when its crate has registered itself.
pub fn db_move() -> Option<&'static dyn DbMoveHook> {
    DB_MOVE.get().map(|hook| hook.as_ref())
}

/// `assignee=` of `ai_runs.before_ticket_change`: left out (`_UNSET`), or the new assignee (which may be none).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NewAssignee<'a> {
    /// The change does not touch the assignee.
    Unset,
    /// The ticket goes to this member, or to no one.
    To(Option<&'a str>),
}

/// The AI team's runs, worktrees and guard (`services/ai/runs.py`, `worktrees.py`, `guard.py`), as far as the ticket
/// code and its routes call them.
#[async_trait]
pub trait AiRunsHook: Send + Sync {
    /// `ai_runs.before_ticket_change(ticket_id, status=, assignee=, deleting=, by=)`: a person changes a ticket an AI
    /// may be working on; a deletion ends its runs, a reassignment away from the team ends them too.
    async fn before_ticket_change(
        &self,
        ticket_id: &str,
        status: Option<&str>,
        assignee: NewAssignee<'_>,
        deleting: bool,
        by: &str,
    ) -> ApiResult<()>;

    /// `ai_runs.note_person_edit(ticket_id, by=, what=, tell_lead=)`: a person edited the ticket while a lead works
    /// on it; the edit is recorded as a touch and, with `tell_lead`, the lead hears it.
    async fn note_person_edit(&self, ticket_id: &str, by: &str, what: &str, tell_lead: bool) -> ApiResult<()>;

    /// `ai_runs.wake_new_assignee(ticket_id, assignee_id, by=)`: a ticket was given to a team, its lead starts.
    async fn wake_new_assignee(&self, ticket_id: &str, assignee_id: &str, by: &str) -> ApiResult<()>;

    /// `ai_guard.current() is not None`: the current task acts for an AI run.
    fn in_run(&self) -> bool;

    /// `ai_worktrees.on_status(ticket_id, status, previous, by_ai=)`: the hand-over on a ticket's move (Review pushes
    /// and opens the draft PR, Done merges), started in the background.
    fn on_status(&self, ticket_id: &str, status: &str, previous: &str, by_ai: bool);
}

static AI_RUNS: OnceLock<Box<dyn AiRunsHook>> = OnceLock::new();

/// Register the AI team's runs (once, at startup; a second call is ignored).
pub fn set_ai_runs_hook(hook: Box<dyn AiRunsHook>) {
    let _ = AI_RUNS.set(hook);
}

/// The AI team's runs, when its crate has registered itself.
pub fn ai_runs() -> Option<&'static dyn AiRunsHook> {
    AI_RUNS.get().map(|hook| hook.as_ref())
}

/// Idea promotion (`services/idea_promote.py`), as far as the ticket code calls it. Neither function commits.
#[async_trait]
pub trait IdeaPromoteHook: Send + Sync {
    /// `idea_promote.on_ticket_status_change(session, ticket, previous_status)`: the idea promoted to this ticket
    /// (and any assumption it tests) follows the status change. `ticket` is the ticket as it is now stored.
    async fn on_ticket_status_change(
        &self,
        session: &Session,
        ticket: &ticket::Model,
        previous_status: &str,
    ) -> Result<(), DbErr>;

    /// `idea_promote.on_ticket_deleted(session, ticket)`: the ticket's idea goes back to Ready with the link cleared.
    async fn on_ticket_deleted(&self, session: &Session, ticket: &ticket::Model) -> Result<(), DbErr>;
}

static IDEA_PROMOTE: OnceLock<Box<dyn IdeaPromoteHook>> = OnceLock::new();

/// Register idea promotion (once, at startup; a second call is ignored).
pub fn set_idea_promote_hook(hook: Box<dyn IdeaPromoteHook>) {
    let _ = IDEA_PROMOTE.set(hook);
}

/// Idea promotion, when its crate has registered itself.
pub fn idea_promote() -> Option<&'static dyn IdeaPromoteHook> {
    IDEA_PROMOTE.get().map(|hook| hook.as_ref())
}
