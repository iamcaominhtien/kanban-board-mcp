//! Per-project Docs AI settings and who answers (Settings > Docs > AI; design/screens/docs-ai-care.md, F, G)
//! (`services/docs_ai/settings.py`, lines 1 to 218).
//!
//! Docs AI is off for a new project until an admin turns it on (`enabled`, AI-1): `services.projects.create_project`
//! writes the row. A project made before that change keeps its stored value; one that never stored a row was "on" and
//! is given `enabled=True` here on first use, so nothing changes for it. The board-wide "Docs AI" feature switch
//! (Settings > AI > Features) stays the master switch: when it is off, Docs AI is off everywhere.

use kb_ai::store::now_iso;
use kb_base::pyjson;
use kb_db::Session;
use kb_db::database;
use kb_db::entities::{ai_team, docs_ai_settings, docs_page, member, project};
use kb_db::sea_orm::ActiveValue::Set;
use kb_db::sea_orm::{ActiveModelTrait, ColumnTrait, EntityTrait, IntoActiveModel, PaginatorTrait, QueryFilter};
use serde_json::{Map, Value, json};

use super::errors::{DocsAiError, Error};
use crate::assistant::errors::Error as AssistFailure;
use crate::assistant::settings as assist_settings;

/// The project's Docs AI settings. A project without a row predates AI-1 (new projects get one when they are made,
/// switched off), so its row is created on first use with Docs AI on, as it always was.
pub async fn get(session: &Session, project_id: &str) -> Result<docs_ai_settings::Model, Error> {
    if let Some(row) = docs_ai_settings::Entity::find_by_id(project_id).one(session).await? {
        return Ok(row);
    }
    // two runs that start together both get here: the second insert does nothing
    let mut new = docs_ai_settings::new();
    new.project_id = Set(project_id.to_string());
    new.enabled = Set(true);
    database::insert_missing(session, new).await?;
    session.commit().await?;
    docs_ai_settings::Entity::find_by_id(project_id)
        .one(session)
        .await?
        .ok_or_else(|| Error::Other(format!("docs_ai_settings {project_id} is missing")))
}

/// `_project`: the project, or `not_found`.
async fn project_of(session: &Session, project_id: &str) -> Result<project::Model, Error> {
    match project::Entity::find_by_id(project_id).one(session).await? {
        Some(project) => Ok(project),
        None => Err(DocsAiError::new("not_found", "Project not found.").into()),
    }
}

/// The board-wide Docs AI feature switch.
pub async fn master_on(_session: &Session) -> Result<bool, Error> {
    Ok(true)
}

/// Docs AI is on for the project, or `docs_ai_off` (nothing in Docs shows AI then).
pub async fn require_enabled(session: &Session, project_id: &str) -> Result<docs_ai_settings::Model, Error> {
    project_of(session, project_id).await?;
    let row = get(session, project_id).await?;
    if !row.enabled || !master_on(session).await? {
        return Err(DocsAiError::new(
            "docs_ai_off",
            "Docs AI is off for this project. An admin can turn it on in Settings › Docs.",
        )
        .into());
    }
    Ok(row)
}

/// `_can_answer` (also exported as `can_answer`): whether the team could answer through `llm.complete`.
pub fn can_answer(profile: Option<&ai_team::Model>) -> bool {
    let Some(profile) = profile else { return false };
    if profile.paused {
        return false;
    }
    if profile.connection == "local" {
        return profile.provider == "claude-code";
    }
    profile.connection == "api_key"
}

/// The AI team that answers and checks: the one chosen in Settings (`member_id`), else the project's first unpaused
/// team, the same one the assistant engine runs the call with. Raises `paused` when the chosen team is paused and
/// `no_member` when the project has none.
pub async fn answering_member(session: &Session, project_id: &str) -> Result<(member::Model, ai_team::Model), Error> {
    match assist_settings::answering_team(session, project_id, "docs").await {
        Ok(Some(found)) => Ok(found),
        Ok(None) => Err(DocsAiError::new(
            "no_member",
            "No AI team can read this space. Pick one in Settings › Docs, or add one in Members.",
        )
        .into()),
        Err(AssistFailure::Assist(exc)) => Err(DocsAiError::new("paused", exc.message).into()),
        Err(other) => Err(other.into()),
    }
}

/// AI teams of the project that could answer, for the picker in Settings. The team chosen there stays in the list
/// when it is paused (marked `paused`), so the picker shows which one it is.
pub async fn candidates(session: &Session, project_id: &str) -> Result<Vec<Value>, Error> {
    let chosen = get(session, project_id).await?.member_id;
    let members = member::Entity::find()
        .filter(member::Column::ProjectId.eq(project_id))
        .filter(member::Column::Kind.eq("ai"))
        .all(session)
        .await?;
    let mut out = Vec::new();
    for m in members {
        let profile = ai_team::Entity::find_by_id(m.id.as_str()).one(session).await?;
        let paused_choice = profile.as_ref().is_some_and(|p| p.paused) && chosen.as_deref() == Some(m.id.as_str());
        if can_answer(profile.as_ref()) || paused_choice {
            // `can_answer` and `paused_choice` both need a profile
            let Some(profile) = profile else { continue };
            out.push(json!({
                "id": m.id,
                "name": m.name,
                "provider": profile.provider,
                "connection": profile.connection,
                "model": profile.model,
                "paused": profile.paused,
            }));
        }
    }
    Ok(out)
}

/// Everything the UI needs: the switches, who answers, and the state the Docs UI should show.
///
/// `state` is `off`, `ready` or `no_member`. `master` is the board-wide switch.
pub async fn describe(session: &Session, project_id: &str) -> Result<Map<String, Value>, Error> {
    project_of(session, project_id).await?;
    let row = get(session, project_id).await?;
    let master = master_on(session).await?;
    let mut member = Value::Null;
    let mut problem = Value::Null;
    let has_member = match answering_member(session, project_id).await {
        Ok((m, profile)) => {
            member = json!({
                "id": m.id,
                "name": m.name,
                "provider": profile.provider,
                "model": profile.model,
                "metered": profile.connection == "api_key",
            });
            true
        }
        Err(Error::DocsAi(exc)) => {
            problem = json!({"code": exc.code, "message": exc.message});
            false
        }
        Err(other) => return Err(other),
    };
    let state = if !(row.enabled && master) {
        "off"
    } else if has_member {
        "ready"
    } else {
        "no_member"
    };
    let mut out = Map::new();
    out.insert("enabled".into(), json!(row.enabled));
    out.insert("master".into(), json!(master));
    out.insert("state".into(), json!(state));
    out.insert("member_id".into(), json!(row.member_id));
    out.insert("member".into(), member);
    // why nobody can answer (`paused`: the team chosen in Settings is paused; `no_member`), or None
    out.insert("problem".into(), problem);
    out.insert("candidates".into(), Value::Array(candidates(session, project_id).await?));
    out.insert("style_page_id".into(), json!(row.style_page_id));
    out.insert("freshness_on".into(), json!(row.freshness_on));
    out.insert("digest_on".into(), json!(row.digest_on));
    Ok(out)
}

/// `str(value)` of a truthy id.
fn id_text(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        other => pyjson::py_str(other),
    }
}

/// Change the settings (validated).
pub async fn update(
    session: &Session,
    project_id: &str,
    data: &Map<String, Value>,
    by: &str,
) -> Result<docs_ai_settings::Model, Error> {
    project_of(session, project_id).await?;
    let row = get(session, project_id).await?;
    let mut changed = row.into_active_model();
    if let Some(enabled) = data.get("enabled").filter(|v| !v.is_null()) {
        changed.enabled = Set(pyjson::truthy(enabled));
    }
    if let Some(mid) = data.get("member_id") {
        let chosen = pyjson::truthy(mid).then(|| id_text(mid));
        if let Some(mid) = &chosen {
            let profile = ai_team::Entity::find_by_id(mid.as_str()).one(session).await?;
            let member = member::Entity::find_by_id(mid.as_str()).one(session).await?;
            let member = match (member, &profile) {
                (Some(member), Some(_)) if member.project_id == project_id => member,
                _ => return Err(DocsAiError::new("invalid", "Pick an AI team of this project.").into()),
            };
            if !can_answer(profile.as_ref()) {
                return Err(DocsAiError::new(
                    "invalid",
                    format!("{} cannot answer here: it needs Claude Code or an API key.", member.name),
                )
                .into());
            }
        }
        changed.member_id = Set(chosen);
    }
    if let Some(pid) = data.get("style_page_id") {
        let chosen = pyjson::truthy(pid).then(|| id_text(pid));
        if let Some(pid) = &chosen {
            let page = docs_page::Entity::find_by_id(pid.as_str()).one(session).await?;
            if page.is_none_or(|page| page.project_id != project_id) {
                return Err(DocsAiError::new("invalid", "The style guide page is not in this space.").into());
            }
        }
        changed.style_page_id = Set(chosen);
    }
    if let Some(value) = data.get("freshness_on").filter(|v| !v.is_null()) {
        changed.freshness_on = Set(pyjson::truthy(value));
    }
    if let Some(value) = data.get("digest_on").filter(|v| !v.is_null()) {
        changed.digest_on = Set(pyjson::truthy(value));
    }
    changed.updated_by = Set(Some(by.to_string()));
    changed.updated_at = Set(now_iso());
    let row = changed.update(session).await?;
    session.commit().await?;
    Ok(row)
}

/// Live pages of the project.
pub async fn count_pages(session: &Session, project_id: &str) -> Result<i64, Error> {
    let count = docs_page::Entity::find()
        .filter(docs_page::Column::ProjectId.eq(project_id))
        .filter(docs_page::Column::DeletedAt.is_null())
        .count(session)
        .await?;
    Ok(i64::try_from(count).unwrap_or(i64::MAX))
}
