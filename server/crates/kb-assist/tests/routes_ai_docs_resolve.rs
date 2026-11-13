//! An AI member that resolves a Docs comment thread says what it did first (`server/tests/test_ai_docs_resolve.py`,
//! through HTTP).
//!
//! The test of the Python file is one test whose first half calls the MCP tool `docs_write` as an AI run
//! (`action="resolve"` refused with "Reply in this thread first", `action="reply"`, then `resolve`, answering
//! `status == "resolved"` and `resolved_by`). That half needs the MCP tool and a run's token, and waits with the MCP
//! port (`kb-mcp`): left out. What goes through HTTP is its last part: a person resolving their own thread is not
//! asked to reply.

mod http;

use http::start;
use serde_json::json;

const DOC: &str = "# API\n\nEvery route requires a bearer token; rotation rules live in [[Auth]].\n\n## Limits\n\nRate limits are not enforced yet. Tracked in KAN-12.\n\n| Method | Path |\n|---|---|\n| GET | /tickets |\n";

/// `inline(c, page, quote, body)` of `test_docs_comments.py`.
async fn inline(c: &testkit::Client, page_id: &str, quote: &str, body: &str) -> serde_json::Value {
    let r = c
        .post(
            &format!("/docs/pages/{page_id}/comments"),
            json!({"kind": "inline", "body": body,
                   "anchor": {"quote": quote, "prefix": "Every route requires a ", "suffix": "; rotation",
                              "section": "api"}}),
        )
        .await;
    r.assert_status(201);
    r.json()
}

#[tokio::test]
async fn test_an_ai_replies_in_a_thread_before_it_resolves_it() {
    let Some(f) = start("test_an_ai_replies_in_a_thread_before_it_resolves_it", &[]).await else { return };
    let c = &f.c;
    let pid = f.board().await;
    let page = c.post(&format!("/projects/{pid}/docs/pages"), json!({"title": "API"})).await;
    page.assert_status(201);
    let page_id = http::id(&page.json());
    // `publish(c, page_id, DOC)`
    c.put(&format!("/docs/pages/{page_id}/draft"), json!({"markdown": DOC})).await;
    let cur = c.get(&format!("/docs/pages/{page_id}")).await.json();
    c.post(&format!("/docs/pages/{page_id}/publish"), json!({"base_version": cur["version"]})).await.assert_status(200);
    inline(c, &page_id, "bearer token", "Is this enough?").await;
    // a person resolving their own thread is not asked to reply
    let other = inline(c, &page_id, "rotation", "And rotation?").await;
    let r = c.post_empty(&format!("/docs/comments/threads/{}/resolve", http::id(&other))).await;
    r.assert_status(200);
}
