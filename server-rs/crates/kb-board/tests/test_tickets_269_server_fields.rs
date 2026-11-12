//! `tests/test_tickets_269_server_fields.py` (issue #269), the row a ticket's own fields carry: whose review a
//! ticket in Review waits for. Left for their routes: `test_a_test_case_keeps_files_by_field_and_who_ran_and_decided_it`
//! (test cases) and `test_doc_references_in_comments_test_cases_and_linked_docs_reach_activity` (comments, test
//! cases, Docs pages).

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
