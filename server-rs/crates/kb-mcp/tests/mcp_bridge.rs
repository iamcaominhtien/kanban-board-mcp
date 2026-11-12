//! The bridge (`kb_mcp::bridge`, the port of `mcp_bridge.py`) in front of a running board: each line written to it
//! is posted to the board's MCP endpoint with the run's token, and the board's answer comes back as one line. The
//! Rust bridge runs in this process on a pair of pipes; the Python bridge (`server/mcp_bridge.py`, standard library
//! only: it needs no database and reads no setting) is started against the same board, and the two must write the
//! same lines.

mod common;

use std::io::{BufRead, BufReader, Write};
use std::process::{Command, Stdio};
use std::time::Duration;

use serde_json::{Value, json};
use testkit::normalize;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, duplex};

const TOKEN: &str = "kbr_not-a-live-run";

/// The lines sent, each a request so that each gets exactly one line back (the bridge answers in parallel: a line
/// is sent when the one before it was answered).
fn requests() -> Vec<Value> {
    vec![
        json!({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "2025-06-18",
               "capabilities": {}, "clientInfo": {"name": "bridge-test", "version": "0"}}}),
        json!({"jsonrpc": "2.0", "id": 2, "method": "ping"}),
        json!({"jsonrpc": "2.0", "id": "three", "method": "tools/call", "params": {"name": "get_projects", "arguments": {}}}),
        json!({"jsonrpc": "2.0", "id": 4, "method": "foo/bar"}),
        json!({"jsonrpc": "2.0", "id": 5, "method": "tools/call", "params": {"name": "get_projects", "arguments": {"nöpe": "Hà Nội ☕"}}}),
        json!({"jsonrpc": "2.0", "id": 6, "method": "tools/call", "params": {"name": "no_such_tool"}}),
    ]
}

/// What comes back without an answer line: sent first, then a request, whose answer must be the next line.
const SILENT: [&str; 4] = [r#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#, "", "   ", "this is not JSON"];

async fn through_the_rust_bridge(url: &str) -> Vec<String> {
    let (mut to_bridge, bridge_in) = duplex(1 << 16);
    let (bridge_out, from_bridge) = duplex(1 << 20);
    let url = url.to_string();
    let bridge = tokio::spawn(async move { kb_mcp::bridge::run(bridge_in, bridge_out, &url, TOKEN).await });
    let mut answers = tokio::io::BufReader::new(from_bridge).lines();
    let mut lines = Vec::new();
    for silent in SILENT {
        to_bridge.write_all(format!("{silent}\n").as_bytes()).await.expect("write");
    }
    for request in requests() {
        to_bridge.write_all(format!("{request}\n").as_bytes()).await.expect("write");
        let line = tokio::time::timeout(Duration::from_secs(60), answers.next_line()).await;
        lines.push(line.expect("an answer in time").expect("read").expect("a line"));
    }
    drop(to_bridge);
    bridge.await.expect("the bridge ends with its input");
    assert_eq!(answers.next_line().await.expect("read"), None, "nothing more is written");
    lines
}

fn through_the_python_bridge(url: &str) -> Option<Vec<String>> {
    let server_dir = format!("{}/../../../server", env!("CARGO_MANIFEST_DIR"));
    let python = format!("{server_dir}/.venv/bin/python");
    if !std::path::Path::new(&python).is_file() {
        return None;
    }
    // (the bridge imports the standard library only; `-I` keeps it from picking up anything else)
    let mut child = Command::new(python)
        .args(["-I", "mcp_bridge.py"])
        .current_dir(&server_dir)
        .env("KANBAN_MCP_URL", url)
        .env("KANBAN_RUN_TOKEN", TOKEN)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .expect("the Python bridge starts");
    let mut stdin = child.stdin.take().expect("stdin");
    let mut answers = BufReader::new(child.stdout.take().expect("stdout")).lines();
    let mut lines = Vec::new();
    for silent in SILENT {
        stdin.write_all(format!("{silent}\n").as_bytes()).expect("write");
    }
    for request in requests() {
        stdin.write_all(format!("{request}\n").as_bytes()).expect("write");
        stdin.flush().expect("flush");
        lines.push(answers.next().expect("an answer").expect("read"));
    }
    drop(stdin);
    assert!(answers.next().is_none(), "nothing more is written");
    assert!(child.wait().expect("wait").success());
    Some(lines)
}

/// Ids and times of two runs differ; everything else, the spacing and the escapes included, must not.
fn normalized(lines: &[String]) -> Vec<String> {
    lines
        .iter()
        .map(|line| {
            let value: Value = serde_json::from_str(line).unwrap_or_else(|e| panic!("not JSON ({e}): {line}"));
            assert_eq!(kb_base_dumps(&value), *line, "a line is written as json.dumps writes it");
            normalize(&value).to_string()
        })
        .collect()
}

/// `json.dumps(value)`: `", "` and `": "` between items, text as ASCII.
fn kb_base_dumps(value: &Value) -> String {
    fn write(value: &Value, out: &mut String) {
        match value {
            Value::Array(items) => {
                out.push('[');
                for (i, item) in items.iter().enumerate() {
                    if i > 0 {
                        out.push_str(", ");
                    }
                    write(item, out);
                }
                out.push(']');
            }
            Value::Object(map) => {
                out.push('{');
                for (i, (key, item)) in map.iter().enumerate() {
                    if i > 0 {
                        out.push_str(", ");
                    }
                    write(&Value::String(key.clone()), out);
                    out.push_str(": ");
                    write(item, out);
                }
                out.push('}');
            }
            Value::String(text) => {
                out.push('"');
                for c in text.chars() {
                    match c {
                        '"' => out.push_str("\\\""),
                        '\\' => out.push_str("\\\\"),
                        '\n' => out.push_str("\\n"),
                        '\r' => out.push_str("\\r"),
                        '\t' => out.push_str("\\t"),
                        c if c.is_ascii() && !c.is_ascii_control() => out.push(c),
                        c => {
                            let mut units = [0u16; 2];
                            for unit in c.encode_utf16(&mut units) {
                                out.push_str(&format!("\\u{unit:04x}"));
                            }
                        }
                    }
                }
                out.push('"');
            }
            other => out.push_str(&other.to_string()),
        }
    }
    let mut out = String::new();
    write(value, &mut out);
    out
}

#[tokio::test]
async fn the_bridge_carries_each_request_to_the_board_and_its_answer_back() {
    let s = common::start().await;
    let url = format!("{}/mcp/", s.base_url());
    let rust = through_the_rust_bridge(&url).await;
    let ids: Vec<Value> = rust.iter().map(|l| serde_json::from_str::<Value>(l).expect("JSON")["id"].clone()).collect();
    assert_eq!(ids, [json!(1), json!(2), json!("three"), json!(4), json!(5), json!(6)]);
    let first: Value = serde_json::from_str(&rust[0]).expect("JSON");
    assert_eq!(first["result"]["serverInfo"]["name"], "kanban-mcp");
    assert!(rust[4].contains(r#"n\u00f6pe"#), "text is written as ASCII: {}", rust[4]);

    let python = tokio::task::spawn_blocking(move || through_the_python_bridge(&url)).await.expect("the Python bridge");
    match python {
        Some(python) => assert_eq!(normalized(&rust), normalized(&python)),
        None => eprintln!("SKIPPED the comparison: no Python virtualenv"),
    }
}

/// An answer that is not a success is an error for a request, with the status as `urllib` words it.
#[tokio::test]
async fn an_http_error_of_the_board_is_reported_to_the_client() {
    let s = common::start().await;
    let url = format!("{}/mcp/below", s.base_url());
    let rust = through_the_rust_bridge(&url).await;
    assert_eq!(
        rust[1],
        r#"{"jsonrpc": "2.0", "id": 2, "error": {"code": -32000, "message": "The board did not answer: HTTP Error 404: Not Found"}}"#
    );
    let python = tokio::task::spawn_blocking(move || through_the_python_bridge(&url)).await.expect("the Python bridge");
    if let Some(python) = python {
        assert_eq!(rust, python);
    }
}
