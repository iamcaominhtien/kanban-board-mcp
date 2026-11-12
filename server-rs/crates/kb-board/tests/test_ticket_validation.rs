//! `tests/test_ticket_validation.py`: the ticket's own fields, the parent rules, the block rules, the texts that must
//! not be blank and what a deleted ticket leaves behind. The two `test_mcp_*` tests wait for the MCP tools.

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

#[tokio::test]
async fn test_block_rules() {
    if !skip_unless_available("test_block_rules") {
        return;
    }
    let s = Server::start().await;
    let c = s.client();
    let (p, a) = _ticket(&c, "t", "ACT").await;
    let a = id(&a);
    let b = _second(&c, &id(&p), "b", json!({})).await;
    let d = _second(&c, &id(&p), "d", json!({})).await;
    let other_p = c.post("/projects", json!({"name": "O", "prefix": "OTH", "color": "#123456"})).await.json();
    let o = _second(&c, &id(&other_p), "o", json!({})).await;
    assert_eq!(c.post_empty(&format!("/tickets/{a}/blocks/{o}")).await.status, 400); // cross-project
    assert_eq!(c.post_empty(&format!("/tickets/{a}/blocks/{b}")).await.status, 200);
    assert_eq!(c.post_empty(&format!("/tickets/{b}/blocks/{a}")).await.status, 400); // direct cycle
    assert_eq!(c.post_empty(&format!("/tickets/{b}/blocks/{d}")).await.status, 200);
    assert_eq!(c.post_empty(&format!("/tickets/{d}/blocks/{a}")).await.status, 400); // transitive cycle
}

#[tokio::test]
async fn test_text_fields_must_not_be_blank() {
    if !skip_unless_available("test_text_fields_must_not_be_blank") {
        return;
    }
    let s = Server::start().await;
    let c = s.client();
    let (_, t) = _ticket(&c, "t", "ACT").await;
    let i = id(&t);
    assert_eq!(c.post(&format!("/tickets/{i}/comments"), json!({"text": "  ", "author": "x"})).await.status, 400);
    let long = "y".repeat(50001);
    assert_eq!(c.post(&format!("/tickets/{i}/comments"), json!({"text": long, "author": "x"})).await.status, 400);
    assert_eq!(c.post(&format!("/tickets/{i}/acceptance-criteria"), json!({"text": " "})).await.status, 400);
    assert_eq!(c.post(&format!("/tickets/{i}/test-cases"), json!({"title": " "})).await.status, 400);
    let ok = c.post(&format!("/tickets/{i}/comments"), json!({"text": " hi ", "author": "x"})).await;
    assert!(ok.status == 200 && ok.json()["comments"][0]["text"] == "hi");
    let cid = id(&ok.json()["comments"][0]);
    assert_eq!(c.patch(&format!("/tickets/{i}/comments/{cid}"), json!({"text": ""})).await.status, 400);
    let tc = id(&c.post(&format!("/tickets/{i}/test-cases"), json!({"title": "tc"})).await.json()["test_cases"][0]);
    assert_eq!(c.patch(&format!("/tickets/{i}/test-cases/{tc}"), json!({"title": " "})).await.status, 400);
}

#[tokio::test]
async fn test_delete_ticket_leaves_no_dangling_references() {
    if !skip_unless_available("test_delete_ticket_leaves_no_dangling_references") {
        return;
    }
    let s = Server::start().await;
    let c = s.client();
    let (p, parent) = _ticket(&c, "t", "ACT").await;
    let parent = id(&parent);
    let child = _second(&c, &id(&p), "child", json!({"parent_id": parent})).await;
    let peer = _second(&c, &id(&p), "peer", json!({})).await;
    c.post_empty(&format!("/tickets/{parent}/blocks/{peer}")).await;
    c.post(&format!("/tickets/{parent}/links"), json!({"target_id": peer, "relation_type": "relates_to"})).await;
    assert_eq!(c.delete(&format!("/tickets/{parent}")).await.status, 204);
    let ch = get_ticket(&c, &child).await;
    assert!(ch["parent_id"].is_null());
    let pr = get_ticket(&c, &peer).await;
    assert_eq!(pr["blocked_by"], json!([]));
    assert_eq!(pr["links"], json!([]));
}
