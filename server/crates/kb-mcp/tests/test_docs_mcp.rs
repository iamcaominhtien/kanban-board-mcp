//! `tests/test_docs_mcp.py`: the Docs tools through the real protocol. The Python tests call the operations; here the
//! same calls are made through `docs_read` and `docs_write`, and what a returned dict is asserted on is the tool
//! result's JSON.

mod common;

use common::{call, call_err};
use serde_json::{Value, json};

async fn write(mcp: &testkit::Mcp, action: &str, rest: Value) -> Value {
    let mut arguments = json!({"action": action});
    for (key, value) in rest.as_object().expect("an object") {
        arguments[key] = value.clone();
    }
    call(mcp, "docs_write", arguments).await
}

async fn read(mcp: &testkit::Mcp, action: &str, rest: Value) -> Value {
    let mut arguments = json!({"action": action});
    for (key, value) in rest.as_object().expect("an object") {
        arguments[key] = value.clone();
    }
    call(mcp, "docs_read", arguments).await
}

async fn project(c: &testkit::Client) -> Value {
    let made = c.post("/projects", json!({"name": "Docs", "prefix": "DOC", "color": "#123456"})).await;
    made.assert_status(201);
    made.json()
}

#[tokio::test]
async fn test_full_crud_round_trip() {
    let s = common::start().await;
    let (mcp, c) = (s.mcp(), s.client());
    let pid = project(&c).await["id"].clone();
    let page =
        write(&mcp, "create", json!({"project_id": pid, "title": "Runbook", "markdown": "## Steps\n1. go"})).await;
    let full = read(&mcp, "get", json!({"page_id": page["id"]})).await;
    let renamed = write(
        &mcp,
        "update",
        json!({"page_id": page["id"], "markdown": "## Steps\n1. stop", "base_version": full["version"], "title": "Runbook v2"}),
    )
    .await;
    assert!(renamed["title"] == "Runbook v2" && renamed["version"] == 2);

    let child = write(&mcp, "create", json!({"project_id": pid, "title": "Child", "markdown": "x"})).await;
    let moved = write(&mcp, "move", json!({"page_id": child["id"], "parent_id": page["id"]})).await;
    assert_eq!(moved["parent_id"], page["id"]);
    let refused =
        call_err(&mcp, "docs_write", json!({"action": "move", "page_id": page["id"], "parent_id": child["id"]})).await;
    assert!(refused.contains("itself"), "{refused}");

    let dup = write(&mcp, "duplicate", json!({"page_id": page["id"], "include_children": true})).await;
    assert_eq!(dup["status"], "draft");
    let tree = read(&mcp, "list", json!({"project_id": pid})).await;
    assert_eq!(tree.as_array().expect("a list").len(), 4);

    let deleted = write(&mcp, "delete", json!({"page_id": dup["id"]})).await;
    assert_eq!(deleted["deleted_pages"], 2);
    let bin = read(&mcp, "recycle_bin", json!({"project_id": pid})).await;
    let titles: Vec<&Value> = bin.as_array().expect("a list").iter().map(|e| &e["title"]).collect();
    assert_eq!(titles, [&dup["title"]]);
    let restored = write(&mcp, "restore", json!({"page_id": dup["id"]})).await;
    assert_eq!(restored["restored_pages"], 2);
    assert_eq!(read(&mcp, "recycle_bin", json!({"project_id": pid})).await, json!([]));
}

#[tokio::test]
async fn test_versions_diff_restore_and_stale_base() {
    let s = common::start().await;
    let (mcp, c) = (s.mcp(), s.client());
    let pid = project(&c).await["id"].clone();
    let page = write(&mcp, "create", json!({"project_id": pid, "title": "Spec", "markdown": "## A\nold"})).await;
    write(&mcp, "update", json!({"page_id": page["id"], "markdown": "## A\nnew", "base_version": 1, "note": "edit"}))
        .await;
    let versions = read(&mcp, "versions", json!({"page_id": page["id"]})).await;
    let numbers: Vec<&Value> = versions.as_array().expect("a list").iter().map(|v| &v["version"]).collect();
    assert_eq!(numbers, [&json!(2), &json!(1)]);
    assert_eq!(read(&mcp, "version", json!({"page_id": page["id"], "version": 1})).await["markdown"], "## A\nold");
    let diff = read(&mcp, "version", json!({"page_id": page["id"], "version": 1, "compare_to": 2})).await;
    assert_eq!((&diff["added"], &diff["removed"]), (&json!(1), &json!(1)));
    let refused = call_err(
        &mcp,
        "docs_write",
        json!({"action": "update", "page_id": page["id"], "markdown": "x", "base_version": 1}),
    )
    .await;
    assert!(refused.contains("docs_read"), "{refused}");
    let back = write(&mcp, "restore_version", json!({"page_id": page["id"], "version": 1})).await;
    assert_eq!(back["version"], 3);
}

#[tokio::test]
async fn test_search_resolve_import_and_ticket_links() {
    let s = common::start().await;
    let (mcp, c) = (s.mcp(), s.client());
    let pid = project(&c).await["id"].clone();
    let t = c
        .post(&format!("/projects/{}/tickets", pid.as_str().expect("an id")), json!({"title": "Rate", "type": "task"}))
        .await
        .json();
    let key = t["id"].clone();
    let page = write(
        &mcp,
        "create",
        json!({"project_id": pid, "title": "Limits", "markdown": format!("## Policy\nPer-token buckets. {}", key.as_str().expect("a key"))}),
    )
    .await;
    let found = read(&mcp, "search", json!({"project_id": pid, "query": "buckets"})).await;
    let titles: Vec<&Value> = found["pages"].as_array().expect("pages").iter().map(|p| &p["title"]).collect();
    assert_eq!(titles, [&json!("Limits")]);
    let res =
        read(&mcp, "check_links", json!({"project_id": pid, "refs": ["[[Limits#Policy]]", "[[Ghost]]", key]})).await;
    let statuses: Vec<&Value> = res.as_array().expect("a list").iter().map(|r| &r["status"]).collect();
    assert_eq!(statuses, [&json!("ok"), &json!("missing"), &json!("ok")]);
    // `pytest.raises(ValueError)` for a text that is no reference
    call_err(&mcp, "docs_read", json!({"action": "check_links", "project_id": pid, "refs": ["plain words"]})).await;

    let dir = tempfile::tempdir().expect("a folder");
    let root = dir.path();
    std::fs::create_dir(root.join("guide")).expect("a folder");
    std::fs::write(root.join("guide/intro.md"), "# Intro\nSee [[Limits]].").expect("a file");
    std::fs::write(root.join("notes.md"), "---\ntitle: Notes\n---\nhello").expect("a file");
    std::fs::write(root.join("skip.txt"), "no").expect("a file");
    let out = write(&mcp, "import", json!({"project_id": pid, "path": root.to_string_lossy()})).await;
    // guide folder + intro + notes
    assert!(
        out["created"].as_array().expect("created").len() == 3 && out["failed"].as_array().is_some_and(Vec::is_empty)
    );
    std::fs::create_dir(root.join("empty")).expect("a folder");
    let refused = call_err(
        &mcp,
        "docs_write",
        json!({"action": "import", "project_id": pid, "path": root.join("empty").to_string_lossy()}),
    )
    .await;
    assert!(refused.contains("No .md"), "{refused}");

    let linked =
        call(&mcp, "manage_ticket", json!({"action": "link_doc", "ticket_id": key, "page_id": page["id"]})).await;
    assert!(common::truthy(&linked));
    // the page names the ticket, so they are already linked by a mention and no manual link is added (the Python
    // test asserted a manual one; the server answers `already_linked` since the link by mention exists)
    assert_eq!(linked["already_linked"], "mention");
    let docs = c.get(&format!("/tickets/{}/docs", key.as_str().expect("a key"))).await.json();
    assert!(docs.as_array().expect("docs").iter().any(|d| d["origin"] == "page"), "{docs}");
    call(&mcp, "manage_ticket", json!({"action": "unlink_doc", "ticket_id": key, "page_id": page["id"]})).await;
    let docs = c.get(&format!("/tickets/{}/docs", key.as_str().expect("a key"))).await.json();
    assert!(!docs.as_array().expect("docs").iter().any(|d| d["origin"] == "manual"));
}

#[tokio::test]
async fn test_agent_comments_on_a_page_through_the_docs_tools() {
    let s = common::start().await;
    let (mcp, c) = (s.mcp(), s.client());
    let pid = project(&c).await["id"].clone();
    let page = write(&mcp, "create", json!({"project_id": pid, "title": "Runbook", "markdown": "## Steps\n\nRestart the **worker** before deploying.\n"})).await;
    let pg = page["id"].clone();

    let inline =
        write(&mcp, "comment", json!({"page_id": pg, "body": "Which worker?", "quote": "Restart the worker"})).await;
    assert!(inline["kind"] == "inline" && inline["number"] == 1);
    assert_eq!(inline["comments"][0]["author"], "agent");
    let whole = write(&mcp, "comment", json!({"page_id": pg, "body": "Needs an owner"})).await;
    assert_eq!(whole["kind"], "page");

    // a quote that is not in the page is refused with a hint
    let refused = call_err(
        &mcp,
        "docs_write",
        json!({"action": "comment", "page_id": pg, "body": "x", "quote": "nothing like this"}),
    )
    .await;
    assert!(refused.contains("not in the published page"), "{refused}");

    // a person replies through the REST API; the agent sees it and answers
    let r = c
        .clone()
        .header("x-actor", "user")
        .post(
            &format!("/docs/comments/threads/{}/replies", inline["id"].as_str().expect("an id")),
            json!({"body": "The queue worker."}),
        )
        .await;
    r.assert_status(201);
    let listed = read(&mcp, "comments", json!({"page_id": pg})).await;
    assert!(listed["counts"]["page"] == 1 && listed["counts"]["open"] == 1);
    let thread = listed["threads"]
        .as_array()
        .expect("threads")
        .iter()
        .find(|t| t["id"] == inline["id"])
        .expect("a thread")
        .clone();
    let authors: Vec<&Value> = thread["comments"].as_array().expect("comments").iter().map(|x| &x["author"]).collect();
    assert_eq!(authors, [&json!("agent"), &json!("user")]);
    assert!(thread["comments"][0].get("can_edit").is_none());

    let reply = write(&mcp, "reply", json!({"thread_id": inline["id"], "body": "Thanks"})).await;
    assert_eq!(reply["comments"].as_array().expect("comments").len(), 3);
    let own = reply["comments"][2]["id"].clone();
    let edited = write(&mcp, "edit_comment", json!({"comment_id": own, "body": "Thanks!"})).await;
    assert_eq!(edited["comments"][2]["body"], "Thanks!");
    // the agent cannot edit a person's comment
    let refused = call_err(
        &mcp,
        "docs_write",
        json!({"action": "edit_comment", "comment_id": thread["comments"][1]["id"], "body": "no"}),
    )
    .await;
    assert!(refused.contains("own comments"), "{refused}");

    let resolved = write(&mcp, "resolve", json!({"thread_id": inline["id"]})).await;
    assert!(resolved["status"] == "resolved" && resolved["resolved_by"] == "agent");
    assert_eq!(read(&mcp, "comments", json!({"page_id": pg, "state": "open"})).await["counts"]["open"], 0);
    let reopened = write(&mcp, "reopen", json!({"thread_id": inline["id"]})).await;
    assert_eq!(reopened["status"], "open");

    let deleted = write(&mcp, "delete_comment", json!({"comment_id": own})).await;
    assert_eq!(deleted["deleted"], "comment");
    // the pages' events say who to notify
    let events =
        c.get(&format!("/projects/{}/docs/comment-events?recipient=user", pid.as_str().expect("an id"))).await.json();
    let events = events.as_array().expect("events");
    assert!(!events.is_empty() && events[0]["actor"] == "agent");
}
