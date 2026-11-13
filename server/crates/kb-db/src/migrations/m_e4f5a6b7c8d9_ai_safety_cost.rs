//! `server/alembic/versions/e4f5a6b7c8d9_ai_safety_cost.py`
//!
//! AI safety and cost: limits, approval rules, grants, notifications and workspace defaults.

use sea_orm::ConnectionTrait;

use super::ops::{self, StepResult};

/// `upgrade()` of revision `e4f5a6b7c8d9`.
pub(super) async fn upgrade<C: ConnectionTrait>(conn: &C) -> StepResult {
    // batch_alter_table("ai_member"): Alembic rebuilt the table for these columns (their default is written as an
    // expression); ADD COLUMN gives the same table
    ops::exec(conn, r"ALTER TABLE ai_member ADD COLUMN safe_mode BOOLEAN DEFAULT 0 NOT NULL").await?;
    ops::exec(conn, r"ALTER TABLE ai_member ADD COLUMN allow_external BOOLEAN DEFAULT 0 NOT NULL").await?;
    ops::exec(conn, r"ALTER TABLE ai_member ADD COLUMN tokens_per_day INTEGER").await?;
    ops::exec(conn, r"ALTER TABLE ai_member ADD COLUMN cap_per_run FLOAT").await?;
    ops::exec(conn, r"ALTER TABLE ai_member ADD COLUMN warn_at VARCHAR DEFAULT '[80,100]' NOT NULL").await?;
    ops::exec(conn, r"ALTER TABLE ai_member ADD COLUMN key_rotated_at VARCHAR").await?;
    ops::exec(conn, r"ALTER TABLE ai_member ADD COLUMN mcp_last_used_at VARCHAR").await?;
    ops::exec(conn, r"ALTER TABLE ai_member ADD COLUMN token_revoked_at VARCHAR").await?;
    ops::exec(conn, r"ALTER TABLE ai_member ADD COLUMN token_revoked_by VARCHAR").await?;
    ops::exec(conn, r#"ALTER TABLE ai_approval ADD COLUMN "before" VARCHAR DEFAULT '{}' NOT NULL"#).await?;
    // batch_alter_table("ai_project_settings"): Alembic rebuilt the table for these columns (their default is written as an
    // expression); ADD COLUMN gives the same table
    ops::exec(conn, r"ALTER TABLE ai_project_settings ADD COLUMN board_tokens_per_day INTEGER DEFAULT '1000000'")
        .await?;
    ops::exec(conn, r"ALTER TABLE ai_project_settings ADD COLUMN board_max_parallel INTEGER DEFAULT '4' NOT NULL")
        .await?;
    ops::exec(conn, r"ALTER TABLE ai_project_settings ADD COLUMN board_runs_per_day INTEGER DEFAULT '60'").await?;
    ops::exec(conn, r"ALTER TABLE ai_project_settings ADD COLUMN board_at_cap VARCHAR DEFAULT 'pause' NOT NULL")
        .await?;
    ops::exec(conn, r"ALTER TABLE ai_project_settings ADD COLUMN approval_on_expiry VARCHAR DEFAULT 'skip' NOT NULL")
        .await?;
    ops::exec(conn, r#"ALTER TABLE ai_project_settings ADD COLUMN approvers VARCHAR DEFAULT '{"low":"member","medium":"admin","high":"owner"}' NOT NULL"#).await?;
    ops::exec(conn, r"ALTER TABLE ai_project_settings ADD COLUMN delegates VARCHAR DEFAULT '[]' NOT NULL").await?;
    ops::exec(conn, r"ALTER TABLE ai_project_settings ADD COLUMN audit_retention_days INTEGER DEFAULT '90'").await?;
    ops::exec(conn, r"ALTER TABLE ai_project_settings ADD COLUMN loop_cooldown_s INTEGER DEFAULT '60' NOT NULL")
        .await?;
    ops::exec(conn, r"ALTER TABLE ai_project_settings ADD COLUMN no_repeat_chain BOOLEAN DEFAULT 1 NOT NULL").await?;
    ops::exec(conn, r#"ALTER TABLE ai_project_settings ADD COLUMN allowed_domains VARCHAR DEFAULT '["github.com","developer.mozilla.org"]' NOT NULL"#).await?;
    ops::exec(conn, r"ALTER TABLE ai_project_settings ADD COLUMN notify VARCHAR DEFAULT '{}' NOT NULL").await?;
    ops::exec(conn, r"ALTER TABLE ai_project_settings ADD COLUMN digest VARCHAR DEFAULT 'daily' NOT NULL").await?;
    ops::exec(conn, r"ALTER TABLE ai_project_settings ADD COLUMN alert_state VARCHAR DEFAULT '{}' NOT NULL").await?;
    ops::exec(conn, r"ALTER TABLE ai_project_settings ADD COLUMN checklist VARCHAR DEFAULT '{}' NOT NULL").await?;
    ops::exec(conn, r"ALTER TABLE ai_project_settings ADD COLUMN key_reminder_days INTEGER DEFAULT '90' NOT NULL")
        .await?;
    ops::exec(conn, r"ALTER TABLE ai_project_settings ADD COLUMN paused_cancelled INTEGER DEFAULT '0' NOT NULL")
        .await?;
    ops::exec(conn, r"ALTER TABLE ai_project_settings ADD COLUMN paused_held INTEGER DEFAULT '0' NOT NULL").await?;
    ops::exec(conn, r"ALTER TABLE ai_project_settings ADD COLUMN paused_tokens_revoked BOOLEAN DEFAULT 0 NOT NULL")
        .await?;
    ops::exec(
        conn,
        r"CREATE TABLE ai_grant (
	id VARCHAR NOT NULL, 
	project_id VARCHAR NOT NULL, 
	kind VARCHAR NOT NULL, 
	member_id VARCHAR, 
	ticket_id VARCHAR, 
	action VARCHAR, 
	amount FLOAT DEFAULT '0' NOT NULL, 
	day VARCHAR, 
	created_by VARCHAR DEFAULT 'user' NOT NULL, 
	created_at VARCHAR NOT NULL, 
	revoked_at VARCHAR, 
	source_approval_id VARCHAR, 
	PRIMARY KEY (id), 
	FOREIGN KEY(project_id) REFERENCES project (id)
)",
    )
    .await?;
    ops::exec(conn, r"CREATE INDEX ix_ai_grant_member_id ON ai_grant (member_id)").await?;
    ops::exec(conn, r"CREATE INDEX ix_ai_grant_ticket_id ON ai_grant (ticket_id)").await?;
    ops::exec(conn, r"CREATE INDEX ix_ai_grant_project_id ON ai_grant (project_id)").await?;
    ops::exec(
        conn,
        r"CREATE TABLE ai_notification (
	id VARCHAR NOT NULL, 
	project_id VARCHAR NOT NULL, 
	event VARCHAR NOT NULL, 
	title VARCHAR NOT NULL, 
	body VARCHAR DEFAULT '' NOT NULL, 
	ref_kind VARCHAR, 
	ref_id VARCHAR, 
	member_id VARCHAR, 
	people VARCHAR DEFAULT '[]' NOT NULL, 
	urgent BOOLEAN DEFAULT 1 NOT NULL, 
	inapp BOOLEAN DEFAULT 1 NOT NULL, 
	desktop BOOLEAN DEFAULT 0 NOT NULL, 
	digest BOOLEAN DEFAULT 0 NOT NULL, 
	data VARCHAR DEFAULT '{}' NOT NULL, 
	created_at VARCHAR NOT NULL, 
	PRIMARY KEY (id), 
	FOREIGN KEY(project_id) REFERENCES project (id)
)",
    )
    .await?;
    ops::exec(conn, r"CREATE INDEX ix_ai_notification_created_at ON ai_notification (created_at)").await?;
    ops::exec(conn, r"CREATE INDEX ix_ai_notification_project_id ON ai_notification (project_id)").await?;
    ops::exec(
        conn,
        r"CREATE TABLE ai_workspace_defaults (
	id INTEGER NOT NULL, 
	template VARCHAR DEFAULT 'developer' NOT NULL, 
	ceiling VARCHAR DEFAULT 'review' NOT NULL, 
	delete_mode VARCHAR DEFAULT 'blocked' NOT NULL, 
	daily_budget FLOAT DEFAULT '5', 
	monthly_cap FLOAT DEFAULT '120', 
	updated_by VARCHAR, 
	updated_at VARCHAR, 
	PRIMARY KEY (id)
)",
    )
    .await?;
    Ok(())
}
