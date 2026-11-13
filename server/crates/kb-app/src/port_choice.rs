//! Which port the board listens on (`port_choice.py`).
//!
//! An MCP client is told the board's address once (`http://127.0.0.1:<port>/mcp/`), so the port must not change from
//! one start to the next. The server asks for, in this order:
//!
//! 1. `KANBAN_PORT`, when set (a fixed port you chose);
//! 2. the port it listened on last time, kept in `config.json`;
//! 3. any free port (the very first start, or when the wanted port is taken by another program).
//!
//! A port that is taken is never an error: the board starts on a free one and says so in the log. The port kept for
//! the next start is changed only when the board got the one it asked for, or had none to ask for, so a second
//! instance that had to take another port does not steal the first one's.
//!
//! The socket is the standard library's, which sets `SO_REUSEADDR` on Unix as Python's `_new_socket` does (and
//! listens at once; uvicorn listened on Python's socket a moment later).

use std::net::{Ipv4Addr, SocketAddr, TcpListener};

use kb_base::{config, pytext};

/// The address the board listens on.
pub const HOST: Ipv4Addr = Ipv4Addr::LOCALHOST;

/// The port asked for: `KANBAN_PORT`, else the one saved by the last start; `None` when there is none.
pub fn wanted_port() -> Option<u16> {
    match env_port(std::env::var("KANBAN_PORT").ok().as_deref()) {
        Some(port) => Some(port),
        None => config::get_port(),
    }
}

/// The port `KANBAN_PORT` names: `None` when it is unset or empty, or not a port number (with a warning).
pub fn env_port(value: Option<&str>) -> Option<u16> {
    let raw = pytext::strip(value.unwrap_or(""));
    if raw.is_empty() {
        return None;
    }
    // `raw.isdigit() and 0 < int(raw) < 65536`
    let port = if raw.chars().all(|c| c.is_ascii_digit()) { raw.parse::<u32>().ok() } else { None };
    match port.filter(|p| 0 < *p && *p < 65536).and_then(|p| u16::try_from(p).ok()) {
        Some(port) => Some(port),
        None => {
            tracing::warn!(target: "kanban.port", "KANBAN_PORT={} is not a port number: ignored", pytext::repr(raw));
            None
        }
    }
}

fn bind(port: u16) -> std::io::Result<TcpListener> {
    TcpListener::bind(SocketAddr::from((HOST, port)))
}

/// A socket bound on the wanted port, or on a free one when that is taken.
pub fn bind_socket() -> std::io::Result<TcpListener> {
    let wanted = wanted_port();
    let sock = match wanted {
        Some(wanted) => match bind(wanted) {
            Ok(sock) => sock,
            Err(exc) => {
                tracing::warn!(
                    target: "kanban.port",
                    "Port {wanted} is not free ({exc}): using another one; MCP clients set to {HOST}:{wanted} need the new port"
                );
                return bind(0);
            }
        },
        None => bind(0)?,
    };
    if let Err(err) = config::set_port(sock.local_addr()?.port()) {
        tracing::warn!(target: "kanban.port", "Could not save the port for the next start: {err}");
    }
    Ok(sock)
}

#[cfg(test)]
mod tests {
    use super::env_port;

    /// `test_a_bad_environment_value_is_ignored` (the value itself; the server tests check the start).
    #[test]
    fn a_bad_environment_value_is_ignored() {
        for bad in ["abc", "0", "70000", "-5", "", "  ", "99999999999", "8 0"] {
            assert_eq!(env_port(Some(bad)), None, "{bad:?}");
        }
        assert_eq!(env_port(None), None);
        assert_eq!(env_port(Some(" 8123\n")), Some(8123));
        assert_eq!(env_port(Some("08123")), Some(8123));
        assert_eq!(env_port(Some("65535")), Some(65535));
    }
}
