//! `tests/test_mcp_tools.py`, the tests of the project operations. The Python tests call the operation functions;
//! here each goes through the tool that routes to the operation (`get_projects`, `manage_project`), over the
//! protocol.
//!
//! The other tests of the file wait for their tools: see the list at the end of this file.

mod common;

use common::call;
use serde_json::{Value, json};
use testkit::Mcp;

/// `_seed_project`: `ops.create_project(name=name, prefix=prefix, color="#aabbcc")`.
async fn seed_project(mcp: &Mcp, name: &str, prefix: &str) -> Value {
    call(mcp, "manage_project", json!({"action": "create", "name": name, "prefix": prefix, "color": "#aabbcc"})).await
}

// ---------------------------------------------------------------------------
// list_projects
// ---------------------------------------------------------------------------

#[tokio::test]
async fn test_list_projects_returns_list() {
    let s = common::start().await;
    let result = call(&s.mcp(), "get_projects", json!({})).await;
    assert!(result.is_array(), "{result}");
}

#[tokio::test]
async fn test_list_projects_shows_created_project() {
    let s = common::start().await;
    let mcp = s.mcp();
    seed_project(&mcp, "Alpha", "ALPHA").await;
    let result = call(&mcp, "get_projects", json!({})).await;
    assert!(result.as_array().expect("a list").iter().any(|p| p["prefix"] == "ALPHA"), "{result}");
}

// ---------------------------------------------------------------------------
// create_project
// ---------------------------------------------------------------------------

#[tokio::test]
async fn test_create_project_returns_correct_fields() {
    let s = common::start().await;
    let result = call(
        &s.mcp(),
        "manage_project",
        json!({"action": "create", "name": "My App", "prefix": "MYAPP", "color": "#ff0000"}),
    )
    .await;
    assert_eq!(result["name"], "My App");
    assert_eq!(result["prefix"], "MYAPP");
    assert_eq!(result["color"], "#ff0000");
    assert!(result.get("id").is_some());
    assert_eq!(result["ticket_counter"], 0);
}

#[tokio::test]
async fn test_create_project_uppercases_prefix() {
    let s = common::start().await;
    let result = call(&s.mcp(), "manage_project", json!({"action": "create", "name": "Lower", "prefix": "low"})).await;
    assert_eq!(result["prefix"], "LOW");
    // the default of the operation's `color`
    assert_eq!(result["color"], "#6366f1");
}

// Waiting for their tools (ported with them):
// - list_tickets, get_ticket: test_create_ticket_appears_in_list_tickets, test_list_tickets_filter_by_status,
//   test_get_ticket_returns_ticket, test_get_ticket_points_an_outside_agent_to_the_shared_guides,
//   test_get_ticket_lists_uploaded_files_with_absolute_paths, test_get_ticket_raises_for_missing_id,
//   test_list_tickets_percent_is_literal_not_wildcard
// - manage_ticket: test_update_ticket_status_changes_status, test_update_ticket_status_raises_for_missing,
//   test_create_ticket_unknown_project_raises, test_update_ticket_title, test_update_ticket_unknown_id_raises,
//   test_create_child_ticket, test_create_child_ticket_unknown_parent_raises,
//   test_create_child_ticket_depth_violation_raises, test_update_ticket_description_publishes_sse,
//   test_update_ticket_nonexistent_does_not_publish_sse, test_story_ticket_can_have_sub_tickets,
//   test_story_nesting_on_update_respects_depth
// - ticket_items: test_add_comment, test_add_comment_unknown_ticket_raises, test_update_comment,
//   test_update_comment_unknown_ticket_raises, test_update_comment_unknown_comment_raises, test_delete_comment,
//   test_list_and_restore_comment, test_delete_comment_unknown_ticket_raises, test_add_work_log,
//   test_add_work_log_unknown_ticket_raises, test_add_test_case, test_add_test_case_unknown_ticket_raises,
//   test_update_test_case_status, test_update_test_case_unknown_ticket_raises, test_update_test_case_unknown_id_raises,
//   test_add_acceptance_criterion_publishes_sse, test_add_test_case_publishes_sse, test_add_work_log_publishes_sse,
//   test_add_comment_publishes_sse
