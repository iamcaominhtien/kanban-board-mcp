//! Who may read and edit a project's Docs space.
//!
//! Identity comes from the request actor (`X-Actor`): the board's own user is an admin, the AI agent a
//! member, and anyone else is looked up by name among the project's members. A name that is not a
//! member has no access to Docs at all; it can only ask an admin for access.

use std::sync::OnceLock;

use chrono::{Duration, Utc};
use kb_base::{activity, pyjson, time};
use kb_db::Session;
use kb_db::entities::{docs_comment_event, member, project};
use kb_db::sea_orm::ActiveValue::Set;
use kb_db::sea_orm::{ActiveModelTrait, ColumnTrait, DbErr, EntityTrait, QueryFilter};
use serde_json::{Map, Value, json};

use crate::docs_text::{DocsError, DocsResult};

pub const ROLES: [&str; 3] = ["viewer", "member", "admin"];
pub const EDIT_POLICIES: [&str; 3] = ["everyone", "members", "admins"];
pub const MAX_NOTE: usize = 300;

/// The notification centre (`services/notifications.py`), which is not below this crate while it is being ported:
/// `kb-notify` registers itself here at startup. Nothing is called while no hook is set.
pub trait NotificationsHook: Send + Sync {
    /// `notifications.comment_event(event)`: called where a Docs comment event was added and committed.
    fn comment_event(&self, event: &docs_comment_event::Model);
}

static NOTIFICATIONS_HOOK: OnceLock<Box<dyn NotificationsHook>> = OnceLock::new();

/// Register the notification centre (once, at startup; a second call is ignored).
pub fn set_notifications_hook(hook: Box<dyn NotificationsHook>) {
    let _ = NOTIFICATIONS_HOOK.set(hook);
}

/// Return the project's members.
pub async fn members_of(session: &Session, project_id: &str) -> Result<Vec<member::Model>, DbErr> {
    member::Entity::find().filter(member::Column::ProjectId.eq(project_id)).all(session).await
}

/// `str.casefold()`.
fn casefold(text: &str) -> String {
    caseless::default_case_fold_str(text)
}

fn _member<'a>(members: &'a [member::Model], actor: &str) -> Option<&'a member::Model> {
    let actor = casefold(actor);
    members.iter().find(|m| casefold(&m.name) == actor)
}

/// Return the Docs role of an actor.
///
/// The board's own user (`user`) is an admin and the AI agent (`agent`) a member. Anyone else is
/// looked up by name among the project's members; a name that is not a member can only read.
pub fn role_in(members: &[member::Model], actor: &str) -> String {
    if actor == activity::HUMAN_ACTOR {
        return "admin".to_string();
    }
    if actor == activity::AGENT_ACTOR {
        return "member".to_string();
    }
    if let Some(m) = _member(members, actor) {
        return if ROLES.contains(&m.role.as_str()) { m.role.clone() } else { "member".to_string() };
    }
    "viewer".to_string()
}

/// True when the actor belongs to the project (the board's user, the agent or a member).
pub fn has_access(members: &[member::Model], actor: &str) -> bool {
    actor == activity::HUMAN_ACTOR || actor == activity::AGENT_ACTOR || _member(members, actor).is_some()
}

/// Whether a role may edit pages under the project's edit policy.
pub fn can_edit(role: &str, policy: &str) -> bool {
    if policy == "everyone" {
        return true;
    }
    if policy == "admins" {
        return role == "admin";
    }
    role == "member" || role == "admin"
}

/// `project.docs_edit_policy or "members"`.
fn policy_of(project: &project::Model) -> &str {
    if project.docs_edit_policy.is_empty() { "members" } else { &project.docs_edit_policy }
}

/// The names of the members whose role is admin, in the order the database gave them.
fn admins_of(members: &[member::Model]) -> Vec<String> {
    members.iter().filter(|m| m.role == "admin").map(|m| m.name.clone()).collect()
}

/// Describe what the current actor may do in a project's Docs space.
///
/// Returns `{access, role, can_edit, policy, me, admins}`; `admins` names who gets an access request.
pub async fn access_of(session: &Session, project: &project::Model) -> Result<Map<String, Value>, DbErr> {
    let members = members_of(session, &project.id).await?;
    let actor = activity::current_actor();
    let role = role_in(&members, &actor);
    let access = has_access(&members, &actor);
    let policy = policy_of(project);
    let mut out = Map::new();
    out.insert("access".into(), json!(access));
    out.insert("role".into(), if access { json!(role) } else { Value::Null });
    out.insert("can_edit".into(), json!(access && can_edit(&role, policy)));
    out.insert("policy".into(), json!(policy));
    out.insert("me".into(), json!(actor));
    out.insert("admins".into(), json!(admins_of(&members)));
    Ok(out)
}

/// Raise 403 `docs_no_access` when the actor is not part of the project.
pub async fn require_reader(session: &Session, project: &project::Model) -> DocsResult<()> {
    let actor = activity::current_actor();
    if actor == activity::HUMAN_ACTOR || actor == activity::AGENT_ACTOR {
        return Ok(());
    }
    if !has_access(&members_of(session, &project.id).await?, &actor) {
        return Err(DocsError::new(
            403,
            "docs_no_access",
            format!("Docs in {} is limited to project members.", project.name),
        )
        .into());
    }
    Ok(())
}

/// Raise 403 `read_only` when the project's edit policy does not let the actor edit pages.
pub async fn require_editor(session: &Session, project: &project::Model) -> DocsResult<()> {
    let actor = activity::current_actor();
    if actor == activity::HUMAN_ACTOR {
        return Ok(());
    }
    let members = members_of(session, &project.id).await?;
    if !has_access(&members, &actor) {
        return Err(DocsError::new(
            403,
            "docs_no_access",
            format!("Docs in {} is limited to project members.", project.name),
        )
        .into());
    }
    let policy = policy_of(project);
    if !can_edit(&role_in(&members, &actor), policy) {
        let who = if policy == "admins" { "project admins" } else { "project members" };
        return Err(DocsError::new(
            403,
            "read_only",
            format!("Only {who} can edit pages in this space. You can still read published pages."),
        )
        .into());
    }
    Ok(())
}

/// `" ".join(note.split())[:MAX_NOTE]`: runs of whitespace become one space, cut by characters.
fn clean_note(note: &str) -> String {
    let joined = note
        .split(|c: char| c.is_whitespace() || ('\u{1c}'..='\u{1f}').contains(&c))
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join(" ");
    joined.chars().take(MAX_NOTE).collect()
}

/// Ask the project's admins for access to Docs.
///
/// The request is an Activity entry (`access_request`) that notifies every admin and the board's
/// own user. A second request from the same person within ten minutes is not sent again.
///
/// `note` is an optional note to the admins. Returns `{sent, admins}`; `sent` is false when the actor already has
/// access or just asked.
pub async fn request_access(
    session: &Session,
    project: &project::Model,
    note: &str,
) -> Result<Map<String, Value>, DbErr> {
    let members = members_of(session, &project.id).await?;
    let actor = activity::current_actor();
    let admins = admins_of(&members);
    let reply = |sent: bool| {
        let mut out = Map::new();
        out.insert("sent".into(), json!(sent));
        out.insert("admins".into(), json!(admins));
        out
    };
    if has_access(&members, &actor) {
        return Ok(reply(false));
    }
    let since = time::iso(&(Utc::now() - Duration::minutes(10)));
    let recent = docs_comment_event::Entity::find()
        .filter(docs_comment_event::Column::ProjectId.eq(project.id.as_str()))
        .filter(docs_comment_event::Column::Kind.eq("access_request"))
        .filter(docs_comment_event::Column::Actor.eq(actor.as_str()))
        .filter(docs_comment_event::Column::CreatedAt.gte(since))
        .one(session)
        .await?;
    if recent.is_some() {
        return Ok(reply(false));
    }
    let mut recipients = vec![activity::HUMAN_ACTOR.to_string()];
    recipients.extend(admins.iter().cloned());
    let mut event = docs_comment_event::new();
    event.project_id = Set(project.id.clone());
    event.page_id = Set(None);
    event.kind = Set("access_request".to_string());
    event.actor = Set(actor);
    event.recipients = Set(pyjson::dumps(&recipients));
    event.snippet = Set(clean_note(note));
    let event = event.insert(session).await?;
    session.commit().await?;
    if let Some(centre) = NOTIFICATIONS_HOOK.get() {
        centre.comment_event(&event);
    }
    Ok(reply(true))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn member(name: &str, role: &str) -> member::Model {
        member::Model {
            id: name.to_lowercase(),
            project_id: "p".into(),
            name: name.into(),
            color: "#000000".into(),
            role: role.into(),
            kind: "human".into(),
            created_at: "2026-01-01T00:00:00+00:00".into(),
        }
    }

    #[test]
    fn roles_come_from_the_actor_and_the_member_list() {
        let members =
            [member("Ada", "admin"), member("Vy", "viewer"), member("Odd", "owner"), member("Straße", "member")];
        assert_eq!(role_in(&members, "user"), "admin");
        assert_eq!(role_in(&members, "agent"), "member");
        assert_eq!(role_in(&members, "ADA"), "admin");
        assert_eq!(role_in(&members, "vy"), "viewer");
        // a stored role that is not one of ROLES counts as member
        assert_eq!(role_in(&members, "Odd"), "member");
        // casefold, not lowercase: "ß" and "ss" are the same name
        assert_eq!(role_in(&members, "STRASSE"), "member");
        assert_eq!(role_in(&members, "Nobody"), "viewer");
        assert!(has_access(&members, "user") && has_access(&members, "agent") && has_access(&members, "ada"));
        assert!(!has_access(&members, "Nobody"));
    }

    #[test]
    fn the_edit_policy_decides_who_edits() {
        for role in ROLES {
            assert!(can_edit(role, "everyone"));
            assert_eq!(can_edit(role, "admins"), role == "admin");
            assert_eq!(can_edit(role, "members"), role != "viewer");
            // an unknown policy reads as "members"
            assert_eq!(can_edit(role, ""), role != "viewer");
        }
    }

    #[test]
    fn a_note_is_one_line_and_at_most_300_characters() {
        assert_eq!(clean_note("  please\n let  me\tin \u{1f} "), "please let me in");
        assert_eq!(clean_note(&"é".repeat(400)).chars().count(), MAX_NOTE);
    }
}
