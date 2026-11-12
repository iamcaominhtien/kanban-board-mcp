//! The comments of a ticket as the AI member behind the current MCP call may read them.
//!
//! `get_ticket` serves people (their own MCP clients) and AI runs alike. For a call that carries an AI run's token the
//! comments get the same treatment the run's prompt gives them (`context::comments_for_reader`): secrets redacted, text
//! by other AIs and outsiders fenced as data, outsiders' comments held back unless the member reads external sources.

use std::collections::HashSet;

use kb_db::Session;
use kb_db::entities::member;
use kb_db::sea_orm::{ColumnTrait, EntityTrait, QueryFilter};
use serde_json::{Map, Value, json};

use crate::context::comments_for_reader;
use crate::guard;
use crate::store::{ai_names, get_profile};

/// `{"comments": [...], "held_back": n}` for an AI caller; None when the caller is not an AI run.
pub async fn for_caller(
    session: &Session,
    project_id: &str,
    raw: &[Value],
) -> Result<Option<Map<String, Value>>, guard::Error> {
    let Some(context) = guard::resolve().await? else { return Ok(None) };
    let _ = get_profile(session, &context.member_id).await?;
    let humans: HashSet<String> = member::Entity::find()
        .filter(member::Column::ProjectId.eq(project_id))
        .filter(member::Column::Kind.eq("human"))
        .all(session)
        .await?
        .into_iter()
        .map(|m| m.name)
        .collect();
    let names = ai_names(session, project_id).await?;
    let (comments, held_back) = comments_for_reader(raw, &names, Some(&humans), false);
    let mut out = Map::new();
    out.insert("comments".into(), Value::Array(comments));
    out.insert("held_back".into(), json!(held_back));
    Ok(Some(out))
}

/// Only the comments with these ids and/or written after `since` (an ISO date or time).
pub fn pick(comments: Vec<Value>, ids: Option<&[String]>, since: Option<&str>) -> Vec<Value> {
    let mut comments = comments;
    if let Some(ids) = ids.filter(|i| !i.is_empty()) {
        comments.retain(|c| c.get("id").and_then(Value::as_str).is_some_and(|id| ids.iter().any(|w| w == id)));
    }
    if let Some(since) = since.filter(|s| !s.is_empty()) {
        comments.retain(|c| match c.get("at") {
            Some(Value::String(at)) => at.as_str() > since,
            // `(c.get("at") or "") > since` with a non-empty `since`: the empty text is never later
            _ => false,
        });
    }
    comments
}

/// A stored value as a list: a list as it is, JSON text of a list parsed, anything else empty.
pub fn loads_list(value: &Value) -> Vec<Value> {
    match value {
        Value::Array(items) => items.clone(),
        Value::String(text) => match serde_json::from_str::<Value>(if text.is_empty() { "[]" } else { text }) {
            Ok(Value::Array(items)) => items,
            _ => Vec::new(),
        },
        Value::Null => Vec::new(),
        _ => Vec::new(),
    }
}
