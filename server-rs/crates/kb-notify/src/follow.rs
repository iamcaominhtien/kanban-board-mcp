//! Part of `services/notifications.py`: lines 534 to 714, "Follow and mute".

use chrono::{DateTime, Duration, Utc};
use kb_db::Session;
use kb_db::entities::{docs_page, notify_follow, project};
use kb_db::sea_orm::{ActiveModelTrait, ActiveValue, ColumnTrait, EntityTrait, QueryFilter};
use serde_json::{Value, json};

use crate::delivery::{announce, head_id};
use crate::error::{NotifyError, Result};
use crate::helpers::{iso, parse, utcnow};
use crate::kinds::{KINDS, kind_info};
use crate::writing::is_needs_kind;

fn active(f: &notify_follow::Model, now: DateTime<Utc>) -> bool {
    match parse(f.until.as_deref()) {
        None => true,
        Some(until) => until > now,
    }
}

/// The recipient's follows and mutes that have not run out.
pub async fn follows_of(session: &Session, recipient: &str) -> Result<Vec<notify_follow::Model>> {
    let rows = notify_follow::Entity::find().filter(notify_follow::Column::Recipient.eq(recipient)).all(session).await?;
    let now = utcnow();
    Ok(rows.into_iter().filter(|f| active(f, now)).collect())
}

/// Whether a mute makes this row quiet. Never for a Needs you row (it is addressed to the recipient).
pub fn quiet_by_follows(
    follows: &[notify_follow::Model],
    kind: &str,
    project_id: Option<&str>,
    ticket_id: Option<&str>,
    page_id: Option<&str>,
) -> bool {
    if is_needs_kind(kind) {
        return false;
    }
    follows
        .iter()
        .any(|f| (f.level == "mute" || f.level == "mentions") && mutes(f, kind, project_id, ticket_id, page_id))
}

/// Whether one mute (of a kind, a project, a ticket or a page) covers this row.
pub fn mutes(
    f: &notify_follow::Model,
    kind: &str,
    project_id: Option<&str>,
    ticket_id: Option<&str>,
    page_id: Option<&str>,
) -> bool {
    match f.scope.as_str() {
        "kind" => f.scope_id == kind && (f.project_id.is_none() || f.project_id.as_deref() == project_id),
        "project" => Some(f.scope_id.as_str()) == project_id,
        "ticket" => ticket_id.is_some_and(|t| !t.is_empty()) && Some(f.scope_id.as_str()) == ticket_id,
        "page" => page_id.is_some_and(|p| !p.is_empty()) && Some(f.scope_id.as_str()) == page_id,
        _ => false,
    }
}

/// What the recipient muted, for the Muted list in Settings.
pub async fn muted_list(session: &Session, recipient: &str) -> Result<Vec<Value>> {
    let rows = follows_of(session, recipient).await?;
    Ok(rows.iter().filter(|f| f.level == "mute" || f.level == "mentions").map(follow_to_dict).collect())
}

/// A follow or mute for the API.
pub fn follow_to_dict(f: &notify_follow::Model) -> Value {
    json!({
        "id": f.id,
        "scope": f.scope,
        "scope_id": f.scope_id,
        "project_id": f.project_id,
        "level": f.level,
        "until": f.until,
        "label": f.label,
        "created_at": f.created_at,
    })
}

/// What the bell on a ticket, page or space shows: following, everything, mentions only, muted, or nothing.
pub async fn follow_state(session: &Session, recipient: &str, scope: &str, scope_id: &str) -> Result<Value> {
    let rows: Vec<_> =
        follows_of(session, recipient).await?.into_iter().filter(|f| f.scope == scope && f.scope_id == scope_id).collect();
    let f = rows.first();
    Ok(json!({
        "scope": scope,
        "scope_id": scope_id,
        "level": f.map(|f| f.level.clone()),
        "until": f.and_then(|f| f.until.clone()),
        "id": f.map(|f| f.id.clone()),
    }))
}

/// Follow, mute or forget a ticket, page, Docs space, project or kind (level `None` forgets it).
pub async fn set_follow(
    session: &Session,
    recipient: &str,
    scope: &str,
    scope_id: &str,
    level: Option<&str>,
    project_id: Option<&str>,
    minutes: Option<i64>,
    label: &str,
) -> Result<Value> {
    if !["ticket", "page", "space", "project", "kind"].contains(&scope) {
        return Err(NotifyError::value("scope must be ticket, page, space, project or kind"));
    }
    if let Some(level) = level {
        if !["follow", "everything", "mentions", "mute"].contains(&level) {
            return Err(NotifyError::value("level must be follow, everything, mentions or mute"));
        }
    }
    if scope == "kind" && !KINDS.iter().any(|k| k.name == scope_id) {
        return Err(NotifyError::value(format!("Unknown kind: {scope_id}")));
    }
    let mut stmt = notify_follow::Entity::find()
        .filter(notify_follow::Column::Recipient.eq(recipient))
        .filter(notify_follow::Column::Scope.eq(scope))
        .filter(notify_follow::Column::ScopeId.eq(scope_id));
    if scope == "kind" {
        stmt = match project_id.filter(|p| !p.is_empty()) {
            Some(p) => stmt.filter(notify_follow::Column::ProjectId.eq(p)),
            None => stmt.filter(notify_follow::Column::ProjectId.is_null()),
        };
    }
    for row in stmt.all(session).await? {
        notify_follow::Entity::delete_by_id(row.id).exec(session).await?;
    }
    if let Some(level) = level {
        let until = match minutes.filter(|m| *m != 0) {
            Some(m) => {
                let when = Duration::try_minutes(m)
                    .and_then(|d| utcnow().checked_add_signed(d))
                    .ok_or_else(|| NotifyError::Internal("date value out of range".into()))?;
                Some(iso(&when))
            }
            None => None,
        };
        let label = if label.is_empty() { follow_label(session, scope, scope_id, project_id).await? } else { label.to_string() };
        let mut row = notify_follow::new();
        row.recipient = ActiveValue::Set(recipient.to_string());
        row.scope = ActiveValue::Set(scope.to_string());
        row.scope_id = ActiveValue::Set(scope_id.to_string());
        row.project_id = ActiveValue::Set(project_id.map(str::to_string));
        row.level = ActiveValue::Set(level.to_string());
        row.until = ActiveValue::Set(until);
        row.label = ActiveValue::Set(label);
        row.insert(session).await?;
    }
    session.commit().await?;
    announce(Some(head_id(session).await?)).await;
    follow_state(session, recipient, scope, scope_id).await
}

/// What the Muted list shows for a follow that was given no label.
pub async fn follow_label(session: &Session, scope: &str, scope_id: &str, project_id: Option<&str>) -> Result<String> {
    if scope == "ticket" {
        return Ok(scope_id.to_string());
    }
    if scope == "page" {
        let page = docs_page::Entity::find_by_id(scope_id).one(session).await?;
        return Ok(page.map(|p| p.title).unwrap_or_else(|| "A Docs page".to_string()));
    }
    if scope == "project" || scope == "space" {
        let p = project::Entity::find_by_id(scope_id).one(session).await?;
        let name = p.map(|p| p.name).unwrap_or_else(|| "A project".to_string());
        return Ok(if scope == "space" { format!("{name} · Docs space") } else { name });
    }
    let label = kind_info(scope_id).map(|k| k.label).unwrap_or("");
    if let Some(project_id) = project_id.filter(|p| !p.is_empty()) {
        if let Some(p) = project::Entity::find_by_id(project_id).one(session).await? {
            return Ok(format!("{label}, in {}", p.name));
        }
    }
    Ok(label.to_string())
}

/// Remove one follow or mute of the recipient.
pub async fn unmute(session: &Session, recipient: &str, follow_id: &str) -> Result<()> {
    let row = notify_follow::Entity::find_by_id(follow_id).one(session).await?;
    let Some(row) = row.filter(|r| r.recipient == recipient) else {
        return Err(NotifyError::lookup("Not found"));
    };
    notify_follow::Entity::delete_by_id(row.id).exec(session).await?;
    session.commit().await?;
    announce(Some(head_id(session).await?)).await;
    Ok(())
}
