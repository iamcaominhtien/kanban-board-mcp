//! `services/idea_space.py`, lines 1034-1139: the research log of an idea: what was found, tried or decided.

use kb_base::{pyjson, pytext};
use kb_db::Session;
use kb_db::entities::idea_log_entry;
use kb_db::sea_orm::{ActiveModelTrait, ActiveValue::Set, ColumnTrait, EntityTrait, ModelTrait, QueryFilter};
use serde_json::Value;

use super::{CLOSED_STAGES, add_evidence, get_or_raise, neg, now, save};
use crate::error::{Error, rule_error, value_error};
use crate::idea_tickets::add_trail;
use crate::idea_tickets::find_assumption;
use crate::model::{Idea, LOG_KINDS, save_model};

/// `text[:n]` by characters.
fn head(text: &str, n: usize) -> String {
    text.chars().take(n).collect()
}

/// `session.get(IdeaLogEntry, entry_id)` of an entry of this idea, or `ValueError`.
async fn find(session: &Session, idea_id: &str, entry_id: &str) -> Result<idea_log_entry::Model, Error> {
    match idea_log_entry::Entity::find_by_id(entry_id).one(session).await? {
        Some(entry) if entry.idea_id == idea_id => Ok(entry),
        _ => value_error(format!("Log entry '{entry_id}' not found")),
    }
}

/// Add an entry to the research log (note, research, interview, experiment, finding or decision).
pub async fn add_log_entry(
    session: &Session,
    idea_id: &str,
    kind: &str,
    body: &str,
    author: Option<&str>,
    ai: bool,
    assumption_id: Option<&str>,
    attachments: &[Value],
    ticket_id: Option<&str>,
) -> Result<idea_log_entry::Model, Error> {
    if !LOG_KINDS.contains(&kind) {
        return value_error(format!("kind must be one of: {}", LOG_KINDS.join(", ")));
    }
    if pytext::strip(body).is_empty() {
        return value_error("body cannot be empty");
    }
    let mut idea = get_or_raise(session, idea_id).await?;
    if CLOSED_STAGES.contains(&idea.row.stage.as_str()) {
        return rule_error("idea_closed", "The idea is closed: reopen it to add to the log");
    }
    if let Some(assumption_id) = assumption_id.filter(|a| !a.is_empty()) {
        find_assumption(&idea, assumption_id)?;
    }
    let mut row = idea_log_entry::new();
    row.idea_id = Set(idea.row.id.clone());
    row.kind = Set(kind.to_string());
    row.body = Set(pytext::strip(body).to_string());
    row.author = Set(author.map(str::to_string));
    row.ai = Set(ai);
    row.assumption_id = Set(assumption_id.map(str::to_string));
    row.attachments = Set(pyjson::dumps(&attachments));
    row.ticket_id = Set(ticket_id.map(str::to_string));
    let created_at = now();
    row.created_at = Set(created_at.clone());
    let entry = row.insert(session).await?;
    let label = format!("Log entry ({kind}): {}", head(pytext::strip(body), 60));
    add_trail(&mut idea.row, &label, &created_at, author, Some("log"), None, ai);
    save(session, &mut idea).await?;
    Ok(entry)
}

/// The fields `update_log_entry` may change; None leaves a field as it is.
#[derive(Debug, Clone, Copy, Default)]
pub struct LogChanges<'a> {
    /// The new text.
    pub body: Option<&'a str>,
    /// Pin or unpin.
    pub pinned: Option<bool>,
    /// The new kind.
    pub kind: Option<&'a str>,
}

/// Edit a log entry's text or kind, or pin it.
pub async fn update_log_entry(
    session: &Session,
    idea_id: &str,
    entry_id: &str,
    changes: &LogChanges<'_>,
) -> Result<idea_log_entry::Model, Error> {
    let entry = find(session, idea_id, entry_id).await?;
    let mut changed = entry.clone();
    if let Some(body) = changes.body {
        if pytext::strip(body).is_empty() {
            return value_error("body cannot be empty");
        }
        changed.body = pytext::strip(body).to_string();
    }
    if let Some(kind) = changes.kind {
        if !LOG_KINDS.contains(&kind) {
            return value_error(format!("kind must be one of: {}", LOG_KINDS.join(", ")));
        }
        changed.kind = kind.to_string();
    }
    if let Some(pinned) = changes.pinned {
        changed.pinned = pinned;
    }
    let saved = save_model(session, &entry, changed).await?;
    session.commit().await?;
    Ok(saved)
}

/// Delete a log entry (it stays in Activity as "entry deleted").
pub async fn delete_log_entry(
    session: &Session,
    idea_id: &str,
    entry_id: &str,
    author: Option<&str>,
) -> Result<(), Error> {
    let entry = find(session, idea_id, entry_id).await?;
    let mut idea = get_or_raise(session, idea_id).await?;
    let label = format!("Log entry deleted ({})", entry.kind);
    entry.delete(session).await?;
    add_trail(&mut idea.row, &label, &now(), author, Some("log"), None, false);
    save(session, &mut idea).await?;
    Ok(())
}

/// The research log, pinned entries first, then newest first.
pub async fn list_log(session: &Session, idea_id: &str) -> Result<Vec<idea_log_entry::Model>, Error> {
    let mut rows =
        idea_log_entry::Entity::find().filter(idea_log_entry::Column::IdeaId.eq(idea_id)).all(session).await?;
    rows.sort_by(|a, b| (!a.pinned).cmp(&!b.pinned).then(neg(&a.created_at).cmp(&neg(&b.created_at))));
    Ok(rows)
}

/// "Use as evidence": a finding becomes a note of evidence for an assumption in one click.
pub async fn log_entry_as_evidence(
    session: &Session,
    idea_id: &str,
    entry_id: &str,
    assumption_id: &str,
    author: Option<&str>,
) -> Result<Idea, Error> {
    let entry = find(session, idea_id, entry_id).await?;
    let mut changed = entry.clone();
    changed.assumption_id = Some(assumption_id.to_string());
    save_model(session, &entry, changed).await?;
    add_evidence(
        session,
        idea_id,
        &[assumption_id.to_string()],
        "note",
        &format!("log:{}", entry.id),
        &head(&entry.body, 80),
        author,
    )
    .await
}
