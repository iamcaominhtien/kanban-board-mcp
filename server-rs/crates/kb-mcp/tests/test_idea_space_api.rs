//! `tests/test_idea_space_api.py`: `test_an_ai_member_can_read_ideas_and_add_to_the_inbox_only` (the others are in
//! `kb-ideas`). The Idea Space tools are listed with `KANBAN_MCP_IDEA_TOOLS=1`.

mod common;

use common::call;
use serde_json::json;
use testkit::Options;

#[tokio::test]
async fn test_an_ai_member_can_read_ideas_and_add_to_the_inbox_only() {
    let s = common::start_with(Options { env: vec![("KANBAN_MCP_IDEA_TOOLS".into(), "1".into())], ..Options::default() }).await;
    let (mcp, c) = (s.mcp(), s.client());
    let made = c.post("/projects", json!({"name": "Idea Project", "prefix": "IDQ", "color": "#123456"})).await;
    made.assert_status(201);
    let p = made.json();
    let created = call(
        &mcp,
        "create_idea_ticket",
        json!({"title": "Split the card renderer", "description": "It is 480 lines.", "project_id": p["id"],
               "why": "Out of scope for KAN-231", "ticket_id": "KAN-231"}),
    )
    .await;
    let listed = call(&mcp, "list_idea_tickets", json!({"project_id": p["id"]})).await;
    let assumptions = call(&mcp, "list_idea_assumptions", json!({"ticket_id": created["id"]})).await;
    let trail = call(&mcp, "get_idea_activity_trail", json!({"ticket_id": created["id"]})).await;

    assert!(created["stage"] == "inbox" && created["source"] == "ai", "{created}");
    assert_eq!(created["source_ref"]["why"], "Out of scope for KAN-231");
    assert_eq!(created["source_ref"]["id"], "KAN-231");
    assert_eq!(created["created_by"], "agent");
    let listed_ids: Vec<&serde_json::Value> = listed.as_array().expect("a list").iter().map(|i| &i["id"]).collect();
    assert_eq!(listed_ids, [&created["id"]]);
    assert_eq!(assumptions["readiness"]["state"], "not_started");
    let trail = trail.as_array().expect("a list");
    assert_eq!(trail[trail.len() - 1]["ai"], true);
    // no tool moves, edits, promotes or deletes an idea (`not hasattr(ops, ...)`)
    let tools = common::tools(&mcp).await;
    for name in ["update_idea_status", "promote_idea_to_ticket", "delete_idea_ticket"] {
        assert!(!tools.contains_key(name), "{name}");
    }
}
