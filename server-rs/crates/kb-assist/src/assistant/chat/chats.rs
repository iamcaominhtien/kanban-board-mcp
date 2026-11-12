//! `detail`, `update_chat`, `mark_seen` and `delete_chat` of `services/assistant/chat.py` (lines 440 to 515).

use kb_ai::store::{loads, now_iso};
use kb_base::pyjson;
use kb_db::Session;
use kb_db::entities::{ai_chat, ai_chat_message};
use kb_db::sea_orm::ActiveValue::Set;
use kb_db::sea_orm::{
    ActiveModelTrait, ColumnTrait, EntityTrait, IntoActiveModel, ModelTrait, QueryFilter, QueryOrder,
};
use serde_json::{Map, Value, json};

use super::{SCOPES, cancel_task, chat_of, chat_out, msg_out, settle_team_messages, target};
use crate::assistant::errors::{AssistError, Error};
use crate::assistant::sessions;

/// A chat with its messages.
pub async fn detail(session: &Session, chat_id: &str, by: &str) -> Result<Map<String, Value>, Error> {
    let chat = chat_of(session, chat_id, by).await?;
    settle_team_messages(session, &chat).await?;
    let rows = ai_chat_message::Entity::find()
        .filter(ai_chat_message::Column::ChatId.eq(chat.id.as_str()))
        .order_by_asc(ai_chat_message::Column::CreatedAt)
        .all(session)
        .await?;
    let mut out = chat_out(&chat);
    out.insert("messages".into(), Value::Array(rows.iter().map(msg_out).collect()));
    out.insert("drafts".into(), json!([]));
    Ok(out)
}

/// `data.get(key)` when it is true, as text.
fn given<'a>(data: &'a Map<String, Value>, key: &str) -> Option<&'a str> {
    data.get(key).filter(|v| pyjson::truthy(v)).and_then(Value::as_str)
}

/// Change what a chat is about, include a page for it, or pick who answers.
pub async fn update_chat(
    session: &Session,
    chat_id: &str,
    by: &str,
    data: &Map<String, Value>,
) -> Result<ai_chat::Model, Error> {
    let chat = chat_of(session, chat_id, by).await?;
    let mut row = kb_db::edit(chat.clone());
    let thing = given(data, "ticket_id").or_else(|| given(data, "doc_id"));
    if given(data, "scope").is_some_and(|scope| scope != chat.scope) || thing.is_some() {
        let scope = given(data, "scope").unwrap_or(chat.scope.as_str());
        if !SCOPES.contains(&scope) {
            return Err(AssistError::new("invalid", "Unknown scope.").into());
        }
        let scope_id = thing;
        if matches!(scope, "ticket" | "doc" | "idea") {
            let (_pid, title) = target(session, scope, scope_id).await?;
            let mut note = ai_chat_message::new();
            note.chat_id = Set(chat.id.clone());
            note.role = Set("note".to_string());
            note.text = Set(format!("Now about {title}"));
            note.state = Set("done".to_string());
            note.finished_at = Set(Some(now_iso()));
            note.insert(session).await?;
        }
        row.scope = Set(scope.to_string());
        row.scope_id = Set(scope_id.map(str::to_string));
        row.ticket_id = Set(scope_id.filter(|_| scope == "ticket").map(str::to_string));
        row.doc_id = Set(scope_id.filter(|_| scope == "doc").map(str::to_string));
    }
    if let Some(page) = given(data, "include_doc") {
        // `sorted({*loads(chat.include_docs, []), data["include_doc"]})`
        let mut pages: Vec<String> = match loads(Some(&chat.include_docs), json!([])) {
            Value::Array(items) => items.iter().filter_map(Value::as_str).map(str::to_string).collect(),
            _ => Vec::new(),
        };
        pages.push(page.to_string());
        pages.sort();
        pages.dedup();
        row.include_docs = Set(pyjson::dumps(&pages));
    }
    if let Some(member_id) = data.get("member_id") {
        row.member_id = Set(member_id.as_str().map(str::to_string));
    }
    row.updated_at = Set(now_iso());
    let chat = row.update(session).await?;
    session.commit().await?;
    Ok(chat)
}

/// The owner has this chat open and in front of them now (the page tells every ~15 s).
pub async fn mark_seen(session: &Session, chat_id: &str, by: &str) -> Result<(), Error> {
    let chat = chat_of(session, chat_id, by).await?;
    let mut row = kb_db::edit(chat);
    row.seen_at = Set(Some(now_iso()));
    row.update(session).await?;
    session.commit().await?;
    Ok(())
}

/// Delete a chat, its messages and its conversation.
pub async fn delete_chat(session: &Session, chat_id: &str, by: &str) -> Result<(), Error> {
    let chat = chat_of(session, chat_id, by).await?;
    let rows = ai_chat_message::Entity::find()
        .filter(ai_chat_message::Column::ChatId.eq(chat.id.as_str()))
        .all(session)
        .await?;
    for m in rows {
        cancel_task(&m.id);
        m.delete(session).await?;
    }
    chat.delete(session).await?;
    session.commit().await?;
    sessions::forget(&sessions::chat_name(chat_id)).await?;
    Ok(())
}
