//! `tests/test_mcp_batch.py`: many calls in one, `items` on `ticket_items` runs them in order, each as a call of its
//! own. The ticket comes from the REST API (the Python tests take it from the AI team's helpers). The two tests of
//! `docs_write` (`test_comments_replies_and_resolves_in_one_call_each` and the `docs_write` half of
//! `test_only_light_actions_take_items_and_a_batch_has_a_size_limit`) wait for the docs tools.

mod common;

use common::{call, call_err};
use serde_json::json;

#[tokio::test]
async fn test_test_cases_are_added_in_order_and_a_bad_one_does_not_stop_the_rest() {
    let s = common::start().await;
    let (mcp, c) = (s.mcp(), s.client());
    let (_, ticket) = common::rest_ticket(&c, "t", "BAT", json!({})).await;
    let tid = ticket["id"].as_str().expect("an id");
    let out = call(
        &mcp,
        "ticket_items",
        json!({
            "ticket_id": tid,
            "item": "test_case",
            "action": "add",
            "items": [
                {"title": "First"},
                // no title
                {"status": "pass"},
                {"title": "Third", "status": "pass", "proof": "log"},
            ],
        }),
    )
    .await;
    assert_eq!((&out["done"], &out["failed"]), (&json!(2), &json!(1)));
    let oks: Vec<&serde_json::Value> = out["results"].as_array().expect("results").iter().map(|r| &r["ok"]).collect();
    assert_eq!(oks, [&json!(true), &json!(false), &json!(true)]);
    assert!(out["results"][1]["error"].as_str().expect("an error").contains("title"), "{out}");
    // the ticket comes back once, with both test cases in order
    let titles: Vec<&str> =
        out["ticket"]["test_cases"].as_array().expect("test cases").iter().filter_map(|t| t["title"].as_str()).collect();
    assert_eq!(titles, ["First", "Third"]);
    let got = c.get(&format!("/tickets/{tid}")).await.json();
    let titles: Vec<&str> =
        got["test_cases"].as_array().expect("test cases").iter().filter_map(|t| t["title"].as_str()).collect();
    assert_eq!(titles, ["First", "Third"]);
}

#[tokio::test]
async fn test_only_light_actions_take_items_and_a_batch_has_a_size_limit() {
    let s = common::start().await;
    let (mcp, c) = (s.mcp(), s.client());
    let (_, ticket) = common::rest_ticket(&c, "t", "BAT", json!({})).await;
    let tid = &ticket["id"];
    let many: Vec<serde_json::Value> = (0..26).map(|i| json!({"title": format!("T{i}")})).collect();
    let refused = call_err(
        &mcp,
        "ticket_items",
        json!({"ticket_id": tid, "item": "test_case", "action": "add", "items": many}),
    )
    .await;
    assert!(refused.contains("at most 25"), "{refused}");
    let refused =
        call_err(&mcp, "ticket_items", json!({"ticket_id": tid, "item": "test_case", "action": "add", "items": []})).await;
    assert!(refused.contains("non-empty list"), "{refused}");
    // without items nothing changes
    let one =
        call(&mcp, "ticket_items", json!({"ticket_id": tid, "item": "test_case", "action": "add", "title": "Solo"})).await;
    let titles: Vec<&str> =
        one["test_cases"].as_array().expect("test cases").iter().filter_map(|t| t["title"].as_str()).collect();
    assert_eq!(titles, ["Solo"]);
}
