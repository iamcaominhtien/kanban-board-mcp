//! `tests/test_mcp_tool_routing.py`, the tests of the project tools and of the routing itself: every action is
//! reached through `tools/call` (so the published schema is what is validated), with the parameter checks and
//! fix-it errors the tool descriptions promise.
//!
//! Where a Python test also used a ticket tool, the ticket is made and changed through the REST API here, and a
//! check that needs a tool the server does not list yet is skipped (`common::tools`): it runs from the day the tool
//! is ported. The tests that are about other tools wait for them: see the list at the end of this file.

mod common;

use common::{call, call_err, tools};
use serde_json::{Value, json};
use testkit::Mcp;

async fn project(mcp: &Mcp, prefix: &str) -> Value {
    call(mcp, "manage_project", json!({"action": "create", "name": "Facade", "prefix": prefix})).await
}

fn ids(list: &Value) -> Vec<String> {
    list.as_array().expect("a list").iter().map(|x| x["id"].as_str().expect("an id").to_string()).collect()
}

// --------------------------------------------------------------------------- projects and members

#[tokio::test]
async fn test_projects_and_members() {
    let s = common::start().await;
    let (mcp, c) = (s.mcp(), s.client());
    let p = project(&mcp, "FAC").await;
    let pid = p["id"].as_str().expect("an id");
    assert_eq!(p["prefix"], "FAC");
    assert_eq!(ids(&call(&mcp, "get_projects", json!({})).await), [pid]);

    let updated = call(&mcp, "manage_project", json!({"action": "update", "project_id": pid, "name": "Renamed"})).await;
    assert_eq!(updated["name"], "Renamed");

    let member = call(&mcp, "manage_project", json!({"action": "add_member", "project_id": pid, "name": "Bao"})).await;
    let member_id = member["id"].as_str().expect("an id");
    let detail = call(&mcp, "get_projects", json!({"project_id": pid})).await;
    assert_eq!(detail["name"], "Renamed");
    assert!(ids(&detail["members"]).contains(&member_id.to_string()));

    // (the ticket is made through the REST API: `manage_ticket` is ported with the ticket tools)
    let ticket = c.post(&format!("/projects/{pid}/tickets"), json!({"title": "T", "assignee": member_id})).await;
    ticket.assert_status(201);
    let ticket = ticket.json();
    assert_eq!(ticket["assignee"], member_id);
    let remove = json!({"action": "remove_member", "project_id": pid, "member_id": member_id});
    let refused = call_err(&mcp, "manage_project", remove.clone()).await;
    assert!(refused.contains("Reassign first"), "{refused}");
    let ticket_id = ticket["id"].as_str().expect("a ticket id");
    c.patch(&format!("/tickets/{ticket_id}"), json!({"assignee": null})).await.assert_status(200);
    let removed = call(&mcp, "manage_project", remove).await;
    assert_eq!(removed, json!({"ok": true}));
    let after = call(&mcp, "get_projects", json!({"project_id": pid})).await;
    assert!(!ids(&after["members"]).contains(&member_id.to_string()));
}

#[tokio::test]
async fn test_get_projects_unknown_id_lists_the_real_ones() {
    let s = common::start().await;
    let mcp = s.mcp();
    let p = project(&mcp, "FAC").await;
    let refused = call_err(&mcp, "get_projects", json!({"project_id": "nope"})).await;
    assert!(refused.contains(p["id"].as_str().expect("an id")), "{refused}");
}

// --------------------------------------------------------------------------- the routing

#[tokio::test]
async fn test_missing_and_foreign_parameters_name_the_action_and_what_it_takes() {
    let s = common::start().await;
    let mcp = s.mcp();
    let refused = call_err(&mcp, "manage_project", json!({"action": "create", "name": "x"})).await;
    let (label, missing) = (refused.find("manage_project(action='create')"), refused.find("Missing: prefix"));
    assert!(label.is_some() && missing.is_some() && label < missing, "{refused}");
    let refused = call_err(
        &mcp,
        "manage_project",
        json!({"action": "add_member", "project_id": "p", "name": "x", "repo_path": "/tmp"}),
    )
    .await;
    assert!(refused.contains("does not use: repo_path"), "{refused}");
    if tools(&mcp).await.contains_key("docs_read") {
        let refused = call_err(&mcp, "docs_read", json!({"action": "search"})).await;
        assert!(refused.contains("requires project_id, query; optional: scope, limit"), "{refused}");
    }
}

#[tokio::test]
async fn test_an_unknown_action_is_rejected_by_the_schema() {
    let s = common::start().await;
    let mcp = s.mcp();
    let listed = tools(&mcp).await;
    if listed.contains_key("manage_ticket") {
        call_err(&mcp, "manage_ticket", json!({"action": "explode", "ticket_id": "X-1"})).await;
    }
    // the same for the tool that is always there
    let refused = call_err(&mcp, "manage_project", json!({"action": "explode", "project_id": "x"})).await;
    assert!(refused.contains("Input should be 'create', 'update', 'add_member' or 'remove_member'"), "{refused}");
}

#[tokio::test]
async fn test_a_misspelt_parameter_is_an_error_not_silently_ignored() {
    let s = common::start().await;
    let mcp = s.mcp();
    let p = project(&mcp, "FAC").await;
    let pid = p["id"].as_str().expect("an id");
    let refused =
        call_err(&mcp, "manage_project", json!({"action": "update", "project_id": pid, "naem": "typo"})).await;
    assert!(refused.contains("Extra inputs are not permitted"), "{refused}");
    assert_eq!(call(&mcp, "get_projects", json!({"project_id": pid})).await["name"], "Facade");
    let listed = tools(&mcp).await;
    if listed.contains_key("list_tickets") {
        let refused = call_err(&mcp, "list_tickets", json!({"project_id": pid, "statuss": "done"})).await;
        assert!(refused.contains("Extra inputs are not permitted"), "{refused}");
    }
    for (name, tool) in &listed {
        assert_eq!(tool["inputSchema"]["additionalProperties"], false, "{name}");
    }
}

/// Over the protocol the result also carries what the tool's output schema asks for.
#[tokio::test]
async fn test_tools_work_through_a_real_client_session() {
    let s = common::start().await;
    let mcp = s.mcp();
    mcp.initialize().await;
    let run = |tool: &'static str, arguments: Value| {
        let mcp = mcp.clone();
        async move {
            let result = mcp.call_tool(tool, arguments.clone()).await;
            assert!(!result.is_error, "{tool} {arguments}: {}", result.text);
            result
        }
    };
    let made = run("manage_project", json!({"action": "create", "name": "P", "prefix": "PRO"})).await;
    let project = made.json();
    // a tool without an output schema answers with text only
    assert!(made.raw.get("structuredContent").is_none(), "{}", made.raw);
    let all = run("get_projects", json!({})).await;
    assert_eq!(all.raw["structuredContent"]["result"].as_array().expect("a list").len(), 1);
    let detail = run("get_projects", json!({"project_id": project["id"]})).await;
    assert!(!detail.json()["members"].as_array().expect("members").is_empty());
    assert_eq!(detail.raw["structuredContent"]["result"], detail.json());
    let failed = mcp.call_tool("manage_project", json!({"action": "update", "project_id": "NOPE", "name": "x"})).await;
    assert!(failed.is_error);
}

// Waiting for their tools (ported with them):
// - manage_ticket, list_tickets, get_ticket: test_ticket_lifecycle_and_relations,
//   test_wont_do_needs_a_reason_and_done_guards_are_enforced, test_get_ticket_can_return_just_the_comments,
//   test_changes_are_attributed_to_the_agent, test_the_comments_view_refuses_activity_options,
//   test_reopen_pend_and_resume_through_manage_ticket, test_list_tickets_filters_pending_and_reopened
// - ticket_items: test_a_work_log_note_without_an_action_is_added_and_with_an_id_updated,
//   test_comments_work_log_criteria_sub_tasks_and_test_cases, test_ticket_items_explains_a_wrong_call
// - ticket_branches: test_branches_by_name, test_branch_counts_keep_their_schema_constraint
// - docs_read, docs_write: test_docs_read_and_write, test_docs_import
// - `test_every_table_entry_names_real_parameters` is a unit test next to each table (`src/tools/projects.rs`).
