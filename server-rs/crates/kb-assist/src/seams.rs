//! Places where the assistants meet the AI runs (`services/ai/runs.py`, ported in `kb-ai-run`, which `hooks::CoreRuns`
//! connects here from `register`). A slot that is not filled behaves as the Python call would on a board that has not
//! started its runs; each seam says which Python call it stands for.
//!
//! | seam | stands for | filled by |
//! |---|---|---|
//! | `Runs::url` | `ai_runs._url()` (`engine._run`: the board's URL for the turn's MCP config and `KANBAN_URL`) | `kb_ai_run::runs::url` |
//! | `Runs::to_dict` | `ai_runs.to_dict(run)` (`engine._finish`: the run in the `ai.run` event) | `kb_ai_run::runs::to_dict` |
//! | `Runs::deliver_to_ticket` | `await ai_runs.deliver_to_ticket(chat.scope_id, TEAM_NOTE.format(...), by=by)` (`chat.send`: a message in a ticket chat goes to the ticket's team) | `kb_ai_run::runs::deliver_to_ticket` |
//!
//! | `Runs::deliver_to_ticket_with` | `await ai_runs.deliver_to_ticket(ticket_id, note, by=by, trigger=trigger, depth=depth)` (`handoff.send`; `kb_draw::hooks::CanvasDelivery::deliver_to_ticket`) | `kb_ai_run::runs::deliver_to_ticket` |
//! | `Runs::deliver_to_page` | `await messaging.deliver_to_page(page_id, note, by=by, depth=depth)` (`kb_draw::hooks::CanvasDelivery::deliver_to_page`) | `kb_ai_run::messaging::deliver_to_page` |
//! | `Runs::wake_new_assignee` | `await ai_runs.wake_new_assignee(ticket_id, member_id, by=by, instruction=instruction)` (`kb_docs::hooks::AssignHook::wake_new_assignee`) | `kb_ai_run::runs::wake_new_assignee` |
//!
//! `store.active_runs` (`chat.ticket_team`, `chat.settle_team_messages`) is `kb_ai::store::active_runs`, called
//! directly.
//!
//! The modules of this task import nothing of `assistant.docs`, `assistant.editor`, `assistant.ideas` or
//! `services/docs_ai`; those are the next task and call into the modules here, not the other way round.

use std::sync::{Arc, RwLock};

use async_trait::async_trait;
use kb_db::entities::ai_run;
use serde_json::{Map, Value};

/// What `Runs::url` gives while the slot is empty: `RT.board_url or "http://127.0.0.1:8000"` of a board that has
/// not said where it listens.
pub const DEFAULT_BOARD_URL: &str = "http://127.0.0.1:8000";

/// Why `Runs::deliver_to_ticket` did not deliver.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum DeliverError {
    /// `runs.RunError` (a `ValueError`): the ticket is not there, or its team's run cannot start; the message is
    /// for the person.
    #[error("{0}")]
    Run(String),
    /// Any other exception of `runs.deliver_to_ticket`.
    #[error("{0}")]
    Other(String),
}

/// What the assistants ask of the runs (`services/ai/runs.py`), read-only except for the note to a ticket's team.
#[async_trait]
pub trait Runs: Send + Sync {
    /// `ai_runs._url()`: where the board listens (`RT.board_url or "http://127.0.0.1:8000"`).
    fn url(&self) -> String;
    /// `ai_runs.to_dict(run)`: a run as the API and the `ai.run` event show it.
    fn to_dict(&self, run: &ai_run::Model) -> Map<String, Value>;
    /// `await ai_runs.deliver_to_ticket(ticket_id, text, by=by)`: a note to the ticket's team (live when its lead
    /// runs, else a new turn on its conversation; a comment when the ticket has no team). Returns the dict of the
    /// Python call (`{delivered, run_id, ...}`).
    async fn deliver_to_ticket(&self, ticket_id: &str, text: &str, by: &str) -> Result<Value, DeliverError>;

    /// `await ai_runs.deliver_to_ticket(ticket_id, text, by=by, trigger=trigger, depth=depth)`: the same note with
    /// the trigger that tells the run why it was woken and the depth of the AI-to-AI hand-offs behind it. The
    /// default calls `deliver_to_ticket` and drops both.
    async fn deliver_to_ticket_with(
        &self,
        ticket_id: &str,
        text: &str,
        by: &str,
        _trigger: &str,
        _depth: i64,
    ) -> Result<Value, DeliverError> {
        self.deliver_to_ticket(ticket_id, text, by).await
    }

    /// `await messaging.deliver_to_page(page_id, note, by=by, depth=depth)`: a note to the assistant of a page
    /// (the `delivered` key of its answer is in the returned dict). The default says it is not connected.
    async fn deliver_to_page(
        &self,
        _page_id: &str,
        _note: &str,
        _by: &str,
        _depth: i64,
    ) -> Result<Value, DeliverError> {
        Err(DeliverError::Other("deliver_to_page is not connected".to_string()))
    }

    /// `await ai_runs.wake_new_assignee(ticket_id, member_id, by=by, instruction=instruction)`: the run it started
    /// as `(run id, state)`, if any. The default starts none.
    async fn wake_new_assignee(
        &self,
        _ticket_id: &str,
        _member_id: &str,
        _by: Option<&str>,
        _instruction: &str,
    ) -> Option<(String, String)> {
        None
    }
}

static RUNS: RwLock<Option<Arc<dyn Runs>>> = RwLock::new(None);

/// Fill the runs seam (a later call replaces the earlier one, which tests use).
pub fn set_runs(runs: Option<Arc<dyn Runs>>) {
    *RUNS.write().unwrap_or_else(|e| e.into_inner()) = runs;
}

/// The runs seam, when `runs` has been ported and connected.
pub fn runs() -> Option<Arc<dyn Runs>> {
    RUNS.read().unwrap_or_else(|e| e.into_inner()).clone()
}

/// `ai_runs._url()`, or `DEFAULT_BOARD_URL` while the slot is empty.
pub fn board_url() -> String {
    runs().map_or_else(|| DEFAULT_BOARD_URL.to_string(), |runs| runs.url())
}
