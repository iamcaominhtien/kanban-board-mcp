//! `server/alembic/versions/a1b2c3d4e5f7_notifications.py`
//!
//! notifications: the event log, rows per recipient, follow and mute, prefs; the 09:00 AI safety digest goes

use sea_orm::ConnectionTrait;
use serde_json::{Map, Value, json};

use kb_base::{pyjson, pytext, time};

use super::ops::{self, StepResult};
use crate::database::DatabaseError;

/// `upgrade()` of revision `a1b2c3d4e5f7`.
pub(super) async fn upgrade<C: ConnectionTrait>(conn: &C) -> StepResult {
    ops::exec(
        conn,
        r"CREATE TABLE notify_event (
	id INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT, 
	project_id VARCHAR, 
	kind VARCHAR NOT NULL, 
	op VARCHAR DEFAULT 'new' NOT NULL, 
	needs BOOLEAN DEFAULT '0' NOT NULL, 
	target_kind VARCHAR, 
	target_id VARCHAR, 
	ticket_id VARCHAR, 
	page_id VARCHAR, 
	member_id VARCHAR, 
	actor VARCHAR, 
	title VARCHAR DEFAULT '' NOT NULL, 
	body VARCHAR DEFAULT '' NOT NULL, 
	data VARCHAR DEFAULT '{}' NOT NULL, 
	recipients VARCHAR DEFAULT '[]' NOT NULL, 
	created_at VARCHAR NOT NULL
)",
    )
    .await?;
    ops::exec(conn, r"CREATE INDEX ix_notify_event_project_id ON notify_event (project_id)").await?;
    ops::exec(conn, r"CREATE INDEX ix_notify_event_kind ON notify_event (kind)").await?;
    ops::exec(conn, r"CREATE INDEX ix_notify_event_target_id ON notify_event (target_id)").await?;
    ops::exec(conn, r"CREATE INDEX ix_notify_event_created_at ON notify_event (created_at)").await?;
    ops::exec(
        conn,
        r"CREATE TABLE notification (
	id VARCHAR NOT NULL, 
	recipient VARCHAR NOT NULL, 
	event_id INTEGER NOT NULL, 
	last_event_id INTEGER NOT NULL, 
	project_id VARCHAR, 
	kind VARCHAR NOT NULL, 
	needs BOOLEAN DEFAULT '0' NOT NULL, 
	group_key VARCHAR NOT NULL, 
	count INTEGER DEFAULT '1' NOT NULL, 
	items VARCHAR DEFAULT '[]' NOT NULL, 
	target_kind VARCHAR, 
	target_id VARCHAR, 
	ticket_id VARCHAR, 
	page_id VARCHAR, 
	member_id VARCHAR, 
	actor VARCHAR, 
	title VARCHAR DEFAULT '' NOT NULL, 
	body VARCHAR DEFAULT '' NOT NULL, 
	data VARCHAR DEFAULT '{}' NOT NULL, 
	inapp BOOLEAN DEFAULT '1' NOT NULL, 
	desktop BOOLEAN DEFAULT '0' NOT NULL, 
	read_at VARCHAR, 
	done_at VARCHAR, 
	done_reason VARCHAR, 
	done_by VARCHAR, 
	snoozed_until VARCHAR, 
	cleared_at VARCHAR, 
	created_at VARCHAR NOT NULL, 
	updated_at VARCHAR NOT NULL, 
	PRIMARY KEY (id)
)",
    )
    .await?;
    ops::exec(conn, r"CREATE INDEX ix_notification_recipient ON notification (recipient)").await?;
    ops::exec(conn, r"CREATE INDEX ix_notification_event_id ON notification (event_id)").await?;
    ops::exec(conn, r"CREATE INDEX ix_notification_last_event_id ON notification (last_event_id)").await?;
    ops::exec(conn, r"CREATE INDEX ix_notification_project_id ON notification (project_id)").await?;
    ops::exec(conn, r"CREATE INDEX ix_notification_kind ON notification (kind)").await?;
    ops::exec(conn, r"CREATE INDEX ix_notification_group_key ON notification (group_key)").await?;
    ops::exec(conn, r"CREATE INDEX ix_notification_target_id ON notification (target_id)").await?;
    ops::exec(conn, r"CREATE INDEX ix_notification_created_at ON notification (created_at)").await?;
    ops::exec(conn, r"CREATE INDEX ix_notification_updated_at ON notification (updated_at)").await?;
    ops::exec(conn, r"CREATE INDEX ix_notification_recipient_open ON notification (recipient, done_at)").await?;
    ops::exec(conn, r"CREATE INDEX ix_notification_open_needs ON notification (needs, done_at)").await?;
    ops::exec(
        conn,
        r"CREATE TABLE notify_follow (
	id VARCHAR NOT NULL, 
	recipient VARCHAR NOT NULL, 
	scope VARCHAR NOT NULL, 
	scope_id VARCHAR NOT NULL, 
	project_id VARCHAR, 
	level VARCHAR DEFAULT 'follow' NOT NULL, 
	until VARCHAR, 
	label VARCHAR DEFAULT '' NOT NULL, 
	created_at VARCHAR NOT NULL, 
	PRIMARY KEY (id)
)",
    )
    .await?;
    ops::exec(conn, r"CREATE INDEX ix_notify_follow_recipient ON notify_follow (recipient)").await?;
    ops::exec(conn, r"CREATE INDEX ix_notify_follow_scope_id ON notify_follow (scope_id)").await?;
    ops::exec(conn, r"CREATE INDEX ix_notify_follow_project_id ON notify_follow (project_id)").await?;
    ops::exec(
        conn,
        r"CREATE TABLE notify_prefs (
	recipient VARCHAR NOT NULL, 
	prefs VARCHAR DEFAULT '{}' NOT NULL, 
	updated_at VARCHAR NOT NULL, 
	PRIMARY KEY (recipient)
)",
    )
    .await?;
    move_docs_follows(conn).await?;
    carry_safety_desktop_prefs(conn).await?;
    // batch_alter_table: Alembic rebuilt the two tables without the columns; DROP COLUMN leaves the same tables
    ops::exec(conn, "ALTER TABLE ai_notification DROP COLUMN digest").await?;
    ops::exec(conn, "ALTER TABLE ai_project_settings DROP COLUMN digest").await?;
    ops::exec(conn, "ALTER TABLE ai_project_settings DROP COLUMN notify").await?;
    Ok(())
}

/// The eight AI safety events and their family (services/notifications.py SAFETY_KINDS)
const SAFETY_KIND: [(&str, &str); 8] = [
    ("approval_requested", "approval"),
    ("auto_trip", "auto_trip"),
    ("budget", "budget"),
    ("blocked", "blocked"),
    ("offline", "offline"),
    ("question", "question"),
    ("run_restarted", "run_restarted"),
    ("run_stopped_memory", "run_stopped_memory"),
];

/// DocsFollow becomes one case of following: a Docs space (scope "space", scope_id = the project).
async fn move_docs_follows<C: ConnectionTrait>(conn: &C) -> StepResult {
    if !ops::has_table(conn, "docs_follow").await? {
        return Ok(());
    }
    let rows = ops::rows(conn, "SELECT project_id, follower, created_at FROM docs_follow", vec![]).await?;
    for row in rows {
        let project_id: Option<String> = row.try_get("", "project_id")?;
        let follower: Option<String> = row.try_get("", "follower")?;
        let created_at: Option<String> = row.try_get("", "created_at")?;
        // (follower or "user").strip().lower() or "user"
        let follower = follower.filter(|f| !f.is_empty()).unwrap_or_else(|| "user".to_string());
        let mut key = pytext::strip(&follower).to_lowercase();
        if key.is_empty() || key == "you" {
            key = "user".to_string();
        }
        ops::exec_with(
            conn,
            "INSERT INTO notify_follow (id, recipient, scope, scope_id, project_id, level, label, created_at) \
             VALUES (?, ?, 'space', ?, ?, 'follow', 'Docs space', ?)",
            vec![time::uuid4().into(), key.into(), project_id.clone().into(), project_id.into(), created_at.into()],
        )
        .await?;
    }
    ops::exec(conn, "DROP INDEX ix_docs_follow_project_id").await?;
    ops::exec(conn, "DROP TABLE docs_follow").await?;
    Ok(())
}

/// The explicit desktop choices of one project's notify prefs, by safety family (empty when unreadable).
fn safety_desktop_choices(raw: Option<&str>) -> Result<Vec<(&'static str, bool)>, DatabaseError> {
    let raw = raw.filter(|r| !r.is_empty()).unwrap_or("{}");
    let Some(prefs) = pyjson::loads(raw) else { return Ok(Vec::new()) };
    let prefs = match prefs {
        Value::Object(map) => map,
        other if !pyjson::truthy(&other) => return Ok(Vec::new()),
        // Python stopped here too: `(prefs or {}).items()` on a list, a number or a string
        other => {
            let kind = match other {
                Value::Array(_) => "list",
                Value::String(_) => "str",
                Value::Bool(_) => "bool",
                Value::Number(ref n) if n.is_f64() => "float",
                _ => "int",
            };
            return Err(DatabaseError::Other(format!(
                "ai_project_settings.notify is not an object: '{kind}' object has no attribute 'items'"
            )));
        }
    };
    let mut out: Vec<(&'static str, bool)> = Vec::new();
    for (event, value) in &prefs {
        let Some(desktop) = value.as_object().and_then(|v| v.get("desktop")) else { continue };
        let Some((_, family)) = SAFETY_KIND.iter().find(|(name, _)| name == event) else { continue };
        out.push((family, pyjson::truthy(desktop)));
    }
    Ok(out)
}

/// Safety notifications held for the 09:00 digest are no longer held: they are ordinary rows now. The per-project
/// switches move to the app-wide settings; an explicit desktop choice of the board's own user is carried over.
async fn carry_safety_desktop_prefs<C: ConnectionTrait>(conn: &C) -> StepResult {
    let mut carried = Map::new();
    for row in ops::rows(conn, "SELECT notify FROM ai_project_settings", vec![]).await? {
        let raw: Option<String> = row.try_get("", "notify")?;
        for (family, desktop) in safety_desktop_choices(raw.as_deref())? {
            carried.insert(family.to_string(), json!({"desktop": desktop}));
        }
    }
    if !carried.is_empty() {
        ops::exec_with(
            conn,
            "INSERT INTO notify_prefs (recipient, prefs, updated_at) VALUES ('user', ?, datetime('now'))",
            vec![pyjson::dumps(&json!({"events": carried})).into()],
        )
        .await?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn desktop_choices_are_read_as_python_read_them() {
        let raw = r#"{"approval_requested": {"desktop": false, "email": true}, "budget": {"desktop": "no"},
            "unknown": {"desktop": true}, "offline": "yes", "question": {"email": true}, "blocked": {"desktop": null}}"#;
        assert_eq!(
            safety_desktop_choices(Some(raw)).unwrap(),
            [("approval", false), ("budget", true), ("blocked", false)]
        );
        for unreadable in [None, Some(""), Some("not json"), Some("null"), Some("[]"), Some("0"), Some("{}")] {
            assert!(safety_desktop_choices(unreadable).unwrap().is_empty(), "{unreadable:?}");
        }
        // Python's migration stopped on JSON that is not an object (AttributeError); so does this one
        for wrong in ["[1]", "5", "\"x\"", "true"] {
            assert!(safety_desktop_choices(Some(wrong)).is_err(), "{wrong}");
        }
    }
}
