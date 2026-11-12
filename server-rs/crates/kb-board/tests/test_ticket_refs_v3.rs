//! `tests/test_ticket_refs_v3.py`: ticket text refs (AC / test case / debug note origins), comment edit-delete-undo,
//! mentions and the doc_ref activity entries.
//!
//! The Python file uses the fixtures of `tests/test_docs.py` (a project, pages made and published through the Docs
//! routes). What a test asks of the Docs routes runs where the server has them (`common::docs_served`: the Python
//! server, and the Rust one once `kb-docs` is ported); the ticket routes are checked on both.

mod common;

use std::time::Duration;

use common::{docs_served, id};
use serde_json::{Value, json};
use testkit::{Client, Server, skip_unless_available};

/// The `pid` fixture of `tests/test_docs.py`.
async fn pid(c: &Client) -> String {
    id(&c.post("/projects", json!({"name": "Kanban", "prefix": "KAN", "color": "#0a0"})).await.json())
}

/// `mk` of `tests/test_docs.py`.
async fn mk(c: &Client, pid: &str, title: &str) -> Value {
    let r = c.post(&format!("/projects/{pid}/docs/pages"), json!({"title": title})).await;
    assert_eq!(r.status, 201, "{}", r.text());
    r.json()
}

/// `publish` of `tests/test_docs.py`.
async fn publish(c: &Client, page: &Value, markdown: &str) -> Value {
    c.put(&format!("/docs/pages/{}/draft", id(page)), json!({"markdown": markdown})).await;
    let cur = c.get(&format!("/docs/pages/{}", id(page))).await.json();
    let r = c
        .post(&format!("/docs/pages/{}/publish", id(page)), json!({"base_version": cur["version"], "note": null}))
        .await;
    assert_eq!(r.status, 200, "{}", r.text());
    r.json()
}

async fn _ticket(c: &Client, pid: &str, extra: Value) -> Value {
    let mut body = json!({"title": "T", "type": "task"});
    for (key, value) in extra.as_object().expect("extra fields") {
        body[key] = value.clone();
    }
    let r = c.post(&format!("/projects/{pid}/tickets"), body).await;
    assert_eq!(r.status, 201, "{}", r.text());
    r.json()
}

/// `{(d["origin"], d["detail"]) for d in rows}`.
fn origins(rows: &Value) -> Vec<(Value, Value)> {
    rows.as_array().expect("rows").iter().map(|d| (d["origin"].clone(), d["detail"].clone())).collect()
}

/// `{n["name"] for n in notified}`, sorted.
fn names(notified: &Value) -> Vec<String> {
    let mut names: Vec<String> =
        notified.as_array().expect("notified").iter().map(|n| n["name"].as_str().expect("name").to_string()).collect();
    names.sort();
    names.dedup();
    names
}

/// The whole test reads the Docs routes (`GET /tickets/{id}/docs`, the backlinks of a page).
#[tokio::test]
async fn test_linked_docs_cover_ac_test_case_and_debug_note() {
    if !skip_unless_available("test_linked_docs_cover_ac_test_case_and_debug_note") {
        return;
    }
    let s = Server::start().await;
    let c = s.client();
    let pid = pid(&c).await;
    if !docs_served(&c, &pid).await {
        eprintln!("test_linked_docs_cover_ac_test_case_and_debug_note waits for the Docs routes (kb-docs)");
        return;
    }
    publish(&c, &mk(&c, &pid, "Spec").await, "## Auth\nrules").await;
    let t = _ticket(&c, &pid, json!({"description": "see [[Spec#Auth]]"})).await;
    let key = id(&t);
    c.post(&format!("/tickets/{key}/acceptance-criteria"), json!({"text": "follows [[Spec]]"})).await;
    let r = c
        .post(&format!("/tickets/{key}/test-cases"), json!({"title": "tc", "expected_result": "matches [[Spec#Auth]]"}))
        .await;
    assert!(r.status == 200 || r.status == 201, "{}", r.text());
    c.post(
        &format!("/tickets/{key}/work-log"),
        json!({"author": "bao", "role": "Developer", "note": "root cause in [[Spec]]", "kind": "root_cause"}),
    )
    .await;
    let rows = c.get(&format!("/tickets/{key}/docs")).await.json();
    let found = origins(&rows);
    assert!(found.contains(&(json!("description"), json!(""))));
    assert!(found.contains(&(json!("acceptance_criterion"), json!(""))));
    assert!(found.contains(&(json!("test_case"), json!("TC-1"))));
    assert!(found.contains(&(json!("debug_note"), json!(""))));
    let page_id = id(&json!({"id": rows[0]["page_id"]}));
    let back = c.get(&format!("/docs/pages/{page_id}/backlinks")).await.json();
    let tickets = origins(&back["tickets"]);
    assert!(tickets.contains(&(json!("test_case"), json!("TC-1"))));
    assert!(tickets.contains(&(json!("debug_note"), json!(""))));
}

#[tokio::test]
async fn test_comment_edit_delete_restore_and_mentions() {
    if !skip_unless_available("test_comment_edit_delete_restore_and_mentions") {
        return;
    }
    let s = Server::start().await;
    let c = s.client();
    let pid = pid(&c).await;
    let t = _ticket(&c, &pid, json!({})).await;
    let key = id(&t);
    let mem =
        c.post(&format!("/projects/{pid}/members"), json!({"name": "Linh Pham", "color": "#2E6F40"})).await.json();
    let text = format!("look @[Linh Pham](member:{})", id(&mem));
    let posted = c.post(&format!("/tickets/{key}/comments"), json!({"text": text, "author": "user"})).await.json();
    let cm = posted["comments"][0].clone();
    assert!(cm["edited_at"].is_null() && cm["mentions"] == json!([mem["id"]]));
    assert_eq!(names(&cm["notified"]), ["Admin", "Linh Pham"]); // reporter + mention

    let edited = c.patch(&format!("/tickets/{key}/comments/{}", id(&cm)), json!({"text": "changed"})).await.json();
    assert!(
        !edited["comments"][0]["edited_at"].as_str().expect("edited_at").is_empty()
            && edited["comments"][0]["mentions"] == json!([])
    );

    let gone = c.delete(&format!("/tickets/{key}/comments/{}", id(&cm))).await.json();
    assert_eq!(gone["comments"], json!([]));
    assert_eq!(c.get(&format!("/tickets/{key}")).await.json()["comments"], json!([]));
    let undone = c.post_empty(&format!("/tickets/{key}/comments/{}/restore", id(&cm))).await.json();
    let restored: Vec<&Value> = undone["comments"].as_array().expect("comments").iter().map(|x| &x["id"]).collect();
    assert_eq!(restored, vec![&cm["id"]]);
    assert_eq!(c.post_empty(&format!("/tickets/{key}/comments/{}/restore", id(&cm))).await.status, 404);
}

/// The whole test reads `GET /tickets/{id}/docs`.
#[tokio::test]
async fn test_deleted_comment_mentions_do_not_link_docs() {
    if !skip_unless_available("test_deleted_comment_mentions_do_not_link_docs") {
        return;
    }
    let s = Server::start().await;
    let c = s.client();
    let pid = pid(&c).await;
    if !docs_served(&c, &pid).await {
        eprintln!("test_deleted_comment_mentions_do_not_link_docs waits for the Docs routes (kb-docs)");
        return;
    }
    let page = publish(&c, &mk(&c, &pid, "Spec").await, "x").await;
    let t = _ticket(&c, &pid, json!({})).await;
    let tid = id(&t);
    let cid =
        id(&c.post(&format!("/tickets/{tid}/comments"), json!({"text": "see [[Spec]]"})).await.json()["comments"][0]);
    let rows = c.get(&format!("/tickets/{tid}/docs")).await.json();
    let found: Vec<&Value> = rows.as_array().expect("rows").iter().map(|d| &d["origin"]).collect();
    assert_eq!(found, vec![&json!("comment")]);
    c.delete(&format!("/tickets/{tid}/comments/{cid}")).await;
    assert_eq!(c.get(&format!("/tickets/{tid}/docs")).await.json(), json!([]));
    assert!(!id(&page).is_empty());
}

/// The Python test replaces `events.publish` and reads what it was given; here the event is read from the
/// server's event stream.
#[tokio::test]
async fn test_comment_activity_carries_comment_id_and_event_is_published() {
    if !skip_unless_available("test_comment_activity_carries_comment_id_and_event_is_published") {
        return;
    }
    let s = Server::start().await;
    let c = s.client();
    let pid = pid(&c).await;
    let t = _ticket(&c, &pid, json!({})).await;
    let mem = c.post(&format!("/projects/{pid}/members"), json!({"name": "Hoa Mai", "color": "#2E6F40"})).await.json();
    let mut stream = s.events().await;
    let text = format!("cc @[Hoa Mai](member:{})", id(&mem));
    let posted = c.post(&format!("/tickets/{}/comments", id(&t)), json!({"text": text, "author": "user"})).await.json();
    let cid = id(&posted["comments"][0]);
    let log: Vec<&Value> =
        posted["activity_log"].as_array().expect("activity_log").iter().filter(|e| e["field"] == "comment").collect();
    assert!(!log.is_empty() && log[0]["ref"] == json!(cid));
    let mut sent: Vec<String> = Vec::new();
    while let Some(message) = stream.next(Duration::from_secs(2)).await {
        sent.push(message);
        if sent.len() == 2 {
            break;
        }
    }
    assert_eq!(sent.first().map(String::as_str), Some("invalidate"));
    let events: Vec<Value> =
        sent.iter().filter(|m| m.starts_with('{')).map(|m| serde_json::from_str(m).expect("json")).collect();
    assert!(!events.is_empty() && events[0]["type"] == "comment_added" && events[0]["comment_id"] == json!(cid));
    assert_eq!(names(&events[0]["notified"]), ["Admin", "Hoa Mai"]);
    // the event as `json.dumps` writes it: the keys in this order
    let keys: Vec<&String> = events[0].as_object().expect("event").keys().collect();
    assert_eq!(keys, ["type", "ticket_id", "comment_id", "author", "notified"]);
}

/// The page of the Python test is only there to be referenced: the entries come from the text of the description.
#[tokio::test]
async fn test_description_edit_logs_doc_ref_added_and_removed() {
    if !skip_unless_available("test_description_edit_logs_doc_ref_added_and_removed") {
        return;
    }
    let s = Server::start().await;
    let c = s.client();
    let pid = pid(&c).await;
    if docs_served(&c, &pid).await {
        publish(&c, &mk(&c, &pid, "Spec").await, "## Auth\nx").await;
    }
    let t = _ticket(&c, &pid, json!({"description": "Follow [[Old rules]]."})).await;
    let r =
        c.patch(&format!("/tickets/{}", id(&t)), json!({"description": "Follow [[Spec#Auth]] and [[Spec]]."})).await;
    assert_eq!(r.status, 200, "{}", r.text());
    let log = r.json()["activity_log"].as_array().expect("activity_log").clone();
    let added: Vec<&Value> = log.iter().filter(|e| e["field"] == "doc_ref_added").map(|e| &e["to"]).collect();
    let removed: Vec<&Value> = log.iter().filter(|e| e["field"] == "doc_ref_removed").map(|e| &e["from"]).collect();
    assert!(added == [&json!("Spec#Auth"), &json!("Spec")] && removed == [&json!("Old rules")]);
    assert!(
        log.iter()
            .filter(|e| e["field"].as_str().expect("field").starts_with("doc_ref"))
            .all(|e| e["ref"] == "description")
    );
}
