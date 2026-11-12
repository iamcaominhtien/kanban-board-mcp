//! `tests/test_tickets.py`, the tests of the ticket itself: create, read, list, search, update, move, delete, and
//! the two that go through the member and workspace routes. The tests of comments, acceptance criteria, sub-tasks,
//! the work log, test cases, branches, reopen and pending are ported with those routes.

mod common;

use common::{id, new_ticket};
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
