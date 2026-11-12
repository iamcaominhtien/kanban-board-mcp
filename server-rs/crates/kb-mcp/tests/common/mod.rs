//! Shared by the MCP tests: a raw HTTP/1.1 client (the transport test decides every byte of a request and reads
//! the reply as it came), and the golden files recorded from the Python server.
#![allow(dead_code)]

use std::time::Duration;

use serde_json::{Map, Value, json};
use testkit::{Target, target};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

/// A reply as it came over the socket.
#[derive(Debug, Clone)]
pub struct RawReply {
    pub status: u16,
    /// Header names in lower case, in the order sent.
    pub headers: Vec<(String, String)>,
    /// The body, with the chunk framing removed.
    pub body: String,
}

impl RawReply {
    /// The value of a header.
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers.iter().find(|(n, _)| n == name).map(|(_, v)| v.as_str())
    }

    /// The JSON-RPC message of the reply: the `data:` of an event stream, or the JSON body.
    pub fn message(&self) -> Value {
        let text = match self.body.lines().find_map(|l| l.strip_prefix("data: ")) {
            Some(data) => data,
            None => self.body.as_str(),
        };
        serde_json::from_str(text).unwrap_or_else(|e| panic!("not JSON ({e}): {}", self.body))
    }
}

/// Send one request, written out by the caller except for `Host` and `Content-Length`, and read the reply.
/// `open_stream` stops after the headers of a reply that never ends (a standing event stream).
pub async fn raw(
    port: u16,
    method: &str,
    path: &str,
    headers: &[(&str, &str)],
    body: Option<&[u8]>,
    open_stream: bool,
) -> RawReply {
    let mut stream = TcpStream::connect(("127.0.0.1", port)).await.expect("connect");
    let mut head = format!("{method} {path} HTTP/1.1\r\n");
    if !headers.iter().any(|(n, _)| n.eq_ignore_ascii_case("host")) {
        head.push_str(&format!("Host: 127.0.0.1:{port}\r\n"));
    }
    for (name, value) in headers {
        head.push_str(&format!("{name}: {value}\r\n"));
    }
    if let Some(body) = body {
        head.push_str(&format!("Content-Length: {}\r\n", body.len()));
    }
    head.push_str("\r\n");
    let mut bytes = head.into_bytes();
    bytes.extend_from_slice(body.unwrap_or_default());
    stream.write_all(&bytes).await.expect("write the request");

    let mut buf: Vec<u8> = Vec::new();
    let head_end = loop {
        if let Some(at) = find(&buf, b"\r\n\r\n") {
            break at;
        }
        read_more(&mut stream, &mut buf).await.unwrap_or_else(|| panic!("{method} {path}: no reply head"));
    };
    let head = String::from_utf8_lossy(&buf[..head_end]).into_owned();
    let mut lines = head.split("\r\n");
    let status: u16 =
        lines.next().and_then(|l| l.split(' ').nth(1)).and_then(|s| s.parse().ok()).expect("a status line");
    let headers: Vec<(String, String)> = lines
        .filter_map(|l| l.split_once(':'))
        .map(|(n, v)| (n.trim().to_lowercase(), v.trim().to_string()))
        .collect();
    let mut rest = buf[head_end + 4..].to_vec();
    let get = |name: &str| headers.iter().find(|(n, _)| n == name).map(|(_, v)| v.clone());
    let body = if open_stream || method == "HEAD" {
        Vec::new()
    } else if let Some(length) = get("content-length").and_then(|v| v.parse::<usize>().ok()) {
        while rest.len() < length {
            if read_more(&mut stream, &mut rest).await.is_none() {
                break;
            }
        }
        rest
    } else if get("transfer-encoding").is_some_and(|v| v.contains("chunked")) {
        let mut out = Vec::new();
        loop {
            let Some(line_end) = find(&rest, b"\r\n") else {
                if read_more(&mut stream, &mut rest).await.is_none() {
                    break;
                }
                continue;
            };
            let size = usize::from_str_radix(String::from_utf8_lossy(&rest[..line_end]).trim(), 16).expect("chunk size");
            while rest.len() < line_end + 2 + size + 2 {
                if read_more(&mut stream, &mut rest).await.is_none() {
                    break;
                }
            }
            if size == 0 {
                break;
            }
            out.extend_from_slice(&rest[line_end + 2..line_end + 2 + size]);
            rest.drain(..line_end + 2 + size + 2);
        }
        out
    } else {
        // no length: the body ends with the connection
        while read_more(&mut stream, &mut rest).await.is_some() {}
        rest
    };
    RawReply { status, headers, body: String::from_utf8_lossy(&body).into_owned() }
}

fn find(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack.windows(needle.len()).position(|w| w == needle)
}

async fn read_more(stream: &mut TcpStream, buf: &mut Vec<u8>) -> Option<()> {
    let mut chunk = [0u8; 8192];
    match tokio::time::timeout(Duration::from_secs(60), stream.read(&mut chunk)).await {
        Ok(Ok(n)) if n > 0 => {
            buf.extend_from_slice(&chunk[..n]);
            Some(())
        }
        _ => None,
    }
}

/// The headers of a JSON-RPC POST as an MCP client sends them.
pub const MCP_HEADERS: [(&str, &str); 2] =
    [("Accept", "application/json, text/event-stream"), ("Content-Type", "application/json")];

/// `POST /mcp/` with the usual headers.
pub async fn post(port: u16, body: &str) -> RawReply {
    raw(port, "POST", "/mcp/", &MCP_HEADERS, Some(body.as_bytes()), false).await
}

/// The path of a golden file of this crate's tests.
pub fn golden_path(name: &str) -> String {
    format!("{}/../../contract/golden/{name}", env!("CARGO_MANIFEST_DIR"))
}

/// Compare what a server answered (`got`: `{case: reply}`) with the golden file recorded from the Python server.
/// `PARITY_TARGET=python KANBAN_WRITE_GOLDEN=1` writes the file first.
pub fn check_golden(name: &str, got: &Map<String, Value>) {
    let path = golden_path(name);
    if std::env::var("KANBAN_WRITE_GOLDEN").is_ok_and(|v| v == "1") {
        assert_eq!(target(), Target::Python, "a golden file is what the Python server answers");
        let text = serde_json::to_string_pretty(&json!(got)).expect("json") + "\n";
        std::fs::write(&path, text).expect("write the golden file");
    }
    let text = std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("golden file {path}: {e}"));
    let golden: Map<String, Value> = serde_json::from_str(&text).expect("golden file parses");
    let mut wrong = Vec::new();
    for (case, expected) in &golden {
        match got.get(case) {
            Some(reply) if reply == expected => {}
            Some(reply) => wrong.push(format!(
                "--- {case}\n expected: {}\n      got: {}",
                serde_json::to_string(expected).expect("json"),
                serde_json::to_string(reply).expect("json")
            )),
            None => wrong.push(format!("--- {case}: in the golden file, not in the test")),
        }
    }
    for case in got.keys() {
        if !golden.contains_key(case) {
            wrong.push(format!("--- {case}: not in the golden file (write it again)"));
        }
    }
    assert!(wrong.is_empty(), "{} of {} cases differ from Python:\n{}", wrong.len(), golden.len(), wrong.join("\n"));
}
