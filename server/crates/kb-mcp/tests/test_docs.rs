//! `tests/test_docs.py`: the one test of its MCP section (the rest are the REST routes and the services, ported with
//! the Docs crate).

mod common;

use common::{call, call_err};
use serde_json::json;

#[tokio::test]
async fn test_mcp_docs_tools_round_trip_and_conflict() {
    let s = common::start().await;
    let (mcp, c) = (s.mcp(), s.client());
    let made = c.post("/projects", json!({"name": "Kanban", "prefix": "KAN", "color": "#0a0"})).await;
    let pid = made.json()["id"].clone();
    let created = call(
        &mcp,
        "docs_write",
        json!({"action": "create", "project_id": pid, "title": "Runbook", "markdown": "## Steps\n1. go"}),
    )
    .await;
    assert!(created["version"] == 1 && created["status"] == "published");
    let page = call(&mcp, "docs_read", json!({"action": "get", "page_id": created["id"]})).await;
    assert!(page["markdown"].as_str().expect("text").starts_with("## Steps") && page["headings"][0]["slug"] == "steps");
    let updated = call(
        &mcp,
        "docs_write",
        json!({"action": "update", "page_id": created["id"], "markdown": "## Steps\n1. stop", "base_version": page["version"], "note": "tweak"}),
    )
    .await;
    assert_eq!(updated["version"], 2);
    let refused = call_err(
        &mcp,
        "docs_write",
        json!({"action": "update", "page_id": created["id"], "markdown": "stale", "base_version": 1}),
    )
    .await;
    assert!(refused.contains("docs_read"), "{refused}");
    let draft_only = call(
        &mcp,
        "docs_write",
        json!({"action": "update", "page_id": created["id"], "markdown": "wip", "base_version": 2, "publish": false}),
    )
    .await;
    assert!(draft_only["published"] == false && draft_only["version"] == 2);
    let tree = call(&mcp, "docs_read", json!({"action": "list", "project_id": pid})).await;
    let rows: Vec<(String, i64)> = tree
        .as_array()
        .expect("a list")
        .iter()
        .map(|t| (t["title"].as_str().expect("a title").to_string(), t["version"].as_i64().expect("a version")))
        .collect();
    assert_eq!(rows, [("Runbook".to_string(), 2)]);
}
