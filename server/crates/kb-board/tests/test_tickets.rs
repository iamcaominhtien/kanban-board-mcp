//! `tests/test_tickets.py`: the ticket itself (create, read, list, search, update, move, delete), its comments,
//! acceptance criteria, sub-tasks, work log, test cases and branches, the two tests that go through the member and
//! workspace routes, and reopen and pending.

mod common;

use common::{id, new_ticket, patch_empty};
use serde_json::{Value, json};
use testkit::{Client, Server, skip_unless_available};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async fn _create_project(c: &Client, prefix: &str) -> Value {
    let r = c.post("/projects", json!({"name": "Test Project", "prefix": prefix, "color": "#123456"})).await;
    assert_eq!(r.status, 201);
    r.json()
}

async fn _create_ticket(c: &Client, project_id: &str, title: &str, extra: Value) -> Value {
    let mut body = json!({"title": title});
    for (key, value) in extra.as_object().expect("extra fields") {
        body[key] = value.clone();
    }
    new_ticket(c, project_id, body).await
}

fn log_has(body: &Value, check: impl Fn(&Value) -> bool) -> bool {
    body["activity_log"].as_array().expect("activity_log").iter().any(check)
}

fn ids(list: &Value) -> Vec<String> {
    list.as_array().expect("list").iter().map(id).collect()
}

// ---------------------------------------------------------------------------
// Core CRUD
// ---------------------------------------------------------------------------

#[tokio::test]
async fn test_create_ticket_appears_in_list() {
    if !skip_unless_available("test_create_ticket_appears_in_list") {
        return;
    }
    let s = Server::start().await;
    let c = s.client();
    let project = _create_project(&c, "TST").await;
    let ticket = _create_ticket(&c, &id(&project), "First ticket", json!({})).await;
    let r = c.get(&format!("/projects/{}/tickets", id(&project))).await;
    assert_eq!(r.status, 200);
    let tickets = r.json();
    assert_eq!(tickets.as_array().expect("list").len(), 1);
    assert_eq!(tickets[0]["id"], ticket["id"]);
    assert_eq!(tickets[0]["title"], "First ticket");
}

#[tokio::test]
async fn test_get_ticket_404_if_missing() {
    if !skip_unless_available("test_get_ticket_404_if_missing") {
        return;
    }
    let s = Server::start().await;
    let r = s.client().get("/tickets/DOESNOTEXIST-999").await;
    assert_eq!(r.status, 404);
}

#[tokio::test]
async fn test_update_ticket_title_logs_activity() {
    if !skip_unless_available("test_update_ticket_title_logs_activity") {
        return;
    }
    let s = Server::start().await;
    let c = s.client();
    let project = _create_project(&c, "TST").await;
    let ticket = _create_ticket(&c, &id(&project), "Old title", json!({})).await;
    let r = c.patch(&format!("/tickets/{}", id(&ticket)), json!({"title": "New title"})).await;
    assert_eq!(r.status, 200);
    let body = r.json();
    assert_eq!(body["title"], "New title");
    assert!(log_has(&body, |e| e["field"] == "title" && e["from"] == "Old title" && e["to"] == "New title"));
}

#[tokio::test]
async fn test_update_ticket_status_logs_activity() {
    if !skip_unless_available("test_update_ticket_status_logs_activity") {
        return;
    }
    let s = Server::start().await;
    let c = s.client();
    let project = _create_project(&c, "TST").await;
    let ticket = _create_ticket(&c, &id(&project), "My ticket", json!({})).await;
    let r = c.patch(&format!("/tickets/{}", id(&ticket)), json!({"status": "in-progress"})).await;
    assert_eq!(r.status, 200);
    let body = r.json();
    assert_eq!(body["status"], "in-progress");
    assert!(log_has(&body, |e| e["field"] == "status" && e["to"] == "in-progress"));
}

#[tokio::test]
async fn test_update_ticket_description_and_tags_logs_activity() {
    if !skip_unless_available("test_update_ticket_description_and_tags_logs_activity") {
        return;
    }
    let s = Server::start().await;
    let c = s.client();
    let project = _create_project(&c, "TST").await;
    let ticket = _create_ticket(&c, &id(&project), "My ticket", json!({})).await;
    let r = c
        .patch(
            &format!("/tickets/{}", id(&ticket)),
            json!({"description": "Updated description content", "tags": ["FRONTEND", "UI"]}),
        )
        .await;
    assert_eq!(r.status, 200);
    let body = r.json();
    assert_eq!(body["description"], "Updated description content");
    assert!(log_has(&body, |e| e["field"] == "description" && e["to"] == "Updated description content"));
    assert!(log_has(&body, |e| e["field"] == "tags" && e["to"] == json!(["FRONTEND", "UI"])));
}

#[tokio::test]
async fn test_delete_ticket_then_404() {
    if !skip_unless_available("test_delete_ticket_then_404") {
        return;
    }
    let s = Server::start().await;
    let c = s.client();
    let project = _create_project(&c, "TST").await;
    let ticket = _create_ticket(&c, &id(&project), "My ticket", json!({})).await;
    let r_del = c.delete(&format!("/tickets/{}", id(&ticket))).await;
    assert_eq!(r_del.status, 204);
    let r_get = c.get(&format!("/tickets/{}", id(&ticket))).await;
    assert_eq!(r_get.status, 404);
}

#[tokio::test]
async fn test_quick_status_patch() {
    if !skip_unless_available("test_quick_status_patch") {
        return;
    }
    let s = Server::start().await;
    let c = s.client();
    let project = _create_project(&c, "TST").await;
    let ticket = _create_ticket(&c, &id(&project), "My ticket", json!({})).await;
    let r = c.patch(&format!("/tickets/{}/status", id(&ticket)), json!({"status": "done"})).await;
    assert_eq!(r.status, 200);
    assert_eq!(r.json()["status"], "done");
}

// ---------------------------------------------------------------------------
// Parent / child nesting
// ---------------------------------------------------------------------------

#[tokio::test]
async fn test_create_child_ticket() {
    if !skip_unless_available("test_create_child_ticket") {
        return;
    }
    let s = Server::start().await;
    let c = s.client();
    let project = _create_project(&c, "TST").await;
    let parent = _create_ticket(&c, &id(&project), "Parent", json!({})).await;
    let child = _create_ticket(&c, &id(&project), "Child", json!({"parent_id": parent["id"]})).await;
    assert_eq!(child["parent_id"], parent["id"]);
}

#[tokio::test]
async fn test_create_child_of_child_returns_400() {
    if !skip_unless_available("test_create_child_of_child_returns_400") {
        return;
    }
    let s = Server::start().await;
    let c = s.client();
    let project = _create_project(&c, "TST").await;
    let parent = _create_ticket(&c, &id(&project), "Parent", json!({})).await;
    let child = _create_ticket(&c, &id(&project), "Child", json!({"parent_id": parent["id"]})).await;
    let r = c
        .post(&format!("/projects/{}/tickets", id(&project)), json!({"title": "Grandchild", "parent_id": child["id"]}))
        .await;
    assert_eq!(r.status, 400);
}

// ---------------------------------------------------------------------------
// Comments
// ---------------------------------------------------------------------------

#[tokio::test]
async fn test_add_and_delete_comment() {
    if !skip_unless_available("test_add_and_delete_comment") {
        return;
    }
    let s = Server::start().await;
    let c = s.client();
    let project = _create_project(&c, "TST").await;
    let ticket = _create_ticket(&c, &id(&project), "My ticket", json!({})).await;
    let tid = id(&ticket);

    let r_add = c.post(&format!("/tickets/{tid}/comments"), json!({"text": "Hello", "author": "alice"})).await;
    assert_eq!(r_add.status, 200);
    let comments = r_add.json()["comments"].clone();
    assert_eq!(comments.as_array().expect("comments").len(), 1);
    assert_eq!(comments[0]["text"], "Hello");
    let comment_id = id(&comments[0]);

    let r_del = c.delete(&format!("/tickets/{tid}/comments/{comment_id}")).await;
    assert_eq!(r_del.status, 200);
    assert_eq!(r_del.json()["comments"], json!([]));
}

#[tokio::test]
async fn test_update_comment() {
    if !skip_unless_available("test_update_comment") {
        return;
    }
    let s = Server::start().await;
    let c = s.client();
    let project = _create_project(&c, "TST").await;
    let ticket = _create_ticket(&c, &id(&project), "My ticket", json!({})).await;
    let tid = id(&ticket);

    let r_add = c.post(&format!("/tickets/{tid}/comments"), json!({"text": "Hello", "author": "alice"})).await;
    let comment_id = id(&r_add.json()["comments"][0]);

    let r_patch = c
        .patch(&format!("/tickets/{tid}/comments/{comment_id}"), json!({"text": "## Updated\n\n- with markdown"}))
        .await;
    assert_eq!(r_patch.status, 200);
    let comments = r_patch.json()["comments"].clone();
    assert_eq!(comments.as_array().expect("comments").len(), 1);
    assert_eq!(comments[0]["id"], json!(comment_id));
    assert_eq!(comments[0]["text"], "## Updated\n\n- with markdown");
    assert_eq!(comments[0]["author"], "alice");
}

#[tokio::test]
async fn test_update_comment_unknown_returns_404() {
    if !skip_unless_available("test_update_comment_unknown_returns_404") {
        return;
    }
    let s = Server::start().await;
    let c = s.client();
    let project = _create_project(&c, "TST").await;
    let ticket = _create_ticket(&c, &id(&project), "My ticket", json!({})).await;

    let r_patch =
        c.patch(&format!("/tickets/{}/comments/does-not-exist", id(&ticket)), json!({"text": "new text"})).await;
    assert_eq!(r_patch.status, 404);
}

// ---------------------------------------------------------------------------
// Acceptance criteria
// ---------------------------------------------------------------------------

#[tokio::test]
async fn test_add_toggle_delete_acceptance_criterion() {
    if !skip_unless_available("test_add_toggle_delete_acceptance_criterion") {
        return;
    }
    let s = Server::start().await;
    let c = s.client();
    let project = _create_project(&c, "TST").await;
    let ticket = _create_ticket(&c, &id(&project), "My ticket", json!({})).await;
    let tid = id(&ticket);

    let r_add = c.post(&format!("/tickets/{tid}/acceptance-criteria"), json!({"text": "It works"})).await;
    assert_eq!(r_add.status, 200);
    let acs = r_add.json()["acceptance_criteria"].clone();
    assert_eq!(acs.as_array().expect("criteria").len(), 1);
    assert_eq!(acs[0]["done"], false);
    let ac_id = id(&acs[0]);

    let r_toggle = patch_empty(&c, &format!("/tickets/{tid}/acceptance-criteria/{ac_id}/toggle")).await;
    assert_eq!(r_toggle.status, 200);
    let ac_after = r_toggle.json()["acceptance_criteria"][0].clone();
    assert_eq!(ac_after["done"], true);

    let r_del = c.delete(&format!("/tickets/{tid}/acceptance-criteria/{ac_id}")).await;
    assert_eq!(r_del.status, 200);
    assert_eq!(r_del.json()["acceptance_criteria"], json!([]));
}

// ---------------------------------------------------------------------------
// Sub-tasks (checklist items)
// ---------------------------------------------------------------------------

#[tokio::test]
async fn test_add_toggle_delete_sub_task() {
    if !skip_unless_available("test_add_toggle_delete_sub_task") {
        return;
    }
    let s = Server::start().await;
    let c = s.client();
    let project = _create_project(&c, "TST").await;
    let ticket = _create_ticket(&c, &id(&project), "My ticket", json!({})).await;
    let tid = id(&ticket);
    assert_eq!(ticket["sub_tasks"], json!([]));

    let r_add = c.post(&format!("/tickets/{tid}/sub-tasks"), json!({"text": "Confirm spec"})).await;
    assert_eq!(r_add.status, 200);
    let items = r_add.json()["sub_tasks"].clone();
    let shown: Vec<(Value, Value)> =
        items.as_array().expect("sub_tasks").iter().map(|i| (i["text"].clone(), i["done"].clone())).collect();
    assert_eq!(shown, vec![(json!("Confirm spec"), json!(false))]);
    let sub_id = id(&items[0]);

    let r_toggle = patch_empty(&c, &format!("/tickets/{tid}/sub-tasks/{sub_id}/toggle")).await;
    assert_eq!(r_toggle.json()["sub_tasks"][0]["done"], true);

    let r_blank = c.post(&format!("/tickets/{tid}/sub-tasks"), json!({"text": "  "})).await;
    assert_eq!(r_blank.status, 400);

    let r_del = c.delete(&format!("/tickets/{tid}/sub-tasks/{sub_id}")).await;
    assert_eq!(r_del.status, 200);
    assert_eq!(r_del.json()["sub_tasks"], json!([]));

    let r_missing = c.post("/tickets/NOPE-1/sub-tasks", json!({"text": "x"})).await;
    assert_eq!(r_missing.status, 404);
}

// ---------------------------------------------------------------------------
// Work log
// ---------------------------------------------------------------------------

#[tokio::test]
async fn test_add_work_log() {
    if !skip_unless_available("test_add_work_log") {
        return;
    }
    let s = Server::start().await;
    let c = s.client();
    let project = _create_project(&c, "TST").await;
    let ticket = _create_ticket(&c, &id(&project), "My ticket", json!({})).await;
    let r = c
        .post(
            &format!("/tickets/{}/work-log", id(&ticket)),
            json!({"author": "bob", "role": "Developer", "note": "Did stuff"}),
        )
        .await;
    assert_eq!(r.status, 200);
    let wl = r.json()["work_log"].clone();
    assert_eq!(wl.as_array().expect("work_log").len(), 1);
    assert_eq!(wl[0]["note"], "Did stuff");
}

#[tokio::test]
async fn test_delete_work_log() {
    if !skip_unless_available("test_delete_work_log") {
        return;
    }
    let s = Server::start().await;
    let c = s.client();
    let project = _create_project(&c, "TST").await;
    let ticket = _create_ticket(&c, &id(&project), "My ticket", json!({})).await;
    let tid = id(&ticket);
    let r_add = c
        .post(&format!("/tickets/{tid}/work-log"), json!({"author": "alice", "role": "Tester", "note": "Reviewed"}))
        .await;
    assert_eq!(r_add.status, 200);
    let log_id = id(&r_add.json()["work_log"][0]);
    let r_del = c.delete(&format!("/tickets/{tid}/work-log/{log_id}")).await;
    assert_eq!(r_del.status, 200);
    assert_eq!(r_del.json()["work_log"], json!([]));
}

#[tokio::test]
async fn test_debug_space_extended_work_log_and_update() {
    if !skip_unless_available("test_debug_space_extended_work_log_and_update") {
        return;
    }
    let s = Server::start().await;
    let c = s.client();
    let project = _create_project(&c, "TST").await;
    let ticket = _create_ticket(&c, &id(&project), "My ticket", json!({})).await;
    let tid = id(&ticket);
    // Links must point at a real branch and test case of the ticket
    c.post(&format!("/tickets/{tid}/branches"), json!({"name": "fix/jwt-decode"})).await;
    c.post(&format!("/tickets/{tid}/test-cases"), json!({"title": "jwt decode"})).await;

    // Add rich debug entry
    let r_add = c
        .post(
            &format!("/tickets/{tid}/work-log"),
            json!({
                "author": "An",
                "role": "Tester",
                "note": "Found null pointer in JWT decoder",
                "kind": "investigation",
                "pinned": true,
                "attachments": [{"id": "att-1", "name": "trace.log", "url": "/uploads/trace.log"}],
                "linked_branch": "fix/jwt-decode",
                "linked_test_case": "TC-1",
            }),
        )
        .await;
    assert_eq!(r_add.status, 200);
    let wl = r_add.json()["work_log"].clone();
    assert_eq!(wl.as_array().expect("work_log").len(), 1);
    let entry = wl[0].clone();
    assert_eq!(entry["author"], "An");
    assert_eq!(entry["kind"], "investigation");
    assert_eq!(entry["pinned"], true);
    assert_eq!(entry["attachments"].as_array().expect("attachments").len(), 1);
    assert_eq!(entry["linked_branch"], "fix/jwt-decode");
    assert_eq!(entry["linked_test_case"], "TC-1");
    assert!(!entry["at"].is_null());

    // Update debug entry (change to root_cause, modify note)
    let log_id = id(&entry);
    let r_patch = c
        .patch(
            &format!("/tickets/{tid}/work-log/{log_id}"),
            json!({
                "kind": "root_cause",
                "note": "Confirmed root cause: missing fallback when token header has no kid",
                "pinned": true,
            }),
        )
        .await;
    assert_eq!(r_patch.status, 200);
    let entry_upd = r_patch.json()["work_log"][0].clone();
    assert_eq!(entry_upd["kind"], "root_cause");
    assert_eq!(entry_upd["note"], "Confirmed root cause: missing fallback when token header has no kid");
    assert_eq!(entry_upd["pinned"], true);
    assert!(!entry_upd["updated_at"].is_null());
}

// ---------------------------------------------------------------------------
// Test cases
// ---------------------------------------------------------------------------

#[tokio::test]
async fn test_add_update_delete_test_case() {
    if !skip_unless_available("test_add_update_delete_test_case") {
        return;
    }
    let s = Server::start().await;
    let c = s.client();
    let project = _create_project(&c, "TST").await;
    let ticket = _create_ticket(&c, &id(&project), "My ticket", json!({})).await;
    let tid = id(&ticket);

    let r_add = c.post(&format!("/tickets/{tid}/test-cases"), json!({"title": "TC1", "status": "pending"})).await;
    assert_eq!(r_add.status, 200);
    let tcs = r_add.json()["test_cases"].clone();
    assert_eq!(tcs.as_array().expect("test_cases").len(), 1);
    let tc_id = id(&tcs[0]);
    assert_eq!(tcs[0]["status"], "pending");

    let r_upd = c
        .patch(&format!("/tickets/{tid}/test-cases/{tc_id}"), json!({"status": "pass", "proof": "screenshot.png"}))
        .await;
    assert_eq!(r_upd.status, 200);
    let tc_after = r_upd.json()["test_cases"][0].clone();
    assert_eq!(tc_after["status"], "pass");
    assert_eq!(tc_after["proof"], "screenshot.png");

    let r_del = c.delete(&format!("/tickets/{tid}/test-cases/{tc_id}")).await;
    assert_eq!(r_del.status, 200);
    assert_eq!(r_del.json()["test_cases"], json!([]));
}

#[tokio::test]
async fn test_test_case_extended_fields_and_running_status() {
    if !skip_unless_available("test_test_case_extended_fields_and_running_status") {
        return;
    }
    let s = Server::start().await;
    let c = s.client();
    let project = _create_project(&c, "TST").await;
    let ticket = _create_ticket(&c, &id(&project), "My ticket", json!({})).await;
    let tid = id(&ticket);

    // Add first TC with running status & extended fields
    let r1 = c
        .post(
            &format!("/tickets/{tid}/test-cases"),
            json!({
                "title": "Verify login with OAuth",
                "status": "running",
                "description": "User clicks Google button and completes auth",
                "expected_result": "Redirect to dashboard with valid JWT",
                "notes": "Testing against staging OAuth provider",
                "assignee": "alex",
            }),
        )
        .await;
    assert_eq!(r1.status, 200);
    let tc1 = r1.json()["test_cases"][0].clone();
    assert_eq!(tc1["code"], "TC-1");
    assert_eq!(tc1["status"], "running");
    assert!(!tc1["started_at"].is_null());
    assert_eq!(tc1["description"], "User clicks Google button and completes auth");
    assert_eq!(tc1["expected_result"], "Redirect to dashboard with valid JWT");
    assert_eq!(tc1["assignee"], "alex");

    // Add second TC
    let r2 = c
        .post(&format!("/tickets/{tid}/test-cases"), json!({"title": "Verify password reset", "status": "pending"}))
        .await;
    assert_eq!(r2.status, 200);
    let tc2 = r2.json()["test_cases"][1].clone();
    assert_eq!(tc2["code"], "TC-2");
    assert_eq!(tc2["status"], "pending");

    // Update first TC to pass
    let r_upd = c
        .patch(
            &format!("/tickets/{tid}/test-cases/{}", id(&tc1)),
            json!({"status": "pass", "notes": "OAuth returned status 200, JWT verified in local storage"}),
        )
        .await;
    assert_eq!(r_upd.status, 200);
    let tc1_updated = r_upd.json()["test_cases"][0].clone();
    assert_eq!(tc1_updated["status"], "pass");
    assert_eq!(tc1_updated["notes"], "OAuth returned status 200, JWT verified in local storage");
}

// ---------------------------------------------------------------------------
// List with filters
// ---------------------------------------------------------------------------

#[tokio::test]
async fn test_list_tickets_with_status_filter() {
    if !skip_unless_available("test_list_tickets_with_status_filter") {
        return;
    }
    let s = Server::start().await;
    let c = s.client();
    let project = _create_project(&c, "TST").await;
    let t1 = _create_ticket(&c, &id(&project), "Backlog ticket", json!({})).await;
    c.patch(&format!("/tickets/{}/status", id(&t1)), json!({"status": "done"})).await;
    _create_ticket(&c, &id(&project), "Another backlog ticket", json!({})).await;

    let r = c.get_query(&format!("/projects/{}/tickets", id(&project)), &[("status", "done")]).await;
    assert_eq!(r.status, 200);
    let results = r.json();
    assert_eq!(results.as_array().expect("list").len(), 1);
    assert_eq!(results[0]["status"], "done");
}

// ---------------------------------------------------------------------------
// Fuzzy search (`q`)
// ---------------------------------------------------------------------------

#[tokio::test]
async fn test_search_by_ticket_id_substring() {
    if !skip_unless_available("test_search_by_ticket_id_substring") {
        return;
    }
    let s = Server::start().await;
    let c = s.client();
    let project = _create_project(&c, "MON").await;
    let ticket = _create_ticket(&c, &id(&project), "Unrelated title", json!({})).await;
    let ticket_id = id(&ticket);
    let number = ticket_id.split('-').nth(1).expect("number");

    let r = c.get_query(&format!("/projects/{}/tickets", id(&project)), &[("q", number)]).await;
    assert_eq!(r.status, 200);
    let results = r.json();
    assert_eq!(results.as_array().expect("list").len(), 1);
    assert_eq!(results[0]["id"], ticket["id"]);
}

#[tokio::test]
async fn test_search_by_title_fuzzy() {
    if !skip_unless_available("test_search_by_title_fuzzy") {
        return;
    }
    let s = Server::start().await;
    let c = s.client();
    let project = _create_project(&c, "TST").await;
    let ticket = _create_ticket(&c, &id(&project), "Fix login page crash", json!({})).await;
    _create_ticket(&c, &id(&project), "Improve onboarding flow", json!({})).await;

    // Slightly misspelled / partial query should still match via fuzzy scoring.
    let r = c.get_query(&format!("/projects/{}/tickets", id(&project)), &[("q", "login pge")]).await;
    assert_eq!(r.status, 200);
    let results = r.json();
    assert_eq!(results.as_array().expect("list").len(), 1);
    assert_eq!(results[0]["id"], ticket["id"]);
}

#[tokio::test]
async fn test_search_by_description() {
    if !skip_unless_available("test_search_by_description") {
        return;
    }
    let s = Server::start().await;
    let c = s.client();
    let project = _create_project(&c, "TST").await;
    let ticket =
        _create_ticket(&c, &id(&project), "Generic title", json!({"description": "Users cannot reset their password"}))
            .await;
    _create_ticket(&c, &id(&project), "Another generic title", json!({})).await;

    let r = c.get_query(&format!("/projects/{}/tickets", id(&project)), &[("q", "reset password")]).await;
    assert_eq!(r.status, 200);
    let results = r.json();
    assert_eq!(results.as_array().expect("list").len(), 1);
    assert_eq!(results[0]["id"], ticket["id"]);
}

#[tokio::test]
async fn test_search_by_tag() {
    if !skip_unless_available("test_search_by_tag") {
        return;
    }
    let s = Server::start().await;
    let c = s.client();
    let project = _create_project(&c, "TST").await;
    let ticket = _create_ticket(&c, &id(&project), "Generic title", json!({"tags": ["backend"]})).await;
    _create_ticket(&c, &id(&project), "Other ticket", json!({"tags": ["frontend"]})).await;

    let r = c.get_query(&format!("/projects/{}/tickets", id(&project)), &[("q", "backend")]).await;
    assert_eq!(r.status, 200);
    let results = r.json();
    assert_eq!(results.as_array().expect("list").len(), 1);
    assert_eq!(results[0]["id"], ticket["id"]);
}

#[tokio::test]
async fn test_search_no_match_returns_empty() {
    if !skip_unless_available("test_search_no_match_returns_empty") {
        return;
    }
    let s = Server::start().await;
    let c = s.client();
    let project = _create_project(&c, "TST").await;
    _create_ticket(&c, &id(&project), "Fix login page crash", json!({})).await;

    let r = c.get_query(&format!("/projects/{}/tickets", id(&project)), &[("q", "zzzzz nonexistent")]).await;
    assert_eq!(r.status, 200);
    assert_eq!(r.json(), json!([]));
}

// ---------------------------------------------------------------------------
// Wont Do status
// ---------------------------------------------------------------------------

#[tokio::test]
async fn test_set_wont_do_requires_reason() {
    if !skip_unless_available("test_set_wont_do_requires_reason") {
        return;
    }
    let s = Server::start().await;
    let c = s.client();
    let project = _create_project(&c, "TST").await;
    let ticket = _create_ticket(&c, &id(&project), "My ticket", json!({})).await;
    let r = c.patch(&format!("/tickets/{}", id(&ticket)), json!({"status": "wont_do"})).await;
    assert_eq!(r.status, 400);
    assert!(r.detail().as_str().expect("detail").contains("wont_do_reason"));
}

#[tokio::test]
async fn test_set_wont_do_with_reason() {
    if !skip_unless_available("test_set_wont_do_with_reason") {
        return;
    }
    let s = Server::start().await;
    let c = s.client();
    let project = _create_project(&c, "TST").await;
    let ticket = _create_ticket(&c, &id(&project), "My ticket", json!({})).await;
    let r = c
        .patch(&format!("/tickets/{}", id(&ticket)), json!({"status": "wont_do", "wont_do_reason": "Out of scope"}))
        .await;
    assert_eq!(r.status, 200);
    let body = r.json();
    assert_eq!(body["status"], "wont_do");
    assert_eq!(body["wont_do_reason"], "Out of scope");
}

#[tokio::test]
async fn test_wont_do_tickets_excluded_by_default() {
    if !skip_unless_available("test_wont_do_tickets_excluded_by_default") {
        return;
    }
    let s = Server::start().await;
    let c = s.client();
    let project = _create_project(&c, "TST").await;
    let t1 = _create_ticket(&c, &id(&project), "Normal ticket", json!({})).await;
    let t2 = _create_ticket(&c, &id(&project), "Wont do ticket", json!({})).await;
    c.patch(&format!("/tickets/{}", id(&t2)), json!({"status": "wont_do", "wont_do_reason": "Not needed"})).await;
    let r_default = c.get(&format!("/projects/{}/tickets", id(&project))).await;
    let r_include = c.get_query(&format!("/projects/{}/tickets", id(&project)), &[("include_wont_do", "true")]).await;
    assert_eq!(r_default.status, 200);
    let default_ids = ids(&r_default.json());
    assert!(default_ids.contains(&id(&t1)));
    assert!(!default_ids.contains(&id(&t2)));

    let all_ids = ids(&r_include.json());
    assert!(all_ids.contains(&id(&t1)));
    assert!(all_ids.contains(&id(&t2)));
}

#[tokio::test]
async fn test_set_wont_do_with_null_reason_returns_400() {
    if !skip_unless_available("test_set_wont_do_with_null_reason_returns_400") {
        return;
    }
    let s = Server::start().await;
    let c = s.client();
    let project = _create_project(&c, "TST").await;
    let ticket = _create_ticket(&c, &id(&project), "My ticket", json!({})).await;
    let r = c.patch(&format!("/tickets/{}", id(&ticket)), json!({"status": "wont_do", "wont_do_reason": null})).await;
    assert_eq!(r.status, 400);
    assert!(r.detail().as_str().expect("detail").contains("wont_do_reason"));
}

#[tokio::test]
async fn test_child_ticket_cannot_be_set_to_wont_do() {
    if !skip_unless_available("test_child_ticket_cannot_be_set_to_wont_do") {
        return;
    }
    let s = Server::start().await;
    let c = s.client();
    let project = _create_project(&c, "TST").await;
    let parent = _create_ticket(&c, &id(&project), "Parent ticket", json!({})).await;
    let child = _create_ticket(&c, &id(&project), "Child ticket", json!({"parent_id": parent["id"]})).await;
    let r = c
        .patch(&format!("/tickets/{}", id(&child)), json!({"status": "wont_do", "wont_do_reason": "Not needed"}))
        .await;
    assert_eq!(r.status, 400);
    let detail = r.detail().as_str().expect("detail").to_string();
    assert!(detail.contains("Child") || detail.contains("wont_do"));
}

#[tokio::test]
async fn test_restore_ticket_clears_wont_do_reason() {
    if !skip_unless_available("test_restore_ticket_clears_wont_do_reason") {
        return;
    }
    let s = Server::start().await;
    let c = s.client();
    let project = _create_project(&c, "TST").await;
    let ticket = _create_ticket(&c, &id(&project), "My ticket", json!({})).await;
    c.patch(&format!("/tickets/{}", id(&ticket)), json!({"status": "wont_do", "wont_do_reason": "Out of scope"})).await;
    let r = c.patch(&format!("/tickets/{}", id(&ticket)), json!({"status": "backlog"})).await;
    assert_eq!(r.status, 200);
    let body = r.json();
    assert_eq!(body["status"], "backlog");
    assert_eq!(body["wont_do_reason"], Value::Null);
}

#[tokio::test]
async fn test_review_and_testing_status_transitions() {
    if !skip_unless_available("test_review_and_testing_status_transitions") {
        return;
    }
    let s = Server::start().await;
    let c = s.client();
    let project = _create_project(&c, "TST").await;
    let ticket = _create_ticket(&c, &id(&project), "My ticket", json!({})).await;

    // Update to review
    let r = c.patch(&format!("/tickets/{}/status", id(&ticket)), json!({"status": "review"})).await;
    assert_eq!(r.status, 200);
    assert_eq!(r.json()["status"], "review");

    // Update to testing
    let r = c.patch(&format!("/tickets/{}/status", id(&ticket)), json!({"status": "testing"})).await;
    assert_eq!(r.status, 200);
    assert_eq!(r.json()["status"], "testing");
}

#[tokio::test]
async fn test_branch_crud_operations() {
    if !skip_unless_available("test_branch_crud_operations") {
        return;
    }
    let s = Server::start().await;
    let c = s.client();
    let project = _create_project(&c, "TST").await;
    let ticket = _create_ticket(&c, &id(&project), "My ticket", json!({})).await;
    let tid = id(&ticket);

    // Create branch
    let r_create = c
        .post(
            &format!("/tickets/{tid}/branches"),
            json!({
                "name": "feature/attachments",
                "branch_from": "main",
                "status": "open",
                "ahead_count": 2,
                "behind_count": 1,
            }),
        )
        .await;
    assert_eq!(r_create.status, 201);
    let branches = r_create.json()["branches"].clone();
    assert_eq!(branches.as_array().expect("branches").len(), 1);
    let branch = branches[0].clone();
    assert_eq!(branch["name"], "feature/attachments");
    assert_eq!(branch["status"], "open");
    assert_eq!(branch["branch_from"], "main");
    assert_eq!(branch["ahead_count"], 2);
    assert_eq!(branch["behind_count"], 1);
    let branch_id = id(&branch);

    // List branches
    let r_list = c.get(&format!("/tickets/{tid}/branches")).await;
    assert_eq!(r_list.status, 200);
    assert_eq!(r_list.json().as_array().expect("branches").len(), 1);

    // Patch branch
    let r_patch = c
        .patch(
            &format!("/tickets/{tid}/branches/{branch_id}"),
            json!({"status": "merged", "pr_url": "https://github.com/example/repo/pull/42"}),
        )
        .await;
    assert_eq!(r_patch.status, 200);
    let updated_branch = r_patch.json()["branches"][0].clone();
    assert_eq!(updated_branch["status"], "merged");
    assert_eq!(updated_branch["pr_url"], "https://github.com/example/repo/pull/42");

    // Delete branch
    let r_del = c.delete(&format!("/tickets/{tid}/branches/{branch_id}")).await;
    assert_eq!(r_del.status, 200);
    assert_eq!(r_del.json()["branches"], json!([]));
}

#[tokio::test]
async fn test_workspace_settings_and_ticket_retention() {
    if !skip_unless_available("test_workspace_settings_and_ticket_retention") {
        return;
    }
    let s = Server::start().await;
    let c = s.client();
    // Get settings
    let r_get = c.get("/workspace/settings").await;
    assert_eq!(r_get.status, 200);
    let settings = r_get.json();
    assert_eq!(settings["enabled"], true);
    assert_eq!(settings["default_retention_days"], 14);

    // Patch settings
    let r_patch = c.patch("/workspace/settings", json!({"default_retention_days": 30})).await;
    assert_eq!(r_patch.status, 200);
    assert_eq!(r_patch.json()["default_retention_days"], 30);

    // Ticket workspace
    let project = _create_project(&c, "TST").await;
    let ticket = _create_ticket(&c, &id(&project), "My ticket", json!({})).await;

    let r_ws = c.get(&format!("/tickets/{}/workspace", id(&ticket))).await;
    assert_eq!(r_ws.status, 200);
    let ws_info = r_ws.json();
    assert_eq!(ws_info["enabled"], true);
    assert_eq!(ws_info["retention_days"], 30);
    assert!(ws_info.get("files").is_some());

    // Override retention per task
    let r_override =
        c.patch(&format!("/tickets/{}/workspace/retention", id(&ticket)), json!({"retention_days": 7})).await;
    assert_eq!(r_override.status, 200);
    assert_eq!(r_override.json()["workspace_retention_days"], 7);

    let r_ws2 = c.get(&format!("/tickets/{}/workspace", id(&ticket))).await;
    assert_eq!(r_ws2.json()["retention_days"], 7);
}

#[tokio::test]
async fn test_remove_member_blocked_when_assigned_to_open_tickets() {
    if !skip_unless_available("test_remove_member_blocked_when_assigned_to_open_tickets") {
        return;
    }
    let s = Server::start().await;
    let c = s.client();
    let project = _create_project(&c, "TST").await;
    let pid = id(&project);
    // Create member
    let r_mem = c.post(&format!("/projects/{pid}/members"), json!({"name": "An Nguyen", "color": "#2E6F40"})).await;
    assert_eq!(r_mem.status, 201);
    let member_id = id(&r_mem.json());

    // Create ticket assigned to member
    let ticket = _create_ticket(&c, &pid, "Task for An", json!({})).await;
    let r_assign = c.patch(&format!("/tickets/{}", id(&ticket)), json!({"assignee": member_id})).await;
    assert_eq!(r_assign.status, 200);
    assert_eq!(r_assign.json()["assignee"], json!(member_id));

    // Try to delete member while assigned to open ticket
    let r_del_blocked = c.delete(&format!("/projects/{pid}/members/{member_id}")).await;
    assert_eq!(r_del_blocked.status, 400);
    assert!(
        r_del_blocked.detail().as_str().expect("detail").contains("Cannot remove: assigned to 1 open ticket"),
        "{}",
        r_del_blocked.text()
    );

    // Close ticket
    let r_done = c.patch(&format!("/tickets/{}/status", id(&ticket)), json!({"status": "done"})).await;
    assert_eq!(r_done.status, 200);

    // Now delete member should succeed
    let r_del_ok = c.delete(&format!("/projects/{pid}/members/{member_id}")).await;
    assert_eq!(r_del_ok.status, 204);
}

#[tokio::test]
async fn test_reopen_ticket_lifecycle() {
    if !skip_unless_available("test_reopen_ticket_lifecycle") {
        return;
    }
    let s = Server::start().await;
    let c = s.client();
    let project = _create_project(&c, "TST").await;
    let ticket = _create_ticket(&c, &id(&project), "Done task", json!({})).await;
    let tid = id(&ticket);

    // Add AC and TC
    c.post(&format!("/tickets/{tid}/acceptance-criteria"), json!({"text": "Must work"})).await;
    let t_ac = c.get(&format!("/tickets/{tid}")).await.json();
    let ac_id = id(&t_ac["acceptance_criteria"][0]);
    // (the Python test posts to the toggle route, which is a PATCH: the answer is a 405 it does not look at)
    c.post_empty(&format!("/tickets/{tid}/acceptance-criteria/{ac_id}/toggle")).await;

    // Mark done
    let r_done = c.patch(&format!("/tickets/{tid}/status"), json!({"status": "done"})).await;
    assert_eq!(r_done.status, 200);

    // Cannot reopen open ticket (e.g. if already open)
    // Reopen from done
    let r_reopen = c
        .post(
            &format!("/tickets/{tid}/reopen"),
            json!({"reason": "Found regression in production", "reset_ac": true, "actor": "Linh Pham"}),
        )
        .await;
    assert_eq!(r_reopen.status, 200);
    let reopened = r_reopen.json();
    assert_eq!(reopened["status"], "todo");
    assert_eq!(reopened["reopen_count"], 1);
    assert_eq!(reopened["last_reopen_reason"], "Found regression in production");
    assert_eq!(reopened["last_reopened_by"], "Linh Pham");
    assert_eq!(reopened["reopen_history"].as_array().expect("history").len(), 1);
    assert_eq!(reopened["acceptance_criteria"][0]["done"], false);
}

#[tokio::test]
async fn test_pending_ticket_lifecycle() {
    if !skip_unless_available("test_pending_ticket_lifecycle") {
        return;
    }
    let s = Server::start().await;
    let c = s.client();
    let project = _create_project(&c, "TST").await;
    let t1 = _create_ticket(&c, &id(&project), "Blocker task", json!({})).await;
    let t2 = _create_ticket(&c, &id(&project), "Blocked task", json!({})).await;

    // Set pending waiting on ticket
    let r_pen = c
        .put(
            &format!("/tickets/{}/pending", id(&t2)),
            json!({
                "reason_type": "ticket",
                "ticket_id": t1["id"],
                "note": "Waiting on API contract",
                "add_blocked_by": true,
            }),
        )
        .await;
    assert_eq!(r_pen.status, 200);
    let pen = r_pen.json();
    assert_eq!(pen["pending"], true);
    assert_eq!(pen["pending_ticket_id"], t1["id"]);
    assert_eq!(pen["pending_reason_type"], "ticket");
    assert_eq!(pen["pending_note"], "Waiting on API contract");
    assert!(pen["blocked_by"].as_array().expect("blocked_by").contains(&t1["id"]));

    // Resume ticket
    let r_res = c
        .post(&format!("/tickets/{}/resume", id(&t2)), json!({"reason": "Contract finalized", "add_comment": true}))
        .await;
    assert_eq!(r_res.status, 200);
    let res = r_res.json();
    assert_eq!(res["pending"], false);
    let comments = res["comments"].as_array().expect("comments");
    assert!(comments.iter().any(|comm| comm["text"].as_str().expect("text").contains("Contract finalized")));
}

#[tokio::test]
async fn test_set_pending_validates_its_target() {
    if !skip_unless_available("test_set_pending_validates_its_target") {
        return;
    }
    let s = Server::start().await;
    let c = s.client();
    let project = _create_project(&c, "TST").await;
    let t = _create_ticket(&c, &id(&project), "A", json!({})).await;
    let url = format!("/tickets/{}/pending", id(&t));

    for body in [
        json!({"reason_type": "ticket"}),
        json!({"reason_type": "ticket", "ticket_id": t["id"]}),
        json!({"reason_type": "ticket", "ticket_id": "NOPE-1"}),
        json!({"reason_type": "person"}),
        json!({"reason_type": "person", "member_id": "missing"}),
        json!({"reason_type": "party", "party": "   "}),
        json!({"reason_type": "party", "party": "x".repeat(241)}),
    ] {
        let r = c.put(&url, body.clone()).await;
        assert_eq!(r.status, 400, "{body}");
    }
    assert_eq!(c.get(&format!("/tickets/{}", id(&t))).await.json()["pending"], false);

    let r = c.put(&url, json!({"reason_type": "party", "party": "Client", "note": "n"})).await;
    assert_eq!(r.status, 200);
    assert_eq!(r.json()["pending_party"], "Client");

    // switching to another reason drops the old party
    let t2 = _create_ticket(&c, &id(&project), "B", json!({})).await;
    let r = c.put(&url, json!({"reason_type": "ticket", "ticket_id": t2["id"]})).await;
    assert!(r.json()["pending_party"].is_null());
}

#[tokio::test]
async fn test_closed_ticket_cannot_be_pending_and_open_ticket_cannot_reopen() {
    if !skip_unless_available("test_closed_ticket_cannot_be_pending_and_open_ticket_cannot_reopen") {
        return;
    }
    let s = Server::start().await;
    let c = s.client();
    let project = _create_project(&c, "TST").await;
    let t = _create_ticket(&c, &id(&project), "A", json!({})).await;
    let tid = id(&t);
    assert_eq!(c.post(&format!("/tickets/{tid}/reopen"), json!({})).await.status, 409);
    c.patch(&format!("/tickets/{tid}/status"), json!({"status": "done"})).await;
    let r = c.put(&format!("/tickets/{tid}/pending"), json!({"reason_type": "party", "party": "X"})).await;
    assert_eq!(r.status, 422);
}

#[tokio::test]
async fn test_reopen_reason_is_limited_and_parent_can_be_reopened() {
    if !skip_unless_available("test_reopen_reason_is_limited_and_parent_can_be_reopened") {
        return;
    }
    let s = Server::start().await;
    let c = s.client();
    let project = _create_project(&c, "TST").await;
    let parent = _create_ticket(&c, &id(&project), "P", json!({})).await;
    let child = _create_ticket(&c, &id(&project), "C", json!({"parent_id": parent["id"]})).await;
    c.patch(&format!("/tickets/{}/status", id(&child)), json!({"status": "done"})).await;
    c.patch(&format!("/tickets/{}/status", id(&parent)), json!({"status": "done"})).await;

    let r = c.post(&format!("/tickets/{}/reopen", id(&child)), json!({"reason": "x".repeat(241)})).await;
    assert_eq!(r.status, 400);

    let r = c.post(&format!("/tickets/{}/reopen", id(&child)), json!({"reason": "again", "reopen_parent": true})).await;
    assert_eq!(r.status, 200);
    let p = c.get(&format!("/tickets/{}", id(&parent))).await.json();
    assert!(p["status"] == "todo" && p["reopen_count"] == 1);
}

#[tokio::test]
async fn test_undo_reopen_restores_status_count_and_history() {
    if !skip_unless_available("test_undo_reopen_restores_status_count_and_history") {
        return;
    }
    let s = Server::start().await;
    let c = s.client();
    let project = _create_project(&c, "TST").await;
    let t = _create_ticket(&c, &id(&project), "A", json!({})).await;
    let tid = id(&t);
    c.patch(&format!("/tickets/{tid}/status"), json!({"status": "done"})).await;
    let done = c.get(&format!("/tickets/{tid}")).await.json();
    assert!(!done["completed_at"].as_str().expect("completed_at").is_empty());

    c.post(&format!("/tickets/{tid}/reopen"), json!({"reason": "r"})).await;
    let r = c.post_empty(&format!("/tickets/{tid}/reopen/undo")).await;
    assert_eq!(r.status, 200);
    let undone = r.json();
    assert_eq!(undone["status"], "done");
    assert!(undone["reopen_count"] == 0 && undone["reopen_history"] == json!([]));
    assert_eq!(undone["completed_at"], done["completed_at"]);
    assert!(!log_has(&undone, |e| e["field"] == "reopen"));

    // nothing left to undo
    assert_eq!(c.post_empty(&format!("/tickets/{tid}/reopen/undo")).await.status, 409);
}

#[tokio::test]
async fn test_reopen_and_resume_write_marker_activity_with_details() {
    if !skip_unless_available("test_reopen_and_resume_write_marker_activity_with_details") {
        return;
    }
    let s = Server::start().await;
    let c = s.client();
    let project = _create_project(&c, "TST").await;
    let blocker = _create_ticket(&c, &id(&project), "B", json!({})).await;
    let t = _create_ticket(&c, &id(&project), "A", json!({})).await;
    let tid = id(&t);
    c.put(
        &format!("/tickets/{tid}/pending"),
        json!({"reason_type": "ticket", "ticket_id": blocker["id"], "add_blocked_by": true}),
    )
    .await;
    // the blocker finishing writes a system prompt on the waiting ticket; the flag stays
    c.patch(&format!("/tickets/{}/status", id(&blocker)), json!({"status": "done"})).await;
    let waiting = c.get(&format!("/tickets/{tid}")).await.json();
    assert_eq!(waiting["pending"], true);
    let prompt: Vec<&Value> = waiting["activity_log"]
        .as_array()
        .expect("activity_log")
        .iter()
        .filter(|e| e["field"] == "pending_prompt")
        .collect();
    assert!(!prompt.is_empty() && prompt[0]["cause"] == "blocker_done" && prompt[0]["actor"] == "system");

    let resumed = c.post(&format!("/tickets/{tid}/resume"), json!({"reason": "ok"})).await.json();
    let cleared = resumed["activity_log"]
        .as_array()
        .expect("activity_log")
        .iter()
        .find(|e| e["field"] == "pending_cleared")
        .expect("a pending_cleared entry")
        .clone();
    assert_eq!(cleared["was_waiting_on"]["target_id"], blocker["id"]);
    assert_eq!(cleared["duration_days"], 0);
}
