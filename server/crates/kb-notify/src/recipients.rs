//! Part of `services/notifications.py`: lines 225 to 321, "Who gets it".

use std::collections::{HashMap, HashSet};

use kb_db::Session;
use kb_db::entities::{member, notify_follow};
use kb_db::sea_orm::{ColumnTrait, EntityTrait, QueryFilter};

use crate::error::Result;
use crate::helpers::{ai_key, person_key};

/// name (lower case) -> member id of the AI members of a project.
pub async fn ai_names(session: &Session, project_id: Option<&str>) -> Result<HashMap<String, String>> {
    let Some(project_id) = project_id.filter(|p| !p.is_empty()) else {
        return Ok(HashMap::new());
    };
    let rows = member::Entity::find()
        .filter(member::Column::ProjectId.eq(project_id))
        .filter(member::Column::Kind.eq("ai"))
        .all(session)
        .await?;
    Ok(rows.into_iter().map(|m| (m.name.trim().to_lowercase(), m.id)).collect())
}

/// Recipient keys for names: an AI member's name becomes "ai:<id>", anyone else is a person.
pub async fn recipient_keys(
    session: &Session,
    project_id: Option<&str>,
    names: &[Option<&str>],
) -> Result<Vec<String>> {
    let ais = ai_names(session, project_id).await?;
    let mut out: Vec<String> = Vec::new();
    for n in names {
        let Some(n) = n else { continue };
        let raw = n.trim();
        let key = if raw.starts_with("ai:") {
            raw.to_string()
        } else if let Some(id) = ais.get(&raw.to_lowercase()) {
            ai_key(id)
        } else {
            person_key(Some(raw))
        };
        if !out.contains(&key) {
            out.push(key);
        }
    }
    Ok(out)
}

/// The board's own user, and the people who are owners or admins of the project (decision 2 on #253: they are
/// recipients of every AI safety event, as they saw every one before).
pub async fn owners_and_admins(session: &Session, project_id: Option<&str>) -> Result<Vec<String>> {
    let mut out = vec!["user".to_string()];
    let Some(project_id) = project_id.filter(|p| !p.is_empty()) else {
        return Ok(out);
    };
    let rows = member::Entity::find()
        .filter(member::Column::ProjectId.eq(project_id))
        .filter(member::Column::Kind.eq("human"))
        .all(session)
        .await?;
    for m in rows {
        if m.role == "admin" || m.role == "owner" {
            let k = person_key(Some(&m.name));
            if !out.contains(&k) {
                out.push(k);
            }
        }
    }
    Ok(out)
}

/// The projects this person is an owner or admin of; `None` means every project (the board's own user).
pub async fn managed_projects(session: &Session, me: &str) -> Result<Option<HashSet<String>>> {
    if me == "user" {
        return Ok(None);
    }
    let rows = member::Entity::find()
        .filter(member::Column::Kind.eq("human"))
        .filter(member::Column::Role.is_in(["admin", "owner"]))
        .all(session)
        .await?;
    Ok(Some(rows.into_iter().filter(|m| person_key(Some(&m.name)) == me).map(|m| m.project_id).collect()))
}

/// Whether a person may change the app-wide notification settings: the board's own user, or an owner or admin of a
/// project (as for every AI safety event, `owners_and_admins`).
pub async fn may_manage(session: &Session, me: &str) -> Result<bool> {
    let managed = managed_projects(session, me).await?;
    Ok(managed.is_none_or(|m| !m.is_empty()))
}

/// Recipients who follow a ticket, page or Docs space (not muted).
pub async fn followers(session: &Session, scope: &str, scope_id: Option<&str>) -> Result<Vec<String>> {
    let Some(scope_id) = scope_id.filter(|s| !s.is_empty()) else {
        return Ok(Vec::new());
    };
    let rows = notify_follow::Entity::find()
        .filter(notify_follow::Column::Scope.eq(scope))
        .filter(notify_follow::Column::ScopeId.eq(scope_id))
        .filter(notify_follow::Column::Level.is_in(["follow", "everything"]))
        .all(session)
        .await?;
    Ok(rows.into_iter().map(|r| r.recipient).collect())
}
