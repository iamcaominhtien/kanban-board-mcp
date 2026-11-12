//! The program AI clients start for the board's MCP server over stdio (`mcp_stdio.py` before). Their configuration
//! names this file, so it keeps its name and its place; the server itself is one program, `kanban-server`, in the
//! same folder, and this one hands over to it: `kanban-server mcp-stdio <the same words>`, with the same standard
//! input, output and error.
//!
//! On Unix the server program takes this process's place. On Windows it runs as a child with the same handles, and
//! this process waits for it and ends with its exit code.

use std::path::PathBuf;
use std::process::{Command, ExitCode};

/// `kanban-server` beside this program.
fn server_program() -> Result<PathBuf, String> {
    let me = std::env::current_exe().map_err(|err| format!("Cannot tell where this program is: {err}"))?;
    // (a link to the program is followed: the server is beside the file, not beside the link)
    let me = std::fs::canonicalize(&me).unwrap_or(me);
    let folder = me.parent().map(PathBuf::from).unwrap_or_default();
    let server = folder.join(format!("kanban-server{}", std::env::consts::EXE_SUFFIX));
    if server.is_file() {
        Ok(server)
    } else {
        Err(format!(
            "{} is missing: it must be in the same folder as this program (in a checkout, build it with \
             `cargo build -p kanban-server`).",
            server.display()
        ))
    }
}

#[cfg(unix)]
fn hand_over(mut command: Command) -> ExitCode {
    use std::os::unix::process::CommandExt;
    // returns only when the server program could not be started
    let err = command.exec();
    eprintln!("Cannot start the MCP server: {err}");
    ExitCode::FAILURE
}

#[cfg(not(unix))]
fn hand_over(mut command: Command) -> ExitCode {
    match command.status() {
        Ok(status) => ExitCode::from(u8::try_from(status.code().unwrap_or(1)).unwrap_or(1)),
        Err(err) => {
            eprintln!("Cannot start the MCP server: {err}");
            ExitCode::FAILURE
        }
    }
}

fn main() -> ExitCode {
    let server = match server_program() {
        Ok(server) => server,
        Err(message) => {
            eprintln!("{message}");
            return ExitCode::FAILURE;
        }
    };
    let mut command = Command::new(server);
    command.arg("mcp-stdio").args(std::env::args_os().skip(1));
    hand_over(command)
}
