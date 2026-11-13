//! `tools/list` and `initialize` against the snapshots exported from the Python server (`contract/mcp-tools.json`,
//! `mcp-initialize.json`, and the `-ideas` pair for a server started with `KANBAN_MCP_IDEA_TOOLS=1`): names,
//! descriptions, schemas, annotations and the instructions, in the snapshot's order of tools and of keys.
//!
//! While tools are still being ported, the Rust server lists the snapshot's entries without the tools named in
//! `kb_mcp::registry::NOT_PORTED_YET`; the Python server must list every one.
//!
//! The `-ideas` snapshots are written by `export_the_idea_tools_contract`:
//! `PARITY_TARGET=python KANBAN_WRITE_GOLDEN=1 cargo test -p kb-mcp --test mcp_tools_list export`.

mod common;

use serde_json::{Value, json};
use testkit::{Options, Target, target};

fn contract(name: &str) -> String {
    format!("{}/../../contract/{name}", env!("CARGO_MANIFEST_DIR"))
}

fn snapshot(name: &str) -> Value {
    let path = contract(name);
    let text = std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{path}: {e}"));
    serde_json::from_str(&text).expect("the snapshot parses")
}

fn with_idea_tools() -> Options {
    Options { env: vec![("KANBAN_MCP_IDEA_TOOLS".to_string(), "1".to_string())], ..Options::default() }
}

/// The snapshot's tools that the server under test must list.
fn expected_tools(name: &str) -> Vec<Value> {
    let all = snapshot(name)["tools"].as_array().expect("tools").clone();
    match target() {
        Target::Python => all,
        Target::Rust => all
            .into_iter()
            .filter(|tool| !kb_mcp::registry::NOT_PORTED_YET.contains(&tool["name"].as_str().expect("a name")))
            .collect(),
    }
}

/// Entry by entry, as text: the order of the keys counts too.
fn assert_same_tools(listed: &Value, expected: &[Value]) {
    let listed = listed["tools"].as_array().expect("tools");
    let names =
        |tools: &[Value]| tools.iter().map(|t| t["name"].as_str().unwrap_or("?").to_string()).collect::<Vec<_>>();
    assert_eq!(names(listed), names(expected));
    for (tool, expected) in listed.iter().zip(expected) {
        assert_eq!(tool.to_string(), expected.to_string(), "{}", expected["name"]);
    }
}

async fn initialize(mcp: &testkit::Mcp) -> Value {
    let params = json!({"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "contract", "version": "0"}});
    mcp.request("initialize", params).await
}

#[tokio::test]
async fn the_tool_list_is_the_snapshot() {
    let s = common::start().await;
    let listed = s.mcp().list_tools().await;
    assert_same_tools(&listed, &expected_tools("mcp-tools.json"));
    // (the Python server lists 13 tools)
    assert_eq!(snapshot("mcp-tools.json")["tools"].as_array().expect("tools").len(), 13);
}

#[tokio::test]
async fn the_initialize_reply_is_the_snapshot() {
    let s = common::start().await;
    let reply = initialize(&s.mcp()).await;
    assert_eq!(reply.to_string(), snapshot("mcp-initialize.json").to_string());
}

#[tokio::test]
async fn with_the_idea_tools_switched_on_the_list_and_the_instructions_are_the_ideas_snapshots() {
    let s = common::start_with(with_idea_tools()).await;
    let mcp = s.mcp();
    assert_same_tools(&mcp.list_tools().await, &expected_tools("mcp-tools-ideas.json"));
    assert_eq!(initialize(&mcp).await.to_string(), snapshot("mcp-initialize-ideas.json").to_string());
    // the five Idea Space tools come after the others, and the instructions gain one line about them
    let (core, ideas) = (snapshot("mcp-tools.json"), snapshot("mcp-tools-ideas.json"));
    let (core, ideas) = (core["tools"].as_array().expect("tools"), ideas["tools"].as_array().expect("tools"));
    assert_eq!(ideas.len(), core.len() + 5);
    assert_eq!(ideas[..core.len()], core[..]);
    let text = |name: &str| snapshot(name)["instructions"].as_str().expect("instructions").to_string();
    assert!(!text("mcp-initialize.json").contains("create_idea_ticket"));
    assert!(text("mcp-initialize-ideas.json").contains("create_idea_ticket"));
}

/// A run the board started sends its token with every request: the list it gets is the same (`ai_run` is always
/// listed; the tool itself refuses a call from outside a run).
#[tokio::test]
async fn the_tool_list_is_the_same_inside_a_board_run() {
    let s = common::start().await;
    let outside = s.mcp().list_tools().await;
    let inside = s.mcp().bearer("kbr_not-a-live-run").list_tools().await;
    assert_eq!(inside.to_string(), outside.to_string());
    assert_same_tools(&inside, &expected_tools("mcp-tools.json"));
}
