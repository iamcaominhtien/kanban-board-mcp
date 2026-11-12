//! The transport of the MCP endpoint, request by request: what the server answers to each raw HTTP request (status,
//! the headers that matter, the body with its event-stream framing). The answers of the Python server (FastMCP 1.27
//! behind `app.mount("/mcp", ...)`, stateless) are kept in `contract/golden/mcp_transport.json`; both servers are
//! compared with it, so this file is the specification of the transport. To record it again after adding a case:
//! `PARITY_TARGET=python KANBAN_WRITE_GOLDEN=1 cargo test -p kb-mcp --test mcp_transport`.

mod common;

use common::{MCP_HEADERS, RawReply, check_golden, raw};
use serde_json::{Map, Value, json};


/// The headers that are part of the contract (the others are the HTTP server's own: `date`, `server`).
const KEPT_HEADERS: [&str; 8] = [
    "content-type",
    "cache-control",
    "connection",
    "x-accel-buffering",
    "allow",
    "mcp-session-id",
    "content-length",
    "transfer-encoding",
];

struct Case {
    name: &'static str,
    method: &'static str,
    path: &'static str,
    headers: Vec<(&'static str, &'static str)>,
    body: Option<&'static str>,
    /// The reply is a stream that stays open: only its head is read.
    open_stream: bool,
}

fn post(name: &'static str, body: &'static str) -> Case {
    Case { name, method: "POST", path: "/mcp/", headers: MCP_HEADERS.to_vec(), body: Some(body), open_stream: false }
}

fn with(name: &'static str, headers: &[(&'static str, &'static str)], body: &'static str) -> Case {
    Case { name, method: "POST", path: "/mcp/", headers: headers.to_vec(), body: Some(body), open_stream: false }
}

fn plus(name: &'static str, extra: &[(&'static str, &'static str)], body: &'static str) -> Case {
    let mut headers = MCP_HEADERS.to_vec();
    headers.extend_from_slice(extra);
    Case { name, method: "POST", path: "/mcp/", headers, body: Some(body), open_stream: false }
}

fn other(
    name: &'static str,
    method: &'static str,
    path: &'static str,
    headers: &[(&'static str, &'static str)],
) -> Case {
    Case { name, method, path, headers: headers.to_vec(), body: None, open_stream: false }
}

const PING: &str = r#"{"jsonrpc":"2.0","id":1,"method":"ping"}"#;
const JSON: (&str, &str) = ("Content-Type", "application/json");
const BOTH: (&str, &str) = ("Accept", "application/json, text/event-stream");

fn cases() -> Vec<Case> {
    vec![
        // --- initialize: the version is the client's when the SDK knows it, else the newest
        post(
            "initialize 2025-06-18",
            r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"t","version":"0"}}}"#,
        ),
        post(
            "initialize 2024-11-05",
            r#"{"jsonrpc":"2.0","id":"a","method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"t","version":"0"}}}"#,
        ),
        post(
            "initialize 2025-03-26",
            r#"{"jsonrpc":"2.0","id":2,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"t","version":"0"}}}"#,
        ),
        post(
            "initialize 2025-11-25",
            r#"{"jsonrpc":"2.0","id":2,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"t","version":"0"}}}"#,
        ),
        post(
            "initialize unknown version",
            r#"{"jsonrpc":"2.0","id":2,"method":"initialize","params":{"protocolVersion":"1999-01-01","capabilities":{},"clientInfo":{"name":"t","version":"0"}}}"#,
        ),
        post(
            "initialize version as a number",
            r#"{"jsonrpc":"2.0","id":2,"method":"initialize","params":{"protocolVersion":20250618,"capabilities":{},"clientInfo":{"name":"t","version":"0"}}}"#,
        ),
        post("initialize without params", r#"{"jsonrpc":"2.0","id":3,"method":"initialize"}"#),
        post(
            "initialize without clientInfo",
            r#"{"jsonrpc":"2.0","id":3,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{}}}"#,
        ),
        post(
            "initialize without capabilities",
            r#"{"jsonrpc":"2.0","id":3,"method":"initialize","params":{"protocolVersion":"2025-06-18","clientInfo":{"name":"t","version":"0"}}}"#,
        ),
        post(
            "initialize with extra fields",
            r#"{"jsonrpc":"2.0","id":3,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{"roots":{"listChanged":true},"sampling":{}},"clientInfo":{"name":"t","version":"0","title":"T"},"more":1}}"#,
        ),
        plus(
            "initialize with a bad protocol header",
            &[("mcp-protocol-version", "nope")],
            r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"t","version":"0"}}}"#,
        ),
        // --- the methods served
        post("ping", PING),
        post("ping with params", r#"{"jsonrpc":"2.0","id":1,"method":"ping","params":{"_meta":{"progressToken":1}}}"#),
        post("ping with a string id", r#"{"jsonrpc":"2.0","id":"abc","method":"ping"}"#),
        post("ping with id 0", r#"{"jsonrpc":"2.0","id":0,"method":"ping"}"#),
        post("ping with a negative id", r#"{"jsonrpc":"2.0","id":-7,"method":"ping"}"#),
        post("ping with a float id", r#"{"jsonrpc":"2.0","id":1.5,"method":"ping"}"#),
        post("ping with a whole float id", r#"{"jsonrpc":"2.0","id":2.0,"method":"ping"}"#),
        post("ping with a null id", r#"{"jsonrpc":"2.0","id":null,"method":"ping"}"#),
        post("ping with a boolean id", r#"{"jsonrpc":"2.0","id":true,"method":"ping"}"#),
        post("ping with an empty string id", r#"{"jsonrpc":"2.0","id":"","method":"ping"}"#),
        post("ping with a numeric string id", r#"{"jsonrpc":"2.0","id":"12","method":"ping"}"#),
        post("ping with extra members", r#"{"jsonrpc":"2.0","id":1,"method":"ping","extra":true}"#),
        post("ping with params as a list", r#"{"jsonrpc":"2.0","id":1,"method":"ping","params":[1]}"#),
        post("ping with params null", r#"{"jsonrpc":"2.0","id":1,"method":"ping","params":null}"#),
        post("resources/list", r#"{"jsonrpc":"2.0","id":4,"method":"resources/list"}"#),
        post(
            "resources/list with a cursor",
            r#"{"jsonrpc":"2.0","id":4,"method":"resources/list","params":{"cursor":"x"}}"#,
        ),
        post("resources/templates/list", r#"{"jsonrpc":"2.0","id":5,"method":"resources/templates/list","params":{}}"#),
        post("prompts/list", r#"{"jsonrpc":"2.0","id":6,"method":"prompts/list","params":{}}"#),
        post("resources/read", r#"{"jsonrpc":"2.0","id":7,"method":"resources/read","params":{"uri":"file:///x"}}"#),
        post("resources/read without a uri", r#"{"jsonrpc":"2.0","id":7,"method":"resources/read","params":{}}"#),
        post("prompts/get", r#"{"jsonrpc":"2.0","id":8,"method":"prompts/get","params":{"name":"x"}}"#),
        post(
            "resources/subscribe",
            r#"{"jsonrpc":"2.0","id":9,"method":"resources/subscribe","params":{"uri":"file:///x"}}"#,
        ),
        post(
            "resources/unsubscribe",
            r#"{"jsonrpc":"2.0","id":9,"method":"resources/unsubscribe","params":{"uri":"file:///x"}}"#,
        ),
        post("logging/setLevel", r#"{"jsonrpc":"2.0","id":10,"method":"logging/setLevel","params":{"level":"info"}}"#),
        post(
            "completion/complete",
            r#"{"jsonrpc":"2.0","id":11,"method":"completion/complete","params":{"ref":{"type":"ref/prompt","name":"x"},"argument":{"name":"a","value":"b"}}}"#,
        ),
        post("tasks/list", r#"{"jsonrpc":"2.0","id":11,"method":"tasks/list"}"#),
        post("tasks/get", r#"{"jsonrpc":"2.0","id":11,"method":"tasks/get","params":{"taskId":"x"}}"#),
        post("unknown method", r#"{"jsonrpc":"2.0","id":12,"method":"foo/bar"}"#),
        post("unknown method with a string id", r#"{"jsonrpc":"2.0","id":"q","method":"tools/nope","params":{}}"#),
        post("empty method", r#"{"jsonrpc":"2.0","id":12,"method":""}"#),
        post("a server-side method", r#"{"jsonrpc":"2.0","id":12,"method":"roots/list"}"#),
        // --- tools/call as far as the protocol goes (the tools have their own tests)
        post(
            "tools/call unknown tool",
            r#"{"jsonrpc":"2.0","id":13,"method":"tools/call","params":{"name":"no_such_tool","arguments":{}}}"#,
        ),
        post("tools/call without params", r#"{"jsonrpc":"2.0","id":14,"method":"tools/call"}"#),
        post(
            "tools/call without a name",
            r#"{"jsonrpc":"2.0","id":14,"method":"tools/call","params":{"arguments":{}}}"#,
        ),
        post(
            "tools/call with a name that is not text",
            r#"{"jsonrpc":"2.0","id":14,"method":"tools/call","params":{"name":5}}"#,
        ),
        post(
            "tools/call with arguments as a list",
            r#"{"jsonrpc":"2.0","id":14,"method":"tools/call","params":{"name":"get_projects","arguments":[]}}"#,
        ),
        post(
            "tools/call with arguments null",
            r#"{"jsonrpc":"2.0","id":14,"method":"tools/call","params":{"name":"get_projects","arguments":null}}"#,
        ),
        post(
            "tools/call without arguments",
            r#"{"jsonrpc":"2.0","id":14,"method":"tools/call","params":{"name":"get_projects"}}"#,
        ),
        post(
            "tools/call with a task",
            r#"{"jsonrpc":"2.0","id":14,"method":"tools/call","params":{"name":"get_projects","arguments":{},"task":{"ttl":5}}}"#,
        ),
        post(
            "tools/list with a cursor",
            r#"{"jsonrpc":"2.0","id":15,"method":"tools/list","params":{"cursor":"zzz"}}"#,
        ),
        post(
            "tools/list with a cursor that is not text",
            r#"{"jsonrpc":"2.0","id":15,"method":"tools/list","params":{"cursor":5}}"#,
        ),
        // --- notifications and responses: accepted, no reply
        post("notifications/initialized", r#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#),
        post(
            "notifications/cancelled",
            r#"{"jsonrpc":"2.0","method":"notifications/cancelled","params":{"requestId":1}}"#,
        ),
        post("unknown notification", r#"{"jsonrpc":"2.0","method":"notifications/whatever","params":{"a":1}}"#),
        post("a method without id that is a request", r#"{"jsonrpc":"2.0","method":"tools/list"}"#),
        post("a response", r#"{"jsonrpc":"2.0","id":1,"result":{}}"#),
        post("an error response", r#"{"jsonrpc":"2.0","id":1,"error":{"code":-1,"message":"x"}}"#),
        // --- bodies that are not a JSON-RPC message
        post("empty body", ""),
        post("not JSON", "hello"),
        post("truncated JSON", r#"{"jsonrpc":"2.0","id":1,"#),
        post("JSON then more", r#"{"jsonrpc":"2.0","id":1,"method":"ping"} x"#),
        post("single quotes", "{'jsonrpc':'2.0'}"),
        post("trailing comma", r#"{"jsonrpc":"2.0","id":1,"method":"ping",}"#),
        post("missing colon", r#"{"jsonrpc" "2.0"}"#),
        post("missing comma", r#"{"jsonrpc":"2.0" "id":1}"#),
        post("unterminated string", r#"{"jsonrpc":"2.0"#),
        post("bad escape", r#"{"jsonrpc":"2.\x"}"#),
        post("list not closed", "[1,"),
        post("list with a trailing comma", "[1,]"),
        post("whitespace only", "  \n "),
        post("a number", "5"),
        post("a string", r#""ping""#),
        post("null", "null"),
        post("empty object", "{}"),
        post("empty list", "[]"),
        post("a batch", r#"[{"jsonrpc":"2.0","id":1,"method":"ping"},{"jsonrpc":"2.0","id":2,"method":"ping"}]"#),
        post("no jsonrpc member", r#"{"id":1,"method":"ping"}"#),
        post("jsonrpc 1.0", r#"{"jsonrpc":"1.0","id":1,"method":"ping"}"#),
        post("method is not text", r#"{"jsonrpc":"2.0","id":1,"method":5}"#),
        post("id only", r#"{"jsonrpc":"2.0","id":1}"#),
        post("id is an object", r#"{"jsonrpc":"2.0","id":{},"method":"ping"}"#),
        post("params is text", r#"{"jsonrpc":"2.0","id":1,"method":"ping","params":"x"}"#),
        // --- headers
        with("no Accept", &[JSON], PING),
        with("Accept json only", &[("Accept", "application/json"), JSON], PING),
        with("Accept event-stream only", &[("Accept", "text/event-stream"), JSON], PING),
        with("Accept anything", &[("Accept", "*/*"), JSON], PING),
        with(
            "Accept with parameters",
            &[("Accept", "text/event-stream;q=0.9 , application/json; charset=utf-8"), JSON],
            PING,
        ),
        with("Accept in upper case", &[("Accept", "APPLICATION/JSON, TEXT/EVENT-STREAM"), JSON], PING),
        with("no Content-Type", &[BOTH], PING),
        with("Content-Type text/plain", &[BOTH, ("Content-Type", "text/plain")], PING),
        with("Content-Type with a charset", &[BOTH, ("Content-Type", "application/json; charset=utf-8")], PING),
        with("Content-Type in upper case", &[BOTH, ("Content-Type", "Application/JSON")], PING),
        with("Content-Type application/jsonx", &[BOTH, ("Content-Type", "application/jsonx")], PING),
        with("Content-Type application/json-rpc", &[BOTH, ("Content-Type", "application/json-rpc")], PING),
        with("no Accept and no Content-Type", &[], PING),
        plus("a session id", &[("mcp-session-id", "abc123")], PING),
        plus("protocol header 2025-06-18", &[("mcp-protocol-version", "2025-06-18")], PING),
        plus("protocol header 2025-11-25", &[("mcp-protocol-version", "2025-11-25")], PING),
        plus("protocol header unknown", &[("mcp-protocol-version", "2020-01-01")], PING),
        plus("protocol header empty", &[("mcp-protocol-version", "")], PING),
        plus(
            "protocol header unknown on a notification",
            &[("mcp-protocol-version", "x")],
            r#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#,
        ),
        plus("protocol header unknown on bad JSON", &[("mcp-protocol-version", "x")], "nope"),
        plus("Host localhost", &[("Host", "localhost:1234")], PING),
        plus("Host ::1", &[("Host", "[::1]:8000")], PING),
        plus("Host without a port", &[("Host", "127.0.0.1")], PING),
        plus("Host elsewhere", &[("Host", "example.com")], PING),
        plus("Host elsewhere with a port", &[("Host", "evil.test:8000")], PING),
        plus("Origin local", &[("Origin", "http://localhost:5173")], PING),
        plus("Origin 127.0.0.1", &[("Origin", "http://127.0.0.1:9")], PING),
        plus("Origin without a port", &[("Origin", "http://localhost")], PING),
        plus("Origin https local", &[("Origin", "https://localhost:5173")], PING),
        plus("Origin elsewhere", &[("Origin", "http://evil.test")], PING),
        plus("Origin null", &[("Origin", "null")], PING),
        plus("a bearer token on ping", &[("Authorization", "Bearer kbr_nope")], PING),
        plus("Last-Event-ID", &[("Last-Event-ID", "5")], PING),
        with(
            "Host elsewhere and a bad Content-Type",
            &[("Host", "example.com"), BOTH, ("Content-Type", "text/plain")],
            PING,
        ),
        with("Host elsewhere and no Accept", &[("Host", "example.com"), JSON], PING),
        with("no Accept and bad JSON", &[JSON], "nope"),
        with("jsonx and no Accept", &[("Content-Type", "application/jsonx")], PING),
        // --- other methods and paths
        other("GET", "GET", "/mcp/", &[]),
        other("GET accepting json", "GET", "/mcp/", &[("Accept", "application/json")]),
        Case {
            name: "GET accepting an event stream",
            method: "GET",
            path: "/mcp/",
            headers: vec![("Accept", "text/event-stream")],
            body: None,
            open_stream: true,
        },
        other(
            "GET event stream with a bad protocol header",
            "GET",
            "/mcp/",
            &[("Accept", "text/event-stream"), ("mcp-protocol-version", "x")],
        ),
        other(
            "GET event stream from another host",
            "GET",
            "/mcp/",
            &[("Accept", "text/event-stream"), ("Host", "example.com")],
        ),
        other("GET with a query", "GET", "/mcp/?a=1", &[]),
        other("DELETE", "DELETE", "/mcp/", &[]),
        other("DELETE with a session id", "DELETE", "/mcp/", &[("mcp-session-id", "abc")]),
        other("PUT", "PUT", "/mcp/", &[JSON]),
        other("PATCH", "PATCH", "/mcp/", &[JSON]),
        other("HEAD", "HEAD", "/mcp/", &[]),
        other("OPTIONS", "OPTIONS", "/mcp/", &[]),
        other("GET below", "GET", "/mcp/anything", &[]),
        other("GET deeper", "GET", "/mcp/a/b", &[]),
        Case {
            name: "POST below",
            method: "POST",
            path: "/mcp/anything",
            headers: MCP_HEADERS.to_vec(),
            body: Some(PING),
            open_stream: false,
        },
        Case {
            name: "POST double slash",
            method: "POST",
            path: "/mcp//",
            headers: MCP_HEADERS.to_vec(),
            body: Some(PING),
            open_stream: false,
        },
        Case {
            name: "POST with a query",
            method: "POST",
            path: "/mcp/?x=1",
            headers: MCP_HEADERS.to_vec(),
            body: Some(PING),
            open_stream: false,
        },
        Case {
            name: "POST without the slash",
            method: "POST",
            path: "/mcp",
            headers: MCP_HEADERS.to_vec(),
            body: Some(PING),
            open_stream: false,
        },
    ]
}

fn kept(reply: &RawReply) -> Value {
    let mut headers = Map::new();
    for (name, value) in &reply.headers {
        if KEPT_HEADERS.contains(&name.as_str()) {
            headers.insert(name.clone(), json!(value));
        }
    }
    // the tool list is long, and shorter while tools are still being ported: `mcp_tools_list.rs` compares it with the
    // snapshot; here only its framing counts
    let body = match reply.body.split_once(r#""result":{"tools":["#) {
        Some((head, rest)) if rest.ends_with("]}}\r\n\r\n") => format!("{head}\"result\":{{\"tools\":[<the tools>]}}}}\r\n\r\n"),
        _ => reply.body.clone(),
    };
    json!({"status": reply.status, "headers": headers, "body": body})
}

#[tokio::test]
async fn the_transport_answers_as_fastmcp_does() {
    let s = common::start().await;
    let mut got = Map::new();
    for case in cases() {
        let reply =
            raw(s.port(), case.method, case.path, &case.headers, case.body.map(str::as_bytes), case.open_stream).await;
        assert!(got.insert(case.name.to_string(), kept(&reply)).is_none(), "two cases named {}", case.name);
    }
    check_golden("mcp_transport.json", &got);
}
