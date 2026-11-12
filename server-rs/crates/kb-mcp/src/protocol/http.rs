//! Streamable HTTP, stateless: the transport of `app.mount("/mcp", mcp.streamable_http_app())` with
//! `stateless_http=True` and `streamable_http_path="/"`.
//!
//! Every request stands alone (no session id is given or checked). A JSON-RPC request is answered `200` with an
//! event stream holding one `message` event; a notification or a response `202` with no body; everything else with
//! the SDK's own refusals, in the SDK's order of checks:
//!
//! 1. the DNS-rebinding guard FastMCP turns on for a local server: a POST must say `Content-Type:
//!    application/json…` (400), `Host` must be a local name with a port (421), `Origin`, when sent, a local `http`
//!    origin with a port (403); these three answer in plain text;
//! 2. POST: `Accept` must name both `application/json` and `text/event-stream` (406), `Content-Type` must be exactly
//!    `application/json` before any parameter (415), the body must be JSON (400, Python's own parse message) and a
//!    JSON-RPC message (400, Pydantic's text); except for `initialize`, a `mcp-protocol-version` header must name a
//!    version the SDK knows (400);
//! 3. GET opens the stream for messages from the server (there are none: it only carries keep-alive comments)
//!    when `Accept` names `text/event-stream` (else 406); DELETE is refused (405: no session to end); any other
//!    method is a 405 with `Allow`.
//!
//! A path below `/mcp/` is Starlette's plain `Not Found`.

use std::convert::Infallible;
use std::time::Duration;

use axum::body::{Body, Bytes};
use axum::extract::Request;
use axum::http::{HeaderMap, Method, StatusCode, header};
use axum::response::Response;
use futures::stream;
use serde_json::{Value, json};

use kb_base::{Routes, ctx};

use super::message::{self, Incoming};
use super::{
    DEFAULT_NEGOTIATED_VERSION, INVALID_PARAMS, INVALID_REQUEST, PARSE_ERROR, SUPPORTED_PROTOCOL_VERSIONS,
    json_errors,
};
use crate::common::RequestAuthorization;
use crate::pydantic::format_errors;

const CONTENT_TYPE_JSON: &str = "application/json";
const CONTENT_TYPE_SSE: &str = "text/event-stream";
/// `sse_starlette`'s default interval between keep-alive comments.
const PING_INTERVAL: Duration = Duration::from_secs(15);
/// The largest body read (a request is a JSON-RPC message; Starlette itself has no limit).
const MAX_BODY: usize = 256 * 1024 * 1024;

/// The methods a mounted app is given. (Starlette's `Mount` passes every method on; a method outside this list is
/// answered by the app's router instead, with its own 405.)
const METHODS: [&str; 8] = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS", "TRACE"];

/// The MCP endpoint, for the app to merge **before** every other route (it is the first route of the Python app):
/// `/mcp/` and everything below it, for every method. `/mcp` without the slash is not part of it.
pub fn routes() -> Routes {
    let mut routes = Routes::new();
    for method in METHODS {
        routes = routes
            .hidden(method, "/mcp/", axum::routing::any(endpoint))
            .hidden(method, "/mcp/{rest:path}", axum::routing::any(not_found));
    }
    routes
}

/// Starlette's answer of the mounted app for a path it has no route for.
async fn not_found() -> Response {
    plain(StatusCode::NOT_FOUND, "Not Found", Some("text/plain; charset=utf-8"))
}

fn plain(status: StatusCode, text: &'static str, content_type: Option<&'static str>) -> Response {
    let mut builder = Response::builder().status(status);
    if let Some(content_type) = content_type {
        builder = builder.header(header::CONTENT_TYPE, content_type);
    }
    builder.body(Body::from(text)).unwrap_or_default()
}

/// `_create_error_response`: a JSON-RPC error without a request id.
fn error_response(status: StatusCode, message: &str, code: i64, allow: Option<&'static str>) -> Response {
    let body = super::error(&json!("server-error"), code, message, None);
    let mut builder = Response::builder().status(status).header(header::CONTENT_TYPE, CONTENT_TYPE_JSON);
    if let Some(allow) = allow {
        builder = builder.header(header::ALLOW, allow);
    }
    builder.body(Body::from(body.to_string())).unwrap_or_default()
}

/// A header as Starlette reads it: the first one of that name, its bytes as latin-1.
fn header_text(headers: &HeaderMap, name: &str) -> Option<String> {
    headers.get(name).map(|value| value.as_bytes().iter().map(|b| *b as char).collect())
}

/// `TransportSecurityMiddleware.validate_request` with the settings FastMCP gives a server on `127.0.0.1`.
fn security_refusal(headers: &HeaderMap, is_post: bool) -> Option<Response> {
    if is_post {
        let content_type = header_text(headers, "content-type").unwrap_or_default();
        if !content_type.to_lowercase().starts_with(CONTENT_TYPE_JSON) {
            return Some(plain(StatusCode::BAD_REQUEST, "Invalid Content-Type header", None));
        }
    }
    let host = header_text(headers, "host").unwrap_or_default();
    if !["127.0.0.1:", "localhost:", "[::1]:"].iter().any(|allowed| host.starts_with(allowed)) {
        tracing::warn!(target: "mcp.server.transport_security", "Invalid Host header: {host}");
        return Some(plain(StatusCode::MISDIRECTED_REQUEST, "Invalid Host header", None));
    }
    if let Some(origin) = header_text(headers, "origin").filter(|origin| !origin.is_empty()) {
        let allowed = ["http://127.0.0.1:", "http://localhost:", "http://[::1]:"];
        if !allowed.iter().any(|allowed| origin.starts_with(allowed)) {
            tracing::warn!(target: "mcp.server.transport_security", "Invalid Origin header: {origin}");
            return Some(plain(StatusCode::FORBIDDEN, "Invalid Origin header", None));
        }
    }
    None
}

/// `_check_accept_headers`: whether `Accept` names JSON, and the event stream.
fn accepts(headers: &HeaderMap) -> (bool, bool) {
    let accept = header_text(headers, "accept").unwrap_or_default();
    let types: Vec<&str> = accept.split(',').map(kb_base::pytext::strip).collect();
    (types.iter().any(|t| t.starts_with(CONTENT_TYPE_JSON)), types.iter().any(|t| t.starts_with(CONTENT_TYPE_SSE)))
}

/// `_validate_protocol_version`: the refusal for a `mcp-protocol-version` header the SDK does not know.
fn protocol_version_refusal(headers: &HeaderMap) -> Option<Response> {
    let version = header_text(headers, "mcp-protocol-version").unwrap_or_else(|| DEFAULT_NEGOTIATED_VERSION.to_string());
    if SUPPORTED_PROTOCOL_VERSIONS.contains(&version.as_str()) {
        return None;
    }
    let message = format!(
        "Bad Request: Unsupported protocol version: {version}. Supported versions: {}",
        SUPPORTED_PROTOCOL_VERSIONS.join(", ")
    );
    Some(error_response(StatusCode::BAD_REQUEST, &message, INVALID_REQUEST, None))
}

/// The head of an event-stream reply, as `sse_starlette` sends it for the SDK.
fn event_stream(body: Body) -> Response {
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CACHE_CONTROL, "no-cache, no-transform")
        .header(header::CONNECTION, "keep-alive")
        .header(header::CONTENT_TYPE, CONTENT_TYPE_SSE)
        .header("x-accel-buffering", "no")
        .body(body)
        .unwrap_or_default()
}

/// One `message` event (`sse_starlette` ends lines with CR LF).
fn message_event(message: &Value) -> Bytes {
    Bytes::from(format!("event: message\r\ndata: {message}\r\n\r\n"))
}

/// The keep-alive comment `sse_starlette` sends every 15 seconds while a stream is open.
fn ping_event() -> Bytes {
    let now = chrono::Utc::now().format("%Y-%m-%d %H:%M:%S%.6f+00:00");
    Bytes::from(format!(": ping - {now}\r\n\r\n"))
}

/// Stops the work behind a reply when the client goes away (the SDK cancels a request whose transport closed).
struct AbortOnDrop<T>(tokio::task::JoinHandle<T>);

impl<T> Drop for AbortOnDrop<T> {
    fn drop(&mut self) {
        self.0.abort();
    }
}

/// `/mcp/`, any method.
async fn endpoint(request: Request) -> Response {
    let method = request.method().clone();
    let headers = request.headers().clone();
    if let Some(refusal) = security_refusal(&headers, method == Method::POST) {
        return refusal;
    }
    if method == Method::POST {
        return post(headers, request).await;
    }
    if method == Method::GET {
        return get(&headers);
    }
    if method == Method::DELETE {
        let message = "Method Not Allowed: Session termination not supported";
        return error_response(StatusCode::METHOD_NOT_ALLOWED, message, INVALID_REQUEST, None);
    }
    error_response(StatusCode::METHOD_NOT_ALLOWED, "Method Not Allowed", INVALID_REQUEST, Some("GET, POST, DELETE"))
}

/// `_handle_get_request`: the stream for what the server would send on its own. It has nothing to send, so the
/// stream only carries the keep-alive comments until the client closes it.
fn get(headers: &HeaderMap) -> Response {
    if !accepts(headers).1 {
        let message = "Not Acceptable: Client must accept text/event-stream";
        return error_response(StatusCode::NOT_ACCEPTABLE, message, INVALID_REQUEST, None);
    }
    if let Some(refusal) = protocol_version_refusal(headers) {
        return refusal;
    }
    let pings = stream::unfold((), |()| async {
        tokio::time::sleep(PING_INTERVAL).await;
        Some((Ok::<_, Infallible>(ping_event()), ()))
    });
    event_stream(Body::from_stream(pings))
}

/// `_handle_post_request`.
async fn post(headers: HeaderMap, request: Request) -> Response {
    let (has_json, has_sse) = accepts(&headers);
    if !(has_json && has_sse) {
        let message = "Not Acceptable: Client must accept both application/json and text/event-stream";
        return error_response(StatusCode::NOT_ACCEPTABLE, message, INVALID_REQUEST, None);
    }
    // `_check_content_type`: the media type itself, exactly, before any parameter
    let content_type = header_text(&headers, "content-type").unwrap_or_default();
    let media_types = content_type.split(';').next().unwrap_or_default();
    if !media_types.split(',').any(|part| kb_base::pytext::strip(part) == CONTENT_TYPE_JSON) {
        let message = "Unsupported Media Type: Content-Type must be application/json";
        return error_response(StatusCode::UNSUPPORTED_MEDIA_TYPE, message, INVALID_REQUEST, None);
    }
    let body = match axum::body::to_bytes(request.into_body(), MAX_BODY).await {
        Ok(body) => body,
        Err(err) => {
            let message = format!("Error handling POST request: {err}");
            return error_response(StatusCode::INTERNAL_SERVER_ERROR, &message, super::INTERNAL_ERROR, None);
        }
    };
    let Ok(text) = std::str::from_utf8(&body) else {
        // `json.loads` raises a `UnicodeDecodeError`, which is not a parse error to the SDK
        let message = "Error handling POST request: 'utf-8' codec can't decode the request body";
        return error_response(StatusCode::INTERNAL_SERVER_ERROR, message, super::INTERNAL_ERROR, None);
    };
    let raw: Value = match serde_json::from_str(text) {
        Ok(raw) => raw,
        Err(err) => {
            let reason = json_errors::python_json_error(text).unwrap_or_else(|| err.to_string());
            return error_response(StatusCode::BAD_REQUEST, &format!("Parse error: {reason}"), PARSE_ERROR, None);
        }
    };
    let incoming = match message::classify(&raw) {
        Ok(incoming) => incoming,
        Err(errors) => {
            let message = format!("Validation error: {}", format_errors("JSONRPCMessage", &errors));
            return error_response(StatusCode::BAD_REQUEST, &message, INVALID_PARAMS, None);
        }
    };
    let is_initialize = matches!(&incoming, Incoming::Request { method, .. } if method == "initialize");
    if !is_initialize {
        if let Some(refusal) = protocol_version_refusal(&headers) {
            return refusal;
        }
    }
    let Incoming::Request { id, method, params } = incoming else {
        // a notification or a response: accepted, nothing to answer (the server keeps no state it would change)
        return Response::builder()
            .status(StatusCode::ACCEPTED)
            .header(header::CONTENT_TYPE, CONTENT_TYPE_JSON)
            .body(Body::empty())
            .unwrap_or_default();
    };

    // The reply is a stream: its head goes out now, the one event when the request is done. The request runs as a
    // task of its own with the request's context (the actor the app set) plus its `Authorization` header, which is
    // how a board-started run says who it is.
    let authorization = RequestAuthorization(header_text(&headers, "authorization"));
    let work = ctx::spawn(async move {
        let _authorization = ctx::set(authorization);
        super::handle_request(&id, &method, params.as_ref()).await
    });
    let events = stream::unfold(Some(AbortOnDrop(work)), |state| async {
        let mut work = state?;
        tokio::select! {
            reply = &mut work.0 => {
                let event = match reply {
                    Ok(reply) => message_event(&reply),
                    // the request's task died (a panic): the stream ends without an event, as when the SDK's
                    // session crashes
                    Err(err) => {
                        tracing::error!(target: "mcp.server.streamable_http", "Stateless session crashed: {err}");
                        return None;
                    }
                };
                Some((Ok::<_, Infallible>(event), None))
            }
            () = tokio::time::sleep(PING_INTERVAL) => Some((Ok(ping_event()), Some(work))),
        }
    });
    event_stream(Body::from_stream(events))
}
