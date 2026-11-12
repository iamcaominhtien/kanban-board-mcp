//! `tests/test_ticket_validation.py`, the tests of the ticket's own fields and of the parent rules. Left for the
//! routes they need: `test_block_rules`, `test_text_fields_must_not_be_blank` and
//! `test_delete_ticket_leaves_no_dangling_references` (blocks, links, comments, criteria, test cases; the last one is
//! checked on rows a test adds in `tickets_routes.rs`), and the two `test_mcp_*` tests (the MCP tools).

mod common;

use common::{get_ticket, id};
use serde_json::{Value, json};
use testkit::{Client, Server, skip_unless_available};

/// `_ticket` of `tests/test_activity.py`: a project and a ticket in it.
async fn _ticket(c: &Client, title: &str, prefix: &str) -> (Value, Value) {
    let p = c.post("/projects", json!({"name": prefix, "prefix": prefix, "color": "#123456"})).await.json();
    let r = c.post(&format!("/projects/{}/tickets", id(&p)), json!({"title": title})).await;
    assert_eq!(r.status, 201, "{}", r.text());
    (p, r.json())
}

async fn _second(c: &Client, project_id: &str, title: &str, extra: Value) -> String {
    let mut body = json!({"title": title});
    for (key, value) in extra.as_object().expect("extra fields") {
        body[key] = value.clone();
    }
    let r = c.post(&format!("/projects/{project_id}/tickets"), body).await;
    assert_eq!(r.status, 201, "{}", r.text());
    id(&r.json())
}

/// The parameters of the Python test, each on a ticket of its own (one server for all of them).
#[tokio::test]
async fn test_bad_ticket_fields_are_rejected() {
    if !skip_unless_available("test_bad_ticket_fields_are_rejected") {
        return;
    }
    let s = Server::start().await;
    let c = s.client();
    let bodies = [
        json!({"title": ""}),
        json!({"title": "   "}),
        json!({"title": "x".repeat(301)}),
        json!({"due_date": "not-a-date"}),
        json!({"start_date": "2026-13-45"}),
        json!({"start_date": "2026-12-01", "due_date": "2026-01-01"}),
        json!({"estimate": -5}),
        json!({"estimate": 1e12}),
        json!({"tags": [1]}),
        json!({"tags": [{"a": 1}]}),
        json!({"tags": ["x".repeat(51)]}),
        json!({"tags": (0..31).map(|i| format!("t{i}")).collect::<Vec<_>>()}),
    ];
    for (n, body) in bodies.into_iter().enumerate() {
        let prefix = format!("AC{}", (b'A' + n as u8) as char);
        let (_, t) = _ticket(&c, "t", &prefix).await;
        let r = c.patch(&format!("/tickets/{}", id(&t)), body.clone()).await;
        assert_eq!(r.status, 400, "{body}: {}", r.text());
        assert_eq!(get_ticket(&c, &id(&t)).await["title"], "t");
    }
}

#[tokio::test]
async fn test_valid_values_are_normalised() {
    if !skip_unless_available("test_valid_values_are_normalised") {
        return;
    }
    let s = Server::start().await;
    let c = s.client();
    let (_, t) = _ticket(&c, "t", "ACT").await;
    let r = c
        .patch(
            &format!("/tickets/{}", id(&t)),
            json!({
                "title": "  Hello  ",
                "tags": [" a ", "A", "", "b"],
                "due_date": "2026-05-01",
                "start_date": "2026-04-01",
                "estimate": 3.5,
            }),
        )
        .await;
    assert_eq!(r.status, 200, "{}", r.text());
    let j = r.json();
    assert!(j["title"] == "Hello" && j["tags"] == json!(["a", "b"]) && j["estimate"] == 3.5);
    // explicit null / empty string clears the date
    let r = c.patch(&format!("/tickets/{}", id(&t)), json!({"due_date": "", "start_date": null})).await;
    assert!(r.json()["due_date"].is_null() && r.json()["start_date"].is_null());
}

#[tokio::test]
async fn test_create_validates_too() {
    if !skip_unless_available("test_create_validates_too") {
        return;
    }
    let s = Server::start().await;
    let c = s.client();
    let (p, _) = _ticket(&c, "t", "ACT").await;
    for body in
        [json!({"title": " "}), json!({"title": "ok", "due_date": "bad"}), json!({"title": "ok", "estimate": -1})]
    {
        let r = c.post(&format!("/projects/{}/tickets", id(&p)), body.clone()).await;
        assert_eq!(r.status, 400, "{body}: {}", r.text());
    }
}

#[tokio::test]
async fn test_parent_rules() {
    if !skip_unless_available("test_parent_rules") {
        return;
    }
    let s = Server::start().await;
    let c = s.client();
    let (p, a) = _ticket(&c, "t", "ACT").await;
    let a = id(&a);
    let b = _second(&c, &id(&p), "b", json!({})).await;
    let child = _second(&c, &id(&p), "child", json!({})).await;
    let other_p = c.post("/projects", json!({"name": "O", "prefix": "OTH", "color": "#123456"})).await.json();
    let o = _second(&c, &id(&other_p), "o", json!({})).await;
    let patch = |ticket: String, parent: Value| {
        let c = c.clone();
        async move { c.patch(&format!("/tickets/{ticket}"), json!({"parent_id": parent})).await.status }
    };
    assert_eq!(patch(a.clone(), json!(a)).await, 400); // self
    assert_eq!(patch(a.clone(), json!("ZZZ-9")).await, 400); // missing
    assert_eq!(patch(a.clone(), json!(o)).await, 400); // other project
    assert_eq!(patch(child.clone(), json!(b)).await, 200);
    // b is now a child's parent: it can't itself get a parent, and a child can't become a parent
    assert_eq!(patch(b.clone(), json!(a)).await, 400);
    assert_eq!(patch(a.clone(), json!(child)).await, 400);
    // clearing is fine
    assert_eq!(patch(child.clone(), Value::Null).await, 200);
    let r = c.post(&format!("/projects/{}/tickets", id(&p)), json!({"title": "x", "parent_id": o})).await;
    assert_eq!(r.status, 400);
}
