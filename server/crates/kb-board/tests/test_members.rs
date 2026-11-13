//! The member tests of the Python suite (`test_remove_member_blocked_when_assigned_to_open_tickets` of
//! `tests/test_tickets.py`, `test_member_role_can_be_changed` of `tests/test_docs_comments.py`), and one check per
//! route of `api/members.py` that both servers answer the same status and JSON for the success case and for each
//! error.

mod common;

use std::time::Duration;

use common::{NOW, count, exec, id, insert, member, project, scalar, ticket};
use serde_json::{Value, json};
use testkit::{Server, Target, normalize, skip_unless_available, target};

#[tokio::test]
async fn test_remove_member_blocked_when_assigned_to_open_tickets() {
    if !skip_unless_available("test_remove_member_blocked_when_assigned_to_open_tickets") {
        return;
    }
    let s = Server::start().await;
    let c = s.client();
    let project = project(&c, "Test Project", "TST").await;
    let pid = id(&project);
    // Create member
    let r_mem = c.post(&format!("/projects/{pid}/members"), json!({"name": "An Nguyen", "color": "#2E6F40"})).await;
    assert_eq!(r_mem.status, 201);
    let member_id = id(&r_mem.json());

    // Create ticket assigned to member (the ticket routes are not ported yet: the row is added to the database)
    ticket(&s, "TST-1", &pid, "Task for An", json!({"assignee": member_id})).await;

    // Try to delete member while assigned to open ticket
    let r_del_blocked = c.delete(&format!("/projects/{pid}/members/{member_id}")).await;
    assert_eq!(r_del_blocked.status, 400);
    let detail = r_del_blocked.detail();
    assert!(detail.as_str().expect("detail").contains("Cannot remove: assigned to 1 open ticket"), "{detail}");

    // Close ticket
    exec(&s, "UPDATE ticket SET status = 'done' WHERE id = 'TST-1'", &[]).await;

    // Now delete member should succeed
    let r_del_ok = c.delete(&format!("/projects/{pid}/members/{member_id}")).await;
    assert_eq!(r_del_ok.status, 204);
}

#[tokio::test]
async fn test_member_role_can_be_changed() {
    if !skip_unless_available("test_member_role_can_be_changed") {
        return;
    }
    let s = Server::start().await;
    let c = s.client();
    let pid = id(&project(&c, "Docs", "DOC").await);
    let m = member(&c, &pid, "Mia", "member").await;
    let r = c.patch(&format!("/projects/{pid}/members/{}", id(&m)), json!({"role": "viewer"})).await;
    assert_eq!(r.json()["role"], "viewer");
    let bad = c.patch(&format!("/projects/{pid}/members/{}", id(&m)), json!({"role": "boss"})).await;
    assert_eq!(bad.status, 422);
}

// ---------------------------------------------------------------------------
// The same status and JSON on both servers, route by route (not in the Python suite)
// ---------------------------------------------------------------------------

/// A member as every route returns it, ids replaced (`n` numbers the member's id; the project is `<uuid:1>`).
fn read(n: usize, name: &str, color: &str, role: &str) -> Value {
    json!({
        "id": format!("<uuid:{n}>"), "project_id": "<uuid:1>", "name": name, "color": color, "role": role,
        "kind": "human", "created_at": "<time>",
    })
}

/// A reply with the project's id put first, so that the project is always `<uuid:1>`.
fn normal(pid: &str, body: Value) -> Value {
    normalize(&json!([pid, body]))[1].clone()
}

#[tokio::test]
async fn get_members_answers_the_same() {
    if !skip_unless_available("get_members_answers_the_same") {
        return;
    }
    let s = Server::start().await;
    let c = s.client();
    // a project that does not exist has no members; it is not an error
    let r = c.get("/projects/ghost/members").await;
    assert_eq!(r.status, 200);
    assert_eq!(r.json(), json!([]));

    let pid = id(&project(&c, "Team", "TEA").await);
    let other = id(&project(&c, "Other", "OTH").await);
    member(&c, &pid, "Zoe", "viewer").await;
    member(&c, &pid, "Ann", "admin").await;
    member(&c, &other, "Elsewhere", "member").await;
    // in the order they were added, the project's own only
    let r = c.get(&format!("/projects/{pid}/members")).await;
    assert_eq!(r.status, 200);
    assert_eq!(
        normal(&pid, r.json()),
        json!([
            read(2, "Admin", "#3B82F6", "member"),
            read(3, "Zoe", "#10B981", "viewer"),
            read(4, "Ann", "#F59E0B", "admin"),
        ])
    );
    // members added in the same instant are listed by id
    let at = "2026-01-01T00:00:00.000000+00:00";
    for name in ["m-b", "m-c", "m-a"] {
        let row = json!({"id": name, "project_id": other, "name": name, "color": "#000000", "role": "member",
            "kind": "human", "created_at": at});
        insert(&s, "member", &row).await;
    }
    let listed = c.get(&format!("/projects/{other}/members")).await.json();
    let names: Vec<&str> = listed.as_array().expect("list").iter().map(|m| m["name"].as_str().expect("name")).collect();
    assert_eq!(names, vec!["m-a", "m-b", "m-c", "Admin", "Elsewhere"]);
}

#[tokio::test]
async fn post_member_answers_the_same() {
    if !skip_unless_available("post_member_answers_the_same") {
        return;
    }
    let s = Server::start().await;
    let c = s.client();
    let pid = id(&project(&c, "Team", "TEA").await);
    let path = format!("/projects/{pid}/members");

    // the name is stored as given; the color is the next of the palette, the role "member"
    let r = c.post(&path, json!({"name": "An Nguyen"})).await;
    assert_eq!(r.status, 201);
    assert_eq!(normal(&pid, r.json()), read(2, "An Nguyen", "#10B981", "member"));
    let r = c.post(&path, json!({"name": "  Spaced   Out ", "color": "#2E6F40", "role": "viewer"})).await;
    assert_eq!(r.status, 201);
    assert_eq!(normal(&pid, r.json()), read(2, "  Spaced   Out ", "#2E6F40", "viewer"));
    // no color, a null color and an empty color all take the palette, which starts again after eight members
    let mut colors = Vec::new();
    for (i, color) in [json!(null), json!(""), json!(null), json!(null), json!(null), json!(null)].iter().enumerate() {
        let r = c.post(&path, json!({"name": format!("M{i}"), "color": color, "role": "admin"})).await;
        assert_eq!(r.status, 201, "{}", r.text());
        colors.push(r.json()["color"].as_str().expect("color").to_string());
    }
    assert_eq!(colors, vec!["#EF4444", "#8B5CF6", "#EC4899", "#06B6D4", "#84CC16", "#3B82F6"]);
    assert_eq!(count(&s, "SELECT COUNT(*) FROM member WHERE project_id = ?", &[json!(pid)]).await, 9);
    // stored as given
    assert_eq!(scalar(&s, "SELECT name FROM member WHERE color = '#2E6F40'", &[]).await, json!("  Spaced   Out "));

    // refused
    let r = c.post(&path, json!({"name": "Boss", "role": "owner"})).await;
    assert_eq!(r.status, 422);
    assert_eq!(r.json(), json!({"detail": "Invalid role"}));
    for name in ["", "   ", " \t\n "] {
        let r = c.post(&path, json!({"name": name})).await;
        assert_eq!(r.status, 422, "{name:?}");
        assert_eq!(r.json(), json!({"detail": "Enter a name."}), "{name:?}");
    }
    // the role is checked before the name
    let r = c.post(&path, json!({"name": "", "role": "owner"})).await;
    assert_eq!(r.json(), json!({"detail": "Invalid role"}));
    let r = c.post(&path, json!({"color": "#000000"})).await;
    assert_eq!(r.status, 422);
    assert_eq!(r.detail()[0]["type"], "missing");
    assert_eq!(r.detail()[0]["loc"], json!(["body", "name"]));
    let r = c.post(&path, json!({"name": null})).await;
    assert_eq!(r.status, 422);
    assert_eq!(r.detail()[0]["loc"], json!(["body", "name"]));
    assert_eq!(count(&s, "SELECT COUNT(*) FROM member WHERE project_id = ?", &[json!(pid)]).await, 9);

    // a project that does not exist still gets the member (nothing checks the project)
    let r = c.post("/projects/ghost/members", json!({"name": "Lost"})).await;
    assert_eq!(r.status, 201);
    assert_eq!(r.json()["project_id"], "ghost");
    assert_eq!(r.json()["color"], "#3B82F6");
}

/// Names are unique across people and AI in a project. The check is `services/ai/teams.py:check_name`, which the
/// board reaches through `kb_board::hooks::AiTeamsHook`: until `kb-ai` registers it the Rust server accepts the
/// name, so on the Rust target this test only says so.
#[tokio::test]
async fn post_member_refuses_a_name_that_is_taken() {
    if !skip_unless_available("post_member_refuses_a_name_that_is_taken") {
        return;
    }
    if target() == Target::Rust {
        eprintln!(
            "post_member_refuses_a_name_that_is_taken: waits for kb-ai (AiTeamsHook::check_name), not run on Rust"
        );
        return;
    }
    let s = Server::start().await;
    let c = s.client();
    let pid = id(&project(&c, "Team", "TEA").await);
    let path = format!("/projects/{pid}/members");
    member(&c, &pid, "An Nguyen", "member").await;
    // case and the spaces around are ignored
    let r = c.post(&path, json!({"name": "  an nguyen "})).await;
    assert_eq!(r.status, 409);
    assert_eq!(r.json(), json!({"detail": "“An Nguyen” is already a member of Team."}));
    // an AI member's name
    let row = json!({"id": "ai-1", "project_id": pid, "name": "Claude Code", "color": "#000000", "role": "member",
        "kind": "ai", "created_at": NOW});
    insert(&s, "member", &row).await;
    let r = c.post(&path, json!({"name": "claude  code"})).await;
    assert_eq!(r.status, 409);
    assert_eq!(r.json(), json!({"detail": "An AI member already uses the name “claude code”."}));
    // a removed AI member's name is free, and so is the same name in another project
    exec(&s, "UPDATE member SET kind = 'ai_removed' WHERE id = 'ai-1'", &[]).await;
    c.post(&path, json!({"name": "Claude Code"})).await.assert_status(201);
    let other = id(&project(&c, "Other", "OTH").await);
    c.post(&format!("/projects/{other}/members"), json!({"name": "An Nguyen"})).await.assert_status(201);
}

#[tokio::test]
async fn patch_member_answers_the_same() {
    if !skip_unless_available("patch_member_answers_the_same") {
        return;
    }
    let s = Server::start().await;
    let c = s.client();
    let pid = id(&project(&c, "Team", "TEA").await);
    let other = id(&project(&c, "Other", "OTH").await);
    let m = member(&c, &pid, "Mia", "member").await;
    let path = format!("/projects/{pid}/members/{}", id(&m));

    for role in ["viewer", "admin", "member", "member"] {
        let r = c.patch(&path, json!({"role": role})).await;
        assert_eq!(r.status, 200, "{role}");
        let mut expected = m.clone();
        expected["role"] = json!(role);
        assert_eq!(r.json(), expected);
        assert_eq!(scalar(&s, "SELECT role FROM member WHERE id = ?", &[m["id"].clone()]).await, json!(role));
    }

    let r = c.patch(&path, json!({"role": "boss"})).await;
    assert_eq!(r.status, 422);
    assert_eq!(r.json(), json!({"detail": "Invalid role 'boss'. Valid roles: ['viewer', 'member', 'admin']"}));
    // the role is checked before the member is looked up
    let r = c.patch(&format!("/projects/{pid}/members/ghost"), json!({"role": ""})).await;
    assert_eq!(r.status, 422);
    assert_eq!(r.json(), json!({"detail": "Invalid role ''. Valid roles: ['viewer', 'member', 'admin']"}));

    let r = c.patch(&format!("/projects/{pid}/members/ghost"), json!({"role": "admin"})).await;
    assert_eq!(r.status, 404);
    assert_eq!(r.json(), json!({"detail": "Member not found"}));
    // a member of another project
    let r = c.patch(&format!("/projects/{other}/members/{}", id(&m)), json!({"role": "admin"})).await;
    assert_eq!(r.status, 404);
    assert_eq!(r.json(), json!({"detail": "Member not found"}));
    assert_eq!(scalar(&s, "SELECT role FROM member WHERE id = ?", &[m["id"].clone()]).await, json!("member"));

    let r = c.patch(&path, json!({})).await;
    assert_eq!(r.status, 422);
    assert_eq!(r.detail()[0]["type"], "missing");
    assert_eq!(r.detail()[0]["loc"], json!(["body", "role"]));
}

#[tokio::test]
async fn del_member_answers_the_same() {
    if !skip_unless_available("del_member_answers_the_same") {
        return;
    }
    let s = Server::start().await;
    let c = s.client();
    let pid = id(&project(&c, "Team", "TEA").await);
    let other = id(&project(&c, "Other", "OTH").await);
    let path = |member: &Value| format!("/projects/{pid}/members/{}", id(member));

    // removed
    let gone = member(&c, &pid, "Gone", "member").await;
    let r = c.delete(&path(&gone)).await;
    assert_eq!(r.status, 204);
    assert!(r.body.is_empty(), "{}", r.text());
    assert_eq!(count(&s, "SELECT COUNT(*) FROM member WHERE id = ?", &[gone["id"].clone()]).await, 0);

    // not found: gone, never there, or in another project
    for url in [path(&gone), format!("/projects/{pid}/members/ghost")] {
        let r = c.delete(&url).await;
        assert_eq!(r.status, 404);
        assert_eq!(r.json(), json!({"detail": "Member not found"}));
    }
    let mia = member(&c, &pid, "Mia", "member").await;
    let r = c.delete(&format!("/projects/{other}/members/{}", id(&mia))).await;
    assert_eq!(r.status, 404);
    assert_eq!(r.json(), json!({"detail": "Member not found"}));

    // an AI member is removed on its own page
    let row = json!({"id": "ai-1", "project_id": pid, "name": "Claude Code", "color": "#000000", "role": "member",
        "kind": "ai", "created_at": NOW});
    insert(&s, "member", &row).await;
    let r = c.delete(&format!("/projects/{pid}/members/ai-1")).await;
    assert_eq!(r.status, 400);
    assert_eq!(
        r.json(),
        json!({"detail": "This is an AI member: remove it from the AI members page (it handles its tickets and runs)."})
    );

    // one open ticket, then two; a ticket of another project does not count
    ticket(&s, "TEA-1", &pid, "one", json!({"assignee": mia["id"], "status": "todo"})).await;
    ticket(&s, "OTH-1", &other, "elsewhere", json!({"assignee": mia["id"]})).await;
    let r = c.delete(&path(&mia)).await;
    assert_eq!(r.status, 400);
    assert_eq!(r.json(), json!({"detail": "Cannot remove: assigned to 1 open ticket. Reassign first."}));
    ticket(&s, "TEA-2", &pid, "two", json!({"assignee": mia["id"], "status": "in_progress"})).await;
    let r = c.delete(&path(&mia)).await;
    assert_eq!(r.status, 400);
    assert_eq!(r.json(), json!({"detail": "Cannot remove: assigned to 2 open tickets. Reassign first."}));

    // closed tickets (done, won't do) do not block: the member goes and those tickets have no assignee
    exec(&s, "UPDATE ticket SET status = 'done' WHERE id = 'TEA-1'", &[]).await;
    exec(&s, "UPDATE ticket SET status = 'wont_do' WHERE id = 'TEA-2'", &[]).await;
    let before = scalar(&s, "SELECT updated_at FROM ticket WHERE id = 'TEA-1'", &[]).await;
    let r = c.delete(&path(&mia)).await;
    assert_eq!(r.status, 204, "{}", r.text());
    for ticket_id in ["TEA-1", "TEA-2"] {
        assert_eq!(scalar(&s, "SELECT assignee FROM ticket WHERE id = ?", &[json!(ticket_id)]).await, Value::Null);
    }
    // nothing else of the ticket changes, and the other project's ticket keeps its assignee
    assert_eq!(scalar(&s, "SELECT updated_at FROM ticket WHERE id = 'TEA-1'", &[]).await, before);
    assert_eq!(scalar(&s, "SELECT status FROM ticket WHERE id = 'TEA-2'", &[]).await, json!("wont_do"));
    assert_eq!(scalar(&s, "SELECT assignee FROM ticket WHERE id = 'OTH-1'", &[]).await, mia["id"]);

    // someone who created a ticket stays, whatever its state; that is checked before the assigned tickets
    let ann = member(&c, &pid, "Ann", "member").await;
    ticket(&s, "TEA-3", &pid, "made by Ann", json!({"created_by": ann["id"], "status": "done"})).await;
    ticket(&s, "TEA-4", &pid, "for Ann", json!({"assignee": ann["id"]})).await;
    let r = c.delete(&path(&ann)).await;
    assert_eq!(r.status, 400);
    assert_eq!(r.json(), json!({"detail": "Cannot remove member who created tickets"}));
    assert_eq!(count(&s, "SELECT COUNT(*) FROM member WHERE id = ?", &[ann["id"].clone()]).await, 1);
}

#[tokio::test]
async fn every_change_of_a_member_is_announced() {
    if !skip_unless_available("every_change_of_a_member_is_announced") {
        return;
    }
    let s = Server::start().await;
    let c = s.client();
    let pid = id(&project(&c, "Team", "TEA").await);
    let mut events = s.events().await;
    let m = member(&c, &pid, "Mia", "member").await;
    assert_eq!(events.next(Duration::from_secs(5)).await.as_deref(), Some("invalidate"));
    let path = format!("/projects/{pid}/members/{}", id(&m));
    c.patch(&path, json!({"role": "admin"})).await.assert_status(200);
    assert_eq!(events.next(Duration::from_secs(5)).await.as_deref(), Some("invalidate"));
    c.delete(&path).await.assert_status(204);
    assert_eq!(events.next(Duration::from_secs(5)).await.as_deref(), Some("invalidate"));
    // a refused change announces nothing
    c.patch(&path, json!({"role": "admin"})).await.assert_status(404);
    c.delete(&path).await.assert_status(404);
    c.post(&format!("/projects/{pid}/members"), json!({"name": " "})).await.assert_status(422);
    assert_eq!(events.next(Duration::from_millis(700)).await, None);
}
