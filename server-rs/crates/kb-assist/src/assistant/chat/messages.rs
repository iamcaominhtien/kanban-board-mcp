//! One message of a chat (`services/assistant/chat.py`, lines 827 to 979): reading it, putting back what its answer
//! changed, feedback, stopping, trying again, posting it as a comment, and `recover` at start.

use std::collections::HashSet;

use kb_ai::store::{loads, now_iso};
use kb_base::{events, pyjson, pytext};
use kb_board::tickets as svc_tickets;
use kb_db::Session;
use kb_db::database;
use kb_db::entities::ai_chat_message;
use kb_db::sea_orm::ActiveValue::Set;
use kb_db::sea_orm::{ActiveModelTrait, ColumnTrait, DbErr, EntityTrait, IntoActiveModel, QueryFilter};
use serde_json::{Map, Value, json};

use super::{ACTIVE, cancel_task, dict, message_of, msg_out, run_of, spawn, undoing};
use crate::assistant::errors::{AssistError, Error};
use crate::assistant::{engine, receipt};

/// One message of the person's own chat.
pub async fn get_message(session: &Session, message_id: &str, by: &str) -> Result<Value, Error> {
    let (m, _chat_row) = message_of(session, message_id, by).await?;
    Ok(msg_out(&m))
}

/// Takes the message out of `UNDOING` when the undo ends, however it ends (Python's `finally`).
struct Undoing(String);

impl Drop for Undoing {
    fn drop(&mut self) {
        undoing().remove(&self.0);
    }
}

/// The indexes a list of JSON numbers names.
fn indexes(list: Option<&Value>) -> HashSet<i64> {
    list.and_then(Value::as_array).map(Vec::as_slice).unwrap_or_default().iter().filter_map(Value::as_i64).collect()
}

/// Put back what an answer changed ("Undo all"): the changes of its receipt, newest first. A change someone else
/// has since overwritten is left as it is and named in `receipt.undo.skipped`.
pub async fn undo_receipt(session: &Session, message_id: &str, by: &str) -> Result<Value, Error> {
    let (m, _chat_row) = message_of(session, message_id, by).await?;
    let mut ctx = dict(&m.context);
    let applied = ctx.get("receipt").and_then(|rec| rec.get("applied")).and_then(Value::as_array).cloned();
    let (Some(mut rec), Some(applied)) =
        (ctx.get("receipt").and_then(Value::as_object).cloned(), applied.filter(|a| !a.is_empty()))
    else {
        return Err(AssistError::new("not_found", "This answer changed nothing.").into());
    };
    let before = rec.get("undo").filter(|u| pyjson::truthy(u)).cloned().unwrap_or(json!({}));
    if rec.get("status").and_then(Value::as_str) == Some("undone") && !before.get("skipped").is_some_and(pyjson::truthy)
    {
        return Err(AssistError::new("conflict", "These changes were already put back.").into());
    }
    if ACTIVE.contains(&m.state.as_str()) {
        return Err(AssistError::new("conflict", "The answer is being written again: wait for it.").into());
    }
    if !undoing().insert(m.id.clone()) {
        return Err(AssistError::new("conflict", "Undo is already running.").into());
    }
    let already = indexes(before.get("put_back"));
    let mut result = {
        let _running = Undoing(m.id.clone());
        let runs = rec.get("runs").and_then(Value::as_array).cloned().unwrap_or_default();
        receipt::undo(session, &applied, &runs, Some(&already)).await?
    };
    let mut put_back: Vec<i64> = already.union(&indexes(result.get("put_back"))).copied().collect();
    put_back.sort_unstable();
    let undone = put_back.len();
    result.insert("put_back".into(), json!(put_back));
    result.insert("undone".into(), json!(undone));
    rec.insert("status".into(), json!(if undone != 0 { "undone" } else { "done" }));
    rec.insert("undo".into(), Value::Object(result));
    ctx.insert("receipt".into(), Value::Object(rec));
    let mut row = kb_db::edit(m);
    row.context = Set(pyjson::dumps(&ctx));
    let m = row.update(session).await?;
    session.commit().await?;
    events::publish(events::INVALIDATE, &[]).await;
    Ok(msg_out(&m))
}

/// Keep (or clear) the asker's thumbs up or down on an answer.
pub async fn set_feedback(
    session: &Session,
    message_id: &str,
    by: &str,
    thumb: Option<&str>,
    reason: &str,
) -> Result<Value, Error> {
    let (m, _chat_row) = message_of(session, message_id, by).await?;
    if !matches!(thumb, None | Some("up" | "down")) {
        return Err(AssistError::new("invalid", "Thumbs up or down.").into());
    }
    let feedback = match thumb {
        Some(thumb) => json!({"thumb": thumb, "reason": reason.chars().take(500).collect::<String>(), "at": now_iso()}),
        None => json!({}),
    };
    let mut row = kb_db::edit(m);
    row.feedback = Set(pyjson::dumps(&feedback));
    let m = row.update(session).await?;
    session.commit().await?;
    Ok(msg_out(&m))
}

/// Stop an answer that is being written.
pub async fn stop(session: &Session, message_id: &str, by: &str) -> Result<Value, Error> {
    let (m, _chat_row) = message_of(session, message_id, by).await?;
    if !ACTIVE.contains(&m.state.as_str()) {
        return Ok(msg_out(&m));
    }
    match run_of(message_id) {
        Some(run_id) => {
            engine::cancel(&run_id);
        }
        None => cancel_task(message_id),
    }
    let mut row = kb_db::edit(m);
    row.state = Set("stopped".to_string());
    row.finished_at = Set(Some(now_iso()));
    let m = row.update(session).await?;
    session.commit().await?;
    Ok(msg_out(&m))
}

/// Try again: the same question is answered again into this message (`continue_`: keep the text written so far).
pub async fn retry(session: &Session, message_id: &str, by: &str, continue_: bool) -> Result<Value, Error> {
    let (m, chat_row) = message_of(session, message_id, by).await?;
    if m.role != "ai" {
        return Err(AssistError::new("invalid", "Only an answer can be tried again.").into());
    }
    if ACTIVE.contains(&m.state.as_str()) {
        return Ok(msg_out(&m));
    }
    let info = engine::ready(&chat_row.project_id, "chat").await?;
    if info.get("state").and_then(Value::as_str) != Some("ready") {
        let message = info.get("message").and_then(Value::as_str).unwrap_or("");
        return Err(AssistError::new("not_configured", message).into());
    }
    let mut row = kb_db::edit(m);
    row.state = Set("thinking".to_string());
    row.error = Set("{}".to_string());
    row.finished_at = Set(None);
    if !continue_ {
        row.text = Set(String::new());
    }
    let m = row.update(session).await?;
    session.commit().await?;
    spawn(&m.id, by, Vec::new());
    Ok(msg_out(&m))
}

/// "Post as comment": share a ticket chat's answer with the team, as a comment with the AI badge.
pub async fn post_as_comment(
    session: &Session,
    message_id: &str,
    by: &str,
    text: Option<&str>,
) -> Result<Map<String, Value>, Error> {
    let (m, chat) = message_of(session, message_id, by).await?;
    if m.role != "ai" || m.state != "done" {
        return Err(AssistError::new("invalid", "Only a finished answer can be posted.").into());
    }
    let Some(ticket_id) = chat.ticket_id.as_deref().filter(|id| !id.is_empty()) else {
        return Err(AssistError::new("invalid", "This chat is not about a ticket.").into());
    };
    let body = pytext::strip(text.filter(|t| !t.is_empty()).unwrap_or(m.text.as_str()));
    if body.is_empty() {
        return Err(AssistError::new("invalid", "There is nothing to post.").into());
    }
    let mut meta = Map::new();
    meta.insert("ai".into(), json!({"member": "Board AI", "chat_message_id": m.id, "posted_by": by}));
    let Some(ticket) = svc_tickets::add_comment(session, ticket_id, body, by, Some(&meta)).await? else {
        return Err(AssistError::new("not_found", "Ticket not found.").into());
    };
    // `(loads(ticket.comments, []) or [{}])[-1].get("id")`
    let comment_id = match loads(Some(&ticket.comments), json!([])) {
        Value::Array(comments) => comments.last().and_then(|c| c.get("id")).cloned().unwrap_or(Value::Null),
        _ => Value::Null,
    };
    let mut ctx = dict(&m.context);
    ctx.insert("posted".into(), json!({"comment_id": comment_id, "at": now_iso(), "by": by}));
    let mut row = kb_db::edit(m);
    row.context = Set(pyjson::dumps(&ctx));
    row.update(session).await?;
    session.commit().await?;
    events::publish(events::INVALIDATE, &[]).await;
    let mut out = Map::new();
    out.insert("comment_id".into(), comment_id);
    out.insert("ticket_id".into(), json!(ticket_id));
    Ok(out)
}

/// At start: answers that were being written when the board stopped are marked so (Try again answers them).
pub async fn recover() -> Result<(), DbErr> {
    let session = database::session();
    let rows =
        ai_chat_message::Entity::find().filter(ai_chat_message::Column::State.is_in(ACTIVE)).all(&session).await?;
    let any = !rows.is_empty();
    for m in rows {
        let mut row = kb_db::edit(m);
        row.state = Set("error".to_string());
        row.finished_at = Set(Some(now_iso()));
        row.error = Set(pyjson::dumps(&json!({
            "code": "unavailable",
            "message": "The board restarted while this was being written. Try again.",
        })));
        row.update(&session).await?;
    }
    if any {
        session.commit().await?;
    }
    Ok(())
}
