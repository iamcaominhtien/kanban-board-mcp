//! `server/alembic/versions/a9b8c7d6e5f4_ai_members.py`
//!
//! ai members: member kind, AI member profiles, runs (with the one-holder-per-ticket index), approvals, audit

use sea_orm::ConnectionTrait;

use super::ops::{self, StepResult};

/// `upgrade()` of revision `a9b8c7d6e5f4`.
pub(super) async fn upgrade<C: ConnectionTrait>(conn: &C) -> StepResult {
    ops::exec(conn, r"ALTER TABLE member ADD COLUMN kind VARCHAR DEFAULT 'human' NOT NULL").await?;
    ops::exec(
        conn,
        r"CREATE TABLE ai_member (
	id VARCHAR NOT NULL, 
	project_id VARCHAR NOT NULL, 
	provider VARCHAR NOT NULL, 
	connection VARCHAR NOT NULL, 
	description VARCHAR DEFAULT '' NOT NULL, 
	glyph VARCHAR DEFAULT 'spark' NOT NULL, 
	cli_path VARCHAR, 
	working_dir VARCHAR, 
	base_url VARCHAR, 
	model VARCHAR, 
	key_enc VARCHAR, 
	key_last4 VARCHAR, 
	persona VARCHAR DEFAULT '' NOT NULL, 
	max_parallel INTEGER DEFAULT '2' NOT NULL, 
	daily_budget FLOAT, 
	monthly_cap FLOAT, 
	max_runs_per_day INTEGER, 
	template VARCHAR DEFAULT 'developer' NOT NULL, 
	ceiling VARCHAR DEFAULT 'review' NOT NULL, 
	permissions VARCHAR DEFAULT '{}' NOT NULL, 
	scope VARCHAR DEFAULT 'assigned' NOT NULL, 
	config VARCHAR DEFAULT '{}' NOT NULL, 
	paused BOOLEAN DEFAULT '0' NOT NULL, 
	paused_at VARCHAR, 
	paused_reason VARCHAR, 
	health VARCHAR DEFAULT 'unknown' NOT NULL, 
	health_detail VARCHAR, 
	checked_at VARCHAR, 
	cli_version VARCHAR, 
	account VARCHAR, 
	last_call_at VARCHAR, 
	remove_after_run BOOLEAN DEFAULT '0' NOT NULL, 
	created_by VARCHAR, 
	created_at VARCHAR NOT NULL, 
	updated_at VARCHAR NOT NULL, 
	PRIMARY KEY (id), 
	FOREIGN KEY(id) REFERENCES member (id), 
	FOREIGN KEY(project_id) REFERENCES project (id)
)",
    )
    .await?;
    ops::exec(conn, r"CREATE INDEX ix_ai_member_project_id ON ai_member (project_id)").await?;
    ops::exec(
        conn,
        r#"CREATE TABLE ai_run (
	id VARCHAR NOT NULL, 
	project_id VARCHAR NOT NULL, 
	ticket_id VARCHAR NOT NULL, 
	member_id VARCHAR NOT NULL, 
	number INTEGER DEFAULT '1' NOT NULL, 
	mode VARCHAR DEFAULT 'work' NOT NULL, 
	"trigger" VARCHAR DEFAULT 'assign' NOT NULL, 
	state VARCHAR DEFAULT 'queued' NOT NULL, 
	started_by VARCHAR DEFAULT 'user' NOT NULL, 
	instruction VARCHAR DEFAULT '' NOT NULL, 
	source_comment_id VARCHAR, 
	reply_comment_id VARCHAR, 
	include_context BOOLEAN DEFAULT '1' NOT NULL, 
	chain VARCHAR DEFAULT '[]' NOT NULL, 
	queued_at VARCHAR NOT NULL, 
	started_at VARCHAR, 
	ended_at VARCHAR, 
	last_output_at VARCHAR, 
	ended_reason VARCHAR, 
	ended_by VARCHAR, 
	exit_code INTEGER, 
	summary VARCHAR, 
	report VARCHAR DEFAULT '{}' NOT NULL, 
	question VARCHAR, 
	answer VARCHAR, 
	session_id VARCHAR, 
	steps VARCHAR DEFAULT '[]' NOT NULL, 
	files VARCHAR DEFAULT '[]' NOT NULL, 
	tokens_in INTEGER DEFAULT '0' NOT NULL, 
	tokens_out INTEGER DEFAULT '0' NOT NULL, 
	cost_usd FLOAT DEFAULT '0' NOT NULL, 
	metered BOOLEAN DEFAULT '0' NOT NULL, 
	status_before VARCHAR, 
	status_changes VARCHAR DEFAULT '[]' NOT NULL, 
	pid INTEGER, 
	token_hash VARCHAR, 
	model VARCHAR, 
	PRIMARY KEY (id), 
	FOREIGN KEY(project_id) REFERENCES project (id), 
	FOREIGN KEY(member_id) REFERENCES member (id)
)"#,
    )
    .await?;
    ops::exec(conn, r"CREATE INDEX ix_ai_run_project_id ON ai_run (project_id)").await?;
    ops::exec(conn, r"CREATE INDEX ix_ai_run_ticket_id ON ai_run (ticket_id)").await?;
    ops::exec(conn, r"CREATE INDEX ix_ai_run_member_id ON ai_run (member_id)").await?;
    ops::exec(conn, r"CREATE INDEX ix_ai_run_state ON ai_run (state)").await?;
    ops::exec(conn, r"CREATE INDEX ix_ai_run_token_hash ON ai_run (token_hash)").await?;
    ops::exec(conn, r"CREATE UNIQUE INDEX ux_ai_run_ticket_hold ON ai_run (ticket_id) WHERE mode = 'work' AND state IN ('queued', 'starting', 'running', 'needs_input')").await?;
    ops::exec(
        conn,
        r"CREATE TABLE ai_approval (
	id VARCHAR NOT NULL, 
	project_id VARCHAR NOT NULL, 
	member_id VARCHAR NOT NULL, 
	run_id VARCHAR, 
	ticket_id VARCHAR, 
	action VARCHAR NOT NULL, 
	summary VARCHAR DEFAULT '' NOT NULL, 
	payload VARCHAR DEFAULT '{}' NOT NULL, 
	reason VARCHAR, 
	risk VARCHAR DEFAULT 'medium' NOT NULL, 
	status VARCHAR DEFAULT 'pending' NOT NULL, 
	on_behalf_of VARCHAR, 
	requested_at VARCHAR NOT NULL, 
	expires_at VARCHAR, 
	decided_by VARCHAR, 
	decided_at VARCHAR, 
	decision_note VARCHAR, 
	PRIMARY KEY (id), 
	FOREIGN KEY(project_id) REFERENCES project (id), 
	FOREIGN KEY(member_id) REFERENCES member (id)
)",
    )
    .await?;
    ops::exec(conn, r"CREATE INDEX ix_ai_approval_project_id ON ai_approval (project_id)").await?;
    ops::exec(conn, r"CREATE INDEX ix_ai_approval_member_id ON ai_approval (member_id)").await?;
    ops::exec(conn, r"CREATE INDEX ix_ai_approval_ticket_id ON ai_approval (ticket_id)").await?;
    ops::exec(
        conn,
        r"CREATE TABLE ai_audit (
	id VARCHAR NOT NULL, 
	seq INTEGER DEFAULT '0' NOT NULL, 
	project_id VARCHAR NOT NULL, 
	member_id VARCHAR, 
	member_name VARCHAR DEFAULT '' NOT NULL, 
	on_behalf_of VARCHAR, 
	run_id VARCHAR, 
	action VARCHAR NOT NULL, 
	target VARCHAR, 
	result VARCHAR DEFAULT 'allowed' NOT NULL, 
	detail VARCHAR DEFAULT '{}' NOT NULL, 
	created_at VARCHAR NOT NULL, 
	reverted_at VARCHAR, 
	reverted_by VARCHAR, 
	prev_hash VARCHAR DEFAULT '' NOT NULL, 
	hash VARCHAR DEFAULT '' NOT NULL, 
	PRIMARY KEY (id)
)",
    )
    .await?;
    ops::exec(conn, r"CREATE INDEX ix_ai_audit_seq ON ai_audit (seq)").await?;
    ops::exec(conn, r"CREATE INDEX ix_ai_audit_project_id ON ai_audit (project_id)").await?;
    ops::exec(conn, r"CREATE INDEX ix_ai_audit_member_id ON ai_audit (member_id)").await?;
    ops::exec(conn, r"CREATE INDEX ix_ai_audit_run_id ON ai_audit (run_id)").await?;
    ops::exec(
        conn,
        r"CREATE TABLE ai_project_settings (
	project_id VARCHAR NOT NULL, 
	board_ai_id VARCHAR, 
	paused_all BOOLEAN DEFAULT '0' NOT NULL, 
	paused_at VARCHAR, 
	paused_by VARCHAR, 
	paused_reason VARCHAR, 
	safe_mode BOOLEAN DEFAULT '0' NOT NULL, 
	board_daily_cap FLOAT, 
	board_monthly_budget FLOAT, 
	max_chain_depth INTEGER DEFAULT '3' NOT NULL, 
	runs_per_ticket_per_day INTEGER DEFAULT '6' NOT NULL, 
	approval_expiry_hours INTEGER DEFAULT '24' NOT NULL, 
	PRIMARY KEY (project_id), 
	FOREIGN KEY(project_id) REFERENCES project (id)
)",
    )
    .await?;
    Ok(())
}
