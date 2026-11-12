//! `tests/test_activity.py`, the tests of a ticket's own activity: the created entry, the actor of a change, and
//! the parent, Won't Do reason and workspace retention entries. Left for their routes:
//! `test_comment_lifecycle_uses_author_as_actor`, `test_long_text_is_clipped`,
//! `test_acceptance_criteria_work_log_and_test_cases`, `test_blocks_and_links_are_logged_on_both_tickets`,
//! `test_branch_lifecycle_is_logged`, `test_project_timeline_does_not_duplicate_created_or_comment` (the activity
//! feed) and `test_mcp_changes_are_attributed_to_the_agent` (the MCP tools).

mod common;

use common::id;
use serde_json::{Value, json};
use testkit::{Client, Server, skip_unless_available};

async fn _ticket(c: &Client, title: &str, prefix: &str) -> (Value, Value) {
    let p = c.post("/projects", json!({"name": prefix, "prefix": prefix, "color": "#123456"})).await.json();
    let r = c.post(&format!("/projects/{}/tickets", id(&p)), json!({"title": title})).await;
    assert_eq!(r.status, 201, "{}", r.text());
    (p, r.json())
}

async fn _log(c: &Client, tid: &str) -> Vec<Value> {
    c.get(&format!("/tickets/{tid}")).await.json()["activity_log"].as_array().expect("activity_log").clone()
}

#[tokio::test]
async fn test_created_entry_and_default_actor() {
    if !skip_unless_available("test_created_entry_and_default_actor") {
        return;
    }
    let s = Server::start().await;
    let c = s.client();
    let (_, t) = _ticket(&c, "Hello", "ACT").await;
    let log = _log(&c, &id(&t)).await;
    assert_eq!(log.len(), 1);
    assert!(log[0]["field"] == "created" && log[0]["ref"] == "Hello");
    assert!(log[0]["actor"] == "user" && !log[0]["at"].as_str().expect("at").is_empty());
}

#[tokio::test]
async fn test_x_actor_header_attributes_the_change() {
    if !skip_unless_available("test_x_actor_header_attributes_the_change") {
        return;
    }
    let s = Server::start().await;
    let c = s.client();
    let (_, t) = _ticket(&c, "t", "ACT").await;
    let path = format!("/tickets/{}", id(&t));
    c.clone().header("X-Actor", "An Nguyen").patch(&path, json!({"priority": "high"})).await;
    c.patch(&path, json!({"title": "New"})).await;
    let log = _log(&c, &id(&t)).await;
    let last: Vec<(Value, Value)> =
        log[log.len() - 2..].iter().map(|e| (e["field"].clone(), e["actor"].clone())).collect();
    assert_eq!(last, vec![(json!("priority"), json!("An Nguyen")), (json!("title"), json!("user"))]);
}

#[tokio::test]
async fn test_parent_wont_do_reason_repo_and_retention() {
    if !skip_unless_available("test_parent_wont_do_reason_repo_and_retention") {
        return;
    }
    let s = Server::start().await;
    let c = s.client();
    let tmp_path = tempfile::tempdir().expect("temporary folder");
    let (p, parent) = _ticket(&c, "Parent", "PAR").await;
    let child = c.post(&format!("/projects/{}/tickets", id(&p)), json!({"title": "Child"})).await.json();
    let cid = id(&child);
    c.patch(&format!("/tickets/{cid}"), json!({"parent_id": parent["id"]})).await;
    let solo = id(&c.post(&format!("/projects/{}/tickets", id(&p)), json!({"title": "Solo"})).await.json());
    let r = c.patch(&format!("/tickets/{solo}"), json!({"status": "wont_do", "wont_do_reason": "not needed"})).await;
    assert_eq!(r.status, 200, "{}", r.text());
    c.patch(&format!("/tickets/{solo}"), json!({"status": "todo"})).await; // reason is cleared silently
    let solo_log = _log(&c, &solo).await;
    let reasons: Vec<(Value, Value)> = solo_log
        .iter()
        .filter(|e| e["field"] == "wont_do_reason")
        .map(|e| (e["from"].clone(), e["to"].clone()))
        .collect();
    assert_eq!(reasons, vec![(Value::Null, json!("not needed"))]);
    c.patch("/workspace/settings", json!({"root_path": tmp_path.path().to_string_lossy()})).await;
    c.patch(&format!("/tickets/{cid}/workspace/retention"), json!({"retention_days": 7})).await;
    c.patch(&format!("/tickets/{cid}/workspace/retention"), json!({"retention_days": 0})).await;
    c.patch(&format!("/tickets/{cid}/workspace/retention"), json!({"retention_days": null})).await;
    let log = _log(&c, &cid).await;
    let by = |f: &str| -> Vec<(Value, Value)> {
        log.iter().filter(|e| e["field"] == f).map(|e| (e["from"].clone(), e["to"].clone())).collect()
    };
    assert_eq!(by("parent_id"), vec![(Value::Null, parent["id"].clone())]);
    assert_eq!(
        by("workspace_retention"),
        vec![
            (json!("default"), json!("7 days")),
            (json!("7 days"), json!("forever")),
            (json!("forever"), json!("default")),
        ]
    );
}
