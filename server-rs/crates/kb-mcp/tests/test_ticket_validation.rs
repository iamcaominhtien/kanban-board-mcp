//! `tests/test_ticket_validation.py`: the two `test_mcp_*` tests of the file (the others are in `kb-board`). The
//! Python tests call the operations; here each goes through the tool that routes to it.

mod common;

use common::{call, call_err, rest_ticket, rest_ticket_in};
use serde_json::{Value, json};

#[tokio::test]
async fn test_mcp_can_set_and_clear_fields() {
    let s = common::start().await;
    let (mcp, c) = (s.mcp(), s.client());
    let (p, t) = rest_ticket(&c, "t", "ACT", json!({})).await;
    let made = c.post(&format!("/projects/{}/members", p["id"].as_str().expect("id")), json!({"name": "Bao", "color": "#2E6F40"})).await;
    made.assert_status(201);
    let m = made.json();
    let i = &t["id"];
    let update = |extra: Value| {
        let mut arguments = json!({"action": "update", "ticket_id": i});
        for (key, value) in extra.as_object().expect("an object") {
            arguments[key] = value.clone();
        }
        arguments
    };
    let r = call(
        &mcp,
        "manage_ticket",
        update(json!({"assignee": m["id"], "start_date": "2026-01-01", "due_date": "2026-02-01", "estimate": 2,
                      "block_done_if_acs_incomplete": true, "block_done_if_tcs_incomplete": true})),
    )
    .await;
    assert!(r["assignee"] == m["id"] && r["start_date"] == "2026-01-01", "{r}");
    assert!(r["block_done_if_acs_incomplete"] == true && r["block_done_if_tcs_incomplete"] == true);
    let r = call(&mcp, "manage_ticket", update(json!({"clear_fields": ["assignee", "due_date", "estimate"]}))).await;
    assert!(r["assignee"].is_null() && r["due_date"].is_null() && r["estimate"].is_null(), "{r}");
    // `title` is not a field that can be emptied: the schema refuses it
    call_err(&mcp, "manage_ticket", update(json!({"clear_fields": ["title"]}))).await;
    let refused = call_err(&mcp, "manage_ticket", update(json!({"estimate": 1, "clear_fields": ["estimate"]}))).await;
    assert!(refused.contains("was both set and listed in clear_fields"), "{refused}");
    // won't do needs a reason
    call_err(&mcp, "manage_ticket", update(json!({"status": "wont_do"}))).await;
    let r = call(&mcp, "manage_ticket", update(json!({"status": "wont_do", "wont_do_reason": "duplicate work"}))).await;
    assert!(r["status"] == "wont_do" && r["wont_do_reason"] == "duplicate work", "{r}");
}

#[tokio::test]
async fn test_mcp_block_link_test_case_and_delete_tools() {
    let s = common::start().await;
    let (mcp, c) = (s.mcp(), s.client());
    let (p, a) = rest_ticket(&c, "t", "ACT", json!({})).await;
    let b = rest_ticket_in(&c, &p["id"], "b", json!({})).await["id"].clone();
    let aid = a["id"].as_str().expect("id");
    let made = c.post(&format!("/tickets/{aid}/test-cases"), json!({"title": "tc"})).await;
    made.assert_status(200);
    let tc = made.json();

    let res = call(&mcp, "manage_ticket", json!({"action": "block", "ticket_id": b, "target_id": a["id"]})).await;
    // `ops.block_ticket(a, b)`: a is the blocker, so the tool's ticket_id is the blocked one
    assert!(res["blocker"]["blocks"].as_array().expect("blocks").contains(&b), "{res}");
    assert!(res["blocked"]["blocked_by"].as_array().expect("blocked_by").contains(&a["id"]));
    // the other way round would be a cycle
    call_err(&mcp, "manage_ticket", json!({"action": "block", "ticket_id": a["id"], "target_id": b})).await;
    let res = call(&mcp, "manage_ticket", json!({"action": "unblock", "ticket_id": b, "target_id": a["id"]})).await;
    assert_eq!(res["blocker"]["blocks"], json!([]));
    let link = call(
        &mcp,
        "manage_ticket",
        json!({"action": "link", "ticket_id": a["id"], "target_id": b, "relation_type": "relates_to"}),
    )
    .await;
    assert_eq!(link["target_id"], b);
    let removed = call(&mcp, "manage_ticket", json!({"action": "unlink", "ticket_id": a["id"], "link_id": link["id"]})).await;
    assert_eq!(removed, json!({"removed": link["id"]}));
    let after = call(
        &mcp,
        "ticket_items",
        json!({"ticket_id": a["id"], "item": "test_case", "action": "delete", "item_id": tc["test_cases"][0]["id"]}),
    )
    .await;
    assert_eq!(after["test_cases"], json!([]));
    assert_eq!(call(&mcp, "manage_ticket", json!({"action": "delete", "ticket_id": b})).await, json!({"deleted": b}));
    let refused = call_err(&mcp, "manage_ticket", json!({"action": "delete", "ticket_id": b})).await;
    assert!(refused.contains("not found"), "{refused}");
}
