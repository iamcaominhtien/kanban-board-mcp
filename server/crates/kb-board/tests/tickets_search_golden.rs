//! The search of the ticket list against `contract/golden/ticket_search.json` (made by
//! `contract/golden/gen_ticket_search.py` with the Python scoring): the 240 tickets of the file are put in a
//! project, and for each query `GET /projects/{id}/tickets?q=` must return the ids the file lists, in its order.
//! Run on both servers: on the Python one it proves the file says what the server does.

mod common;

use common::{NOW, db, id, project};
use serde_json::Value;
use sqlx::Connection;
use testkit::{Server, skip_unless_available};

fn golden() -> Value {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../contract/golden/ticket_search.json");
    let text = std::fs::read_to_string(path).expect("golden file ticket_search.json exists");
    serde_json::from_str(&text).expect("golden file parses")
}

#[tokio::test]
async fn the_list_returns_the_matches_of_the_golden_file_in_its_order() {
    if !skip_unless_available("the_list_returns_the_matches_of_the_golden_file_in_its_order") {
        return;
    }
    let golden = golden();
    let tickets = golden["tickets"].as_array().expect("tickets");
    let cases = golden["cases"].as_array().expect("cases");
    assert!(tickets.len() >= 200 && cases.len() >= 200);

    let s = Server::start().await;
    let c = s.client();
    let pid = id(&project(&c, "Search", "SRC").await);
    // the rows as the Python model stores a new ticket, created one after the other
    let mut conn = db(&s).await;
    let mut tx = conn.begin().await.expect("begin");
    for (n, t) in tickets.iter().enumerate() {
        let created = format!("2026-11-11T08:00:00.{n:06}+00:00");
        sqlx::query(
            "INSERT INTO ticket (id, project_id, title, description, tags, type, status, priority, comments, \
             acceptance_criteria, sub_tasks, activity_log, work_log, test_cases, blocks, blocked_by, \
             block_done_if_acs_incomplete, block_done_if_tcs_incomplete, links, branches, reopen_count, \
             reopen_history, pending, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'task', 'backlog', 'medium', \
             '[]', '[]', '[]', '[]', '[]', '[]', '[]', '[]', 0, 0, '[]', '[]', 0, '[]', 0, ?, ?)",
        )
        .bind(t["id"].as_str().expect("id"))
        .bind(&pid)
        .bind(t["title"].as_str().expect("title"))
        .bind(t["description"].as_str().expect("description"))
        .bind(t["tags"].as_str().expect("tags"))
        .bind(&created)
        .bind(NOW)
        .execute(&mut *tx)
        .await
        .expect("insert");
    }
    tx.commit().await.expect("commit");
    let _ = conn.close().await;

    let path = format!("/projects/{pid}/tickets");
    let mut matched = 0;
    for case in cases {
        let q = case["q"].as_str().expect("q");
        let r = c.get_query(&path, &[("q", q)]).await;
        assert_eq!(r.status, 200, "{q:?}: {}", r.text());
        let got: Vec<String> = r.json().as_array().expect("list").iter().map(id).collect();
        let expected: Vec<&str> =
            case["order"].as_array().expect("order").iter().map(|id| id.as_str().expect("id")).collect();
        assert_eq!(got, expected, "{q:?}");
        matched += got.len();
    }
    assert!(matched > 1000, "{matched} tickets returned");
}
