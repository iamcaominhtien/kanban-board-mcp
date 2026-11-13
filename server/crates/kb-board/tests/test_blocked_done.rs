//! `tests/test_blocked_done.py`: a ticket another one still blocks cannot go to Done (found by the live runs of
//! #269): the API and the quick status change refuse it and name the blocker; a blocker that is Done or Won't do,
//! or a block removed, lets it go. The Python test also reads the refusal through the MCP tool `update_ticket`,
//! which reaches the same service function; that line is ported with the MCP tools.

mod common;

use common::id;
use serde_json::json;
use testkit::{Client, Server, skip_unless_available};

/// `_project` of `tests/ai_helpers.py`: the project's id and the id of its member An Nguyen.
async fn _project(c: &Client) -> (String, String) {
    let p = c.post("/projects", json!({"name": "Kanban Board", "prefix": "KAN", "color": "#2E6F40"})).await.json();
    let an = c.post(&format!("/projects/{}/members", id(&p)), json!({"name": "An Nguyen"})).await.json();
    (id(&p), id(&an))
}

/// `_ticket` of `tests/ai_helpers.py`.
async fn _ticket(c: &Client, pid: &str, title: &str) -> String {
    let r = c.post(&format!("/projects/{pid}/tickets"), json!({"title": title, "status": "todo"})).await;
    id(&r.json())
}

async fn _blocked_pair(c: &Client, pid: &str) -> (String, String) {
    let blocker = _ticket(c, pid, "Store the goal").await;
    let blocked = _ticket(c, pid, "Show the goal").await;
    let r = c.post_empty(&format!("/tickets/{blocker}/blocks/{blocked}")).await;
    assert_eq!(r.status, 200, "{}", r.text());
    (blocker, blocked)
}

#[tokio::test]
async fn test_done_is_refused_while_a_blocker_is_open_and_names_it() {
    if !skip_unless_available("test_done_is_refused_while_a_blocker_is_open_and_names_it") {
        return;
    }
    let s = Server::start().await;
    let c = s.client();
    let (pid, _) = _project(&c).await;
    let (blocker, blocked) = _blocked_pair(&c, &pid).await;
    let r = c.patch(&format!("/tickets/{blocked}"), json!({"status": "done"})).await;
    assert_eq!(r.status, 400, "{}", r.text());
    let detail = r.detail().as_str().expect("detail").to_string();
    assert!(detail.contains(&blocker) && detail.contains("todo"));
    // the quick status change (dragging the card) is refused the same way
    let r = c.patch(&format!("/tickets/{blocked}/status"), json!({"status": "done"})).await;
    assert!(r.status == 400 || r.status == 422, "{}", r.text());
    assert_eq!(c.get(&format!("/tickets/{blocked}")).await.json()["status"], "todo");
    // other columns are not affected
    let r = c.patch(&format!("/tickets/{blocked}"), json!({"status": "review"})).await;
    assert_eq!(r.status, 200, "{}", r.text());
}

#[tokio::test]
async fn test_done_goes_through_once_the_blocker_is_done_or_the_block_removed() {
    if !skip_unless_available("test_done_goes_through_once_the_blocker_is_done_or_the_block_removed") {
        return;
    }
    let s = Server::start().await;
    let c = s.client();
    let (pid, _) = _project(&c).await;
    let (blocker, blocked) = _blocked_pair(&c, &pid).await;
    assert_eq!(c.patch(&format!("/tickets/{blocker}"), json!({"status": "done"})).await.status, 200);
    let r = c.patch(&format!("/tickets/{blocked}"), json!({"status": "done"})).await;
    assert_eq!(r.status, 200, "{}", r.text());

    let (blocker2, blocked2) = _blocked_pair(&c, &pid).await;
    let r = c.delete(&format!("/tickets/{blocker2}/blocks/{blocked2}")).await;
    assert!(r.status == 200 || r.status == 204, "{}", r.text());
    let r = c.patch(&format!("/tickets/{blocked2}"), json!({"status": "done"})).await;
    assert_eq!(r.status, 200, "{}", r.text());
}

#[tokio::test]
async fn test_a_blocker_that_will_not_be_done_does_not_hold_the_ticket() {
    if !skip_unless_available("test_a_blocker_that_will_not_be_done_does_not_hold_the_ticket") {
        return;
    }
    let s = Server::start().await;
    let c = s.client();
    let (pid, _) = _project(&c).await;
    let (blocker, blocked) = _blocked_pair(&c, &pid).await;
    let r = c
        .patch(&format!("/tickets/{blocker}"), json!({"status": "wont_do", "wont_do_reason": "Not needed after all"}))
        .await;
    assert_eq!(r.status, 200, "{}", r.text());
    let r = c.patch(&format!("/tickets/{blocked}"), json!({"status": "done"})).await;
    assert_eq!(r.status, 200, "{}", r.text());
}
