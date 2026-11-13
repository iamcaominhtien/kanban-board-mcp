//! The test of `tests/test_ai_memory.py` that goes through the `knowledge` MCP tool: an outside agent reads the memory,
//! proposes a lesson and leaves a ticket note (the other tests of that file are in `kb-ai-know` and `kb-ai-api`).
//! The Rust target is the board's own server (`KANBAN_SERVER_BIN`): the instructions are set through its AI routes.

mod common;

use common::{call, call_err, rest_ticket};
use serde_json::json;
use testkit::{Server, skip_unless_available};

#[tokio::test]
async fn test_an_outside_agent_reads_the_memory_proposes_a_lesson_and_leaves_a_ticket_note() {
    if !skip_unless_available("test_an_outside_agent_reads_the_memory_proposes_a_lesson_and_leaves_a_ticket_note") {
        return;
    }
    let s = Server::start().await;
    let (mcp, c) = (s.mcp(), s.client());
    let (project, ticket) = rest_ticket(&c, "A ticket", "KAN", json!({})).await;
    let (pid, tid) = (project["id"].as_str().expect("an id").to_string(), ticket["id"].as_str().expect("an id"));
    c.put(&format!("/projects/{pid}/ai/knowledge/instructions"), json!({"instructions": "Tests: uv run pytest."}))
        .await
        .assert_status(200);
    let proposed = call(
        &mcp,
        "knowledge",
        json!({"action": "remember", "project_id": pid,
               "text": "Migrations need uv run alembic revision --autogenerate."}),
    )
    .await;
    assert_eq!(proposed["lesson"]["state"], "proposed");
    let note = call(
        &mcp,
        "knowledge",
        json!({"action": "remember", "project_id": pid, "scope": "ticket", "ticket_id": tid,
               "text": "The bug only shows with two tabs open."}),
    )
    .await;
    assert_eq!(note["note"]["scope"], "ticket");
    let refused =
        call_err(&mcp, "knowledge", json!({"action": "remember", "project_id": pid, "scope": "role", "text": "x"}))
            .await;
    assert!(refused.contains("Role notes are kept by a board run"), "{refused}");
    let mem = call(&mcp, "knowledge", json!({"action": "memory", "project_id": pid})).await;
    assert_eq!(mem["instructions"], "Tests: uv run pytest.");
    assert_eq!(mem["lessons"][0]["state"], "proposed");
    assert_eq!(mem["notes"][0]["text"], "The bug only shows with two tabs open.");
    // a proposal is counted where a person sees it, and tells the owners
    let page = c.get(&format!("/projects/{pid}/ai/knowledge")).await.json();
    assert_eq!(page["proposals"], 1);
    let gone =
        call(&mcp, "knowledge", json!({"action": "forget", "project_id": pid, "note_id": note["note"]["id"]})).await;
    assert_eq!(gone["forgot"], note["note"]["id"]);
}
