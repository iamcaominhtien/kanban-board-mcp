//! The board's HTTP server: REST, the event stream and MCP over HTTP. The desktop app starts it, reads the
//! `READY port=N` line from its standard output and writes the API secret to its standard input.
//!
//! `--routes` prints the table of REST routes as JSON and exits (the route coverage check reads it). `--runner` is
//! the runner process of the AI team instead of the server (the API starts it with `KANBAN_RUNNER=process`).
//!
//! `kanban-server mcp-stdio <words>` is the stdio MCP server (`mcp_stdio.py`), which the `kanban-mcp-stdio` program
//! beside this one hands over to.
//!
//! `kanban-server db <words>` is `kanban-db <words>` (`dbkit/cli.py`): the copy of the board between databases from a
//! terminal. The program is `kanban-db` too when it is started under that name (a link to this file).

use std::net::{Ipv4Addr, SocketAddr};
use std::time::Instant;

#[allow(unsafe_code)]
fn set_env(name: &str, value: &str) {
    // Only called from `main` before the runtime starts: no other thread reads the environment yet.
    unsafe { std::env::set_var(name, value) };
}

fn main() -> std::process::ExitCode {
    let t0 = Instant::now();
    let args: Vec<String> = std::env::args().skip(1).collect();
    let started_as = std::env::args().next().unwrap_or_default();
    let started_as = std::path::Path::new(&started_as).file_stem().and_then(|n| n.to_str()).unwrap_or_default();
    let db_words = if started_as == "kanban-db" {
        Some(args.clone())
    } else if args.first().is_some_and(|a| a == "db") {
        Some(args[1..].to_vec())
    } else {
        None
    };
    if let Some(words) = db_words {
        // the copy builds the Docs search index of a SQLite target through the Docs area's hook
        kb_app::hooks::install();
        let runtime = match tokio::runtime::Builder::new_multi_thread().enable_all().build() {
            Ok(runtime) => runtime,
            Err(err) => {
                eprintln!("Cannot start the runtime: {err}");
                return std::process::ExitCode::FAILURE;
            }
        };
        let code = runtime.block_on(kb_dbkit::cli::main(words));
        return std::process::ExitCode::from(u8::try_from(code).unwrap_or(1));
    }
    if args.first().is_some_and(|a| a == "mcp-stdio") {
        // what `kanban-mcp-stdio` runs (the program AI clients start hands over to this one)
        return kb_app::stdio::main(&args[1..]);
    }
    if args.iter().any(|a| a == "--routes") {
        let (_, table) = kb_app::routes().into_parts();
        let table: Vec<serde_json::Value> =
            table.into_iter().map(|(method, path)| serde_json::json!({"method": method, "path": path})).collect();
        println!("{}", serde_json::Value::Array(table));
        return std::process::ExitCode::SUCCESS;
    }
    if args.iter().any(|a| a == "--runner") {
        // `main.py --runner`: checked before anything of the server starts
        kb_log::setup_logging(false);
        let runtime = match tokio::runtime::Builder::new_multi_thread().enable_all().build() {
            Ok(runtime) => runtime,
            Err(err) => {
                eprintln!("Cannot start the runtime: {err}");
                return std::process::ExitCode::FAILURE;
            }
        };
        let code = runtime.block_on(kb_app::lifespan::runner());
        return std::process::ExitCode::from(u8::try_from(code).unwrap_or(1));
    }
    kb_base::api_secret::init();
    if std::env::var("KANBAN_RUNNER").unwrap_or_default().is_empty() {
        set_env("KANBAN_RUNNER", "process");
    }
    kb_log::setup_logging(false);

    let listener = match std::net::TcpListener::bind(SocketAddr::from((Ipv4Addr::LOCALHOST, 0))) {
        Ok(listener) => listener,
        Err(err) => {
            eprintln!("Cannot open a port on 127.0.0.1: {err}");
            return std::process::ExitCode::FAILURE;
        }
    };
    let port = listener.local_addr().map(|a| a.port()).unwrap_or(0);
    kb_app::startup_mark(t0, &format!("socket-bound-port={port}"));
    set_env("KANBAN_BOARD_URL", &format!("http://127.0.0.1:{port}"));

    let runtime = match tokio::runtime::Builder::new_multi_thread().enable_all().build() {
        Ok(runtime) => runtime,
        Err(err) => {
            eprintln!("Cannot start the runtime: {err}");
            return std::process::ExitCode::FAILURE;
        }
    };
    match runtime.block_on(kb_app::serve(listener, t0)) {
        Ok(()) => std::process::ExitCode::SUCCESS,
        Err(err) => {
            tracing::error!(target: "kanban.http", "The server stopped: {err}");
            eprintln!("The server stopped: {err}");
            std::process::ExitCode::FAILURE
        }
    }
}
