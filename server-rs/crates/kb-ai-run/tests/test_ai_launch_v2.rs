//! `server/tests/test_ai_launch_v2.py`, the part about `services/ai/stream.py`: Claude Code's stream as step rows.
//! Pure functions: no run, no CLI. (The tests of the command line, the MCP config and the prompts in the same Python
//! file wait for `launch`.)

use kb_ai_run::stream::Parser;
use kb_base::pyjson;
use serde_json::{Value, json};

fn line(obj: Value) -> String {
    pyjson::dumps(&obj)
}

fn tool(name: &str, inp: Value, tid: &str, parent: Option<&str>) -> String {
    line(json!({
        "type": "assistant",
        "parent_tool_use_id": parent,
        "message": {"content": [{"type": "tool_use", "id": tid, "name": name, "input": inp}]},
    }))
}

fn parse(p: &mut Parser, text: &str) -> Value {
    p.parse(text).expect("the parser takes the line").to_value()
}

#[test]
fn test_init_gives_the_session_the_model_and_what_was_loaded() {
    let out = parse(
        &mut Parser::new("/w", None),
        &line(json!({
            "type": "system",
            "subtype": "init",
            "session_id": "s1",
            "model": "claude-haiku",
            "agents": ["dev", "reviewer"],
            "plugins": [{"name": "kanban-board"}, "bad"],
            "tools": ["Bash"],
        })),
    );
    assert!(out["ready"] == true && out["session_id"] == "s1" && out["model"] == "claude-haiku");
    assert_eq!(out["init"], json!({"agents": ["dev", "reviewer"], "plugins": ["kanban-board"], "tools": ["Bash"]}));
}

#[test]
fn test_a_subagents_steps_are_credited_to_the_agent_call_that_started_it() {
    let mut p = Parser::new("/w", None);
    let started = parse(
        &mut p,
        &tool("Agent", json!({"subagent_type": "reviewer", "description": "Review the diff"}), "call1", None),
    );
    assert_eq!(started["agents"], json!([{"id": "call1", "agent_type": "reviewer"}]));
    assert!(started["rows"][0]["kind"] == "subagent" && started["rows"][0]["agent_id"].is_null());
    assert!(started["rows"][0]["title"].as_str().expect("title").starts_with("Asked reviewer: Review the diff"));
    let inner = parse(&mut p, &tool("Bash", json!({"command": "pytest -q"}), "t2", Some("call1")));
    assert!(inner["rows"][0]["agent_id"] == "call1" && inner["rows"][0]["detail"]["command"] == "pytest -q");
    let said = parse(
        &mut p,
        &line(json!({
            "type": "assistant",
            "parent_tool_use_id": "call1",
            "message": {"content": [{"type": "text", "text": "Two findings."}]},
        })),
    );
    assert_eq!(said["agents"], json!([{"id": "call1", "last_text": "Two findings."}]));
    // the lead's own text is not an agent's
    let lead =
        parse(&mut p, &line(json!({"type": "assistant", "message": {"content": [{"type": "text", "text": "Done."}]}})));
    assert!(lead["agents"] == json!([]) && lead["rows"][0]["agent_id"].is_null());
    assert_eq!(p.agent_types.get("call1").map(String::as_str), Some("reviewer"));
}

#[test]
fn test_plans_messages_and_the_report_are_their_own_kinds_and_tool_search_is_skipped() {
    let mut p = Parser::new("/w", None);
    assert_eq!(parse(&mut p, &tool("ToolSearch", json!({"query": "x"}), "t0", None))["rows"], json!([]));
    let plan =
        parse(&mut p, &tool("TaskCreate", json!({"subject": "Write the migration"}), "t1", None))["rows"][0].clone();
    assert!(plan["kind"] == "plan" && plan["title"] == "Write the migration");
    let sent = parse(&mut p, &tool("SendMessage", json!({"to": "IAM-7", "message": "API is ready"}), "t2", None));
    assert_eq!(sent["messages_out"], json!([{"peer": "IAM-7", "text": "API is ready", "agent_id": null}]));
    assert!(sent["rows"][0]["kind"] == "message");
    assert_eq!(sent["rows"][0]["detail"], json!({"direction": "out", "peer": "IAM-7"}));
    assert_eq!(
        parse(&mut p, &tool("StructuredOutput", json!({"status": "done"}), "t3", None))["rows"][0]["kind"],
        "report"
    );
}

#[test]
fn test_a_message_from_another_session_is_a_step_and_a_replayed_message_is_not() {
    let mut p = Parser::new("/w", None);
    let text = "<cross-session-message from=\"docs-assistant\">Page updated</cross-session-message>";
    let got = parse(&mut p, &line(json!({"type": "user", "message": {"content": text}})));
    assert_eq!(got["messages_in"], json!([{"peer": "docs-assistant", "text": "Page updated", "agent_id": null}]));
    assert_eq!(got["rows"][0]["title"], "From docs-assistant: Page updated");
    let replay = parse(&mut p, &line(json!({"type": "user", "isReplay": true, "message": {"content": text}})));
    assert!(replay["rows"] == json!([]) && replay["messages_in"] == json!([]));
}

#[test]
fn test_a_failed_tool_result_is_an_error_step_and_carries_its_exit_code() {
    let got = parse(
        &mut Parser::new("/w", None),
        &line(json!({
            "type": "user",
            "message": {"content": [
                {"type": "tool_result", "tool_use_id": "t9", "is_error": true, "content": "Exit code 2\nboom"}
            ]},
        })),
    );
    assert!(got["results"][0]["exit_code"] == 2 && got["results"][0]["tool_id"] == "t9");
    assert!(got["rows"][0]["kind"] == "error" && got["rows"][0]["parent_tool_id"] == "t9");
}

#[test]
fn test_the_result_carries_the_structured_report_or_reads_it_from_json_text() {
    let mut p = Parser::new("/w", None);
    let out = parse(
        &mut p,
        &line(json!({
            "type": "result",
            "subtype": "success",
            "session_id": "s1",
            "result": "",
            "structured_output": {"status": "done", "summary": "ok"},
            "usage": {"input_tokens": 10, "cache_read_input_tokens": 90, "output_tokens": 5},
            "total_cost_usd": 0.01,
            "modelUsage": {"m": {"contextWindow": 200000}},
        })),
    );
    let r = &out["result"];
    assert!(r["structured"] == json!({"status": "done", "summary": "ok"}) && r["is_error"] == false);
    assert_eq!((&r["tokens_in"], &r["tokens_cached"], &r["tokens_out"]), (&json!(100), &json!(90), &json!(5)));
    assert!(out["context_window"] == 200000 && out["session_id"] == "s1");
    let text = parse(
        &mut p,
        &line(
            json!({"type": "result", "subtype": "success", "result": "{\"status\": \"partial\", \"summary\": \"half\"}"}),
        ),
    );
    assert_eq!(text["result"]["structured"]["status"], "partial");
    let failed = parse(&mut p, &line(json!({"type": "result", "subtype": "error_max_turns", "result": "stopped"})));
    assert!(failed["result"]["is_error"] == true && failed["result"]["structured"].is_null());
}

#[test]
fn test_secrets_in_commands_are_redacted_and_lines_that_are_not_json_are_ignored() {
    let mut p = Parser::new("/w", None);
    // a made-up value, built here so no scanner reads it as a real token
    let fake = format!("{}{}", "z".repeat(6), "9".repeat(6));
    let header = format!("Authorization: {}{} {fake}", "Bear", "er");
    let row = parse(&mut p, &tool("Bash", json!({"command": format!("curl -H '{header}' x")}), "t1", None))["rows"][0]
        .clone();
    let (command, title) = (row["detail"]["command"].as_str().expect("command"), row["title"].as_str().expect("title"));
    assert!(!command.contains(&fake) && !title.contains(&fake));
    assert!(parse(&mut p, "not json")["rows"] == json!([]) && parse(&mut p, "{broken")["rows"] == json!([]));
}

/// Not in the Python file: a value of the wrong type ends the reading where Python raises.
#[test]
fn a_value_of_the_wrong_type_is_an_error_where_python_raises() {
    let mut p = Parser::new("/w", None);
    assert!(p.parse(&line(json!({"type": "assistant", "message": {"content": 5}}))).is_err());
    assert!(p.parse(&tool("Bash", json!({"command": 5}), "t1", None)).is_err());
    // and the parser goes on with the next line
    assert_eq!(parse(&mut p, &tool("Bash", json!({"command": "ls"}), "t2", None))["rows"][0]["kind"], "command");
}
