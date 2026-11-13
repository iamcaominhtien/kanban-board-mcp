//! Comments: inline and page threads, replies, edits, resolving, batches, and what a person's reply looks like to
//! the agent.

use serde_json::json;

use super::{Call, Fixtures, call, dr, dw, dwk, dwp, finish, golden, keep};
use crate::{Run, common};

fn setup() -> Vec<Call> {
    vec![
        keep("setup: project", "manage_project", json!({"action": "create", "name": "Notes", "prefix": "NOT"}), "p"),
        keep("setup: Bao", "manage_project", json!({"action": "add_member", "project_id": "$p", "name": "Bao"}), "bao"),
        dwk(
            "setup: a page",
            "create",
            json!({"project_id": "$p", "title": "Runbook", "markdown": "## Steps\n\nRestart the **worker** before deploying.\n\n- Check the queue\n- Drain it\n\n| Name | Role |\n|---|---|\n| Ana | Owner |\n\n## Rollback\n\nUndo the deploy.\n"}),
            "pg",
        ),
        dwk("setup: another page", "create", json!({"project_id": "$p", "title": "Other", "markdown": "text"}), "pg2"),
    ]
}

fn first_round() -> Vec<Call> {
    vec![
        dw("comment: nothing else", "comment", json!({})),
        dw("comment: no body", "comment", json!({"page_id": "$pg"})),
        dw("comment: a parameter it does not use", "comment", json!({"page_id": "$pg", "body": "x", "title": "t"})),
        dw("comment: a page that does not exist", "comment", json!({"page_id": "nope", "body": "x"})),
        dw("comment: an empty body", "comment", json!({"page_id": "$pg", "body": "  "})),
        dw("comment: a body that is too long", "comment", json!({"page_id": "$pg", "body": "x".repeat(4001)})),
        dw(
            "comment: a quote that is not there",
            "comment",
            json!({"page_id": "$pg", "body": "x", "quote": "nothing like this"}),
        ),
        dw(
            "comment: a quote across two blocks",
            "comment",
            json!({"page_id": "$pg", "body": "x", "quote": "before deploying.\n\nCheck the queue"}),
        ),
        dwk(
            "comment: inline",
            "comment",
            json!({"page_id": "$pg", "body": "Which worker?", "quote": "Restart the worker"}),
            "th1",
        ),
        dwk(
            "comment: inline in a list item",
            "comment",
            json!({"page_id": "$pg", "body": "How long?", "quote": "Drain it"}),
            "th2",
        ),
        dwk(
            "comment: inline in a table cell",
            "comment",
            json!({"page_id": "$pg", "body": "Who is Ana?", "quote": "Owner"}),
            "th3",
        ),
        dwk(
            "comment: on the page",
            "comment",
            json!({"page_id": "$pg", "body": "Needs an owner, @Bao please look"}),
            "th4",
        ),
        dwk(
            "comment: a mention of someone not a member",
            "comment",
            json!({"page_id": "$pg", "body": "Ask @Nobody and [[Other]] and NOT-1"}),
            "th5",
        ),
        dr("comments: all", "comments", json!({"page_id": "$pg"})),
        dr("comments: open", "comments", json!({"page_id": "$pg", "state": "open"})),
        dr("comments: resolved", "comments", json!({"page_id": "$pg", "state": "resolved"})),
        dr("comments: a page that does not exist", "comments", json!({"page_id": "nope"})),
        dr("comments: nothing else", "comments", json!({})),
        dr("comments: a page with none", "comments", json!({"page_id": "$pg2"})),
        dw("reply: nothing else", "reply", json!({})),
        dw("reply: no body", "reply", json!({"thread_id": "$th1"})),
        dw("reply: a thread that does not exist", "reply", json!({"thread_id": "nope", "body": "x"})),
        dw("reply: an empty body", "reply", json!({"thread_id": "$th1", "body": ""})),
        dw("reply: a parameter it does not use", "reply", json!({"thread_id": "$th1", "body": "x", "quote": "y"})),
    ]
}

fn second_round() -> Vec<Call> {
    vec![
        dr("comments: after a person's reply", "comments", json!({"page_id": "$pg"})),
        dwp(
            "reply: the agent answers",
            "reply",
            json!({"thread_id": "$th1", "body": "Thanks"}),
            "own",
            "/comments/2/id",
        ),
        dw("edit_comment: nothing else", "edit_comment", json!({})),
        dw("edit_comment: no body", "edit_comment", json!({"comment_id": "$own"})),
        dw("edit_comment: a comment that does not exist", "edit_comment", json!({"comment_id": "nope", "body": "x"})),
        dw("edit_comment: its own", "edit_comment", json!({"comment_id": "$own", "body": "Thanks!"})),
        dw("edit_comment: an empty body", "edit_comment", json!({"comment_id": "$own", "body": " "})),
        dw("edit_comment: a person's comment", "edit_comment", json!({"comment_id": "$person", "body": "no"})),
        dw("delete_comment: nothing else", "delete_comment", json!({})),
        dw("delete_comment: a comment that does not exist", "delete_comment", json!({"comment_id": "nope"})),
        dw("delete_comment: a person's reply", "delete_comment", json!({"comment_id": "$person"})),
        dw("resolve: nothing else", "resolve", json!({})),
        dw("resolve: a thread that does not exist", "resolve", json!({"thread_id": "nope"})),
        dw("resolve: a page thread", "resolve", json!({"thread_id": "$th4"})),
        dw("resolve: inline", "resolve", json!({"thread_id": "$th1"})),
        dw("resolve: again", "resolve", json!({"thread_id": "$th1"})),
        dr("comments: open after resolving", "comments", json!({"page_id": "$pg", "state": "open"})),
        dr("comments: resolved after resolving", "comments", json!({"page_id": "$pg", "state": "resolved"})),
        dw("reply: to a resolved thread", "reply", json!({"thread_id": "$th1", "body": "Late reply"})),
        dw("reopen: a thread", "reopen", json!({"thread_id": "$th1"})),
        dw("reopen: a thread that is open", "reopen", json!({"thread_id": "$th1"})),
        dw("reopen: a thread that does not exist", "reopen", json!({"thread_id": "nope"})),
        dw("delete_comment: its own reply", "delete_comment", json!({"comment_id": "$own"})),
        dw("delete_comment: a first comment removes the thread", "delete_comment", json!({"comment_id": "$first2"})),
        dr("comments: the threads left", "comments", json!({"page_id": "$pg"})),
        // batches
        dw(
            "items: comments on several quotes",
            "comment",
            json!({"page_id": "$pg", "items": [{"body": "a", "quote": "Rollback"}, {"body": "b"}, {"body": "c", "quote": "not on the page"}, {"quote": "Undo the deploy"}]}),
        ),
        dw(
            "items: replies",
            "reply",
            json!({"body": "ok", "items": [{"thread_id": "$th3"}, {"thread_id": "nope"}, {"thread_id": "$th5", "body": "own text"}]}),
        ),
        dw(
            "items: resolve",
            "resolve",
            json!({"items": [{"thread_id": "$th2"}, {"thread_id": "$th3"}, {"thread_id": "$th4"}]}),
        ),
        dw("items: reopen", "reopen", json!({"items": [{"thread_id": "$th2"}, {"thread_id": "nope"}]})),
        dw(
            "items: edit does not take them",
            "edit_comment",
            json!({"comment_id": "$own", "body": "x", "items": [{"body": "y"}]}),
        ),
        dw(
            "items: an item that is not an object",
            "comment",
            json!({"page_id": "$pg", "body": "x", "items": [5, null, {"body": "z"}]}),
        ),
        dr("comments: the end", "comments", json!({"page_id": "$pg"})),
        dw(
            "edit: a comment is on the published text",
            "edit",
            json!({"page_id": "$pg", "section": "Steps", "markdown": "Restart nothing.", "mode": "replace"}),
        ),
        dr("comments: after the edit orphaned a quote", "comments", json!({"page_id": "$pg"})),
        dw("comment: on a page in the bin", "comment", json!({"page_id": "$pg2", "body": "before"})),
        dw("delete: the page", "delete", json!({"page_id": "$pg2"})),
        dw("comment: on a deleted page", "comment", json!({"page_id": "$pg2", "body": "x"})),
        dr("comments: a deleted page", "comments", json!({"page_id": "$pg2"})),
    ]
}

#[tokio::test]
async fn docs_comments_answer_as_python_does() {
    let s = common::start().await;
    let f = Fixtures::new();
    let mut run = Run::new(s.mcp());
    run.run(setup()).await;
    run.run(first_round()).await;
    // a person replies through the REST API; the agent sees it
    let c = s.client();
    let thread = run.id("th1");
    let reply = s
        .client()
        .header("x-actor", "user")
        .post(&format!("/docs/comments/threads/{thread}/replies"), json!({"body": "The queue worker."}))
        .await;
    reply.assert_status(201);
    run.ids.insert("person".into(), reply.json()["comments"][1]["id"].as_str().expect("a comment id").to_string());
    // the first comment of the second thread, to delete the thread with it
    let listed = run.mcp.call_tool("docs_read", json!({"action": "comments", "page_id": run.id("pg")})).await.json();
    let second = listed["threads"].as_array().expect("threads").iter().find(|t| t["id"] == json!(run.id("th2")));
    run.ids
        .insert("first2".into(), second.expect("the thread")["comments"][0]["id"].as_str().expect("an id").to_string());
    run.run(second_round()).await;
    for (name, path) in [
        ("rest: the comment events", format!("/projects/{}/docs/comment-events?recipient=user", run.id("p"))),
        ("rest: the events of the agent", format!("/projects/{}/docs/comment-events?recipient=Bao", run.id("p"))),
        ("rest: the threads", format!("/docs/pages/{}/comments", run.id("pg"))),
    ] {
        let r = c.get(&path).await;
        run.got.insert(name.to_string(), json!({"status": r.status, "body": r.json()}));
    }
    let got = finish(run, &f.folders(&[]));
    golden("mcp_tool_calls_docs_comments.json", &got);
    let _ = call;
}
