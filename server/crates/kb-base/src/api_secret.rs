//! A secret only the board's own window knows, so a program on the computer cannot change the board by calling its
//! REST API as the owner.
//!
//! Without it the REST API trusts any caller on the loopback address, and an AI run with a shell (Bypass, or a broad
//! Bash rule) could `curl` it: approve its own requests, switch Safe mode off, lift the limits. When the desktop app
//! starts the server it writes a random secret to the server's standard input (not to its environment, which `ps`
//! shows to every program of the same user) and hands the same secret to its window only. The server then refuses
//! every request that changes something (POST, PUT, PATCH, DELETE) without it, except the MCP endpoint (a run's own
//! token) and the client log.
//!
//! Without the app (a developer starting the server by hand, the tests) there is no secret and nothing is checked.

use std::io::BufRead;
use std::sync::OnceLock;

pub const HEADER: &str = "X-Kanban-Secret";
pub const FLAG: &str = "KANBAN_API_SECRET_STDIN";
pub const UNCHECKED_PREFIXES: [&str; 4] = ["/mcp", "/logs/client", "/ai/hooks", "/internal/ai/"];
pub const CHANGING: [&str; 4] = ["POST", "PUT", "PATCH", "DELETE"];

static SECRET: OnceLock<String> = OnceLock::new();

/// Read the secret the desktop app wrote to standard input (once, at startup, before anything else reads stdin).
/// The flag is taken out of the environment, so child processes do not wait for a secret of their own.
pub fn init() {
    SECRET.get_or_init(|| {
        let flagged = std::env::var(FLAG).is_ok_and(|v| v == "1");
        // SAFETY of the environment: called once from `main` before any thread is started.
        remove_flag();
        if !flagged {
            return String::new();
        }
        let mut line = String::new();
        match std::io::stdin().lock().read_line(&mut line) {
            Ok(_) => line.trim().to_string(),
            Err(_) => String::new(),
        }
    });
}

#[allow(unsafe_code)]
fn remove_flag() {
    // Only `init` calls this, from `main`, before the runtime and its threads exist.
    unsafe { std::env::remove_var(FLAG) };
}

/// The secret, or "" when the server was started without one.
pub fn secret() -> &'static str {
    SECRET.get().map(String::as_str).unwrap_or("")
}

/// Use `value` as the secret (tests, and the runner process that gets it from its parent).
pub fn set_for_process(value: &str) {
    let _ = SECRET.set(value.to_string());
}

// What an AI that reached for the REST API (curl, a browser on the board) should use instead: the 403 says so, or it
// tries again another way (seen in a log: uploads by curl, Docs links checked in a browser)
const INSTEAD: [(&[&str], &str); 2] = [
    (
        &["/uploads/", "/workspace/files"],
        "To attach a picture or a file, write it as a path in your working folder inside the Markdown of the MCP \
         call: ![shot](qa/evidence/TC-1.png) or [sample](docs/sample.xlsx) in docs_write, a comment, a work log or a \
         test case proof; the board copies it. For the ticket's scratch folder, manage_ticket(action='workspace') \
         gives its path: write the file there with your own file tools.",
    ),
    (
        &["/docs/resolve", "/docs/pages/"],
        "To check the links of a Docs page use docs_read(action='check_links'); to read a page, \
         docs_read(action='get'). The board's window cannot be driven from a browser outside the app.",
    ),
];

/// The 403 text for a request without the secret, with the MCP tool an AI run should use instead.
pub fn refusal(path: &str) -> String {
    let hint = INSTEAD
        .iter()
        .find(|(parts, _)| parts.iter().any(|p| path.contains(p)))
        .map(|(_, text)| *text)
        .unwrap_or("An AI run changes the board through the kanban MCP tools, not the REST API or a browser.");
    format!("This request must come from the board's own window. {hint}")
}

/// Whether a request may go on: no secret is set, it does not change anything, it is one of the unchecked endpoints,
/// or it carries the secret.
pub fn allows(method: &str, path: &str, given: Option<&str>) -> bool {
    allows_with(secret(), method, path, given)
}

fn allows_with(secret: &str, method: &str, path: &str, given: Option<&str>) -> bool {
    if secret.is_empty() || !CHANGING.contains(&method.to_ascii_uppercase().as_str()) {
        return true;
    }
    if UNCHECKED_PREFIXES.iter().any(|p| path.starts_with(p)) {
        return true;
    }
    constant_time_eq(given.unwrap_or("").as_bytes(), secret.as_bytes())
}

/// `hmac.compare_digest`: the time taken does not depend on where the first difference is.
pub fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn checks_only_changing_requests_outside_the_open_prefixes() {
        assert!(allows_with("", "POST", "/tickets", None));
        assert!(allows_with("s3", "GET", "/tickets", None));
        assert!(!allows_with("s3", "POST", "/tickets", None));
        assert!(!allows_with("s3", "delete", "/tickets/1", Some("nope")));
        assert!(allows_with("s3", "POST", "/tickets", Some("s3")));
        assert!(allows_with("s3", "POST", "/mcp/", None));
        assert!(allows_with("s3", "POST", "/internal/ai/events", None));
    }

    #[test]
    fn refusal_names_the_tool_to_use() {
        assert!(refusal("/uploads/x.png").contains("To attach a picture"));
        assert!(refusal("/projects/1/docs/pages/2").contains("docs_read(action='check_links')"));
        assert!(refusal("/tickets").ends_with("not the REST API or a browser."));
    }
}
