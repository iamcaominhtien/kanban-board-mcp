//! Two scenarios through the ticket routes, then what the database holds: the `project`, `story` and `ticket` tables
//! of `testkit`'s `dump_db`, ids and times normalized, must be the same on both servers. This checks the stored
//! bytes: the JSON columns as `json.dumps` writes them and the activity log.
//!
//! - the first scenario is the ticket itself: create, update, move, delete;
//! - the second is everything a ticket holds: comments, acceptance criteria, sub-tasks, the work log, test cases,
//!   blocks, links, branches, reopen and pending.
//!
//! The dump of the Python server is kept in `contract/golden/ticket_scenario.json` (the first scenario at the top
//! level, the second under `second`), and each server is compared with it. To write it again after a scenario changes:
//! `PARITY_TARGET=python KANBAN_WRITE_GOLDEN=1 cargo test -p kb-board --test tickets_scenario`.

mod common;

use std::sync::Mutex;

use common::{exec, id, member, new_ticket, patch_empty, project};
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

/// The golden file is one file for both tests: one of them reads or writes it at a time.
static GOLDEN_FILE: Mutex<()> = Mutex::new(());

/// Compare the tables with the part of the golden file under `key` (the top level when there is none), after
/// writing that part when the golden file is being written.
fn check(got: &Value, key: Option<&str>) {
    let _one_at_a_time = GOLDEN_FILE.lock().unwrap_or_else(|e| e.into_inner());
    let read = || -> Value {
        let text = std::fs::read_to_string(GOLDEN).expect("golden file ticket_scenario.json exists");
        serde_json::from_str(&text).expect("golden file parses")
    };
    if std::env::var("KANBAN_WRITE_GOLDEN").is_ok_and(|v| v == "1") {
        assert_eq!(target(), Target::Python, "the golden file is what the Python server stores");
        let mut golden = read();
        match key {
            Some(key) => golden[key] = got.clone(),
            None => {
                for table in ["project", "story", "ticket"] {
                    golden[table] = got[table].clone();
                }
            }
        }
        let text = serde_json::to_string_pretty(&golden).expect("json") + "\n";
        std::fs::write(GOLDEN, text).expect("write the golden file");
    }
    let golden = read();
    let expected = match key {
        Some(key) => &golden[key],
        None => &golden,
    };
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

#[tokio::test]
async fn the_same_scenario_leaves_the_same_rows() {
    if !skip_unless_available("the_same_scenario_leaves_the_same_rows") {
        return;
    }
    let s = Server::start().await;
    scenario(&s).await;
    let got = tables(&s.dump_db().await);
    assert_eq!(got["ticket"].as_array().expect("tickets").len(), 7);
    check(&got, None);
}

/// A request that must be answered with `status`.
async fn call(c: &Client, status: u16, method: &str, path: &str, body: Value) -> Value {
    let r = match body {
        Value::Null => c.request(method, path, &[], None).await,
        body => {
            let bytes = serde_json::to_vec(&body).expect("json");
            c.request(method, path, &[("content-type", "application/json")], Some(bytes)).await
        }
    };
    assert_eq!(r.status, status, "{method} {path}: {}", r.text());
    serde_json::from_slice(&r.body).unwrap_or(Value::Null)
}

/// The id of the last item of a list field of a ticket.
fn last(ticket: &Value, field: &str) -> String {
    id(ticket[field].as_array().expect("list").last().expect("an item"))
}

async fn second_scenario(s: &Server) {
    let c = s.client();
    let an = c.clone().header("X-Actor", "An Nguyen");
    let pid = id(&project(&c, "Kanban Board", "KAN").await);
    let other = id(&project(&c, "Other", "OTH").await);
    let bao = member(&c, &pid, "Bao", "member").await;
    let ha = member(&c, &pid, "Hà My", "admin").await;
    let n = Value::Null;
    new_ticket(
        &an,
        &pid,
        json!({"title": "Đăng nhập bằng Google", "assignee": bao["id"], "description": "As [[Spec]]"}),
    )
    .await;
    new_ticket(&c, &pid, json!({"title": "Parent", "status": "todo"})).await;
    new_ticket(&c, &pid, json!({"title": "Child", "parent_id": "KAN-2"})).await;
    new_ticket(&c, &pid, json!({"title": "Peer"})).await;
    new_ticket(&c, &other, json!({"title": "Elsewhere"})).await;
    let t = "/tickets/KAN-1";

    // comments: mentions, a reply, an edit (and one that changes nothing), a delete and a restore, refusals
    let text = format!("Xem [[Spec#Mục tiêu]] nhé @[Hà My](member:{}) \"quoted\" <b> \\ 😀", id(&ha));
    let first = last(&call(&c, 200, "POST", &format!("{t}/comments"), json!({"text": text})).await, "comments");
    let body =
        json!({"text": "  A reply by Bao  ", "author": "bao", "reply_to": first, "ai_intent": "ask", "ai_fast": false});
    let reply = last(&call(&c, 200, "POST", &format!("{t}/comments"), body).await, "comments");
    call(&an, 200, "POST", &format!("{t}/comments"), json!({"text": "To delete [[Old page]]", "author": id(&ha)}))
        .await;
    call(&c, 400, "POST", &format!("{t}/comments"), json!({"text": "  "})).await;
    call(&an, 200, "PATCH", &format!("{t}/comments/{first}"), json!({"text": "Now [[Spec]] only"})).await;
    call(&c, 200, "PATCH", &format!("{t}/comments/{first}"), json!({"text": " Now [[Spec]] only "})).await;
    call(&c, 404, "PATCH", &format!("{t}/comments/nope"), json!({"text": "x"})).await;
    call(&c, 200, "DELETE", &format!("{t}/comments/{reply}"), n.clone()).await;
    call(&c, 200, "DELETE", &format!("{t}/comments/nope"), n.clone()).await;
    let third = last(&crate::common::get_ticket(&c, "KAN-1").await, "comments");
    call(&c, 200, "DELETE", &format!("{t}/comments/{third}"), n.clone()).await;
    call(&c, 200, "POST", &format!("{t}/comments/{third}/restore"), n.clone()).await;
    call(&c, 404, "POST", &format!("{t}/comments/{third}/restore"), n.clone()).await;

    // acceptance criteria and sub-tasks: added, toggled twice and once, deleted
    for path in ["acceptance-criteria", "sub-tasks"] {
        let field = path.replace('-', "_");
        let one = last(
            &call(&an, 200, "POST", &format!("{t}/{path}"), json!({"text": "  Đạt 100% [[Spec]]  "})).await,
            &field,
        );
        let two = last(&call(&c, 200, "POST", &format!("{t}/{path}"), json!({"text": "x".repeat(250)})).await, &field);
        let three = last(&call(&c, 200, "POST", &format!("{t}/{path}"), json!({"text": "To remove"})).await, &field);
        call(&c, 400, "POST", &format!("{t}/{path}"), json!({"text": ""})).await;
        patch_empty(&c, &format!("{t}/{path}/{one}/toggle")).await.assert_status(200);
        patch_empty(&an, &format!("{t}/{path}/{two}/toggle")).await.assert_status(200);
        patch_empty(&c, &format!("{t}/{path}/{two}/toggle")).await.assert_status(200);
        patch_empty(&c, &format!("{t}/{path}/nope/toggle")).await.assert_status(200);
        call(&c, 200, "DELETE", &format!("{t}/{path}/{three}"), n.clone()).await;
        call(&c, 200, "DELETE", &format!("{t}/{path}/nope"), n.clone()).await;
    }
    let ac = id(&crate::common::get_ticket(&c, "KAN-1").await["acceptance_criteria"][0]);

    // branches (no repository is linked: the record alone), test cases, the work log with its links
    let body = json!({"name": "feature/đăng-nhập", "branch_from": "develop", "status": "open", "ahead_count": 2, "behind_count": 1.0,
        "pr_url": "https://example.com/pr/1", "commit_hash": "abc1234", "linked_ticket_id": "KAN-4"});
    let branch = last(&call(&an, 201, "POST", &format!("{t}/branches"), body).await, "branches");
    let extra = last(
        &call(&c, 201, "POST", &format!("{t}/branches"), json!({"name": "to-delete", "status": "baseline"})).await,
        "branches",
    );
    call(&c, 400, "POST", &format!("{t}/branches"), json!({"name": "wt", "create_worktree": true})).await;
    let body = json!({"name": "feature/login", "status": "merged", "branch_from": "main", "pr_url": "", "ahead_count": 0,
        "worktree_path": "/tmp/wt/login"});
    call(&c, 200, "PATCH", &format!("{t}/branches/{branch}"), body).await;
    call(
        &an,
        200,
        "PATCH",
        &format!("{t}/branches/{branch}"),
        json!({"remove_worktree": true, "commit_hash": "def5678"}),
    )
    .await;
    call(&c, 200, "PATCH", &format!("{t}/branches/{extra}"), json!({"worktree_path": " ", "linked_ticket_id": ""}))
        .await;
    call(&c, 404, "PATCH", &format!("{t}/branches/nope"), json!({"name": "x"})).await;
    call(&c, 200, "DELETE", &format!("{t}/branches/{extra}?remove_worktree=true&delete_git_branch=true"), n.clone())
        .await;
    call(&c, 200, "DELETE", &format!("{t}/branches/nope"), n.clone()).await;
    call(&c, 400, "POST", &format!("{t}/branches/{branch}/checkout"), n.clone()).await;

    let body = json!({"title": "  Mở trang đăng nhập  ", "description": "Theo [[Spec#Đăng nhập]]", "expected_result": "Thấy nút Google",
        "criterion_id": ac, "assignee": bao["id"], "test_data_files": [{"id": "f1", "name": "dữ liệu.csv", "url": "/uploads/d.csv", "size": 3}]});
    let tc1 = last(&call(&c, 200, "POST", &format!("{t}/test-cases"), body).await, "test_cases");
    let body = json!({"title": "Runs", "status": "running", "notes": "long notes [[Notes]]", "note": "short", "proof": "[[Proof]]"});
    let tc2 = last(&call(&an, 200, "POST", &format!("{t}/test-cases"), body).await, "test_cases");
    let tc3 = last(
        &call(
            &c,
            200,
            "POST",
            &format!("{t}/test-cases"),
            json!({"title": "Passed", "status": "pass", "note": "only a note"}),
        )
        .await,
        "test_cases",
    );
    call(&c, 400, "POST", &format!("{t}/test-cases"), json!({"title": "x", "criterion_id": "nope"})).await;
    call(&c, 200, "DELETE", &format!("{t}/test-cases/{tc3}"), n.clone()).await;
    call(&c, 200, "POST", &format!("{t}/test-cases"), json!({"title": "After a delete", "status": "fail"})).await;
    call(&an, 200, "PATCH", &format!("{t}/test-cases/{tc1}"), json!({"status": "running"})).await;
    let body = json!({"status": "pass", "title": "Mở trang", "description": "Theo [[Spec]]", "expected_result": "", "notes": "ok",
        "proof": "ảnh.png", "note": "n", "assignee": "", "criterion_id": "", "test_data_files": [],
        "expected_files": [{"id": "e", "n": 1.0}], "notes_files": [{"id": "n", "ok": true, "none": null}]});
    call(&c, 200, "PATCH", &format!("{t}/test-cases/{tc1}"), body).await;
    call(&c, 200, "PATCH", &format!("{t}/test-cases/{tc2}"), json!({"status": "running", "title": "Runs"})).await;
    call(&an, 200, "PATCH", &format!("{t}/test-cases/{tc2}"), json!({"status": "fail"})).await;
    call(&c, 200, "PATCH", &format!("{t}/test-cases/nope"), json!({"status": "pass"})).await;
    call(&c, 400, "PATCH", &format!("{t}/test-cases/{tc2}"), json!({"title": " "})).await;

    let body = json!({"author": "Hà My", "role": "Tester", "note": "  Tìm thấy lỗi ở [[Spec]]  ", "kind": "root_cause", "pinned": true,
        "linked_branch": "feature/login", "linked_test_case": tc2,
        "attachments": [{"name": "  trace.log ", "url": "/uploads/trace.log", "size": 12, "type": "text/plain", "extra": true},
            {"id": "att-2", "name": "ảnh.png", "url": "/uploads/a.png", "size": 1.5}]});
    let log1 = last(&call(&c, 200, "POST", &format!("{t}/work-log"), body).await, "work_log");
    let log2 = last(
        &call(
            &an,
            200,
            "POST",
            &format!("{t}/work-log"),
            json!({"author": "user", "role": "Other", "note": "y".repeat(300)}),
        )
        .await,
        "work_log",
    );
    call(
        &c,
        400,
        "POST",
        &format!("{t}/work-log"),
        json!({"author": "A", "role": "PM", "note": "n", "linked_branch": "nope"}),
    )
    .await;
    call(
        &c,
        200,
        "PATCH",
        &format!("{t}/work-log/{log1}"),
        json!({"note": " Sửa xong ", "kind": "resolved", "author": "Bao", "role": "Developer"}),
    )
    .await;
    call(
        &c,
        200,
        "PATCH",
        &format!("{t}/work-log/{log1}"),
        json!({"linked_branch": "", "linked_test_case": "TC-1", "pinned": false, "attachments": []}),
    )
    .await;
    call(&c, 404, "PATCH", &format!("{t}/work-log/nope"), json!({"note": "x"})).await;
    call(&c, 200, "DELETE", &format!("{t}/work-log/{log2}"), n.clone()).await;
    call(&c, 200, "DELETE", &format!("{t}/work-log/nope"), n.clone()).await;

    // blocks and links, made and removed, with what is refused in between
    call(&c, 200, "POST", "/tickets/KAN-1/blocks/KAN-2", n.clone()).await;
    call(&c, 200, "POST", "/tickets/KAN-1/blocks/KAN-2", n.clone()).await;
    call(&an, 200, "POST", "/tickets/KAN-2/blocks/KAN-4", n.clone()).await;
    call(&c, 400, "POST", "/tickets/KAN-4/blocks/KAN-1", n.clone()).await;
    call(&c, 400, "POST", "/tickets/KAN-1/blocks/OTH-1", n.clone()).await;
    call(&c, 200, "POST", "/tickets/KAN-1/blocks/KAN-4", n.clone()).await;
    call(&c, 200, "DELETE", "/tickets/KAN-1/blocks/KAN-4", n.clone()).await;
    call(&c, 200, "DELETE", "/tickets/KAN-4/blocks/KAN-3", n.clone()).await;
    call(&c, 200, "DELETE", "/tickets/KAN-3/blocks/KAN-3", n.clone()).await;
    let link = |target: &str, relation: &str| json!({"target_id": target, "relation_type": relation});
    let causes = call(&an, 201, "POST", "/tickets/KAN-1/links", link("KAN-2", "causes")).await;
    call(&c, 201, "POST", "/tickets/KAN-1/links", link("KAN-2", "causes")).await;
    call(&c, 201, "POST", "/tickets/KAN-1/links", link("KAN-4", "duplicated_by")).await;
    call(&c, 201, "POST", "/tickets/KAN-4/links", link("KAN-1", "relates_to")).await;
    call(&c, 201, "POST", "/tickets/KAN-2/links", link("KAN-1", "caused_by")).await;
    call(&c, 400, "POST", "/tickets/KAN-1/links", link("OTH-1", "relates_to")).await;
    call(&c, 400, "POST", "/tickets/KAN-1/links", link("KAN-1", "relates_to")).await;
    call(&c, 200, "DELETE", &format!("/tickets/KAN-1/links/{}", id(&causes)), n.clone()).await;
    call(&c, 404, "DELETE", &format!("/tickets/KAN-1/links/{}", id(&causes)), n.clone()).await;

    // pending: set, changed, resumed with a comment; a blocker that finishes prompts the waiting ticket
    let put = "/tickets/KAN-3/pending";
    call(&c, 400, "PUT", put, json!({"reason_type": "ticket", "ticket_id": "KAN-3"})).await;
    call(
        &an,
        200,
        "PUT",
        put,
        json!({"reason_type": "party", "party": "  Khách hàng  ", "note": " chờ phản hồi ", "ticket_id": "KAN-4"}),
    )
    .await;
    call(&c, 200, "PUT", put, json!({"reason_type": "person", "member_id": bao["id"], "actor": "Bao"})).await;
    call(
        &c,
        200,
        "PUT",
        put,
        json!({"reason_type": "ticket", "ticket_id": "KAN-4", "add_blocked_by": true, "actor": null}),
    )
    .await;
    call(&c, 200, "PATCH", "/tickets/KAN-4", json!({"status": "wont_do", "wont_do_reason": "not needed"})).await;
    call(
        &c,
        200,
        "POST",
        "/tickets/KAN-3/resume",
        json!({"reason": "  KAN-4 xong rồi  ", "add_comment": true, "actor": "Hà My"}),
    )
    .await;
    call(&c, 409, "POST", "/tickets/KAN-3/resume", n.clone()).await;
    call(&c, 200, "PUT", put, json!({"reason_type": "ticket", "ticket_id": "OTH-1"})).await;
    call(&c, 200, "DELETE", put, n.clone()).await;
    call(&c, 200, "PUT", "/tickets/KAN-2/pending", json!({"reason_type": "party", "party": "Legal"})).await;
    call(&c, 200, "DELETE", "/tickets/KAN-2/pending", json!({"add_comment": true})).await;
    call(&c, 200, "PUT", "/tickets/KAN-2/pending", json!({"reason_type": "ticket", "ticket_id": "KAN-1"})).await;

    // reopen: with everything reset, undone, again; a child with its parent; closing a ticket others wait for
    call(&c, 409, "POST", "/tickets/KAN-1/reopen", json!({})).await;
    call(&c, 200, "PATCH", "/tickets/KAN-1", json!({"status": "wont_do", "wont_do_reason": "Thôi"})).await;
    call(&c, 200, "POST", "/tickets/KAN-1/reopen", json!({"reason": "  Cần làm lại  ", "actor": "Linh Phạm"})).await;
    call(&c, 200, "POST", "/tickets/KAN-1/reopen/undo", n.clone()).await;
    call(&c, 409, "POST", "/tickets/KAN-1/reopen/undo", n.clone()).await;
    call(&an, 200, "POST", "/tickets/KAN-1/reopen", json!({"reset_ac": true, "reset_tests": true, "unassign": true}))
        .await;
    call(&c, 200, "PATCH", "/tickets/KAN-1/status", json!({"status": "done"})).await;
    call(&c, 400, "POST", "/tickets/KAN-1/reopen", json!({"reason": "x".repeat(241)})).await;
    call(&c, 200, "POST", "/tickets/KAN-1/reopen", json!({"actor": null, "reason": "x".repeat(240)})).await;
    call(&c, 200, "PATCH", "/tickets/KAN-3/status", json!({"status": "done"})).await;
    call(&c, 200, "PATCH", "/tickets/KAN-2", json!({"status": "wont_do", "wont_do_reason": "parent dropped"})).await;
    call(
        &c,
        200,
        "POST",
        "/tickets/KAN-3/reopen",
        json!({"reopen_parent": true, "actor": "Bao", "reason": "child first"}),
    )
    .await;
    call(&c, 200, "POST", "/tickets/KAN-2/reopen/undo", n.clone()).await;
    call(&c, 422, "PUT", "/tickets/KAN-2/pending", json!({"reason_type": "party", "party": "X"})).await;
}

#[tokio::test]
async fn the_second_scenario_leaves_the_same_rows() {
    if !skip_unless_available("the_second_scenario_leaves_the_same_rows") {
        return;
    }
    let s = Server::start().await;
    second_scenario(&s).await;
    let got = tables(&s.dump_db().await);
    assert_eq!(got["ticket"].as_array().expect("tickets").len(), 5);
    check(&got, Some("second"));
}
