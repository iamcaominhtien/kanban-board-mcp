//! `tests/test_blocked_done.py`: `test_done_is_refused_while_a_blocker_is_open_and_names_it`, with its MCP line (the
//! `kb-board` port of the file leaves that line out). The Python test calls `ops.update_ticket`; here it is
//! `manage_ticket(action='update')`.

mod common;

use common::{call_err, rest_ticket_in};
use serde_json::json;

#[tokio::test]
async fn test_done_is_refused_while_a_blocker_is_open_and_names_it() {
    let s = common::start().await;
    let (mcp, c) = (s.mcp(), s.client());
    let made = c.post("/projects", json!({"name": "P", "prefix": "BLK", "color": "#123456"})).await;
    made.assert_status(201);
    let pid = made.json()["id"].clone();
    let blocker = rest_ticket_in(&c, &pid, "Store the goal", json!({"status": "todo"})).await["id"]
        .as_str()
        .expect("id")
        .to_string();
    let blocked = rest_ticket_in(&c, &pid, "Show the goal", json!({"status": "todo"})).await["id"]
        .as_str()
        .expect("id")
        .to_string();
    c.post_empty(&format!("/tickets/{blocker}/blocks/{blocked}")).await.assert_status(200);

    let r = c.patch(&format!("/tickets/{blocked}"), json!({"status": "done"})).await;
    r.assert_status(400);
    let detail = r.json()["detail"].as_str().expect("a detail").to_string();
    assert!(detail.contains(&blocker) && detail.contains("todo"), "{detail}");
    // the quick status change (dragging the card) is refused the same way
    let r = c.patch(&format!("/tickets/{blocked}/status"), json!({"status": "done"})).await;
    assert!(r.status == 400 || r.status == 422, "{}", r.text());
    assert_eq!(c.get(&format!("/tickets/{blocked}")).await.json()["status"], "todo");
    // over MCP the AI reads the same reason
    let refused =
        call_err(&mcp, "manage_ticket", json!({"action": "update", "ticket_id": blocked, "status": "done"})).await;
    assert!(refused.contains(&blocker), "{refused}");
    // other columns are not affected
    c.patch(&format!("/tickets/{blocked}"), json!({"status": "review"})).await.assert_status(200);
}
