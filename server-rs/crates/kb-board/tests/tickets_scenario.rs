//! One scenario through the ticket routes (create, update, move, delete), then what the database holds: the
//! `project`, `story` and `ticket` tables of `testkit`'s `dump_db`, ids and times normalized, must be the same on both
//! servers. This checks the stored bytes: the JSON columns as `json.dumps` writes them and the activity log.
//!
//! The dump of the Python server is kept in `contract/golden/ticket_scenario.json`, and each server is compared with
//! it. To write it again after the scenario changes:
//! `PARITY_TARGET=python KANBAN_WRITE_GOLDEN=1 cargo test -p kb-board --test tickets_scenario`.

mod common;

use common::{exec, id, member, new_ticket, project};
use serde_json::{Map, Value, json};
use testkit::{Client, Server, Target, normalize, skip_unless_available, target};

const GOLDEN: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../contract/golden/ticket_scenario.json");

async fn ok(c: &Client, ticket_id: &str, body: Value) {
    let r = c.patch(&format!("/tickets/{ticket_id}"), body.clone()).await;
    assert_eq!(r.status, 200, "PATCH {ticket_id} {body}: {}", r.text());
}

async fn refused(c: &Client, ticket_id: &str, body: Value) {
    let r = c.patch(&format!("/tickets/{ticket_id}"), body.clone()).await;
    assert_eq!(r.status, 400, "PATCH {ticket_id} {body}: {}", r.text());
}

async fn scenario(s: &Server) {
    let c = s.client();
    let an = c.clone().header("X-Actor", "An Nguyen");
    let pid = id(&project(&c, "Kanban Board", "KAN").await);
    let other = id(&project(&c, "Other", "OTH").await);
    let bao = member(&c, &pid, "Bao", "member").await;
    let ha = member(&c, &pid, "Hà My", "admin").await;

    // create: a title alone, every field, a Story with a ticket and a sub-ticket, another project
    new_ticket(&c, &pid, json!({"title": "  Nhắc uống nước mỗi giờ  "})).await;
    new_ticket(
        &an,
        &pid,
        json!({
            "title": "Login: a wrong password shows no message", "type": "bug", "priority": "critical",
            "status": "todo", "description": "Steps in [[Login spec#Errors]].\n\n\"Quoted\" & <tagged> \\ slash",
            "estimate": 3, "due_date": "2026-06-30", "start_date": "2026-06-01T09:00:00+07:00",
            "tags": [" auth ", "Đăng nhập", "AUTH", "p1"], "assignee": bao["id"],
        }),
    )
    .await;
    new_ticket(&c, &pid, json!({"title": "Export a month as CSV", "type": "story", "estimate": 0.1})).await;
    new_ticket(&c, &pid, json!({"title": "The file", "parent_id": "KAN-3", "status": "in-progress"})).await;
    new_ticket(&c, &pid, json!({"title": "The header row", "parent_id": "KAN-4", "type": "chore"})).await;
    new_ticket(&c, &pid, json!({"title": "To delete", "tags": ["x"]})).await;
    new_ticket(&c, &pid, json!({"title": "Peer", "priority": "low"})).await;
    new_ticket(&c, &other, json!({"title": "Elsewhere", "status": "done"})).await;
    for body in [json!({"title": " "}), json!({"title": "t", "parent_id": "KAN-5"}), json!({"title": "t", "tags": [1]})]
    {
        c.post(&format!("/projects/{pid}/tickets"), body).await.assert_status(400);
    }

    // update: several fields at once, by a named person; then one by one, with values that are refused in between
    ok(
        &an,
        "KAN-1",
        json!({
            "title": "Nhắc uống nước mỗi giờ (8:00–18:00)", "description": "Vì sao: [[Sức khỏe]] và [[Login spec]].",
            "priority": "high", "type": "feature", "estimate": 1.5, "tags": ["sức khỏe", "Mobile", "mobile"],
            "due_date": "2026-07-01", "assignee": ha["id"], "block_done_if_acs_incomplete": true,
            "review_requested_from": bao["id"], "wave_pin": 2,
        }),
    )
    .await;
    ok(&c, "KAN-1", json!({"description": "Vì sao: [[Sức khỏe]].", "estimate": 2, "tags": ["sức khỏe"]})).await;
    ok(&c, "KAN-1", json!({"estimate": null, "due_date": "", "assignee": null, "wave_pin": null})).await;
    ok(&c, "KAN-1", json!({})).await;
    refused(&c, "KAN-1", json!({"title": "x".repeat(301)})).await;
    refused(&c, "KAN-1", json!({"status": "done"})).await; // its criteria are not all passed: it has none
    ok(&c, "KAN-1", json!({"status": "done", "block_done_if_acs_incomplete": false})).await;
    ok(&c, "KAN-2", json!({"title": format!("{} tail", "ă".repeat(260)), "parent_id": "KAN-7"})).await;
    ok(&c, "KAN-2", json!({"parent_id": null, "start_date": null})).await;
    c.patch("/tickets/KAN-2/workspace/retention", json!({"retention_days": 7})).await.assert_status(200);

    // move: through the quick route and the full one; Won't do and back; a Story does not move by hand
    for (ticket, status) in [("KAN-2", "in-progress"), ("KAN-2", "review"), ("KAN-2", "review"), ("KAN-7", "testing")] {
        c.patch(&format!("/tickets/{ticket}/status"), json!({"status": status})).await.assert_status(200);
    }
    ok(&an, "KAN-7", json!({"status": "wont_do", "wont_do_reason": "Trùng với KAN-2"})).await;
    ok(&c, "KAN-7", json!({"status": "todo"})).await;
    refused(&c, "KAN-7", json!({"status": "wont_do"})).await;
    refused(&c, "KAN-3", json!({"status": "todo"})).await;
    refused(&c, "KAN-4", json!({"type": "story"})).await;
    refused(&c, "KAN-5", json!({"status": "wont_do", "wont_do_reason": "a sub-ticket of a ticket"})).await;
    ok(&c, "KAN-4", json!({"status": "wont_do", "wont_do_reason": "the plan dropped it"})).await;
    ok(&c, "KAN-4", json!({"status": "in-progress"})).await;
    refused(&c, "KAN-4", json!({"status": "wont_do", "wont_do_reason": ""})).await;
    // waiting for others: a ticket that blocks is open, then done
    exec(s, r#"UPDATE ticket SET blocked_by = '["KAN-7"]' WHERE id = 'KAN-4'"#, &[]).await;
    refused(&c, "KAN-4", json!({"status": "done"})).await;
    c.patch("/tickets/KAN-7/status", json!({"status": "done"})).await.assert_status(200);
    ok(&c, "KAN-4", json!({"status": "done"})).await;

    // delete: a ticket others point at (a child, a block, links, a ticket waiting for it), and one nothing points at
    exec(s, "UPDATE ticket SET parent_id = 'KAN-6' WHERE id = 'KAN-7'", &[]).await;
    let links = r#"[{"id": "l1", "target_id": "KAN-6", "relation_type": "relates_to"}, {"id": "l2", "target_id": "KAN-1", "relation_type": "duplicates"}]"#;
    exec(
        s,
        r#"UPDATE ticket SET blocks = '["KAN-6", "KAN-1"]', blocked_by = '["KAN-6"]', links = ?, pending = 1, pending_reason_type = 'ticket', pending_ticket_id = 'KAN-6' WHERE id = 'KAN-2'"#,
        &[json!(links)],
    )
    .await;
    c.delete("/tickets/KAN-6").await.assert_status(204);
    c.delete("/tickets/KAN-6").await.assert_status(404);
    c.delete("/tickets/OTH-1").await.assert_status(204);
    // the number of a deleted ticket is not given again
    new_ticket(&c, &pid, json!({"title": "After the delete"})).await;
    // closing a pending ticket clears the flag
    ok(&c, "KAN-2", json!({"status": "wont_do", "wont_do_reason": "superseded"})).await;
}

/// The three tables, rows in a fixed order (projects by prefix; a dump sorts by the first column, a random id).
fn tables(dump: &Value) -> Value {
    let mut projects = dump["project"].as_array().expect("project rows").clone();
    projects.sort_by_key(|p| p["prefix"].as_str().expect("prefix").to_string());
    let mut out = Map::new();
    out.insert("project".into(), Value::Array(projects));
    out.insert("story".into(), dump["story"].clone());
    out.insert("ticket".into(), dump["ticket"].clone());
    normalize(&Value::Object(out))
}

#[tokio::test]
async fn the_same_scenario_leaves_the_same_rows() {
    if !skip_unless_available("the_same_scenario_leaves_the_same_rows") {
        return;
    }
    let s = Server::start().await;
    scenario(&s).await;
    let got = tables(&s.dump_db().await);
    assert_eq!(got["ticket"].as_array().expect("tickets").len(), 7);

    if std::env::var("KANBAN_WRITE_GOLDEN").is_ok_and(|v| v == "1") {
        assert_eq!(target(), Target::Python, "the golden file is what the Python server stores");
        let text = serde_json::to_string_pretty(&got).expect("json") + "\n";
        std::fs::write(GOLDEN, text).expect("write the golden file");
    }
    let text = std::fs::read_to_string(GOLDEN).expect("golden file ticket_scenario.json exists");
    let expected: Value = serde_json::from_str(&text).expect("golden file parses");
    for table in ["project", "story", "ticket"] {
        let (got, expected) = (got[table].as_array().expect("rows"), expected[table].as_array().expect("rows"));
        assert_eq!(got.len(), expected.len(), "{table}");
        for (got, expected) in got.iter().zip(expected) {
            for (column, value) in expected.as_object().expect("row") {
                assert_eq!(&got[column], value, "{table} {}: {column}", expected.get("id").unwrap_or(&Value::Null));
            }
            assert_eq!(got, expected, "{table}");
        }
    }
}
