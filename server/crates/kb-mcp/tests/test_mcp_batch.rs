//! `tests/test_mcp_batch.py`: many calls in one, `items` on `ticket_items` runs them in order, each as a call of its
//! own. The ticket comes from the REST API (the Python tests take it from the AI team's helpers).

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
    let titles: Vec<&str> = out["ticket"]["test_cases"]
        .as_array()
        .expect("test cases")
        .iter()
        .filter_map(|t| t["title"].as_str())
        .collect();
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
    let refused = call_err(&mcp, "docs_write", json!({"action": "delete", "page_id": "x", "items": [{}]})).await;
    assert!(refused.contains("items only works with"), "{refused}");
    let many: Vec<serde_json::Value> = (0..26).map(|i| json!({"title": format!("T{i}")})).collect();
    let refused =
        call_err(&mcp, "ticket_items", json!({"ticket_id": tid, "item": "test_case", "action": "add", "items": many}))
            .await;
    assert!(refused.contains("at most 25"), "{refused}");
    let refused =
        call_err(&mcp, "ticket_items", json!({"ticket_id": tid, "item": "test_case", "action": "add", "items": []}))
            .await;
    assert!(refused.contains("non-empty list"), "{refused}");
    // without items nothing changes
    let one =
        call(&mcp, "ticket_items", json!({"ticket_id": tid, "item": "test_case", "action": "add", "title": "Solo"}))
            .await;
    let titles: Vec<&str> =
        one["test_cases"].as_array().expect("test cases").iter().filter_map(|t| t["title"].as_str()).collect();
    assert_eq!(titles, ["Solo"]);
}

/// `DOC` of `tests/test_docs_comments.py`.
const DOC: &str = "# API\n\nEvery route requires a bearer token; rotation rules live in [[Auth]].\n\n## Limits\n\nRate limits are not enforced yet. Tracked in KAN-12.\n\n| Method | Path |\n|---|---|\n| GET | /tickets |\n";

/// `publish(c, page_id, markdown)` of `tests/test_docs_comments.py`.
async fn publish(c: &testkit::Client, page_id: &str, markdown: &str) {
    c.put(&format!("/docs/pages/{page_id}/draft"), json!({"markdown": markdown})).await.assert_status(200);
    let current = c.get(&format!("/docs/pages/{page_id}")).await.json();
    let published =
        c.post(&format!("/docs/pages/{page_id}/publish"), json!({"base_version": current["version"]})).await;
    published.assert_status(200);
}

/// `inline(c, page, quote=...)`: a person's inline comment on a quote of the page.
async fn inline(c: &testkit::Client, page_id: &str, quote: &str) -> serde_json::Value {
    let made = c
        .clone()
        .header("x-actor", "user")
        .post(
            &format!("/docs/pages/{page_id}/comments"),
            json!({"kind": "inline", "body": "Is this enough?",
                   "anchor": {"quote": quote, "prefix": "Every route requires a ", "suffix": "; rotation", "section": "api"}}),
        )
        .await;
    made.assert_status(201);
    made.json()
}

#[tokio::test]
async fn test_comments_replies_and_resolves_in_one_call_each() {
    let s = common::start().await;
    let (mcp, c) = (s.mcp(), s.client());
    let (project, _) = common::rest_ticket(&c, "t", "BAT", json!({})).await;
    let page = c
        .post(&format!("/projects/{}/docs/pages", project["id"].as_str().expect("an id")), json!({"title": "API"}))
        .await
        .json();
    let page_id = page["id"].as_str().expect("an id");
    publish(&c, page_id, DOC).await;
    let mut threads = Vec::new();
    for quote in ["bearer token", "rotation"] {
        threads.push(inline(&c, page_id, quote).await);
    }
    let made = call(
        &mcp,
        "docs_write",
        json!({"action": "comment", "page_id": page_id, "items": [
            {"body": "One", "quote": "Every route"},
            {"body": "Two", "quote": "rotation"},
            {"body": "Three", "quote": "not in the page"},
        ]}),
    )
    .await;
    assert_eq!((&made["done"], &made["failed"]), (&json!(2), &json!(1)));
    assert!(made["results"][2]["error"].as_str().expect("an error").contains("not in the published page"), "{made}");
    let ids: Vec<&serde_json::Value> = threads.iter().map(|t| &t["id"]).collect();
    let items: Vec<serde_json::Value> = ids.iter().map(|i| json!({"thread_id": i, "body": "Fixed in v2"})).collect();
    let replied = call(&mcp, "docs_write", json!({"action": "reply", "items": items})).await;
    assert_eq!(replied["done"], 2);
    let items: Vec<serde_json::Value> = ids.iter().map(|i| json!({"thread_id": i})).collect();
    let resolved = call(&mcp, "docs_write", json!({"action": "resolve", "items": items})).await;
    assert_eq!(resolved["done"], 2);
    let listed = c.get(&format!("/docs/pages/{page_id}/comments")).await.json();
    for id in ids {
        let thread = listed["threads"].as_array().expect("threads").iter().find(|t| &t["id"] == id).expect("a thread");
        assert_eq!(thread["status"], "resolved");
    }
}
