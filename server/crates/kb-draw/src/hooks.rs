//! Calls into areas that are above this crate (the Python code imports them late, inside a function). The upper
//! crate registers itself at startup; while a hook is not set the call is skipped.

use std::sync::OnceLock;

use async_trait::async_trait;
use kb_db::Session;
use serde_json::{Map, Value};

/// `services/docs.py` and `services/docs_search.py`, as the canvases call them (a canvas can be a Docs page).
#[async_trait]
pub trait CanvasDocs: Send + Sync {
    /// `docs.get_page(session, page_id, edit=True)`: fails when the page's space does not let the caller edit.
    async fn check_page_edit(&self, session: &Session, page_id: &str) -> crate::Result<()>;
    /// `docs_search.reindex(session, page_ids)`.
    async fn reindex(&self, session: &Session, page_ids: &[String]) -> crate::Result<()>;
    /// `docs.create_page(session, project_id, title, parent_id=parent_id, markdown="")`: the page as the API
    /// returns it.
    async fn create_page(
        &self,
        session: &Session,
        project_id: &str,
        title: &str,
        parent_id: Option<&str>,
    ) -> crate::Result<Map<String, Value>>;
    /// `docs.publish_page(session, page_id, base_version=base_version, markdown=markdown, note=note)`.
    async fn publish_page(
        &self,
        session: &Session,
        page_id: &str,
        base_version: i32,
        markdown: &str,
        note: &str,
    ) -> crate::Result<()>;
}

static CANVAS_DOCS: OnceLock<Box<dyn CanvasDocs>> = OnceLock::new();

/// Register the Docs code (once, at startup; a second call is ignored).
pub fn set_canvas_docs(hook: Box<dyn CanvasDocs>) {
    let _ = CANVAS_DOCS.set(hook);
}

/// The Docs code, when its crate has registered itself.
pub fn canvas_docs() -> Option<&'static dyn CanvasDocs> {
    CANVAS_DOCS.get().map(|hook| hook.as_ref())
}

/// Why handing a note to an AI team failed (`services/canvas_delivery.py` tells the cases apart).
#[derive(Debug, Clone)]
pub enum DeliverError {
    /// `RunError`: a team that waits for a person, a run that cannot start. The text is shown as the reason.
    Run(String),
    /// `ValueError`: the note could not be left on the page. The text is shown as the reason.
    Value(String),
    /// Any other exception: logged, and the reason is the generic one.
    Other(String),
}

/// `services/assistant/docs.py` and `services/ai/messaging.py`, as `canvas_delivery` calls them (late imports there).
#[async_trait]
pub trait CanvasDelivery: Send + Sync {
    /// `assistant_docs.docs_ai_on(session, project_id)`: whether the Docs assistant is on and ready.
    async fn docs_ai_on(&self, session: &Session, project_id: &str) -> crate::Result<bool>;
    /// `messaging.deliver_to_ticket(ticket_id, note, by=by, trigger=trigger, depth=depth)`.
    async fn deliver_to_ticket(
        &self,
        ticket_id: &str,
        note: &str,
        by: &str,
        trigger: &str,
        depth: i32,
    ) -> Result<(), DeliverError>;
    /// `messaging.deliver_to_page(page_id, note, by=by, depth=depth)`: the `delivered` key of its answer.
    async fn deliver_to_page(
        &self,
        page_id: &str,
        note: &str,
        by: &str,
        depth: i32,
    ) -> Result<Option<String>, DeliverError>;
}

static CANVAS_DELIVERY: OnceLock<Box<dyn CanvasDelivery>> = OnceLock::new();

/// Register the AI team and assistant code (once, at startup; a second call is ignored).
pub fn set_canvas_delivery(hook: Box<dyn CanvasDelivery>) {
    let _ = CANVAS_DELIVERY.set(hook);
}

/// The AI team and assistant code, when its crate has registered itself.
pub fn canvas_delivery() -> Option<&'static dyn CanvasDelivery> {
    CANVAS_DELIVERY.get().map(|hook| hook.as_ref())
}
