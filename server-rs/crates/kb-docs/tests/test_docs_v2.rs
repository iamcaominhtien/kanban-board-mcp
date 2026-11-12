//! `tests/test_docs_v2.py`: rename preview and link rewrite, heading aliases, delete preview, docs_enabled, ticket
//! and docs origins, recycle bin, notifications and request ids.

mod common;

use std::collections::BTreeSet;
use std::time::Duration;

use common::{id, mk, pid, project, publish, ticket};
use serde_json::{Value, json};
use testkit::{Client, Server, skip_unless_available};

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

fn ids_of(v: &Value, key: &str) -> Vec<Value> {
    v.as_array().unwrap().iter().map(|p| p[key].clone()).collect()
}

async fn resolve(c: &Client, pid: &str, body: Value) -> Value {
    c.post(&format!("/projects/{pid}/docs/resolve"), body).await.json()
}

// --- page detail stats -------------------------------------------------------

#[tokio::test]
async fn test_page_detail_has_stats() {
    let (_s, c, pid) = setup!("test_page_detail_has_stats");
    let target = publish(&c, &mk(&c, &pid, "Spec", json!({})).await, "## A\none two three four", None).await;
    publish(&c, &mk(&c, &pid, "Src", json!({})).await, "See [[Spec]] and again [[Spec#A]].", None).await;
    let t = ticket(&c, &pid, json!({"description": "read [[Spec]]"})).await;
    let detail = c.get(&format!("/docs/pages/{}", id(&target))).await.json();
    assert_eq!(detail["stats"], json!({"words": 6, "linked_tickets": 1, "inbound_links": 1}));
    assert!(!detail["created_at"].as_str().unwrap().is_empty() && !detail["created_by"].as_str().unwrap().is_empty());
    c.post(&format!("/tickets/{}/docs", id(&t)), json!({"page_id": target["id"]})).await;
    let again = c.get(&format!("/docs/pages/{}", id(&target))).await.json();
    assert_eq!(again["stats"]["linked_tickets"], 1); // same ticket, still one
}

// --- rename preview + rewrite ------------------------------------------------

#[tokio::test]
async fn test_rename_preview_counts_links_in_published_text_and_drafts() {
    let (_s, c, pid) = setup!("test_rename_preview_counts_links_in_published_text_and_drafts");
    let target = publish(&c, &mk(&c, &pid, "Old name", json!({})).await, "## Intro\nx", None).await;
    let a = publish(
        &c,
        &mk(&c, &pid, "A", json!({})).await,
        "[[Old name]] and [[old name#Intro]] and [[Old name|label]]",
        None,
    )
    .await;
    let b = mk(&c, &pid, "B", json!({})).await; // draft only
    c.put(&format!("/docs/pages/{}/draft", id(&b)), json!({"markdown": "just [[Old name]]"})).await;
    publish(&c, &mk(&c, &pid, "C", json!({})).await, "unrelated [[Other]]", None).await;
    let url = format!("/docs/pages/{}/rename-preview", id(&target));
    let prev = c.get_query(&url, &[("title", "New")]).await.json();
    assert_eq!(prev["total"], 4);
    let got: BTreeSet<(String, i64)> = prev["affected_pages"]
        .as_array()
        .unwrap()
        .iter()
        .map(|p| (p["title"].as_str().unwrap().to_string(), p["count"].as_i64().unwrap()))
        .collect();
    assert_eq!(got, BTreeSet::from([("A".to_string(), 3), ("B".to_string(), 1)]));
    assert_eq!(prev["affected_pages"][0]["page_id"], a["id"]);
    let same = c.get_query(&url, &[("title", "Old name")]).await.json();
    assert_eq!(same, json!({"affected_pages": [], "total": 0}));
    assert_eq!(c.get_query(&url, &[("title", " ")]).await.status, 422);
}

#[tokio::test]
async fn test_rename_with_rewrite_updates_links_drafts_and_versions() {
    let (_s, c, pid) = setup!("test_rename_with_rewrite_updates_links_drafts_and_versions");
    let target = publish(&c, &mk(&c, &pid, "Old name", json!({})).await, "## Intro\nx", None).await;
    let a = publish(
        &c,
        &mk(&c, &pid, "A", json!({})).await,
        "[[Old name]], [[Old name#Intro]], [[old name|the label]], `[[Old name]]` in code\n```\n[[Old name]]\n```\n[[Other]]",
        None,
    )
    .await;
    let b = mk(&c, &pid, "B", json!({})).await;
    c.put(&format!("/docs/pages/{}/draft", id(&b)), json!({"markdown": "draft [[Old name|shown]]"})).await;
    let r = c.patch(&format!("/docs/pages/{}", id(&target)), json!({"title": "New name", "rewrite_links": true})).await;
    assert_eq!(r.status, 200);
    let body = r.json();
    assert!(body["title"] == "New name" && body["rewritten"] == 4 && body["rewritten_pages"] == 2);
    let page_a = c.get(&format!("/docs/pages/{}", id(&a))).await.json();
    assert_eq!(page_a["version"], 2);
    let md = page_a["markdown"].as_str().unwrap();
    assert_eq!(
        md.lines().next().unwrap(),
        "[[New name]], [[New name#Intro]], [[New name|the label]], `[[Old name]]` in code"
    );
    assert!(md.contains("```\n[[Old name]]\n```")); // code untouched
    assert!(md.ends_with("[[Other]]"));
    let versions = c.get(&format!("/docs/pages/{}/versions", id(&a))).await.json();
    assert_eq!(versions[0]["note"], "Link to \"New name\" updated");
    let page_b = c.get(&format!("/docs/pages/{}", id(&b))).await.json();
    assert_eq!(page_b["draft"]["markdown"], "draft [[New name|shown]]");
    // the link index follows: the backlink still points at the renamed page
    let bl = c.get(&format!("/docs/pages/{}/backlinks", id(&target))).await.json();
    assert_eq!(ids_of(&bl["pages"], "page_id"), [a["id"].clone()]);
}

#[tokio::test]
async fn test_rename_without_rewrite_leaves_links_alone() {
    let (_s, c, pid) = setup!("test_rename_without_rewrite_leaves_links_alone");
    let target = publish(&c, &mk(&c, &pid, "Old", json!({})).await, "## S\nx", None).await;
    let a = publish(&c, &mk(&c, &pid, "A", json!({})).await, "[[Old]]", None).await;
    let r = c.patch(&format!("/docs/pages/{}", id(&target)), json!({"title": "New"})).await;
    assert_eq!(r.json()["rewritten"], 0);
    assert_eq!(c.get(&format!("/docs/pages/{}", id(&a))).await.json()["version"], 1);
}

#[tokio::test]
async fn test_rewrite_keeps_drafts_publishable_and_skips_ambiguous_titles() {
    let (_s, c, pid) = setup!("test_rewrite_keeps_drafts_publishable_and_skips_ambiguous_titles");
    let target = publish(&c, &mk(&c, &pid, "Old", json!({})).await, "x", None).await;
    let a = publish(&c, &mk(&c, &pid, "A", json!({})).await, "[[Old]]", None).await;
    c.put(&format!("/docs/pages/{}/draft", id(&a)), json!({"markdown": "[[Old]] plus edits", "base_version": 1})).await;
    c.patch(&format!("/docs/pages/{}", id(&target)), json!({"title": "New", "rewrite_links": true})).await;
    let detail = c.get(&format!("/docs/pages/{}", id(&a))).await.json();
    assert!(detail["version"] == 2 && detail["draft"]["base_version"] == 2);
    let ok = c.post(&format!("/docs/pages/{}/publish", id(&a)), json!({"base_version": 2})).await;
    assert!(ok.status == 200 && ok.json()["markdown"].as_str().unwrap().contains("[[New]] plus edits"));

    // a second page titled "Same" at the top: [[Same]] resolves to it, so renaming the nested one rewrites nothing
    let top = publish(&c, &mk(&c, &pid, "Same", json!({})).await, "x", None).await;
    let nested = publish(&c, &mk(&c, &pid, "Same", json!({"parent_id": top["id"]})).await, "x", None).await;
    publish(&c, &mk(&c, &pid, "Linker", json!({})).await, "[[Same]]", None).await;
    let prev = c.get_query(&format!("/docs/pages/{}/rename-preview", id(&nested)), &[("title", "Else")]).await.json();
    assert_eq!(prev["total"], 0);
}

#[tokio::test]
async fn test_rewrite_rejects_titles_that_cannot_be_links() {
    let (_s, c, pid) = setup!("test_rewrite_rejects_titles_that_cannot_be_links");
    let target = publish(&c, &mk(&c, &pid, "Old", json!({})).await, "x", None).await;
    let url = format!("/docs/pages/{}", id(&target));
    let r = c.patch(&url, json!({"title": "C# tips", "rewrite_links": true})).await;
    assert!(r.status == 422 && r.json()["detail"]["code"] == "title_not_linkable");
    let ok = c.patch(&url, json!({"title": "C# tips"})).await;
    assert!(ok.status == 200 && ok.json()["title"] == "C# tips");
}

// --- heading rename aliases --------------------------------------------------

#[tokio::test]
async fn test_heading_rename_keeps_old_anchor_links_working() {
    let (_s, c, pid) = setup!("test_heading_rename_keeps_old_anchor_links_working");
    let target =
        publish(&c, &mk(&c, &pid, "Guide", json!({})).await, "## Intro\na\n## Setup\nb\n## Usage\nc", None).await;
    let refs = json!({"refs": [{"kind": "page", "title": "Guide", "anchor": "Setup"}]});
    assert_eq!(resolve(&c, &pid, refs.clone()).await[0]["status"], "ok");
    publish(&c, &target, "## Intro\na\n## Installation\nb\n## Usage\nc", None).await;
    let res = resolve(&c, &pid, refs.clone()).await[0].clone();
    assert!(res["status"] == "ok" && res["anchor"] == "installation" && res["anchor_renamed"] == true);
    assert_eq!(res["section"], "Installation");
    // chained rename keeps the first alias alive
    publish(&c, &target, "## Intro\na\n## Getting started\nb\n## Usage\nc", None).await;
    let res = resolve(&c, &pid, refs.clone()).await[0].clone();
    assert!(res["status"] == "ok" && res["anchor"] == "getting-started");
    // removing the heading entirely (no replacement) breaks it
    publish(&c, &target, "## Intro\na\n## Usage\nc", None).await;
    assert_eq!(resolve(&c, &pid, refs).await[0]["status"], "section_missing");
}

#[tokio::test]
async fn test_alias_does_not_apply_when_heading_count_changes_or_slug_is_reused() {
    let (_s, c, pid) = setup!("test_alias_does_not_apply_when_heading_count_changes_or_slug_is_reused");
    let target = publish(&c, &mk(&c, &pid, "Guide", json!({})).await, "## One\na\n## Two\nb", None).await;
    // pure addition: no alias
    publish(&c, &target, "## One\na\n## Two\nb\n## Three\nc", None).await;
    let refs = json!({"refs": [{"kind": "page", "title": "Guide", "anchor": "Gone"}]});
    assert_eq!(resolve(&c, &pid, refs).await[0]["status"], "section_missing");
    publish(&c, &target, "## One\na\n## Zwei\nb\n## Three\nc", None).await;
    let refs = json!({"refs": [{"kind": "page", "title": "Guide", "anchor": "Two"}]});
    assert_eq!(resolve(&c, &pid, refs.clone()).await[0]["anchor"], "zwei");
    // re-creating the old heading makes it a real heading again (the alias is dropped)
    publish(&c, &target, "## One\na\n## Two\nb\n## Zwei\nz\n## Three\nc", None).await;
    let res = resolve(&c, &pid, refs).await[0].clone();
    assert!(res["anchor"] == "two" && res.get("anchor_renamed").is_none());
}

// --- delete preview ----------------------------------------------------------

#[tokio::test]
async fn test_delete_preview_lists_subtree_and_linking_pages() {
    let (_s, c, pid) = setup!("test_delete_preview_lists_subtree_and_linking_pages");
    let root = publish(&c, &mk(&c, &pid, "Root", json!({})).await, "x", None).await;
    let kid = publish(&c, &mk(&c, &pid, "Kid", json!({"parent_id": root["id"]})).await, "x", None).await;
    publish(&c, &mk(&c, &pid, "Linker", json!({})).await, "[[Root]] and [[Kid]]", None).await;
    publish(&c, &mk(&c, &pid, "Linker 2", json!({})).await, "[[Kid#Nope]]", None).await;
    // inside the subtree: not counted
    publish(&c, &mk(&c, &pid, "Inside", json!({"parent_id": root["id"]})).await, "[[Root]]", None).await;
    let prev = c.get(&format!("/docs/pages/{}/delete-preview", id(&root))).await.json();
    let roles: BTreeSet<(String, String)> = prev["pages"]
        .as_array()
        .unwrap()
        .iter()
        .map(|p| (p["title"].as_str().unwrap().to_string(), p["role"].as_str().unwrap().to_string()))
        .collect();
    assert_eq!(
        roles,
        BTreeSet::from([
            ("Root".to_string(), "this".to_string()),
            ("Kid".to_string(), "child".to_string()),
            ("Inside".to_string(), "child".to_string())
        ])
    );
    assert!(prev["pages"][0]["role"] == "this" && prev["linking_pages"] == 2);
    // the dialog lists who links here, with link counts and the tickets that mention the pages
    let counts: Vec<i64> = prev["linking"].as_array().unwrap().iter().map(|r| r["count"].as_i64().unwrap()).collect();
    assert_eq!(counts, [2, 1]);
    assert!(prev["linking"].as_array().unwrap().iter().all(|r| r["parent"].is_null()));
    assert_eq!(prev["linking_tickets"], 0);
    let t = ticket(&c, &pid, json!({"description": "see [[Kid]]"})).await;
    let again = c.get(&format!("/docs/pages/{}/delete-preview", id(&root))).await.json();
    assert!(again["linking_tickets"] == 1 && !id(&t).is_empty());
    let leaf = c.get(&format!("/docs/pages/{}/delete-preview", id(&kid))).await.json();
    assert!(leaf["pages"] == json!([{"id": kid["id"], "title": "Kid", "role": "this"}]) && leaf["linking_pages"] == 2);
}

// --- docs_enabled ------------------------------------------------------------

#[tokio::test]
async fn test_docs_disabled_project_answers_403_everywhere() {
    let (_s, c, pid) = setup!("test_docs_disabled_project_answers_403_everywhere");
    let page = publish(&c, &mk(&c, &pid, "P", json!({})).await, "x", None).await;
    let t = ticket(&c, &pid, json!({})).await;
    let r = c.patch(&format!("/projects/{pid}"), json!({"docs_enabled": false})).await;
    assert!(r.status == 200 && r.json()["docs_enabled"] == false);
    assert!(c.get("/projects").await.json().as_array().unwrap().iter().any(|p| p["docs_enabled"] == false));
    let pg = id(&page);
    let mut calls = vec![
        c.get(&format!("/projects/{pid}/docs/tree")).await,
        c.post(&format!("/projects/{pid}/docs/pages"), json!({"title": "n"})).await,
        c.get(&format!("/docs/pages/{pg}")).await,
        c.get(&format!("/docs/pages/{pg}/versions")).await,
        c.get(&format!("/docs/pages/{pg}/backlinks")).await,
        c.get(&format!("/projects/{pid}/docs/recycle-bin")).await,
        c.delete(&format!("/projects/{pid}/docs/recycle-bin")).await,
        c.get_query(&format!("/projects/{pid}/docs/search"), &[("q", "x")]).await,
        c.get_query(&format!("/projects/{pid}/docs/similar"), &[("slug", "x")]).await,
        c.get_query(&format!("/docs/pages/{pg}/rename-preview"), &[("title", "q")]).await,
        c.get(&format!("/docs/pages/{pg}/delete-preview")).await,
        c.post(&format!("/tickets/{}/docs", id(&t)), json!({"page_id": page["id"]})).await,
    ];
    // the import route is part 2: its answer is checked where the server has it
    let import = c
        .upload(
            &format!("/projects/{pid}/docs/import"),
            "files",
            "a.md",
            "text/markdown",
            b"x".to_vec(),
            &[("dry_run", "true")],
        )
        .await;
    if import.status != 404 && import.status != 405 {
        calls.push(import);
    }
    for resp in calls {
        assert_eq!(resp.status, 403, "{}", resp.text());
        assert_eq!(resp.json()["detail"]["code"], "docs_disabled");
    }
    // the ticket modal just shows nothing
    assert_eq!(c.get(&format!("/tickets/{}/docs", id(&t))).await.json(), json!([]));
    c.patch(&format!("/projects/{pid}"), json!({"docs_enabled": true})).await;
    assert_eq!(c.get(&format!("/projects/{pid}/docs/tree")).await.status, 200);
}

#[tokio::test]
async fn test_new_projects_have_docs_enabled() {
    let (_s, c, _pid) = setup!("test_new_projects_have_docs_enabled");
    assert_eq!(c.get("/projects").await.json()[0]["docs_enabled"], true);
}

// --- ticket <-> docs ---------------------------------------------------------

#[tokio::test]
async fn test_ticket_docs_origins_description_comment_manual_and_page() {
    let (_s, c, pid) = setup!("test_ticket_docs_origins_description_comment_manual_and_page");
    let spec = publish(&c, &mk(&c, &pid, "Spec", json!({})).await, "## Design\nx", None).await;
    let other = publish(&c, &mk(&c, &pid, "Other", json!({})).await, "x", None).await;
    let manual = publish(&c, &mk(&c, &pid, "Manual page", json!({})).await, "x", None).await;
    let t = ticket(&c, &pid, json!({"description": "Intro. See [[Spec#Design]] for the plan. Thanks."})).await;
    let key = id(&t);
    c.post(&format!("/tickets/{key}/comments"), json!({"text": "also check [[Other]]", "author": "me"})).await;
    publish(&c, &mk(&c, &pid, "Mentions", json!({})).await, &format!("## Notes\nTracked in {key}."), None).await;
    let r = c.post(&format!("/tickets/{key}/docs"), json!({"page_id": manual["id"]})).await;
    assert!(r.status == 201 && r.json()["origin"] == "manual");
    let again = c.post(&format!("/tickets/{key}/docs"), json!({"page_id": manual["id"]})).await;
    assert_eq!(again.status, 201); // idempotent
    let rows = c.get(&format!("/tickets/{key}/docs")).await.json();
    let got: Vec<(String, String)> = rows
        .as_array()
        .unwrap()
        .iter()
        .map(|d| (d["title"].as_str().unwrap().to_string(), d["origin"].as_str().unwrap().to_string()))
        .collect();
    let want: Vec<(String, String)> =
        [("Spec", "description"), ("Other", "comment"), ("Manual page", "manual"), ("Mentions", "page")]
            .iter()
            .map(|(a, b)| (a.to_string(), b.to_string()))
            .collect();
    assert_eq!(got, want);
    let spec_row = &rows[0];
    assert!(spec_row["section"] == "Design" && spec_row["snippet"] == "See Spec for the plan.");
    assert!(spec_row["page_id"] == spec["id"] && spec_row["path"] == json!([]) && spec_row["version"] == 1);
    assert!(rows[3]["section"] == "Notes" && rows[3]["snippet"].as_str().unwrap().contains("Tracked in"));
    let keys: BTreeSet<&str> = rows[0].as_object().unwrap().keys().map(String::as_str).collect();
    assert_eq!(
        keys,
        BTreeSet::from(["page_id", "project_id", "title", "path", "section", "snippet", "origin", "detail", "version"])
    );

    // manual links can be removed; derived ones cannot
    let gone = c.delete(&format!("/tickets/{key}/docs/{}", id(&manual))).await;
    assert_eq!(gone.json(), json!({"removed": 1}));
    c.delete(&format!("/tickets/{key}/docs/{}", id(&other))).await;
    let rows = c.get(&format!("/tickets/{key}/docs")).await.json();
    let origins: Vec<&str> = rows.as_array().unwrap().iter().map(|d| d["origin"].as_str().unwrap()).collect();
    assert!(!origins.contains(&"manual") && origins.contains(&"comment"));
}

#[tokio::test]
async fn test_description_edit_refreshes_the_ticket_doc_links_and_backlinks() {
    let (_s, c, pid) = setup!("test_description_edit_refreshes_the_ticket_doc_links_and_backlinks");
    let spec = publish(&c, &mk(&c, &pid, "Spec", json!({})).await, "x", None).await;
    let t = ticket(&c, &pid, json!({"description": "nothing"})).await;
    assert_eq!(c.get(&format!("/tickets/{}/docs", id(&t))).await.json(), json!([]));
    c.patch(&format!("/tickets/{}", id(&t)), json!({"description": "now [[Spec]]"})).await;
    let rows = c.get(&format!("/tickets/{}/docs", id(&t))).await.json();
    assert_eq!(ids_of(&rows, "origin"), [json!("description")]);
    let bl = c.get(&format!("/docs/pages/{}/backlinks", id(&spec))).await.json();
    let pairs: Vec<(Value, Value)> =
        bl["tickets"].as_array().unwrap().iter().map(|x| (x["ticket_id"].clone(), x["origin"].clone())).collect();
    assert_eq!(pairs, [(t["id"].clone(), json!("description"))]);
    assert_eq!(bl["tickets"][0]["context"], "now Spec");
    c.patch(&format!("/tickets/{}", id(&t)), json!({"description": "gone"})).await;
    assert_eq!(c.get(&format!("/tickets/{}/docs", id(&t))).await.json(), json!([]));
    assert_eq!(c.get(&format!("/docs/pages/{}/backlinks", id(&spec))).await.json()["tickets"], json!([]));
}

#[tokio::test]
async fn test_manual_link_errors() {
    let (_s, c, pid) = setup!("test_manual_link_errors");
    let page = mk(&c, &pid, "P", json!({})).await;
    let t = ticket(&c, &pid, json!({})).await;
    assert_eq!(c.post("/tickets/NOPE-1/docs", json!({"page_id": page["id"]})).await.status, 404);
    assert_eq!(c.post(&format!("/tickets/{}/docs", id(&t)), json!({"page_id": "nope"})).await.status, 404);
    let other = project(&c, "Other", "OTH").await;
    let foreign = mk(&c, &id(&other), "Foreign", json!({})).await;
    let r = c.post(&format!("/tickets/{}/docs", id(&t)), json!({"page_id": foreign["id"]})).await;
    assert!(r.status == 422 && r.json()["detail"]["code"] == "bad_project");
    c.delete(&format!("/docs/pages/{}", id(&page))).await;
    assert_eq!(c.post(&format!("/tickets/{}/docs", id(&t)), json!({"page_id": page["id"]})).await.status, 410);
    assert_eq!(c.delete("/tickets/NOPE-1/docs/x").await.status, 404);
}

#[tokio::test]
async fn test_backlinks_rows_carry_origin_and_sentence_context() {
    let (_s, c, pid) = setup!("test_backlinks_rows_carry_origin_and_sentence_context");
    let target = publish(&c, &mk(&c, &pid, "Target", json!({})).await, "## A\nx", None).await;
    publish(
        &c,
        &mk(&c, &pid, "Source", json!({})).await,
        "## Plan\nFirst sentence here. We rely on [[Target#A]] for limits. Last one.",
        None,
    )
    .await;
    let manual = ticket(&c, &pid, json!({})).await;
    c.post(&format!("/tickets/{}/docs", id(&manual)), json!({"page_id": target["id"]})).await;
    let bl = c.get(&format!("/docs/pages/{}/backlinks", id(&target))).await.json();
    let row = &bl["pages"][0];
    assert!(row["origin"] == "page" && row["context"] == "We rely on Target for limits.");
    assert!(row["title"] == "Source" && row["in"] == "Plan" && row.get("snippet").is_some());
    let pairs: Vec<(Value, Value)> =
        bl["tickets"].as_array().unwrap().iter().map(|x| (x["ticket_id"].clone(), x["origin"].clone())).collect();
    assert_eq!(pairs, [(manual["id"].clone(), json!("manual"))]);
}

// --- recycle bin -------------------------------------------------------------

#[tokio::test]
async fn test_recycle_bin_parent_flags_and_empty_bin() {
    let (_s, c, pid) = setup!("test_recycle_bin_parent_flags_and_empty_bin");
    let parent = mk(&c, &pid, "Parent", json!({})).await;
    let child = mk(&c, &pid, "Child", json!({"parent_id": parent["id"]})).await;
    let solo = mk(&c, &pid, "Solo", json!({})).await;
    c.delete(&format!("/docs/pages/{}", id(&child))).await;
    let bin = c.get(&format!("/projects/{pid}/docs/recycle-bin")).await.json();
    assert_eq!((bin[0]["parent_title"].clone(), bin[0]["parent_deleted"].clone()), (json!("Parent"), json!(false)));
    c.delete(&format!("/docs/pages/{}", id(&parent))).await;
    c.delete(&format!("/docs/pages/{}", id(&solo))).await;
    let bin = c.get(&format!("/projects/{pid}/docs/recycle-bin")).await.json();
    let by: std::collections::BTreeMap<String, Value> =
        bin.as_array().unwrap().iter().map(|e| (e["title"].as_str().unwrap().to_string(), e.clone())).collect();
    assert!(by["Child"]["parent_deleted"] == true && by["Child"]["parent_title"] == "Parent");
    assert!(by["Solo"]["parent_title"].is_null() && by["Solo"]["parent_deleted"] == false);
    assert_eq!(by["Parent"]["page_count"], 1);
    let live = mk(&c, &pid, "Live", json!({})).await;
    let r = c.delete(&format!("/projects/{pid}/docs/recycle-bin")).await;
    assert!(r.status == 200 && r.json() == json!({"purged": 3}));
    assert_eq!(c.get(&format!("/projects/{pid}/docs/recycle-bin")).await.json(), json!([]));
    assert_eq!(c.get(&format!("/docs/pages/{}", id(&parent))).await.status, 404);
    assert_eq!(c.get(&format!("/docs/pages/{}", id(&live))).await.status, 200); // live pages are untouched
    assert_eq!(c.delete(&format!("/projects/{pid}/docs/recycle-bin")).await.json(), json!({"purged": 0}));
}

#[tokio::test]
async fn test_restoring_a_child_of_a_deleted_parent_returns_at_top_level() {
    let (_s, c, pid) = setup!("test_restoring_a_child_of_a_deleted_parent_returns_at_top_level");
    let parent = mk(&c, &pid, "Parent", json!({})).await;
    let child = mk(&c, &pid, "Child", json!({"parent_id": parent["id"]})).await;
    c.delete(&format!("/docs/pages/{}", id(&child))).await;
    c.delete(&format!("/docs/pages/{}", id(&parent))).await;
    let r = c.post_empty(&format!("/docs/pages/{}/restore", id(&child))).await;
    assert_eq!(r.json()["moved_to_top_level"], true);
}

// --- notifications and request ids ------------------------------------------

/// What the stream carried, without the notification centre's "the log moved" messages.
async fn drain(events: &mut testkit::Events) -> Vec<String> {
    let mut out = Vec::new();
    while let Some(e) = events.next(Duration::from_millis(700)).await {
        if !e.contains("\"notifications\"") {
            out.push(e);
        }
    }
    out
}

#[tokio::test]
async fn test_notification_event_only_when_notify_is_true() {
    let (s, c, pid) = setup!("test_notification_event_only_when_notify_is_true");
    let mut sse = s.events().await;
    let page = mk(&c, &pid, "Notify me", json!({})).await;
    let pg = id(&page);
    c.put(&format!("/docs/pages/{pg}/draft"), json!({"markdown": "a"})).await;
    drain(&mut sse).await;
    c.post(&format!("/docs/pages/{pg}/publish"), json!({"base_version": 0, "note": "silent"})).await;
    // no JSON event without notify
    assert_eq!(drain(&mut sse).await, ["invalidate"]);

    c.put(&format!("/docs/pages/{pg}/draft"), json!({"markdown": "b"})).await;
    c.post(&format!("/docs/pages/{pg}/publish"), json!({"base_version": 1, "note": "loud", "notify": true})).await;
    let events = drain(&mut sse).await;
    assert_eq!(events[0], "invalidate");
    let payload: Value = serde_json::from_str(&events[1]).unwrap();
    assert_eq!(
        payload,
        json!({"type": "docs_published", "project_id": pid, "page_id": page["id"], "title": "Notify me", "version": 2, "author": "user", "note": "loud"})
    );
    // the notification log written in the background announces itself with one more "invalidate" over a real stream
    // (the Python test read the queue in the same process, before it)
    assert!(events[2..].iter().all(|e| e == "invalidate"), "{events:?}");

    // restoring a version only notifies when asked
    c.post(&format!("/docs/pages/{pg}/versions/1/restore"), json!({})).await;
    assert!(drain(&mut sse).await.iter().all(|e| !e.starts_with('{')));
    c.post(&format!("/docs/pages/{pg}/versions/1/restore"), json!({"notify": true})).await;
    let ev: Vec<Value> =
        drain(&mut sse).await.iter().filter(|e| e.starts_with('{')).map(|e| serde_json::from_str(e).unwrap()).collect();
    assert!(ev.len() == 1 && ev[0]["version"] == 4 && ev[0]["note"] == "Restored from v1");
}

#[tokio::test]
async fn test_errors_carry_a_request_id_header_and_detail() {
    let (_s, c, pid) = setup!("test_errors_carry_a_request_id_header_and_detail");
    let r = c.get("/docs/pages/nope").await;
    assert_eq!(r.status, 404);
    let rid = r.headers.get("x-request-id").expect("x-request-id").to_str().unwrap().to_string();
    assert!(!rid.is_empty());
    assert_eq!(r.json()["detail"], json!({"code": "page_not_found", "message": "Page not found", "request_id": rid}));
    let echoed = c.request("GET", "/docs/pages/nope", &[("x-request-id", "abc-123")], None).await;
    assert!(
        echoed.headers.get("x-request-id").unwrap() == "abc-123" && echoed.json()["detail"]["request_id"] == "abc-123"
    );
    let page = mk(&c, &pid, "P", json!({})).await;
    let conflict = c.post(&format!("/docs/pages/{}/publish", id(&page)), json!({"base_version": 5})).await;
    assert_eq!(conflict.status, 409);
    let d = conflict.json()["detail"].clone();
    assert!(
        d["code"] == "conflict"
            && d["request_id"].as_str().unwrap() == conflict.headers.get("x-request-id").unwrap().to_str().unwrap()
    );
    assert_eq!(d["latest_version"], 0); // extras survive
    let ok = c.get(&format!("/projects/{pid}/docs/tree")).await;
    assert!(ok.headers.get("x-request-id").is_none());
}

// --- renamed pages keep ticket references -------------------------------------

#[tokio::test]
async fn test_renamed_page_keeps_ticket_references_working() {
    // Tickets link by page id: [[Old title]] in a ticket still resolves, showing the new title.
    let (_s, c, pid) = setup!("test_renamed_page_keeps_ticket_references_working");
    let target = publish(&c, &mk(&c, &pid, "Data model", json!({})).await, "## Fields\nx", None).await;
    let t = ticket(&c, &pid, json!({"description": "Schema in [[Data model]]"})).await;
    let before = c.get(&format!("/tickets/{}/docs", id(&t))).await.json();
    assert_eq!(ids_of(&before, "page_id"), [target["id"].clone()]);

    let r = c.patch(&format!("/docs/pages/{}", id(&target)), json!({"title": "Schema", "rewrite_links": true})).await;
    assert_eq!(r.status, 200);

    let after = c.get(&format!("/tickets/{}/docs", id(&t))).await.json();
    let pairs: Vec<(Value, Value)> =
        after.as_array().unwrap().iter().map(|x| (x["page_id"].clone(), x["title"].clone())).collect();
    assert_eq!(pairs, [(target["id"].clone(), json!("Schema"))]);
    let bl = c.get(&format!("/docs/pages/{}/backlinks", id(&target))).await.json();
    assert_eq!(ids_of(&bl["tickets"], "ticket_id"), [t["id"].clone()]);
    // shown with the new title
    assert!(bl["tickets"][0]["excerpt"].as_str().unwrap().contains("[[Schema]]"));
    let reference = json!({"refs": [{"kind": "page", "title": "Data model"}], "from_ticket": true});
    let res = resolve(&c, &pid, reference.clone()).await;
    assert!(res[0]["status"] == "ok" && res[0]["title"] == "Schema");
    // pages do not link by id: a [[Data model]] in a page stays broken until it is rewritten
    let res = resolve(&c, &pid, json!({"refs": [{"kind": "page", "title": "Data model"}]})).await;
    assert_eq!(res[0]["status"], "missing");

    // a new page that takes the old title wins over the alias
    let other = publish(&c, &mk(&c, &pid, "Data model", json!({})).await, "y", None).await;
    let res = resolve(&c, &pid, reference).await;
    assert_eq!(res[0]["page_id"], other["id"]);
}

#[tokio::test]
async fn test_backlink_excerpt_keeps_the_reference_and_cuts_long_lines() {
    let (_s, c, pid) = setup!("test_backlink_excerpt_keeps_the_reference_and_cuts_long_lines");
    let target = publish(&c, &mk(&c, &pid, "Data model", json!({})).await, "x", None).await;
    let filler = "word ".repeat(40);
    publish(
        &c,
        &mk(&c, &pid, "Src", json!({})).await,
        &format!("## Tokens\n{filler}the **token** rules live in [[Data model]] and the column schema {filler}"),
        None,
    )
    .await;
    let bl = c.get(&format!("/docs/pages/{}/backlinks", id(&target))).await.json();
    let row = &bl["pages"][0];
    assert_eq!(row["in"], "Tokens"); // heading text, not the slug
    let ex = row["excerpt"].as_str().unwrap();
    assert!(ex.contains("[[Data model]]") && !ex.contains("**"));
    assert!(ex.starts_with("… ") && ex.ends_with(" …") && ex.chars().count() < 160);
    assert!(!row["context"].as_str().unwrap().contains("[[")); // the plain sentence stays plain
}

#[tokio::test]
async fn test_backlinks_carry_the_target_anchor_for_heading_rename_notes() {
    let (_s, c, pid) = setup!("test_backlinks_carry_the_target_anchor_for_heading_rename_notes");
    let target = publish(&c, &mk(&c, &pid, "Spec", json!({})).await, "## Auth\nx", None).await;
    publish(&c, &mk(&c, &pid, "Src", json!({})).await, "See [[Spec#Auth]].", None).await;
    ticket(&c, &pid, json!({"description": "read [[Spec#Auth]]"})).await;
    let bl = c.get(&format!("/docs/pages/{}/backlinks", id(&target))).await.json();
    assert_eq!(ids_of(&bl["pages"], "target_anchor"), [json!("Auth")]);
    assert_eq!(ids_of(&bl["tickets"], "target_anchor"), [json!("Auth")]);
}

// --- last viewed version (per user) and draft autosave count ------------------

async fn members(c: &Client, pid: &str, names: &[&str]) {
    for name in names {
        c.post(&format!("/projects/{pid}/members"), json!({"name": name})).await;
    }
}

#[tokio::test]
async fn test_seen_version_is_per_actor() {
    let (_s, c, pid) = setup!("test_seen_version_is_per_actor");
    members(&c, &pid, &["Ana", "Bo"]).await;
    let page = publish(&c, &mk(&c, &pid, "Seen", json!({})).await, "v1 text", None).await;
    publish(&c, &page, "v2 text", None).await;
    let url = format!("/docs/pages/{}/seen", id(&page));
    let (ana, bo) = (c.clone().header("x-actor", "Ana"), c.clone().header("x-actor", "Bo"));
    assert_eq!(ana.get(&url).await.json(), json!({"version": null}));
    assert_eq!(ana.put(&url, json!({"version": 1})).await.json(), json!({"version": 1}));
    assert_eq!(ana.get(&url).await.json(), json!({"version": 1}));
    assert_eq!(bo.get(&url).await.json(), json!({"version": null}));
    // clamped to the current version, and updated in place
    assert_eq!(ana.put(&url, json!({"version": 99})).await.json(), json!({"version": 2}));
    assert_eq!(ana.get(&url).await.json(), json!({"version": 2}));
    assert_eq!(c.get("/docs/pages/nope/seen").await.status, 404);
}

#[tokio::test]
async fn test_draft_counts_autosaves() {
    let (_s, c, pid) = setup!("test_draft_counts_autosaves");
    let page = mk(&c, &pid, "Autosaves", json!({})).await; // creating the page starts the draft
    let url = format!("/docs/pages/{}/draft", id(&page));
    let first = c.put(&url, json!({"markdown": "a"})).await.json();
    assert_eq!(first["draft"]["saves"], 2);
    let again = c.put(&url, json!({"markdown": "ab"})).await.json();
    assert_eq!(again["draft"]["saves"], 3);
}

#[tokio::test]
async fn test_followers_are_counted_without_the_caller() {
    let (_s, c, pid) = setup!("test_followers_are_counted_without_the_caller");
    members(&c, &pid, &["Ana", "Bo", "Cy"]).await;
    let url = format!("/projects/{pid}/docs");
    let (ana, bo, cy) =
        (c.clone().header("x-actor", "Ana"), c.clone().header("x-actor", "Bo"), c.clone().header("x-actor", "Cy"));
    assert_eq!(ana.get(&format!("{url}/followers")).await.json(), json!({"following": false, "count": 0, "names": []}));
    ana.put(&format!("{url}/follow"), json!({"on": true})).await;
    ana.put(&format!("{url}/follow"), json!({"on": true})).await; // idempotent
    bo.put(&format!("{url}/follow"), json!({"on": true})).await;
    let mine = ana.get(&format!("{url}/followers")).await.json();
    assert_eq!(mine, json!({"following": true, "count": 1, "names": ["Bo"]}));
    let theirs = cy.get(&format!("{url}/followers")).await.json();
    assert!(theirs["following"] == false && theirs["count"] == 2);
    let off = bo.put(&format!("{url}/follow"), json!({"on": false})).await.json();
    assert_eq!(off, json!({"following": false, "count": 1, "names": ["Ana"]}));
}
