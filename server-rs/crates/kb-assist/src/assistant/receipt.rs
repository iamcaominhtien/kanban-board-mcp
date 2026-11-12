//! The receipt of a Board AI answer: what the turn changed on tickets, and putting it back (AI v2,
//! design/screens/ai-board-wave3.md, B and G) (`services/assistant/receipt.py`, lines 1 to 326).
//!
//! The Board AI acts through the board's own tools with the asker's rights, so every change it makes is already in
//! the Activity of its ticket, marked with the id of the turn's run. The receipt is read from there, kept on the
//! answer (`context.receipt`) and, on "Undo all", each change is put back unless something else changed the same
//! field since.
//!
//! Not in the receipt: edits of a Docs page (they leave no ticket Activity) and what a tool refused.

use std::collections::{HashMap, HashSet};

use kb_base::activity::clip;
use kb_base::pyjson;
use kb_board::tickets as svc_tickets;
use kb_board::tickets::TicketUpdate;
use kb_db::Session;
use kb_db::entities::{member, ticket};
use kb_db::sea_orm::{ColumnTrait, DbErr, EntityTrait, QueryFilter};
use serde_json::{Map, Value, json};

use super::errors::Error;

/// Activity fields a turn can set that are put back by writing the old value again.
pub const FIELDS: [&str; 11] = [
    "status",
    "assignee",
    "priority",
    "estimate",
    "due_date",
    "start_date",
    "title",
    "description",
    "parent_id",
    "tags",
    "type",
];
/// Listed in the receipt; there is no way back for these.
pub const LISTED: [&str; 3] = ["sub_task", "acceptance_criterion", "branch"];
/// The most changes one receipt lists.
pub const MAX_CHANGES: usize = 200;
/// Moving a ticket into these hands its work over (a pull request, a merge): that is for a person to do.
pub const HAND_OVER: [&str; 2] = ["review", "done"];

/// `_loads`: `json.loads(raw) if raw else default`, and `default` for text that is not JSON.
fn loads(raw: Option<&str>, default: Value) -> Value {
    match raw {
        None | Some("") => default,
        Some(text) => serde_json::from_str(text).unwrap_or(default),
    }
}

/// The items of a stored JSON list (nothing for a value that is not a list).
fn list_of(raw: &str) -> Vec<Value> {
    match loads(Some(raw), json!([])) {
        Value::Array(items) => items,
        _ => Vec::new(),
    }
}

/// `e.get(key)`.
fn field<'a>(e: &'a Value, key: &str) -> &'a Value {
    e.get(key).unwrap_or(&Value::Null)
}

/// `str(value or "")`.
fn text_or_empty(value: &Value) -> String {
    if pyjson::truthy(value) { py_text(value) } else { String::new() }
}

/// `str(value)`.
fn py_text(value: &Value) -> String {
    match value {
        Value::String(s) => s.clone(),
        other => pyjson::py_str(other),
    }
}

/// `text[:n]`, in characters.
fn first_chars(text: &str, n: usize) -> String {
    text.chars().take(n).collect()
}

/// `a == b` as Python compares what JSON holds: numbers by value (`2 == 2.0`, `True == 1`), the rest as they are.
fn py_eq(a: &Value, b: &Value) -> bool {
    fn number(v: &Value) -> Option<f64> {
        match v {
            Value::Number(n) => n.as_f64(),
            Value::Bool(b) => Some(f64::from(u8::from(*b))),
            _ => None,
        }
    }
    match (a, b) {
        (Value::Array(x), Value::Array(y)) => x.len() == y.len() && x.iter().zip(y).all(|(p, q)| py_eq(p, q)),
        (Value::Object(x), Value::Object(y)) => {
            x.len() == y.len() && x.iter().all(|(k, p)| y.get(k).is_some_and(|q| py_eq(p, q)))
        }
        _ => match (number(a), number(b)) {
            (Some(x), Some(y)) => x == y,
            (None, None) => a == b,
            _ => false,
        },
    }
}

/// `_names`: member ids to names, for the assignee lines.
async fn names(session: &Session, ids: &HashSet<String>) -> Result<HashMap<String, String>, DbErr> {
    if ids.is_empty() {
        return Ok(HashMap::new());
    }
    let rows = member::Entity::find().filter(member::Column::Id.is_in(ids.iter().cloned())).all(session).await?;
    Ok(rows.into_iter().map(|m| (m.id, m.name)).collect())
}

/// `_item_words`: what a sub-task, criterion, branch or link entry says, in a few words.
pub fn item_words(field_name: &str, e: &Value) -> String {
    let what = match field_name {
        "sub_task" => "sub-task",
        "acceptance_criterion" => "acceptance criterion",
        "branch" => "branch",
        _ => "link",
    };
    let (before, after, reference) = (field(e, "from"), field(e, "to"), field(e, "ref"));
    let text = [reference, after, before].into_iter().find(|v| pyjson::truthy(v)).map(py_text).unwrap_or_default();
    let verb = if matches!(field_name, "sub_task" | "acceptance_criterion") {
        if before.is_null() && !after.is_null() {
            "added"
        } else if after.is_null() {
            "removed"
        } else if after == "done" {
            "ticked"
        } else if before == "done" {
            "unticked"
        } else {
            "changed"
        }
    } else if after.is_null() && !before.is_null() {
        "removed"
    } else {
        "added"
    };
    let tail =
        if !text.is_empty() && field_name != "branch" { format!(": {}", first_chars(&text, 80)) } else { String::new() };
    format!("{what} {verb}{tail}")
}

/// The changes the turn `run_id` made on tickets (of one project, or of every project when `project_id` is None),
/// oldest first.
///
/// Each change is `{op, ticket, before, after, at, undo}`; `undo` says whether the board can put it back, `words`
/// says a listed one in words.
pub async fn collect(
    session: &Session,
    project_id: Option<&str>,
    run_id: &str,
    since: Option<&str>,
) -> Result<Vec<Value>, DbErr> {
    let mut stmt = ticket::Entity::find().filter(ticket::Column::ActivityLog.contains(run_id));
    if let Some(project_id) = project_id.filter(|p| !p.is_empty()) {
        stmt = stmt.filter(ticket::Column::ProjectId.eq(project_id));
    }
    if let Some(since) = since.filter(|s| !s.is_empty()) {
        // only tickets touched while the turn ran: no scan of the whole board for a plain answer
        stmt = stmt.filter(ticket::Column::UpdatedAt.gte(since));
    }
    let mut changes: Vec<Value> = Vec::new();
    for t in stmt.all(session).await? {
        let log: Vec<Value> =
            list_of(&t.activity_log).into_iter().filter(|e| field(e, "run_id").as_str() == Some(run_id)).collect();
        let born_here = log.iter().any(|e| field(e, "field") == "created");
        for e in &log {
            let name = text_or_empty(field(e, "field"));
            let name = name.as_str();
            if name == "created" {
                let title = Some(field(e, "ref")).filter(|r| pyjson::truthy(r)).cloned().unwrap_or(json!(t.title));
                changes.push(json!({
                    "op": "create",
                    "ticket": t.id,
                    "created": t.id,
                    "type": t.r#type,
                    "title": title,
                    "before": null,
                    "after": null,
                    "at": field(e, "at"),
                    "undo": true,
                }));
            } else if name == "comment" {
                changes.push(json!({
                    "op": "comment",
                    "ticket": t.id,
                    "before": null,
                    "after": field(e, "to"),
                    "ref": field(e, "ref"),
                    "at": field(e, "at"),
                    "undo": true,
                }));
            } else if FIELDS.contains(&name) {
                if born_here {
                    continue; // the ticket is new: its first values are part of "created"
                }
                changes.push(json!({
                    "op": name,
                    "ticket": t.id,
                    "before": field(e, "from"),
                    "after": field(e, "to"),
                    "at": field(e, "at"),
                    "undo": true,
                }));
            } else if LISTED.contains(&name) {
                if born_here {
                    continue;
                }
                changes.push(json!({
                    "op": name,
                    "ticket": t.id,
                    "before": field(e, "from"),
                    "after": field(e, "to"),
                    "words": item_words(name, e),
                    "at": field(e, "at"),
                    "undo": false,
                }));
            }
        }
    }
    for c in &mut changes {
        if c["op"] != "description" {
            continue;
        }
        for k in ["before", "after"] {
            let long = c[k].as_str().filter(|text| text.chars().count() > 190).map(|text| first_chars(text, 189));
            if let Some(cut) = long {
                c[k] = json!(format!("{cut}…"));
                c["undo"] = json!(false); // a clipped text cannot be written back
                c["words"] = json!("description rewritten (too long to put back)");
            }
        }
    }
    changes.sort_by_key(|c| text_or_empty(field(c, "at")));
    changes.truncate(MAX_CHANGES);
    let ids: HashSet<String> = changes
        .iter()
        .filter(|c| c["op"] == "assignee")
        .flat_map(|c| [&c["before"], &c["after"]])
        .filter(|v| pyjson::truthy(v))
        .map(py_text)
        .collect();
    let names = names(session, &ids).await?;
    for c in &mut changes {
        if c["op"] == "assignee" {
            // the receipt says the name; the id stays beside it for the way back
            c["before_id"] = c["before"].clone();
            c["after_id"] = c["after"].clone();
            for k in ["before", "after"] {
                if pyjson::truthy(&c[k]) {
                    if let Some(name) = names.get(&py_text(&c[k])) {
                        c[k] = json!(name);
                    }
                }
            }
        }
    }
    Ok(changes)
}

/// The receipt as it is kept on the answer (`runs`: the turns whose changes it lists).
pub fn summary(changes: Vec<Value>, runs: Vec<Value>) -> Value {
    json!({"applied": changes, "count": changes.len(), "status": "done", "runs": runs})
}

/// `(old or {}).get(key) or []` as a list.
fn old_list(old: Option<&Value>, key: &str) -> Vec<Value> {
    old.and_then(|o| o.get(key)).and_then(Value::as_array).cloned().unwrap_or_default()
}

/// The indexes a receipt's `undo.put_back` names.
fn indexes(list: Option<&Value>) -> HashSet<i64> {
    let items = list.and_then(Value::as_array).map(Vec::as_slice).unwrap_or_default();
    items.iter().filter_map(|v| v.as_i64().or_else(|| v.as_f64().filter(|f| f.fract() == 0.0).map(|f| f as i64))).collect()
}

/// The receipt of an answer tried again: what the first try did and was not put back stays in it.
pub fn merge(old: Option<&Value>, changes: Vec<Value>, run_id: &str) -> Option<Value> {
    let old = old.filter(|o| pyjson::truthy(o));
    let applied = old_list(old, "applied");
    let back = indexes(old.and_then(|o| o.get("undo")).and_then(|u| u.get("put_back")));
    let kept = applied.into_iter().enumerate().filter(|(i, _)| !back.contains(&(*i as i64))).map(|(_, a)| a);
    let mut runs = old_list(old, "runs");
    runs.push(json!(run_id));
    let both: Vec<Value> = kept.chain(changes).collect();
    if both.is_empty() { None } else { Some(summary(both, runs)) }
}

/// `_same`: equal as the Activity keeps them (clipped text, no tags is None).
fn same(a: &Value, b: &Value) -> bool {
    if a.is_array() || b.is_array() {
        // `list(a or []) == list(b or [])`
        let items = |v: &Value| -> Vec<Value> {
            match v {
                Value::Array(items) => items.clone(),
                Value::String(text) => text.chars().map(|c| json!(c.to_string())).collect(),
                _ => Vec::new(),
            }
        };
        return py_eq(&Value::Array(items(a)), &Value::Array(items(b)));
    }
    if a.is_string() || b.is_string() {
        return py_eq(&clip(a.clone()), &clip(b.clone()));
    }
    py_eq(a, b)
}

/// `_current`: what the ticket holds in `field` now.
fn current(t: &ticket::Model, field_name: &str) -> Value {
    match field_name {
        "status" => json!(t.status),
        "assignee" => json!(t.assignee),
        "priority" => json!(t.priority),
        "estimate" => json!(t.estimate),
        "due_date" => json!(t.due_date),
        "start_date" => json!(t.start_date),
        "title" => json!(t.title),
        "description" => json!(t.description),
        "parent_id" => json!(t.parent_id),
        "tags" => loads(Some(&t.tags), json!([])),
        "type" => json!(t.r#type),
        _ => Value::Null,
    }
}

/// `_later`: who changed `field` after the turn did, and when ("Hoa Mai at 10:51 UTC").
fn later(t: &ticket::Model, field_name: &str, after_at: &Value) -> String {
    let after_at = text_or_empty(after_at);
    for e in list_of(&t.activity_log).iter().rev() {
        let at = text_or_empty(field(e, "at"));
        if field(e, "field") == field_name && at > after_at {
            let who = Some(field(e, "actor")).filter(|a| pyjson::truthy(a)).map(py_text);
            let who = who.unwrap_or_else(|| "someone".to_string());
            let when: String = at.chars().skip(11).take(5).collect();
            return if when.is_empty() { who } else { format!("{who} at {when} UTC") };
        }
    }
    "someone else".to_string()
}

/// One change put back, or why it was not.
enum Outcome {
    Back,
    Skipped(String),
    Nothing,
}

async fn put_back_one(
    session: &Session,
    applied: &[Value],
    runs: &[Value],
    c: &Value,
    t: &ticket::Model,
    op: &str,
    label: &str,
) -> Result<Outcome, Error> {
    let ticket_id = t.id.as_str();
    if op == "create" {
        let children = ticket::Entity::find().filter(ticket::Column::ParentId.eq(ticket_id)).one(session).await?;
        let mine: HashSet<String> = applied
            .iter()
            .filter(|x| x["op"] == "comment" && x["ticket"] == ticket_id)
            .map(|x| py_text(field(x, "ref")))
            .collect();
        let made_at = text_or_empty(field(c, "at"));
        let since = list_of(&t.activity_log)
            .iter()
            .any(|e| text_or_empty(field(e, "at")) > made_at && !runs.iter().any(|r| py_eq(r, field(e, "run_id"))));
        let others = list_of(&t.comments).iter().any(|x| {
            !pyjson::truthy(field(x, "deleted_at")) && !field(x, "id").as_str().is_some_and(|id| mine.contains(id))
        });
        if children.is_some() || since || others {
            return Ok(Outcome::Skipped(format!("{label} (it has been worked on since)")));
        }
        if svc_tickets::delete_ticket(session, ticket_id).await? {
            return Ok(Outcome::Back);
        }
        return Ok(Outcome::Nothing);
    }
    if op == "comment" {
        let reference = field(c, "ref");
        let live = list_of(&t.comments)
            .iter()
            .any(|x| py_eq(field(x, "id"), reference) && !pyjson::truthy(field(x, "deleted_at")));
        if !live {
            return Ok(Outcome::Skipped(format!("{label} (it is already gone)")));
        }
        svc_tickets::delete_comment(session, ticket_id, &py_text(reference)).await?;
        return Ok(Outcome::Back);
    }
    let after = if op == "assignee" { field(c, "after_id") } else { field(c, "after") };
    if !same(&current(t, op), after) {
        return Ok(Outcome::Skipped(format!("{label} (now set by {})", later(t, op, field(c, "at")))));
    }
    let mut before = if op == "assignee" { field(c, "before_id").clone() } else { field(c, "before").clone() };
    if op == "tags" {
        // `list(before or [])`
        before = if before.is_array() { before } else { json!([]) };
    }
    if op == "status" && before.as_str().is_some_and(|b| HAND_OVER.contains(&b)) {
        return Ok(Outcome::Skipped(format!(
            "{label} (moving it back to {} hands its work over: do that yourself)",
            py_text(&before)
        )));
    }
    // `TicketUpdate(**{op: before})`: a value the field does not take is a `ValueError` (pydantic's)
    let mut body = Map::new();
    body.insert(op.to_string(), before);
    let update: TicketUpdate =
        serde_json::from_value(Value::Object(body)).map_err(|err| Error::Value(err.to_string()))?;
    if svc_tickets::update_ticket(session, ticket_id, &update).await?.is_none() {
        return Ok(Outcome::Skipped(format!("{label} (the ticket is gone)")));
    }
    Ok(Outcome::Back)
}

/// Put the changes back, newest first. A change is left alone when the field was changed by someone else since.
///
/// Returns `{undone, put_back, skipped, kept}`: `put_back` holds the indexes (in `applied`) that are back; each
/// `skipped` line names the ticket, the field and what overwrote it; `kept` names what has no way back.
pub async fn undo(
    session: &Session,
    applied: &[Value],
    runs: &[Value],
    already: Option<&HashSet<i64>>,
) -> Result<Map<String, Value>, Error> {
    let mut put_back: Vec<i64> = Vec::new();
    let mut skipped: Vec<String> = Vec::new();
    let mut kept: Vec<String> = Vec::new();
    for (i, c) in applied.iter().enumerate().rev() {
        if already.is_some_and(|done| done.contains(&(i as i64))) {
            continue;
        }
        let (ticket_id, op) = (py_text(field(c, "ticket")), py_text(field(c, "op")));
        let label = format!("{ticket_id} {}", op.replace('_', " "));
        if !pyjson::truthy(field(c, "undo")) {
            let words = Some(field(c, "words")).filter(|w| pyjson::truthy(w));
            kept.push(match words {
                Some(words) => format!("{ticket_id} {}", py_text(words)),
                None => label,
            });
            continue;
        }
        let Some(t) = ticket::Entity::find_by_id(ticket_id.as_str()).one(session).await? else {
            skipped.push(format!("{label} (the ticket is gone)"));
            continue;
        };
        match put_back_one(session, applied, runs, c, &t, &op, &label).await {
            Ok(Outcome::Back) => put_back.push(i as i64),
            Ok(Outcome::Skipped(line)) => skipped.push(line),
            Ok(Outcome::Nothing) => {}
            // `except ValueError as exc`: the ticket's own rules refused the way back
            Err(Error::Value(message)) => skipped.push(format!("{label}: {message}")),
            Err(Error::Assist(err)) => skipped.push(format!("{label}: {}", err.message)),
            Err(other) => return Err(other),
        }
    }
    put_back.sort_unstable();
    let mut out = Map::new();
    out.insert("undone".into(), json!(put_back.len()));
    out.insert("put_back".into(), json!(put_back));
    out.insert("skipped".into(), json!(skipped));
    out.insert("kept".into(), json!(kept));
    Ok(out)
}
