//! `tests/test_mcp_tool_quality.py`, the tests of the tool list itself: what the AI reads (descriptions, schemas,
//! annotations), asked of the server over `tools/list` and `initialize`. `_full_mcp()` of the Python tests is a
//! server started with `KANBAN_MCP_IDEA_TOOLS=1`.
//!
//! The Rust server lists the tools that are ported (`kb_mcp::registry::NOT_PORTED_YET` names the others), each as
//! the Python server lists it, so the same checks hold for a shorter list; a check that names a tool is skipped
//! while the tool is not listed. The tests of how the tools behave wait for their tools: see the end of this file.

mod common;

use common::{call, call_err, tools};
use serde_json::{Map, Value, json};
use testkit::{Options, Server, Target, target};

const CORE: [&str; 13] = [
    "get_projects",
    "list_tickets",
    "get_ticket",
    "docs_read",
    "manage_project",
    "manage_ticket",
    "ticket_items",
    "ticket_branches",
    "docs_write",
    "ai_schedules",
    "knowledge",
    "board_wait",
    "ai_run",
];
const IDEAS: [&str; 5] =
    ["list_idea_tickets", "get_idea_ticket", "list_idea_assumptions", "get_idea_activity_trail", "create_idea_ticket"];

/// A server with every tool, including the Idea Space ones that are hidden by default.
async fn full_mcp() -> Server {
    common::start_with(Options { env: vec![("KANBAN_MCP_IDEA_TOOLS".into(), "1".into())], ..Options::default() }).await
}

/// The tools of a table that the server under test has (all of them on Python).
fn expected(names: &[&str]) -> Vec<String> {
    names
        .iter()
        .filter(|name| target() == Target::Python || !kb_mcp::registry::NOT_PORTED_YET.contains(name))
        .map(|name| name.to_string())
        .collect()
}

fn names(tools: &Map<String, Value>) -> Vec<String> {
    tools.keys().cloned().collect()
}

fn enum_of(schema: &Value) -> Option<&Vec<Value>> {
    if let Some(values) = schema.get("enum").and_then(Value::as_array) {
        return Some(values);
    }
    schema.get("anyOf")?.as_array()?.iter().find_map(|sub| sub.get("enum").and_then(Value::as_array))
}

fn properties(tool: &Value) -> &Map<String, Value> {
    tool["inputSchema"]["properties"].as_object().expect("properties")
}

async fn instructions(server: &Server) -> String {
    server.mcp().initialize().await["instructions"].as_str().expect("instructions").to_string()
}

// --------------------------------------------------------------------------- the tool list itself

#[tokio::test]
async fn test_every_registered_tool_is_in_the_table_and_vice_versa() {
    assert!(!CORE.iter().any(|name| IDEAS.contains(name)));
    let (plain, full) = (common::start().await, full_mcp().await);
    assert_eq!(names(&tools(&plain.mcp()).await), expected(&CORE));
    assert_eq!(names(&tools(&full.mcp()).await), [expected(&CORE), expected(&IDEAS)].concat());
    assert!(CORE.len() == 13 && IDEAS.len() == 5);
}

#[tokio::test]
async fn test_idea_space_tools_are_hidden_by_default_and_can_be_switched_on() {
    let plain = common::start().await;
    let listed = tools(&plain.mcp()).await;
    assert!(!IDEAS.iter().any(|name| listed.contains_key(*name))); // the real server: hidden
    let text = instructions(&plain).await;
    assert!(!text.contains("IDEA-N") && !text.to_lowercase().contains("idea"));

    let full = full_mcp().await;
    let listed = tools(&full.mcp()).await;
    for name in expected(&IDEAS) {
        assert!(listed.contains_key(&name), "{name}");
    }
    assert!(instructions(&full).await.contains("IDEA-N"));
    // (`ideas_enabled()` for each value of the variable is a unit test of `kb_mcp::settings`)
}

#[tokio::test]
async fn test_every_tool_has_annotations_that_match_its_name() {
    let reads = ["get_projects", "list_tickets", "get_ticket", "docs_read", "board_wait"];
    // a tool that has a `delete` / `remove` / `unlink` action is destructive as a whole
    let destructive = [
        "manage_project",
        "manage_ticket",
        "ticket_items",
        "ticket_branches",
        "docs_write",
        "ai_schedules",
        "knowledge", // forget removes a note (issue #274)
    ]; // ai_run asks, messages and reports but never deletes: not destructive
    let full = full_mcp().await;
    for (name, tool) in tools(&full.mcp()).await {
        let a = &tool["annotations"];
        assert!(a.is_object(), "{name}");
        let read = reads.contains(&name.as_str()) || name.starts_with("list_idea") || name.starts_with("get_idea");
        assert_eq!(a["readOnlyHint"], read, "{name}");
        if name.starts_with("delete_") || destructive.contains(&name.as_str()) {
            assert_eq!(a["destructiveHint"], true, "{name}");
        } else {
            assert_ne!(a["destructiveHint"], true, "{name}");
        }
        assert_eq!(a["openWorldHint"], false, "{name}");
    }
}

#[tokio::test]
async fn test_descriptions_are_present_and_free_of_stale_conventions() {
    let full = full_mcp().await;
    for (name, tool) in tools(&full.mcp()).await {
        let desc = tool["description"].as_str().unwrap_or_default();
        assert!(desc.chars().count() >= 40, "{name}: description too short");
        assert!(!desc.contains("Args:"), "{name}: parameter docs belong in the schema");
        assert!(!desc.contains("or None") && !desc.contains("{\"error\""), "{name}: failures are raised, not returned");
    }
}

#[tokio::test]
async fn test_every_parameter_is_described_unless_its_enum_or_flag_explains_itself() {
    let self_explanatory = ["title", "description", "expected_result", "notes", "idea_emoji"];
    let full = full_mcp().await;
    for (name, tool) in tools(&full.mcp()).await {
        for (pname, schema) in properties(&tool) {
            if schema.get("description").and_then(Value::as_str).is_some_and(|d| !d.is_empty()) {
                continue;
            }
            let is_flag = schema["type"] == "boolean"
                || schema
                    .get("anyOf")
                    .and_then(Value::as_array)
                    .is_some_and(|a| a.iter().any(|s| s["type"] == "boolean"));
            assert!(
                enum_of(schema).is_some_and(|e| !e.is_empty()) || is_flag || self_explanatory.contains(&pname.as_str()),
                "{name}.{pname} has no description"
            );
        }
    }
}

#[tokio::test]
async fn test_schemas_carry_no_redundant_titles() {
    let full = full_mcp().await;
    let listed = tools(&full.mcp()).await;
    for (name, tool) in &listed {
        for (pname, schema) in properties(tool) {
            assert!(schema.get("title").is_none(), "{name}.{pname}");
        }
    }
    // ...but a parameter that is itself called "title" survives
    if let Some(manage_ticket) = listed.get("manage_ticket") {
        assert!(properties(manage_ticket).contains_key("title"));
    }
}

#[tokio::test]
async fn test_the_tool_list_stays_compact() {
    fn size(tools: &Map<String, Value>) -> usize {
        tools
            .values()
            .map(|t| {
                // `len(json.dumps(t.inputSchema, separators=(",", ":")))`: characters, with text as ASCII escapes
                let schema = kb_base_compact_ascii_len(&t["inputSchema"]);
                t["description"].as_str().unwrap_or_default().chars().count() + schema
            })
            .sum()
    }
    let (plain, full) = (common::start().await, full_mcp().await);
    let (default, full) = (size(&tools(&plain.mcp()).await), size(&tools(&full.mcp()).await));
    // AI v2 removed the ai_team tool and the permission, handoff, workflow and Story actions; ai_run is seven actions
    // (ask, message, reply, team, runs, report). Measured after that: 49,074 / 51,904 characters. The bounds
    // leave about 3 % of room; raise them on purpose, with what was added, never by reflex.
    assert!(default < 50_500, "default tool list is {default} characters (about {} tokens)", default / 4);
    assert!(full < 53_400, "full tool list is {full} characters (about {} tokens)", full / 4);
    if target() == Target::Python {
        assert!(default < full);
        // the measure is the Python test's: the numbers of its comment, within the bounds
        assert!(default > 45_000 && full > default + 1_000, "{default} / {full}");
    } else {
        assert!(default <= full);
    }
}

/// The length of `json.dumps(value, separators=(",", ":"))`: a character outside ASCII counts as its `\uXXXX`
/// escapes.
fn kb_base_compact_ascii_len(value: &Value) -> usize {
    value.to_string().chars().map(|c| if c.is_ascii() { 1 } else { 6 * c.len_utf16() }).sum()
}

#[tokio::test]
async fn test_server_instructions_explain_the_ids_and_conventions() {
    let (plain, full) = (common::start().await, full_mcp().await);
    for (text, musts) in [
        (instructions(&plain).await, ["IAM-12", "clear_fields", "workspace", "AI agent"]),
        (instructions(&full).await, ["IAM-12", "IDEA-N", "Inbox", "cannot move"]),
    ] {
        for must in musts {
            assert!(text.contains(must), "{must}");
        }
    }
}

#[tokio::test]
async fn test_schema_enums_match_the_services() {
    let full = full_mcp().await;
    let listed = tools(&full.mcp()).await;
    let enum_set = |tool: &str, param: &str| -> Option<Vec<String>> {
        let values = enum_of(&properties(listed.get(tool)?)[param])?;
        let mut values: Vec<String> = values.iter().filter_map(Value::as_str).map(str::to_string).collect();
        values.sort();
        Some(values)
    };
    let sorted = |values: &[&str]| {
        let mut values: Vec<String> = values.iter().map(|v| v.to_string()).collect();
        values.sort();
        values
    };
    // every action name in a description is a real choice, and the other way round
    let project_actions: Vec<&str> = kb_mcp::tools::projects::PROJECT_OPS.iter().map(|(action, _)| *action).collect();
    assert_eq!(enum_set("manage_project", "action"), Some(sorted(&project_actions)));
    let read_actions: Vec<&str> = kb_mcp::tools::docs::DOCS_READ_OPS.iter().map(|(action, _)| *action).collect();
    assert_eq!(enum_set("docs_read", "action"), Some(sorted(&read_actions)));
    let mut write_actions: Vec<&str> = kb_mcp::tools::docs::DOCS_WRITE_OPS.iter().map(|(action, _)| *action).collect();
    write_actions.extend(kb_mcp::tools::docs::DOCS_WRITE_COMPOSITE);
    assert_eq!(enum_set("docs_write", "action"), Some(sorted(&write_actions)));
    // (the enums of the ticket, branch, docs, idea and ai_run tools are compared with their tables and with the
    // services' own lists when those tools are ported; what the schema says is fixed by the snapshot meanwhile)
    if let Some(statuses) = enum_set("manage_ticket", "status") {
        assert_eq!(statuses, sorted(&kb_mcp::common::STATUSES));
    }
    if let Some(kinds) = enum_set("ticket_items", "log_kind") {
        assert_eq!(kinds, sorted(&kb_mcp::common::WORK_LOG_KINDS));
    }
    if let Some(relations) = enum_set("manage_ticket", "relation_type") {
        assert_eq!(relations, sorted(&kb_mcp::common::RELATION_TYPES));
    }
    if let Some(statuses) = enum_set("ticket_branches", "status") {
        assert_eq!(statuses, sorted(&kb_mcp::common::BRANCH_STATUSES));
    }
    if let Some(actions) = enum_set("ai_run", "action") {
        assert_eq!(actions, sorted(&["ask", "message", "reply", "history", "team", "runs", "report"]));
    }
}

#[tokio::test]
async fn test_invalid_enum_values_are_rejected_before_any_work() {
    let (plain, full) = (common::start().await, full_mcp().await);
    if tools(&full.mcp()).await.contains_key("create_idea_ticket") {
        call_err(&full.mcp(), "create_idea_ticket", json!({"project_id": "x", "title": "t", "idea_energy": "low"}))
            .await;
    }
    if tools(&plain.mcp()).await.contains_key("list_tickets") {
        call_err(&plain.mcp(), "list_tickets", json!({"project_id": "x", "status": "bogus"})).await;
    }
    // the same for the tool that is always there: nothing is made
    let mcp = plain.mcp();
    call_err(&mcp, "manage_project", json!({"action": "bogus", "name": "x", "prefix": "X"})).await;
    assert_eq!(call(&mcp, "get_projects", json!({})).await, json!([]));
}

// --------------------------------------------------------------------------- behaviour the descriptions promise

#[tokio::test]
async fn test_create_ticket_and_update_project_cover_what_the_descriptions_offer() {
    let s = common::start().await;
    let (mcp, c) = (s.mcp(), s.client());
    let (p, _) = common::rest_ticket(&c, "t", "ACT", json!({})).await;
    let member =
        call(&mcp, "manage_project", json!({"action": "add_member", "project_id": p["id"], "name": "Bao"})).await;
    let created = call(
        &mcp,
        "manage_ticket",
        json!({"action": "create", "project_id": p["id"], "title": "with owner", "assignee": member["id"],
               "start_date": "2026-01-02", "due_date": "2026-02-01"}),
    )
    .await;
    assert!(created["assignee"] == member["id"] && created["start_date"] == "2026-01-02", "{created}");
    let project =
        call(&mcp, "manage_project", json!({"action": "update", "project_id": p["id"], "name": "Renamed"})).await;
    assert_eq!(project["name"], "Renamed");
    let refused =
        call_err(&mcp, "manage_project", json!({"action": "update", "project_id": "no-such-project", "name": "x"}))
            .await;
    assert!(refused.contains("not found"), "{refused}");
}

#[tokio::test]
async fn test_list_tickets_is_paginated_and_compact() {
    let s = common::start().await;
    let (mcp, c) = (s.mcp(), s.client());
    let (p, _) = common::rest_ticket(&c, "first", "ACT", json!({})).await;
    for n in 0..4 {
        common::rest_ticket_in(&c, &p["id"], &format!("t{n}"), json!({"description": "long ".repeat(50)})).await;
    }
    let page = call(&mcp, "list_tickets", json!({"project_id": p["id"], "limit": 2})).await;
    assert_eq!(
        (&page["total"], &page["count"], &page["offset"], &page["has_more"]),
        (&json!(5), &json!(2), &json!(0), &json!(true))
    );
    let rest = call(&mcp, "list_tickets", json!({"project_id": p["id"], "limit": 2, "offset": 4})).await;
    assert_eq!((&rest["count"], &rest["has_more"]), (&json!(1), &json!(false)));
    let summary = page["tickets"][0].as_object().expect("a summary");
    for key in ["id", "title", "status", "priority", "blocked_by", "acceptance_criteria", "test_cases"] {
        assert!(summary.contains_key(key), "{key}");
    }
    assert!(!summary.contains_key("description") && !summary.contains_key("activity_log"));
    let full = call(&mcp, "list_tickets", json!({"project_id": p["id"], "detail": true, "limit": 1})).await;
    assert!(full["tickets"][0].get("description").is_some() && full["tickets"][0].get("activity_log").is_none());
}

#[tokio::test]
async fn test_activity_log_is_opt_in_and_branches_have_no_camel_case_twins() {
    let s = common::start().await;
    let (mcp, c) = (s.mcp(), s.client());
    let (_, t) = common::rest_ticket(&c, "t", "ACT", json!({})).await;
    let id = t["id"].as_str().expect("an id");
    c.patch(&format!("/tickets/{id}"), json!({"priority": "high"})).await.assert_status(200);
    c.post(&format!("/tickets/{id}/branches"), json!({"name": "feat/a", "branch_from": "main"}))
        .await
        .assert_status(201);
    let plain = call(&mcp, "get_ticket", json!({"ticket_id": id})).await;
    // recent entries only
    assert!(plain["activity_log"].as_array().expect("log").len() <= 10);
    let all = call(&mcp, "get_ticket", json!({"ticket_id": id, "activity_limit": -1})).await;
    assert_eq!(
        all["activity_log"].as_array().expect("log").len() as u64,
        plain["activity_total"].as_u64().expect("total")
    );
    let commented = call(
        &mcp,
        "ticket_items",
        json!({"ticket_id": id, "item": "comment", "action": "add", "text": "hi", "author": "Claude"}),
    )
    .await;
    assert!(commented.get("activity_log").is_none());
    let branch = plain["branches"][0].as_object().expect("a branch");
    assert!(branch.contains_key("pr_url") && !branch.contains_key("prUrl") && !branch.contains_key("branchFrom"));
}

#[tokio::test]
async fn test_sub_item_errors_list_the_valid_ids() {
    let s = common::start().await;
    let (mcp, c) = (s.mcp(), s.client());
    let (_, t) = common::rest_ticket(&c, "t", "ACT", json!({})).await;
    let id = &t["id"];
    let created = call(
        &mcp,
        "ticket_items",
        json!({"ticket_id": id, "item": "comment", "action": "add", "text": "hello", "author": "Claude"}),
    )
    .await;
    let cid = created["comments"][0]["id"].as_str().expect("an id").to_string();
    // used to "succeed" silently
    let text = call_err(
        &mcp,
        "ticket_items",
        json!({"ticket_id": id, "item": "comment", "action": "delete", "item_id": "wrong-id"}),
    )
    .await;
    assert!(text.contains(&cid) && text.contains("get_ticket"), "{text}");
    let got = call(&mcp, "get_ticket", json!({"ticket_id": id})).await;
    assert_eq!(got["comments"].as_array().expect("comments").len(), 1);
    let text = call_err(
        &mcp,
        "ticket_items",
        json!({"ticket_id": id, "item": "criterion", "action": "toggle", "item_id": "nope"}),
    )
    .await;
    assert!(text.contains("not found"), "{text}");
}

#[tokio::test]
async fn test_test_cases_and_branches_can_be_addressed_by_code_and_name() {
    let s = common::start().await;
    let (mcp, c) = (s.mcp(), s.client());
    let (_, t) = common::rest_ticket(&c, "t", "ACT", json!({})).await;
    let i = &t["id"];
    call(&mcp, "ticket_items", json!({"ticket_id": i, "item": "test_case", "action": "add", "title": "works"})).await;
    // by code, not UUID
    let updated = call(
        &mcp,
        "ticket_items",
        json!({"ticket_id": i, "item": "test_case", "action": "update", "item_id": "TC-1", "status": "pass"}),
    )
    .await;
    assert_eq!(updated["test_cases"][0]["status"], "pass");
    call(&mcp, "ticket_branches", json!({"ticket_id": i, "action": "add", "name": "feat/x"})).await;
    // by name
    let renamed = call(
        &mcp,
        "ticket_branches",
        json!({"ticket_id": i, "action": "update", "branch": "feat/x", "pr_url": "https://example.com/pr/1"}),
    )
    .await;
    assert_eq!(renamed["branches"][0]["pr_url"], "https://example.com/pr/1");
    let after = call(&mcp, "ticket_branches", json!({"ticket_id": i, "action": "delete", "branch": "feat/x"})).await;
    assert_eq!(after["branches"], json!([]));
}

#[tokio::test]
async fn test_failures_are_raised_for_idea_tools_too() {
    let s = full_mcp().await;
    let mcp = s.mcp();
    for (tool, arguments) in [
        ("get_idea_ticket", json!({"ticket_id": "IDEA-999"})),
        ("list_idea_assumptions", json!({"ticket_id": "IDEA-999"})),
        ("get_idea_activity_trail", json!({"ticket_id": "IDEA-999"})),
    ] {
        let text = call_err(&mcp, tool, arguments).await;
        assert!(text.contains("not found"), "{tool}: {text}");
    }
}

#[tokio::test]
async fn test_unlink_explains_that_each_side_of_a_link_has_its_own_id() {
    let s = common::start().await;
    let (mcp, c) = (s.mcp(), s.client());
    let (p, a) = common::rest_ticket(&c, "t", "ACT", json!({})).await;
    let b = common::rest_ticket_in(&c, &p["id"], "b", json!({})).await;
    let link = call(
        &mcp,
        "manage_ticket",
        json!({"action": "link", "ticket_id": a["id"], "target_id": b["id"], "relation_type": "relates_to"}),
    )
    .await;
    // the other side of the link
    let text =
        call_err(&mcp, "manage_ticket", json!({"action": "unlink", "ticket_id": b["id"], "link_id": link["id"]})).await;
    assert!(text.contains("different id on each"), "{text}");
    let removed =
        call(&mcp, "manage_ticket", json!({"action": "unlink", "ticket_id": a["id"], "link_id": link["id"]})).await;
    assert_eq!(removed, json!({"removed": link["id"]}));
}

#[tokio::test]
async fn test_get_ticket_can_return_only_the_recent_activity() {
    let s = common::start().await;
    let (mcp, c) = (s.mcp(), s.client());
    let (_, t) = common::rest_ticket(&c, "t", "ACT", json!({})).await;
    let i = t["id"].as_str().expect("an id");
    for n in 0..5 {
        c.patch(&format!("/tickets/{i}"), json!({"title": format!("t{n}")})).await.assert_status(200);
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    let tos = |ticket: &Value| -> Vec<Value> {
        ticket["activity_log"].as_array().expect("log").iter().map(|e| e["to"].clone()).collect()
    };
    // default: the most recent entries
    let plain = call(&mcp, "get_ticket", json!({"ticket_id": i})).await;
    let shown = plain["activity_log"].as_array().expect("log");
    assert!(!shown.is_empty() && shown.len() <= 10);
    assert!(plain["activity_total"].as_u64().expect("total") >= 6 && shown[shown.len() - 1]["to"] == "t4");

    let everything = call(&mcp, "get_ticket", json!({"ticket_id": i, "activity_limit": -1})).await;
    let all = everything["activity_log"].as_array().expect("log");
    let total = all.len() as u64;
    assert!(total >= 6 && everything["activity_total"].as_u64() == Some(total));

    // the newest two, oldest first
    let latest = call(&mcp, "get_ticket", json!({"ticket_id": i, "activity_limit": 2})).await;
    assert_eq!(tos(&latest), [json!("t3"), json!("t4")]);
    assert_eq!(latest["activity_total"].as_u64(), Some(total));

    // leave it out entirely
    let none = call(&mcp, "get_ticket", json!({"ticket_id": i, "activity_limit": 0})).await;
    assert_eq!(none["activity_log"], json!([]));

    // entries strictly after the third-from-last
    let cutoff = all[all.len() - 3]["at"].clone();
    let newer = call(&mcp, "get_ticket", json!({"ticket_id": i, "activity_since": cutoff})).await;
    assert_eq!(tos(&newer), [json!("t3"), json!("t4")]);
    let both =
        call(&mcp, "get_ticket", json!({"ticket_id": i, "activity_since": all[0]["at"], "activity_limit": 1})).await;
    assert_eq!(tos(&both), [json!("t4")]);
    let future = call(&mcp, "get_ticket", json!({"ticket_id": i, "activity_since": "2999-01-01"})).await;
    assert_eq!(future["activity_log"], json!([]));
    let text = call_err(&mcp, "get_ticket", json!({"ticket_id": i, "activity_since": "yesterday"})).await;
    assert!(text.contains("ISO"), "{text}");
}

#[tokio::test]
async fn test_default_activity_is_capped_and_long_texts_are_shortened() {
    let s = common::start().await;
    let (mcp, c) = (s.mcp(), s.client());
    let (_, t) = common::rest_ticket(&c, "t", "ACT", json!({})).await;
    let i = t["id"].as_str().expect("an id");
    for n in 0..15 {
        let priority = ["low", "high"][n % 2];
        c.patch(&format!("/tickets/{i}"), json!({"priority": priority})).await.assert_status(200);
    }
    c.patch(&format!("/tickets/{i}"), json!({"description": "x".repeat(5000)})).await.assert_status(200);
    let recent = call(&mcp, "get_ticket", json!({"ticket_id": i})).await;
    assert_eq!(recent["activity_log"].as_array().expect("log").len(), 10);
    assert!(recent["activity_total"].as_u64().expect("total") > 10);
    let description = |ticket: &Value| -> String {
        let log = ticket["activity_log"].as_array().expect("log");
        log.iter().find(|e| e["field"] == "description").expect("a description entry")["to"]
            .as_str()
            .expect("text")
            .to_string()
    };
    // shortened by default...
    let short = description(&recent);
    assert!(short.chars().count() < 400 && short.contains("more chars"), "{short}");
    let full = call(&mcp, "get_ticket", json!({"ticket_id": i, "activity_limit": -1})).await;
    // ...whole with a negative limit
    assert_eq!(description(&full).chars().count(), 5000);
    let log = full["activity_log"].as_array().expect("log");
    assert_eq!(log.len() as u64, full["activity_total"].as_u64().expect("total"));
    // a negative limit with `since` = everything after that moment, in full
    let cutoff = log[log.len() - 2]["at"].clone();
    let tail = call(&mcp, "get_ticket", json!({"ticket_id": i, "activity_limit": -5, "activity_since": cutoff})).await;
    let expected: Vec<&Value> = log.iter().filter(|e| e["at"].as_str() > cutoff.as_str()).collect();
    assert_eq!(tail["activity_log"].as_array().expect("log").iter().collect::<Vec<_>>(), expected);
}

#[tokio::test]
async fn test_activity_limit_is_validated_by_the_schema() {
    let s = common::start().await;
    let mcp = s.mcp();
    let listed = tools(&mcp).await;
    let Some(get_ticket) = listed.get("get_ticket") else { return };
    call_err(&mcp, "get_ticket", json!({"ticket_id": "X-1", "activity_limit": -1})).await;
    let props = properties(get_ticket);
    assert!(props.contains_key("activity_limit") && props.contains_key("activity_since"));
    assert!(!props.contains_key("include_activity"));
}

#[tokio::test]
async fn test_sketches_are_actions_of_the_docs_tools_not_tools_of_their_own() {
    let full = full_mcp().await;
    let listed = tools(&full.mcp()).await;
    assert!(!listed.keys().any(|name| name.contains("sketch"))); // the tool count stays the same
    let (Some(read), Some(write)) = (listed.get("docs_read"), listed.get("docs_write")) else { return };
    let (read_text, write_text) =
        (read["description"].as_str().expect("text"), write["description"].as_str().expect("text"));
    for action in ["sketches", "sketch"] {
        assert!(kb_mcp::tools::docs::DOCS_READ_OPS.iter().any(|(a, _)| *a == action), "{action}");
        assert!(read_text.contains(&format!("- {action}:")), "{action}");
    }
    for action in ["sketch_create", "sketch_save"] {
        assert!(kb_mcp::tools::docs::DOCS_WRITE_OPS.iter().any(|(a, _)| *a == action), "{action}");
        assert!(write_text.contains(&format!("- {action}:")), "{action}");
    }
    // the limits an agent must respect are in front of it
    assert!(write_text.contains("base_version") && write_text.contains("stale"));
    let props = properties(write);
    assert!(props["source_path"]["description"].as_str().expect("text").contains("10 layers"));
    assert!(props["path"]["description"].as_str().expect("text").contains("4096"));
    assert!(properties(read).contains_key("sketch_id"));
}

// Not ported:
// - test_every_operation_is_reachable_through_a_tool looks through the Python modules (every function of
//   `kanban_mcp.operations` is named by a table); in Rust an operation nothing routes to is found by reading
//   `operations/mod.rs` against the tables (`update_ticket_status` and `create_child_ticket` are the two that the
//   Python tests call and no table routes to: `manage_ticket` update and create do the same).
