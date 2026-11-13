//! Every route of the second half of `api/tickets.py` (reopen, pending, comments, acceptance criteria, sub-tasks, the
//! work log, test cases, the activity feed, blocks, links, branches), the success case and each error branch: both
//! servers answer the same status and the same JSON (ids and times normalized).
//!
//! The answers of the Python server are kept in `contract/golden/ticket_sub_routes.json`, one entry per request, and
//! each server is compared with them. To write the file again after the requests change:
//! `PARITY_TARGET=python KANBAN_WRITE_GOLDEN=1 cargo test -p kb-board --test tickets_sub_routes`.
//!
//! A 422 that Pydantic writes is compared by status and by the fields it names (its wording is not part of the
//! contract); an unhandled error by its status and Starlette's text.

#![recursion_limit = "256"]

mod common;

use std::path::Path;

use common::{exec, id, member, new_ticket, project};
use serde_json::{Map, Value, json};
use testkit::{Server, Target, normalize, skip_unless_available, target};

const GOLDEN: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../contract/golden/ticket_sub_routes.json");

/// The requests of one part and what was answered.
struct Tape<'a> {
    server: &'a Server,
    steps: Vec<Value>,
}

impl Tape<'_> {
    /// One request (by a client of its own: the Python server closes the connection after a 500), recorded under
    /// `label`. Returns the JSON of the answer (null when it is not JSON).
    async fn call(&mut self, label: &str, method: &str, path: &str, body: Option<Value>) -> Value {
        self.call_as(label, None, method, path, body).await
    }

    async fn call_as(
        &mut self,
        label: &str,
        actor: Option<&str>,
        method: &str,
        path: &str,
        body: Option<Value>,
    ) -> Value {
        let mut c = self.server.client();
        if let Some(actor) = actor {
            c = c.header("X-Actor", actor);
        }
        let r = match body {
            Some(body) => {
                let bytes = serde_json::to_vec(&body).expect("json");
                c.request(method, path, &[("content-type", "application/json")], Some(bytes)).await
            }
            None => c.request(method, path, &[], None).await,
        };
        let parsed: Option<Value> = serde_json::from_slice(&r.body).ok();
        let shown = match &parsed {
            // Pydantic's 422: the fields it names
            Some(body) if r.status == 422 && body["detail"].is_array() => {
                let locs: Vec<Value> =
                    body["detail"].as_array().expect("detail").iter().map(|e| e["loc"].clone()).collect();
                json!({"fields": locs})
            }
            Some(body) => body.clone(),
            None => json!(r.text()),
        };
        self.steps.push(json!({"request": label, "status": r.status, "answer": shown}));
        parsed.unwrap_or(Value::Null)
    }
}

/// The id of the last item of a list field of a ticket.
fn last_id(ticket: &Value, field: &str) -> String {
    id(ticket[field].as_array().expect("list").last().expect("an item"))
}

async fn reopen_and_pending(s: &Server, t: &mut Tape<'_>) {
    let c = s.client();
    let pid = id(&project(&c, "Reopen", "REO").await);
    let other = id(&project(&c, "Other", "ORE").await);
    let bao = member(&c, &pid, "Bao", "member").await;
    for title in ["Closed", "Parent", "Child", "Waiting", "Blocker"] {
        new_ticket(&c, &pid, json!({"title": title})).await;
    }
    new_ticket(&c, &other, json!({"title": "Elsewhere"})).await;
    c.patch("/tickets/REO-3", json!({"parent_id": "REO-2"})).await.assert_status(200);

    // reopen
    t.call("reopen: no ticket", "POST", "/tickets/NOPE-1/reopen", Some(json!({}))).await;
    t.call("reopen: an open ticket", "POST", "/tickets/REO-1/reopen", Some(json!({}))).await;
    t.call("reopen: no body", "POST", "/tickets/REO-1/reopen", None).await;
    t.call("reopen: a flag that is not one", "POST", "/tickets/REO-1/reopen", Some(json!({"reset_ac": "x"}))).await;
    c.post("/tickets/REO-1/acceptance-criteria", json!({"text": "passes"})).await.assert_status(200);
    let one = c.post("/tickets/REO-1/acceptance-criteria", json!({"text": "open one"})).await.json();
    let first = id(&one["acceptance_criteria"][0]);
    common::patch_empty(&c, &format!("/tickets/REO-1/acceptance-criteria/{first}/toggle")).await.assert_status(200);
    c.post("/tickets/REO-1/test-cases", json!({"title": "passes", "status": "pass"})).await.assert_status(200);
    c.post("/tickets/REO-1/test-cases", json!({"title": "waits"})).await.assert_status(200);
    c.patch("/tickets/REO-1", json!({"assignee": bao["id"], "status": "done"})).await.assert_status(200);
    t.call(
        "reopen: a reason that is too long",
        "POST",
        "/tickets/REO-1/reopen",
        Some(json!({"reason": "x".repeat(241)})),
    )
    .await;
    let body = json!({"reason": "  Regression on prod  ", "reset_ac": true, "reset_tests": true, "unassign": true,
        "actor": "Linh Pham"});
    t.call("reopen: from Done, everything reset", "POST", "/tickets/REO-1/reopen", Some(body)).await;
    t.call("reopen: again, now open", "POST", "/tickets/REO-1/reopen", Some(json!({}))).await;
    c.patch("/tickets/REO-1", json!({"status": "wont_do", "wont_do_reason": "no"})).await.assert_status(200);
    t.call("reopen: from Won't Do, by default", "POST", "/tickets/REO-1/reopen", Some(json!({"reason": "  "}))).await;
    t.call(
        "undo reopen: back to Won't Do, the first reopen is the latest again",
        "POST",
        "/tickets/REO-1/reopen/undo",
        None,
    )
    .await;
    t.call("undo reopen: not in To Do", "POST", "/tickets/REO-1/reopen/undo", None).await;
    t.call("undo reopen: no ticket", "POST", "/tickets/NOPE-1/reopen/undo", None).await;
    t.call("undo reopen: never reopened", "POST", "/tickets/REO-4/reopen/undo", None).await;
    let body = json!({"actor": null, "reset_ac": true, "reset_tests": true});
    t.call("reopen: no actor, nothing left to reset", "POST", "/tickets/REO-1/reopen", Some(body)).await;
    // a child and its parent
    c.patch("/tickets/REO-3/status", json!({"status": "done"})).await.assert_status(200);
    let body = json!({"reopen_parent": true, "actor": ""});
    t.call("reopen: the parent is open, only the child", "POST", "/tickets/REO-3/reopen", Some(body.clone())).await;
    c.patch("/tickets/REO-3/status", json!({"status": "done"})).await.assert_status(200);
    c.patch("/tickets/REO-2", json!({"status": "wont_do", "wont_do_reason": "dropped"})).await.assert_status(200);
    t.call("reopen: the child and its closed parent", "POST", "/tickets/REO-3/reopen", Some(body)).await;
    t.call("reopen: the parent after it", "GET", "/tickets/REO-2", None).await;
    t.call("undo reopen: the child only", "POST", "/tickets/REO-3/reopen/undo", None).await;

    // pending
    let put = "/tickets/REO-4/pending";
    t.call("pending: no ticket", "PUT", "/tickets/NOPE-1/pending", Some(json!({"reason_type": "party", "party": "X"})))
        .await;
    t.call("pending: no reason type", "PUT", put, Some(json!({}))).await;
    t.call("pending: a reason type that is none", "PUT", put, Some(json!({"reason_type": "weather"}))).await;
    let stranger = member(&c, &other, "Stranger", "member").await;
    for (label, body) in [
        ("a ticket that is not named", json!({"reason_type": "ticket"})),
        ("an empty ticket id", json!({"reason_type": "ticket", "ticket_id": ""})),
        ("itself", json!({"reason_type": "ticket", "ticket_id": "REO-4"})),
        ("a ticket that does not exist", json!({"reason_type": "ticket", "ticket_id": "NOPE-1"})),
        (
            "blocked by a ticket of another project",
            json!({"reason_type": "ticket", "ticket_id": "ORE-1", "add_blocked_by": true}),
        ),
        ("a person that is not named", json!({"reason_type": "person"})),
        ("a person that does not exist", json!({"reason_type": "person", "member_id": "missing"})),
        ("a party that is blank", json!({"reason_type": "party", "party": "   "})),
        ("a party that is not named", json!({"reason_type": "party", "ticket_id": "REO-5"})),
        ("a party that is too long", json!({"reason_type": "party", "party": "x".repeat(241)})),
        ("a note that is too long", json!({"reason_type": "party", "party": "X", "note": "n".repeat(241)})),
    ] {
        t.call(&format!("pending: {label}"), "PUT", put, Some(body)).await;
    }
    let body = json!({"reason_type": "party", "party": "  Client  ", "note": " asked on Monday ", "ticket_id": "REO-5",
        "member_id": bao["id"]});
    t.call_as("pending: on a party", Some("An Nguyen"), "PUT", put, Some(body)).await;
    let body = json!({"reason_type": "person", "member_id": stranger["id"], "party": "ignored", "actor": "Bao"});
    t.call("pending: on a person, of any project, while already pending", "PUT", put, Some(body)).await;
    t.call(
        "pending: on a ticket of another project",
        "PUT",
        put,
        Some(json!({"reason_type": "ticket", "ticket_id": "ORE-1"})),
    )
    .await;
    let body = json!({"reason_type": "ticket", "ticket_id": "REO-5", "add_blocked_by": true, "actor": null});
    t.call("pending: on a ticket that then blocks it", "PUT", put, Some(body.clone())).await;
    t.call("pending: the same again", "PUT", put, Some(body)).await;
    t.call("pending: the ticket it waits for", "GET", "/tickets/REO-5", None).await;
    c.patch("/tickets/REO-1/status", json!({"status": "done"})).await.assert_status(200);
    t.call(
        "pending: a closed ticket",
        "PUT",
        "/tickets/REO-1/pending",
        Some(json!({"reason_type": "party", "party": "X"})),
    )
    .await;

    // resume
    t.call("resume: no ticket", "POST", "/tickets/NOPE-1/resume", None).await;
    t.call("resume: no ticket, by DELETE", "DELETE", "/tickets/NOPE-1/pending", None).await;
    t.call("resume: not pending", "POST", "/tickets/REO-5/resume", Some(json!({"reason": "x"}))).await;
    t.call("resume: not pending, by DELETE", "DELETE", "/tickets/REO-5/pending", None).await;
    t.call(
        "resume: a reason that is too long",
        "POST",
        "/tickets/REO-4/resume",
        Some(json!({"reason": "x".repeat(241)})),
    )
    .await;
    t.call("resume: a flag that is not one", "POST", "/tickets/REO-4/resume", Some(json!({"add_comment": "x"}))).await;
    let body = json!({"reason": "  The contract is final  ", "add_comment": true, "actor": "Hà My"});
    t.call("resume: with a reason and a comment", "POST", "/tickets/REO-4/resume", Some(body)).await;
    t.call("resume: twice", "POST", "/tickets/REO-4/resume", None).await;
    for (label, method, path, body) in [
        ("by DELETE without a body", "DELETE", "/tickets/REO-4/pending", None),
        ("a comment asked for without a reason", "POST", "/tickets/REO-4/resume", Some(json!({"add_comment": true}))),
        (
            "a reason without a comment, no actor",
            "DELETE",
            "/tickets/REO-4/pending",
            Some(json!({"reason": "ok", "actor": null})),
        ),
        ("a body that is null", "POST", "/tickets/REO-4/resume", Some(Value::Null)),
    ] {
        c.put(put, json!({"reason_type": "party", "party": "X"})).await.assert_status(200);
        t.call(&format!("resume: {label}"), method, path, body).await;
    }
    // a stored time without an offset cannot be subtracted from now
    c.put(put, json!({"reason_type": "party", "party": "X"})).await.assert_status(200);
    exec(s, "UPDATE ticket SET pending_since = '2026-01-01T00:00:00' WHERE id = 'REO-4'", &[]).await;
    t.call("resume: pending since a time without an offset", "POST", "/tickets/REO-4/resume", None).await;
    exec(s, "UPDATE ticket SET pending_since = 'last week' WHERE id = 'REO-4'", &[]).await;
    t.call("resume: pending since something that is no time", "POST", "/tickets/REO-4/resume", None).await;
    c.put(put, json!({"reason_type": "party", "party": "X"})).await.assert_status(200);
    exec(s, "UPDATE ticket SET pending_since = '2020-02-01T00:00:00+07:00' WHERE id = 'REO-4'", &[]).await;
    let resumed = c.post_empty("/tickets/REO-4/resume").await.json();
    let cleared = resumed["activity_log"].as_array().expect("log").last().expect("entry").clone();
    assert!(cleared["duration_days"].as_i64().expect("days") > 2000, "{cleared}");
}

async fn comments(s: &Server, t: &mut Tape<'_>) {
    let c = s.client();
    let pid = id(&project(&c, "Comments", "COM").await);
    let bao = member(&c, &pid, "Bao", "member").await;
    let ha = member(&c, &pid, "Hà My", "admin").await;
    let chi = member(&c, &pid, "Chi", "member").await;
    new_ticket(&c, &pid, json!({"title": "Talked about", "assignee": bao["id"]})).await;
    let url = "/tickets/COM-1/comments";

    t.call("comment: no ticket", "POST", "/tickets/NOPE-1/comments", Some(json!({"text": "hi"}))).await;
    t.call("comment: no text", "POST", url, Some(json!({"author": "x"}))).await;
    t.call("comment: a blank text", "POST", url, Some(json!({"text": " \n "}))).await;
    t.call("comment: a text that is too long", "POST", url, Some(json!({"text": "y".repeat(50_001)}))).await;
    t.call("comment: an intent that is none", "POST", url, Some(json!({"text": "hi", "ai_intent": "shout"}))).await;
    t.call("comment: an author that is null", "POST", url, Some(json!({"text": "hi", "author": null}))).await;
    let first = t
        .call("comment: by the board's user", "POST", url, Some(json!({"text": "  First, see [[Spec#Goal]]  "})))
        .await;
    let first = last_id(&first, "comments");
    let text = format!("@[Hà My](member:{}) and @[Nobody](member:nobody), look at [[Spec]]", id(&ha));
    let body = json!({"text": text, "author": "hà my", "ai_intent": "notify", "ai_fast": true, "reply_to": ""});
    t.call("comment: by a member named in another case, with mentions", "POST", url, Some(body)).await;
    let body = json!({"text": "A reply", "author": id(&chi), "reply_to": first, "ai_intent": null});
    let reply = t.call_as("comment: a reply, by a member's id", Some("Chi"), "POST", url, Some(body)).await;
    let reply = last_id(&reply, "comments");
    t.call(
        "comment: a reply to a comment that is not there",
        "POST",
        url,
        Some(json!({"text": "Lost", "reply_to": "gone"})),
    )
    .await;
    // an AI member's comment (written by the AI team): a reply under it asks that AI again
    let stored = c.get("/tickets/COM-1").await.json();
    let mut all = stored["comments"].as_array().expect("comments").clone();
    all.push(
        json!({"id": "ai-1", "text": "Done.", "author": "Robo", "at": common::NOW, "ai": {"member_id": "m-robo"}}),
    );
    exec(s, "UPDATE ticket SET comments = ? WHERE id = 'COM-1'", &[json!(Value::Array(all).to_string())]).await;
    t.call("comment: a reply to an AI's comment", "POST", url, Some(json!({"text": "And then?", "reply_to": "ai-1"})))
        .await;

    // edit
    let one = format!("{url}/{first}");
    t.call(
        "edit comment: no ticket",
        "PATCH",
        &format!("/tickets/NOPE-1/comments/{first}"),
        Some(json!({"text": "x"})),
    )
    .await;
    t.call("edit comment: no comment", "PATCH", &format!("{url}/nope"), Some(json!({"text": "x"}))).await;
    t.call("edit comment: no text", "PATCH", &one, Some(json!({}))).await;
    t.call("edit comment: a blank text", "PATCH", &one, Some(json!({"text": "  "}))).await;
    let text = format!("Now [[Spec]] and @[Bao](member:{})", id(&bao));
    t.call("edit comment: a new text", "PATCH", &one, Some(json!({"text": text.clone()}))).await;
    t.call("edit comment: the same text", "PATCH", &one, Some(json!({"text": format!(" {text} ")}))).await;

    // delete and restore
    t.call("delete comment: no ticket", "DELETE", &format!("/tickets/NOPE-1/comments/{first}"), None).await;
    t.call("delete comment: no comment", "DELETE", &format!("{url}/nope"), None).await;
    t.call("restore comment: not deleted", "POST", &format!("{one}/restore"), None).await;
    t.call("delete comment", "DELETE", &one, None).await;
    t.call("delete comment: twice", "DELETE", &one, None).await;
    t.call("edit comment: a deleted one", "PATCH", &one, Some(json!({"text": "x"}))).await;
    t.call(
        "comment: after a delete, the deleted author is not told",
        "POST",
        url,
        Some(json!({"text": "Anyone?", "author": "Chi"})),
    )
    .await;
    t.call("restore comment: no ticket", "POST", &format!("/tickets/NOPE-1/comments/{first}/restore"), None).await;
    t.call("restore comment: no comment", "POST", &format!("{url}/nope/restore"), None).await;
    t.call("restore comment", "POST", &format!("{one}/restore"), None).await;
    t.call("delete comment: a reply", "DELETE", &format!("{url}/{reply}"), None).await;
    t.call("activities: of the project", "GET", &format!("/projects/{pid}/activities"), None).await;
}

async fn checklists_work_log_and_test_cases(s: &Server, t: &mut Tape<'_>) {
    let c = s.client();
    let pid = id(&project(&c, "Lists", "LST").await);
    new_ticket(&c, &pid, json!({"title": "Listed"})).await;

    for (name, path, limit) in [("criterion", "acceptance-criteria", 1000), ("sub-task", "sub-tasks", 500)] {
        let url = format!("/tickets/LST-1/{path}");
        t.call(&format!("{name}: no ticket"), "POST", &format!("/tickets/NOPE-1/{path}"), Some(json!({"text": "x"})))
            .await;
        t.call(&format!("{name}: no text"), "POST", &url, Some(json!({}))).await;
        t.call(&format!("{name}: a text that is not one"), "POST", &url, Some(json!({"text": 3}))).await;
        t.call(&format!("{name}: a blank text"), "POST", &url, Some(json!({"text": "  "}))).await;
        t.call(&format!("{name}: a text that is too long"), "POST", &url, Some(json!({"text": "x".repeat(limit + 1)})))
            .await;
        t.call(&format!("{name}: at the limit"), "POST", &url, Some(json!({"text": "ă".repeat(limit)}))).await;
        let added = t
            .call_as(
                &format!("{name}: added"),
                Some("An Nguyen"),
                "POST",
                &url,
                Some(json!({"text": "  Đạt [[Spec]]  "})),
            )
            .await;
        let field = path.replace('-', "_");
        let item = last_id(&added, &field);
        t.call(&format!("{name}: toggle, no ticket"), "PATCH", &format!("/tickets/NOPE-1/{path}/{item}/toggle"), None)
            .await;
        t.call(&format!("{name}: toggle, no item"), "PATCH", &format!("{url}/nope/toggle"), None).await;
        t.call(&format!("{name}: toggle on"), "PATCH", &format!("{url}/{item}/toggle"), None).await;
        t.call(&format!("{name}: toggle off"), "PATCH", &format!("{url}/{item}/toggle"), Some(json!({"ignored": 1})))
            .await;
        t.call(&format!("{name}: delete, no ticket"), "DELETE", &format!("/tickets/NOPE-1/{path}/{item}"), None).await;
        t.call(&format!("{name}: delete, no item"), "DELETE", &format!("{url}/nope"), None).await;
        t.call(&format!("{name}: delete"), "DELETE", &format!("{url}/{item}"), None).await;
    }

    // test cases
    let url = "/tickets/LST-1/test-cases";
    let ac = c.get("/tickets/LST-1").await.json()["acceptance_criteria"][0]["id"].clone();
    t.call("test case: no ticket", "POST", "/tickets/NOPE-1/test-cases", Some(json!({"title": "x"}))).await;
    t.call("test case: no title", "POST", url, Some(json!({}))).await;
    t.call("test case: a blank title", "POST", url, Some(json!({"title": " "}))).await;
    t.call("test case: a title that is too long", "POST", url, Some(json!({"title": "x".repeat(301)}))).await;
    t.call("test case: a status that is none", "POST", url, Some(json!({"title": "x", "status": "skipped"}))).await;
    t.call("test case: files that are not objects", "POST", url, Some(json!({"title": "x", "notes_files": ["a"]})))
        .await;
    t.call(
        "test case: a criterion that is not there",
        "POST",
        url,
        Some(json!({"title": "x", "criterion_id": "nope"})),
    )
    .await;
    let one = t.call("test case: a title alone", "POST", url, Some(json!({"title": "  Opens  "}))).await;
    let one = last_id(&one, "test_cases");
    let body = json!({"title": "Runs", "status": "running", "note": "a short note", "criterion_id": ac, "assignee": "alex",
        "description": "As in [[Spec#Run]]", "expected_result": "Like [[Spec]]", "proof": "[[Proof]]",
        "test_data_files": [{"id": "f1", "name": "data.csv", "url": "/uploads/data.csv", "size": 3}],
        "expected_files": [{"anything": [1, 2.0, null]}], "notes_files": []});
    let two = t.call_as("test case: running, with every field", Some("Ha My"), "POST", url, Some(body)).await;
    let two = last_id(&two, "test_cases");
    let body =
        json!({"title": "Passed", "status": "pass", "notes": "the long notes", "note": "short", "criterion_id": ""});
    t.call_as("test case: passed at once", Some("Tuan Vo"), "POST", url, Some(body)).await;
    t.call("test case: delete, no ticket", "DELETE", &format!("/tickets/NOPE-1/test-cases/{one}"), None).await;
    t.call("test case: delete, no test case", "DELETE", &format!("{url}/nope"), None).await;
    t.call("test case: delete the first", "DELETE", &format!("{url}/{one}"), None).await;
    t.call(
        "test case: the next code follows the highest",
        "POST",
        url,
        Some(json!({"title": "Fourth", "status": "fail"})),
    )
    .await;
    let item = format!("{url}/{two}");
    t.call(
        "edit test case: no ticket",
        "PATCH",
        &format!("/tickets/NOPE-1/test-cases/{two}"),
        Some(json!({"status": "pass"})),
    )
    .await;
    t.call("edit test case: no test case", "PATCH", &format!("{url}/nope"), Some(json!({"status": "pass"}))).await;
    t.call("edit test case: a blank title", "PATCH", &item, Some(json!({"title": " "}))).await;
    t.call("edit test case: a status that is none", "PATCH", &item, Some(json!({"status": "done"}))).await;
    t.call("edit test case: nothing", "PATCH", &item, Some(json!({}))).await;
    t.call_as("edit test case: still running", Some("Other"), "PATCH", &item, Some(json!({"status": "running"}))).await;
    let body = json!({"status": "fail", "title": " Runs twice ", "description": "Now [[Spec]]", "expected_result": "",
        "notes": "See [[Notes]]", "proof": "no proof", "note": "n", "assignee": "", "criterion_id": "",
        "test_data_files": [], "expected_files": [{"id": "e"}], "notes_files": [{"id": "n"}]});
    t.call_as("edit test case: failed, every field", Some("Tuan Vo"), "PATCH", &item, Some(body)).await;
    t.call_as(
        "edit test case: failed again, by another",
        Some("Other"),
        "PATCH",
        &item,
        Some(json!({"status": "fail"})),
    )
    .await;
    t.call_as(
        "edit test case: running again",
        Some("Chi"),
        "PATCH",
        &item,
        Some(json!({"status": "running", "criterion_id": "anything"})),
    )
    .await;
    t.call(
        "edit test case: back to pending",
        "PATCH",
        &item,
        Some(json!({"status": "pending", "title": "Runs twice"})),
    )
    .await;

    // work log
    let url = "/tickets/LST-1/work-log";
    let entry = |extra: Value| {
        let mut entry = json!({"author": "An", "role": "Developer", "note": "found it"});
        for (key, value) in extra.as_object().expect("extra") {
            entry[key] = value.clone();
        }
        Some(entry)
    };
    c.post("/tickets/LST-1/branches", json!({"name": "fix/it"})).await.assert_status(201);
    t.call("work log: no ticket", "POST", "/tickets/NOPE-1/work-log", entry(json!({}))).await;
    t.call("work log: no author", "POST", url, Some(json!({"role": "Developer", "note": "n"}))).await;
    for (label, extra) in [
        ("a role that is none", json!({"role": "Wizard"})),
        ("a kind that is none", json!({"kind": "weird"})),
        ("attachments that are not objects", json!({"attachments": ["x"]})),
        ("a blank author", json!({"author": "  "})),
        ("a blank note", json!({"note": " \n"})),
        ("a note that is too long", json!({"note": "x".repeat(20_001)})),
        ("a branch that is not the ticket's", json!({"linked_branch": "fix/nope"})),
        ("a test case that is not the ticket's", json!({"linked_test_case": "TC-99"})),
        ("an attachment from elsewhere", json!({"attachments": [{"name": "a", "url": "https://evil.example/a"}]})),
        ("an attachment that climbs", json!({"attachments": [{"name": "a", "url": "/uploads/../a"}]})),
        ("an attachment without a name", json!({"attachments": [{"url": "/uploads/a", "name": " "}]})),
    ] {
        t.call(&format!("work log: {label}"), "POST", url, entry(extra)).await;
    }
    let plain = t
        .call("work log: a note alone", "POST", url, entry(json!({"note": "  padded [[Spec]]  ", "author": "user"})))
        .await;
    let plain = last_id(&plain, "work_log");
    let body = entry(json!({"role": "Tester", "kind": "root_cause", "pinned": true, "linked_branch": " fix/it ",
        "linked_test_case": two, "note": "x".repeat(300),
        "attachments": [{"id": "att-1", "name": "n".repeat(201), "url": "/uploads/t.log", "size": 12, "type": "t".repeat(101), "more": 1},
            {"name": 5, "url": "/uploads/five", "size": 1.5, "type": ""}]}));
    let full = t.call("work log: every field", "POST", url, body).await;
    let full = last_id(&full, "work_log");
    let item = format!("{url}/{full}");
    t.call(
        "edit work log: no ticket",
        "PATCH",
        &format!("/tickets/NOPE-1/work-log/{full}"),
        Some(json!({"note": "x"})),
    )
    .await;
    t.call("edit work log: no entry", "PATCH", &format!("{url}/nope"), Some(json!({"note": "x"}))).await;
    for (label, body) in [
        ("a kind that is none", json!({"kind": "weird"})),
        ("a blank note", json!({"note": " "})),
        ("a blank author", json!({"author": ""})),
        ("a branch that is not the ticket's", json!({"linked_branch": "fix/nope"})),
        ("a test case that is not the ticket's", json!({"linked_test_case": "TC-99", "linked_branch": ""})),
        ("an attachment from elsewhere", json!({"attachments": [{"name": "a", "url": "/elsewhere/a"}]})),
        ("nothing", json!({})),
        ("the same note", json!({"note": "x".repeat(300)})),
        (
            "a new note, kind, author and role",
            json!({"note": " shorter ", "kind": "resolved", "author": "Bao", "role": "PM", "pinned": false}),
        ),
        ("links cleared", json!({"linked_branch": "", "linked_test_case": "  "})),
        ("a link by code, the other left", json!({"linked_test_case": "TC-2"})),
        ("attachments replaced", json!({"attachments": [{"name": "new.txt", "url": "/uploads/new.txt"}]})),
        ("attachments emptied", json!({"attachments": []})),
    ] {
        t.call(&format!("edit work log: {label}"), "PATCH", &item, Some(body)).await;
    }
    t.call("delete work log: no ticket", "DELETE", &format!("/tickets/NOPE-1/work-log/{full}"), None).await;
    t.call("delete work log: no entry", "DELETE", &format!("{url}/nope"), None).await;
    t.call("delete work log", "DELETE", &format!("{url}/{plain}"), None).await;

    // the activity feed: a change reads as Python prints the two values
    c.patch("/tickets/LST-1", json!({"tags": ["a", "it's"], "estimate": 2, "priority": "high"}))
        .await
        .assert_status(200);
    c.patch("/tickets/LST-1", json!({"tags": [], "estimate": null})).await.assert_status(200);
    let feed = format!("/projects/{pid}/activities");
    t.call("activities: the newest", "GET", &format!("{feed}?limit=6"), None).await;
    t.call("activities: a limit of none", "GET", &format!("{feed}?limit=0"), None).await;
    t.call("activities: a limit over the most", "GET", &format!("{feed}?limit=1001"), None).await;
    t.call("activities: a limit that is no number", "GET", &format!("{feed}?limit=many"), None).await;
    t.call("activities: a project that is not there", "GET", "/projects/nope/activities", None).await;
    let all = t.call("activities: all of the project", "GET", &format!("{feed}?limit=1000"), None).await;
    assert!(all.as_array().expect("events").len() > 20);
}

async fn blocks_and_links(s: &Server, t: &mut Tape<'_>) {
    let c = s.client();
    let pid = id(&project(&c, "Relations", "REL").await);
    let other = id(&project(&c, "Other", "ORL").await);
    for title in ["A", "B", "C", "D"] {
        new_ticket(&c, &pid, json!({"title": title})).await;
    }
    new_ticket(&c, &other, json!({"title": "Elsewhere"})).await;

    for (label, method, path) in [
        ("block: itself", "POST", "/tickets/REL-1/blocks/REL-1"),
        ("block: no blocker", "POST", "/tickets/NOPE-1/blocks/REL-1"),
        ("block: no blocked ticket", "POST", "/tickets/REL-1/blocks/NOPE-1"),
        ("block: a ticket of another project", "POST", "/tickets/REL-1/blocks/ORL-1"),
        ("block: A blocks B", "POST", "/tickets/REL-1/blocks/REL-2"),
        ("block: A blocks B, again", "POST", "/tickets/REL-1/blocks/REL-2"),
        ("block: B blocks C", "POST", "/tickets/REL-2/blocks/REL-3"),
        ("block: A blocks C too", "POST", "/tickets/REL-1/blocks/REL-3"),
        ("block: a direct circle", "POST", "/tickets/REL-2/blocks/REL-1"),
        ("block: a circle through B", "POST", "/tickets/REL-3/blocks/REL-1"),
        ("unblock: no blocker", "DELETE", "/tickets/NOPE-1/blocks/REL-1"),
        ("unblock: no blocked ticket", "DELETE", "/tickets/REL-1/blocks/NOPE-1"),
        ("unblock: tickets that are not linked", "DELETE", "/tickets/REL-3/blocks/REL-4"),
        ("unblock: the other way round", "DELETE", "/tickets/REL-2/blocks/REL-1"),
        ("unblock: a ticket and itself", "DELETE", "/tickets/REL-4/blocks/REL-4"),
        ("unblock: A and B", "DELETE", "/tickets/REL-1/blocks/REL-2"),
        ("unblock: A and B, again", "DELETE", "/tickets/REL-1/blocks/REL-2"),
    ] {
        t.call(label, method, path, None).await;
    }
    // a ticket that names itself as blocked (a row from elsewhere): one row plays both parts
    exec(s, r#"UPDATE ticket SET blocks = '["REL-4", "REL-9"]', blocked_by = '["REL-4"]' WHERE id = 'REL-4'"#, &[])
        .await;
    t.call("unblock: a ticket that blocks itself", "DELETE", "/tickets/REL-4/blocks/REL-4", None).await;

    let url = "/tickets/REL-1/links";
    let link = |target: &str, relation: &str| Some(json!({"target_id": target, "relation_type": relation}));
    t.call("link: no target", "POST", url, Some(json!({"relation_type": "causes"}))).await;
    t.call("link: a relation that is none", "POST", url, link("REL-2", "blocks")).await;
    t.call("link: itself", "POST", url, link("REL-1", "causes")).await;
    t.call("link: no ticket", "POST", "/tickets/NOPE-1/links", link("REL-2", "causes")).await;
    t.call("link: no target ticket", "POST", url, link("NOPE-1", "causes")).await;
    t.call("link: a ticket of another project", "POST", url, link("ORL-1", "relates_to")).await;
    let causes = t.call_as("link: A causes B", Some("An Nguyen"), "POST", url, link("REL-2", "causes")).await;
    t.call("link: A causes B, again", "POST", url, link("REL-2", "causes")).await;
    t.call("link: both tickets after it", "GET", &format!("/projects/{pid}/tickets"), None).await;
    for (relation, target) in
        [("caused_by", "REL-2"), ("duplicates", "REL-3"), ("duplicated_by", "REL-3"), ("relates_to", "REL-4")]
    {
        t.call(&format!("link: A {relation} {target}"), "POST", url, link(target, relation)).await;
    }
    // the inverse is already on the target: only this side is added
    t.call("link: B causes A, which A already says", "POST", "/tickets/REL-2/links", link("REL-1", "causes")).await;
    t.call("unlink: no ticket", "DELETE", &format!("/tickets/NOPE-1/links/{}", id(&causes)), None).await;
    t.call("unlink: no link", "DELETE", &format!("{url}/nope"), None).await;
    t.call("unlink: A causes B", "DELETE", &format!("{url}/{}", id(&causes)), None).await;
    t.call("unlink: twice", "DELETE", &format!("{url}/{}", id(&causes)), None).await;
    // links from elsewhere: a target that is gone, a relation nobody knows, a link that is not complete
    let stored = r#"[{"id": "gone", "target_id": "REL-99", "relation_type": "causes"}, {"id": "odd", "target_id": "REL-3", "relation_type": "mirrors"}, {"id": "bare"}, {"id": "dup", "target_id": "REL-3", "relation_type": "relates_to", "extra": 1}, {"id": 7, "target_id": "REL-4", "relation_type": "causes"}]"#;
    exec(s, "UPDATE ticket SET links = ? WHERE id = 'REL-1'", &[json!(stored)]).await;
    t.call("link: one that is stored with more fields", "POST", url, link("REL-3", "relates_to")).await;
    t.call("link: one that is stored with an id that is no text", "POST", url, link("REL-4", "causes")).await;
    for stored_id in ["gone", "odd", "bare"] {
        t.call(&format!("unlink: the stored link '{stored_id}'"), "DELETE", &format!("{url}/{stored_id}"), None).await;
    }
    t.call("relations: every ticket at the end", "GET", &format!("/projects/{pid}/tickets"), None).await;
    t.call("relations: the activity feed", "GET", &format!("/projects/{pid}/activities"), None).await;
}

async fn branches_without_a_repository(s: &Server, t: &mut Tape<'_>) {
    let c = s.client();
    let pid = id(&project(&c, "Branches", "BRA").await);
    new_ticket(&c, &pid, json!({"title": "Branched"})).await;
    let url = "/tickets/BRA-1/branches";

    for (label, method, path) in [
        ("default base: no ticket", "GET", "/tickets/NOPE-1/branches/base"),
        ("default base: no repository", "GET", "/tickets/BRA-1/branches/base"),
        ("branches: no ticket", "GET", "/tickets/NOPE-1/branches"),
        ("branches: none yet", "GET", url),
        ("graph: no ticket", "GET", "/tickets/NOPE-1/graph"),
        ("graph: no repository", "GET", "/tickets/BRA-1/graph?limit=-3"),
        ("graph: a limit that is no number", "GET", "/tickets/BRA-1/graph?limit=few"),
        ("commit: no ticket", "GET", "/tickets/NOPE-1/commits/abcdef1"),
        ("commit: no repository", "GET", "/tickets/BRA-1/commits/abcdef1"),
    ] {
        t.call(label, method, path, None).await;
    }
    t.call("branch: no ticket", "POST", "/tickets/NOPE-1/branches", Some(json!({"name": "x"}))).await;
    t.call("branch: no name", "POST", url, Some(json!({}))).await;
    t.call("branch: a status that is none", "POST", url, Some(json!({"name": "x", "status": "closed"}))).await;
    t.call("branch: a count that is not whole", "POST", url, Some(json!({"name": "x", "ahead_count": 1.5}))).await;
    t.call("branch: a base that is null", "POST", url, Some(json!({"name": "x", "branch_from": null}))).await;
    t.call("branch: a worktree without a repository", "POST", url, Some(json!({"name": "x", "create_worktree": true})))
        .await;
    t.call(
        "branch: a worktree path without a repository",
        "POST",
        url,
        Some(json!({"name": "x", "worktree_path": " /tmp/wt "})),
    )
    .await;
    let one =
        t.call("branch: a name alone", "POST", url, Some(json!({"name": "feature/one", "worktree_path": "  "}))).await;
    let one = last_id(&one, "branches");
    let body = json!({"name": "Tính năng/hai", "branch_from": "develop", "status": "baseline", "pr_url": "https://example.com/pr/2",
        "commit_hash": "abc1234", "linked_ticket_id": "BRA-9", "ahead_count": 2.0, "behind_count": 1});
    t.call_as("branch: every field", Some("An Nguyen"), "POST", url, Some(body)).await;
    t.call("branches: as stored", "GET", url, None).await;

    let item = format!("{url}/{one}");
    t.call("edit branch: no ticket", "PATCH", &format!("/tickets/NOPE-1/branches/{one}"), Some(json!({"name": "x"})))
        .await;
    t.call("edit branch: no branch", "PATCH", &format!("{url}/nope"), Some(json!({"name": "x"}))).await;
    t.call("edit branch: the id 'base'", "PATCH", &format!("{url}/base"), Some(json!({"name": "x"}))).await;
    t.call("edit branch: a status that is none", "PATCH", &item, Some(json!({"status": "closed"}))).await;
    t.call("edit branch: a count that is no number", "PATCH", &item, Some(json!({"behind_count": "two"}))).await;
    t.call("edit branch: nothing", "PATCH", &item, Some(json!({}))).await;
    let body = json!({"name": "feature/uno", "status": "merged", "branch_from": "release", "pr_url": "https://example.com/pr/1",
        "commit_hash": "fff0000", "linked_ticket_id": "BRA-2", "ahead_count": 5, "behind_count": 0, "worktree_path": "/tmp/wt-one"});
    t.call("edit branch: every field", "PATCH", &item, Some(body)).await;
    t.call(
        "edit branch: the same name and status",
        "PATCH",
        &item,
        Some(json!({"name": "feature/uno", "status": "merged"})),
    )
    .await;
    t.call("edit branch: the worktree path cleared", "PATCH", &item, Some(json!({"worktree_path": "  "}))).await;
    c.patch(&item, json!({"worktree_path": "/tmp/wt-two"})).await.assert_status(200);
    t.call(
        "edit branch: the worktree removed",
        "PATCH",
        &item,
        Some(json!({"remove_worktree": true, "worktree_path": "/tmp/kept?"})),
    )
    .await;
    t.call(
        "edit branch: no worktree to remove, a path given",
        "PATCH",
        &item,
        Some(json!({"remove_worktree": true, "worktree_path": "/tmp/wt-three"})),
    )
    .await;

    t.call("checkout: no ticket", "POST", &format!("/tickets/NOPE-1/branches/{one}/checkout"), None).await;
    t.call("checkout: no branch", "POST", &format!("{url}/nope/checkout"), None).await;
    t.call("checkout: the id 'base'", "POST", &format!("{url}/base/checkout"), None).await;
    t.call("checkout: no repository", "POST", &format!("{item}/checkout"), None).await;

    t.call("delete branch: no ticket", "DELETE", &format!("/tickets/NOPE-1/branches/{one}"), None).await;
    t.call("delete branch: no branch", "DELETE", &format!("{url}/nope?force=1"), None).await;
    t.call("delete branch: the id 'base'", "DELETE", &format!("{url}/base"), None).await;
    t.call("delete branch: a flag that is not one", "DELETE", &format!("{item}?force=maybe"), None).await;
    t.call(
        "delete branch: with every flag",
        "DELETE",
        &format!("{item}?remove_worktree=true&delete_git_branch=on&force=YES"),
        None,
    )
    .await;
    t.call("branches: another method on the base path", "POST", &format!("{url}/base"), None).await;
    // a repository that is gone: listing is an unhandled error, the graph and a commit are refused
    exec(s, "UPDATE ticket SET repo_path = '/nonexistent/repo' WHERE id = 'BRA-1'", &[]).await;
    t.call("branches: the repository is gone", "GET", url, None).await;
    t.call("default base: the repository is gone", "GET", &format!("{url}/base"), None).await;
    t.call("graph: the repository is gone", "GET", "/tickets/BRA-1/graph", None).await;
    t.call("commit: the repository is gone", "GET", "/tickets/BRA-1/commits/abcdef1", None).await;
    t.call("branch: the repository is gone", "POST", url, Some(json!({"name": "y"}))).await;
    t.call("delete branch: the repository is gone", "DELETE", &format!("{url}/nope"), None).await;
    t.call(
        "checkout: the repository is gone",
        "POST",
        &format!("{url}/{}/checkout", last_id(&c.get("/tickets/BRA-1").await.json(), "branches")),
        None,
    )
    .await;
}

/// `git` with fixed dates, so that the commits of this test have the same hashes on every run.
fn git(cwd: &Path, args: &[&str]) -> String {
    let out = std::process::Command::new("git")
        .args(args)
        .current_dir(cwd)
        .env("GIT_AUTHOR_DATE", "2026-03-01T10:00:00+00:00")
        .env("GIT_COMMITTER_DATE", "2026-03-01T10:00:00+00:00")
        .output()
        .expect("git runs");
    assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
    String::from_utf8_lossy(&out.stdout).into_owned()
}

fn commit(repo: &Path, branch: &str, fname: &str) {
    git(repo, &["checkout", "-q", branch]);
    std::fs::write(repo.join(fname), fname).expect("write");
    git(repo, &["add", "."]);
    git(repo, &["commit", "-qm", &format!("add {fname}")]);
    git(repo, &["checkout", "-q", "main"]);
}

/// `worktrees` is a folder outside the repository: a worktree inside it would be committed by `git add .`.
async fn branches_in_a_repository(s: &Server, t: &mut Tape<'_>, repo: &Path, worktrees: &Path) {
    let c = s.client();
    git(repo, &["init", "-q", "-b", "main"]);
    git(repo, &["config", "user.email", "t@example.com"]);
    git(repo, &["config", "user.name", "Tester"]);
    std::fs::write(repo.join("a.txt"), "a").expect("write");
    git(repo, &["add", "."]);
    git(repo, &["commit", "-qm", "init"]);
    let pid = id(&project(&c, "Git", "GIT").await);
    c.patch(&format!("/projects/{pid}"), json!({"repo_path": repo.to_string_lossy()})).await.assert_status(200);
    new_ticket(&c, &pid, json!({"title": "In git"})).await;
    let url = "/tickets/GIT-1/branches";

    t.call("git: the default base", "GET", &format!("{url}/base"), None).await;
    t.call("git: the graph before any branch", "GET", "/tickets/GIT-1/graph", None).await;
    let a = t
        .call(
            "git: a branch from main",
            "POST",
            url,
            Some(json!({"name": "feat/a", "ahead_count": 9, "commit_hash": "ignored"})),
        )
        .await;
    let a = last_id(&a, "branches");
    t.call("git: the same name again", "POST", url, Some(json!({"name": "feat/a"}))).await;
    t.call("git: a name git refuses", "POST", url, Some(json!({"name": "bad name..x"}))).await;
    t.call("git: a base that is not there", "POST", url, Some(json!({"name": "y", "branch_from": "nope"}))).await;
    t.call(
        "git: a worktree where a folder is",
        "POST",
        url,
        Some(json!({"name": "feat/taken", "create_worktree": true, "worktree_path": repo.to_string_lossy()})),
    )
    .await;
    let wt = worktrees.join("b");
    let b = t
        .call(
            "git: a branch with a worktree",
            "POST",
            url,
            Some(json!({"name": "feat/b", "create_worktree": true, "worktree_path": wt.to_string_lossy()})),
        )
        .await;
    let b = last_id(&b, "branches");
    c.patch(
        &format!("/projects/{pid}"),
        json!({"worktree_template": format!("{}/{{project}}-{{ticket_id}}-{{ticket}}-{{branch}}-{{repo}}", worktrees.to_string_lossy())}),
    )
    .await
    .assert_status(200);
    t.call(
        "git: a worktree from the project's template",
        "POST",
        url,
        Some(json!({"name": "feat/c", "create_worktree": true, "status": "stale"})),
    )
    .await;
    t.call(
        "git: a baseline record",
        "POST",
        url,
        Some(json!({"name": "feat/base", "status": "baseline", "branch_from": "feat/a"})),
    )
    .await;
    commit(repo, "feat/a", "a1.txt");
    commit(repo, "main", "m1.txt");
    t.call("git: the branches, as the repository has them", "GET", url, None).await;
    t.call("git: the graph", "GET", "/tickets/GIT-1/graph", None).await;
    t.call("git: the graph, cut", "GET", "/tickets/GIT-1/graph?limit=1", None).await;
    let tip = git(repo, &["rev-parse", "feat/a"]).trim().to_string();
    t.call("git: a commit", "GET", &format!("/tickets/GIT-1/commits/{tip}"), None).await;
    t.call("git: a commit by a short id", "GET", &format!("/tickets/GIT-1/commits/{}", &tip[..7]), None).await;
    t.call("git: a commit id that is none", "GET", "/tickets/GIT-1/commits/not-a-hash", None).await;
    t.call("git: a commit that is not there", "GET", &format!("/tickets/GIT-1/commits/{}", "0".repeat(40)), None).await;

    let item = format!("{url}/{a}");
    t.call("git: merged, while it is not", "PATCH", &item, Some(json!({"status": "merged"}))).await;
    t.call(
        "git: merged, into a base that is not there",
        "PATCH",
        &item,
        Some(json!({"status": "merged", "branch_from": "nope"})),
    )
    .await;
    t.call("git: renamed to a name that is taken", "PATCH", &item, Some(json!({"name": "feat/b"}))).await;
    t.call("git: renamed", "PATCH", &item, Some(json!({"name": "feat/a2"}))).await;
    git(repo, &["merge", "-q", "--no-ff", "feat/a2", "-m", "merge a2"]);
    t.call("git: merged, after the merge", "PATCH", &item, Some(json!({"status": "merged"}))).await;
    t.call("git: checked out", "POST", &format!("{item}/checkout"), None).await;
    t.call("git: checked out again", "POST", &format!("{item}/checkout"), None).await;
    std::fs::write(repo.join("a.txt"), "changed").expect("write");
    t.call("git: a checkout over uncommitted changes", "POST", &format!("{url}/{b}/checkout"), None).await;
    git(repo, &["checkout", "--", "a.txt"]);
    git(repo, &["checkout", "-q", "main"]);
    // the branch of the template's worktree goes away under the board: its record stays, flagged
    let from_template = c.get("/tickets/GIT-1").await.json()["branches"][2]["worktree_path"].clone();
    std::fs::remove_dir_all(from_template.as_str().expect("worktree path")).expect("remove the worktree");
    git(repo, &["worktree", "prune"]);
    git(repo, &["branch", "-D", "feat/c"]);
    t.call("git: the branches after all this", "GET", url, None).await;
    t.call("git: the graph after the merge", "GET", "/tickets/GIT-1/graph", None).await;

    let wt_b = format!("{url}/{b}");
    git(repo, &["worktree", "lock", &wt.to_string_lossy()]);
    t.call("git: a locked worktree is not removed", "PATCH", &wt_b, Some(json!({"remove_worktree": true}))).await;
    t.call("git: nor with the branch", "DELETE", &format!("{wt_b}?remove_worktree=true"), None).await;
    git(repo, &["worktree", "unlock", &wt.to_string_lossy()]);
    t.call("git: the worktree removed", "PATCH", &wt_b, Some(json!({"remove_worktree": true}))).await;
    assert!(!wt.exists());
    commit(repo, "feat/b", "b1.txt");
    t.call("git: an unmerged branch is not deleted", "DELETE", &format!("{wt_b}?delete_git_branch=true"), None).await;
    t.call("git: unless forced", "DELETE", &format!("{wt_b}?delete_git_branch=true&force=true"), None).await;
    t.call("git: a record deleted, the branch kept", "DELETE", &item, None).await;
    assert!(git(repo, &["branch", "--list", "feat/a2"]).contains("feat/a2"));
    t.call("git: the ticket at the end", "GET", "/tickets/GIT-1", None).await;
}

#[tokio::test]
async fn the_sub_entity_routes_answer_the_same() {
    if !skip_unless_available("the_sub_entity_routes_answer_the_same") {
        return;
    }
    let s = Server::start().await;
    let repo = tempfile::tempdir().expect("temporary folder");
    let repo_path = repo.path().canonicalize().expect("resolve");
    let mut tape = Tape { server: &s, steps: Vec::new() };
    reopen_and_pending(&s, &mut tape).await;
    comments(&s, &mut tape).await;
    checklists_work_log_and_test_cases(&s, &mut tape).await;
    blocks_and_links(&s, &mut tape).await;
    branches_without_a_repository(&s, &mut tape).await;
    let worktrees = tempfile::tempdir().expect("temporary folder");
    let worktrees_path = worktrees.path().canonicalize().expect("resolve");
    branches_in_a_repository(&s, &mut tape, &repo_path, &worktrees_path).await;

    // the folder of the repository is another one on every run
    let name = repo_path.file_name().expect("folder name").to_string_lossy();
    let text = serde_json::to_string(&tape.steps).expect("json");
    let text = text.replace(&*repo_path.to_string_lossy(), "<repo>").replace(&*name, "<repo name>");
    let text = text.replace(&*worktrees_path.to_string_lossy(), "<worktrees>");
    let got = normalize(&serde_json::from_str::<Value>(&text).expect("json"));
    let got = got.as_array().expect("steps");

    if std::env::var("KANBAN_WRITE_GOLDEN").is_ok_and(|v| v == "1") {
        assert_eq!(target(), Target::Python, "the golden file is what the Python server answers");
        let text = serde_json::to_string_pretty(&got).expect("json") + "\n";
        std::fs::write(GOLDEN, text).expect("write the golden file");
    }
    let text = std::fs::read_to_string(GOLDEN).expect("golden file ticket_sub_routes.json exists");
    let expected: Vec<Value> = serde_json::from_str(&text).expect("golden file parses");
    let mut wrong: Vec<String> = Vec::new();
    for (got, expected) in got.iter().zip(&expected) {
        if got != expected {
            wrong.push(format!(
                "{}\n  expected {}\n  got      {}",
                expected["request"],
                difference(expected, got),
                difference(got, expected)
            ));
        }
    }
    assert!(wrong.is_empty(), "{} of {} answers differ:\n{}", wrong.len(), expected.len(), wrong.join("\n"));
    assert_eq!(got.len(), expected.len());
    let labels: std::collections::BTreeSet<&str> =
        got.iter().map(|step| step["request"].as_str().expect("label")).collect();
    assert_eq!(labels.len(), got.len(), "every request has a label of its own");
}

/// What `a` has that `b` has not, as short as it can be said: the status, or the fields of the answer that differ.
fn difference(a: &Value, b: &Value) -> String {
    if a["status"] != b["status"] {
        return format!("status {} {}", a["status"], a["answer"]);
    }
    fn walk(path: &str, a: &Value, b: &Value, out: &mut Map<String, Value>) {
        match (a, b) {
            (Value::Object(x), Value::Object(y)) => {
                for (key, value) in x {
                    walk(&format!("{path}.{key}"), value, y.get(key).unwrap_or(&Value::Null), out);
                }
                for key in y.keys().filter(|key| !x.contains_key(*key)) {
                    out.insert(format!("{path}.{key}"), json!("(absent)"));
                }
            }
            (Value::Array(x), Value::Array(y)) if x.len() == y.len() => {
                for (i, (value, other)) in x.iter().zip(y).enumerate() {
                    walk(&format!("{path}[{i}]"), value, other, out);
                }
            }
            _ if a != b => {
                out.insert(path.to_string(), a.clone());
            }
            _ => {}
        }
    }
    let mut out = Map::new();
    walk("", &a["answer"], &b["answer"], &mut out);
    Value::Object(out).to_string()
}
