//! The server as one app: every area's routes, the middlewares, the event stream and what runs for the app's
//! lifetime (the port of the Python `main.py`).

pub mod lifespan;
pub mod middleware;
pub mod sse;

use std::time::Instant;

use axum::http::{Method, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::{Json, Router};
use serde_json::{Value, json};
use tower_http::cors::{Any, CorsLayer};

use kb_base::Routes;

/// `GET /health`: report liveness.
async fn health() -> Json<Value> {
    Json(json!({"status": "ok"}))
}

/// `GET /version`: server version and the oldest UI build it supports (no auth, like /health).
async fn version() -> Json<Value> {
    Json(kb_base::version::version_info())
}

/// Every REST route of the server, with the table of what they are.
pub fn routes() -> Routes {
    // the areas, in the order the Python app included its routers (the first route that matches a path wins)
    Routes::new()
        .merge(kb_board::api::routes())
        .merge(kb_notify::api::routes())
        .merge(kb_dbkit::api::routes())
        .merge(kb_ideas::api::routes())
        .merge(kb_docs::api::routes())
        .merge(kb_draw::api::routes())
        .merge(kb_ai::api::routes())
        .merge(kb_assist::api::routes())
        .get("/health", health)
        .get("/version", version)
        .get("/events", sse::sse_events)
}

async fn not_found() -> Response {
    (StatusCode::NOT_FOUND, Json(json!({"detail": "Not Found"}))).into_response()
}

async fn method_not_allowed() -> Response {
    (StatusCode::METHOD_NOT_ALLOWED, Json(json!({"detail": "Method Not Allowed"}))).into_response()
}

/// The app: routes, fallbacks and the middlewares in the order the Python app ran them (the last one added is the
/// outermost: request logging, then the actor, the app's secret, the unreachable-database answer, and CORS next to
/// the routes).
pub fn app() -> Router {
    let (router, _table) = routes().into_parts();
    let cors = CorsLayer::new()
        // Wildcard is safe: the server binds to 127.0.0.1 (loopback only), so it is not reachable from external
        // networks.
        .allow_origin(Any)
        .allow_methods([Method::GET, Method::POST, Method::PUT, Method::PATCH, Method::DELETE, Method::OPTIONS])
        .expose_headers([header::HeaderName::from_static("x-request-id")])
        .allow_headers([
            header::CONTENT_TYPE,
            header::AUTHORIZATION,
            header::ACCEPT,
            header::HeaderName::from_static("x-requested-with"),
            header::HeaderName::from_static("last-event-id"),
            header::HeaderName::from_static("x-request-id"),
            header::HeaderName::from_static("x-actor"),
            header::HeaderName::from_static("x-kanban-secret"),
        ])
        .max_age(std::time::Duration::from_secs(600));
    router
        .fallback(not_found)
        .method_not_allowed_fallback(method_not_allowed)
        .layer(cors)
        .layer(axum::middleware::from_fn(middleware::database_unreachable))
        .layer(axum::middleware::from_fn(middleware::require_the_apps_secret))
        .layer(axum::middleware::from_fn(middleware::record_activity_actor))
        .layer(axum::middleware::from_fn(middleware::log_requests))
}

/// Print one startup stage with the time since `t0` (the desktop app shows these in its own log).
pub fn startup_mark(t0: Instant, stage: &str) {
    println!("[startup] {stage} +{}ms", t0.elapsed().as_millis());
}

/// Serve the app on `listener` until the process is asked to stop; prints `READY port=N` once it is listening.
pub async fn serve(listener: std::net::TcpListener, t0: Instant) -> std::io::Result<()> {
    let port = listener.local_addr()?.port();
    listener.set_nonblocking(true)?;
    let listener = tokio::net::TcpListener::from_std(listener)?;
    let running = lifespan::startup().await.map_err(std::io::Error::other)?;
    let app = app();
    startup_mark(t0, "server-startup-done");
    println!("READY port={port}");
    let served = axum::serve(listener, app).with_graceful_shutdown(lifespan::stop_signal()).await;
    lifespan::shutdown(running).await;
    served
}
