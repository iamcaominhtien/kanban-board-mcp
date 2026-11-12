//! `tests/test_docs_comments.py`: inline threads, page comments, replies, mentions, the comment events (Activity), unread
//! dots, anchors across publishes and the Recycle Bin. The pure anchor tests of that file are in `kb-doctext`
//! (`tests/test_docs_comments.rs`); `test_snippet_names_images_and_diagrams` is here (a pure function of this crate).
//! The notification rows the events lead to (`GET /notifications`) are checked at the end, as the centre writes them.

mod common;

use std::time::Duration;

use common::{count, id, member, pid, publish};
use kb_doctext::docs_anchors::MAX_QUOTE;
use serde_json::{Value, json};
use testkit::{Client, Server, skip_unless_available};

const DOC: &str = "# API\n\n\
    Every route requires a bearer token; rotation rules live in [[Auth]].\n\n\
    ## Limits\n\n\
    Rate limits are not enforced yet. Tracked in KAN-12.\n\n\
    | Method | Path |\n|---|---|\n| GET | /tickets |\n";

/// The `c`, `pid` and `page` fixtures: a server, a project and a published page "API".
macro_rules! setup {
    ($name:expr) => {{
        if !skip_unless_available($name) {
            return;
        }
        let s = Server::start().await;
        let c = s.client();
        let pid = pid(&c).await;
        let page = c.post(&format!("/projects/{pid}/docs/pages"), json!({"title": "API"})).await.json();
        publish(&c, &page, DOC, None).await;
        (s, c, pid, page)
    }};
}

fn as_(c: &Client, name: &str) -> Client {
    c.clone().header("x-actor", name)
}

/// `inline(c, page, quote, body, actor)`: start an inline thread on the default selection.
async fn inline(c: &Client, page: &Value, quote: &str, body: &str, actor: &str) -> Value {
    let r = as_(c, actor)
        .post(
            &format!("/docs/pages/{}/comments", id(page)),
            json!({
                "kind": "inline",
                "body": body,
                "anchor": {
                    "quote": quote,
                    "prefix": "Every route requires a ",
                    "suffix": "; rotation",
                    "section": "api",
                },
            }),
        )
        .await;
    assert_eq!(r.status, 201, "{}", r.text());
    r.json()
}

async fn inline_default(c: &Client, page: &Value) -> Value {
    inline(c, page, "bearer token", "Is this enough?", "user").await
}

async fn comments(c: &Client, page: &Value) -> Value {
    c.get(&format!("/docs/pages/{}/comments", id(page))).await.json()
}

fn ids(threads: &Value) -> Vec<Value> {
    threads.as_array().unwrap().iter().map(|t| t["id"].clone()).collect()
}

// --- threads, replies, page comments ------------------------------------------

#[tokio::test]
async fn test_inline_thread_roundtrip() {
    let (_s, c, _pid, page) = setup!("test_inline_thread_roundtrip");
    let t = inline_default(&c, &page).await;
    assert!(t["number"] == 1 && t["status"] == "open");
    assert!(t["anchor"]["state"] == "attached" && !t["anchor"]["pos"].is_null());
    assert_eq!(t["comments"][0]["author"], "user");

    let r = c.post(&format!("/docs/comments/threads/{}/replies", id(&t)), json!({"body": "Yes."})).await;
    assert!(r.status == 201 && r.json()["comments"].as_array().unwrap().len() == 2);

    let listed = comments(&c, &page).await;
    assert_eq!(listed["counts"], json!({"all": 1, "open": 1, "resolved": 0, "orphaned": 0, "page": 0}));
    assert!(listed["role"] == "admin" && listed["me"] == "user");
}

#[tokio::test]
async fn test_numbers_follow_page_order() {
    let (_s, c, _pid, page) = setup!("test_numbers_follow_page_order");
    let later = inline(&c, &page, "Rate limits are not enforced", "Is this enough?", "user").await;
    let first = inline(&c, &page, "bearer token", "Is this enough?", "user").await;
    let listed = comments(&c, &page).await["threads"].clone();
    let number = |t: &Value| listed.as_array().unwrap().iter().find(|x| x["id"] == t["id"]).unwrap()["number"].clone();
    assert!(number(&first) == 1 && number(&later) == 2);
}

#[tokio::test]
async fn test_state_filter_and_resolve_reopen() {
    let (_s, c, _pid, page) = setup!("test_state_filter_and_resolve_reopen");
    let t = inline_default(&c, &page).await;
    let r = c.post_empty(&format!("/docs/comments/threads/{}/resolve", id(&t))).await;
    assert_eq!(r.status, 200);
    let body = r.json();
    assert!(body["status"] == "resolved" && body["resolved_by"] == "user");
    assert!(!body["resolved_at"].is_null() && body["number"].is_null());

    let pid_ = id(&page);
    let open = c.get(&format!("/docs/pages/{pid_}/comments?state=open")).await.json();
    assert_eq!(open["threads"], json!([]));
    let resolved = c.get(&format!("/docs/pages/{pid_}/comments?state=resolved")).await.json();
    assert_eq!(ids(&resolved["threads"]), [t["id"].clone()]);

    let r = c.post_empty(&format!("/docs/comments/threads/{}/reopen", id(&t))).await;
    assert!(r.json()["status"] == "open" && r.json()["resolved_by"].is_null());
    let bad = c.get(&format!("/docs/pages/{pid_}/comments?state=nope")).await;
    assert_eq!(bad.status, 422);
}

#[tokio::test]
async fn test_page_comments_and_validation() {
    let (_s, c, _pid, page) = setup!("test_page_comments_and_validation");
    let r = c.post(&format!("/docs/pages/{}/comments", id(&page)), json!({"kind": "page", "body": "Looks good"})).await;
    assert!(r.status == 201 && r.json()["anchor"].is_null());
    let only = c.get(&format!("/docs/pages/{}/comments?kind=page", id(&page))).await.json();
    assert!(only["threads"].as_array().unwrap().len() == 1 && only["counts"]["page"] == 1);
    // page comments cannot be resolved
    assert_eq!(c.post_empty(&format!("/docs/comments/threads/{}/resolve", id(&r.json()))).await.status, 422);

    for payload in [
        json!({"kind": "page", "body": "   "}),
        json!({"kind": "inline", "body": "x"}),
        json!({"kind": "inline", "body": "x", "anchor": {"quote": "a".repeat(MAX_QUOTE + 1)}}),
        json!({"kind": "weird", "body": "x"}),
    ] {
        let bad = c.post(&format!("/docs/pages/{}/comments", id(&page)), payload.clone()).await;
        assert_eq!(bad.status, 422, "{payload}");
    }
}

#[tokio::test]
async fn test_edit_marks_edited_and_only_author_edits() {
    let (_s, c, pid, page) = setup!("test_edit_marks_edited_and_only_author_edits");
    member(&c, &pid, "Linh", "member").await;
    let t = inline(&c, &page, "bearer token", "Is this enough?", "Linh").await;
    let cid = t["comments"][0]["id"].as_str().unwrap().to_string();
    let r = as_(&c, "Linh").patch(&format!("/docs/comments/{cid}"), json!({"body": "Edited"})).await;
    assert_eq!(r.status, 200);
    assert_eq!(r.json()["comments"][0]["body"], "Edited");
    assert!(!r.json()["comments"][0]["edited_at"].is_null());
    // even the admin cannot edit someone else's comment
    let other = c.patch(&format!("/docs/comments/{cid}"), json!({"body": "Hack"})).await;
    assert!(other.status == 403 && other.json()["detail"]["code"] == "not_author");
}

#[tokio::test]
async fn test_delete_first_comment_removes_thread_reply_keeps_it() {
    let (_s, c, _pid, page) = setup!("test_delete_first_comment_removes_thread_reply_keeps_it");
    let t = inline_default(&c, &page).await;
    let r = c.post(&format!("/docs/comments/threads/{}/replies", id(&t)), json!({"body": "Reply"})).await;
    let reply_id = r.json()["comments"][1]["id"].as_str().unwrap().to_string();
    let out = c.delete(&format!("/docs/comments/{reply_id}")).await;
    assert_eq!(out.json(), json!({"deleted": "comment", "thread_id": t["id"]}));
    let listed = comments(&c, &page).await;
    assert_eq!(listed["threads"][0]["comments"].as_array().unwrap().len(), 1);

    let out = c.delete(&format!("/docs/comments/{}", t["comments"][0]["id"].as_str().unwrap())).await;
    assert_eq!(out.json()["deleted"], "thread");
    let listed = comments(&c, &page).await;
    assert!(listed["threads"] == json!([]) && listed["counts"]["all"] == 0);
}

// --- permissions ----------------------------------------------------------------

#[tokio::test]
async fn test_viewer_reads_but_cannot_write() {
    let (_s, c, pid, page) = setup!("test_viewer_reads_but_cannot_write");
    member(&c, &pid, "Vera", "viewer").await;
    let t = inline_default(&c, &page).await;
    let listed = as_(&c, "Vera").get(&format!("/docs/pages/{}/comments", id(&page))).await;
    assert_eq!(listed.json()["role"], "viewer");
    assert_eq!(listed.json()["threads"][0]["can_reply"], false);

    let cases = [
        (format!("/docs/pages/{}/comments", id(&page)), Some(json!({"kind": "page", "body": "hi"}))),
        (format!("/docs/comments/threads/{}/replies", id(&t)), Some(json!({"body": "hi"}))),
        (format!("/docs/comments/threads/{}/resolve", id(&t)), None),
    ];
    for (url, payload) in cases {
        let r = match payload {
            Some(p) => as_(&c, "Vera").post(&url, p).await,
            None => as_(&c, "Vera").post_empty(&url).await,
        };
        assert_eq!(r.status, 403, "{url}");
        assert_eq!(r.json()["detail"]["code"], "read_only", "{url}");
    }
    // a name that is not a project member is read-only as well
    let r =
        as_(&c, "Stranger").post(&format!("/docs/comments/threads/{}/replies", id(&t)), json!({"body": "hi"})).await;
    assert_eq!(r.status, 403);
}

#[tokio::test]
async fn test_member_resolves_but_only_admin_deletes_any() {
    let (_s, c, pid, page) = setup!("test_member_resolves_but_only_admin_deletes_any");
    member(&c, &pid, "Mia", "member").await;
    member(&c, &pid, "Ada", "admin").await;
    let t = inline(&c, &page, "bearer token", "Is this enough?", "Mia").await;
    let cid = t["comments"][0]["id"].as_str().unwrap().to_string();
    assert_eq!(as_(&c, "Mia").post_empty(&format!("/docs/comments/threads/{}/resolve", id(&t))).await.status, 200);

    // another member cannot delete Mia's comment
    member(&c, &pid, "Max", "member").await;
    let r = as_(&c, "Max").delete(&format!("/docs/comments/{cid}")).await;
    assert_eq!(r.status, 403);
    // an admin can
    let r = as_(&c, "Ada").delete(&format!("/docs/comments/{cid}")).await;
    assert!(r.status == 200 && r.json()["deleted"] == "thread");
}

#[tokio::test]
async fn test_member_role_can_be_changed() {
    if !skip_unless_available("test_member_role_can_be_changed") {
        return;
    }
    let s = Server::start().await;
    let c = s.client();
    let pid = pid(&c).await;
    let m = member(&c, &pid, "Mia", "member").await;
    let r = c.patch(&format!("/projects/{pid}/members/{}", id(&m)), json!({"role": "viewer"})).await;
    assert_eq!(r.json()["role"], "viewer");
    let bad = c.patch(&format!("/projects/{pid}/members/{}", id(&m)), json!({"role": "boss"})).await;
    assert_eq!(bad.status, 422);
}

// --- mentions, notifications, activity -----------------------------------------

#[tokio::test]
async fn test_mentions_are_limited_to_project_members() {
    let (_s, c, pid, page) = setup!("test_mentions_are_limited_to_project_members");
    member(&c, &pid, "Linh Pham", "member").await;
    let t = inline(&c, &page, "bearer token", "@Linh Pham please check, cc @Nobody", "user").await;
    let names: Vec<&str> =
        t["comments"][0]["mentions"].as_array().unwrap().iter().map(|m| m["name"].as_str().unwrap()).collect();
    assert_eq!(names, ["Linh Pham"]);
}

#[tokio::test]
async fn test_picker_mentions_are_understood() {
    let (_s, c, pid, page) = setup!("test_picker_mentions_are_understood");
    let linh = member(&c, &pid, "Linh Pham", "member").await;
    let body = format!("cc @[Linh Pham](member:{}) and @[Ghost](member:nope)", id(&linh));
    let t = inline(&c, &page, "bearer token", &body, "user").await;
    let names: Vec<&str> =
        t["comments"][0]["mentions"].as_array().unwrap().iter().map(|m| m["name"].as_str().unwrap()).collect();
    assert_eq!(names, ["Linh Pham"]);
    let got = c.get_query(&format!("/projects/{pid}/docs/comment-events"), &[("recipient", "Linh Pham")]).await.json();
    assert!(got[0]["snippet"].as_str().unwrap().starts_with("cc @Linh Pham and"));
}

#[tokio::test]
async fn test_notifications_reach_only_the_right_people() {
    let (_s, c, pid, page) = setup!("test_notifications_reach_only_the_right_people");
    for name in ["Hoa", "Linh", "Tuan", "Bystander"] {
        member(&c, &pid, name, "member").await;
    }
    let thread = inline(&c, &page, "bearer token", "Starting this thread", "Tuan").await;
    let tid = id(&thread);
    // Hoa replies and mentions Linh
    as_(&c, "Hoa").post(&format!("/docs/comments/threads/{tid}/replies"), json!({"body": "Good catch @Linh"})).await;
    // Linh replies: notifies the starter (Tuan) and the earlier replier (Hoa), not herself or bystanders
    as_(&c, "Linh").post(&format!("/docs/comments/threads/{tid}/replies"), json!({"body": "Thanks"})).await;

    let ev = |r: &str| {
        let url = format!("/projects/{pid}/docs/comment-events");
        let c = c.clone();
        let r = r.to_string();
        async move { c.get_query(&url, &[("recipient", r.as_str())]).await.json() }
    };
    let kinds = |events: &Value| -> Vec<String> {
        events.as_array().unwrap().iter().map(|e| e["kind"].as_str().unwrap().to_string()).collect()
    };
    let linh = ev("Linh").await;
    assert!(kinds(&linh) == ["reply"] && linh[0]["mentioned"] == json!(["Linh"]));
    let tuan = ev("Tuan").await;
    assert!(kinds(&tuan).iter().all(|k| k == "reply") && tuan.as_array().unwrap().len() == 2);
    let hoa = ev("Hoa").await;
    assert!(hoa.as_array().unwrap().len() == 1 && hoa[0]["actor"] == "Linh");
    assert_eq!(ev("Bystander").await, json!([]));

    // Activity lists everything, newest first
    let all = c.get(&format!("/projects/{pid}/docs/comment-events")).await.json();
    assert_eq!(kinds(&all), ["reply", "reply", "comment"]);
    assert_eq!(all[0]["page_title"], "API");
}

#[tokio::test]
async fn test_mention_in_a_new_comment_notifies_the_mentioned() {
    let (_s, c, pid, page) = setup!("test_mention_in_a_new_comment_notifies_the_mentioned");
    member(&c, &pid, "Linh", "member").await;
    inline(&c, &page, "bearer token", "@Linh take a look", "user").await;
    let got = c.get_query(&format!("/projects/{pid}/docs/comment-events"), &[("recipient", "Linh")]).await.json();
    let kinds: Vec<&str> = got.as_array().unwrap().iter().map(|e| e["kind"].as_str().unwrap()).collect();
    assert_eq!(kinds, ["comment"]);
}

#[tokio::test]
async fn test_resolve_notifies_starter_and_repliers_but_not_the_actor() {
    let (_s, c, pid, page) = setup!("test_resolve_notifies_starter_and_repliers_but_not_the_actor");
    member(&c, &pid, "Tuan", "member").await;
    member(&c, &pid, "Hoa", "member").await;
    let t = inline(&c, &page, "bearer token", "Is this enough?", "Tuan").await;
    as_(&c, "Hoa").post(&format!("/docs/comments/threads/{}/replies", id(&t)), json!({"body": "ok"})).await;
    as_(&c, "Hoa").post_empty(&format!("/docs/comments/threads/{}/resolve", id(&t))).await;
    let kinds_of = |v: Value| -> Vec<String> {
        v.as_array().unwrap().iter().map(|e| e["kind"].as_str().unwrap().to_string()).collect()
    };
    let tuan = c.get_query(&format!("/projects/{pid}/docs/comment-events"), &[("recipient", "Tuan")]).await.json();
    assert!(kinds_of(tuan).contains(&"resolved".to_string()));
    let hoa = c.get_query(&format!("/projects/{pid}/docs/comment-events"), &[("recipient", "Hoa")]).await.json();
    assert!(!kinds_of(hoa).contains(&"resolved".to_string()));
}

#[tokio::test]
async fn test_unread_dot() {
    let (_s, c, pid, page) = setup!("test_unread_dot");
    member(&c, &pid, "Linh", "member").await;
    let t = inline(&c, &page, "bearer token", "Is this enough?", "Linh").await;
    assert_eq!(t["unread"], false); // your own thread
    let mine = comments(&c, &page).await["threads"][0].clone();
    assert_eq!(mine["unread"], true); // someone else wrote it
    let read = c.post_empty(&format!("/docs/comments/threads/{}/read", id(&t))).await;
    assert_eq!(read.json()["unread"], false);
    as_(&c, "Linh").post(&format!("/docs/comments/threads/{}/replies", id(&t)), json!({"body": "more"})).await;
    let again = comments(&c, &page).await["threads"][0].clone();
    assert_eq!(again["unread"], true);
}

// --- anchors across publishes --------------------------------------------------

#[tokio::test]
async fn test_publish_keeps_moves_and_orphans() {
    let (_s, c, _pid, page) = setup!("test_publish_keeps_moves_and_orphans");
    let attached = inline(&c, &page, "bearer token", "Is this enough?", "user").await;
    let moved = inline(&c, &page, "Rate limits are not enforced yet.", "Is this enough?", "user").await;
    let gone = inline(&c, &page, "Tracked in KAN-12", "Is this enough?", "user").await;

    let new = "# API\n\nIntro paragraph added above.\n\n\
        Every route requires a bearer token; rotation rules live in [[Auth]].\n\n\
        ## Limits\n\n\
        Rate limits are not yet enforced. Nothing else.\n";
    publish(&c, &page, new, None).await;
    let listed = comments(&c, &page).await;
    let by = |t: &Value| listed["threads"].as_array().unwrap().iter().find(|x| x["id"] == t["id"]).unwrap().clone();
    assert_eq!(by(&attached)["anchor"]["state"], "attached");
    assert!(by(&attached)["anchor"]["pos"].as_i64() > attached["anchor"]["pos"].as_i64()); // moved down
    assert_eq!(by(&moved)["anchor"]["state"], "attached"); // slightly edited: kept
    assert_eq!(by(&gone)["anchor"]["state"], "orphaned");
    assert!(by(&gone)["number"].is_null());
    let counts = comments(&c, &page).await["counts"].clone();
    assert!(counts["orphaned"] == 1 && counts["open"] == 3);
}

#[tokio::test]
async fn test_anchor_preview_warns_before_publishing() {
    let (_s, c, _pid, page) = setup!("test_anchor_preview_warns_before_publishing");
    inline(&c, &page, "bearer token", "Is this enough?", "user").await;
    inline(&c, &page, "Rate limits are not enforced", "Is this enough?", "user").await;
    let r = c
        .post(
            &format!("/docs/pages/{}/comments/anchor-preview", id(&page)),
            json!({"markdown": "# API\n\nA bearer token is needed.\n"}),
        )
        .await;
    assert_eq!(r.json()["count"], 1);
    assert_eq!(r.json()["orphaned"][0]["quote"], "Rate limits are not enforced");
    // nothing changed
    let counts = comments(&c, &page).await["counts"].clone();
    assert_eq!(counts["orphaned"], 0);
}

#[tokio::test]
async fn test_orphaned_thread_can_be_reattached_or_resolved() {
    let (_s, c, _pid, page) = setup!("test_orphaned_thread_can_be_reattached_or_resolved");
    let t = inline(&c, &page, "Tracked in KAN-12", "Is this enough?", "user").await;
    publish(&c, &page, "# API\n\nBrand new text with a bearer token.\n", None).await;
    let orphan = comments(&c, &page).await["threads"][0].clone();
    assert_eq!(orphan["anchor"]["state"], "orphaned");

    let r = c
        .post(
            &format!("/docs/comments/threads/{}/reattach", id(&t)),
            json!({"quote": "bearer token", "prefix": "with a ", "suffix": ".", "section": "api"}),
        )
        .await;
    assert_eq!(r.status, 200);
    assert!(r.json()["anchor"]["state"] == "attached" && r.json()["number"] == 1);

    publish(&c, &page, "# API\n\nNothing matches now.\n", None).await;
    let resolved = c.post_empty(&format!("/docs/comments/threads/{}/resolve", id(&t))).await;
    assert_eq!(resolved.json()["status"], "resolved");
}

#[tokio::test]
async fn test_orphan_comes_back_when_text_returns_via_restore() {
    let (_s, c, _pid, page) = setup!("test_orphan_comes_back_when_text_returns_via_restore");
    let t = inline(&c, &page, "bearer token", "Is this enough?", "user").await;
    publish(&c, &page, "# API\n\nCompletely different.\n", None).await;
    assert_eq!(comments(&c, &page).await["counts"]["orphaned"], 1);
    let r = c.post(&format!("/docs/pages/{}/versions/1/restore", id(&page)), json!({})).await;
    assert_eq!(r.status, 200, "{}", r.text());
    let listed = comments(&c, &page).await;
    assert_eq!(listed["counts"]["orphaned"], 0);
    assert_eq!(listed["threads"][0]["id"], t["id"]);
}

#[tokio::test]
async fn test_comments_follow_the_page_through_history() {
    let (_s, c, _pid, page) = setup!("test_comments_follow_the_page_through_history");
    let t = inline_default(&c, &page).await;
    for i in 0..2 {
        publish(&c, &page, &format!("{DOC}\nExtra {i}.\n"), None).await;
    }
    let listed = comments(&c, &page).await;
    assert_eq!(ids(&listed["threads"]), [t["id"].clone()]);
}

// --- recycle bin -----------------------------------------------------------------

#[tokio::test]
async fn test_deleting_a_page_hides_comments_and_restore_brings_them_back() {
    let (_s, c, _pid, page) = setup!("test_deleting_a_page_hides_comments_and_restore_brings_them_back");
    let t = inline_default(&c, &page).await;
    assert_eq!(c.delete(&format!("/docs/pages/{}", id(&page))).await.status, 200);
    let gone = c.get(&format!("/docs/pages/{}/comments", id(&page))).await;
    assert_eq!(gone.status, 410); // in the Recycle Bin
    assert_eq!(c.post_empty(&format!("/docs/pages/{}/restore", id(&page))).await.status, 200);
    let back = comments(&c, &page).await;
    assert_eq!(ids(&back["threads"]), [t["id"].clone()]);
}

#[tokio::test]
async fn test_purging_a_page_deletes_its_comments() {
    let (s, c, _pid, page) = setup!("test_purging_a_page_deletes_its_comments");
    inline_default(&c, &page).await;
    c.delete(&format!("/docs/pages/{}", id(&page))).await;
    assert_eq!(c.delete(&format!("/docs/pages/{}/purge", id(&page))).await.status, 204);
    assert_eq!(count(&s, "SELECT COUNT(*) FROM docs_comment_thread", &[]).await, 0);
    assert_eq!(count(&s, "SELECT COUNT(*) FROM docs_comment", &[]).await, 0);
    // the events of the page go with it
    assert_eq!(count(&s, "SELECT COUNT(*) FROM docs_comment_event", &[]).await, 0);
}

#[tokio::test]
async fn test_selection_over_several_blocks() {
    let (_s, c, _pid, page) = setup!("test_selection_over_several_blocks");
    let quote = "rotation rules live in Auth. Limits Rate limits are not enforced";
    let t = inline(&c, &page, quote, "Is this enough?", "user").await;
    assert!(t["anchor"]["state"] == "attached" && !t["anchor"]["pos"].is_null());
    assert_eq!(t["anchor"]["quote"], quote);

    // an edit elsewhere keeps it attached; removing the text it spans orphans it
    publish(&c, &page, &format!("{DOC}\nA new closing line.\n"), None).await;
    let listed = comments(&c, &page).await["threads"].clone();
    assert_eq!(listed[0]["anchor"]["state"], "attached");
    publish(&c, &page, &DOC.replace("## Limits\n\n", ""), None).await;
    let listed = comments(&c, &page).await["threads"].clone();
    assert_eq!(listed[0]["anchor"]["state"], "orphaned");
}

/// Python registers `DELETE /tickets/{ticket_id}/docs/{page_id}` before the Docs AI routes of
/// `/tickets/{ticket_id}/docs/comments`, so a DELETE on that path unlinks a page called "comments": the answer of
/// the page route (not a 405 of the comments path), as the router of the app picks the first match.
#[tokio::test]
async fn test_delete_on_the_ticket_docs_comments_path_goes_to_the_page_route() {
    let (_s, c, pid, _page) = setup!("test_delete_on_the_ticket_docs_comments_path_goes_to_the_page_route");
    let ticket = c.post(&format!("/projects/{pid}/tickets"), json!({"title": "T", "type": "task"})).await.json();
    let viaroute = c.delete(&format!("/tickets/{}/docs/comments", id(&ticket))).await;
    let direct = c.delete(&format!("/tickets/{}/docs/some-page", id(&ticket))).await;
    assert_eq!(viaroute.status, direct.status, "{} / {}", viaroute.text(), direct.text());
    assert_ne!(viaroute.status, 405);
    assert_eq!(viaroute.json()["detail"]["code"], direct.json()["detail"]["code"]);
}

#[test]
fn test_snippet_names_images_and_diagrams() {
    let body = "Look at this\n\n![shot.png](/uploads/a.png)\n\n[Auth flow](diagram:dg_12345678) and [docs](https://x.y) @[Ann](member:m1)";
    assert_eq!(kb_docs::docs_comments::snippet_of(body), "Look at this [image] [diagram] and docs @Ann");
}

// --- the notification centre (Rust port: the notification rows the events lead to) -----------------------------

/// The `(kind, title)` of a person's notifications, once `want` of them are written (the centre's loop writes them
/// within a second); every row if they do not come.
async fn notices(c: &Client, who: &str, want: usize) -> Vec<(String, String)> {
    let me = as_(c, who);
    let mut rows = Vec::new();
    for _ in 0..60 {
        let r = me.get("/notifications?view=page&filter=all").await;
        assert_eq!(r.status, 200, "{}", r.text());
        rows = r.json()["items"]
            .as_array()
            .unwrap()
            .iter()
            .map(|n| (n["kind"].as_str().unwrap().to_string(), n["title"].as_str().unwrap().to_string()))
            .collect();
        if rows.len() >= want {
            break;
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
    rows.sort();
    rows
}

#[tokio::test]
async fn test_comment_events_become_notifications() {
    let (_s, c, pid, page) = setup!("test_comment_events_become_notifications");
    for name in ["Hoa", "Linh", "Tuan", "Bystander"] {
        member(&c, &pid, name, "member").await;
    }
    let thread = inline(&c, &page, "bearer token", "Starting this thread", "Tuan").await;
    let tid = id(&thread);
    // a reply that mentions Linh, a reply of Linh, then Linh resolves the thread
    as_(&c, "Hoa").post(&format!("/docs/comments/threads/{tid}/replies"), json!({"body": "Good catch @Linh"})).await;
    as_(&c, "Linh").post(&format!("/docs/comments/threads/{tid}/replies"), json!({"body": "Thanks"})).await;
    as_(&c, "Linh").post_empty(&format!("/docs/comments/threads/{tid}/resolve")).await;

    // Linh: the mention (Needs you); her own reply and resolve are not for her
    assert_eq!(notices(&c, "Linh", 1).await, [("mention".to_string(), "Hoa mentioned you".to_string())]);
    // Tuan started the thread: the replies and the resolve are for information (the centre may merge them into one
    // row, "3 new comments in threads you follow")
    let tuan = notices(&c, "Tuan", 1).await;
    assert!(!tuan.is_empty() && tuan.iter().all(|(k, _)| k == "comment"), "{tuan:?}");
    // Hoa replied in the thread: she hears about Linh's reply and the resolve
    let hoa = notices(&c, "Hoa", 1).await;
    assert!(hoa.iter().all(|(k, _)| k == "comment") && !hoa.is_empty(), "{hoa:?}");
    // a bystander hears nothing
    tokio::time::sleep(Duration::from_millis(1500)).await;
    assert_eq!(notices(&c, "Bystander", 0).await, Vec::<(String, String)>::new());
}
