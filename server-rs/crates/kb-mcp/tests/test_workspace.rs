//! `tests/test_workspace.py`: `test_mcp_tool_returns_path_and_creates_folder` (the others are in `kb-board`).

mod common;

use common::{call, call_err};
use serde_json::json;

#[tokio::test]
async fn test_mcp_tool_returns_path_and_creates_folder() {
    let s = common::start().await;
    let (mcp, c) = (s.mcp(), s.client());
    let root = tempfile::tempdir().expect("a temporary folder");
    // `_setup`
    c.patch("/workspace/settings", json!({"root_path": root.path().to_str().expect("text")})).await.assert_status(200);
    let made = c.post("/projects", json!({"name": "W", "prefix": "WS", "color": "#123456"})).await;
    let p = made.json();
    let t = c.post(&format!("/projects/{}/tickets", p["id"].as_str().expect("id")), json!({"title": "t"})).await.json();
    let id = t["id"].as_str().expect("an id");

    let folder = root.path().join(id);
    let info = call(&mcp, "manage_ticket", json!({"action": "workspace", "ticket_id": id})).await;
    assert_eq!(info, json!({"enabled": true, "path": folder.to_str().expect("text"), "exists": true}));
    assert!(folder.is_dir());
    let refused = call_err(&mcp, "manage_ticket", json!({"action": "workspace", "ticket_id": "NOPE-1"})).await;
    assert!(refused.contains("not found"), "{refused}");
    let full = call(&mcp, "get_ticket", json!({"ticket_id": id})).await;
    assert_eq!(full["workspace_path"], folder.to_str().expect("text"));
    let refused = call_err(&mcp, "manage_ticket", json!({"action": "workspace", "ticket_id": "../etc"})).await;
    assert!(refused.contains("not found"), "{refused}");
}
