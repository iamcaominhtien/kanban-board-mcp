//! `tests/test_debug_space.py`: the `test_mcp_*` test of the file (the others are in `kb-board`).

mod common;

use common::{call, call_err};
use serde_json::json;

#[tokio::test]
async fn test_mcp_can_delete_work_log_and_is_validated() {
    let s = common::start().await;
    let mcp = s.mcp();
    let p = call(&mcp, "manage_project", json!({"action": "create", "name": "M", "prefix": "MWL"})).await;
    let t = call(&mcp, "manage_ticket", json!({"action": "create", "project_id": p["id"], "title": "x"})).await;
    let item = |action: &str, rest: serde_json::Value| {
        let mut arguments = json!({"ticket_id": t["id"], "item": "work_log", "action": action});
        for (key, value) in rest.as_object().expect("an object") {
            arguments[key] = value.clone();
        }
        arguments
    };
    let added =
        call(&mcp, "ticket_items", item("add", json!({"author": "agent", "role": "Developer", "note": "n"}))).await;
    let lid = added["work_log"][0]["id"].clone();
    // a role the board does not have
    call_err(&mcp, "ticket_items", item("add", json!({"author": "a", "role": "Wizard", "note": "n"}))).await;
    let result = call(&mcp, "ticket_items", item("delete", json!({"item_id": lid}))).await;
    assert_eq!(result["work_log"], json!([]));
    let refused = call_err(
        &mcp,
        "ticket_items",
        json!({"ticket_id": "NOPE-1", "item": "work_log", "action": "delete", "item_id": lid}),
    )
    .await;
    assert!(refused.contains("not found"), "{refused}");
}
