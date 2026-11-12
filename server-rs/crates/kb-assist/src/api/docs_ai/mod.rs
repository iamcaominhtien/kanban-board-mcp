//! `api/docs_ai/`: the Docs AI API, one router assembled from a module per feature (`settings`, `ask`, `page`,
//! `write`, `threads`, `health`, `tickets`, in that order: `router.include_router` of `__init__.py`).
//!
//! Every endpoint is gated by `settings::require_enabled`, except the settings themselves. A `DocsAiError` answers
//! `{"detail": message, "code": …}` with the status the code maps to (see `api::Failure`).

use kb_base::Routes;

pub mod ask;
pub mod health;
pub mod page;
pub mod settings;
pub mod threads;
pub mod tickets;
pub mod write;

/// The routes of `docs_ai_router`, in the order of its modules.
pub fn routes() -> Routes {
    Routes::new()
        .merge(settings::routes())
        .merge(ask::routes())
        .merge(page::routes())
        .merge(write::routes())
        .merge(threads::routes())
        .merge(health::routes())
        .merge(tickets::routes())
}
