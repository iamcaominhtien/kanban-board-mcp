//! `PATCH /docs/pages/{page_id}/versions/{version}`: the history's "Edit note" changes one version's note and nothing
//! else.

mod common;

use common::{id, mk, pid, publish};
use serde_json::json;
use testkit::{Server, skip_unless_available};

#[tokio::test]
async fn a_version_note_can_be_changed_and_removed() {
    if !skip_unless_available("a_version_note_can_be_changed_and_removed") {
        return;
    }
    let s = Server::start().await;
    let c = s.client();
    let pid = pid(&c).await;
    let page = mk(&c, &pid, "Spec", json!({})).await;
    publish(&c, &page, "one", Some("First")).await;
    publish(&c, &page, "two", Some("Second")).await;
    let page_id = id(&page);
    let url = format!("/docs/pages/{page_id}/versions/2");
    let before = c.get(&url).await.json();

    let r = c.patch(&url, json!({"note": "  Added the 401 branch  "})).await;
    assert_eq!(r.status, 200, "{}", r.text());
    let v = r.json();
    assert_eq!(v["note"], "Added the 401 branch");
    // the version itself stays as it was
    for key in ["version", "title", "markdown", "author", "created_at"] {
        assert_eq!(v[key], before[key], "{key}");
    }
    let list = c.get(&format!("/docs/pages/{page_id}/versions")).await.json();
    let notes: Vec<_> = list.as_array().expect("list").iter().map(|v| v["note"].clone()).collect();
    assert_eq!(notes, [json!("Added the 401 branch"), json!("First")]);
    // no new version was written
    assert_eq!(c.get(&format!("/docs/pages/{page_id}")).await.json()["version"], 2);

    let r = c.patch(&url, json!({"note": ""})).await;
    assert_eq!(r.status, 200, "{}", r.text());
    assert!(r.json()["note"].is_null());
    let r = c.patch(&url, json!({"note": null})).await;
    assert_eq!(r.status, 200, "{}", r.text());
}

#[tokio::test]
async fn a_version_note_is_refused_when_too_long_or_the_version_is_missing() {
    if !skip_unless_available("a_version_note_is_refused_when_too_long_or_the_version_is_missing") {
        return;
    }
    let s = Server::start().await;
    let c = s.client();
    let pid = pid(&c).await;
    let page = mk(&c, &pid, "Spec", json!({})).await;
    publish(&c, &page, "one", Some("First")).await;
    let page_id = id(&page);

    let r = c.patch(&format!("/docs/pages/{page_id}/versions/1"), json!({"note": "x".repeat(201)})).await;
    assert_eq!(r.status, 422, "{}", r.text());
    assert_eq!(r.json()["detail"]["code"], "note_too_long", "{}", r.text());
    assert_eq!(c.get(&format!("/docs/pages/{page_id}/versions/1")).await.json()["note"], "First");

    let r = c.patch(&format!("/docs/pages/{page_id}/versions/9"), json!({"note": "x"})).await;
    assert_eq!(r.status, 404, "{}", r.text());
    let r = c.patch("/docs/pages/nope/versions/1", json!({"note": "x"})).await;
    assert_eq!(r.status, 404, "{}", r.text());
}
