//! `tests/test_tickets_269_server_fields.py` (issue #269), the design rows that needed data from the server: whose
//! review a ticket in Review waits for, a test case's files beside its Expected result and Notes and who started or
//! decided it, and a doc reference added or removed anywhere on a ticket (a comment, a test case, Linked docs)
//! written in its Activity.

mod common;

use common::{get_ticket, id};
use serde_json::{Value, json};
use testkit::{Client, Server, skip_unless_available};

/// `_project` of `tests/ai_helpers.py`: the project's id and the id of its member An Nguyen.
async fn _project(c: &Client) -> (String, String) {
    let p = c.post("/projects", json!({"name": "Kanban Board", "prefix": "KAN", "color": "#2E6F40"})).await.json();
    let an = c.post(&format!("/projects/{}/members", id(&p)), json!({"name": "An Nguyen"})).await.json();
    (id(&p), id(&an))
}

/// `_ticket` of `tests/ai_helpers.py`.
async fn _ticket(c: &Client, pid: &str) -> String {
    let r = c.post(&format!("/projects/{pid}/tickets"), json!({"title": "Fix add()", "status": "todo"})).await;
    id(&r.json())
}

// --- 5. Review requested ----------------------------------------------------------------------------------------

/// The last step of the Python test (an AI clears the field with the MCP tool `update_ticket`) is done here with the
/// REST route, which reaches the same service function with the same field set to null; the tool itself is ported
/// with the MCP tools.
#[tokio::test]
async fn test_a_person_names_whose_review_a_ticket_waits_for() {
    if !skip_unless_available("test_a_person_names_whose_review_a_ticket_waits_for") {
        return;
    }
    let s = Server::start().await;
    let c = s.client();
    let an = c.clone().header("X-Actor", "An Nguyen");
    let (pid, _an) = _project(&c).await;
    let ha = c.post(&format!("/projects/{pid}/members"), json!({"name": "Ha My"})).await.json();
    let tid = _ticket(&c, &pid).await;
    let r = an.patch(&format!("/tickets/{tid}"), json!({"status": "review", "review_requested_from": ha["id"]})).await;
    assert_eq!(r.status, 200, "{}", r.text());
    let t = get_ticket(&c, &tid).await;
    assert_eq!(t["review_requested_from"], ha["id"]);
    assert!(t["activity_log"].as_array().expect("log").iter().any(|e| e["field"] == "review_requested_from"));
    // someone outside the project is refused
    let other = c.post("/projects", json!({"name": "O", "prefix": "OTH", "color": "#123456"})).await.json();
    let stranger = c.post(&format!("/projects/{}/members", id(&other)), json!({"name": "X"})).await.json();
    let r = c.patch(&format!("/tickets/{tid}"), json!({"review_requested_from": stranger["id"]})).await;
    assert!(r.status == 400 || r.status == 422, "{}", r.text());
    // cleared like any other field
    let out = c.patch(&format!("/tickets/{tid}"), json!({"review_requested_from": null})).await;
    assert_eq!(out.status, 200, "{}", out.text());
    assert_eq!(out.json()["review_requested_from"], Value::Null);
}

// --- 6. Test case files and who ran / decided it ------------------------------------------------------------------

#[tokio::test]
async fn test_a_test_case_keeps_files_by_field_and_who_ran_and_decided_it() {
    if !skip_unless_available("test_a_test_case_keeps_files_by_field_and_who_ran_and_decided_it") {
        return;
    }
    let s = Server::start().await;
    let c = s.client();
    let (pid, _) = _project(&c).await;
    let tid = _ticket(&c, &pid).await;
    let an = c.clone().header("X-Actor", "An Nguyen");
    let t = an.post(&format!("/tickets/{tid}/test-cases"), json!({"title": "Drop moves the card"})).await.json();
    let tc = t["test_cases"][0].clone();
    let shot = json!({"id": "f1", "name": "expected.png", "url": "/uploads/expected.png", "size": 10});
    let rec = json!({"id": "f2", "name": "ghost.mov", "url": "/uploads/ghost.mov", "size": 20});
    let t = c
        .clone()
        .header("X-Actor", "Ha My")
        .patch(
            &format!("/tickets/{tid}/test-cases/{}", id(&tc)),
            json!({"status": "running", "expected_files": [shot]}),
        )
        .await
        .json();
    let tc = t["test_cases"][0].clone();
    assert!(tc["expected_files"] == json!([shot]) && tc["notes_files"] == json!([]));
    assert!(tc["started_by"] == "Ha My" && !tc["started_at"].as_str().expect("started_at").is_empty());
    let t = c
        .clone()
        .header("X-Actor", "Tuan Vo")
        .patch(&format!("/tickets/{tid}/test-cases/{}", id(&tc)), json!({"status": "fail", "notes_files": [rec]}))
        .await
        .json();
    let tc = t["test_cases"][0].clone();
    assert!(tc["status_by"] == "Tuan Vo" && !tc["status_at"].as_str().expect("status_at").is_empty());
    assert!(tc["notes_files"] == json!([rec]) && tc["expected_files"] == json!([shot]));
    // the person who started it stays the one who started it
    assert_eq!(tc["started_by"], "Ha My");
}

// --- 7. Doc references in Activity --------------------------------------------------------------------------------

/// `(field, from, to, ref)` of the doc reference entries.
fn _refs(t: &Value) -> Vec<(Value, Value, Value, Value)> {
    t["activity_log"]
        .as_array()
        .expect("activity_log")
        .iter()
        .filter(|e| e["field"] == "doc_ref_added" || e["field"] == "doc_ref_removed")
        .map(|e| (e["field"].clone(), e["from"].clone(), e["to"].clone(), e["ref"].clone()))
        .collect()
}

/// The comment and the test case of the Python test. Its last part (a page linked by hand under Linked docs) is
/// left to the Docs port: it needs the Docs routes, and as written it no longer holds on the Python server, which
/// answers `already_linked: "mention"` and adds nothing when a test case of the ticket already names the page.
#[tokio::test]
async fn test_doc_references_in_comments_test_cases_and_linked_docs_reach_activity() {
    if !skip_unless_available("test_doc_references_in_comments_test_cases_and_linked_docs_reach_activity") {
        return;
    }
    let s = Server::start().await;
    let c = s.client();
    let (pid, _) = _project(&c).await;
    let tid = _ticket(&c, &pid).await;
    // a comment
    let t = c
        .post(&format!("/tickets/{tid}/comments"), json!({"text": "See [[API#Endpoints]]", "author": "An Nguyen"}))
        .await
        .json();
    let added = |key: &str, place: &str| (json!("doc_ref_added"), Value::Null, json!(key), json!(place));
    let removed = |key: &str, place: &str| (json!("doc_ref_removed"), json!(key), Value::Null, json!(place));
    assert!(_refs(&t).contains(&added("API#Endpoints", "a comment")));
    let comment = t["comments"].as_array().expect("comments").last().expect("a comment").clone();
    let t = c.patch(&format!("/tickets/{tid}/comments/{}", id(&comment)), json!({"text": "No link now"})).await.json();
    assert!(_refs(&t).contains(&removed("API#Endpoints", "a comment")));
    // a test case
    let t = c
        .post(&format!("/tickets/{tid}/test-cases"), json!({"title": "List", "expected_result": "As in [[API]]"}))
        .await
        .json();
    assert!(_refs(&t).contains(&added("API", "test case TC-1")));
}
