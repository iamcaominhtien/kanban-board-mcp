//! `tests/test_idea_tickets.py`: `test_get_idea_activity_trail_returns_entries_in_reverse_order` reads the trail
//! through the tool (the others are in `kb-ideas`).

mod common;

use common::call;
use serde_json::json;
use testkit::Options;

/// What `_trail_text` makes of an entry: its words, lower case.
fn trail_text(entry: &serde_json::Value) -> String {
    entry.to_string().to_lowercase()
}

#[tokio::test]
async fn test_get_idea_activity_trail_returns_entries_in_reverse_order() {
    let s =
        common::start_with(Options { env: vec![("KANBAN_MCP_IDEA_TOOLS".into(), "1".into())], ..Options::default() })
            .await;
    let (mcp, c) = (s.mcp(), s.client());
    let made = c.post("/projects", json!({"name": "Idea Project", "prefix": "IDQ", "color": "#123456"})).await;
    made.assert_status(201);
    let project = made.json();
    let made = c.post("/api/idea-tickets", json!({"project_id": project["id"], "title": "[TEST] Idea ticket"})).await;
    made.assert_status(201);
    let created = made.json();
    let id = created["id"].as_str().expect("an id");
    c.patch(&format!("/api/idea-tickets/{id}/status"), json!({"new_status": "in_review"})).await.assert_status(200);
    c.post(&format!("/api/idea-tickets/{id}/microthoughts"), json!({"text": "[TEST] Latest event"}))
        .await
        .assert_status(200);

    let trail = call(&mcp, "get_idea_activity_trail", json!({"ticket_id": id})).await;
    let trail = trail.as_array().expect("a list");
    assert!(trail.len() >= 3);
    assert!(trail_text(&trail[0]).contains("microthought"));
    assert!(trail_text(&trail[trail.len() - 1]).contains("idea created"));
}
