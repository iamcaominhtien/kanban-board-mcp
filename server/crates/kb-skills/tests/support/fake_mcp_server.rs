//! A tiny stdio MCP server with two tools, used to test the status probe of the Configuration tab
//! (`tests/fixtures/fake_mcp_server.py`, which needs the Python `mcp` SDK; this needs nothing).

use std::io::{BufRead, Write};

use serde_json::{Value, json};

const SUPPORTED: [&str; 4] = ["2024-11-05", "2025-03-26", "2025-06-18", "2025-11-25"];

fn tools() -> Value {
    json!([
        {
            "name": "ping",
            "description": "Answer pong.",
            "inputSchema": {"properties": {}, "title": "pingArguments", "type": "object"}
        },
        {
            "name": "add",
            "description": "Add two numbers.",
            "inputSchema": {
                "properties": {"a": {"title": "A", "type": "integer"}, "b": {"title": "B", "type": "integer"}},
                "required": ["a", "b"],
                "title": "addArguments",
                "type": "object"
            }
        }
    ])
}

fn call(params: &Value) -> Value {
    let args = &params["arguments"];
    let text = match params["name"].as_str() {
        Some("ping") => "pong".to_string(),
        Some("add") => (args["a"].as_i64().unwrap_or(0) + args["b"].as_i64().unwrap_or(0)).to_string(),
        _ => return json!({"content": [{"type": "text", "text": "Unknown tool"}], "isError": true}),
    };
    json!({"content": [{"type": "text", "text": text}], "isError": false})
}

fn main() {
    let stdin = std::io::stdin();
    let mut stdout = std::io::stdout();
    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        let Ok(message) = serde_json::from_str::<Value>(&line) else { continue };
        let (Some(method), Some(id)) = (message["method"].as_str(), message.get("id")) else { continue };
        let answer = match method {
            "initialize" => {
                let asked = message["params"]["protocolVersion"].as_str().unwrap_or_default();
                let version = if SUPPORTED.contains(&asked) { asked } else { SUPPORTED[3] };
                json!({
                    "protocolVersion": version,
                    "capabilities": {"experimental": {}, "tools": {"listChanged": false}},
                    "serverInfo": {"name": "fake", "version": "1.0.0"}
                })
            }
            "ping" => json!({}),
            "tools/list" => json!({"tools": tools()}),
            "tools/call" => call(&message["params"]),
            _ => {
                let error =
                    json!({"jsonrpc": "2.0", "id": id, "error": {"code": -32601, "message": "Method not found"}});
                let _ = writeln!(stdout, "{error}");
                let _ = stdout.flush();
                continue;
            }
        };
        let _ = writeln!(stdout, "{}", json!({"jsonrpc": "2.0", "id": id, "result": answer}));
        let _ = stdout.flush();
    }
}
