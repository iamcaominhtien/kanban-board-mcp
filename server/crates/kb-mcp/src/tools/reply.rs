//! Short answers for the calls that change a ticket: the ticket in brief and the item the call touched, instead of
//! the whole ticket with every comment, log entry and test case (which the agent already has, or reads with
//! get_ticket when it needs them).

use serde_json::{Map, Value, json};

/// The fields of the ticket card, in order: each is left out when it is null, empty or false.
const CARD_FIELDS: [&str; 22] = [
    "id",
    "title",
    "type",
    "status",
    "priority",
    "assignee",
    "parent_id",
    "tags",
    "estimate",
    "start_date",
    "due_date",
    "wave_pin",
    "review_requested_from",
    "blocks",
    "blocked_by",
    "wont_do_reason",
    "repo_path",
    "block_done_if_acs_incomplete",
    "block_done_if_tcs_incomplete",
    "reopen_count",
    "last_reopen_reason",
    "completed_at",
];

/// The details of a pending ticket, shown while it is pending.
const PENDING_FIELDS: [&str; 7] = [
    "pending_reason_type",
    "pending_ticket_id",
    "pending_member_id",
    "pending_party",
    "pending_note",
    "pending_since",
    "pending_by",
];

/// The longest text an item keeps in an answer: the agent wrote it, so the start is enough to tell which it is.
const TEXT_LIMIT: usize = 300;

/// Whether a value says nothing: null, false, 0, an empty text, list or object.
fn is_blank(value: &Value) -> bool {
    match value {
        Value::Null => true,
        Value::Bool(flag) => !flag,
        Value::Number(n) => n.as_f64() == Some(0.0),
        Value::String(text) => text.is_empty(),
        Value::Array(items) => items.is_empty(),
        Value::Object(map) => map.is_empty(),
    }
}

/// Whether an answer is a whole ticket (what the ticket operations return).
pub fn is_ticket(value: &Value) -> bool {
    value.get("id").is_some() && value.get("comments").is_some() && value.get("status").is_some()
}

/// How many of a list's items `done` flags.
fn tally(items: &[Value], done: impl Fn(&Value) -> bool) -> Value {
    json!({"done": items.iter().filter(|item| done(item)).count(), "total": items.len()})
}

/// Returns the ticket in brief: what it is and where it stands (status, who has it, what blocks or parks it), and
/// counts of its lists. Fields that say nothing are left out.
pub fn ticket_card(ticket: &Value) -> Value {
    let mut card = Map::new();
    for name in CARD_FIELDS {
        if let Some(value) = ticket.get(name).filter(|v| !is_blank(v) || name == "id") {
            card.insert(name.to_string(), value.clone());
        }
    }
    if ticket.get("pending").is_some_and(|p| !is_blank(p)) {
        card.insert("pending".into(), Value::Bool(true));
        for name in PENDING_FIELDS {
            if let Some(value) = ticket.get(name).filter(|v| !is_blank(v)) {
                card.insert(name.to_string(), value.clone());
            }
        }
    }
    let list = |name: &str| ticket.get(name).and_then(Value::as_array).cloned().unwrap_or_default();
    let flagged = |item: &Value| item.get("done").is_some_and(kb_base::pyjson::truthy);
    let criteria = list("acceptance_criteria");
    if !criteria.is_empty() {
        card.insert("acceptance_criteria".into(), tally(&criteria, flagged));
    }
    let sub_tasks = list("sub_tasks");
    if !sub_tasks.is_empty() {
        card.insert("sub_tasks".into(), tally(&sub_tasks, flagged));
    }
    let cases = list("test_cases");
    if !cases.is_empty() {
        let status = |case: &Value| case.get("status").and_then(Value::as_str).unwrap_or_default().to_string();
        let passed = cases.iter().filter(|c| status(c) == "pass").count();
        let failed = cases.iter().filter(|c| status(c) == "fail").count();
        let mut counts = json!({"passed": passed, "total": cases.len()});
        if failed > 0 {
            counts["failed"] = json!(failed);
        }
        card.insert("test_cases".into(), counts);
    }
    let comments = list("comments");
    let shown = comments.iter().filter(|c| c.get("deleted_at").is_none_or(Value::is_null)).count();
    for (name, count) in [
        ("comments", shown),
        ("work_log", list("work_log").len()),
        ("branches", list("branches").len()),
        ("links", list("links").len()),
    ] {
        if count > 0 {
            card.insert(name.into(), json!(count));
        }
    }
    Value::Object(card)
}

/// An item as the answer shows it: long texts cut to their start, and a comment's fields that say nothing left out.
fn brief(item: &Value) -> Value {
    let Value::Object(fields) = item else { return item.clone() };
    let mut out = Map::new();
    for (name, value) in fields {
        match value {
            Value::String(text) if text.chars().count() > TEXT_LIMIT => {
                let start: String = text.chars().take(TEXT_LIMIT).collect();
                out.insert(name.clone(), json!(format!("{start}… ({} characters)", text.chars().count())));
            }
            Value::Null | Value::Array(_) if is_blank(value) => {}
            _ => {
                out.insert(name.clone(), value.clone());
            }
        }
    }
    Value::Object(out)
}

/// The item of a ticket's list that `key` names: by id, code (a test case's 'TC-2') or name (a branch).
fn find<'a>(items: &'a [Value], key: &str) -> Option<&'a Value> {
    items
        .iter()
        .find(|item| ["id", "code", "name"].iter().any(|field| item.get(*field).and_then(Value::as_str) == Some(key)))
}

/// The list of the ticket an item kind lives in, and the name the answer gives one item of it.
fn list_of(item: &str) -> Option<(&'static str, &'static str)> {
    Some(match item {
        "comment" => ("comments", "comment"),
        "work_log" => ("work_log", "work_log"),
        "criterion" => ("acceptance_criteria", "criterion"),
        "sub_task" => ("sub_tasks", "sub_task"),
        "test_case" => ("test_cases", "test_case"),
        "branch" => ("branches", "branch"),
        _ => return None,
    })
}

/// Returns the answer of a call that changed one item of a ticket's list (`item`: comment, work_log, criterion,
/// sub_task, test_case, attachment, branch): `{ticket: card, <item>: the item as it is now}`, or `deleted: <key>`
/// when it is gone. `keys` are the ids the call named, tried in order (an update's new name first); an `add` names
/// none and its item is the newest. An answer that is not a ticket is returned as it is.
pub fn item_answer(out: Value, item: &str, action: &str, keys: &[String]) -> Value {
    if !is_ticket(&out) {
        return out;
    }
    let mut answer = Map::new();
    answer.insert("ticket".into(), ticket_card(&out));
    if item == "attachment" {
        if let Some(attached) = out.get("attached") {
            answer.insert("attached".into(), attached.clone());
        }
        let posted = out.get("comments").and_then(Value::as_array).and_then(|c| c.last());
        if let (Some(comment), Some(url)) = (posted, out["attached"]["url"].as_str()) {
            if comment["text"].as_str().is_some_and(|text| text.contains(url)) {
                answer.insert("comment".into(), brief(comment));
            }
        }
        return Value::Object(answer);
    }
    let Some((list, name)) = list_of(item) else { return out };
    let items = out.get(list).and_then(Value::as_array).cloned().unwrap_or_default();
    let found = if action == "add" {
        keys.iter().find_map(|key| find(&items, key)).or(items.last())
    } else {
        keys.iter().find_map(|key| find(&items, key))
    };
    match found {
        Some(found) => {
            answer.insert(name.into(), brief(found));
        }
        None => {
            answer.insert("deleted".into(), json!(keys.last().cloned().unwrap_or_default()));
        }
    }
    Value::Object(answer)
}

/// Returns the answer of a manage_ticket call: a ticket as its card, `{blocker, blocked}` as two cards, anything
/// else as it is.
pub fn ticket_answer(out: Value) -> Value {
    if is_ticket(&out) {
        return ticket_card(&out);
    }
    match (out.get("blocker"), out.get("blocked")) {
        (Some(blocker), Some(blocked)) if is_ticket(blocker) && is_ticket(blocked) => {
            json!({"blocker": ticket_card(blocker), "blocked": ticket_card(blocked)})
        }
        _ => out,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ticket() -> Value {
        json!({
            "id": "TKT-1", "project_id": "p", "title": "Login", "description": "long text", "type": "bug",
            "status": "todo", "priority": "high", "assignee": null, "parent_id": null, "tags": [], "estimate": null,
            "blocks": [], "blocked_by": ["TKT-2"], "pending": false, "pending_note": "x", "reopen_count": 0,
            "comments": [
                {"id": "c1", "text": "first", "deleted_at": null, "mentions": []},
                {"id": "c2", "text": "gone", "deleted_at": "t"},
            ],
            "acceptance_criteria": [{"id": "a1", "text": "works", "done": true}, {"id": "a2", "text": "fast", "done": false}],
            "sub_tasks": [],
            "test_cases": [{"id": "t1", "code": "TC-1", "status": "fail"}],
            "work_log": [], "branches": [{"id": "b1", "name": "feat/x"}], "links": [],
        })
    }

    #[test]
    fn the_card_says_where_the_ticket_stands_without_its_lists() {
        assert_eq!(
            ticket_card(&ticket()),
            json!({
                "id": "TKT-1", "title": "Login", "type": "bug", "status": "todo", "priority": "high",
                "blocked_by": ["TKT-2"], "acceptance_criteria": {"done": 1, "total": 2},
                "test_cases": {"passed": 0, "total": 1, "failed": 1}, "comments": 1, "branches": 1,
            })
        );
        let mut parked = ticket();
        parked["pending"] = json!(true);
        assert_eq!(ticket_card(&parked)["pending_note"], "x");
    }

    #[test]
    fn an_item_answer_holds_the_item_the_call_touched() {
        let added = item_answer(ticket(), "comment", "add", &[]);
        assert_eq!(added["comment"], json!({"id": "c2", "text": "gone", "deleted_at": "t"}));
        let toggled = item_answer(ticket(), "criterion", "toggle", &["a2".into()]);
        assert_eq!(toggled["criterion"], json!({"id": "a2", "text": "fast", "done": false}));
        assert_eq!(toggled["ticket"]["acceptance_criteria"], json!({"done": 1, "total": 2}));
        let by_code = item_answer(ticket(), "test_case", "update", &["TC-1".into()]);
        assert_eq!(by_code["test_case"]["id"], "t1");
        let renamed = item_answer(ticket(), "branch", "update", &["feat/x".into(), "b9".into()]);
        assert_eq!(renamed["branch"]["id"], "b1");
        let gone = item_answer(ticket(), "sub_task", "delete", &["s1".into()]);
        assert_eq!(gone["deleted"], "s1");
        assert_eq!(item_answer(json!({"removed": 1}), "comment", "add", &[]), json!({"removed": 1}));
    }

    #[test]
    fn a_long_text_keeps_its_start() {
        let mut long = ticket();
        long["comments"][1]["text"] = json!("a".repeat(1000));
        let added = item_answer(long, "comment", "add", &[]);
        assert_eq!(added["comment"]["text"], json!(format!("{}… (1000 characters)", "a".repeat(300))));
    }

    #[test]
    fn a_block_answers_with_both_cards() {
        let both = ticket_answer(json!({"blocker": ticket(), "blocked": ticket()}));
        assert_eq!(both["blocker"]["id"], "TKT-1");
        assert!(both["blocked"].get("comments").is_some_and(|c| c == 1));
        assert_eq!(ticket_answer(json!({"deleted": "TKT-1"})), json!({"deleted": "TKT-1"}));
    }
}
