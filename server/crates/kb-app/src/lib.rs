//! The server as one app: every area's routes, the middlewares, the event stream and what runs for the app's
//! lifetime (the port of the Python `main.py`).

pub mod cors;
pub mod files;
pub mod hooks;
pub mod lifespan;
pub mod middleware;
pub mod port_choice;
pub mod sse;
pub mod stdio;

use std::time::Instant;

use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::{Json, Router};
use serde_json::{Value, json};

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
    // in the order `main.py` registers them (the first route that matches a path wins): the draw.io editor, the
    // areas' routers, the app's own routes, and the static UI last, so that every other route wins
    Routes::new()
        // the MCP endpoint is mounted first in the Python app
        .merge(kb_mcp::routes())
        .merge(files::drawio_routes())
        .merge(kb_board::api::routes())
        .merge(kb_skills::api::routes())
        .merge(kb_notify::api::routes())
        .merge(kb_dbkit::api::routes())
        .merge(kb_ideas::api::routes())
        .merge(kb_docs::api::routes())
        .merge(kb_draw::api::routes())
        .merge(kb_ai::api::routes())
        .merge(kb_ai_api::api::routes())
        .merge(kb_assist::api::routes())
        .get("/health", health)
        .get("/version", version)
        .merge(files::upload_routes())
        .get("/events", sse::sse_events)
        .merge(files::ui_routes())
}

/// FastAPI's 405: `{"detail": "Method Not Allowed"}` and the methods of the route in `Allow`.
pub(crate) fn method_not_allowed_for(allow: &str) -> Response {
    let mut response = (StatusCode::METHOD_NOT_ALLOWED, Json(json!({"detail": "Method Not Allowed"}))).into_response();
    if let Ok(value) = axum::http::HeaderValue::from_str(allow) {
        response.headers_mut().insert(axum::http::header::ALLOW, value);
    }
    response
}

/// The app: routes, fallbacks and the middlewares in the order the Python app ran them (outermost first: request
/// logging, the actor, the app's secret, the unreachable-database answer, CORS, and the HTTP methods of FastAPI next to
/// the routes).
pub fn app() -> Router {
    let (router, _table) = routes().into_parts();
    // (the router picks the route as Starlette does and answers 404 and 405 itself: `kb_base::routes`)
    // The middlewares wrap the whole router (not each route: axum adds the `Allow` header of a 405 outside a route's
    // own layers), first the outermost.
    let stack = tower::ServiceBuilder::new()
        .layer(axum::middleware::from_fn(middleware::log_requests))
        .layer(axum::middleware::from_fn(middleware::record_activity_actor))
        .layer(axum::middleware::from_fn(middleware::require_the_apps_secret))
        .layer(axum::middleware::from_fn(middleware::database_unreachable))
        .layer(axum::middleware::from_fn(cors::cors))
        .layer(axum::middleware::from_fn(middleware::starlette_methods))
        .service(router);
    Router::new().fallback_service(stack)
}

/// The address of the socket a request came in on (the server's own address, as the ASGI `scope["server"]`): the
/// actor middleware tells the draw.io bundle which local address the board answers on.
#[derive(Debug, Clone, Copy)]
pub struct LocalAddr(pub std::net::SocketAddr);

/// The board's listener: every connection it accepts sends without delay (`TCP_NODELAY`). Without it an answer
/// written in more than one piece (the MCP answers, written as a server-sent event) waited for the client's delayed
/// acknowledgement: about 40 ms on every call.
pub struct BoardListener(tokio::net::TcpListener);

impl axum::serve::Listener for BoardListener {
    type Io = tokio::net::TcpStream;
    type Addr = std::net::SocketAddr;

    async fn accept(&mut self) -> (Self::Io, Self::Addr) {
        let (io, addr) = axum::serve::Listener::accept(&mut self.0).await;
        if let Err(err) = io.set_nodelay(true) {
            tracing::debug!("TCP_NODELAY could not be set on a connection: {err}");
        }
        (io, addr)
    }

    fn local_addr(&self) -> std::io::Result<Self::Addr> {
        self.0.local_addr()
    }
}

impl axum::extract::connect_info::Connected<axum::serve::IncomingStream<'_, BoardListener>> for LocalAddr {
    fn connect_info(stream: axum::serve::IncomingStream<'_, BoardListener>) -> Self {
        LocalAddr(stream.io().local_addr().unwrap_or_else(|_| std::net::SocketAddr::from(([127, 0, 0, 1], 0))))
    }
}

/// Print one startup stage with the time since `t0` (the desktop app shows these in its own log).
pub fn startup_mark(t0: Instant, stage: &str) {
    println!("[startup] {stage} +{}ms", t0.elapsed().as_millis());
}

/// Serve the app on `listener` until the process is asked to stop; prints `READY port=N` once it is listening.
pub async fn serve(listener: std::net::TcpListener, t0: Instant) -> std::io::Result<()> {
    let port = listener.local_addr()?.port();
    listener.set_nonblocking(true)?;
    let listener = BoardListener(tokio::net::TcpListener::from_std(listener)?);
    // `ai_runs.set_board_url(os.environ["KANBAN_BOARD_URL"])` of `main.py`, which runs before the app starts: a run
    // recovered at startup must already know where the board listens
    kb_ai_run::runs::set_board_url(&format!("http://127.0.0.1:{port}"));
    let running = lifespan::startup().await.map_err(std::io::Error::other)?;
    let app = app();
    startup_mark(t0, "server-startup-done");
    kb_files::drawio_bundle::set_origin("127.0.0.1", port);
    println!("READY port={port}");
    let served = axum::serve(listener, app.into_make_service_with_connect_info::<LocalAddr>())
        .with_graceful_shutdown(lifespan::stop_signal())
        .await;
    lifespan::shutdown(running).await;
    served
}
