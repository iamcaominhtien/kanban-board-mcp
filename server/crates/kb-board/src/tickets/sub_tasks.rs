//! `services/tickets.py`, lines 1089-1176: the sub-tasks of a ticket (lightweight checklist items, not tickets).

use kb_base::{activity as act, time};
use kb_db::Session;
use kb_db::entities::ticket;
use serde_json::{Value, json};

use super::validate::{MAX_SUB_TASK_TEXT, clean_text};
use super::{Error, commit, dumps, field, for_edit, loads, put};
use kb_base::pyjson::truthy;

/// Append a sub-task.
///
/// Returns the updated ticket, or None if it does not exist.
pub async fn add_sub_task(session: &Session, ticket_id: &str, text: &str) -> Result<Option<ticket::Model>, Error> {
    let Some(stored) = for_edit(session, ticket_id).await? else {
        return Ok(None);
    };
    let mut ticket = stored.clone();
    let text = clean_text(Some(text), "Sub-task", MAX_SUB_TASK_TEXT)?;
    let mut items = loads(&ticket.sub_tasks)?;
    items.push(json!({"id": time::uuid4(), "text": text, "done": false}));
    act::record(&mut ticket.activity_log, "sub_task", Value::Null, json!(text), None, None);
    ticket.sub_tasks = dumps(&items);
    ticket.updated_at = time::now_iso();
    Ok(Some(commit(session, &stored, ticket).await?))
}

/// Flip a sub-task's done state.
///
/// Returns the updated ticket (also when no sub-task has this id), or None if the ticket does not exist.
pub async fn toggle_sub_task(
    session: &Session,
    ticket_id: &str,
    sub_task_id: &str,
) -> Result<Option<ticket::Model>, Error> {
    let Some(stored) = for_edit(session, ticket_id).await? else {
        return Ok(None);
    };
    let mut ticket = stored.clone();
    let mut items = loads(&ticket.sub_tasks)?;
    for item in &mut items {
        if field(item, "id").as_str() == Some(sub_task_id) {
            let done = !truthy(field(item, "done"));
            put(item, "done", json!(done));
            let (from, to) = if done { ("open", "done") } else { ("done", "open") };
            act::record(
                &mut ticket.activity_log,
                "sub_task",
                json!(from),
                json!(to),
                field(item, "text").as_str(),
                None,
            );
            break;
        }
    }
    ticket.sub_tasks = dumps(&items);
    ticket.updated_at = time::now_iso();
    Ok(Some(commit(session, &stored, ticket).await?))
}

/// Remove a sub-task.
///
/// Returns the updated ticket (also when no sub-task has this id), or None if the ticket does not exist.
pub async fn delete_sub_task(
    session: &Session,
    ticket_id: &str,
    sub_task_id: &str,
) -> Result<Option<ticket::Model>, Error> {
    let Some(stored) = for_edit(session, ticket_id).await? else {
        return Ok(None);
    };
    let mut ticket = stored.clone();
    let mut items = loads(&ticket.sub_tasks)?;
    if let Some(removed) = items.iter().find(|i| field(i, "id").as_str() == Some(sub_task_id)) {
        let text = field(removed, "text").clone();
        act::record(&mut ticket.activity_log, "sub_task", text, Value::Null, None, None);
    }
    items.retain(|i| field(i, "id").as_str() != Some(sub_task_id));
    ticket.sub_tasks = dumps(&items);
    ticket.updated_at = time::now_iso();
    Ok(Some(commit(session, &stored, ticket).await?))
}
