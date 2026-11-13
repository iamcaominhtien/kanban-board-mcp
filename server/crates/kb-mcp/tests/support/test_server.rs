//! The server the tests of `kb-mcp` start through `testkit` when the target is Rust: the MCP endpoint over a
//! database of its own, as the board's server will mount it. Next to it, the routes of the board, the notifications,
//! the Idea Space, Docs and the drawings (a test makes its tickets, ideas and pages through them, and reads the notifications a
//! change made) and a stand-in for the app's last route (the UI's `GET /{path}`), so that a path outside `/mcp/` is
//! answered as the app answers it. Prints `READY port=N` like the board's server.

use std::net::{Ipv4Addr, SocketAddr};

use axum::extract::Request;
use axum::http::StatusCode;
use axum::middleware::Next;
use axum::response::Response;
use kb_base::{Routes, activity, ctx, events};
use kb_db::database;

/// The app's actor middleware (`kb-app/src/middleware.rs`), as far as the tools need it: each request has a
/// context of its own, acting as the board's user, or as `X-Actor` when the header is sent.
async fn record_activity_actor(request: Request, next: Next) -> Response {
    // read the headers first: a borrow of the request must not live across the await
    let (actor, origin) = {
        let header = |name: &str| {
            // Starlette decodes header bytes as latin-1
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

/// The app's adapter for the notifications the Docs comments raise (`kb-app/src/hooks.rs`).
struct Notifications;

impl kb_doctext::docs_access::NotificationsHook for Notifications {
    fn comment_event(&self, event: &kb_db::entities::docs_comment_event::Model) {
        kb_notify::comment_event(event);
    }
}

async fn ui() -> StatusCode {
    StatusCode::NOT_FOUND
}

/// Removes the subscriber when the stream is dropped (the client went away).
struct Guard(std::sync::Arc<events::Subscriber>);

impl Drop for Guard {
    fn drop(&mut self) {
        events::unsubscribe(&self.0);
    }
}

/// `GET /events` as the app serves it (`kb-app/src/sse.rs`): `: connected`, then one `data:` block per event. The
/// tests read it to see that a tool announced a change.
async fn sse_events() -> axum::response::Response {
    use axum::body::{Body, Bytes};
    use axum::response::IntoResponse;
    let guard = Guard(events::subscribe());
    let first =
        futures::stream::once(async { Ok::<_, std::convert::Infallible>(Bytes::from_static(b": connected\n\n")) });
    let rest = futures::stream::unfold(guard, |guard| async move {
        let chunk = match tokio::time::timeout(std::time::Duration::from_secs(30), guard.0.recv()).await {
            Ok(event) => Bytes::from(format!("data: {event}\n\n")),
            Err(_) => Bytes::from_static(b": ping\n\n"),
        };
        Some((Ok::<_, std::convert::Infallible>(chunk), guard))
    });
    (
        [(axum::http::header::CONTENT_TYPE, "text/event-stream; charset=utf-8")],
        Body::from_stream(futures::StreamExt::chain(first, rest)),
    )
        .into_response()
}

#[tokio::main]
async fn main() -> std::process::ExitCode {
    kb_log::setup_logging(false);
    if let Err(err) = async {
        database::setup().await?;
        database::init_db().await
    }
    .await
    {
        eprintln!("The database could not be opened: {err}");
        return std::process::ExitCode::FAILURE;
    }
    // the hooks the app registers that the routes and the tools above reach
    // what `kb-app/src/hooks.rs` registers, as far as the routes and the tools above reach (not the database move)
    kb_ai::hooks::register();
    kb_docs::hooks::register();
    kb_ideas::register();
    kb_doctext::docs_access::set_notifications_hook(Box::new(Notifications));
    // in the order `main.py` includes the routers
    let routes = Routes::new()
        .merge(kb_mcp::routes())
        .merge(kb_board::api::routes())
        .merge(kb_notify::api::routes())
        .merge(kb_ideas::api::routes())
        .merge(kb_docs::api::routes())
        .merge(kb_draw::api::routes())
        .get("/events", sse_events)
        .get("/{full_path:path}", ui);
    let (router, _table) = routes.into_parts();
    let app = router.layer(axum::middleware::from_fn(record_activity_actor));
    let listener = match tokio::net::TcpListener::bind(SocketAddr::from((Ipv4Addr::LOCALHOST, 0))).await {
        Ok(listener) => listener,
        Err(err) => {
            eprintln!("Cannot open a port on 127.0.0.1: {err}");
            return std::process::ExitCode::FAILURE;
        }
    };
    let port = listener.local_addr().map(|a| a.port()).unwrap_or(0);
    println!("READY port={port}");
    match axum::serve(listener, app.into_make_service()).await {
        Ok(()) => std::process::ExitCode::SUCCESS,
        Err(err) => {
            eprintln!("The server stopped: {err}");
            std::process::ExitCode::FAILURE
        }
    }
}
