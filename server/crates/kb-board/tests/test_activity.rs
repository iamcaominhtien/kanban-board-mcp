//! `tests/test_activity.py`: what a ticket's activity log records (the created entry, the actor of a change,
//! comments, criteria, the work log, test cases, blocks, links, the parent, the Won't Do reason, workspace retention
//! and branches) and the project's timeline. `test_mcp_changes_are_attributed_to_the_agent` waits for the MCP tools.

mod common;

use common::{git, id, patch_empty, repo_dir};
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
async fn test_comment_lifecycle_uses_author_as_actor() {
    if !skip_unless_available("test_comment_lifecycle_uses_author_as_actor") {
        return;
    }
    let s = Server::start().await;
    let c = s.client();
    let (_, t) = _ticket(&c, "t", "ACT").await;
    let tid = id(&t);
    let r = c.post(&format!("/tickets/{tid}/comments"), json!({"text": "first", "author": "Bao"})).await;
    let cid = id(&r.json()["comments"][0]);
    c.patch(&format!("/tickets/{tid}/comments/{cid}"), json!({"text": "edited"})).await;
    c.patch(&format!("/tickets/{tid}/comments/{cid}"), json!({"text": "edited"})).await; // no-op
    c.delete(&format!("/tickets/{tid}/comments/{cid}")).await;
    let log: Vec<Value> = _log(&c, &tid).await.into_iter().filter(|e| e["field"] == "comment").collect();
    // edits and deletions are not logged: only "X commented", linking back to the comment
    let moves: Vec<(Value, Value)> = log.iter().map(|e| (e["from"].clone(), e["to"].clone())).collect();
    assert_eq!(moves, vec![(Value::Null, json!("first"))]);
    assert!(log[0]["actor"] == "Bao" && log[0]["ref"] == json!(cid));
}

#[tokio::test]
async fn test_long_text_is_clipped() {
    if !skip_unless_available("test_long_text_is_clipped") {
        return;
    }
    let s = Server::start().await;
    let c = s.client();
    let (_, t) = _ticket(&c, "t", "ACT").await;
    c.post(&format!("/tickets/{}/comments", id(&t)), json!({"text": "x".repeat(5000)})).await;
    let log = _log(&c, &id(&t)).await;
    let e = log.iter().find(|e| e["field"] == "comment").expect("a comment entry");
    let to = e["to"].as_str().expect("to");
    assert!(to.chars().count() == 200 && to.ends_with('…'));
}

#[tokio::test]
async fn test_acceptance_criteria_work_log_and_test_cases() {
    if !skip_unless_available("test_acceptance_criteria_work_log_and_test_cases") {
        return;
    }
    let s = Server::start().await;
    let c = s.client();
    let (_, t) = _ticket(&c, "t", "ACT").await;
    let tid = id(&t);
    let ac = id(
        &c.post(&format!("/tickets/{tid}/acceptance-criteria"), json!({"text": "works"})).await.json()["acceptance_criteria"]
            [0],
    );
    patch_empty(&c, &format!("/tickets/{tid}/acceptance-criteria/{ac}/toggle")).await;
    patch_empty(&c, &format!("/tickets/{tid}/acceptance-criteria/{ac}/toggle")).await;
    c.delete(&format!("/tickets/{tid}/acceptance-criteria/{ac}")).await;

    let lg = id(&c
        .post(&format!("/tickets/{tid}/work-log"), json!({"author": "Chi", "role": "Developer", "note": "did"}))
        .await
        .json()["work_log"][0]);
    c.patch(&format!("/tickets/{tid}/work-log/{lg}"), json!({"note": "did more"})).await;
    c.patch(&format!("/tickets/{tid}/work-log/{lg}"), json!({"pinned": true})).await; // not a note change
    c.delete(&format!("/tickets/{tid}/work-log/{lg}")).await;

    let tc =
        id(&c.post(&format!("/tickets/{tid}/test-cases"), json!({"title": "login"})).await.json()["test_cases"][0]);
    c.patch(&format!("/tickets/{tid}/test-cases/{tc}"), json!({"status": "pass"})).await;
    c.patch(&format!("/tickets/{tid}/test-cases/{tc}"), json!({"status": "pass"})).await; // no-op
    c.patch(&format!("/tickets/{tid}/test-cases/{tc}"), json!({"title": "login v2"})).await;
    c.delete(&format!("/tickets/{tid}/test-cases/{tc}")).await;

    let log = _log(&c, &tid).await;
    let by = |f: &str| -> Vec<(Value, Value)> {
        log.iter().filter(|e| e["field"] == f).map(|e| (e["from"].clone(), e["to"].clone())).collect()
    };
    let n = Value::Null;
    assert_eq!(
        by("acceptance_criterion"),
        vec![
            (n.clone(), json!("works")),
            (json!("open"), json!("done")),
            (json!("done"), json!("open")),
            (json!("works"), n.clone()),
        ]
    );
    assert_eq!(
        by("work_log"),
        vec![(n.clone(), json!("did")), (json!("did"), json!("did more")), (json!("did more"), n.clone())]
    );
    assert_eq!(log.iter().find(|e| e["field"] == "work_log").expect("a work_log entry")["actor"], "Chi");
    assert_eq!(by("test_case_status"), vec![(json!("pending"), json!("pass"))]);
    let refs: Vec<&Value> = log.iter().filter(|e| e["field"] == "test_case_status").map(|e| &e["ref"]).collect();
    assert_eq!(refs, vec![&json!("TC-1 login")]);
    assert_eq!(
        by("test_case"),
        vec![(n.clone(), json!("login")), (json!("login"), json!("login v2")), (json!("login v2"), n.clone())]
    );
}

#[tokio::test]
async fn test_blocks_and_links_are_logged_on_both_tickets() {
    if !skip_unless_available("test_blocks_and_links_are_logged_on_both_tickets") {
        return;
    }
    let s = Server::start().await;
    let c = s.client();
    let (p, a) = _ticket(&c, "A", "LNK").await;
    let b = c.post(&format!("/projects/{}/tickets", id(&p)), json!({"title": "B"})).await.json();
    let (a, b) = (id(&a), id(&b));
    c.post_empty(&format!("/tickets/{a}/blocks/{b}")).await;
    c.post_empty(&format!("/tickets/{a}/blocks/{b}")).await; // already linked: no second entry
    let link = c.post(&format!("/tickets/{a}/links"), json!({"target_id": b, "relation_type": "causes"})).await.json();
    let (la, lb) = (_log(&c, &a).await, _log(&c, &b).await);
    let shown = |log: &[Value], fields: [&str; 2]| -> Vec<(Value, Value)> {
        log.iter()
            .filter(|e| fields.iter().any(|f| e["field"] == *f))
            .map(|e| (e["field"].clone(), e["to"].clone()))
            .collect()
    };
    assert_eq!(
        shown(&la, ["blocks", "link"]),
        vec![(json!("blocks"), json!(b)), (json!("link"), json!(format!("causes {b}")))]
    );
    assert_eq!(
        shown(&lb, ["blocked_by", "link"]),
        vec![(json!("blocked_by"), json!(a)), (json!("link"), json!(format!("caused by {a}")))]
    );
    c.delete(&format!("/tickets/{a}/links/{}", id(&link))).await;
    c.delete(&format!("/tickets/{a}/blocks/{b}")).await;
    let (la, lb) = (_log(&c, &a).await, _log(&c, &b).await);
    let triples = |log: &[Value]| -> Vec<(Value, Value, Value)> {
        log.iter().map(|e| (e["field"].clone(), e["from"].clone(), e["to"].clone())).collect()
    };
    assert!(triples(&la).contains(&(json!("link"), json!(format!("causes {b}")), Value::Null)));
    assert!(triples(&lb).contains(&(json!("link"), json!(format!("caused by {a}")), Value::Null)));
    assert!(triples(&lb).contains(&(json!("blocked_by"), json!(a), Value::Null)));
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

#[tokio::test]
async fn test_branch_lifecycle_is_logged() {
    if !skip_unless_available("test_branch_lifecycle_is_logged") {
        return;
    }
    let s = Server::start().await;
    let c = s.client();
    let repo_dir = repo_dir("main", "T");
    let (p, t) = _ticket(&c, "t", "BRN").await;
    c.patch(&format!("/projects/{}", id(&p)), json!({"repo_path": repo_dir.path().to_string_lossy()})).await;
    let tid = id(&t);
    let br = c.post(&format!("/tickets/{tid}/branches"), json!({"name": "feat/a", "branch_from": "main"})).await.json()
        ["branches"]
        .as_array()
        .expect("branches")
        .last()
        .expect("a branch")
        .clone();
    let bid = id(&br);
    c.post_empty(&format!("/tickets/{tid}/branches/{bid}/checkout")).await;
    let r = c.patch(&format!("/tickets/{tid}/branches/{bid}"), json!({"name": "feat/b"})).await;
    assert_eq!(r.status, 200, "{}", r.text());
    let r = c.patch(&format!("/tickets/{tid}/branches/{bid}"), json!({"status": "archived"})).await;
    assert_eq!(r.status, 200, "{}", r.text());
    c.post_empty(&format!("/tickets/{tid}/branches/{bid}/checkout")).await; // re-checkout is logged again
    c.patch(&format!("/tickets/{tid}/branches/{bid}"), json!({"status": "archived"})).await; // unchanged
    c.delete(&format!("/tickets/{tid}/branches/{bid}")).await;
    let log = _log(&c, &tid).await;
    let got: Vec<(Value, Value, Value)> = log
        .iter()
        .filter(|e| e["field"].as_str().expect("field").starts_with("branch"))
        .map(|e| (e["field"].clone(), e["from"].clone(), e["to"].clone()))
        .collect();
    let n = Value::Null;
    assert!(got.contains(&(json!("branch"), n.clone(), json!("feat/a"))));
    assert!(got.contains(&(json!("branch_checkout"), n.clone(), json!("feat/a"))));
    assert!(got.contains(&(json!("branch"), json!("feat/a"), json!("feat/b"))));
    let statuses: Vec<&(Value, Value, Value)> = got.iter().filter(|g| g.0 == "branch_status").collect();
    assert_eq!(statuses, vec![&(json!("branch_status"), json!("open"), json!("archived"))]);
    assert!(got.contains(&(json!("branch"), json!("feat/b"), n.clone())));
    // the repository followed the board
    assert_eq!(git(repo_dir.path(), &["branch", "--show-current"]).trim(), "feat/b");
}

#[tokio::test]
async fn test_project_timeline_does_not_duplicate_created_or_comment() {
    if !skip_unless_available("test_project_timeline_does_not_duplicate_created_or_comment") {
        return;
    }
    let s = Server::start().await;
    let c = s.client();
    let (p, t) = _ticket(&c, "t", "TML").await;
    c.post(&format!("/tickets/{}/comments", id(&t)), json!({"text": "hi"})).await;
    c.patch(&format!("/tickets/{}", id(&t)), json!({"priority": "high"})).await;
    let events = c.get(&format!("/projects/{}/activities", id(&p))).await.json();
    let kinds: Vec<&str> =
        events.as_array().expect("events").iter().map(|e| e["event_type"].as_str().expect("event_type")).collect();
    let count = |kind: &str| kinds.iter().filter(|k| **k == kind).count();
    assert!(count("created") == 1 && count("commented") == 1);
    assert!(!kinds.contains(&"changed:created") && !kinds.contains(&"changed:comment"));
    assert!(kinds.contains(&"changed:priority"));
}
