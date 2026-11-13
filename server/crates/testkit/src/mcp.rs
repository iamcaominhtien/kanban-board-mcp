//! MCP over HTTP: JSON-RPC 2.0 by POST to `{base}/mcp/`, stateless (no session id).

use crate::client::Client;
use serde_json::{Value, json};
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

/// A tool call's outcome.
pub struct ToolResult {
    /// The `isError` flag of the result.
    pub is_error: bool,
    /// The text content blocks joined with a newline.
    pub text: String,
    /// The whole JSON-RPC `result`.
    pub raw: Value,
}

impl ToolResult {
    /// The text parsed as JSON; panics with the text when it is not JSON.
    pub fn json(&self) -> Value {
        serde_json::from_str(&self.text).unwrap_or_else(|e| panic!("tool text is not JSON ({e}): {}", self.text))
    }
}

/// An MCP client.
#[derive(Clone)]
pub struct Mcp {
    client: Client,
    bearer: Option<String>,
    next_id: Arc<AtomicU64>,
}

impl Mcp {
    pub(crate) fn new(client: Client) -> Mcp {
        Mcp { client, bearer: None, next_id: Arc::new(AtomicU64::new(1)) }
    }

    /// Send `Authorization: Bearer <token>` (an AI run's token) with every request.
    pub fn bearer(mut self, token: &str) -> Mcp {
        self.bearer = Some(token.to_string());
        self
    }

    /// The whole JSON-RPC reply (`result` or `error` included).
    pub async fn request_raw(&self, method: &str, params: Value) -> Value {
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let body = json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params});
        let mut headers = vec![("accept", "application/json, text/event-stream"), ("content-type", "application/json")];
        let auth = self.bearer.as_ref().map(|t| format!("Bearer {t}"));
        if let Some(a) = &auth {
            headers.push(("authorization", a));
        }
        let resp = self.client.request("POST", "/mcp/", &headers, Some(serde_json::to_vec(&body).expect("json"))).await;
        let text = resp.text();
        let ctype = resp.headers.get("content-type").and_then(|v| v.to_str().ok()).unwrap_or("").to_string();
        if ctype.starts_with("text/event-stream") {
            let data: Vec<String> = text
                .replace("\r\n", "\n")
                .split("\n\n")
                .filter_map(|block| {
                    let d: Vec<String> = block
                        .lines()
                        .filter_map(|l| l.strip_prefix("data:"))
                        .map(|d| d.strip_prefix(' ').unwrap_or(d).to_string())
                        .collect();
                    (!d.is_empty()).then(|| d.join("\n"))
                })
                .collect();
            let last = data.last().unwrap_or_else(|| panic!("MCP {method}: no data in SSE reply: {text}"));
            serde_json::from_str(last).unwrap_or_else(|e| panic!("MCP {method}: bad SSE JSON ({e}): {text}"))
        } else {
            serde_json::from_str(&text)
                .unwrap_or_else(|e| panic!("MCP {method}: status {}, reply is not JSON ({e}): {text}", resp.status))
        }
    }

    /// The JSON-RPC `result`; panics on a JSON-RPC error.
    pub async fn request(&self, method: &str, params: Value) -> Value {
        let reply = self.request_raw(method, params).await;
        if let Some(err) = reply.get("error") {
            panic!("MCP {method} failed: {err}");
        }
        reply.get("result").cloned().unwrap_or_else(|| panic!("MCP {method}: no result in {reply}"))
    }

    /// `initialize` with a plain client description.
    pub async fn initialize(&self) -> Value {
        self.request(
            "initialize",
            json!({"protocolVersion": "2025-03-26", "capabilities": {},
                   "clientInfo": {"name": "testkit", "version": "0"}}),
        )
        .await
    }

    /// `tools/list`.
    pub async fn list_tools(&self) -> Value {
        self.request("tools/list", json!({})).await
    }

    /// `tools/call`.
    pub async fn call_tool(&self, name: &str, arguments: Value) -> ToolResult {
        let raw = self.request("tools/call", json!({"name": name, "arguments": arguments})).await;
        let text = raw
            .get("content")
            .and_then(Value::as_array)
            .map(|blocks| {
                blocks.iter().filter_map(|b| b.get("text").and_then(Value::as_str)).collect::<Vec<_>>().join("\n")
            })
            .unwrap_or_default();
        ToolResult { is_error: raw.get("isError").and_then(Value::as_bool).unwrap_or(false), text, raw }
    }
}
