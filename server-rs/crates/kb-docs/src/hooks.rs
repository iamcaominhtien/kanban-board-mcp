//! Calls this crate makes into code it cannot depend on: later parts of Docs (comments, Docs AI), the canvases, the
//! tickets and the AI team. The Python code imports them late, inside a function. The upper crate registers itself
//! at startup; while a hook is not set the call is skipped (or, for the ones that must give an answer, refused).

use std::sync::OnceLock;

use async_trait::async_trait;
use kb_db::Session;
use kb_db::entities::docs_page;
use kb_db::sea_orm::DbErr;

/// `services/docs_comments.py`, which builds on `services/docs.py` (part 2 of the Docs port).
#[async_trait]
pub trait CommentsHook: Send + Sync {
    /// `docs_comments.delete_for_pages(session, ids)`: a hard delete of pages removes their threads.
    async fn delete_for_pages(&self, session: &Session, ids: &[String]) -> Result<(), DbErr>;

    /// `docs_comments.rematch_page(session, page, markdown)`: a new version moves the comment anchors.
    async fn rematch_page(&self, session: &Session, page: &docs_page::Model, markdown: &str) -> Result<(), DbErr>;
}

static COMMENTS: OnceLock<Box<dyn CommentsHook>> = OnceLock::new();

/// Register the comments (once, at startup; a second call is ignored).
pub fn set_comments_hook(hook: Box<dyn CommentsHook>) {
    let _ = COMMENTS.set(hook);
}

/// The comments, when they have registered themselves.
pub fn comments() -> Option<&'static dyn CommentsHook> {
    COMMENTS.get().map(|hook| hook.as_ref())
}

/// `services/canvases.py` (the canvases area, not ported yet), as far as Docs reads it.
#[async_trait]
pub trait CanvasesHook: Send + Sync {
    /// `[b["name"] for b in canvases.read_doc(canvas_id)["boards"]]`; `None` where Python raises (a missing file
    /// only means no sections).
    async fn board_names(&self, canvas_id: &str) -> Option<Vec<String>>;
}

static CANVASES: OnceLock<Box<dyn CanvasesHook>> = OnceLock::new();

/// Register the canvases (once, at startup; a second call is ignored).
pub fn set_canvases_hook(hook: Box<dyn CanvasesHook>) {
    let _ = CANVASES.set(hook);
}

/// The canvases, when their crate has registered itself.
pub fn canvases() -> Option<&'static dyn CanvasesHook> {
    CANVASES.get().map(|hook| hook.as_ref())
}

/// `services/ai/guard.py`: whether the current task acts for an AI run.
pub trait AiGuardHook: Send + Sync {
    /// `guard.current() is not None`.
    fn in_run(&self) -> bool;
}

static AI_GUARD: OnceLock<Box<dyn AiGuardHook>> = OnceLock::new();

/// Register the AI guard (once, at startup; a second call is ignored).
pub fn set_ai_guard_hook(hook: Box<dyn AiGuardHook>) {
    let _ = AI_GUARD.set(hook);
}

/// `_ai_acting()` of `services/docs.py`: whether an AI run makes the change (false while no hook is set).
pub fn ai_acting() -> bool {
    AI_GUARD.get().is_some_and(|hook| hook.in_run())
}

/// A ticket made for an assignment.
#[derive(Debug, Clone)]
pub struct TicketBrief {
    /// The ticket id (`KAN-12`).
    pub id: String,
    /// Its title.
    pub title: String,
}

/// The run `ai_runs.wake_new_assignee` started.
#[derive(Debug, Clone)]
pub struct RunBrief {
    /// The run id.
    pub id: String,
    /// Its state.
    pub state: String,
}

/// `services/tickets.py` and `services/ai/runs.py`, as `docs_work.assign_page` calls them. An `Err` is a
/// `ValueError` of the called function (the route answers 422 with its text).
#[async_trait]
pub trait AssignHook: Send + Sync {
    /// `svc_tickets.create_ticket(session, project_id=, title=, type="task", status="todo", description=,
    /// created_by=)`.
    async fn create_ticket(
        &self,
        session: &Session,
        project_id: &str,
        title: &str,
        description: &str,
        created_by: Option<&str>,
    ) -> Result<TicketBrief, String>;

    /// `svc_tickets.update_ticket(session, ticket_id, TicketUpdate(assignee=member_id))`.
    async fn assign(&self, session: &Session, ticket_id: &str, member_id: &str) -> Result<(), String>;

    /// `ai_runs.wake_new_assignee(ticket_id, member_id, by=, instruction=)`: the run it started, if any.
    async fn wake_new_assignee(
        &self,
        ticket_id: &str,
        member_id: &str,
        by: Option<&str>,
        instruction: &str,
    ) -> Option<RunBrief>;
}

static ASSIGN: OnceLock<Box<dyn AssignHook>> = OnceLock::new();

/// Register tickets and the AI team's runs (once, at startup; a second call is ignored).
pub fn set_assign_hook(hook: Box<dyn AssignHook>) {
    let _ = ASSIGN.set(hook);
}

/// Tickets and the AI team's runs, when their crates have registered themselves.
pub fn assign() -> Option<&'static dyn AssignHook> {
    ASSIGN.get().map(|hook| hook.as_ref())
}
