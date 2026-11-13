//! The argument validator against Pydantic itself: calls that FastMCP refuses before the tool runs, for every kind
//! of parameter the tools have (text, flags, integers with limits, numbers, lists, objects, allowed values, required
//! and unknown arguments, several mistakes at once), over the schemas of **all** the Python server's tools, ported
//! or not. The texts the Python server answers are kept in `contract/golden/mcp_validation.json`.
//!
//! Whatever the target, the Rust validator (`kb_mcp::validation`, driven by the tool's input schema from the
//! snapshot) must produce the golden text for every case. With `PARITY_TARGET=python` the server is asked too (add
//! `KANBAN_WRITE_GOLDEN=1` to record the file again after adding a case). No case is a valid call, so no tool runs.

mod common;

use common::check_golden;
use serde_json::{Map, Value, json};
use testkit::{Target, target};

fn cases() -> Vec<(&'static str, &'static str, Value)> {
    vec![
        // --- required and unknown
        ("required: one missing", "list_tickets", json!({})),
        ("required: two missing", "ticket_items", json!({})),
        ("required: two missing and an unknown argument", "ticket_branches", json!({"branch": "x", "nope": true})),
        ("required: null is not text", "list_tickets", json!({"project_id": null})),
        (
            "required: missing, with a long input",
            "get_ticket",
            json!({"view": "full", "activity_limit": 5, "comment_ids": ["0123456789abcdef", "fedcba9876543210"]}),
        ),
        ("unknown: after the errors of known ones", "list_tickets", json!({"zzz": 1, "project_id": 7, "aaa": null})),
        // --- text
        ("text: a number", "get_ticket", json!({"ticket_id": 12})),
        ("text: a list in text stays text for plain text", "get_ticket", json!({"ticket_id": "[1]", "view": "nope"})),
        ("text: nullable given a number", "manage_ticket", json!({"action": "update", "title": 5})),
        ("text: nullable given a float", "manage_ticket", json!({"action": "update", "title": 1.0})),
        ("text: nullable given a flag", "manage_ticket", json!({"action": "update", "title": false})),
        // --- flags
        ("flag: a word it does not know", "list_tickets", json!({"project_id": "p", "include_wont_do": "maybe"})),
        ("flag: null where none is allowed", "list_tickets", json!({"project_id": "p", "detail": null})),
        ("flag: a number that is not 0 or 1", "list_tickets", json!({"project_id": "p", "detail": 3})),
        ("flag: a negative number", "list_tickets", json!({"project_id": "p", "detail": -1})),
        ("flag: a float", "list_tickets", json!({"project_id": "p", "pending": 0.5})),
        ("flag: an object", "list_tickets", json!({"project_id": "p", "reopened": {"a": 1}})),
        ("flag: an object in text", "list_tickets", json!({"project_id": "p", "reopened": "{\"a\": 1}"})),
        ("flag: empty text", "list_tickets", json!({"project_id": "p", "pending": ""})),
        // --- integers
        ("int: below the minimum", "list_tickets", json!({"project_id": "p", "limit": 0})),
        ("int: above the maximum", "list_tickets", json!({"project_id": "p", "limit": 501})),
        ("int: below the minimum, in text", "list_tickets", json!({"project_id": "p", "limit": "0"})),
        ("int: above the maximum, as a float", "list_tickets", json!({"project_id": "p", "limit": 900.0})),
        ("int: negative offset", "list_tickets", json!({"project_id": "p", "offset": -1})),
        ("int: text that is no number", "list_tickets", json!({"project_id": "p", "limit": "abc"})),
        ("int: text with a fraction", "list_tickets", json!({"project_id": "p", "limit": "12.5"})),
        ("int: empty text", "list_tickets", json!({"project_id": "p", "limit": ""})),
        ("int: a fraction", "list_tickets", json!({"project_id": "p", "limit": 1.5})),
        ("int: a list", "list_tickets", json!({"project_id": "p", "limit": [1]})),
        ("int: null where none is allowed", "list_tickets", json!({"project_id": "p", "limit": null})),
        ("int: an object", "board_wait", json!({"timeout_s": {"s": 1}})),
        ("int: nullable, a fraction", "board_wait", json!({"since": 2.5})),
        ("int: nullable, text", "board_wait", json!({"since": "soon"})),
        ("int: nullable with a maximum", "get_ticket", json!({"ticket_id": "T-1", "activity_limit": 1001})),
        (
            "int: nullable with a minimum",
            "ticket_branches",
            json!({"ticket_id": "T-1", "action": "update", "ahead_count": -3}),
        ),
        ("int: nullable between limits, too low", "manage_ticket", json!({"action": "update", "wave_pin": 0})),
        ("int: nullable between limits, too high", "manage_ticket", json!({"action": "update", "wave_pin": 100})),
        // --- numbers
        ("number: text that is no number", "manage_ticket", json!({"action": "update", "estimate": "abc"})),
        ("number: a list", "manage_ticket", json!({"action": "update", "estimate": [1]})),
        ("number: an object", "manage_ticket", json!({"action": "update", "estimate": {"h": 2}})),
        // --- lists
        ("list: text", "manage_ticket", json!({"action": "update", "tags": "x"})),
        ("list: a number", "manage_ticket", json!({"action": "update", "tags": 5})),
        ("list: an object", "manage_ticket", json!({"action": "update", "tags": {"a": 1}})),
        ("list: items of the wrong type", "manage_ticket", json!({"action": "update", "tags": [1, "a", null, ["x"]]})),
        ("list: items of the wrong type, in text", "manage_ticket", json!({"action": "update", "tags": "[1, \"a\"]"})),
        (
            "list: an item that is not allowed",
            "manage_ticket",
            json!({"action": "update", "clear_fields": ["estimate", "nope", 3]}),
        ),
        (
            "list of objects: text items",
            "ticket_items",
            json!({"ticket_id": "T-1", "item": "comment", "items": ["a", {"b": 1}, 2]}),
        ),
        ("list of objects: text", "ticket_items", json!({"ticket_id": "T-1", "item": "comment", "items": "all"})),
        ("list of anything: an object", "ai_run", json!({"action": "ask", "options": {"a": 1}})),
        // --- objects
        ("object: text", "ai_run", json!({"action": "report", "report": "done"})),
        ("object: a list", "ai_schedules", json!({"action": "create", "fields": [1, 2]})),
        ("object: a number", "ai_schedules", json!({"action": "create", "fields": 5})),
        // --- allowed values
        ("allowed: an unknown action of many", "docs_read", json!({"action": "nope"})),
        ("allowed: two values", "get_ticket", json!({"ticket_id": "T-1", "view": "all"})),
        ("allowed: nullable, unknown", "list_tickets", json!({"project_id": "p", "priority": "urgent"})),
        ("allowed: nullable, a number", "list_tickets", json!({"project_id": "p", "status": 5})),
        ("allowed: nullable, a list in text", "list_tickets", json!({"project_id": "p", "type": "[\"bug\"]"})),
        ("allowed: a flag", "ticket_items", json!({"ticket_id": "T-1", "item": true})),
        // --- several at once, in the order of the parameters
        (
            "several: every kind in one call",
            "manage_ticket",
            json!({"wave_pin": "x", "action": "explode", "tags": [2], "estimate": "much", "unassign": 7, "priority": "p0", "colour": "red", "title": []}),
        ),
    ]
}

fn schema_of(tool: &str) -> Value {
    let entry = kb_mcp::registry::snapshot(false)
        .iter()
        .find(|e| e["name"] == tool)
        .unwrap_or_else(|| panic!("{tool} is not in the snapshot"));
    entry["inputSchema"].clone()
}

#[tokio::test]
async fn the_validator_words_every_refusal_as_pydantic_does() {
    let mut ours = Map::new();
    for (name, tool, arguments) in cases() {
        let arguments = arguments.as_object().expect("arguments").clone();
        let refused = kb_mcp::validation::validate_arguments(&format!("{tool}Arguments"), &schema_of(tool), &arguments);
        let text = refused.expect_err(&format!("{name}: the case must be an invalid call"));
        assert!(
            ours.insert(name.to_string(), json!(format!("Error executing tool {tool}: {text}"))).is_none(),
            "{name}"
        );
    }
    if target() == Target::Python {
        // ask Pydantic: the reference server's own answers (and the golden file, when it is being written)
        let s = common::start().await;
        let mcp = s.mcp();
        let mut theirs = Map::new();
        for (name, tool, arguments) in cases() {
            let result = mcp.call_tool(tool, arguments).await;
            assert!(result.is_error, "{name}: {}", result.text);
            theirs.insert(name.to_string(), json!(result.text));
        }
        check_golden("mcp_validation.json", &theirs);
    }
    check_golden_unwritten("mcp_validation.json", &ours);
}

/// `check_golden` without ever writing the file: the Rust validator is compared, never recorded.
fn check_golden_unwritten(name: &str, got: &Map<String, Value>) {
    let text = std::fs::read_to_string(common::golden_path(name)).expect("the golden file exists");
    let golden: Map<String, Value> = serde_json::from_str(&text).expect("the golden file parses");
    let mut wrong = Vec::new();
    for (case, expected) in &golden {
        if got.get(case) != Some(expected) {
            wrong.push(format!(
                "--- {case}\n expected: {}\n      got: {}",
                expected.as_str().unwrap_or_default(),
                got.get(case).and_then(Value::as_str).unwrap_or("(no such case)")
            ));
        }
    }
    assert_eq!(got.len(), golden.len(), "the cases and the golden file differ: record it again");
    assert!(
        wrong.is_empty(),
        "{} of {} refusals differ from Pydantic's:\n{}",
        wrong.len(),
        golden.len(),
        wrong.join("\n")
    );
}
