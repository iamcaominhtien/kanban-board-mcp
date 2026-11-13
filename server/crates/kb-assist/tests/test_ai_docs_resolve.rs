//! An AI member that resolves a Docs comment thread says what it did first (`server/tests/test_ai_docs_resolve.py`).
//!
//! The Python test calls the MCP tool `docs_write` (`action="resolve"` and `action="reply"`), which the MCP task
//! ports. Here are the service calls the tool makes (`docs_comments.add_reply` and `docs_comments.set_status`) with
//! the guard of a run entered, which is what the rule needs (`activity.current_ai`); the tool's own text for the
//! error waits with the tool.

// Unix only: it starts shell scripts, makes files executable or links them (Windows CI only compiles the tests).
#![cfg(unix)]

mod common;

use kb_base::ctx;
use kb_db::database;
use kb_docs::Error;
use kb_docs::docs_comments::Anchor;

fn anchor_on(quote: &str) -> Anchor {
    Anchor { quote: quote.to_string(), prefix: String::new(), suffix: String::new(), section: None }
}

#[tokio::test]
async fn test_an_ai_replies_in_a_thread_before_it_resolves_it() {
    let _guard = common::init().await;
    ctx::scope(async {
        let (context, pid, _member, _ticket) = common::run_context("kbr_resolve_token").await;
        let s = database::session();
        let doc = "# Auth\n\n## Tokens\n\nTokens expire after an hour.\n\nRotate the key often.\n";
        let page = kb_docs::docs::create_page(&s, &pid, "API", None, "blank", Some(doc)).await.expect("page");
        let page_id = page["id"].as_str().expect("id").to_string();
        let anchor = anchor_on("Tokens expire after an hour.");
        let thread = kb_docs::docs_comments::create_thread(&s, &page_id, "inline", "How long?", Some(&anchor), None)
            .await
            .expect("thread");
        let thread_id = thread["id"].as_str().expect("id").to_string();

        let tokens = kb_ai::guard::enter(&context);
        let refused = kb_docs::docs_comments::set_status(&s, &thread_id, "resolved").await;
        match refused {
            Err(Error::Docs(e)) => assert!(e.message.contains("Reply in this thread first"), "{}", e.message),
            other => panic!("an AI cannot resolve a thread it did not reply in: {other:?}"),
        }
        kb_docs::docs_comments::add_reply(&s, &thread_id, "Fixed in v2: added rotation.", None).await.expect("reply");
        let out = kb_docs::docs_comments::set_status(&s, &thread_id, "resolved").await.expect("resolve");
        kb_ai::guard::leave(tokens);
        assert_eq!(out["status"], "resolved");
        assert_eq!(out["resolved_by"], context.member_name.as_str());
        // a person resolving their own thread is not asked to reply
        let other_anchor = anchor_on("rotation");
        let other =
            kb_docs::docs_comments::create_thread(&s, &page_id, "inline", "And rotation?", Some(&other_anchor), None)
                .await
                .expect("thread");
        let done = kb_docs::docs_comments::set_status(&s, other["id"].as_str().expect("id"), "resolved")
            .await
            .expect("resolve");
        assert_eq!(done["status"], "resolved");
    })
    .await;
}
