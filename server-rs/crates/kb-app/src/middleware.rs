//! The four middlewares of the app (`main.py`).

use std::time::{Duration, Instant};

use axum::Json;
use axum::extract::{ConnectInfo, Request};
use axum::http::{Method, StatusCode};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use serde_json::{Map, Value, json};

use kb_base::error::DbFailure;
use kb_base::{activity, api_secret, ctx};
use kb_db::database;
use kb_files::drawio_bundle;

use crate::LocalAddr;

const DB_FREE_PATHS: [&str; 8] =
    ["/database", "/version", "/settings", "/events", "/logs", "/mcp-clients", "/assets", "/drawio"];

fn unreachable_response(state: Map<String, Value>) -> Response {
    let mut detail = Map::new();
    detail.insert("code".into(), json!("database_unreachable"));
    detail.extend(state);
    (StatusCode::SERVICE_UNAVAILABLE, Json(json!({"detail": detail}))).into_response()
}

fn looks_like_a_lost_connection(message: &str) -> bool {
    let text = message.to_lowercase();
    ["connection", "timed out", "pool", "io error", "broken pipe"].iter().any(|word| text.contains(word))
}

/// While the database does not answer, every request that needs it gets one quick 503 the app turns into its
/// reconnect screen, instead of waiting for a connection timeout each.
pub async fn database_unreachable(request: Request, next: Next) -> Response {
    let path = request.uri().path().to_string();
    // the app's own files (the built UI) need no database
    let is_file = path.rsplit('/').next().is_some_and(|last| last.contains('.'));
    if let Some(state) = database::unreachable() {
        if !is_file && !DB_FREE_PATHS.iter().any(|p| path.starts_with(p)) {
            let wants_html = request
                .headers()
                .get("accept")
                .and_then(|v| v.to_str().ok())
                .is_some_and(|accept| accept.starts_with("text/html"));
            if path == "/" || wants_html {
                return next.run(request).await;
            }
            return unreachable_response(state);
        }
    }
    let response = next.run(request).await;
    if let Some(DbFailure(message)) = response.extensions().get::<DbFailure>() {
        if !database::is_sqlite() && looks_like_a_lost_connection(message) {
            database::check_reachable(Duration::from_secs(3)).await;
            if let Some(state) = database::unreachable() {
                return unreachable_response(state);
            }
        }
    }
    response
}

/// Refuse a request that changes something unless it comes with the secret the desktop app gave its window
/// (`api_secret`). Nothing is checked when the server was not started by the app.
pub async fn require_the_apps_secret(request: Request, next: Next) -> Response {
    let given = request.headers().get(api_secret::HEADER).and_then(|v| v.to_str().ok());
    if request.method() != Method::OPTIONS
        && !api_secret::allows(request.method().as_str(), request.uri().path(), given)
    {
        return (StatusCode::FORBIDDEN, Json(json!({"detail": api_secret::refusal(request.uri().path())})))
            .into_response();
    }
    next.run(request).await
}

/// Attribute REST calls to the board user, or to `X-Actor` when the header is sent. Each request runs with a
/// context of its own (`kb_base::ctx`).
pub async fn record_activity_actor(request: Request, next: Next) -> Response {
    if let Some(ConnectInfo(LocalAddr(server))) = request.extensions().get::<ConnectInfo<LocalAddr>>() {
        if server.ip().is_loopback() {
            // A local runner's CLI reaches the board's MCP server on the same socket
            // ai_runs.set_board_url: wired when kb-ai is ported
            drawio_bundle::set_origin(&server.ip().to_string(), server.port());
        }
    }
    // read the headers first: a borrow of the request must not live across the await
    let (actor, origin) = {
        let header = |name: &str| {
            // Starlette decodes header bytes as latin-1, so a name with an accent is kept (as its latin-1 reading)
            let text: Option<String> =
                request.headers().get(name).map(|v| v.as_bytes().iter().map(|b| *b as char).collect());
            text.map(|v| kb_base::pytext::strip(&v).to_string()).unwrap_or_default()
        };
        (header("x-actor").chars().take(80).collect::<String>(), header("x-origin"))
    };
    ctx::scope(async move {
        let token = activity::set_actor(Some(if actor.is_empty() { activity::HUMAN_ACTOR } else { &actor }));
        let origin_token = activity::set_origin(Some(origin.as_str()));
        let response = next.run(request).await;
        ctx::reset(origin_token);
        ctx::reset(token);
        response
    })
    .await
}

/// FastAPI answers HEAD with 405 (its routes list GET only, so `Allow` is `GET`) and names no `HEAD` in the `Allow`
/// of any 405; axum answers HEAD for every GET route, so the difference is put back here, next to the routes.
pub async fn starlette_methods(request: Request, next: Next) -> Response {
    // (the MCP endpoint is a mounted app in Python: it answers every method itself)
    if request.method() == Method::HEAD && !request.uri().path().starts_with("/mcp/") {
        return crate::method_not_allowed_for("GET");
    }
    let mut response = next.run(request).await;
    if response.status() == StatusCode::METHOD_NOT_ALLOWED {
        let allow = response.headers().get(axum::http::header::ALLOW).and_then(|v| v.to_str().ok()).map(str::to_string);
        if let Some(allow) = allow {
            let methods: Vec<&str> = allow.split(',').map(str::trim).filter(|m| *m != "HEAD").collect();
            if let Ok(value) = axum::http::HeaderValue::from_str(&methods.join(", ")) {
                response.headers_mut().insert(axum::http::header::ALLOW, value);
            }
        }
    }
    response
}

/// Log failed requests (4xx at WARNING, 5xx at ERROR) with timing.
pub async fn log_requests(request: Request, next: Next) -> Response {
    let started = Instant::now();
    let method = request.method().clone();
    let path = request.uri().path().to_string();
    let response = next.run(request).await;
    let status = response.status().as_u16();
    if status >= 500 {
        tracing::error!(target: "kanban.http", "{method} {path} -> {status} ({}ms)", started.elapsed().as_millis());
    } else if status >= 400 {
        tracing::warn!(target: "kanban.http", "{method} {path} -> {status} ({}ms)", started.elapsed().as_millis());
    }
    response
}
