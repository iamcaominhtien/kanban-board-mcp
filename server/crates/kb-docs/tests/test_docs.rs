//! `tests/test_docs.py` (the tests that go through the routes of this half). `test_slugify_and_duplicate_anchors` and
//! `test_parse_references_skips_code_and_tracks_sections` are in `kb-doctext`; `test_diff_markdown_counts_and_word_level`
//! is a unit test of `kb_docs::docs::versions`; `test_mcp_docs_tools_round_trip_and_conflict` waits for the MCP port.

mod common;

use common::{exec, id, mk, new_ticket, pid, publish};
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

// --- tree ------------------------------------------------------------------

#[tokio::test]
async fn test_create_from_template_is_draft_with_unique_slug() {
    let (_s, c, pid) = setup!("test_create_from_template_is_draft_with_unique_slug");
    let a = mk(&c, &pid, "API", json!({"template": "requirements"})).await;
    assert!(a["status"] == "draft" && a["version"] == 0 && a["markdown"] == "");
    assert!(a["draft"]["markdown"].as_str().unwrap().contains("## Summary"));
    let b = mk(&c, &pid, "API", json!({})).await;
    assert_eq!((a["slug"].clone(), b["slug"].clone()), (json!("api"), json!("api-2")));
}

#[tokio::test]
async fn test_title_required_and_bad_template() {
    let (_s, c, pid) = setup!("test_title_required_and_bad_template");
    assert_eq!(c.post(&format!("/projects/{pid}/docs/pages"), json!({"title": "  "})).await.status, 422);
    let r = c.post(&format!("/projects/{pid}/docs/pages"), json!({"title": "x", "template": "nope"})).await;
    assert!(r.status == 422 && r.json()["detail"]["code"] == "bad_template");
}

#[tokio::test]
async fn test_tree_ordering_and_move_rules() {
    let (_s, c, pid) = setup!("test_tree_ordering_and_move_rules");
    let (a, b, d) =
        (mk(&c, &pid, "A", json!({})).await, mk(&c, &pid, "B", json!({})).await, mk(&c, &pid, "D", json!({})).await);
    let child = mk(&c, &pid, "Child", json!({"parent_id": a["id"]})).await;
    let r = c.post(&format!("/docs/pages/{}/move", id(&d)), json!({"parent_id": null, "before_id": a["id"]})).await;
    assert_eq!(r.status, 200);
    let titles = |tree: &Value, parent: &Value| -> Vec<String> {
        tree.as_array()
            .unwrap()
            .iter()
            .filter(|n| n["parent_id"] == *parent)
            .map(|n| n["title"].as_str().unwrap().to_string())
            .collect()
    };
    let tree = c.get(&format!("/projects/{pid}/docs/tree")).await.json();
    assert_eq!(titles(&tree, &Value::Null), ["D", "A", "B"]);
    // nest B under A after Child
    c.post(&format!("/docs/pages/{}/move", id(&b)), json!({"parent_id": a["id"], "after_id": child["id"]})).await;
    let tree = c.get(&format!("/projects/{pid}/docs/tree")).await.json();
    assert_eq!(titles(&tree, &a["id"]), ["Child", "B"]);
    // cycle
    let r = c.post(&format!("/docs/pages/{}/move", id(&a)), json!({"parent_id": child["id"]})).await;
    assert!(r.status == 409 && r.json()["detail"]["code"] == "cycle");
    let r = c.post(&format!("/docs/pages/{}/move", id(&a)), json!({"parent_id": a["id"]})).await;
    assert_eq!(r.status, 409);
}

#[tokio::test]
async fn test_rename_keeps_slug() {
    let (_s, c, pid) = setup!("test_rename_keeps_slug");
    let a = mk(&c, &pid, "Old name", json!({})).await;
    let r = c.patch(&format!("/docs/pages/{}", id(&a)), json!({"title": "New name"})).await;
    assert!(r.json()["title"] == "New name" && r.json()["slug"] == "old-name");
}

#[tokio::test]
async fn test_duplicate_with_children() {
    let (_s, c, pid) = setup!("test_duplicate_with_children");
    let a = mk(&c, &pid, "A", json!({"markdown": "## Hi"})).await;
    mk(&c, &pid, "Kid", json!({"parent_id": a["id"]})).await;
    let r = c.post(&format!("/docs/pages/{}/duplicate", id(&a)), json!({"include_children": true})).await;
    let copy = r.json();
    assert!(copy["title"] == "A (copy)" && copy["status"] == "draft");
    let tree = c.get(&format!("/projects/{pid}/docs/tree")).await.json();
    let kids: Vec<&Value> =
        tree.as_array().unwrap().iter().filter(|n| n["parent_id"] == copy["id"]).map(|n| &n["title"]).collect();
    assert_eq!(kids, [&json!("Kid")]);
    assert_eq!(tree.as_array().unwrap().len(), 4);
}

// --- draft / publish / versions -------------------------------------------

#[tokio::test]
async fn test_draft_publish_version_flow() {
    let (_s, c, pid) = setup!("test_draft_publish_version_flow");
    let p = mk(&c, &pid, "API", json!({})).await;
    let p = publish(&c, &p, "## One\nfirst", Some("first cut")).await;
    assert_eq!(
        (p["version"].clone(), p["status"].clone(), p["has_unpublished_changes"].clone()),
        (json!(1), json!("published"), json!(false))
    );
    assert!(p["draft"].is_null() && p["markdown"].as_str().unwrap().starts_with("## One"));
    c.put(&format!("/docs/pages/{}/draft", id(&p)), json!({"markdown": "## One\nsecond"})).await;
    let cur = c.get(&format!("/docs/pages/{}", id(&p))).await.json();
    assert!(cur["has_unpublished_changes"] == true && cur["markdown"].as_str().unwrap().ends_with("first"));
    let p = publish(&c, &p, "## One\nsecond", None).await;
    assert_eq!(p["version"], 2);
    let versions = c.get(&format!("/docs/pages/{}/versions", id(&p))).await.json();
    let nums: Vec<&Value> = versions.as_array().unwrap().iter().map(|v| &v["version"]).collect();
    assert_eq!(nums, [&json!(2), &json!(1)]);
    assert_eq!(versions[1]["note"], "first cut");
}

#[tokio::test]
async fn test_publish_conflict_returns_409() {
    let (_s, c, pid) = setup!("test_publish_conflict_returns_409");
    let p = publish(&c, &mk(&c, &pid, "API", json!({})).await, "v1", None).await;
    publish(&c, &p, "v2", None).await;
    let r = c.post(&format!("/docs/pages/{}/publish", id(&p)), json!({"base_version": 1, "markdown": "mine"})).await;
    assert_eq!(r.status, 409);
    let detail = r.json()["detail"].clone();
    assert!(detail["code"] == "conflict" && detail["latest_version"] == 2);
}

#[tokio::test]
async fn test_publish_without_draft_is_422_and_discard() {
    let (_s, c, pid) = setup!("test_publish_without_draft_is_422_and_discard");
    let p = publish(&c, &mk(&c, &pid, "API", json!({})).await, "v1", None).await;
    let r = c.post(&format!("/docs/pages/{}/publish", id(&p)), json!({"base_version": 1})).await;
    assert_eq!(r.status, 422);
    c.put(&format!("/docs/pages/{}/draft", id(&p)), json!({"markdown": "edit"})).await;
    let r = c.delete(&format!("/docs/pages/{}/draft", id(&p))).await;
    assert!(r.json()["draft"].is_null() && r.json()["markdown"] == "v1");
}

#[tokio::test]
async fn test_restore_adds_new_version_and_diff() {
    let (_s, c, pid) = setup!("test_restore_adds_new_version_and_diff");
    let p = publish(&c, &mk(&c, &pid, "API", json!({})).await, "## A\nold", None).await;
    publish(&c, &p, "## A\nnew", None).await;
    let r = c.post(&format!("/docs/pages/{}/versions/1/restore", id(&p)), json!({})).await;
    let body = r.json();
    assert!(body["version"] == 3 && body["markdown"] == "## A\nold");
    let versions = c.get(&format!("/docs/pages/{}/versions", id(&p))).await.json();
    assert_eq!(versions[0]["note"], "Restored from v1");
    let d = c.get(&format!("/docs/pages/{}/versions/1/diff/2", id(&p))).await.json();
    assert_eq!((d["added"].clone(), d["removed"].clone()), (json!(1), json!(1)));
    assert_eq!(c.get(&format!("/docs/pages/{}/versions/9", id(&p))).await.status, 404);
}

// --- delete / recycle bin --------------------------------------------------

#[tokio::test]
async fn test_delete_restore_subtree_and_orphan_child() {
    let (_s, c, pid) = setup!("test_delete_restore_subtree_and_orphan_child");
    let a = mk(&c, &pid, "A", json!({})).await;
    let kid = mk(&c, &pid, "Kid", json!({"parent_id": a["id"]})).await;
    let r = c.delete(&format!("/docs/pages/{}", id(&a))).await;
    assert_eq!(r.json()["deleted_pages"], 2);
    assert_eq!(c.get(&format!("/projects/{pid}/docs/tree")).await.json(), json!([]));
    assert_eq!(c.get(&format!("/docs/pages/{}", id(&a))).await.status, 410);
    let bin = c.get(&format!("/projects/{pid}/docs/recycle-bin")).await.json();
    assert!(bin.as_array().unwrap().len() == 1 && bin[0]["page_count"] == 2 && bin[0]["title"] == "A");
    assert_eq!(bin[0]["child_titles"], json!(["Kid"]));
    // restoring only the child while its parent stays deleted lands at top level
    let r = c.post_empty(&format!("/docs/pages/{}/restore", id(&kid))).await;
    assert_eq!(r.json()["moved_to_top_level"], true);
    let tree = c.get(&format!("/projects/{pid}/docs/tree")).await.json();
    let rows: Vec<(Value, Value)> =
        tree.as_array().unwrap().iter().map(|n| (n["title"].clone(), n["parent_id"].clone())).collect();
    assert_eq!(rows, [(json!("Kid"), Value::Null)]);
    let r = c.post_empty(&format!("/docs/pages/{}/restore", id(&a))).await;
    assert_eq!(r.json()["restored_pages"], 1);
}

#[tokio::test]
async fn test_restore_whole_subtree() {
    let (_s, c, pid) = setup!("test_restore_whole_subtree");
    let a = mk(&c, &pid, "A", json!({})).await;
    mk(&c, &pid, "Kid", json!({"parent_id": a["id"]})).await;
    c.delete(&format!("/docs/pages/{}", id(&a))).await;
    let r = c.post_empty(&format!("/docs/pages/{}/restore", id(&a))).await;
    assert!(r.json()["restored_pages"] == 2 && r.json()["moved_to_top_level"] == false);
    assert_eq!(c.get(&format!("/projects/{pid}/docs/tree")).await.json().as_array().unwrap().len(), 2);
}

#[tokio::test]
async fn test_purge_only_from_bin() {
    let (_s, c, pid) = setup!("test_purge_only_from_bin");
    let a = mk(&c, &pid, "A", json!({})).await;
    assert_eq!(c.delete(&format!("/docs/pages/{}/purge", id(&a))).await.status, 409);
    c.delete(&format!("/docs/pages/{}", id(&a))).await;
    assert_eq!(c.delete(&format!("/docs/pages/{}/purge", id(&a))).await.status, 204);
    assert_eq!(c.get(&format!("/docs/pages/{}", id(&a))).await.status, 404);
}

#[tokio::test]
async fn test_purge_expired_after_30_days() {
    let (s, c, pid) = setup!("test_purge_expired_after_30_days");
    let a = mk(&c, &pid, "A", json!({})).await;
    c.delete(&format!("/docs/pages/{}", id(&a))).await;
    exec(
        &s,
        "UPDATE docs_page SET deleted_at = ? WHERE id = ?",
        &[json!("2000-01-01T00:00:00+00:00"), a["id"].clone()],
    )
    .await;
    assert_eq!(c.get(&format!("/projects/{pid}/docs/recycle-bin")).await.json(), json!([]));
    assert_eq!(c.get(&format!("/docs/pages/{}", id(&a))).await.status, 404);
}

// --- references ------------------------------------------------------------

#[tokio::test]
async fn test_references_backlinks_and_resolve() {
    let (_s, c, pid) = setup!("test_references_backlinks_and_resolve");
    let t = new_ticket(&c, &pid, json!({"title": "Rate limiting", "type": "task"})).await;
    let key = id(&t);
    let target = publish(&c, &mk(&c, &pid, "Data model", json!({})).await, "## Fields\nx", None).await;
    let src = publish(
        &c,
        &mk(&c, &pid, "API", json!({})).await,
        &format!("## Overview\nSee [[Data model#Fields]], [[Data model#Nope]], [[Ghost]] and {key}."),
        None,
    )
    .await;
    let bl = c.get(&format!("/docs/pages/{}/backlinks", id(&target))).await.json();
    let titles: Vec<&Value> = bl["pages"].as_array().unwrap().iter().map(|p| &p["title"]).collect();
    assert_eq!(titles, [&json!("API")]);
    assert_eq!(bl["pages"][0]["in"], "Overview");
    let refs = json!([
        {"kind": "page", "title": "data model", "anchor": "Fields"},
        {"kind": "page", "title": "Data model", "anchor": "Nope"},
        {"kind": "page", "title": "Ghost"},
        {"kind": "ticket", "key": key},
        {"kind": "ticket", "key": "KAN-999"},
    ]);
    let res = c.post(&format!("/projects/{pid}/docs/resolve"), json!({"refs": refs})).await.json();
    let statuses: Vec<&Value> = res.as_array().unwrap().iter().map(|r| &r["status"]).collect();
    assert_eq!(statuses, [&json!("ok"), &json!("section_missing"), &json!("missing"), &json!("ok"), &json!("missing")]);
    assert!(res[0]["page_id"] == target["id"] && res[3]["title"] == "Rate limiting");
    let linked = c.get(&format!("/tickets/{key}/docs")).await.json();
    let ids: Vec<&Value> = linked.as_array().unwrap().iter().map(|d| &d["page_id"]).collect();
    assert_eq!(ids, [&src["id"]]);
}

#[tokio::test]
async fn test_resolve_in_bin_and_ambiguous_prefers_shallowest() {
    let (_s, c, pid) = setup!("test_resolve_in_bin_and_ambiguous_prefers_shallowest");
    let parent = mk(&c, &pid, "Parent", json!({})).await;
    mk(&c, &pid, "Auth", json!({"parent_id": parent["id"]})).await;
    let top = mk(&c, &pid, "Auth", json!({})).await;
    let gone = mk(&c, &pid, "Gone", json!({})).await;
    c.delete(&format!("/docs/pages/{}", id(&gone))).await;
    let res = c
        .post(
            &format!("/projects/{pid}/docs/resolve"),
            json!({"refs": [{"kind": "page", "title": "Auth"}, {"kind": "page", "title": "Gone"}, {"kind": "page", "title": "Parent/Auth"}]}),
        )
        .await
        .json();
    assert!(res[0]["page_id"] == top["id"] && res[0]["status"] == "ok");
    assert_eq!(res[1]["status"], "in_bin");
    assert_eq!(res[2]["path"], "Parent/Auth");
}

#[tokio::test]
async fn test_ticket_description_backlink() {
    let (_s, c, pid) = setup!("test_ticket_description_backlink");
    let target = publish(&c, &mk(&c, &pid, "Spec", json!({})).await, "## A", None).await;
    new_ticket(&c, &pid, json!({"title": "T", "type": "task", "description": "see [[Spec]]"})).await;
    let bl = c.get(&format!("/docs/pages/{}/backlinks", id(&target))).await.json();
    let titles: Vec<&Value> = bl["tickets"].as_array().unwrap().iter().map(|t| &t["title"]).collect();
    assert_eq!(titles, [&json!("T")]);
}

#[tokio::test]
async fn test_by_slug_and_templates() {
    let (_s, c, pid) = setup!("test_by_slug_and_templates");
    let a = mk(&c, &pid, "Rate limits", json!({})).await;
    let r = c.get(&format!("/projects/{pid}/docs/by-slug/rate-limits")).await;
    assert_eq!(r.json()["id"], a["id"]);
    assert_eq!(c.get(&format!("/projects/{pid}/docs/by-slug/nope")).await.status, 404);
    let tpls = c.get("/docs/templates").await.json();
    let mut ids: Vec<String> = tpls.as_array().unwrap().iter().map(|t| t["id"].as_str().unwrap().to_string()).collect();
    ids.sort();
    let mut want: Vec<&str> = vec![
        "blank",
        "requirements",
        "meeting-notes",
        "decision-log",
        "technical-design",
        "feature-spec",
        "bugfix-spec",
        "decision-table",
        "use-case",
        "example-map",
        "one-pager",
        "data-dictionary",
        "nfr-checklist",
    ];
    want.sort();
    assert_eq!(ids, want);
}

#[tokio::test]
async fn test_forward_reference_resolves_when_target_is_published_later() {
    let (_s, c, pid) = setup!("test_forward_reference_resolves_when_target_is_published_later");
    let src = publish(&c, &mk(&c, &pid, "Overview", json!({})).await, "See [[API#Endpoints]].", None).await;
    let target = mk(&c, &pid, "API", json!({})).await;
    let url = format!("/docs/pages/{}/backlinks", id(&target));
    assert_eq!(c.get(&url).await.json()["pages"], json!([]));
    publish(&c, &target, "## Endpoints\nx", None).await;
    let bl = c.get(&url).await.json();
    let ids: Vec<&Value> = bl["pages"].as_array().unwrap().iter().map(|p| &p["page_id"]).collect();
    assert_eq!(ids, [&src["id"]]);
    // renaming the target away breaks the link; renaming back repairs it
    c.patch(&format!("/docs/pages/{}", id(&target)), json!({"title": "Reference"})).await;
    assert_eq!(c.get(&url).await.json()["pages"], json!([]));
    c.patch(&format!("/docs/pages/{}", id(&target)), json!({"title": "API"})).await;
    assert_eq!(c.get(&url).await.json()["pages"].as_array().unwrap().len(), 1);
}

#[tokio::test]
async fn test_resolve_markdown_link_by_slug_after_rename() {
    // A link written by slug or page id (what the AI sees in docs_read) opens the page; a rename keeps the slug.
    let (_s, c, pid) = setup!("test_resolve_markdown_link_by_slug_after_rename");
    let page = mk(&c, &pid, "Tổng quan", json!({})).await;
    let old_slug = page["slug"].as_str().unwrap().to_string();
    assert_eq!(old_slug, "tổng-quan");
    c.patch(&format!("/docs/pages/{}", id(&page)), json!({"title": "Overview"})).await;
    let link = |title: &str| json!({"kind": "page", "by_slug": true, "title": title});
    let mut with_anchor = link("overview");
    with_anchor["anchor"] = json!("Nope");
    let refs = json!([link(&old_slug), link("Overview"), link(&id(&page)), with_anchor, link("no-such-page"), {"kind": "page", "title": old_slug}]);
    let res = c.post(&format!("/projects/{pid}/docs/resolve"), json!({"refs": refs})).await.json();
    let res = res.as_array().unwrap();
    assert!(res[..3].iter().all(|r| r["page_id"] == page["id"]));
    assert!(res[..3].iter().all(|r| r["title"] == "Overview"));
    assert_eq!(res[3]["status"], "section_missing");
    assert!(res[4..].iter().all(|r| r["status"] == "missing"));
}
