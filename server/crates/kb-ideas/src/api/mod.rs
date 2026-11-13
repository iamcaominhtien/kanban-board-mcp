//! The REST routes of this area: `api/idea_space.py` and `api/idea_tickets.py`, both under `/api/idea-tickets`.
//!
//! `main.py` includes `idea_space_router` first and `idea_tickets_router` second, and the two overlap:
//! `GET /api/idea-tickets/counts` matches the fixed path of the first router and `/{ticket_id}` of the second, and
//! `PATCH /api/idea-tickets/counts` matches the second only, with `ticket_id="counts"`. The routes are registered
//! here in `main.py`'s order, and the app's router takes the first one that matches the path and the method, as
//! Starlette does (`kb_base::routes`).

use axum::routing::{self, MethodRouter};
use kb_base::Routes;

pub mod idea_space;
mod idea_space_log;
pub mod idea_tickets;

/// One route of one of the two Python routers.
pub(crate) struct Entry {
    method: &'static str,
    path: &'static str,
    handler: MethodRouter,
}

/// A GET route.
pub(crate) fn get<H, T>(path: &'static str, handler: H) -> Entry
where
    H: axum::handler::Handler<T, ()>,
    T: 'static,
{
    Entry { method: "GET", path, handler: routing::get(handler) }
}

/// A POST route.
pub(crate) fn post<H, T>(path: &'static str, handler: H) -> Entry
where
    H: axum::handler::Handler<T, ()>,
    T: 'static,
{
    Entry { method: "POST", path, handler: routing::post(handler) }
}

/// A PATCH route.
pub(crate) fn patch<H, T>(path: &'static str, handler: H) -> Entry
where
    H: axum::handler::Handler<T, ()>,
    T: 'static,
{
    Entry { method: "PATCH", path, handler: routing::patch(handler) }
}

/// A PUT route.
pub(crate) fn put<H, T>(path: &'static str, handler: H) -> Entry
where
    H: axum::handler::Handler<T, ()>,
    T: 'static,
{
    Entry { method: "PUT", path, handler: routing::put(handler) }
}

/// A DELETE route.
pub(crate) fn delete<H, T>(path: &'static str, handler: H) -> Entry
where
    H: axum::handler::Handler<T, ()>,
    T: 'static,
{
    Entry { method: "DELETE", path, handler: routing::delete(handler) }
}

/// Every route of this area (the app merges them, in the order the Python app included its routers).
pub fn routes() -> Routes {
    // main.py: idea_space_router, then idea_tickets_router
    let mut routes = Routes::new();
    for entry in idea_space::entries().into_iter().chain(idea_tickets::entries()) {
        routes = routes.add(entry.method, entry.path, entry.handler);
    }
    routes
}
