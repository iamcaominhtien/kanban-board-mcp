//! `tests/test_mcp_tools.py`, the tests of the project operations. The Python tests call the operation functions;
//! here each goes through the tool that routes to the operation (`get_projects`, `manage_project`), over the
//! protocol.
//!
//! The ticket tests go through `manage_ticket`, `list_tickets`, `get_ticket` and `ticket_items`; the SSE tests read
//! `GET /events` instead of patching `events.publish`.

mod common;

use std::time::Duration;

use common::{call, call_err};
use serde_json::{Value, json};
use testkit::Mcp;

/// `_seed_project`: `ops.create_project(name=name, prefix=prefix, color="#aabbcc")`.
async fn seed_project(mcp: &Mcp, name: &str, prefix: &str) -> Value {
    call(mcp, "manage_project", json!({"action": "create", "name": name, "prefix": prefix, "color": "#aabbcc"})).await
}

// ---------------------------------------------------------------------------
// list_projects
// ---------------------------------------------------------------------------

#[tokio::test]
async fn test_list_projects_returns_list() {
    let s = common::start().await;
    let result = call(&s.mcp(), "get_projects", json!({})).await;
    assert!(result.is_array(), "{result}");
}

#[tokio::test]
async fn test_list_projects_shows_created_project() {
    let s = common::start().await;
    let mcp = s.mcp();
    seed_project(&mcp, "Alpha", "ALPHA").await;
    let result = call(&mcp, "get_projects", json!({})).await;
    assert!(result.as_array().expect("a list").iter().any(|p| p["prefix"] == "ALPHA"), "{result}");
}

// ---------------------------------------------------------------------------
// create_project
// ---------------------------------------------------------------------------

#[tokio::test]
async fn test_create_project_returns_correct_fields() {
    let s = common::start().await;
    let result = call(
        &s.mcp(),
        "manage_project",
        json!({"action": "create", "name": "My App", "prefix": "MYAPP", "color": "#ff0000"}),
    )
    .await;
    assert_eq!(result["name"], "My App");
    assert_eq!(result["prefix"], "MYAPP");
    assert_eq!(result["color"], "#ff0000");
    assert!(result.get("id").is_some());
    assert_eq!(result["ticket_counter"], 0);
}

#[tokio::test]
async fn test_create_project_uppercases_prefix() {
    let s = common::start().await;
    let result = call(&s.mcp(), "manage_project", json!({"action": "create", "name": "Lower", "prefix": "low"})).await;
    assert_eq!(result["prefix"], "LOW");
    // the default of the operation's `color`
    assert_eq!(result["color"], "#6366f1");
}

/// `ops.create_ticket(project_id=..., title=..., **fields)`: `manage_ticket(action='create')`.
async fn create_ticket(mcp: &Mcp, project_id: &Value, title: &str, extra: Value) -> Value {
    let mut arguments = json!({"action": "create", "project_id": project_id, "title": title});
    for (key, value) in extra.as_object().expect("an object") {
        arguments[key] = value.clone();
    }
    call(mcp, "manage_ticket", arguments).await
}

/// `ops.update_ticket(ticket_id, **fields)`: `manage_ticket(action='update')`.
async fn update_ticket(mcp: &Mcp, ticket_id: &Value, extra: Value) -> Value {
    call(mcp, "manage_ticket", update_arguments(ticket_id, extra)).await
}

fn update_arguments(ticket_id: &Value, extra: Value) -> Value {
    let mut arguments = json!({"action": "update", "ticket_id": ticket_id});
    for (key, value) in extra.as_object().expect("an object") {
        arguments[key] = value.clone();
    }
    arguments
}

/// `ops.add_comment(ticket_id, text=..., author=...)`: `ticket_items(item='comment')`.
async fn add_comment(mcp: &Mcp, ticket_id: &Value, text: &str, author: &str) -> Value {
    call(mcp, "ticket_items", json!({"ticket_id": ticket_id, "item": "comment", "action": "add", "text": text, "author": author}))
        .await
}

/// The text of a refusal when a call must fail with a "not found" message.
async fn not_found(mcp: &Mcp, tool: &str, arguments: Value) {
    let text = call_err(mcp, tool, arguments).await;
    assert!(text.contains("not found"), "{text}");
}

// ---------------------------------------------------------------------------
// list_tickets & create_ticket
// ---------------------------------------------------------------------------

#[tokio::test]
async fn test_create_ticket_appears_in_list_tickets() {
    let s = common::start().await;
    let mcp = s.mcp();
    let project = seed_project(&mcp, "Test", "LTST").await;
    let ticket = create_ticket(&mcp, &project["id"], "My first ticket", json!({"type": "task", "priority": "high"})).await;
    assert_eq!(ticket["title"], "My first ticket");
    assert!(ticket["id"].as_str().expect("an id").starts_with("LTST-"));

    let listing = call(&mcp, "list_tickets", json!({"project_id": project["id"]})).await;
    assert!(listing["total"] == 1 && listing["count"] == 1 && listing["has_more"] == false, "{listing}");
    assert!(listing["tickets"].as_array().expect("tickets").iter().any(|t| t["id"] == ticket["id"]));
}

#[tokio::test]
async fn test_list_tickets_filter_by_status() {
    let s = common::start().await;
    let mcp = s.mcp();
    let project = seed_project(&mcp, "Test", "FILT").await;
    create_ticket(&mcp, &project["id"], "In progress ticket", json!({"status": "in-progress"})).await;
    create_ticket(&mcp, &project["id"], "Backlog ticket", json!({"status": "backlog"})).await;

    let listing = call(&mcp, "list_tickets", json!({"project_id": project["id"], "status": "in-progress"})).await;
    let in_progress = listing["tickets"].as_array().expect("tickets");
    assert!(in_progress.iter().all(|t| t["status"] == "in-progress"));
    assert_eq!(in_progress.len(), 1);
}

// ---------------------------------------------------------------------------
// get_ticket
// ---------------------------------------------------------------------------

#[tokio::test]
async fn test_get_ticket_returns_ticket() {
    let s = common::start().await;
    let mcp = s.mcp();
    let project = seed_project(&mcp, "Test", "GETK").await;
    let ticket = create_ticket(&mcp, &project["id"], "Fetch me", json!({})).await;
    let result = call(&mcp, "get_ticket", json!({"ticket_id": ticket["id"]})).await;
    assert_eq!(result["id"], ticket["id"]);
    assert_eq!(result["title"], "Fetch me");
}

#[tokio::test]
async fn test_get_ticket_points_an_outside_agent_to_the_shared_guides() {
    // issue #277: a live outside agent skipped the instructions' mention twice; it reads what a tool returns
    let s = common::start().await;
    let mcp = s.mcp();
    let project = seed_project(&mcp, "Test", "GETG").await;
    let ticket = create_ticket(&mcp, &project["id"], "Guides", json!({})).await;
    let result = call(&mcp, "get_ticket", json!({"ticket_id": ticket["id"]})).await;
    assert!(result["how_to_work"].as_str().expect("how_to_work").contains("docs_read(action='guides')"));
}

#[tokio::test]
async fn test_get_ticket_lists_uploaded_files_with_absolute_paths() {
    let s = common::start().await;
    let mcp = s.mcp();
    let project = seed_project(&mcp, "Test", "GETF").await;
    let ticket = create_ticket(
        &mcp,
        &project["id"],
        "With files",
        json!({"description": "Look: ![shot](/uploads/shot.png) and [spec](/uploads/spec.pdf)"}),
    )
    .await;
    let result = call(&mcp, "get_ticket", json!({"ticket_id": ticket["id"]})).await;
    let files: std::collections::BTreeMap<String, &Value> = result["files"]
        .as_array()
        .expect("files")
        .iter()
        .map(|f| (f["url"].as_str().expect("a url").to_string(), f))
        .collect();
    assert_eq!(files.keys().map(String::as_str).collect::<Vec<_>>(), ["/uploads/shot.png", "/uploads/spec.pdf"]);
    let shot = files["/uploads/shot.png"]["path"].as_str().expect("a path");
    assert!(shot.starts_with('/') && shot.ends_with("shot.png"), "{shot}");
    let plain = create_ticket(&mcp, &project["id"], "No files", json!({})).await;
    let plain = call(&mcp, "get_ticket", json!({"ticket_id": plain["id"]})).await;
    assert!(plain.get("files").is_none());
}

#[tokio::test]
async fn test_get_ticket_raises_for_missing_id() {
    let s = common::start().await;
    not_found(&s.mcp(), "get_ticket", json!({"ticket_id": "MISSING-9999"})).await;
}

// ---------------------------------------------------------------------------
// update_ticket_status
// ---------------------------------------------------------------------------

#[tokio::test]
async fn test_update_ticket_status_changes_status() {
    let s = common::start().await;
    let mcp = s.mcp();
    let project = seed_project(&mcp, "Test", "UPD").await;
    let ticket = create_ticket(&mcp, &project["id"], "Status test", json!({"status": "backlog"})).await;

    let updated = update_ticket(&mcp, &ticket["id"], json!({"status": "done"})).await;
    assert_eq!(updated["status"], "done");

    let fetched = call(&mcp, "get_ticket", json!({"ticket_id": ticket["id"]})).await;
    assert_eq!(fetched["status"], "done");
}

#[tokio::test]
async fn test_update_ticket_status_raises_for_missing() {
    let s = common::start().await;
    not_found(&s.mcp(), "manage_ticket", update_arguments(&json!("MISSING-0"), json!({"status": "done"}))).await;
}

// ---------------------------------------------------------------------------
// create_ticket: unknown project
// ---------------------------------------------------------------------------

#[tokio::test]
async fn test_create_ticket_unknown_project_raises() {
    let s = common::start().await;
    let text = call_err(
        &s.mcp(),
        "manage_ticket",
        json!({"action": "create", "project_id": "9b1e6a6e-6a3c-4a3c-8f55-2f3d5c8f9a10", "title": "x"}),
    )
    .await;
    assert!(text.contains("Project not found"), "{text}");
}

// ---------------------------------------------------------------------------
// list_tickets: wildcard escaping
// ---------------------------------------------------------------------------

#[tokio::test]
async fn test_list_tickets_percent_is_literal_not_wildcard() {
    // q='%' should only match tickets whose title contains '%', not all tickets.
    let s = common::start().await;
    let mcp = s.mcp();
    let project = seed_project(&mcp, "Test", "PCT").await;
    create_ticket(&mcp, &project["id"], "50% done", json!({})).await;
    create_ticket(&mcp, &project["id"], "no percent here", json!({})).await;

    let listing = call(&mcp, "list_tickets", json!({"project_id": project["id"], "q": "%"})).await;
    let results = listing["tickets"].as_array().expect("tickets");
    assert_eq!(results.len(), 1);
    assert!(results[0]["title"].as_str().expect("a title").contains('%'));
}

// ---------------------------------------------------------------------------
// update_ticket
// ---------------------------------------------------------------------------

#[tokio::test]
async fn test_update_ticket_title() {
    let s = common::start().await;
    let mcp = s.mcp();
    let project = seed_project(&mcp, "Test", "UTT").await;
    let ticket = create_ticket(&mcp, &project["id"], "Old Title", json!({})).await;
    let updated = update_ticket(&mcp, &ticket["id"], json!({"title": "New Title"})).await;
    assert_eq!(updated["title"], "New Title");
}

#[tokio::test]
async fn test_update_ticket_unknown_id_raises() {
    let s = common::start().await;
    not_found(&s.mcp(), "manage_ticket", update_arguments(&json!("MISSING-0"), json!({"title": "x"}))).await;
}

// ---------------------------------------------------------------------------
// add_comment
// ---------------------------------------------------------------------------

#[tokio::test]
async fn test_add_comment() {
    let s = common::start().await;
    let mcp = s.mcp();
    let project = seed_project(&mcp, "Test", "CMT").await;
    let ticket = create_ticket(&mcp, &project["id"], "Commentable", json!({})).await;
    let result = add_comment(&mcp, &ticket["id"], "Hello world", "alice").await;
    assert!(
        result["comments"]
            .as_array()
            .expect("comments")
            .iter()
            .any(|c| c["text"] == "Hello world" && c["author"] == "alice"),
        "{result}"
    );
}

#[tokio::test]
async fn test_add_comment_unknown_ticket_raises() {
    let s = common::start().await;
    not_found(
        &s.mcp(),
        "ticket_items",
        json!({"ticket_id": "MISSING-0", "item": "comment", "action": "add", "text": "hi", "author": "bob"}),
    )
    .await;
}

// ---------------------------------------------------------------------------
// update_comment
// ---------------------------------------------------------------------------

#[tokio::test]
async fn test_update_comment() {
    let s = common::start().await;
    let mcp = s.mcp();
    let project = seed_project(&mcp, "Test", "UCM").await;
    let ticket = create_ticket(&mcp, &project["id"], "Commentable", json!({})).await;
    let added = add_comment(&mcp, &ticket["id"], "Hello world", "alice").await;
    let comment_id = added["comments"][0]["id"].clone();

    let result = call(
        &mcp,
        "ticket_items",
        json!({"ticket_id": ticket["id"], "item": "comment", "action": "update", "item_id": comment_id, "text": "**Edited** message"}),
    )
    .await;
    let updated = result["comments"].as_array().expect("comments").iter().find(|c| c["id"] == comment_id).expect("found");
    assert_eq!(updated["text"], "**Edited** message");
    assert_eq!(updated["author"], "alice");
}

#[tokio::test]
async fn test_update_comment_unknown_ticket_raises() {
    let s = common::start().await;
    not_found(
        &s.mcp(),
        "ticket_items",
        json!({"ticket_id": "MISSING-0", "item": "comment", "action": "update", "item_id": "some-id", "text": "hi"}),
    )
    .await;
}

#[tokio::test]
async fn test_update_comment_unknown_comment_raises() {
    let s = common::start().await;
    let mcp = s.mcp();
    let project = seed_project(&mcp, "Test", "UCM2").await;
    let ticket = create_ticket(&mcp, &project["id"], "Commentable", json!({})).await;
    not_found(
        &mcp,
        "ticket_items",
        json!({"ticket_id": ticket["id"], "item": "comment", "action": "update", "item_id": "missing-comment", "text": "hi"}),
    )
    .await;
}

// ---------------------------------------------------------------------------
// delete_comment
// ---------------------------------------------------------------------------

#[tokio::test]
async fn test_delete_comment() {
    let s = common::start().await;
    let mcp = s.mcp();
    let project = seed_project(&mcp, "Test", "DCM").await;
    let ticket = create_ticket(&mcp, &project["id"], "Commentable", json!({})).await;
    let added = add_comment(&mcp, &ticket["id"], "Hello world", "alice").await;
    let comment_id = added["comments"][0]["id"].clone();

    let result = call(
        &mcp,
        "ticket_items",
        json!({"ticket_id": ticket["id"], "item": "comment", "action": "delete", "item_id": comment_id}),
    )
    .await;
    assert_eq!(result["comments"], json!([]));
}

#[tokio::test]
async fn test_list_and_restore_comment() {
    let s = common::start().await;
    let mcp = s.mcp();
    let project = seed_project(&mcp, "Test", "LCM").await;
    let ticket = create_ticket(&mcp, &project["id"], "Thread", json!({})).await;
    let first = add_comment(&mcp, &ticket["id"], "One", "alice").await;
    add_comment(&mcp, &ticket["id"], "Two", "bob").await;
    let cid = first["comments"][0]["id"].clone();
    let listed = call(&mcp, "get_ticket", json!({"ticket_id": ticket["id"], "view": "comments"})).await;
    let texts = |listed: &Value| -> Vec<Value> {
        listed["comments"].as_array().expect("comments").iter().map(|c| c["text"].clone()).collect()
    };
    assert!(listed["count"] == 2 && texts(&listed) == [json!("One"), json!("Two")], "{listed}");
    call(&mcp, "ticket_items", json!({"ticket_id": ticket["id"], "item": "comment", "action": "delete", "item_id": cid})).await;
    let after = call(&mcp, "get_ticket", json!({"ticket_id": ticket["id"], "view": "comments"})).await;
    assert_eq!(after["count"], 1);
    let back = call(&mcp, "ticket_items", json!({"ticket_id": ticket["id"], "item": "comment", "action": "restore", "item_id": cid}))
        .await;
    let restored: Vec<Value> = back["comments"].as_array().expect("comments").iter().map(|c| c["text"].clone()).collect();
    assert_eq!(restored, [json!("One"), json!("Two")]);
}

#[tokio::test]
async fn test_delete_comment_unknown_ticket_raises() {
    let s = common::start().await;
    not_found(
        &s.mcp(),
        "ticket_items",
        json!({"ticket_id": "MISSING-0", "item": "comment", "action": "delete", "item_id": "some-id"}),
    )
    .await;
}

// ---------------------------------------------------------------------------
// add_work_log
// ---------------------------------------------------------------------------

#[tokio::test]
async fn test_add_work_log() {
    let s = common::start().await;
    let mcp = s.mcp();
    let project = seed_project(&mcp, "Test", "WLG").await;
    let ticket = create_ticket(&mcp, &project["id"], "Work log test", json!({})).await;
    let result = call(
        &mcp,
        "ticket_items",
        json!({"ticket_id": ticket["id"], "item": "work_log", "action": "add", "author": "dev", "role": "Developer", "note": "Implemented feature X"}),
    )
    .await;
    assert!(
        result["work_log"].as_array().expect("work_log").iter().any(|w| w["author"] == "dev" && w["note"] == "Implemented feature X"),
        "{result}"
    );
}

#[tokio::test]
async fn test_add_work_log_unknown_ticket_raises() {
    let s = common::start().await;
    not_found(
        &s.mcp(),
        "ticket_items",
        json!({"ticket_id": "MISSING-0", "item": "work_log", "action": "add", "author": "x", "role": "Other", "note": "n"}),
    )
    .await;
}

// ---------------------------------------------------------------------------
// add_test_case
// ---------------------------------------------------------------------------

#[tokio::test]
async fn test_add_test_case() {
    let s = common::start().await;
    let mcp = s.mcp();
    let project = seed_project(&mcp, "Test", "TCX").await;
    let ticket = create_ticket(&mcp, &project["id"], "Test case ticket", json!({})).await;
    let result = call(
        &mcp,
        "ticket_items",
        json!({"ticket_id": ticket["id"], "item": "test_case", "action": "add", "title": "Login works", "status": "pending"}),
    )
    .await;
    assert!(
        result["test_cases"].as_array().expect("test_cases").iter().any(|tc| tc["title"] == "Login works" && tc["status"] == "pending"),
        "{result}"
    );
}

#[tokio::test]
async fn test_add_test_case_unknown_ticket_raises() {
    let s = common::start().await;
    not_found(
        &s.mcp(),
        "ticket_items",
        json!({"ticket_id": "MISSING-0", "item": "test_case", "action": "add", "title": "x"}),
    )
    .await;
}

// ---------------------------------------------------------------------------
// update_test_case
// ---------------------------------------------------------------------------

#[tokio::test]
async fn test_update_test_case_status() {
    let s = common::start().await;
    let mcp = s.mcp();
    let project = seed_project(&mcp, "Test", "UTC").await;
    let ticket = create_ticket(&mcp, &project["id"], "TC update", json!({})).await;
    let with_tc = call(
        &mcp,
        "ticket_items",
        json!({"ticket_id": ticket["id"], "item": "test_case", "action": "add", "title": "Should pass"}),
    )
    .await;
    let tc_id = with_tc["test_cases"][0]["id"].clone();
    let updated = call(
        &mcp,
        "ticket_items",
        json!({"ticket_id": ticket["id"], "item": "test_case", "action": "update", "item_id": tc_id, "status": "pass", "proof": "screenshot.png"}),
    )
    .await;
    let tc = updated["test_cases"].as_array().expect("test_cases").iter().find(|tc| tc["id"] == tc_id).expect("found");
    assert_eq!(tc["status"], "pass");
    assert_eq!(tc["proof"], "screenshot.png");
}

#[tokio::test]
async fn test_update_test_case_unknown_ticket_raises() {
    let s = common::start().await;
    not_found(
        &s.mcp(),
        "ticket_items",
        json!({"ticket_id": "MISSING-0", "item": "test_case", "action": "update", "item_id": "fake-id", "status": "pass"}),
    )
    .await;
}

// ---------------------------------------------------------------------------
// create_child_ticket
// ---------------------------------------------------------------------------

#[tokio::test]
async fn test_create_child_ticket() {
    let s = common::start().await;
    let mcp = s.mcp();
    let project = seed_project(&mcp, "Test", "CHD").await;
    let parent = create_ticket(&mcp, &project["id"], "Parent ticket", json!({})).await;
    let child = create_ticket(&mcp, &project["id"], "Child ticket", json!({"type": "task", "parent_id": parent["id"]})).await;
    assert_eq!(child["parent_id"], parent["id"]);
    assert_eq!(child["title"], "Child ticket");
}

#[tokio::test]
async fn test_create_child_ticket_unknown_parent_raises() {
    // `ops.create_child_ticket` has no tool: `manage_ticket(action='create', parent_id=...)` is the way to a
    // sub-ticket, and the service refuses a parent that does not exist
    let s = common::start().await;
    let mcp = s.mcp();
    let project = seed_project(&mcp, "Test", "ORPH").await;
    let text = call_err(
        &mcp,
        "manage_ticket",
        json!({"action": "create", "project_id": project["id"], "title": "orphan", "parent_id": "MISSING-9999"}),
    )
    .await;
    assert!(text.contains("not found"), "{text}");
}

#[tokio::test]
async fn test_create_child_ticket_depth_violation_raises() {
    let s = common::start().await;
    let mcp = s.mcp();
    let project = seed_project(&mcp, "Test", "DEEP").await;
    let parent = create_ticket(&mcp, &project["id"], "Parent", json!({})).await;
    let child = create_ticket(&mcp, &project["id"], "Child", json!({"parent_id": parent["id"]})).await;
    let text = call_err(
        &mcp,
        "manage_ticket",
        json!({"action": "create", "project_id": project["id"], "title": "Grandchild", "parent_id": child["id"]}),
    )
    .await;
    assert!(text.contains("1 level"), "{text}");
}

// ---------------------------------------------------------------------------
// update_test_case: unknown test_case_id
// ---------------------------------------------------------------------------

#[tokio::test]
async fn test_update_test_case_unknown_id_raises() {
    let s = common::start().await;
    let mcp = s.mcp();
    let project = seed_project(&mcp, "Test", "UTCU").await;
    let ticket = create_ticket(&mcp, &project["id"], "TC unknown id", json!({})).await;
    not_found(
        &mcp,
        "ticket_items",
        json!({"ticket_id": ticket["id"], "item": "test_case", "action": "update", "item_id": "3f6d0a52-86a1-4c36-a7e9-0d0f2f6a2c11", "status": "pass"}),
    )
    .await;
}

// --- SSE publish tests: `events.publish("invalidate")` is what `GET /events` sends ---

/// What the Python tests do with a mock of `events.publish`: the call announces a change exactly once.
async fn publishes_once(s: &testkit::Server, tool: &str, arguments: Value) -> Value {
    let mut events = s.events().await;
    let result = call(&s.mcp(), tool, arguments).await;
    assert_eq!(events.next(Duration::from_secs(5)).await.as_deref(), Some("invalidate"));
    assert_eq!(events.next(Duration::from_millis(500)).await, None, "published more than once");
    result
}

#[tokio::test]
async fn test_update_ticket_description_publishes_sse() {
    let s = common::start().await;
    let mcp = s.mcp();
    let project = seed_project(&mcp, "Test", "SSE1").await;
    let ticket = create_ticket(&mcp, &project["id"], "SSE ticket", json!({})).await;
    publishes_once(&s, "manage_ticket", update_arguments(&ticket["id"], json!({"description": "Updated desc"}))).await;
}

#[tokio::test]
async fn test_add_acceptance_criterion_publishes_sse() {
    let s = common::start().await;
    let mcp = s.mcp();
    let project = seed_project(&mcp, "Test", "SSE2").await;
    let ticket = create_ticket(&mcp, &project["id"], "AC ticket", json!({})).await;
    publishes_once(
        &s,
        "ticket_items",
        json!({"ticket_id": ticket["id"], "item": "criterion", "action": "add", "text": "Must work"}),
    )
    .await;
}

#[tokio::test]
async fn test_add_test_case_publishes_sse() {
    let s = common::start().await;
    let mcp = s.mcp();
    let project = seed_project(&mcp, "Test", "SSE3").await;
    let ticket = create_ticket(&mcp, &project["id"], "TC ticket", json!({})).await;
    publishes_once(
        &s,
        "ticket_items",
        json!({"ticket_id": ticket["id"], "item": "test_case", "action": "add", "title": "Login works"}),
    )
    .await;
}

#[tokio::test]
async fn test_add_work_log_publishes_sse() {
    let s = common::start().await;
    let mcp = s.mcp();
    let project = seed_project(&mcp, "Test", "SSE4").await;
    let ticket = create_ticket(&mcp, &project["id"], "WL ticket", json!({})).await;
    publishes_once(
        &s,
        "ticket_items",
        json!({"ticket_id": ticket["id"], "item": "work_log", "action": "add", "author": "dev", "role": "Developer", "note": "Did the thing"}),
    )
    .await;
}

#[tokio::test]
async fn test_add_comment_publishes_sse() {
    let s = common::start().await;
    let mcp = s.mcp();
    let project = seed_project(&mcp, "Test", "SSE5").await;
    let ticket = create_ticket(&mcp, &project["id"], "Cmt ticket", json!({})).await;
    publishes_once(
        &s,
        "ticket_items",
        json!({"ticket_id": ticket["id"], "item": "comment", "action": "add", "text": "Nice work", "author": "alice"}),
    )
    .await;
}

#[tokio::test]
async fn test_update_ticket_nonexistent_does_not_publish_sse() {
    let s = common::start().await;
    let mut events = s.events().await;
    not_found(&s.mcp(), "manage_ticket", update_arguments(&json!("MISSING-9999"), json!({"description": "ghost"}))).await;
    assert_eq!(events.next(Duration::from_millis(800)).await, None);
}

#[tokio::test]
async fn test_story_ticket_can_have_sub_tickets() {
    // Story > ticket > sub-ticket is allowed; a fourth level, or a non-Story third level, is not.
    let s = common::start().await;
    let mcp = s.mcp();
    let project = seed_project(&mcp, "Test", "STY3").await;
    let story = create_ticket(&mcp, &project["id"], "Story", json!({"type": "story"})).await;
    let ticket = create_ticket(&mcp, &project["id"], "Ticket under the story", json!({"parent_id": story["id"]})).await;
    let sub = create_ticket(&mcp, &project["id"], "Sub-ticket of the ticket", json!({"parent_id": ticket["id"]})).await;
    assert_eq!(sub["parent_id"], ticket["id"]);
    let text = call_err(
        &mcp,
        "manage_ticket",
        json!({"action": "create", "project_id": project["id"], "title": "Too deep", "parent_id": sub["id"]}),
    )
    .await;
    assert!(text.contains("1 level"), "{text}");
}

#[tokio::test]
async fn test_story_nesting_on_update_respects_depth() {
    let s = common::start().await;
    let mcp = s.mcp();
    let project = seed_project(&mcp, "Test", "STY4").await;
    let story = create_ticket(&mcp, &project["id"], "Story", json!({"type": "story"})).await;
    let ticket = create_ticket(&mcp, &project["id"], "T", json!({"parent_id": story["id"]})).await;
    let sub = create_ticket(&mcp, &project["id"], "S", json!({"parent_id": ticket["id"]})).await;
    let other = create_ticket(&mcp, &project["id"], "Other", json!({"parent_id": story["id"]})).await;
    // a ticket with its own sub-ticket cannot move under another ticket (it would be 3 deep)
    let text = call_err(&mcp, "manage_ticket", update_arguments(&ticket["id"], json!({"parent_id": other["id"]}))).await;
    assert!(text.contains("1 level"), "{text}");
    // a plain ticket can still become a sub-ticket of a ticket under the story
    let moved = update_ticket(&mcp, &other["id"], json!({"parent_id": ticket["id"]})).await;
    assert_eq!(moved["parent_id"], ticket["id"]);
    assert_eq!(sub["parent_id"], ticket["id"]);
}
