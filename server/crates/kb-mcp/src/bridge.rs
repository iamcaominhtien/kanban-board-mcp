//! A stdio MCP server that forwards to the board's HTTP MCP endpoint with the run's token.
//!
//! Antigravity keeps its MCP servers in its account's own config file, which has no place for a token that belongs to
//! one run. That file names this bridge instead (`kanban-mcp-stdio --bridge`); Antigravity starts it for the run
//! with the run's environment, and the bridge reads `KANBAN_MCP_URL` and `KANBAN_RUN_TOKEN` from it. It starts fast
//! and needs no database.
//!
//! Each line on stdin is one JSON-RPC message. It is posted to the board, and every message in the answer (plain
//! JSON or a server-sent-event stream) is written to stdout. A request that cannot be delivered gets a JSON-RPC
//! error, so the client never waits for an answer that will not come. Requests are handled in parallel: a board tool
//! may wait for a person's approval while the client keeps talking.

use std::sync::Arc;
use std::time::Duration;

use kb_base::{pyjson, pytext};
use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncWrite, AsyncWriteExt, BufReader};
use tokio::sync::Mutex;

pub const URL_ENV: &str = "KANBAN_MCP_URL";
pub const TOKEN_ENV: &str = "KANBAN_RUN_TOKEN";
pub const DEFAULT_URL: &str = "http://127.0.0.1:8000/mcp/";
/// a board tool may wait for an approval
pub const TIMEOUT_S: u64 = 20 * 60;

type Output = Arc<Mutex<Box<dyn AsyncWrite + Unpin + Send>>>;

/// One message as a line (`json.dumps(message) + "\n"`), flushed; one writer at a time.
async fn write(out: &Output, message: &Value) {
    let line = format!("{}\n", pyjson::dumps(message));
    let mut out = out.lock().await;
    let _ = out.write_all(line.as_bytes()).await;
    let _ = out.flush().await;
}

/// The JSON-RPC messages in an HTTP answer.
pub fn messages(body: &str, content_type: &str) -> Vec<Value> {
    let mut found: Vec<Value> = Vec::new();
    let mut extend = |data: Value| match data {
        Value::Array(items) => found.extend(items),
        other => found.push(other),
    };
    if content_type.contains("text/event-stream") {
        for raw in pytext::splitlines(body) {
            if let Some(data) = raw.strip_prefix("data:") {
                if let Ok(data) = serde_json::from_str::<Value>(pytext::strip(data)) {
                    extend(data);
                }
            }
        }
    } else if !pytext::strip(body).is_empty() {
        match serde_json::from_str::<Value>(body) {
            Ok(data) => extend(data),
            Err(_) => return Vec::new(),
        }
    }
    found
}

/// Why the board did not answer, worded as `urllib` words it where it can be (`str(exc)` of the Python bridge).
fn failure(err: &reqwest::Error) -> String {
    if err.is_timeout() {
        return "timed out".to_string();
    }
    // the cause at the bottom: an operating system error for a connection that could not be made
    let mut source: Option<&(dyn std::error::Error + 'static)> = Some(err);
    let mut io: Option<&std::io::Error> = None;
    while let Some(current) = source {
        if let Some(found) = current.downcast_ref::<std::io::Error>() {
            io = Some(found);
        }
        source = current.source();
    }
    match io {
        Some(io) if io.kind() == std::io::ErrorKind::ConnectionRefused => {
            format!("<urlopen error [Errno {}] Connection refused>", io.raw_os_error().unwrap_or(111))
        }
        Some(io) => format!("<urlopen error {io}>"),
        None => format!("<urlopen error {err}>"),
    }
}

/// Deliver one message and write what comes back.
pub async fn forward(client: &reqwest::Client, out: &Output, message: Value, url: &str, token: &str) {
    let sent = client
        .post(url)
        .header("Content-Type", "application/json")
        .header("Accept", "application/json, text/event-stream")
        .header("Authorization", format!("Bearer {token}"))
        .body(pyjson::dumps(&message))
        .send()
        .await;
    let outcome = match sent {
        // `urlopen` raises for an answer that is not a success
        Ok(response) if !response.status().is_success() => {
            let status = response.status();
            Err(format!("HTTP Error {}: {}", status.as_u16(), status.canonical_reason().unwrap_or("")))
        }
        Ok(response) => {
            let content_type = response
                .headers()
                .get("content-type")
                .map(|v| String::from_utf8_lossy(v.as_bytes()).into_owned())
                .unwrap_or_default();
            match response.bytes().await {
                Ok(body) => Ok((String::from_utf8_lossy(&body).into_owned(), content_type)),
                Err(err) => Err(failure(&err)),
            }
        }
        Err(err) => Err(failure(&err)),
    };
    match outcome {
        Ok((body, content_type)) => {
            for reply in messages(&body, &content_type) {
                write(out, &reply).await;
            }
        }
        Err(exc) => {
            if let Some(id) = message.get("id") {
                let reply = json!({
                    "jsonrpc": "2.0",
                    "id": id,
                    "error": {"code": -32000, "message": format!("The board did not answer: {exc}")},
                });
                write(out, &reply).await;
            }
        }
    }
}

/// Forward every line of `input` to `url` and write the answers to `output`, until the input closes.
pub async fn run<R, W>(input: R, output: W, url: &str, token: &str)
where
    R: AsyncRead + Unpin,
    W: AsyncWrite + Unpin + Send + 'static,
{
    let out: Output = Arc::new(Mutex::new(Box::new(output)));
    let client = reqwest::Client::builder().timeout(Duration::from_secs(TIMEOUT_S)).build().unwrap_or_default();
    let mut tasks = Vec::new();
    let mut lines = BufReader::new(input);
    let mut raw = Vec::new();
    loop {
        raw.clear();
        match lines.read_until(b'\n', &mut raw).await {
            Ok(0) | Err(_) => break,
            Ok(_) => {}
        }
        let text = String::from_utf8_lossy(&raw);
        let line = pytext::strip(&text);
        if line.is_empty() {
            continue;
        }
        let Ok(message) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        let (client, out, url, token) = (client.clone(), out.clone(), url.to_string(), token.to_string());
        tasks.push(tokio::spawn(async move { forward(&client, &out, message, &url, &token).await }));
    }
    // stdin closed: let answers that are still on their way finish
    for task in tasks {
        let _ = tokio::time::timeout(Duration::from_secs(5), task).await;
    }
}

/// Read messages from stdin until it closes. Returns the exit code of the program.
pub async fn main() -> u8 {
    let url = std::env::var(URL_ENV).ok().filter(|url| !url.is_empty()).unwrap_or_else(|| DEFAULT_URL.to_string());
    let token = std::env::var(TOKEN_ENV).unwrap_or_default();
    if token.is_empty() {
        eprintln!("{TOKEN_ENV} is not set: this bridge only works inside a board run");
        return 1;
    }
    run(tokio::io::stdin(), tokio::io::stdout(), &url, &token).await;
    0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_messages_of_an_answer() {
        let sse = "event: message\r\ndata: {\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{}}\r\n\r\n: ping\r\ndata: not json\r\ndata:[{\"a\":1},{\"b\":2}]\r\n\r\n";
        assert_eq!(
            messages(sse, "text/event-stream; charset=utf-8"),
            [json!({"jsonrpc": "2.0", "id": 1, "result": {}}), json!({"a": 1}), json!({"b": 2})]
        );
        assert_eq!(messages(" {\"id\": 3} \n", "application/json"), [json!({"id": 3})]);
        assert_eq!(messages("[1, 2]", ""), [json!(1), json!(2)]);
        assert_eq!(messages("   ", "application/json"), Vec::<Value>::new());
        assert_eq!(messages("<html>", "text/html"), Vec::<Value>::new());
    }
}
