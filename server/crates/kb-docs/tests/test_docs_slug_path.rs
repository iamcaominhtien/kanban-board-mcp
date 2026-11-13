//! `tests/test_docs_slug_path.py`: the slug path of a page and `by-path`. The last test of the Python file compares
//! `slug_path` with the whole-space `_slug_paths` through service calls: that part is `docs_service.rs`; here the
//! answers it gives for the same tree.

mod common;

use common::{exec, id, mk, pid};
use serde_json::{Value, json};
use testkit::{Server, skip_unless_available};

macro_rules! setup {
    ($name:expr) => {{
        if !skip_unless_available($name) {
            return;
        }
        let s = Server::start().await;
        let c = s.client();
        let pid = pid(&c).await;
        (s, c, pid)
    }};
}

#[tokio::test]
async fn test_a_page_has_a_slug_path_from_its_tree_path() {
    let (_s, c, pid) = setup!("test_a_page_has_a_slug_path_from_its_tree_path");
    let arch = mk(&c, &pid, "Architecture", json!({})).await;
    let api = mk(&c, &pid, "API", json!({"parent_id": arch["id"]})).await;
    let d = c.get(&format!("/docs/pages/{}", id(&api))).await.json();
    assert_eq!(d["slug_path"], "architecture/api");
    let r = c.get_query(&format!("/projects/{pid}/docs/by-path"), &[("path", "architecture/api")]).await;
    assert!(r.status == 200 && r.json()["id"] == api["id"]);
    // the page id keeps working, as before
    assert_eq!(c.get(&format!("/docs/pages/{}", id(&api))).await.status, 200);
}

#[tokio::test]
async fn test_a_rename_changes_the_path_and_the_old_one_still_opens_the_page() {
    let (_s, c, pid) = setup!("test_a_rename_changes_the_path_and_the_old_one_still_opens_the_page");
    let arch = mk(&c, &pid, "Architecture", json!({})).await;
    let api = mk(&c, &pid, "API", json!({"parent_id": arch["id"]})).await;
    c.patch(&format!("/docs/pages/{}", id(&arch)), json!({"title": "Design"})).await;
    c.patch(&format!("/docs/pages/{}", id(&api)), json!({"title": "REST API"})).await;
    let d = c.get(&format!("/docs/pages/{}", id(&api))).await.json();
    assert_eq!(d["slug_path"], "design/rest-api");
    // the slug it got when made stays (Markdown links use it)
    assert_eq!(d["slug"], "api");
    for old in ["architecture/api", "design/api", "architecture/rest-api", "design/rest-api"] {
        let r = c.get_query(&format!("/projects/{pid}/docs/by-path"), &[("path", old)]).await;
        assert!(r.status == 200 && r.json()["id"] == api["id"], "{old}");
    }
}

#[tokio::test]
async fn test_a_moved_page_still_opens_by_its_old_path() {
    let (_s, c, pid) = setup!("test_a_moved_page_still_opens_by_its_old_path");
    let a = mk(&c, &pid, "Guides", json!({})).await;
    let b = mk(&c, &pid, "Reference", json!({})).await;
    let page = mk(&c, &pid, "Setup", json!({"parent_id": a["id"]})).await;
    let r = c.post(&format!("/docs/pages/{}/move", id(&page)), json!({"parent_id": b["id"]})).await;
    assert_eq!(r.status, 200, "{}", r.text());
    let r = c.get_query(&format!("/projects/{pid}/docs/by-path"), &[("path", "guides/setup")]).await;
    assert!(r.status == 200 && r.json()["id"] == page["id"]);
}

#[tokio::test]
async fn test_two_pages_with_the_same_path_share_by_id_and_unknown_paths_are_404() {
    let (_s, c, pid) = setup!("test_two_pages_with_the_same_path_share_by_id_and_unknown_paths_are_404");
    let a = mk(&c, &pid, "Notes", json!({})).await;
    let b = mk(&c, &pid, "Notes", json!({})).await;
    let da = c.get(&format!("/docs/pages/{}", id(&a))).await.json();
    let db = c.get(&format!("/docs/pages/{}", id(&b))).await.json();
    assert!(da["slug_path"].is_null() && db["slug_path"].is_null());
    // each still opens by the slug it was made with
    let r = c.get_query(&format!("/projects/{pid}/docs/by-path"), &[("path", db["slug"].as_str().unwrap())]).await;
    assert!(r.status == 200 && r.json()["id"] == b["id"]);
    let r = c.get_query(&format!("/projects/{pid}/docs/by-path"), &[("path", "nothing/here")]).await;
    assert_eq!(r.status, 404);
}

#[tokio::test]
async fn test_the_slug_path_walks_only_the_ancestors_and_matches_the_whole_tree() {
    let (s, c, pid) = setup!("test_the_slug_path_walks_only_the_ancestors_and_matches_the_whole_tree");
    let a = mk(&c, &pid, "Guides", json!({})).await;
    // two "guides": everything under them is shared by id
    let a2 = mk(&c, &pid, "Guides", json!({})).await;
    let under = mk(&c, &pid, "Setup", json!({"parent_id": a["id"]})).await;
    let under2 = mk(&c, &pid, "Setup", json!({"parent_id": a2["id"]})).await;
    let reference = mk(&c, &pid, "Reference", json!({})).await;
    let api = mk(&c, &pid, "API", json!({"parent_id": reference["id"]})).await;
    let leaf = mk(&c, &pid, "Errors", json!({"parent_id": api["id"]})).await;
    let gone = mk(&c, &pid, "Old", json!({})).await;
    let orphan = mk(&c, &pid, "Orphan", json!({"parent_id": gone["id"]})).await;
    // same path as the orphan once its parent is deleted
    let loose = mk(&c, &pid, "Orphan", json!({})).await;
    for n in 0..30 {
        mk(&c, &pid, &format!("Other {n}"), json!({"parent_id": reference["id"]})).await;
    }
    // only the parent is deleted (an old row): its child reads as top level
    exec(
        &s,
        "UPDATE docs_page SET deleted_at = ? WHERE id = ?",
        &[json!("2000-01-01T00:00:00+00:00"), gone["id"].clone()],
    )
    .await;

    let slug_path = |p: &Value| {
        let c = c.clone();
        let url = format!("/docs/pages/{}", id(p));
        async move { c.get(&url).await.json()["slug_path"].clone() }
    };
    assert_eq!(slug_path(&leaf).await, "reference/api/errors");
    for pg in [&under, &under2, &a, &a2, &orphan, &loose] {
        assert_eq!(slug_path(pg).await, Value::Null);
    }
}
