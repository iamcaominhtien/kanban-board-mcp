//! The MCP protocol as FastMCP 1.27 speaks it: a small JSON-RPC 2.0 server with the two transports the board uses
//! (stateless Streamable HTTP for the app, newline-delimited JSON on stdin and stdout for editors).
//!
//! The replies of the Python SDK are the contract, down to their framing, so nothing here is designed: each answer
//! is what the SDK gives for the same message (`tests/mcp_transport.rs` and `tests/mcp_stdio.rs` compare the two).

pub mod http;
pub mod json_errors;
pub mod message;
pub mod stdio;

use serde_json::{Map, Value, json};

use message::ClientRequest;

/// `mcp.types.LATEST_PROTOCOL_VERSION`: what a client asking for a version the SDK does not know is given.
pub const LATEST_PROTOCOL_VERSION: &str = "2025-11-25";
/// `mcp.types.DEFAULT_NEGOTIATED_VERSION`: assumed when a request carries no `mcp-protocol-version` header.
pub const DEFAULT_NEGOTIATED_VERSION: &str = "2025-03-26";
/// `mcp.shared.version.SUPPORTED_PROTOCOL_VERSIONS`.
pub const SUPPORTED_PROTOCOL_VERSIONS: [&str; 4] = ["2024-11-05", "2025-03-26", "2025-06-18", LATEST_PROTOCOL_VERSION];

/// `FastMCP("kanban-mcp", ...)`.
pub const SERVER_NAME: &str = "kanban-mcp";
/// The version of the `mcp` package the Python server ran on: FastMCP reports it as the server's version, and
/// clients have seen it since.
pub const SERVER_VERSION: &str = "1.27.0";

pub const PARSE_ERROR: i64 = -32700;
pub const INVALID_REQUEST: i64 = -32600;
pub const METHOD_NOT_FOUND: i64 = -32601;
pub const INVALID_PARAMS: i64 = -32602;
pub const INTERNAL_ERROR: i64 = -32603;

/// A `JSONRPCResponse`.
pub fn response(id: &Value, result: Value) -> Value {
    json!({"jsonrpc": "2.0", "id": id, "result": result})
}

/// A `JSONRPCError`; `data` is left out when there is none.
pub fn error(id: &Value, code: i64, message: &str, data: Option<Value>) -> Value {
    let mut body = Map::new();
    body.insert("code".into(), json!(code));
    body.insert("message".into(), json!(message));
    if let Some(data) = data {
        body.insert("data".into(), data);
    }
    json!({"jsonrpc": "2.0", "id": id, "error": body})
}

/// What the SDK answers when a request is not one a client may send, or comes before `initialize`.
pub fn invalid_request_parameters(id: &Value) -> Value {
    error(id, INVALID_PARAMS, "Invalid request parameters", Some(json!("")))
}

/// `ServerCapabilities` of a FastMCP server with tools, resources and prompts handlers and nothing that changes.
pub fn capabilities() -> Value {
    json!({
        "experimental": {},
        "prompts": {"listChanged": false},
        "resources": {"subscribe": false, "listChanged": false},
        "tools": {"listChanged": false},
    })
}

/// The `InitializeResult`: the client's protocol version when the SDK knows it, else the newest.
pub fn initialize_result(requested: Option<&str>) -> Value {
    let version = match requested {
        Some(version) if SUPPORTED_PROTOCOL_VERSIONS.contains(&version) => version,
        _ => LATEST_PROTOCOL_VERSION,
    };
    json!({
        "protocolVersion": version,
        "capabilities": capabilities(),
        "serverInfo": {"name": SERVER_NAME, "version": SERVER_VERSION},
        "instructions": crate::instructions::mcp_instructions(),
    })
}

/// Answer one request (the session is initialized, or the transport is stateless): the whole JSON-RPC reply.
pub async fn handle_request(id: &Value, method: &str, params: Option<&Map<String, Value>>) -> Value {
    let Some(request) = message::client_request(method, params) else {
        tracing::warn!(target: "mcp.shared.session", "Failed to validate request: {method}");
        return invalid_request_parameters(id);
    };
    match request {
        ClientRequest::Ping => response(id, json!({})),
        ClientRequest::Initialize { protocol_version } => response(id, initialize_result(protocol_version.as_deref())),
        ClientRequest::ListTools => response(id, json!({"tools": crate::registry::list_tools()})),
        ClientRequest::CallTool { name, arguments } => response(id, crate::registry::call_tool(&name, arguments).await),
        ClientRequest::ListResources => response(id, json!({"resources": []})),
        ClientRequest::ListResourceTemplates => response(id, json!({"resourceTemplates": []})),
        ClientRequest::ListPrompts => response(id, json!({"prompts": []})),
        // FastMCP registers these handlers and the server has no resource and no prompt: the handler raises, and
        // the SDK answers an exception with code 0 and its text
        ClientRequest::ReadResource { uri } => error(id, 0, &format!("Unknown resource: {uri}"), None),
        ClientRequest::GetPrompt { name } => error(id, 0, &format!("Unknown prompt: {name}"), None),
        ClientRequest::Unhandled => error(id, METHOD_NOT_FOUND, "Method not found", None),
    }
}
