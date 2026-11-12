//! `tests/test_mcp_tool_routing.py`, the tests of the project tools and of the routing itself: every action is
//! reached through `tools/call` (so the published schema is what is validated), with the parameter checks and
//! fix-it errors the tool descriptions promise.
//!
//! Where a Python test also used a ticket tool, the ticket is made and changed through the REST API here, and a
//! check that needs a tool the server does not list yet is skipped (`common::tools`): it runs from the day the tool
//! is ported. See the list at the end of this file for what is not ported.

mod common;

use common::{call, call_err, tools};
use serde_json::{Value, json};
use testkit::Mcp;

async fn project(mcp: &Mcp, prefix: &str) -> Value {
    call(mcp, "manage_project", json!({"action": "create", "name": "Facade", "prefix": prefix})).await
}

/// `_ticket(project, **fields)`: `manage_ticket(action='create')`.
async fn ticket(mcp: &Mcp, project: &Value, fields: Value) -> Value {
    let mut arguments = json!({"action": "create", "project_id": project["id"], "title": "T"});
    for (key, value) in fields.as_object().expect("an object") {
        arguments[key] = value.clone();
    }
    call(mcp, "manage_ticket", arguments).await
}

/// `ticket_items(ticket_id=..., item=..., **rest)`.
async fn items(mcp: &Mcp, ticket_id: &Value, item: &str, rest: Value) -> Value {
    call(mcp, "ticket_items", items_arguments(ticket_id, item, rest)).await
}

fn items_arguments(ticket_id: &Value, item: &str, rest: Value) -> Value {
    let mut arguments = json!({"ticket_id": ticket_id, "item": item});
    for (key, value) in rest.as_object().expect("an object") {
        arguments[key] = value.clone();
    }
    arguments
}

fn ids(list: &Value) -> Vec<String> {
    list.as_array().expect("a list").iter().map(|x| x["id"].as_str().expect("an id").to_string()).collect()
}

// --------------------------------------------------------------------------- projects and members

#[tokio::test]
async fn test_projects_and_members() {
    let s = common::start().await;
    let (mcp, c) = (s.mcp(), s.client());
    let p = project(&mcp, "FAC").await;
    let pid = p["id"].as_str().expect("an id");
    assert_eq!(p["prefix"], "FAC");
    assert_eq!(ids(&call(&mcp, "get_projects", json!({})).await), [pid]);

    let updated = call(&mcp, "manage_project", json!({"action": "update", "project_id": pid, "name": "Renamed"})).await;
    assert_eq!(updated["name"], "Renamed");

    let member = call(&mcp, "manage_project", json!({"action": "add_member", "project_id": pid, "name": "Bao"})).await;
    let member_id = member["id"].as_str().expect("an id");
    let detail = call(&mcp, "get_projects", json!({"project_id": pid})).await;
    assert_eq!(detail["name"], "Renamed");
    assert!(ids(&detail["members"]).contains(&member_id.to_string()));

    // (the ticket is made through the REST API: `manage_ticket` is ported with the ticket tools)
    let ticket = c.post(&format!("/projects/{pid}/tickets"), json!({"title": "T", "assignee": member_id})).await;
    ticket.assert_status(201);
    let ticket = ticket.json();
    assert_eq!(ticket["assignee"], member_id);
    let remove = json!({"action": "remove_member", "project_id": pid, "member_id": member_id});
    let refused = call_err(&mcp, "manage_project", remove.clone()).await;
    assert!(refused.contains("Reassign first"), "{refused}");
    let ticket_id = ticket["id"].as_str().expect("a ticket id");
    c.patch(&format!("/tickets/{ticket_id}"), json!({"assignee": null})).await.assert_status(200);
    let removed = call(&mcp, "manage_project", remove).await;
    assert_eq!(removed, json!({"ok": true}));
    let after = call(&mcp, "get_projects", json!({"project_id": pid})).await;
    assert!(!ids(&after["members"]).contains(&member_id.to_string()));
}

#[tokio::test]
async fn test_get_projects_unknown_id_lists_the_real_ones() {
    let s = common::start().await;
    let mcp = s.mcp();
    let p = project(&mcp, "FAC").await;
    let refused = call_err(&mcp, "get_projects", json!({"project_id": "nope"})).await;
    assert!(refused.contains(p["id"].as_str().expect("an id")), "{refused}");
}

// --------------------------------------------------------------------------- the routing

#[tokio::test]
async fn test_missing_and_foreign_parameters_name_the_action_and_what_it_takes() {
    let s = common::start().await;
    let mcp = s.mcp();
    let refused = call_err(&mcp, "manage_project", json!({"action": "create", "name": "x"})).await;
    let (label, missing) = (refused.find("manage_project(action='create')"), refused.find("Missing: prefix"));
    assert!(label.is_some() && missing.is_some() && label < missing, "{refused}");
    let refused = call_err(
        &mcp,
        "manage_project",
        json!({"action": "add_member", "project_id": "p", "name": "x", "repo_path": "/tmp"}),
    )
    .await;
    assert!(refused.contains("does not use: repo_path"), "{refused}");
    if tools(&mcp).await.contains_key("docs_read") {
        let refused = call_err(&mcp, "docs_read", json!({"action": "search"})).await;
        assert!(refused.contains("requires project_id, query; optional: scope, limit"), "{refused}");
    }
}

#[tokio::test]
async fn test_an_unknown_action_is_rejected_by_the_schema() {
    let s = common::start().await;
    let mcp = s.mcp();
    let listed = tools(&mcp).await;
    if listed.contains_key("manage_ticket") {
        call_err(&mcp, "manage_ticket", json!({"action": "explode", "ticket_id": "X-1"})).await;
    }
    // the same for the tool that is always there
    let refused = call_err(&mcp, "manage_project", json!({"action": "explode", "project_id": "x"})).await;
    assert!(refused.contains("Input should be 'create', 'update', 'add_member' or 'remove_member'"), "{refused}");
}

#[tokio::test]
async fn test_a_misspelt_parameter_is_an_error_not_silently_ignored() {
    let s = common::start().await;
    let mcp = s.mcp();
    let p = project(&mcp, "FAC").await;
    let pid = p["id"].as_str().expect("an id");
    let refused =
        call_err(&mcp, "manage_project", json!({"action": "update", "project_id": pid, "naem": "typo"})).await;
    assert!(refused.contains("Extra inputs are not permitted"), "{refused}");
    assert_eq!(call(&mcp, "get_projects", json!({"project_id": pid})).await["name"], "Facade");
    let t = ticket(&mcp, &p, json!({})).await;
    let refused =
        call_err(&mcp, "manage_ticket", json!({"action": "update", "ticket_id": t["id"], "titel": "typo"})).await;
    assert!(refused.contains("Extra inputs are not permitted"), "{refused}");
    let listed = tools(&mcp).await;
    if listed.contains_key("list_tickets") {
        let refused = call_err(&mcp, "list_tickets", json!({"project_id": pid, "statuss": "done"})).await;
        assert!(refused.contains("Extra inputs are not permitted"), "{refused}");
    }
    assert_eq!(call(&mcp, "get_ticket", json!({"ticket_id": t["id"]})).await["title"], "T");
    for (name, tool) in &listed {
        assert_eq!(tool["inputSchema"]["additionalProperties"], false, "{name}");
    }
}

/// Over the protocol the result also carries what the tool's output schema asks for.
#[tokio::test]
async fn test_tools_work_through_a_real_client_session() {
    let s = common::start().await;
    let mcp = s.mcp();
    mcp.initialize().await;
    let run = |tool: &'static str, arguments: Value| {
        let mcp = mcp.clone();
        async move {
            let result = mcp.call_tool(tool, arguments.clone()).await;
            assert!(!result.is_error, "{tool} {arguments}: {}", result.text);
            result
        }
    };
    let made = run("manage_project", json!({"action": "create", "name": "P", "prefix": "PRO"})).await;
    let project = made.json();
    // a tool without an output schema answers with text only
    assert!(made.raw.get("structuredContent").is_none(), "{}", made.raw);
    let all = run("get_projects", json!({})).await;
    assert_eq!(all.raw["structuredContent"]["result"].as_array().expect("a list").len(), 1);
    let detail = run("get_projects", json!({"project_id": project["id"]})).await;
    assert!(!detail.json()["members"].as_array().expect("members").is_empty());
    assert_eq!(detail.raw["structuredContent"]["result"], detail.json());
    let ticket =
        run("manage_ticket", json!({"action": "create", "project_id": project["id"], "title": "t"})).await.json();
    run("ticket_items", json!({"ticket_id": ticket["id"], "item": "criterion", "action": "add", "text": "c"})).await;
    run("ticket_branches", json!({"ticket_id": ticket["id"], "action": "add", "name": "feat/a"})).await;
    run("list_tickets", json!({"project_id": project["id"]})).await;
    run("get_ticket", json!({"ticket_id": ticket["id"], "view": "comments"})).await;
    let page = run("docs_write", json!({"action": "create", "project_id": project["id"], "title": "Doc"})).await.json();
    run("docs_read", json!({"action": "get", "page_id": page["id"]})).await;
    run("docs_read", json!({"action": "search", "project_id": project["id"], "query": "Doc"})).await;
    let failed = mcp.call_tool("manage_project", json!({"action": "update", "project_id": "NOPE", "name": "x"})).await;
    assert!(failed.is_error);
    let failed = mcp.call_tool("manage_ticket", json!({"action": "update", "ticket_id": "NOPE-1", "title": "x"})).await;
    assert!(failed.is_error);
}

// --------------------------------------------------------------------------- tickets

#[tokio::test]
async fn test_ticket_lifecycle_and_relations() {
    let s = common::start().await;
    let mcp = s.mcp();
    let p = project(&mcp, "FAC").await;
    let a = ticket(&mcp, &p, json!({"title": "a"})).await;
    let b = ticket(&mcp, &p, json!({"title": "b", "priority": "high"})).await;
    let child = ticket(&mcp, &p, json!({"title": "child", "parent_id": a["id"]})).await;
    assert!(child["parent_id"] == a["id"] && b["priority"] == "high");

    let moved =
        call(&mcp, "manage_ticket", json!({"action": "update", "ticket_id": a["id"], "status": "in-progress"})).await;
    assert_eq!(moved["status"], "in-progress");
    call(&mcp, "manage_ticket", json!({"action": "update", "ticket_id": a["id"], "estimate": 3})).await;
    let unset =
        call(&mcp, "manage_ticket", json!({"action": "update", "ticket_id": a["id"], "clear_fields": ["estimate"]}))
            .await;
    assert_eq!(unset["estimate"], Value::Null);

    // b cannot proceed until a is done
    let blocked =
        call(&mcp, "manage_ticket", json!({"action": "block", "ticket_id": b["id"], "target_id": a["id"]})).await;
    assert!(blocked["blocker"]["id"] == a["id"] && blocked["blocked"]["id"] == b["id"]);
    assert!(blocked["blocked"]["blocked_by"].as_array().expect("list").contains(&a["id"]));
    let freed =
        call(&mcp, "manage_ticket", json!({"action": "unblock", "ticket_id": b["id"], "target_id": a["id"]})).await;
    assert_eq!(freed["blocked"]["blocked_by"], json!([]));

    let link = call(
        &mcp,
        "manage_ticket",
        json!({"action": "link", "ticket_id": a["id"], "target_id": b["id"], "relation_type": "relates_to"}),
    )
    .await;
    let refused =
        call_err(&mcp, "manage_ticket", json!({"action": "unlink", "ticket_id": b["id"], "link_id": link["id"]})).await;
    assert!(refused.contains("different id on each"), "{refused}");
    let removed =
        call(&mcp, "manage_ticket", json!({"action": "unlink", "ticket_id": a["id"], "link_id": link["id"]})).await;
    assert_eq!(removed, json!({"removed": link["id"]}));

    let ws = call(&mcp, "manage_ticket", json!({"action": "workspace", "ticket_id": a["id"]})).await;
    for key in ["enabled", "path", "exists"] {
        assert!(ws.get(key).is_some(), "{key}");
    }

    let gone = call(&mcp, "manage_ticket", json!({"action": "delete", "ticket_id": child["id"]})).await;
    assert_eq!(gone, json!({"deleted": child["id"]}));
    let refused = call_err(&mcp, "get_ticket", json!({"ticket_id": child["id"]})).await;
    assert!(refused.contains("not found"), "{refused}");
}

#[tokio::test]
async fn test_wont_do_needs_a_reason_and_done_guards_are_enforced() {
    let s = common::start().await;
    let mcp = s.mcp();
    let p = project(&mcp, "FAC").await;
    let t = ticket(&mcp, &p, json!({})).await;
    let refused =
        call_err(&mcp, "manage_ticket", json!({"action": "update", "ticket_id": t["id"], "status": "wont_do"})).await;
    assert!(refused.to_lowercase().contains("reason"), "{refused}");
    let done = call(
        &mcp,
        "manage_ticket",
        json!({"action": "update", "ticket_id": t["id"], "status": "wont_do", "wont_do_reason": "obsolete"}),
    )
    .await;
    assert_eq!(done["status"], "wont_do");
    // not a starting column
    call_err(
        &mcp,
        "manage_ticket",
        json!({"action": "create", "project_id": p["id"], "title": "T", "status": "wont_do"}),
    )
    .await;
}

#[tokio::test]
async fn test_get_ticket_can_return_just_the_comments() {
    let s = common::start().await;
    let mcp = s.mcp();
    let p = project(&mcp, "FAC").await;
    let t = ticket(&mcp, &p, json!({})).await;
    items(&mcp, &t["id"], "comment", json!({"action": "add", "text": "hello", "author": "Claude"})).await;
    let thread = call(&mcp, "get_ticket", json!({"ticket_id": t["id"], "view": "comments"})).await;
    assert!(thread["count"] == 1 && thread["comments"][0]["text"] == "hello");
    assert!(thread.get("description").is_none());
}

// --------------------------------------------------------------------------- ticket_items

/// AIs leave `action` out of a work_log note; it used to be refused ("action: Field required").
#[tokio::test]
async fn test_a_work_log_note_without_an_action_is_added_and_with_an_id_updated() {
    let s = common::start().await;
    let mcp = s.mcp();
    let p = project(&mcp, "FAC").await;
    let i = ticket(&mcp, &p, json!({})).await["id"].clone();
    let after = items(
        &mcp,
        &i,
        "work_log",
        json!({"author": "PM", "role": "PM", "note": "Checked the links on the Overview page.", "log_kind": "investigation"}),
    )
    .await;
    let entry = after["work_log"][0].clone();
    assert_eq!(entry["note"], "Checked the links on the Overview page.");
    let after = items(&mcp, &i, "work_log", json!({"item_id": entry["id"], "note": "Fixed."})).await;
    let notes: Vec<Value> = after["work_log"].as_array().expect("log").iter().map(|e| e["note"].clone()).collect();
    assert_eq!(notes, [json!("Fixed.")]);
}

#[tokio::test]
async fn test_comments_work_log_criteria_sub_tasks_and_test_cases() {
    let s = common::start().await;
    let mcp = s.mcp();
    let p = project(&mcp, "FAC").await;
    let t = ticket(&mcp, &p, json!({})).await;
    let i = &t["id"];

    let after = items(&mcp, i, "comment", json!({"action": "add", "text": "first", "author": "Claude"})).await;
    let cid = after["comments"][0]["id"].clone();
    let edited = items(&mcp, i, "comment", json!({"action": "update", "item_id": cid, "text": "second"})).await;
    assert_eq!(edited["comments"][0]["text"], "second");
    let hidden = items(&mcp, i, "comment", json!({"action": "delete", "item_id": cid})).await;
    let thread = call(&mcp, "get_ticket", json!({"ticket_id": i, "view": "comments"})).await;
    assert_eq!(thread["count"], 0);
    assert!(hidden.get("activity_log").is_none());
    items(&mcp, i, "comment", json!({"action": "restore", "item_id": cid})).await;
    let thread = call(&mcp, "get_ticket", json!({"ticket_id": i, "view": "comments"})).await;
    assert_eq!(thread["count"], 1);

    items(
        &mcp,
        i,
        "work_log",
        json!({"action": "add", "author": "Claude", "role": "Developer", "note": "looked at the logs", "log_kind": "root_cause", "pinned": true}),
    )
    .await;
    let log = call(&mcp, "get_ticket", json!({"ticket_id": i})).await["work_log"][0].clone();
    assert!(log["kind"] == "root_cause" && log["pinned"] == true);
    let resolved = items(
        &mcp,
        i,
        "work_log",
        json!({"action": "update", "item_id": log["id"], "note": "rewritten", "pinned": false}),
    )
    .await;
    assert_eq!(resolved["work_log"][0]["note"], "rewritten");
    items(&mcp, i, "work_log", json!({"action": "delete", "item_id": log["id"]})).await;

    let with_ac = items(&mcp, i, "criterion", json!({"action": "add", "text": "works"})).await;
    let ac = with_ac["acceptance_criteria"][0].clone();
    assert_eq!(ac["done"], false);
    let toggled = items(&mcp, i, "criterion", json!({"action": "toggle", "item_id": ac["id"]})).await;
    assert_eq!(toggled["acceptance_criteria"][0]["done"], true);
    let emptied = items(&mcp, i, "criterion", json!({"action": "delete", "item_id": ac["id"]})).await;
    assert_eq!(emptied["acceptance_criteria"], json!([]));

    let with_st = items(&mcp, i, "sub_task", json!({"action": "add", "text": "step"})).await;
    let st = with_st["sub_tasks"][0].clone();
    let toggled = items(&mcp, i, "sub_task", json!({"action": "toggle", "item_id": st["id"]})).await;
    assert_eq!(toggled["sub_tasks"][0]["done"], true);
    items(&mcp, i, "sub_task", json!({"action": "delete", "item_id": st["id"]})).await;

    items(&mcp, i, "test_case", json!({"action": "add", "title": "it runs", "expected_result": "ok"})).await;
    // by code
    let passed = items(
        &mcp,
        i,
        "test_case",
        json!({"action": "update", "item_id": "TC-1", "status": "pass", "proof": "log.txt"}),
    )
    .await;
    assert_eq!(passed["test_cases"][0]["status"], "pass");
    let left = items(&mcp, i, "test_case", json!({"action": "delete", "item_id": "TC-1"})).await;
    assert_eq!(left["test_cases"], json!([]));
}

#[tokio::test]
async fn test_ticket_items_explains_a_wrong_call() {
    let s = common::start().await;
    let mcp = s.mcp();
    let p = project(&mcp, "FAC").await;
    let t = ticket(&mcp, &p, json!({})).await;
    let i = &t["id"];
    // an action the item does not have: the valid ones are listed
    let refused =
        call_err(&mcp, "ticket_items", items_arguments(i, "comment", json!({"action": "toggle", "item_id": "x"})))
            .await;
    assert!(refused.contains("Valid actions for comment: add, update, delete, restore"), "{refused}");
    // a missing parameter is named, with what the action takes
    let refused =
        call_err(&mcp, "ticket_items", items_arguments(i, "comment", json!({"action": "add", "text": "hi"}))).await;
    assert!(refused.contains("Missing: author"), "{refused}");
    // a parameter that belongs to another item is refused instead of being silently dropped
    let refused = call_err(
        &mcp,
        "ticket_items",
        items_arguments(
            i,
            "comment",
            json!({"action": "add", "text": "hi", "author": "C", "log_kind": "investigation"}),
        ),
    )
    .await;
    assert!(refused.contains("does not use: log_kind"), "{refused}");
    // a stale or unknown sub-item id lists the real ones
    items(&mcp, i, "criterion", json!({"action": "add", "text": "ok"})).await;
    let refused =
        call_err(&mcp, "ticket_items", items_arguments(i, "criterion", json!({"action": "toggle", "item_id": "nope"})))
            .await;
    assert!(refused.contains("not found"), "{refused}");
}

// --------------------------------------------------------------------------- branches

#[tokio::test]
async fn test_branches_by_name() {
    let s = common::start().await;
    let mcp = s.mcp();
    let p = project(&mcp, "FAC").await;
    let t = ticket(&mcp, &p, json!({})).await;
    let i = &t["id"];
    let added = call(&mcp, "ticket_branches", json!({"ticket_id": i, "action": "add", "name": "feat/x"})).await;
    assert_eq!(added["branches"][0]["name"], "feat/x");
    let updated = call(
        &mcp,
        "ticket_branches",
        json!({"ticket_id": i, "action": "update", "branch": "feat/x", "pr_url": "https://example.com/pr/1"}),
    )
    .await;
    assert_eq!(updated["branches"][0]["pr_url"], "https://example.com/pr/1");
    let renamed = call(
        &mcp,
        "ticket_branches",
        json!({"ticket_id": i, "action": "update", "branch": "feat/x", "name": "feat/y"}),
    )
    .await;
    assert_eq!(renamed["branches"][0]["name"], "feat/y");
    let refused = call_err(&mcp, "ticket_branches", json!({"ticket_id": i, "action": "delete"})).await;
    assert!(refused.contains("Missing: branch"), "{refused}");
    let refused =
        call_err(&mcp, "ticket_branches", json!({"ticket_id": i, "action": "add", "name": "z", "force": true})).await;
    assert!(refused.contains("does not use: force"), "{refused}");
    let gone = call(&mcp, "ticket_branches", json!({"ticket_id": i, "action": "delete", "branch": "feat/y"})).await;
    assert_eq!(gone["branches"], json!([]));
}

#[tokio::test]
async fn test_branch_counts_keep_their_schema_constraint() {
    let s = common::start().await;
    let mcp = s.mcp();
    let p = project(&mcp, "FAC").await;
    let t = ticket(&mcp, &p, json!({})).await;
    call_err(&mcp, "ticket_branches", json!({"ticket_id": t["id"], "action": "add", "name": "a", "ahead_count": -1}))
        .await;
}

#[tokio::test]
async fn test_changes_are_attributed_to_the_agent() {
    let s = common::start().await;
    let mcp = s.mcp();
    let p = project(&mcp, "FAC").await;
    let t = ticket(&mcp, &p, json!({})).await;
    call(&mcp, "manage_ticket", json!({"action": "update", "ticket_id": t["id"], "title": "renamed"})).await;
    let ticket = call(&mcp, "get_ticket", json!({"ticket_id": t["id"], "activity_limit": -1})).await;
    let log = ticket["activity_log"].as_array().expect("log");
    assert!(log.iter().any(|e| e["field"] == "title" && e.get("actor").is_some_and(common::truthy)), "{log:?}");
}

#[tokio::test]
async fn test_the_comments_view_refuses_activity_options() {
    let s = common::start().await;
    let mcp = s.mcp();
    let p = project(&mcp, "FAC").await;
    let t = ticket(&mcp, &p, json!({})).await;
    let refused =
        call_err(&mcp, "get_ticket", json!({"ticket_id": t["id"], "view": "comments", "activity_limit": 3})).await;
    assert!(refused.contains("view='full' only"), "{refused}");
}

#[tokio::test]
async fn test_reopen_pend_and_resume_through_manage_ticket() {
    let s = common::start().await;
    let mcp = s.mcp();
    let p = project(&mcp, "FAC").await;
    let t = ticket(&mcp, &p, json!({})).await;
    let other = ticket(&mcp, &p, json!({"title": "Other"})).await;
    let tid = &t["id"];

    let refused = call_err(&mcp, "manage_ticket", json!({"action": "reopen", "ticket_id": tid})).await;
    assert!(refused.contains("Done or Won't Do"), "{refused}");

    let pending = call(
        &mcp,
        "manage_ticket",
        json!({"action": "pend", "ticket_id": tid, "reason_type": "ticket", "target_id": other["id"], "add_blocked_by": true}),
    )
    .await;
    assert!(pending["pending"] == true && pending["status"] == t["status"]);
    assert!(pending["blocked_by"].as_array().expect("list").contains(&other["id"]));
    // attributed to the agent
    assert!(common::truthy(&pending["pending_by"]));

    let refused =
        call_err(&mcp, "manage_ticket", json!({"action": "pend", "ticket_id": tid, "reason_type": "ticket"})).await;
    assert!(refused.contains("target_id") || refused.contains("ticket_id is required"), "{refused}");

    let resumed = call(
        &mcp,
        "manage_ticket",
        json!({"action": "resume", "ticket_id": tid, "reason": "unblocked", "add_comment": true}),
    )
    .await;
    assert_eq!(resumed["pending"], false);

    // the ticket it waited on still blocks it: Done is refused until that one is done (3.35.1)
    let refused =
        call_err(&mcp, "manage_ticket", json!({"action": "update", "ticket_id": tid, "status": "done"})).await;
    assert!(refused.contains("blocked by"), "{refused}");
    call(&mcp, "manage_ticket", json!({"action": "update", "ticket_id": other["id"], "status": "done"})).await;
    call(&mcp, "manage_ticket", json!({"action": "update", "ticket_id": tid, "status": "done"})).await;
    let reopened =
        call(&mcp, "manage_ticket", json!({"action": "reopen", "ticket_id": tid, "reason": "regression"})).await;
    assert!(reopened["status"] == "todo" && reopened["reopen_count"] == 1);
}

#[tokio::test]
async fn test_list_tickets_filters_pending_and_reopened() {
    let s = common::start().await;
    let mcp = s.mcp();
    let p = project(&mcp, "FAC").await;
    let a = ticket(&mcp, &p, json!({"title": "A"})).await;
    let b = ticket(&mcp, &p, json!({"title": "B"})).await;
    call(
        &mcp,
        "manage_ticket",
        json!({"action": "pend", "ticket_id": a["id"], "reason_type": "party", "party": "Acme"}),
    )
    .await;
    call(&mcp, "manage_ticket", json!({"action": "update", "ticket_id": b["id"], "status": "done"})).await;
    call(&mcp, "manage_ticket", json!({"action": "reopen", "ticket_id": b["id"]})).await;

    let only_pending = call(&mcp, "list_tickets", json!({"project_id": p["id"], "pending": true})).await;
    assert_eq!(ids(&only_pending["tickets"]), [a["id"].as_str().expect("id")]);
    assert_eq!(only_pending["tickets"][0]["pending"], true);

    let only_reopened = call(&mcp, "list_tickets", json!({"project_id": p["id"], "reopened": true})).await;
    assert_eq!(ids(&only_reopened["tickets"]), [b["id"].as_str().expect("id")]);
    assert_eq!(only_reopened["tickets"][0]["reopen_count"], 1);

    let rest = call(&mcp, "list_tickets", json!({"project_id": p["id"], "pending": false, "reopened": false})).await;
    assert_eq!(rest["total"], 0);
}

// --------------------------------------------------------------------------- docs

#[tokio::test]
async fn test_docs_read_and_write() {
    let s = common::start().await;
    let mcp = s.mcp();
    let p = project(&mcp, "DOC").await;
    let pid = &p["id"];
    let page = call(
        &mcp,
        "docs_write",
        json!({"action": "create", "project_id": pid, "title": "Guide", "markdown": "## Intro\nhi"}),
    )
    .await;
    assert_eq!(page["version"], 1);
    let child = call(
        &mcp,
        "docs_write",
        json!({"action": "create", "project_id": pid, "title": "Child", "parent_id": page["id"]}),
    )
    .await;

    let tree = call(&mcp, "docs_read", json!({"action": "list", "project_id": pid})).await;
    let mut titles: Vec<&str> = tree.as_array().expect("a list").iter().filter_map(|n| n["title"].as_str()).collect();
    titles.sort_unstable();
    assert_eq!(titles, ["Child", "Guide"]);
    let got = call(&mcp, "docs_read", json!({"action": "get", "page_id": page["id"]})).await;
    assert!(got["markdown"].as_str().expect("text").starts_with("## Intro") && got["version"] == 1);

    let updated = call(
        &mcp,
        "docs_write",
        json!({"action": "update", "page_id": page["id"], "markdown": "## Intro\nchanged", "base_version": 1, "note": "edit", "title": "Guide 2"}),
    )
    .await;
    assert!(updated["version"] == 2 && updated["title"] == "Guide 2");
    // a stale base_version
    let refused = call_err(
        &mcp,
        "docs_write",
        json!({"action": "update", "page_id": page["id"], "markdown": "x", "base_version": 1}),
    )
    .await;
    assert!(refused.contains("docs_read"), "{refused}");

    let versions = call(&mcp, "docs_read", json!({"action": "versions", "page_id": page["id"]})).await;
    let numbers: Vec<&Value> = versions.as_array().expect("a list").iter().map(|v| &v["version"]).collect();
    assert_eq!(numbers, [&json!(2), &json!(1)]);
    let old = call(&mcp, "docs_read", json!({"action": "version", "page_id": page["id"], "version": 1})).await;
    assert!(old["markdown"].as_str().expect("text").contains("hi"));
    let diff =
        call(&mcp, "docs_read", json!({"action": "version", "page_id": page["id"], "version": 1, "compare_to": 2}))
            .await;
    assert_ne!(diff, old);
    let restored =
        call(&mcp, "docs_write", json!({"action": "restore_version", "page_id": page["id"], "version": 1})).await;
    assert_eq!(restored["version"], 3);

    let found = call(&mcp, "docs_read", json!({"action": "search", "project_id": pid, "query": "Intro"})).await;
    assert!(found["total"].as_i64().expect("a total") >= 1);
    let checked =
        call(&mcp, "docs_read", json!({"action": "check_links", "project_id": pid, "refs": ["[[Guide]]", "[[Nope]]"]}))
            .await;
    let statuses: Vec<&Value> = checked.as_array().expect("a list").iter().map(|c| &c["status"]).collect();
    assert_eq!(statuses, [&json!("ok"), &json!("missing")]);

    let moved = call(&mcp, "docs_write", json!({"action": "move", "page_id": child["id"]})).await;
    assert!(moved["parent_id"].is_null());
    let copy =
        call(&mcp, "docs_write", json!({"action": "duplicate", "page_id": page["id"], "include_children": false}))
            .await;
    assert!(copy["title"].as_str().expect("a title").ends_with("(copy)"));

    let t = ticket(&mcp, &p, json!({})).await;
    call(&mcp, "manage_ticket", json!({"action": "link_doc", "ticket_id": t["id"], "page_id": page["id"]})).await;
    call(&mcp, "manage_ticket", json!({"action": "unlink_doc", "ticket_id": t["id"], "page_id": page["id"]})).await;

    call(&mcp, "docs_write", json!({"action": "delete", "page_id": child["id"]})).await;
    let bin = call(&mcp, "docs_read", json!({"action": "recycle_bin", "project_id": pid})).await;
    let ids: Vec<&Value> = bin.as_array().expect("a list").iter().map(|b| &b["id"]).collect();
    assert_eq!(ids, [&child["id"]]);
    call(&mcp, "docs_write", json!({"action": "restore", "page_id": child["id"]})).await;
    assert_eq!(call(&mcp, "docs_read", json!({"action": "recycle_bin", "project_id": pid})).await, json!([]));
}

#[tokio::test]
async fn test_docs_import() {
    let s = common::start().await;
    let mcp = s.mcp();
    let p = project(&mcp, "IMP").await;
    let dir = tempfile::tempdir().expect("a folder");
    std::fs::write(dir.path().join("a.md"), "# A\nbody").expect("a file");
    let out = call(
        &mcp,
        "docs_write",
        json!({"action": "import", "project_id": p["id"], "path": dir.path().to_string_lossy()}),
    )
    .await;
    assert!(out["created"].as_array().expect("created").len() == 1 && out["failed"] == json!([]));
}

// - `test_every_table_entry_names_real_parameters` is a unit test next to each table (`src/tools/projects.rs`,
//   `tickets.rs`, `items.rs`, `branches.rs`).
