//! `tests/test_tickets_269_server_fields.py`: the MCP line of `test_a_person_names_whose_review_a_ticket_waits_for`
//! (the rest of the test is in `kb-board`): an AI clears `review_requested_from` over MCP like any other field.

mod common;

use common::{call, rest_ticket};
use serde_json::json;

#[tokio::test]
async fn test_a_person_names_whose_review_a_ticket_waits_for() {
    let s = common::start().await;
    let (mcp, c) = (s.mcp(), s.client());
    let (p, t) = rest_ticket(&c, "t", "RVW", json!({})).await;
    let ha = c.post(&format!("/projects/{}/members", p["id"].as_str().expect("id")), json!({"name": "Ha My"})).await.json();
    let tid = t["id"].as_str().expect("an id");
    let r = c.patch(&format!("/tickets/{tid}"), json!({"status": "review", "review_requested_from": ha["id"]})).await;
    r.assert_status(200);
    let got = c.get(&format!("/tickets/{tid}")).await.json();
    assert_eq!(got["review_requested_from"], ha["id"]);
    // an AI clears it over MCP like any other field
    let out = call(
        &mcp,
        "manage_ticket",
        json!({"action": "update", "ticket_id": tid, "clear_fields": ["review_requested_from"]}),
    )
    .await;
    assert!(out["review_requested_from"].is_null(), "{out}");
}
