//! Stdio entry point for the Kanban MCP server (the port of `mcp_stdio.py`).
//!
//! Use this when connecting via VS Code, Claude Desktop, or any MCP client that launches the server as a subprocess
//! (stdio transport). Standard output carries the protocol and nothing else; the log goes to its own file.
//!
//! `--bridge` is Antigravity's way into a board run: it forwards to the board's HTTP MCP endpoint with the run's
//! token (`kb_mcp::bridge`). It is handled before anything else: no database is needed.

use std::process::ExitCode;
use std::time::Duration;

use kb_db::database;

/// Bring the database up, then serve stdin and stdout until the client closes them.
async fn serve() -> Result<(), database::DatabaseError> {
    database::setup().await?;
    database::init_db().await?;
    // Follow the database setting: when the board switches to another database, this process does too, so the
    // board and the editors always talk to one database (design/screens/ai-databases.md B3)
    let follow = tokio::spawn(database::follow_settings(Duration::from_secs(2)));
    kb_mcp::protocol::stdio::serve().await;
    follow.abort();
    Ok(())
}

fn main() -> ExitCode {
    let runtime = match tokio::runtime::Builder::new_multi_thread().enable_all().build() {
        Ok(runtime) => runtime,
        Err(err) => {
            eprintln!("Cannot start the runtime: {err}");
            return ExitCode::FAILURE;
        }
    };
    if std::env::args().any(|arg| arg == "--bridge") {
        return ExitCode::from(runtime.block_on(kb_mcp::bridge::main()));
    }

    // its connections are named "kanban-board mcp …" on PostgreSQL
    kb_db::targets::set_role("mcp");
    kb_log::setup_logging(true);
    let served = runtime.block_on(serve());
    // the blocking read of standard input must not keep the process alive once the session is over
    runtime.shutdown_background();
    match served {
        Ok(()) => ExitCode::SUCCESS,
        Err(err) => {
            tracing::error!(target: "kanban.mcp_stdio", "The MCP server could not start: {err}");
            eprintln!("The MCP server could not start: {err}");
            ExitCode::FAILURE
        }
    }
}
