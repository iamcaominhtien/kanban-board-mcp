//! Calls this crate makes into code it cannot depend on: the tickets and the AI team. The Python code imports them
//! late, inside a function. The upper crate registers itself at startup; while a hook is not set the call is skipped
//! (or, for the ones that must give an answer, refused).
//!
//! The other direction: [`register`] gives `kb-draw` the Docs calls its canvases make (a canvas can be a Docs page).

use std::sync::OnceLock;

use async_trait::async_trait;
use kb_db::Session;
use serde_json::{Map, Value};

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

/// What `kb-draw` calls in `services/docs.py` and `services/docs_search.py` (`kb_draw::hooks::CanvasDocs`).
struct DocsForCanvases;

/// The error a canvas caller reads: a Docs error stays one, the rest is a failure of the call.
fn for_draw(err: crate::Error) -> kb_draw::Error {
    match err {
        crate::Error::Docs(e) => kb_draw::Error::Docs(e),
        crate::Error::Db(e) => kb_draw::Error::Db(e),
        crate::Error::Value(m) | crate::Error::Other(m) => kb_draw::Error::Value(m),
    }
}

#[async_trait]
impl kb_draw::hooks::CanvasDocs for DocsForCanvases {
    async fn check_page_edit(&self, session: &Session, page_id: &str) -> kb_draw::Result<()> {
        crate::docs::get_page(session, page_id, false, true).await.map(|_| ()).map_err(for_draw)
    }

    async fn reindex(&self, session: &Session, page_ids: &[String]) -> kb_draw::Result<()> {
        crate::docs_search::reindex(session, page_ids).await.map_err(kb_draw::Error::Db)
    }

    async fn create_page(
        &self,
        session: &Session,
        project_id: &str,
        title: &str,
        parent_id: Option<&str>,
    ) -> kb_draw::Result<Map<String, Value>> {
        crate::docs::create_page(session, project_id, title, parent_id, "blank", Some("")).await.map_err(for_draw)
    }

    async fn publish_page(
        &self,
        session: &Session,
        page_id: &str,
        base_version: i32,
        markdown: &str,
        note: &str,
    ) -> kb_draw::Result<()> {
        crate::docs::publish_page(session, page_id, i64::from(base_version), Some(note), Some(markdown), None)
            .await
            .map(|_| ())
            .map_err(for_draw)
    }
}

/// Register what this crate gives the crates below it (once, at startup; the app calls this): the Docs calls of
/// `kb-draw`'s canvases.
pub fn register() {
    kb_draw::hooks::set_canvas_docs(Box::new(DocsForCanvases));
}
