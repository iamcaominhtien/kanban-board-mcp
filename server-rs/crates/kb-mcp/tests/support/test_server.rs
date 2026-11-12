//! The server the tests of `kb-mcp` start through `testkit` when the target is Rust: the MCP endpoint over a
//! database of its own, as the board's server will mount it. Next to it, the project and ticket routes of the board
//! (a test makes its tickets through them) and a stand-in for the app's last route (the UI's `GET /{path}`), so
//! that a path outside `/mcp/` is answered as the app answers it. Prints `READY port=N` like the board's server.

use std::net::{Ipv4Addr, SocketAddr};

use axum::extract::Request;
use axum::http::StatusCode;
use axum::middleware::Next;
use axum::response::Response;
use kb_base::{Routes, activity, ctx};
use kb_db::database;

/// The app's actor middleware, as far as the tools need it: each request has a context of its own, acting as the
/// board's user.
async fn record_activity_actor(request: Request, next: Next) -> Response {
    ctx::scope(async move {
        let token = activity::set_actor(Some(activity::HUMAN_ACTOR));
        let response = next.run(request).await;
        ctx::reset(token);
        response
    })
    .await
}

async fn ui() -> StatusCode {
    StatusCode::NOT_FOUND
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
    let routes = Routes::new().merge(kb_mcp::routes()).merge(kb_board::api::routes()).get("/{full_path:path}", ui);
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
