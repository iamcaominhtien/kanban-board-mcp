//! `kanban-mcp-stdio --bridge` against `mcp_stdio.py --bridge` where no board is needed: started without a run's
//! token, and with a board that does not answer. (The bridge in front of a running board is tested in
//! `kb-mcp/tests/mcp_bridge.rs`.)

mod common;

use std::time::Duration;

use common::{Which, python_available, spawn};

/// A port nothing listens on: bound, read, and closed again.
fn closed_port() -> u16 {
    let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).expect("bind");
    listener.local_addr().expect("an address").port()
}

fn programs() -> Vec<Which> {
    if python_available() { vec![Which::Python, Which::Rust] } else { vec![Which::Rust] }
}

#[test]
fn without_a_run_token_the_bridge_says_so_and_fails() {
    let mut seen = Vec::new();
    for which in programs() {
        let program = spawn(which, &["--bridge"], &[]);
        let (code, stdout, stderr) = program.finish();
        assert_eq!(code, Some(1), "{which:?}: {stderr}");
        assert!(stdout.is_empty(), "{which:?}: {stdout:?}");
        assert_eq!(stderr, "KANBAN_RUN_TOKEN is not set: this bridge only works inside a board run\n", "{which:?}");
        seen.push(stderr);
    }
    assert!(seen.windows(2).all(|pair| pair[0] == pair[1]));
}

/// Each line that is a request gets an error with its id; a notification, an empty line and a line that is not
/// JSON get nothing. The two programs write the same lines.
#[test]
fn a_board_that_does_not_answer_is_an_error_for_each_request() {
    let url = format!("http://127.0.0.1:{}/mcp/", closed_port());
    let mut outputs = Vec::new();
    for which in programs() {
        let mut program = spawn(which, &["--bridge"], &[("KANBAN_MCP_URL", &url), ("KANBAN_RUN_TOKEN", "kbr_test")]);
        let mut lines = Vec::new();
        program.send(r#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#);
        program.send("");
        program.send("not json at all");
        for request in [
            r#"{"jsonrpc":"2.0","id":1,"method":"ping"}"#,
            r#"{"jsonrpc": "2.0", "id": "é-2", "method": "tools/list"}"#,
        ] {
            program.send(request);
            lines.push(program.next_line(Duration::from_secs(60)).unwrap_or_else(|| panic!("{which:?}: no answer")));
        }
        let (code, rest, stderr) = program.finish();
        assert_eq!(code, Some(0), "{which:?}: {stderr}");
        assert!(rest.is_empty(), "{which:?}: {rest:?}");
        outputs.push(lines);
    }
    let rust = outputs.last().expect("the Rust program ran");
    assert_eq!(
        rust[0],
        r#"{"jsonrpc": "2.0", "id": 1, "error": {"code": -32000, "message": "The board did not answer: <urlopen error [Errno 111] Connection refused>"}}"#
    );
    // `json.dumps` writes text as ASCII
    assert!(rust[1].starts_with(r#"{"jsonrpc": "2.0", "id": "\u00e9-2", "error": {"#), "{}", rust[1]);
    assert!(outputs.windows(2).all(|pair| pair[0] == pair[1]), "{outputs:#?}");
}
