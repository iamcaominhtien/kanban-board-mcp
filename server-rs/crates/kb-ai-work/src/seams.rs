//! Places where this crate's modules call AI-team modules that a later task ports (`runs`). Python imports those
//! late, inside a function; here each call goes through a slot the later task fills. A slot that is not filled
//! behaves as the Python call would on a board where nothing could be started: nothing was delivered.
//!
//! | seam | stands for | filled by |
//! |---|---|---|
//! | `Runs::deliver_to_ticket` | `runs.deliver_to_ticket(ticket_id, text, by=, trigger=)` (`github.back_to_dev`, `github.comments_to_dev`) | `runs` |
//!
//! The hand-over hooks of `worktrees` (`on_review`, `merge`) have a second kind of slot, `worktrees::set_handover`,
//! which the Python tests fill by monkeypatching `worktrees.on_review` / `worktrees.merge`; it is empty in the app.

use std::sync::{Arc, RwLock};

use async_trait::async_trait;
use serde_json::Value;

/// What the GitHub watcher asks of the runs' module.
#[async_trait]
pub trait Runs: Send + Sync {
    /// `runs.deliver_to_ticket(ticket_id, text, by=by, trigger=trigger)`: give `text` to the AI working on the ticket
    /// (a running one gets it as a message, else a run starts). The dict it returns holds `run_id` (a run that was
    /// started or reached) and `delivered` (how); the error is the text of the exception Python would raise.
    async fn deliver_to_ticket(&self, ticket_id: &str, text: &str, by: &str, trigger: &str) -> Result<Value, String>;
}

static RUNS: RwLock<Option<Arc<dyn Runs>>> = RwLock::new(None);

/// Fill the runs seam (a later call replaces the earlier one, which tests use).
pub fn set_runs(runs: Option<Arc<dyn Runs>>) {
    *RUNS.write().unwrap_or_else(|e| e.into_inner()) = runs;
}

/// The runs seam, when `runs` has been ported and registered.
pub fn runs() -> Option<Arc<dyn Runs>> {
    RUNS.read().unwrap_or_else(|e| e.into_inner()).clone()
}
