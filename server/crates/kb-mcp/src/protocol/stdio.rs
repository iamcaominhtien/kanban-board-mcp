//! The stdio transport: newline-delimited JSON-RPC on standard input and output, as the SDK's `stdio_server` and
//! `ServerSession` run it for `mcp.run_stdio_async()`.
//!
//! - One message per line in, one per line out (compact JSON, a line feed, flushed). Nothing else is ever written
//!   to the output: it carries the protocol.
//! - The session starts uninitialized: before `initialize` only `ping` is served; any other request is answered
//!   `Invalid request parameters`, as is a request that is not one a client may send. `initialize` is answered at
//!   once, and requests are served from then on (the `notifications/initialized` that follows changes nothing more).
//! - Requests run side by side and are answered as they finish. `notifications/cancelled` stops the request it
//!   names, which is then answered with the error `Request cancelled`.
//! - A line that is not a JSON-RPC message gets no reply of its own: the SDK tells the client with a
//!   `notifications/message` log entry (`Internal Server Error`). So does a response or an error, which answers
//!   nothing here (the server sends no requests).
//! - When the input ends the requests still running are dropped and the program is done.

use std::collections::HashMap;

use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncWrite, AsyncWriteExt, BufReader};
use tokio::sync::mpsc;
use tokio::task::JoinHandle;

use kb_base::ctx;

use super::message::{self, Incoming};
use super::{error, invalid_request_parameters};

/// Serve the process's standard input and output until the input ends.
pub async fn serve() {
    serve_on(tokio::io::stdin(), tokio::io::stdout()).await;
}

/// What the SDK writes when a line cannot be read as a message (the keys in the order the SDK writes them).
fn internal_server_error() -> Value {
    json!({
        "method": "notifications/message",
        "params": {"level": "error", "logger": "mcp.server.exception_handler", "data": "Internal Server Error"},
        "jsonrpc": "2.0",
    })
}

/// The key of a request id among the requests in flight (`1` and `"1"` are different ids).
fn id_key(id: &Value) -> String {
    id.to_string()
}

/// Serve one session on any pair of streams (the tests use pipes).
pub async fn serve_on<R, W>(input: R, mut output: W)
where
    R: AsyncRead + Unpin,
    W: AsyncWrite + Unpin + Send + 'static,
{
    // one writer owns the output: a message is one whole line
    let (out, mut lines) = mpsc::unbounded_channel::<Value>();
    let writer = tokio::spawn(async move {
        while let Some(message) = lines.recv().await {
            let line = format!("{message}\n");
            if output.write_all(line.as_bytes()).await.is_err() || output.flush().await.is_err() {
                break;
            }
        }
    });
    // requests that finished, so that they leave `in_flight`
    let (finished, mut done) = mpsc::unbounded_channel::<String>();

    let mut initialized = false;
    let mut in_flight: HashMap<String, JoinHandle<()>> = HashMap::new();
    let mut reader = BufReader::new(input);
    let mut raw_line = Vec::new();
    loop {
        raw_line.clear();
        let read = tokio::select! {
            read = reader.read_until(b'\n', &mut raw_line) => read,
            Some(key) = done.recv() => {
                in_flight.remove(&key);
                continue;
            }
        };
        match read {
            Ok(0) | Err(_) => break,
            Ok(_) => {}
        }
        // `TextIOWrapper(sys.stdin.buffer, encoding="utf-8", errors="replace")`
        let line = String::from_utf8_lossy(&raw_line);
        let incoming = serde_json::from_str::<Value>(&line).ok().and_then(|raw| message::classify(&raw).ok());
        let Some(incoming) = incoming else {
            tracing::error!(target: "mcp.server.lowlevel.server", "Received exception from stream: a line that is not a JSON-RPC message");
            let _ = out.send(internal_server_error());
            continue;
        };
        match incoming {
            Incoming::Request { id, method, params } => {
                let request = message::client_request(&method, params.as_ref());
                if request.is_none() {
                    tracing::warn!(target: "mcp.shared.session", "Failed to validate request: {method}");
                    let _ = out.send(invalid_request_parameters(&id));
                    continue;
                }
                if method == "initialize" {
                    // answered by the session itself, before anything else is read
                    let _ = out.send(super::handle_request(&id, &method, params.as_ref()).await);
                    initialized = true;
                    continue;
                }
                if method != "ping" && !initialized {
                    tracing::warn!(target: "mcp.shared.session", "Failed to validate request: Received request before initialization was complete");
                    let _ = out.send(invalid_request_parameters(&id));
                    continue;
                }
                let key = id_key(&id);
                let (out, finished, task_key) = (out.clone(), finished.clone(), key.clone());
                let task = ctx::spawn(async move {
                    let reply = super::handle_request(&id, &method, params.as_ref()).await;
                    let _ = out.send(reply);
                    let _ = finished.send(task_key);
                });
                in_flight.insert(key, task);
            }
            Incoming::Notification { method, params } => match method.as_str() {
                "notifications/initialized" => initialized = true,
                "notifications/cancelled" => {
                    let Some(id) =
                        params.as_ref().and_then(|p| p.get("requestId")).filter(|id| message::is_request_id(id))
                    else {
                        continue;
                    };
                    if let Some(task) = in_flight.remove(&id_key(id)) {
                        if !task.is_finished() {
                            task.abort();
                            let _ = out.send(error(id, 0, "Request cancelled", None));
                        }
                    }
                }
                _ => {}
            },
            // the server sends no request, so a response answers nothing: to the SDK that is an exception
            Incoming::Reply => {
                tracing::error!(target: "mcp.server.lowlevel.server", "Received exception from stream: Received response with an unknown request ID");
                let _ = out.send(internal_server_error());
            }
        }
    }
    // the transport closed: the requests still running are cancelled, what was answered is written out
    for (_, task) in in_flight {
        task.abort();
    }
    drop(out);
    let _ = writer.await;
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, duplex};

    async fn session(input: &str) -> Vec<Value> {
        let (mut client_out, server_in) = duplex(1 << 16);
        let (server_out, mut client_in) = duplex(1 << 20);
        let server = tokio::spawn(serve_on(server_in, server_out));
        client_out.write_all(input.as_bytes()).await.expect("write");
        drop(client_out);
        server.await.expect("the session ends with its input");
        let mut text = String::new();
        client_in.read_to_string(&mut text).await.expect("read");
        text.lines().map(|line| serde_json::from_str(line).expect("each line is one JSON message")).collect()
    }

    #[tokio::test]
    async fn only_ping_is_served_before_initialize() {
        let replies = session(concat!(
            r#"{"jsonrpc":"2.0","id":1,"method":"resources/list"}"#,
            "\n",
            r#"{"jsonrpc":"2.0","id":2,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"t","version":"0"}}}"#,
            "\n",
            r#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#,
            "\n",
            "this is not JSON\n",
            r#"{"jsonrpc":"2.0","id":"x","method":"nope"}"#,
            "\n",
        ))
        .await;
        assert_eq!(replies.len(), 4, "{replies:?}");
        assert_eq!(
            replies[0],
            json!({"jsonrpc": "2.0", "id": 1, "error": {"code": -32602, "message": "Invalid request parameters", "data": ""}})
        );
        assert_eq!(replies[1]["result"]["protocolVersion"], "2025-06-18");
        assert_eq!(replies[1]["result"]["serverInfo"], json!({"name": "kanban-mcp", "version": "1.27.0"}));
        assert_eq!(replies[2]["method"], "notifications/message");
        assert_eq!(replies[3]["id"], "x");
        assert_eq!(replies[3]["error"]["code"], -32602);
    }
}
