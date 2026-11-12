//! `tests/test_activity.py`: `test_mcp_changes_are_attributed_to_the_agent` (the others are in `kb-board`).

mod common;

use std::collections::BTreeMap;

use common::{call, rest_ticket};
use serde_json::{Value, json};

#[tokio::test]
async fn test_mcp_changes_are_attributed_to_the_agent() {
    let s = common::start().await;
    let (mcp, c) = (s.mcp(), s.client());
    let (_, t) = rest_ticket(&c, "t", "ACT", json!({})).await;
    let id = t["id"].as_str().expect("an id");
    call(&mcp, "manage_ticket", json!({"action": "update", "ticket_id": id, "status": "in-progress"})).await;
    for (text, author) in [("from agent", "claude"), ("default author", "user")] {
        call(
            &mcp,
            "ticket_items",
            json!({"ticket_id": id, "item": "comment", "action": "add", "text": text, "author": author}),
        )
        .await;
    }
    let log = |ticket: Value| -> Vec<Value> { ticket["activity_log"].as_array().expect("log").clone() };
    let first = log(c.get(&format!("/tickets/{id}")).await.json());
    c.patch(&format!("/tickets/{id}"), json!({"priority": "low"})).await.assert_status(200);
    let second = log(c.get(&format!("/tickets/{id}")).await.json());
    let got: BTreeMap<(String, String), Value> = first
        .iter()
        .map(|e| ((e["field"].as_str().unwrap_or_default().to_string(), e["to"].as_str().unwrap_or_default().to_string()), e["actor"].clone()))
        .collect();
    assert_eq!(got[&("status".to_string(), "in-progress".to_string())], "agent");
    assert_eq!(got[&("comment".to_string(), "from agent".to_string())], "claude");
    assert_eq!(got[&("comment".to_string(), "default author".to_string())], "agent");
    // the agent actor did not leak into later REST calls
    assert_eq!(second[second.len() - 1]["actor"], "user");
}
