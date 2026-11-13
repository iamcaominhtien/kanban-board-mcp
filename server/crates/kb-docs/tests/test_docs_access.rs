//! `tests/test_docs_access.py`: who may read and edit a project's Docs.

mod common;

use common::{count, id, member, pid};
use serde_json::{Value, json};
use testkit::{Client, Server, skip_unless_available};

/// The `pid` and `page` fixtures: a project with Vera (viewer), Mia (member) and Ada (admin), and a published page.
async fn fixtures(c: &Client) -> (String, Value) {
    let pid = pid(c).await;
    for (name, role) in [("Vera", "viewer"), ("Mia", "member"), ("Ada", "admin")] {
        member(c, &pid, name, role).await;
    }
    let page = c.post(&format!("/projects/{pid}/docs/pages"), json!({"title": "API"})).await.json();
    c.put(&format!("/docs/pages/{}/draft", id(&page)), json!({"markdown": "## Hi\n\nText\n"})).await;
    let cur = c.get(&format!("/docs/pages/{}", id(&page))).await.json();
    c.post(&format!("/docs/pages/{}/publish", id(&page)), json!({"base_version": cur["version"]})).await;
    (pid, page)
}

fn as_(c: &Client, name: &str) -> Client {
    c.clone().header("x-actor", name)
}

/// Status codes for a draft save and a page create by `who`.
async fn edits(c: &Client, pid: &str, page_id: &str, who: &str) -> (u16, u16) {
    let draft = as_(c, who).put(&format!("/docs/pages/{page_id}/draft"), json!({"markdown": "x"})).await;
    let create = as_(c, who).post(&format!("/projects/{pid}/docs/pages"), json!({"title": format!("By {who}")})).await;
    (draft.status, create.status)
}

#[tokio::test]
async fn test_default_policy_lets_members_edit_and_viewers_only_read() {
    if !skip_unless_available("test_default_policy_lets_members_edit_and_viewers_only_read") {
        return;
    }
    let s = Server::start().await;
    let c = s.client();
    let (pid, page) = fixtures(&c).await;
    let access = as_(&c, "Vera").get(&format!("/projects/{pid}/docs/access")).await.json();
    assert_eq!(access["role"], "viewer");
    assert_eq!(access["can_edit"], false);
    assert_eq!(access["policy"], "members");
    assert_eq!(access["admins"], json!(["Ada"]));

    assert_eq!(as_(&c, "Vera").get(&format!("/docs/pages/{}", id(&page))).await.status, 200);
    let r = as_(&c, "Vera").put(&format!("/docs/pages/{}/draft", id(&page)), json!({"markdown": "x"})).await;
    assert_eq!(r.status, 403);
    assert_eq!(r.json()["detail"]["code"], "read_only");
    let v = as_(&c, "Vera");
    for (method, url, body) in [
        ("DELETE", format!("/docs/pages/{}", id(&page)), None),
        ("POST", format!("/docs/pages/{}/publish", id(&page)), Some(json!({"base_version": 1}))),
        ("POST", format!("/docs/pages/{}/versions/1/restore", id(&page)), Some(json!({}))),
    ] {
        let body = body.map(|b| b.to_string().into_bytes());
        let r = v.request(method, &url, &[("content-type", "application/json")], body).await;
        assert_eq!(r.status, 403, "{url}");
    }

    assert_eq!(edits(&c, &pid, &id(&page), "Mia").await, (200, 201));
    assert!(as_(&c, "Mia").get(&format!("/projects/{pid}/docs/access")).await.json()["can_edit"].as_bool().unwrap());
}

#[tokio::test]
async fn test_admins_only_and_everyone_policies() {
    if !skip_unless_available("test_admins_only_and_everyone_policies") {
        return;
    }
    let s = Server::start().await;
    let c = s.client();
    let (pid, page) = fixtures(&c).await;
    let r = c.patch(&format!("/projects/{pid}"), json!({"docs_edit_policy": "admins"})).await;
    assert_eq!(r.status, 200);
    assert_eq!(r.json()["docs_edit_policy"], "admins");
    assert_eq!(edits(&c, &pid, &id(&page), "Mia").await.0, 403);
    assert_eq!(edits(&c, &pid, &id(&page), "Ada").await, (200, 201));
    // the board's own user is always an admin
    assert_eq!(edits(&c, &pid, &id(&page), "user").await.0, 200);

    c.patch(&format!("/projects/{pid}"), json!({"docs_edit_policy": "everyone"})).await;
    assert_eq!(edits(&c, &pid, &id(&page), "Vera").await, (200, 201));
}

#[tokio::test]
async fn test_only_admins_change_docs_settings() {
    if !skip_unless_available("test_only_admins_change_docs_settings") {
        return;
    }
    let s = Server::start().await;
    let c = s.client();
    let (pid, _page) = fixtures(&c).await;
    let r = as_(&c, "Mia").patch(&format!("/projects/{pid}"), json!({"docs_edit_policy": "everyone"})).await;
    assert_eq!(r.status, 403);
    let r = as_(&c, "Mia").patch(&format!("/projects/{pid}"), json!({"docs_enabled": false})).await;
    assert_eq!(r.status, 403);
    let r = as_(&c, "Ada").patch(&format!("/projects/{pid}"), json!({"docs_edit_policy": "admins"})).await;
    assert_eq!(r.status, 200);
    assert_eq!(c.patch(&format!("/projects/{pid}"), json!({"docs_edit_policy": "nobody"})).await.status, 422);
    // other project fields stay open to everyone
    let r = as_(&c, "Mia").patch(&format!("/projects/{pid}"), json!({"name": "K2"})).await;
    assert_eq!(r.status, 200);
}

#[tokio::test]
async fn test_non_member_has_no_access_and_can_request_it() {
    if !skip_unless_available("test_non_member_has_no_access_and_can_request_it") {
        return;
    }
    let s = Server::start().await;
    let c = s.client();
    let (pid, page) = fixtures(&c).await;
    let r = as_(&c, "Stranger").get(&format!("/docs/pages/{}", id(&page))).await;
    assert_eq!(r.status, 403);
    assert_eq!(r.json()["detail"]["code"], "docs_no_access");
    let r = as_(&c, "Stranger").get(&format!("/projects/{pid}/docs/tree")).await;
    assert_eq!(r.json()["detail"]["code"], "docs_no_access");
    let access = as_(&c, "Stranger").get(&format!("/projects/{pid}/docs/access")).await.json();
    assert_eq!(access["access"], false);
    assert_eq!(access["can_edit"], false);

    let r = as_(&c, "Stranger")
        .post(&format!("/projects/{pid}/docs/access-requests"), json!({"note": "I need to read the API docs"}))
        .await;
    assert_eq!(r.status, 201);
    assert_eq!(r.json(), json!({"sent": true, "admins": ["Ada"]}));
    // asking again right away does not notify twice
    let again = as_(&c, "Stranger").post(&format!("/projects/{pid}/docs/access-requests"), json!({})).await;
    assert_eq!(again.json()["sent"], false);

    let r = c.get_query(&format!("/projects/{pid}/docs/comment-events"), &[("recipient", "Ada")]).await;
    assert_eq!(r.status, 200);
    let events = r.json();
    assert_eq!(events.as_array().unwrap().len(), 1);
    let e = &events[0];
    assert_eq!(e["kind"], "access_request");
    assert_eq!(e["actor"], "Stranger");
    assert!(e["page_id"].is_null());
    assert_eq!(e["snippet"], "I need to read the API docs");
    assert!(e["recipients"].as_array().unwrap().contains(&json!("user")));
    // the row itself
    assert_eq!(count(&s, "SELECT COUNT(*) FROM docs_comment_event WHERE kind = 'access_request'", &[]).await, 1);

    // a member asking is a no-op
    let r = as_(&c, "Mia").post(&format!("/projects/{pid}/docs/access-requests"), json!({})).await;
    assert_eq!(r.json()["sent"], false);
}

#[tokio::test]
async fn test_disabled_space_answers_docs_disabled_before_access() {
    if !skip_unless_available("test_disabled_space_answers_docs_disabled_before_access") {
        return;
    }
    let s = Server::start().await;
    let c = s.client();
    let (pid, _page) = fixtures(&c).await;
    c.patch(&format!("/projects/{pid}"), json!({"docs_enabled": false})).await;
    let r = as_(&c, "Stranger").get(&format!("/projects/{pid}/docs/access")).await;
    assert_eq!(r.status, 403);
    assert_eq!(r.json()["detail"]["code"], "docs_disabled");
}
