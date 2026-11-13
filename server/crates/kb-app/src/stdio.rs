//! The stdio MCP server (the port of `mcp_stdio.py`): what `kanban-server mcp-stdio` runs, and so what the
//! `kanban-mcp-stdio` program that AI clients start runs (it hands over to the server program beside it).
//!
//! Use this when connecting via VS Code, Claude Desktop, or any MCP client that launches the server as a subprocess
//! (stdio transport). Standard output carries the protocol and nothing else; the log goes to its own file.
//!
//! `--bridge` is Antigravity's way into a board run: it forwards to the board's HTTP MCP endpoint with the run's
//! token (`kb_mcp::bridge`). It is handled before anything else: no database is needed.
//!
//! The tools call into every area as they do in the board (a ticket moved over stdio stops its AI run), so the
//! areas' hooks are registered here too, as the Python process imported the same services.

use std::process::ExitCode;
use std::time::Duration;

use kb_db::database;

/// Bring the database up, then serve stdin and stdout until the client closes them.
async fn serve() -> Result<(), database::DatabaseError> {
    database::setup().await?;
    database::init_db().await?;
    // Follow the database setting: when the board moves to another database or folder, this process does too, so the
    // board and the editors always talk to one database (design/screens/ai-databases.md B3). When the person opens
    // another workspace, it stays on its board and refuses the agent's calls: the ticket keys the agent holds name
    // other tickets on the other board.
    let follow = tokio::spawn(database::follow_settings(Duration::from_secs(2), database::OnSwitch::Stay));
    kb_mcp::protocol::stdio::serve().await;
    follow.abort();
    Ok(())
}

/// Run the stdio program; `args` are the words after its name.
pub fn main(args: &[String]) -> ExitCode {
    let runtime = match tokio::runtime::Builder::new_multi_thread().enable_all().build() {
        Ok(runtime) => runtime,
        Err(err) => {
            eprintln!("Cannot start the runtime: {err}");
            return ExitCode::FAILURE;
        }
    };
    if args.iter().any(|arg| arg == "--bridge") {
        return ExitCode::from(runtime.block_on(kb_mcp::bridge::main()));
    }

    // its connections are named "kanban-board mcp …" on PostgreSQL
    kb_db::targets::set_role("mcp");
    kb_log::setup_logging(true);
    crate::hooks::install();
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
