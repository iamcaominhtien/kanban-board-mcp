//! One check per route of the core of `api/tickets.py`: both servers answer the same status and the same JSON
//! (ids and times normalized) for the success case and for each error, and store the same.

#![recursion_limit = "256"]

mod common;

use std::time::Duration;

use common::{count, exec, get_ticket, id, member, new_ticket, project, scalar};
use serde_json::{Value, json};
use testkit::{Client, Resp, Server, normalize, skip_unless_available};

/// The read model of a ticket that was just created with a title alone, normalized.
fn fresh(ticket_id: &str, title: &str) -> Value {
    json!({
        "id": ticket_id, "project_id": "<uuid:1>", "title": title, "description": "", "type": "task",
        "status": "backlog", "priority": "medium", "estimate": null, "due_date": null, "start_date": null,
        "tags": [], "parent_id": null, "comments": [], "acceptance_criteria": [], "sub_tasks": [],
        "activity_log": [{"field": "created", "from": null, "to": null, "at": "<time>", "actor": "user", "ref": title}],
        "work_log": [], "test_cases": [], "wont_do_reason": null, "created_by": "<uuid:2>", "assignee": null,
        "blocks": [], "blocked_by": [], "block_done_if_acs_incomplete": false,
        "block_done_if_tcs_incomplete": false, "links": [], "branches": [], "workspace_retention_days": null,
        "repo_path": null, "reopen_count": 0, "last_reopened_at": null, "last_reopened_by": null,
        "last_reopen_reason": null, "reopen_history": [], "pending": false, "pending_reason_type": null,
        "pending_ticket_id": null, "pending_member_id": null, "pending_party": null, "pending_note": null,
        "pending_since": null, "pending_by": null, "from_idea_id": null, "tests_assumption_id": null,
        "wave_pin": null, "review_requested_from": null, "completed_at": null, "completed_by": null,
        "created_at": "<time>", "updated_at": "<time>",
    })
}

/// `base` with the fields of `changes` on top.
fn with(mut base: Value, changes: Value) -> Value {
    for (key, value) in changes.as_object().expect("changes") {
        base[key] = value.clone();
    }
    base
}

/// An activity entry of the board's own user, normalized.
fn entry(field: &str, from: Value, to: Value) -> Value {
    json!({"field": field, "from": from, "to": to, "at": "<time>", "actor": "user"})
}

fn refused(r: &Resp, status: u16, detail: &str) {
    assert_eq!(r.status, status, "{}", r.text());
    assert_eq!(r.json(), json!({"detail": detail}));
}

/// FastAPI's 422 names the field (the wording of the message is Pydantic's, and is not compared).
fn unreadable(r: &Resp, loc: Value) {
    assert_eq!(r.status, 422, "{}", r.text());
    assert_eq!(r.detail()[0]["loc"], loc, "{}", r.text());
}

/// An unhandled error: a 500 with Starlette's plain text. `r` comes from a client of its own (`s.client()`): the
/// Python server closes the connection after such an answer, and a client that kept it would fail its next request.
fn server_error(r: &Resp) {
    assert_eq!(r.status, 500, "{}", r.text());
    assert_eq!(r.text(), "Internal Server Error");
}

fn titles(r: &Resp) -> Vec<String> {
    r.json().as_array().expect("list").iter().map(|t| t["title"].as_str().expect("title").to_string()).collect()
}

fn log_of(ticket: &Value) -> Vec<Value> {
    normalize(ticket)["activity_log"].as_array().expect("activity_log").clone()
}

async fn patch(c: &Client, ticket_id: &str, body: Value) -> Resp {
    c.patch(&format!("/tickets/{ticket_id}"), body).await
}

#[tokio::test]
async fn post_ticket_answers_the_same() {
    if !skip_unless_available("post_ticket_answers_the_same") {
        return;
    }
    let s = Server::start().await;
    let c = s.client();
    let p = project(&c, "Board", "TST").await;
    let pid = id(&p);
    let path = format!("/projects/{pid}/tickets");

    // a title alone
    let r = c.post(&path, json!({"title": "  First  "})).await;
    assert_eq!(r.status, 201, "{}", r.text());
    assert_eq!(normalize(&r.json()), fresh("TST-1", "First"));

    // every field of the body; what the body does not know is dropped
    let bao = member(&c, &pid, "Bao", "member").await;
    let r = c
        .post(
            &path,
            json!({
                "title": "Second", "description": "Why\n\n[[Spec#Goal]]", "type": "bug", "priority": "critical",
                "status": "in-progress", "estimate": 2, "due_date": " 2026-05-02T10:00:00Z ",
                "start_date": "2026-05-01", "tags": [" api ", "API", "", "Đồ họa"], "parent_id": "TST-1",
                "assignee": bao["id"], "created_by": "nobody", "id": "X-1", "wave_pin": 3,
            }),
        )
        .await;
    assert_eq!(r.status, 201, "{}", r.text());
    let mut expected = with(
        fresh("TST-2", "Second"),
        json!({
            "description": "Why\n\n[[Spec#Goal]]", "type": "bug", "priority": "critical", "status": "in-progress",
            "estimate": 2.0, "due_date": "2026-05-02T10:00:00Z", "start_date": "2026-05-01",
            "tags": ["api", "Đồ họa"], "parent_id": "TST-1", "assignee": "<uuid:3>",
        }),
    );
    expected["due_date"] = json!("<time>");
    assert_eq!(normalize(&r.json()), expected);
    assert_eq!(r.json()["due_date"], "2026-05-02T10:00:00Z");
    assert_eq!(r.json()["assignee"], bao["id"]);
    // stored as `json.dumps` writes it
    let stored = scalar(&s, "SELECT tags FROM ticket WHERE id = 'TST-2'", &[]).await;
    assert_eq!(stored, json!(r#"["api", "\u0110\u1ed3 h\u1ecda"]"#));
    assert_eq!(scalar(&s, "SELECT estimate FROM ticket WHERE id = 'TST-2'", &[]).await, json!(2.0));

    // each refusal, with its words
    let long_title = "x".repeat(301);
    let long_tag = "y".repeat(51);
    let many_tags: Vec<String> = (0..31).map(|i| format!("t{i}")).collect();
    let other = project(&c, "Other", "OTH").await;
    let foreign = new_ticket(&c, &id(&other), json!({"title": "o"})).await;
    let stranger = member(&c, &id(&other), "Stranger", "member").await;
    let cases = [
        (json!({"title": "   "}), "Title must not be empty"),
        (json!({"title": ""}), "Title must not be empty"),
        (json!({"title": long_title}), "Title must be at most 300 characters"),
        (json!({"title": "t", "tags": [1]}), "Tags must be strings"),
        (json!({"title": "t", "tags": [long_tag]}), "A tag must be at most 50 characters"),
        (json!({"title": "t", "tags": many_tags}), "A ticket can have at most 30 tags"),
        (json!({"title": "t", "estimate": -1}), "Estimate must be between 0 and 100000"),
        (json!({"title": "t", "estimate": 100000.5}), "Estimate must be between 0 and 100000"),
        (json!({"title": "t", "due_date": "tomorrow"}), "Due date must be an ISO date (YYYY-MM-DD)"),
        (json!({"title": "t", "start_date": "2026-02-30"}), "Start date must be an ISO date (YYYY-MM-DD)"),
        (
            json!({"title": "t", "start_date": "2026-03-02", "due_date": "2026-03-01T23:00:00"}),
            "Start date must not be after the due date",
        ),
        (json!({"title": "t", "parent_id": "ZZZ-9"}), "Parent ticket 'ZZZ-9' not found"),
        (json!({"title": "t", "parent_id": ""}), "Parent ticket '' not found"),
        (json!({"title": "t", "parent_id": foreign["id"]}), "Parent must belong to the same project"),
        (
            json!({"title": "t", "parent_id": "TST-2"}),
            "Cannot nest tickets more than 1 level deep (only a Story's tickets can have sub-tickets)",
        ),
        (json!({"title": "t", "assignee": "nobody"}), "Assignee must be a member of this project"),
        (json!({"title": "t", "assignee": stranger["id"]}), "Assignee must be a member of this project"),
        (
            json!({"title": "t", "type": "story", "parent_id": "TST-1"}),
            "A Story holds tickets, never Stories: it cannot have a parent.",
        ),
        // the first thing that is wrong is the one named
        (json!({"title": " ", "tags": [1], "estimate": -1}), "Title must not be empty"),
        (json!({"title": "t", "tags": [1], "estimate": -1, "due_date": "x"}), "Tags must be strings"),
        (json!({"title": "t", "due_date": "x", "parent_id": "ZZZ-9"}), "Due date must be an ISO date (YYYY-MM-DD)"),
        (json!({"title": "t", "parent_id": "ZZZ-9", "assignee": "nobody"}), "Parent ticket 'ZZZ-9' not found"),
    ];
    for (body, detail) in cases {
        refused(&c.post(&path, body).await, 400, detail);
    }
    // a body the server cannot read
    unreadable(&c.post(&path, json!({"description": "no title"})).await, json!(["body", "title"]));
    unreadable(&c.post(&path, json!({"title": "t", "type": "epic"})).await, json!(["body", "type"]));
    unreadable(&c.post(&path, json!({"title": "t", "status": "closed"})).await, json!(["body", "status"]));
    unreadable(&c.post(&path, json!({"title": "t", "priority": 1})).await, json!(["body", "priority"]));
    unreadable(&c.post(&path, json!({"title": "t", "tags": null})).await, json!(["body", "tags"]));
    unreadable(&c.post(&path, json!({"title": "t", "description": null})).await, json!(["body", "description"]));
    unreadable(&c.post(&path, json!({"title": ["t"]})).await, json!(["body", "title"]));
    let r = c.request("POST", &path, &[("content-type", "application/json")], Some(b"{not json".to_vec())).await;
    assert_eq!(r.status, 422, "{}", r.text());
    // a project that does not exist is not a refusal the route knows
    server_error(&s.client().post("/projects/nope/tickets", json!({"title": "t"})).await);

    // nothing above used a number: the next ticket is the third
    assert_eq!(scalar(&s, "SELECT ticket_counter FROM project WHERE prefix = 'TST'", &[]).await, json!(2));
    // a Story gets its Story row; a ticket of a Story may have sub-tickets, one more level may not
    let story = new_ticket(&c, &pid, json!({"title": "Goal", "type": "story"})).await;
    assert_eq!(story["id"], "TST-3");
    let row = "SELECT state || '/' || approve || '/' || plan || '/' || history || '/' || paused FROM story";
    assert_eq!(scalar(&s, &format!("{row} WHERE ticket_id = 'TST-3'"), &[]).await, json!("draft/person/{}/[]/0"));
    assert_eq!(scalar(&s, "SELECT created_by FROM story WHERE ticket_id = 'TST-3'", &[]).await, story["created_by"]);
    assert_eq!(count(&s, "SELECT COUNT(*) FROM story", &[]).await, 1);
    let part = new_ticket(&c, &pid, json!({"title": "Part", "parent_id": "TST-3"})).await;
    let sub = new_ticket(&c, &pid, json!({"title": "Sub", "parent_id": part["id"]})).await;
    refused(
        &c.post(&path, json!({"title": "Deeper", "parent_id": sub["id"]})).await,
        400,
        "Cannot nest tickets more than 1 level deep",
    );
    // a parent whose own parent is gone
    exec(&s, "UPDATE ticket SET parent_id = 'GONE-1' WHERE id = 'TST-1'", &[]).await;
    refused(
        &c.post(&path, json!({"title": "Orphan's child", "parent_id": "TST-1"})).await,
        400,
        "Cannot nest tickets more than 1 level deep",
    );
}

#[tokio::test]
async fn get_and_list_answer_the_same() {
    if !skip_unless_available("get_and_list_answer_the_same") {
        return;
    }
    let s = Server::start().await;
    let c = s.client();
    let p = project(&c, "Board", "TST").await;
    let pid = id(&p);
    let path = format!("/projects/{pid}/tickets");
    for (title, extra) in [
        ("Alpha", json!({"status": "todo", "priority": "high", "description": "login page"})),
        ("Beta", json!({"status": "done", "tags": ["login"]})),
        ("Gamma", json!({"status": "todo"})),
        ("Delta", json!({"priority": "high"})),
        ("Epsilon", json!({})),
    ] {
        new_ticket(&c, &pid, with(json!({"title": title}), extra)).await;
    }
    let r = patch(&c, "TST-5", json!({"status": "wont_do", "wont_do_reason": "no"})).await;
    assert_eq!(r.status, 200, "{}", r.text());
    exec(&s, "UPDATE ticket SET pending = 1 WHERE id = 'TST-3'", &[]).await;
    exec(&s, "UPDATE ticket SET reopen_count = 2 WHERE id IN ('TST-1', 'TST-2')", &[]).await;
    // a comment that was deleted is not shown; a closed ticket says when and by whom
    let comments = r#"[{"id": "c1", "text": "kept"}, {"id": "c2", "text": "gone", "deleted_at": "2026-01-01"}]"#;
    exec(&s, "UPDATE ticket SET comments = ? WHERE id = 'TST-1'", &[json!(comments)]).await;

    // one ticket
    let r = c.get("/tickets/TST-1").await;
    assert_eq!(r.status, 200);
    assert_eq!(
        normalize(&r.json()),
        with(
            fresh("TST-1", "Alpha"),
            json!({"status": "todo", "priority": "high", "description": "login page", "reopen_count": 2,
                   "comments": [{"id": "c1", "text": "kept"}]}),
        )
    );
    let closed = get_ticket(&c, "TST-5").await;
    assert_eq!(closed["completed_by"], "user");
    assert_eq!(closed["completed_at"], closed["activity_log"][1]["at"]);
    assert_eq!(get_ticket(&c, "TST-2").await["completed_at"], Value::Null); // created in Done: no move into it
    refused(&c.get("/tickets/TST-99").await, 404, "Ticket not found");
    refused(&c.get("/tickets/tst-1").await, 404, "Ticket not found");

    // the list: in the order of creation, Won't do left out
    let list = |query: &'static str| {
        let c = c.clone();
        let path = path.clone();
        async move { c.get(&format!("{path}{query}")).await }
    };
    assert_eq!(titles(&list("").await), ["Alpha", "Beta", "Gamma", "Delta"]);
    assert_eq!(normalize(&list("").await.json())[3], with(fresh("TST-4", "Delta"), json!({"priority": "high"})));
    assert_eq!(titles(&list("?include_wont_do=true").await), ["Alpha", "Beta", "Gamma", "Delta", "Epsilon"]);
    assert_eq!(titles(&list("?include_wont_do=0").await), ["Alpha", "Beta", "Gamma", "Delta"]);
    assert_eq!(titles(&list("?status=todo").await), ["Alpha", "Gamma"]);
    assert_eq!(titles(&list("?status=wont_do").await), ["Epsilon"]);
    assert_eq!(titles(&list("?status=nope").await), Vec::<String>::new());
    assert_eq!(titles(&list("?status=").await), Vec::<String>::new());
    assert_eq!(titles(&list("?priority=high").await), ["Alpha", "Delta"]);
    assert_eq!(titles(&list("?priority=high&status=todo").await), ["Alpha"]);
    assert_eq!(titles(&list("?pending=true").await), ["Gamma"]);
    assert_eq!(titles(&list("?pending=false").await), ["Alpha", "Beta", "Delta"]);
    assert_eq!(titles(&list("?pending=NO&include_wont_do=YES").await), ["Alpha", "Beta", "Delta", "Epsilon"]);
    // Reopened: reopened and not closed again
    assert_eq!(titles(&list("?reopened=true").await), ["Alpha"]);
    assert_eq!(titles(&list("?reopened=false").await), ["Beta", "Gamma", "Delta"]);
    assert_eq!(titles(&list("?reopened=false&status=done").await), ["Beta"]);
    // search: the best match first; a query of spaces filters nothing; filters apply before it
    assert_eq!(titles(&list("?q=login").await), ["Alpha", "Beta"]);
    assert_eq!(titles(&list("?q=alpha").await), ["Alpha"]);
    assert_eq!(titles(&list("?q=TST-4").await), ["Delta", "Alpha", "Beta", "Gamma"]);
    assert_eq!(titles(&list("?q=%20%20").await), ["Alpha", "Beta", "Gamma", "Delta"]);
    assert_eq!(titles(&list("?q=").await), ["Alpha", "Beta", "Gamma", "Delta"]);
    assert_eq!(titles(&list("?q=login&status=done").await), ["Beta"]);
    assert_eq!(titles(&list("?q=epsilon").await), ["Beta"]); // its tag "login" is close enough
    assert_eq!(titles(&list("?q=epsilon&include_wont_do=1").await), ["Epsilon", "Beta"]);
    assert_eq!(titles(&list("?unknown=1").await), ["Alpha", "Beta", "Gamma", "Delta"]);
    // a project that does not exist has no tickets
    let r = c.get("/projects/nope/tickets").await;
    assert_eq!((r.status, r.json()), (200, json!([])));
    // a value that is not a bool
    for query in ["?pending=maybe", "?include_wont_do=", "?reopened=2"] {
        assert_eq!(list(query).await.status, 422, "{query}");
    }

    // the lane counts: by status, sorted, without pending and Won't do tickets
    let r = c.get(&format!("{path}/counts")).await;
    assert_eq!(r.status, 200);
    assert_eq!(
        r.json(),
        json!({"lanes": [{"status": "backlog", "count": 1}, {"status": "done", "count": 1},
                         {"status": "todo", "count": 1}]})
    );
    // a ticket whose flag was never written (a row older than the flag) is counted
    exec(&s, "UPDATE ticket SET status = 'in-progress' WHERE id = 'TST-3'", &[]).await;
    exec(&s, "UPDATE ticket SET status = 'review', pending = 0 WHERE id = 'TST-2'", &[]).await;
    let r = c.get(&format!("{path}/counts")).await;
    assert_eq!(
        r.json(),
        json!({"lanes": [{"status": "backlog", "count": 1}, {"status": "review", "count": 1},
                         {"status": "todo", "count": 1}]})
    );
    assert_eq!(c.get("/projects/nope/tickets/counts").await.json(), json!({"lanes": []}));
}

#[tokio::test]
async fn patch_ticket_answers_the_same() {
    if !skip_unless_available("patch_ticket_answers_the_same") {
        return;
    }
    let s = Server::start().await;
    let c = s.client();
    let p = project(&c, "Board", "TST").await;
    let pid = id(&p);
    let bao = member(&c, &pid, "Bao", "member").await;
    let other = project(&c, "Other", "OTH").await;
    let stranger = member(&c, &id(&other), "Stranger", "member").await;
    new_ticket(&c, &pid, json!({"title": "First", "description": "See [[Old]] and [[Kept#Part]]"})).await;

    // several fields at once: one entry each, in the order of the model, with what the description's references did
    let an = c.clone().header("X-Actor", "An Nguyen");
    let long_title = format!("{} end", "é".repeat(250));
    let r = patch(
        &an,
        "TST-1",
        json!({
            "tags": [" b ", "a", "B"], "assignee": bao["id"], "estimate": 3, "priority": "high",
            "description": "See [[Kept#Part]] and [[New]]", "title": long_title, "type": "bug",
            "due_date": "2026-06-01", "start_date": "2026-05-01", "status": "review",
            "block_done_if_acs_incomplete": true, "review_requested_from": bao["id"], "nope": 1,
        }),
    )
    .await;
    assert_eq!(r.status, 200, "{}", r.text());
    let body = r.json();
    let by_an = |field: &str, from: Value, to: Value| json!({"field": field, "from": from, "to": to, "at": "<time>", "actor": "An Nguyen"});
    let clipped = format!("{}…", "é".repeat(199));
    let mut doc_removed = by_an("doc_ref_removed", json!("Old"), Value::Null);
    doc_removed["ref"] = json!("description");
    let mut doc_added = by_an("doc_ref_added", Value::Null, json!("New"));
    doc_added["ref"] = json!("description");
    assert_eq!(
        log_of(&body)[1..],
        [
            by_an("title", json!("First"), json!(clipped)),
            by_an("description", json!("See [[Old]] and [[Kept#Part]]"), json!("See [[Kept#Part]] and [[New]]")),
            doc_removed,
            doc_added,
            by_an("type", json!("task"), json!("bug")),
            by_an("status", json!("backlog"), json!("review")),
            by_an("priority", json!("medium"), json!("high")),
            by_an("estimate", Value::Null, json!(3.0)),
            by_an("due_date", Value::Null, json!("2026-06-01")),
            by_an("start_date", Value::Null, json!("2026-05-01")),
            by_an("tags", Value::Null, json!(["b", "a"])),
            by_an("assignee", Value::Null, json!("<uuid:2>")),
            by_an("review_requested_from", Value::Null, json!("<uuid:2>")),
        ]
    );
    assert_eq!(body["title"], json!(long_title));
    assert_eq!(body["block_done_if_acs_incomplete"], true);
    assert_eq!((body["estimate"].clone(), body["tags"].clone()), (json!(3.0), json!(["b", "a"])));
    // stored: the log as `json.dumps` writes it (a float with its `.0`, non-ASCII escaped)
    let stored = scalar(&s, "SELECT activity_log FROM ticket WHERE id = 'TST-1'", &[]).await;
    let stored = stored.as_str().expect("log").to_string();
    assert!(stored.contains(r#"{"field": "estimate", "from": null, "to": 3.0, "at": ""#), "{stored}");
    assert!(stored.contains(r#""from": "First", "to": "\u00e9\u00e9"#), "{stored}");
    assert!(stored.contains(r#"\u00e9\u2026", "at": ""#), "{stored}");

    // the same values again: nothing is logged, the ticket is saved all the same; an empty body too
    let before = get_ticket(&c, "TST-1").await;
    let r = patch(&c, "TST-1", json!({"priority": "high", "tags": ["b", "a"], "estimate": 3.0, "type": "bug"})).await;
    assert_eq!(r.status, 200);
    assert_eq!(r.json()["activity_log"], before["activity_log"]);
    let r = patch(&c, "TST-1", json!({})).await;
    assert_eq!(r.status, 200);
    assert_eq!(with(r.json(), json!({"updated_at": before["updated_at"]})), before);
    assert_ne!(r.json()["updated_at"], before["updated_at"]);

    // a null clears what can be empty; tags become none
    let r = patch(
        &c,
        "TST-1",
        json!({"estimate": null, "due_date": null, "start_date": "  ", "tags": null, "assignee": null,
               "review_requested_from": null, "repo_path": null, "wave_pin": null, "parent_id": null,
               "wont_do_reason": null}),
    )
    .await;
    assert_eq!(r.status, 200, "{}", r.text());
    let log = log_of(&r.json());
    assert_eq!(
        log[log.len() - 6..],
        [
            entry("estimate", json!(3.0), Value::Null),
            entry("due_date", json!("2026-06-01"), Value::Null),
            entry("start_date", json!("2026-05-01"), Value::Null),
            entry("tags", json!(["b", "a"]), Value::Null),
            entry("assignee", json!("<uuid:2>"), Value::Null),
            entry("review_requested_from", json!("<uuid:2>"), Value::Null),
        ]
    );
    assert_eq!(r.json()["tags"], json!([]));
    // a null where the column cannot be empty is refused by the database, not by the route
    refused(&patch(&c, "TST-1", json!({"title": null})).await, 400, "Title must not be empty");
    for body in
        [json!({"status": null}), json!({"description": null}), json!({"priority": null}), json!({"type": null})]
    {
        server_error(&patch(&s.client(), "TST-1", body).await);
    }
    server_error(&patch(&s.client(), "TST-1", json!({"block_done_if_tcs_incomplete": null})).await);
    assert_eq!(get_ticket(&c, "TST-1").await["activity_log"], r.json()["activity_log"]);

    // the field rules, as on create
    let cases = [
        (json!({"title": "  "}), "Title must not be empty"),
        (json!({"estimate": -0.5}), "Estimate must be between 0 and 100000"),
        (json!({"tags": ["ok", 2]}), "Tags must be strings"),
        (json!({"due_date": "01/02/2026"}), "Due date must be an ISO date (YYYY-MM-DD)"),
        (json!({"start_date": "2026-1-1"}), "Start date must be an ISO date (YYYY-MM-DD)"),
        (json!({"parent_id": "TST-1"}), "A ticket cannot be its own parent"),
        (json!({"parent_id": "ZZZ-9"}), "Parent ticket 'ZZZ-9' not found"),
        (json!({"wave_pin": 0}), "wave_pin must be between 1 and 99, or null"),
        (json!({"wave_pin": 100}), "wave_pin must be between 1 and 99, or null"),
        (json!({"assignee": stranger["id"]}), "Assignee must be a member of this project"),
        (json!({"assignee": ""}), "Assignee must be a member of this project"),
        (json!({"review_requested_from": stranger["id"]}), "The reviewer must be a member of this project"),
        (json!({"status": "wont_do"}), "wont_do_reason is required when status is wont_do"),
        (json!({"status": "wont_do", "wont_do_reason": " \n "}), "wont_do_reason is required when status is wont_do"),
        (
            json!({"type": "story"}),
            "Make a ticket a Story with Make this a Story, which hands it to the PM; a Story stays a Story.",
        ),
    ];
    for (body, detail) in cases {
        refused(&patch(&c, "TST-1", body).await, 400, detail);
    }
    // dates are checked against the one that is stored
    patch(&c, "TST-1", json!({"due_date": "2026-06-01"})).await.assert_status(200);
    refused(
        &patch(&c, "TST-1", json!({"start_date": "2026-06-02"})).await,
        400,
        "Start date must not be after the due date",
    );
    patch(&c, "TST-1", json!({"start_date": "2026-06-02", "due_date": null})).await.assert_status(200);
    // a pin: a whole number from 1 to 99, also written 3.0
    let r = patch(&c, "TST-1", json!({"wave_pin": 3.0})).await;
    assert_eq!((r.status, r.json()["wave_pin"].clone()), (200, json!(3)));
    assert_eq!(patch(&c, "TST-1", json!({"wave_pin": 2.5})).await.status, 422);
    assert_eq!(patch(&c, "TST-1", json!({"wave_pin": null})).await.json()["wave_pin"], Value::Null);
    // an empty reviewer is no reviewer to check
    let r = patch(&c, "TST-1", json!({"review_requested_from": ""})).await;
    assert_eq!((r.status, r.json()["review_requested_from"].clone()), (200, json!("")));
    // a ticket that does not exist; a body the server cannot read
    refused(&patch(&c, "TST-99", json!({"title": "x"})).await, 404, "Ticket not found");
    refused(&patch(&c, "TST-99", json!({"title": " "})).await, 404, "Ticket not found");
    unreadable(&patch(&c, "TST-1", json!({"status": "closed"})).await, json!(["body", "status"]));
    unreadable(&patch(&c, "TST-1", json!({"tags": "a"})).await, json!(["body", "tags"]));
    unreadable(&patch(&c, "TST-1", json!({"title": 5})).await, json!(["body", "title"]));
    assert_eq!(c.patch("/tickets/TST-1?start=maybe", json!({})).await.status, 422);
    assert_eq!(c.patch("/tickets/TST-1?start=false", json!({})).await.status, 200);

    // the repository of a ticket: resolved, the root of a git working tree, cleared by an empty path
    let dir = tempfile::tempdir().expect("temporary folder");
    let root = std::fs::canonicalize(dir.path()).expect("resolved").to_string_lossy().into_owned();
    let repo = format!("{root}/repo");
    std::fs::create_dir_all(format!("{repo}/sub")).expect("mkdir");
    let init = std::process::Command::new("git").args(["init", "-q", "-b", "main"]).current_dir(&repo).status();
    assert!(init.expect("git runs").success());
    let r = patch(&c, "TST-1", json!({"repo_path": format!("  {repo}/sub/..  ")})).await;
    assert_eq!(r.status, 200, "{}", r.text());
    assert_eq!(r.json()["repo_path"], json!(repo));
    assert_eq!(r.json()["activity_log"].as_array().expect("log").last().expect("entry")["to"], json!(repo));
    refused(
        &patch(&c, "TST-1", json!({"repo_path": format!("{repo}/sub")})).await,
        400,
        &format!("Not a git repository: {repo}/sub"),
    );
    let r = patch(&c, "TST-1", json!({"repo_path": "  "})).await;
    assert_eq!((r.status, r.json()["repo_path"].clone()), (200, Value::Null));

    // a parent: a ticket with children cannot get one, a ticket under a parent cannot have children
    new_ticket(&c, &pid, json!({"title": "Second"})).await;
    new_ticket(&c, &pid, json!({"title": "Third"})).await;
    let r = patch(&c, "TST-3", json!({"parent_id": "TST-2"})).await;
    assert_eq!(log_of(&r.json()).last(), Some(&entry("parent_id", Value::Null, json!("TST-2"))));
    refused(
        &patch(&c, "TST-2", json!({"parent_id": "TST-1"})).await,
        400,
        "Cannot nest tickets more than 1 level deep",
    );
    refused(
        &patch(&c, "TST-1", json!({"parent_id": "TST-3"})).await,
        400,
        "Cannot nest tickets more than 1 level deep (only a Story's tickets can have sub-tickets)",
    );
}

#[tokio::test]
async fn moving_a_ticket_follows_the_same_rules() {
    if !skip_unless_available("moving_a_ticket_follows_the_same_rules") {
        return;
    }
    let s = Server::start().await;
    let c = s.client();
    let p = project(&c, "Board", "TST").await;
    let pid = id(&p);
    for title in ["One", "Two", "Three", "Four", "Five"] {
        new_ticket(&c, &pid, json!({"title": title})).await;
    }
    let status = |ticket: &'static str, to: &'static str| {
        let c = c.clone();
        async move { c.patch(&format!("/tickets/{ticket}/status"), json!({"status": to})).await }
    };

    // the quick route: the ticket, with one entry
    let r = status("TST-1", "in-progress").await;
    assert_eq!(r.status, 200, "{}", r.text());
    let mut expected = with(fresh("TST-1", "One"), json!({"status": "in-progress"}));
    expected["activity_log"].as_array_mut().expect("log").push(entry("status", json!("backlog"), json!("in-progress")));
    assert_eq!(normalize(&r.json()), expected);
    // the same status again is no entry
    assert_eq!(status("TST-1", "in-progress").await.json()["activity_log"], r.json()["activity_log"]);
    refused(&status("TST-99", "todo").await, 404, "Ticket not found");
    refused(&status("TST-1", "wont_do").await, 400, "wont_do_reason is required when status is wont_do");
    unreadable(&status("TST-1", "closed").await, json!(["body", "status"]));
    unreadable(&c.patch("/tickets/TST-1/status", json!({})).await, json!(["body", "status"]));
    unreadable(&c.patch("/tickets/TST-1/status", json!({"status": null})).await, json!(["body", "status"]));

    // Won't do: with a reason; leaving it clears the reason without an entry of its own
    let r = patch(&c, "TST-1", json!({"status": "wont_do", "wont_do_reason": "  duplicate  "})).await;
    assert_eq!(r.status, 200, "{}", r.text());
    let body = r.json();
    assert_eq!((body["wont_do_reason"].clone(), body["completed_by"].clone()), (json!("  duplicate  "), json!("user")));
    let log = log_of(&body);
    assert_eq!(
        log[log.len() - 2..],
        [
            entry("status", json!("in-progress"), json!("wont_do")),
            entry("wont_do_reason", Value::Null, json!("  duplicate  "))
        ]
    );
    let r = status("TST-1", "todo").await;
    let body = r.json();
    assert_eq!((body["wont_do_reason"].clone(), body["completed_at"].clone()), (Value::Null, Value::Null));
    assert_eq!(log_of(&body).last(), Some(&entry("status", json!("wont_do"), json!("todo"))));
    // a reason given without the move is a field like another
    let r = patch(&c, "TST-1", json!({"wont_do_reason": "later"})).await;
    assert_eq!(log_of(&r.json()).last(), Some(&entry("wont_do_reason", Value::Null, json!("later"))));
    let r = patch(&c, "TST-1", json!({"wont_do_reason": null})).await;
    assert_eq!(log_of(&r.json()).last(), Some(&entry("wont_do_reason", json!("later"), Value::Null)));

    // a sub-ticket cannot be Won't do, unless its parent is a Story
    patch(&c, "TST-3", json!({"parent_id": "TST-2"})).await.assert_status(200);
    refused(
        &patch(&c, "TST-3", json!({"status": "wont_do", "wont_do_reason": "no"})).await,
        400,
        "Child tickets cannot be set to wont_do",
    );
    exec(&s, "UPDATE ticket SET type = 'story' WHERE id = 'TST-2'", &[]).await;
    patch(&c, "TST-3", json!({"status": "wont_do", "wont_do_reason": "no"})).await.assert_status(200);
    exec(&s, "UPDATE ticket SET parent_id = 'GONE-1' WHERE id = 'TST-3'", &[]).await;
    patch(&c, "TST-3", json!({"status": "todo"})).await.assert_status(200);
    refused(
        &patch(&c, "TST-3", json!({"status": "wont_do", "wont_do_reason": "no"})).await,
        400,
        "Child tickets cannot be set to wont_do",
    );
    // a ticket of type story without its Story row moves like any ticket; it stays a story
    let r = patch(&c, "TST-2", json!({"status": "todo", "type": "story"})).await;
    assert_eq!(r.status, 200, "{}", r.text());
    refused(
        &patch(&c, "TST-2", json!({"type": "task"})).await,
        400,
        "Make a ticket a Story with Make this a Story, which hands it to the PM; a Story stays a Story.",
    );
    // a Story moves with its own state
    let story = new_ticket(&c, &pid, json!({"title": "Goal", "type": "story"})).await;
    let story_id = id(&story);
    let moves = "A Story moves with its own state: hand it to the PM, approve its plan, or pause, drop or reopen it.";
    refused(&patch(&c, &story_id, json!({"status": "todo"})).await, 400, moves);
    refused(&c.patch(&format!("/tickets/{story_id}/status"), json!({"status": "done"})).await, 400, moves);
    patch(&c, &story_id, json!({"status": "backlog", "title": "The goal"})).await.assert_status(200);

    // Done waits for the criteria, the test cases and the tickets that block it
    let acs = r#"[{"id": "a1", "text": "works", "done": true}, {"id": "a2", "text": "fast", "done": false}]"#;
    let tcs = r#"[{"id": "t1", "code": "TC-1", "title": "login", "status": "pass"}, {"id": "t2", "status": "fail"}]"#;
    exec(&s, "UPDATE ticket SET acceptance_criteria = ?, test_cases = ? WHERE id = 'TST-4'", &[json!(acs), json!(tcs)])
        .await;
    exec(&s, r#"UPDATE ticket SET blocked_by = '["TST-1", "TST-5", "GONE-7", "TST-3"]' WHERE id = 'TST-4'"#, &[]).await;
    exec(&s, "UPDATE ticket SET status = 'done' WHERE id = 'TST-5'", &[]).await;
    let blocked =
        "it is blocked by TST-1 (todo), TST-3 (todo); finish that first, or remove the block if it no longer holds";
    refused(&status("TST-4", "done").await, 400, &format!("Cannot move to Done: {blocked}."));
    let r = patch(&c, "TST-4", json!({"status": "done", "block_done_if_acs_incomplete": true})).await;
    refused(&r, 400, &format!("Cannot move to Done: not all Acceptance Criteria are passed and {blocked}."));
    let r = patch(
        &c,
        "TST-4",
        json!({"status": "done", "block_done_if_acs_incomplete": true, "block_done_if_tcs_incomplete": true}),
    )
    .await;
    refused(
        &r,
        400,
        &format!(
            "Cannot move to Done: not all Acceptance Criteria are passed and Test Cases are missing or not all \
             passed and {blocked}."
        ),
    );
    // the refused move changed nothing, the switches included
    assert_eq!(get_ticket(&c, "TST-4").await["block_done_if_acs_incomplete"], false);
    patch(&c, "TST-4", json!({"block_done_if_tcs_incomplete": true})).await.assert_status(200);
    exec(&s, "UPDATE ticket SET blocked_by = '[]' WHERE id = 'TST-4'", &[]).await;
    refused(&status("TST-4", "done").await, 400, "Cannot move to Done: Test Cases are missing or not all passed.");
    // a switch turned off in the same request does not hold the move; no criteria at all is not "all passed"
    exec(&s, "UPDATE ticket SET acceptance_criteria = '[]' WHERE id = 'TST-4'", &[]).await;
    let r = patch(
        &c,
        "TST-4",
        json!({"status": "done", "block_done_if_tcs_incomplete": false, "block_done_if_acs_incomplete": true}),
    )
    .await;
    refused(&r, 400, "Cannot move to Done: not all Acceptance Criteria are passed.");
    let r = patch(&c, "TST-4", json!({"status": "done", "block_done_if_tcs_incomplete": false})).await;
    assert_eq!(r.status, 200, "{}", r.text());
    assert_eq!(
        (r.json()["status"].clone(), r.json()["block_done_if_tcs_incomplete"].clone()),
        (json!("done"), json!(false))
    );
    // a ticket that is Done already is not asked about its blockers again
    exec(&s, r#"UPDATE ticket SET blocked_by = '["TST-1"]' WHERE id = 'TST-4'"#, &[]).await;
    assert_eq!(status("TST-4", "done").await.status, 200);

    // closing a ticket clears its Pending flag and its pending sub-tickets', and prompts the tickets waiting for it
    for (ticket, target) in [("TST-1", "TST-2"), ("TST-3", "TST-1"), ("TST-5", "TST-1")] {
        exec(
            &s,
            "UPDATE ticket SET pending = 1, pending_reason_type = 'ticket', pending_ticket_id = ?, \
             pending_member_id = 'm', pending_party = 'p', pending_note = 'n', pending_since = 's', \
             pending_by = 'b' WHERE id = ?",
            &[json!(target), json!(ticket)],
        )
        .await;
    }
    exec(&s, "UPDATE ticket SET parent_id = 'TST-1', status = 'todo' WHERE id IN ('TST-3', 'TST-5')", &[]).await;
    exec(&s, "UPDATE ticket SET pending = 0 WHERE id = 'TST-5'", &[]).await;
    exec(&s, "UPDATE ticket SET pending = 1, pending_ticket_id = 'TST-1' WHERE id = 'TST-4'", &[]).await;
    let r = status("TST-1", "done").await;
    assert_eq!(r.status, 200, "{}", r.text());
    let one = r.json();
    for key in [
        "pending_reason_type",
        "pending_ticket_id",
        "pending_member_id",
        "pending_party",
        "pending_note",
        "pending_since",
        "pending_by",
    ] {
        assert_eq!(one[key], Value::Null, "{key}");
    }
    assert_eq!(one["pending"], false);
    // TST-3 was a pending sub-ticket: cleared, and so not prompted; TST-5 was not pending: left as it was
    let three = get_ticket(&c, "TST-3").await;
    assert_eq!((three["pending"].clone(), three["pending_ticket_id"].clone()), (json!(false), Value::Null));
    assert!(three["activity_log"].as_array().expect("log").iter().all(|e| e["field"] != "pending_prompt"));
    assert_eq!(get_ticket(&c, "TST-5").await["pending_ticket_id"], "TST-1");
    // TST-4 waits for it from elsewhere: prompted, still pending
    let four = get_ticket(&c, "TST-4").await;
    assert_eq!(four["pending"], true);
    assert_eq!(
        four["activity_log"].as_array().expect("log").last(),
        Some(&json!({"field": "pending_prompt", "actor": "system", "cause": "blocker_done", "blocker_id": "TST-1",
                     "at": one["updated_at"]}))
    );
    let stored = scalar(&s, "SELECT activity_log FROM ticket WHERE id = 'TST-4'", &[]).await;
    let tail = format!(
        r#", {{"field": "pending_prompt", "actor": "system", "cause": "blocker_done", "blocker_id": "TST-1", "at": "{}"}}]"#,
        one["updated_at"].as_str().expect("time")
    );
    assert!(stored.as_str().expect("log").ends_with(&tail), "{stored}");
    // Done again: no second prompt; Won't do from Done: another cause
    status("TST-1", "done").await.assert_status(200);
    let prompts = |ticket: Value| -> Vec<Value> {
        ticket["activity_log"]
            .as_array()
            .expect("log")
            .iter()
            .filter(|e| e["field"] == "pending_prompt")
            .map(|e| e["cause"].clone())
            .collect()
    };
    assert_eq!(prompts(get_ticket(&c, "TST-4").await), [json!("blocker_done")]);
    exec(&s, "UPDATE ticket SET parent_id = NULL WHERE id = 'TST-1'", &[]).await;
    patch(&c, "TST-1", json!({"status": "wont_do", "wont_do_reason": "gone"})).await.assert_status(200);
    assert_eq!(prompts(get_ticket(&c, "TST-4").await), [json!("blocker_done"), json!("blocker_removed")]);
}

#[tokio::test]
async fn del_ticket_answers_the_same() {
    if !skip_unless_available("del_ticket_answers_the_same") {
        return;
    }
    let s = Server::start().await;
    let c = s.client();
    let p = project(&c, "Board", "TST").await;
    let pid = id(&p);
    for title in ["Parent", "Child", "Peer", "Bystander"] {
        new_ticket(&c, &pid, json!({"title": title})).await;
    }
    let other = project(&c, "Other", "OTH").await;
    new_ticket(&c, &id(&other), json!({"title": "Elsewhere"})).await;
    patch(&c, "TST-2", json!({"parent_id": "TST-1"})).await.assert_status(200);
    let links = r#"[{"id": "l1", "target_id": "TST-1", "relation_type": "relates_to"}, {"id": "l2", "target_id": "TST-4", "relation_type": "causes"}]"#;
    exec(
        &s,
        r#"UPDATE ticket SET blocks = '["TST-1", "TST-4"]', blocked_by = '["TST-4", "TST-1"]', links = ? WHERE id = 'TST-3'"#,
        &[json!(links)],
    )
    .await;
    // tickets waiting for it: one here, one in another project (whose links are not cleaned: another board)
    exec(&s, "UPDATE ticket SET pending = 1, pending_ticket_id = 'TST-1' WHERE id IN ('TST-4', 'OTH-1')", &[]).await;
    exec(&s, r#"UPDATE ticket SET blocked_by = '["TST-1"]' WHERE id = 'OTH-1'"#, &[]).await;
    let made = c.post("/tickets/TST-1/workspace/init", json!({})).await;
    made.assert_status(200);
    let folder = std::path::PathBuf::from(made.json()["path"].as_str().expect("path"));
    std::fs::write(folder.join("report.txt"), "x").expect("write");
    let before = get_ticket(&c, "TST-4").await;

    let r = c.delete("/tickets/TST-1").await;
    assert_eq!(r.status, 204, "{}", r.text());
    assert!(r.body.is_empty(), "{}", r.text());
    refused(&c.get("/tickets/TST-1").await, 404, "Ticket not found");
    refused(&c.delete("/tickets/TST-1").await, 404, "Ticket not found");
    assert!(!folder.exists(), "the workspace folder goes with the ticket");

    // the child is a ticket of its own; the peer points at nothing that is gone
    let child = get_ticket(&c, "TST-2").await;
    assert_eq!(child["parent_id"], Value::Null);
    assert_eq!(child["activity_log"].as_array().expect("log").len(), 2); // created, parent_id: detaching is not logged
    let peer = get_ticket(&c, "TST-3").await;
    assert_eq!(peer["blocks"], json!(["TST-4"]));
    assert_eq!(peer["blocked_by"], json!(["TST-4"]));
    assert_eq!(peer["links"], json!([{"id": "l2", "target_id": "TST-4", "relation_type": "causes"}]));
    assert_eq!(child["updated_at"], peer["updated_at"]);
    assert_eq!(
        scalar(&s, "SELECT blocks || blocked_by || links FROM ticket WHERE id = 'TST-3'", &[]).await,
        json!(r#"["TST-4"]["TST-4"][{"id": "l2", "target_id": "TST-4", "relation_type": "causes"}]"#)
    );
    // the tickets that waited for it are prompted, in any project; nothing else of theirs changes
    let waiting = get_ticket(&c, "TST-4").await;
    assert_eq!(
        waiting["activity_log"].as_array().expect("log").last(),
        Some(&json!({"field": "pending_prompt", "actor": "system", "cause": "blocker_removed",
                     "blocker_id": "TST-1", "at": child["updated_at"]}))
    );
    assert_eq!(
        (waiting["pending"].clone(), waiting["updated_at"].clone()),
        (json!(true), before["updated_at"].clone())
    );
    let elsewhere = get_ticket(&c, "OTH-1").await;
    assert_eq!(elsewhere["activity_log"].as_array().expect("log").last().expect("entry")["cause"], "blocker_removed");
    assert_eq!(elsewhere["blocked_by"], json!(["TST-1"]));
    // the number is not given again
    assert_eq!(id(&new_ticket(&c, &pid, json!({"title": "Next"})).await), "TST-5");

    // a Story's row stays when its ticket goes (the Python code leaves it)
    let story = new_ticket(&c, &pid, json!({"title": "Goal", "type": "story"})).await;
    c.delete(&format!("/tickets/{}", id(&story))).await.assert_status(204);
    assert_eq!(count(&s, "SELECT COUNT(*) FROM story", &[]).await, 1);
}

#[tokio::test]
async fn every_change_of_a_ticket_is_announced() {
    if !skip_unless_available("every_change_of_a_ticket_is_announced") {
        return;
    }
    let s = Server::start().await;
    let c = s.client();
    let p = project(&c, "Announced", "ANN").await;
    let mut events = s.events().await;
    new_ticket(&c, &id(&p), json!({"title": "t"})).await;
    assert_eq!(events.next(Duration::from_secs(5)).await.as_deref(), Some("invalidate"));
    patch(&c, "ANN-1", json!({"title": "Renamed"})).await.assert_status(200);
    assert_eq!(events.next(Duration::from_secs(5)).await.as_deref(), Some("invalidate"));
    c.patch("/tickets/ANN-1/status", json!({"status": "todo"})).await.assert_status(200);
    assert_eq!(events.next(Duration::from_secs(5)).await.as_deref(), Some("invalidate"));
    c.delete("/tickets/ANN-1").await.assert_status(204);
    assert_eq!(events.next(Duration::from_secs(5)).await.as_deref(), Some("invalidate"));
    // a refused change and a read announce nothing
    c.post(&format!("/projects/{}/tickets", id(&p)), json!({"title": " "})).await.assert_status(400);
    patch(&c, "ANN-1", json!({"title": "x"})).await.assert_status(404);
    c.patch("/tickets/ANN-1/status", json!({"status": "todo"})).await.assert_status(404);
    c.delete("/tickets/ANN-1").await.assert_status(404);
    c.get(&format!("/projects/{}/tickets", id(&p))).await.assert_status(200);
    c.get(&format!("/projects/{}/tickets/counts", id(&p))).await.assert_status(200);
    assert_eq!(events.next(Duration::from_millis(700)).await, None);
}
