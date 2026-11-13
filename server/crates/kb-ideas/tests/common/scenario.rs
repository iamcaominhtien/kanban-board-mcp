//! One idea's life, as a script over a minimal HTTP trait: a testkit client (either server) and the app's router in
//! this process. The script stops after the promotion (`part_one`, which needs nothing from the app but the routes)
//! and goes on with the ticket changes that run the idea promotion hook (`part_two`).
#![allow(dead_code)]

use serde_json::{Map, Value, json};

use super::API;

/// What the script needs of a server: one request, with the actor header when given.
pub trait Http {
    async fn call(&self, method: &str, path: &str, actor: Option<&str>, body: Option<Value>) -> (u16, Value);
}

/// A request that must have been answered with `status`; the JSON answer.
async fn ok<H: Http>(h: &H, status: u16, method: &str, path: &str, actor: Option<&str>, body: Option<Value>) -> Value {
    let (got, answer) = h.call(method, path, actor, body).await;
    assert_eq!(got, status, "{method} {path}: {answer}");
    answer
}

fn id(value: &Value) -> String {
    value["id"].as_str().unwrap_or_else(|| panic!("no id in {value}")).to_string()
}

/// What `part_one` made, for `part_two`.
pub struct Made {
    pub project: String,
    pub shipped_ticket: String,
    pub dropped_ticket: String,
    pub deleted_ticket: String,
    pub test_ticket: String,
    pub ideas: Vec<String>,
}

/// Capture an idea, move it through the stages, add assumptions, evidence, comments, votes and log entries, merge
/// another idea into it, and promote it (and three more) into tickets.
pub async fn part_one<H: Http>(h: &H) -> Made {
    let project = id(&ok(
        h,
        201,
        "POST",
        "/projects",
        None,
        Some(json!({"name": "Scenario", "prefix": "SCN", "color": "#123456"})),
    )
    .await);
    ok(h, 201, "POST", &format!("/projects/{project}/members"), None, Some(json!({"name": "Mia", "role": "member"})))
        .await;
    ok(h, 201, "POST", &format!("/projects/{project}/members"), None, Some(json!({"name": "Vera", "role": "viewer"})))
        .await;

    // capture
    let idea = id(&ok(h, 201, "POST", API, None, Some(json!({
        "project_id": project, "title": "Show the cost on every run card", "description": "People ask what a run costs",
        "problem_statement": "The cost is hidden until the run ends", "source": "selection",
        "source_ref": {"kind": "doc", "id": "D1", "label": "Cost notes", "quote": "what does it cost?"},
        "tags": ["ai", "cost"], "idea_energy": "hot",
    }))).await);
    let other = id(&ok(
        h,
        201,
        "POST",
        API,
        None,
        Some(json!({"project_id": project, "title": "Cost in the members list", "description": "S text"})),
    )
    .await);
    let loose = id(&ok(h, 201, "POST", API, None, Some(json!({"title": "A thought with no project"}))).await);
    // stages
    ok(
        h,
        200,
        "POST",
        &format!("{API}/{idea}/stage"),
        Some("Mia"),
        Some(json!({"to": "exploring", "via": "Keep", "tags": ["ai", "cost", "ui"]})),
    )
    .await;
    ok(
        h,
        200,
        "POST",
        &format!("{API}/{idea}/stage"),
        None,
        Some(json!({"to": "parked", "park_until": "2999-01-01", "park_note": "later"})),
    )
    .await;
    ok(h, 200, "POST", &format!("{API}/{idea}/undo"), None, None).await;
    ok(h, 409, "POST", &format!("{API}/{idea}/stage"), None, Some(json!({"to": "archived"}))).await;
    ok(h, 200, "PUT", &format!("{API}/{loose}/project"), None, Some(json!({"project_id": project}))).await;
    ok(
        h,
        200,
        "POST",
        &format!("{API}/{loose}/stage"),
        None,
        Some(json!({"to": "archived", "archive_reason": "not_now", "archive_note": "nope"})),
    )
    .await;
    ok(h, 200, "POST", &format!("{API}/{loose}/stage"), None, Some(json!({"to": "inbox"}))).await;
    // assumptions
    let mut assumptions = Vec::new();
    for (text, impact) in
        [("People pay for it", "high"), ("It fits on the card", "low"), ("The price table stays current", "medium")]
    {
        let a = ok(
            h,
            200,
            "POST",
            &format!("{API}/{idea}/assumption-records"),
            None,
            Some(json!({"text": text, "impact": impact})),
        )
        .await;
        assumptions.push(id(a["assumptions"].as_array().and_then(|x| x.last()).expect("assumption")));
    }
    ok(
        h,
        200,
        "PATCH",
        &format!("{API}/{idea}/assumption-records/{}", assumptions[1]),
        None,
        Some(json!({"status": "validated"})),
    )
    .await;
    ok(
        h,
        200,
        "PATCH",
        &format!("{API}/{idea}/assumption-records/{}", assumptions[2]),
        None,
        Some(json!({"text": "The price table stays up to date", "impact": "high"})),
    )
    .await;
    let test = ok(
        h,
        201,
        "POST",
        &format!("{API}/{idea}/assumption-records/{}/test-ticket", assumptions[0]),
        None,
        Some(json!({"title": "Ask three members"})),
    )
    .await;
    let test_ticket = id(&test["ticket"]);
    // evidence, comments, votes, the log
    ok(h, 201, "POST", &format!("{API}/{idea}/evidence"), None, Some(json!({"assumption_ids": [assumptions[0], assumptions[1]], "kind": "link", "ref": "https://example.com/price", "title": "Price page"}))).await;
    ok(h, 201, "POST", &format!("{API}/{idea}/evidence"), None, Some(json!({"assumption_ids": [assumptions[1]], "kind": "sketch", "ref": "![Run card](sketch:abc)", "title": "Run card with cost"}))).await;
    ok(h, 201, "POST", &format!("{API}/{idea}/evidence"), None, Some(json!({"assumption_ids": [assumptions[1]], "kind": "file", "ref": "/uploads/run-cost-sheet.png", "title": "run-cost-sheet.png"}))).await;
    let comment =
        ok(h, 201, "POST", &format!("{API}/{idea}/comments"), Some("Vera"), Some(json!({"body": "+1 from a viewer"})))
            .await;
    ok(
        h,
        200,
        "PATCH",
        &format!("{API}/{idea}/comments/{}", id(&comment)),
        Some("Vera"),
        Some(json!({"body": "+1, please"})),
    )
    .await;
    ok(h, 201, "POST", &format!("{API}/{idea}/comments"), None, Some(json!({"body": "second comment"}))).await;
    for voter in ["Lan", "Hoa", "Mia"] {
        ok(h, 200, "POST", &format!("{API}/{idea}/vote"), None, Some(json!({"voter": voter}))).await;
    }
    ok(h, 200, "POST", &format!("{API}/{idea}/vote"), None, Some(json!({"voter": "Hoa", "on": false}))).await;
    ok(h, 200, "POST", &format!("{API}/{idea}/microthoughts"), None, Some(json!({"text": "an old style thought"})))
        .await;
    let entry = ok(h, 201, "POST", &format!("{API}/{idea}/log"), None, Some(json!({"kind": "finding", "body": "5 of 8 members checked the card", "assumption_id": assumptions[0], "attachments": [{"name": "notes", "url": "/uploads/notes.md"}]}))).await;
    ok(
        h,
        201,
        "POST",
        &format!("{API}/{idea}/log"),
        Some("Mia"),
        Some(json!({"kind": "note", "body": "a later note"})),
    )
    .await;
    ok(h, 200, "PATCH", &format!("{API}/{idea}/log/{}", id(&entry)), None, Some(json!({"pinned": true}))).await;
    ok(
        h,
        200,
        "POST",
        &format!("{API}/{idea}/log/{}/evidence", id(&entry)),
        None,
        Some(json!({"assumption_id": assumptions[2]})),
    )
    .await;
    ok(h, 200, "PATCH", &format!("{API}/{idea}/page"), None, Some(json!({"body": "## Problem\n\nThe cost is hidden.\n\nA page edited with the AI.", "ai": true, "owner": "Mia", "effort_guess": "3d", "workspace_retention": "forever"}))).await;
    // merge another idea into it, undo, merge again
    ok(h, 200, "POST", &format!("{API}/{other}/vote"), None, Some(json!({"voter": "Tuan"}))).await;
    ok(h, 200, "POST", &format!("{API}/{other}/merge"), None, Some(json!({"into_id": idea}))).await;
    ok(h, 200, "POST", &format!("{API}/{idea}/undo-merge"), None, None).await;
    ok(h, 200, "POST", &format!("{API}/{other}/merge"), None, Some(json!({"into_id": idea}))).await;
    ok(
        h,
        200,
        "POST",
        &format!("{API}/{idea}/assumption-records/{}/resolve", assumptions[0]),
        None,
        Some(json!({"outcome": "unsure"})),
    )
    .await;
    // the stage the checks allow, then promote with sub-tickets
    ok(h, 200, "POST", &format!("{API}/{idea}/stage"), None, Some(json!({"to": "ready", "force": true}))).await;
    ok(h, 200, "GET", &format!("{API}/{idea}/promote/preview"), None, None).await;
    let promoted = ok(h, 201, "POST", &format!("{API}/{idea}/promote"), None, Some(json!({"acknowledge_not_ready": true, "sub_tickets": ["Price table", "Estimate on the card"], "priority": "high"}))).await;
    let shipped_ticket = id(&promoted["ticket"]);
    let mut tickets = Vec::new();
    let mut ideas = vec![idea.clone(), other.clone(), loose.clone()];
    for title in ["Dropped later", "Deleted later"] {
        let i = id(&ok(h, 201, "POST", API, None, Some(json!({"project_id": project, "title": title}))).await);
        let made =
            ok(h, 201, "POST", &format!("{API}/{i}/promote"), None, Some(json!({"acknowledge_not_ready": true}))).await;
        tickets.push(id(&made["ticket"]));
        ideas.push(i);
    }
    ok(h, 200, "GET", &format!("{API}/by-ticket/{shipped_ticket}"), None, None).await;
    ok(h, 200, "GET", &format!("{API}/by-ticket/{test_ticket}"), None, None).await;
    Made {
        project,
        shipped_ticket,
        dropped_ticket: tickets[0].clone(),
        deleted_ticket: tickets[1].clone(),
        test_ticket,
        ideas,
    }
}

/// Change and delete the tickets: the idea is shipped, restored by a reopen, sent back to Exploring when its ticket
/// is dropped, and back to Ready when it is deleted; closing and deleting a test ticket reach the assumption.
pub async fn part_two<H: Http>(h: &H, made: &Made) {
    let ticket = |id: &str| format!("/tickets/{id}");
    ok(h, 200, "PATCH", &ticket(&made.shipped_ticket), None, Some(json!({"status": "in-progress"}))).await;
    ok(h, 200, "PATCH", &ticket(&made.shipped_ticket), None, Some(json!({"status": "done"}))).await;
    ok(h, 200, "PATCH", &ticket(&made.shipped_ticket), None, Some(json!({"status": "todo"}))).await;
    ok(h, 200, "PATCH", &ticket(&made.shipped_ticket), None, Some(json!({"status": "done"}))).await;
    ok(
        h,
        200,
        "PATCH",
        &ticket(&made.dropped_ticket),
        None,
        Some(json!({"status": "wont_do", "wont_do_reason": "superseded"})),
    )
    .await;
    ok(h, 204, "DELETE", &ticket(&made.deleted_ticket), None, None).await;
    ok(h, 200, "PATCH", &ticket(&made.test_ticket), None, Some(json!({"status": "done"}))).await;
    ok(h, 201, "POST", &format!("{API}/{}/promote", made.ideas[3]), None, Some(json!({"acknowledge_not_ready": true})))
        .await;
    ok(h, 204, "DELETE", &ticket(&made.test_ticket), None, None).await;
    ok(h, 200, "GET", &format!("{API}/space?scope=all"), None, None).await;
    ok(h, 200, "GET", &format!("{API}/counts"), None, None).await;
}

/// The tables the scenario fills, rows in an order that does not depend on the random ids, as one JSON object.
pub fn stable(dump: &Value) -> Value {
    let rows = |table: &str| -> Vec<Value> { dump[table].as_array().cloned().unwrap_or_default() };
    let text = |row: &Value, key: &str| row[key].as_str().unwrap_or("").to_string();
    // an assumption by its idea and place, for the evidence that points at it
    let place: std::collections::HashMap<String, String> = rows("idea_assumption")
        .iter()
        .map(|a| (text(a, "id"), format!("{}/{:04}", text(a, "idea_id"), a["position"].as_i64().unwrap_or(0))))
        .collect();
    let mut out = Map::new();
    for table in [
        "idea_ticket",
        "idea_assumption",
        "idea_evidence",
        "idea_comment",
        "idea_log_entry",
        "idea_vote",
        "idea_counter",
        "idea_advice",
        "idea_digest",
        "ticket",
    ] {
        let mut items = rows(table);
        let key = |row: &Value| -> String {
            match table {
                "idea_assumption" => format!("{}/{:04}", text(row, "idea_id"), row["position"].as_i64().unwrap_or(0)),
                "idea_evidence" => format!(
                    "{}|{}|{}",
                    text(row, "kind"),
                    text(row, "ref"),
                    place.get(&text(row, "assumption_id")).cloned().unwrap_or_default()
                ),
                "idea_comment" | "idea_log_entry" => format!("{}|{}", text(row, "idea_id"), text(row, "body")),
                "idea_vote" => format!("{}|{}", text(row, "idea_id"), text(row, "voter")),
                _ => format!("{}", row["id"]),
            }
        };
        items.sort_by_key(|row| key(row));
        out.insert(table.to_string(), Value::Array(items));
    }
    testkit::normalize(&Value::Object(out))
}
