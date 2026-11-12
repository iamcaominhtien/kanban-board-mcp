//! The tool list of the MCP server and the call of a tool: what `registry.py` builds on a FastMCP server, and what
//! FastMCP then does with it.
//!
//! - **The list.** What an agent reads about a tool (name, description, input schema, output schema, annotations)
//!   is the contract, so it is not rebuilt: it is served from the snapshot exported from the Python server
//!   (`contract/mcp-tools.json`, or `mcp-tools-ideas.json` when the Idea Space tools are switched on), in its order,
//!   for the tools that are registered in `tools::CORE_TOOL_TABLE` / `IDEA_TOOL_TABLE`. A tool of the snapshot that
//!   has no function yet is named in `NOT_PORTED_YET`; a test fails when the three disagree.
//! - **A call.** The arguments are validated against the tool's input schema as FastMCP and Pydantic do
//!   (`validation`), the function runs, and its value becomes the result FastMCP builds: text blocks, plus
//!   `structuredContent` for a tool with an output schema; a failure is a result with `isError` and
//!   `Error executing tool <name>: <message>`.

use std::sync::LazyLock;

use futures::future::BoxFuture;
use serde_json::{Map, Value, json};

use crate::common::{ToolError, ToolResult};
use crate::settings::ideas_enabled;
use crate::tools::{CORE_TOOL_TABLE, IDEA_TOOL_TABLE};
use crate::validation::validate_arguments;

/// A tool function: the validated arguments (every parameter of the schema, a default where one was left out) to
/// the value FastMCP turns into the result.
pub type ToolFn = fn(Map<String, Value>) -> BoxFuture<'static, ToolResult>;

/// One registered tool: its name in the snapshot, and its function.
#[derive(Clone, Copy)]
pub struct Tool {
    pub name: &'static str,
    pub run: ToolFn,
}

/// Tools of the Python server that are not ported yet: they are left out of `tools/list` and a call answers
/// `Unknown tool`. A task that ports one removes its name here and adds it to the table in `tools/mod.rs`.
pub const NOT_PORTED_YET: [&str; 0] = [];

const SNAPSHOT: &str = include_str!("../../../contract/mcp-tools.json");
const SNAPSHOT_IDEAS: &str = include_str!("../../../contract/mcp-tools-ideas.json");

fn parse_snapshot(text: &str) -> Vec<Value> {
    let parsed: Value = serde_json::from_str(text).expect("the embedded tool snapshot is the JSON the export wrote");
    parsed.get("tools").and_then(Value::as_array).cloned().unwrap_or_default()
}

/// The entries of the snapshot (`include_ideas`: the one exported with the Idea Space tools on).
pub fn snapshot(include_ideas: bool) -> &'static [Value] {
    static CORE: LazyLock<Vec<Value>> = LazyLock::new(|| parse_snapshot(SNAPSHOT));
    static IDEAS: LazyLock<Vec<Value>> = LazyLock::new(|| parse_snapshot(SNAPSHOT_IDEAS));
    if include_ideas { &IDEAS } else { &CORE }
}

/// The registered tools: the core table, plus the Idea Space ones when they are switched on.
pub fn registered(include_ideas: bool) -> Vec<Tool> {
    let mut tools = CORE_TOOL_TABLE.to_vec();
    if include_ideas {
        tools.extend_from_slice(IDEA_TOOL_TABLE);
    }
    tools
}

/// `tools/list` for a server with or without the Idea Space tools: the snapshot's entries of the registered tools.
pub fn list_tools_for(include_ideas: bool) -> Vec<Value> {
    let tools = registered(include_ideas);
    snapshot(include_ideas)
        .iter()
        .filter(|entry| tools.iter().any(|tool| entry.get("name").and_then(Value::as_str) == Some(tool.name)))
        .cloned()
        .collect()
}

/// `tools/list` of this server (the list is the same for every caller, also inside a run the board started:
/// `ai_run` is always listed and refuses a call from outside a run itself).
pub fn list_tools() -> Vec<Value> {
    list_tools_for(ideas_enabled())
}

fn find(name: &str, include_ideas: bool) -> Option<(Tool, &'static Value)> {
    let tool = registered(include_ideas).into_iter().find(|tool| tool.name == name)?;
    let entry = snapshot(include_ideas).iter().find(|e| e.get("name").and_then(Value::as_str) == Some(name))?;
    Some((tool, entry))
}

/// FastMCP's `_convert_to_content`: nothing for `None`, a block per item of a list, text as it is, anything else as
/// indented JSON.
pub fn convert_to_content(result: &Value) -> Vec<Value> {
    match result {
        Value::Null => Vec::new(),
        Value::Array(items) => items.iter().flat_map(convert_to_content).collect(),
        Value::String(text) => vec![json!({"type": "text", "text": text})],
        // `pydantic_core.to_json(result, indent=2)`
        other => {
            let text = serde_json::to_string_pretty(other).unwrap_or_else(|_| other.to_string());
            vec![json!({"type": "text", "text": text})]
        }
    }
}

/// A `CallToolResult` for a failure: the message is all the agent gets.
fn error_result(message: &str) -> Value {
    json!({"content": [{"type": "text", "text": message}], "isError": true})
}

/// `sorted(arguments)` as Python prints the list: the names of the arguments, never their values.
fn argument_names(arguments: &Map<String, Value>) -> String {
    let mut names: Vec<&String> = arguments.keys().collect();
    names.sort();
    format!("[{}]", names.iter().map(|n| kb_base::pytext::repr(n)).collect::<Vec<_>>().join(", "))
}

/// `tools/call` of this server: the `CallToolResult`.
pub async fn call_tool(name: &str, arguments: Map<String, Value>) -> Value {
    call_tool_for(name, arguments, ideas_enabled()).await
}

/// `call_tool` for a server with or without the Idea Space tools.
///
/// FastMCP turns a failing tool into an error reply for the agent and logs nothing, so a bug in a tool is invisible
/// on the server side. Every failure is logged here (`registry._log_tool_failures`): a bad call from the agent
/// (an unknown tool, invalid arguments, or an error a tool raises on purpose such as "ticket not found") as a
/// warning, anything else raised inside a tool as an error. Argument values are not logged.
pub async fn call_tool_for(name: &str, arguments: Map<String, Value>, include_ideas: bool) -> Value {
    let names = argument_names(&arguments);
    let Some((tool, entry)) = find(name, include_ideas) else {
        let message = format!("Unknown tool: {name}");
        tracing::warn!(target: "kanban_mcp.registry", "MCP tool {name} rejected (arguments: {names}): {message}");
        return error_result(&message);
    };
    let outcome = match validate_arguments(&format!("{name}Arguments"), &entry["inputSchema"], &arguments) {
        Ok(validated) => (tool.run)(validated).await,
        Err(text) => Err(ToolError::Value(text)),
    };
    match outcome {
        Ok(result) => {
            let mut reply = Map::new();
            reply.insert("content".into(), Value::Array(convert_to_content(&result)));
            // every output schema of the snapshot is FastMCP's wrapper for a return type that is not an object
            // of known fields: `{"result": <the value>}`
            if entry.get("outputSchema").is_some() {
                reply.insert("structuredContent".into(), json!({"result": result}));
            }
            reply.insert("isError".into(), json!(false));
            Value::Object(reply)
        }
        Err(err) => {
            let message = format!("Error executing tool {name}: {err}");
            match &err {
                ToolError::Value(_) => {
                    tracing::warn!(target: "kanban_mcp.registry", "MCP tool {name} rejected (arguments: {names}): {message}");
                }
                ToolError::Other(cause) => {
                    tracing::error!(target: "kanban_mcp.registry", "MCP tool {name} failed (arguments: {names}): {cause}");
                }
            }
            error_result(&message)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn names(entries: &[Value]) -> Vec<&str> {
        entries.iter().filter_map(|e| e.get("name").and_then(Value::as_str)).collect()
    }

    /// Every tool of the snapshot is either registered or named as not ported yet, and nothing else is.
    #[test]
    fn the_registered_tools_and_the_not_ported_ones_are_the_snapshot() {
        for include_ideas in [false, true] {
            let snapshot_names = names(snapshot(include_ideas));
            let registered = registered(include_ideas);
            for tool in &registered {
                assert!(snapshot_names.contains(&tool.name), "{} is registered and not in the snapshot", tool.name);
                assert!(
                    !NOT_PORTED_YET.contains(&tool.name),
                    "{} is registered: remove it from NOT_PORTED_YET",
                    tool.name
                );
            }
            for name in &snapshot_names {
                let is_registered = registered.iter().any(|tool| tool.name == *name);
                assert!(
                    is_registered || NOT_PORTED_YET.contains(name),
                    "{name} is in the snapshot: register it or name it in NOT_PORTED_YET"
                );
            }
            let mut seen = std::collections::HashSet::new();
            assert!(registered.iter().all(|tool| seen.insert(tool.name)), "a tool is registered twice");
        }
        for name in NOT_PORTED_YET {
            assert!(names(snapshot(true)).contains(&name), "{name} is in NOT_PORTED_YET and in no snapshot");
        }
        // the Idea Space tools are exactly what the second snapshot adds, after the others
        let (core, ideas) = (names(snapshot(false)), names(snapshot(true)));
        assert_eq!(&ideas[..core.len()], &core[..]);
        assert_eq!(snapshot(true)[..core.len()], snapshot(false)[..]);
        assert_eq!(
            &ideas[core.len()..],
            [
                "list_idea_tickets",
                "get_idea_ticket",
                "list_idea_assumptions",
                "get_idea_activity_trail",
                "create_idea_ticket"
            ]
        );
    }

    #[test]
    fn the_list_is_the_snapshot_of_the_registered_tools_in_its_order() {
        let listed = list_tools_for(false);
        let expected: Vec<Value> = snapshot(false)
            .iter()
            .filter(|e| !NOT_PORTED_YET.contains(&e["name"].as_str().unwrap_or_default()))
            .cloned()
            .collect();
        assert_eq!(listed, expected);
        assert!(!listed.is_empty());
    }

    #[test]
    fn results_become_content_as_fastmcp_builds_it() {
        assert_eq!(convert_to_content(&Value::Null), Vec::<Value>::new());
        assert_eq!(convert_to_content(&json!([])), Vec::<Value>::new());
        assert_eq!(convert_to_content(&json!("plain")), [json!({"type": "text", "text": "plain"})]);
        assert_eq!(
            convert_to_content(&json!({"ok": true, "n": [1, 2.0], "e": {}, "t": "é"})),
            [
                json!({"type": "text", "text": "{\n  \"ok\": true,\n  \"n\": [\n    1,\n    2.0\n  ],\n  \"e\": {},\n  \"t\": \"é\"\n}"})
            ]
        );
        // a list is one block per item, lists inside it too
        assert_eq!(
            convert_to_content(&json!([{"a": 1}, "x", [3, null]])),
            [
                json!({"type": "text", "text": "{\n  \"a\": 1\n}"}),
                json!({"type": "text", "text": "x"}),
                json!({"type": "text", "text": "3"}),
            ]
        );
    }

    #[tokio::test]
    async fn an_unknown_tool_and_bad_arguments_are_error_results() {
        let unknown = call_tool_for("no_such_tool", Map::new(), false).await;
        assert_eq!(
            unknown,
            json!({"content": [{"type": "text", "text": "Unknown tool: no_such_tool"}], "isError": true})
        );
        let mut arguments = Map::new();
        arguments.insert("field".into(), json!(1));
        let refused = call_tool_for("get_projects", arguments, false).await;
        assert_eq!(
            refused["content"][0]["text"],
            "Error executing tool get_projects: 1 validation error for get_projectsArguments\nfield\n  Extra inputs \
             are not permitted [type=extra_forbidden, input_value=1, input_type=int]\n    For further information \
             visit https://errors.pydantic.dev/2.12/v/extra_forbidden"
        );
        assert_eq!(refused["isError"], true);
        assert_eq!(argument_names(json!({"b": 1, "a": "secret"}).as_object().expect("an object")), "['a', 'b']");
    }
}
