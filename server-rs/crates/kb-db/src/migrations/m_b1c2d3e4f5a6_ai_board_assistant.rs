//! `server/alembic/versions/b1c2d3e4f5a6_ai_board_assistant.py`
//!
//! Board AI assistant: settings, chats, drafts, usage, insights and digests.

use sea_orm::ConnectionTrait;

use super::ops::{self, StepResult};

/// `upgrade()` of revision `b1c2d3e4f5a6`.
pub(super) async fn upgrade<C: ConnectionTrait>(conn: &C) -> StepResult {
    ops::exec(conn, r"CREATE TABLE ai_assist_settings (
	id INTEGER NOT NULL, 
	features VARCHAR DEFAULT '{}' NOT NULL, 
	language VARCHAR DEFAULT 'English (US)' NOT NULL, 
	tone VARCHAR DEFAULT 'neutral' NOT NULL, 
	style_guide VARCHAR DEFAULT '' NOT NULL, 
	monthly_cap FLOAT, 
	per_request_cap FLOAT, 
	over_cap VARCHAR DEFAULT 'pause' NOT NULL, 
	data_scope VARCHAR DEFAULT '{}' NOT NULL, 
	excluded_docs VARCHAR DEFAULT '[]' NOT NULL, 
	health VARCHAR DEFAULT '{}' NOT NULL, 
	paused_until VARCHAR, 
	PRIMARY KEY (id)
)").await?;
    ops::exec(conn, r"CREATE TABLE ai_chat (
	id VARCHAR NOT NULL, 
	project_id VARCHAR NOT NULL, 
	owner VARCHAR NOT NULL, 
	title VARCHAR DEFAULT 'New chat' NOT NULL, 
	scope VARCHAR DEFAULT 'project' NOT NULL, 
	ticket_id VARCHAR, 
	doc_id VARCHAR, 
	include_docs VARCHAR DEFAULT '[]' NOT NULL, 
	cost FLOAT DEFAULT '0' NOT NULL, 
	tokens INTEGER DEFAULT '0' NOT NULL, 
	applied BOOLEAN DEFAULT 0 NOT NULL, 
	created_at VARCHAR NOT NULL, 
	updated_at VARCHAR NOT NULL, 
	PRIMARY KEY (id), 
	FOREIGN KEY(project_id) REFERENCES project (id)
)").await?;
    ops::exec(conn, r"CREATE INDEX ix_ai_chat_project_id ON ai_chat (project_id)").await?;
    ops::exec(conn, r"CREATE INDEX ix_ai_chat_owner ON ai_chat (owner)").await?;
    ops::exec(conn, r"CREATE TABLE ai_chat_message (
	id VARCHAR NOT NULL, 
	chat_id VARCHAR NOT NULL, 
	role VARCHAR NOT NULL, 
	text VARCHAR DEFAULT '' NOT NULL, 
	state VARCHAR DEFAULT 'done' NOT NULL, 
	steps VARCHAR DEFAULT '[]' NOT NULL, 
	context VARCHAR DEFAULT '{}' NOT NULL, 
	actions VARCHAR DEFAULT '[]' NOT NULL, 
	draft_id VARCHAR, 
	error VARCHAR DEFAULT '{}' NOT NULL, 
	retry_at VARCHAR, 
	member_id VARCHAR, 
	model VARCHAR, 
	cost FLOAT DEFAULT '0' NOT NULL, 
	tokens_in INTEGER DEFAULT '0' NOT NULL, 
	tokens_out INTEGER DEFAULT '0' NOT NULL, 
	metered BOOLEAN DEFAULT 1 NOT NULL, 
	created_at VARCHAR NOT NULL, 
	finished_at VARCHAR, 
	PRIMARY KEY (id), 
	FOREIGN KEY(chat_id) REFERENCES ai_chat (id)
)").await?;
    ops::exec(conn, r"CREATE INDEX ix_ai_chat_message_chat_id ON ai_chat_message (chat_id)").await?;
    ops::exec(conn, r"CREATE TABLE ai_draft (
	id VARCHAR NOT NULL, 
	project_id VARCHAR NOT NULL, 
	kind VARCHAR NOT NULL, 
	owner VARCHAR NOT NULL, 
	member_id VARCHAR, 
	member_name VARCHAR DEFAULT '' NOT NULL, 
	ticket_id VARCHAR, 
	doc_id VARCHAR, 
	chat_message_id VARCHAR, 
	insight_id VARCHAR, 
	base VARCHAR DEFAULT '{}' NOT NULL, 
	payload VARCHAR DEFAULT '{}' NOT NULL, 
	raw VARCHAR DEFAULT '' NOT NULL, 
	status VARCHAR DEFAULT 'open' NOT NULL, 
	result VARCHAR DEFAULT '{}' NOT NULL, 
	cost FLOAT DEFAULT '0' NOT NULL, 
	tokens INTEGER DEFAULT '0' NOT NULL, 
	created_at VARCHAR NOT NULL, 
	expires_at VARCHAR, 
	applied_at VARCHAR, 
	applied_by VARCHAR, 
	PRIMARY KEY (id), 
	FOREIGN KEY(project_id) REFERENCES project (id)
)").await?;
    ops::exec(conn, r"CREATE INDEX ix_ai_draft_ticket_id ON ai_draft (ticket_id)").await?;
    ops::exec(conn, r"CREATE INDEX ix_ai_draft_project_id ON ai_draft (project_id)").await?;
    ops::exec(conn, r"CREATE TABLE ai_usage (
	id VARCHAR NOT NULL, 
	project_id VARCHAR NOT NULL, 
	feature VARCHAR NOT NULL, 
	member_id VARCHAR, 
	person VARCHAR, 
	cost FLOAT DEFAULT '0' NOT NULL, 
	tokens_in INTEGER DEFAULT '0' NOT NULL, 
	tokens_out INTEGER DEFAULT '0' NOT NULL, 
	metered BOOLEAN DEFAULT 1 NOT NULL, 
	created_at VARCHAR NOT NULL, 
	PRIMARY KEY (id), 
	FOREIGN KEY(project_id) REFERENCES project (id)
)").await?;
    ops::exec(conn, r"CREATE INDEX ix_ai_usage_feature ON ai_usage (feature)").await?;
    ops::exec(conn, r"CREATE INDEX ix_ai_usage_created_at ON ai_usage (created_at)").await?;
    ops::exec(conn, r"CREATE INDEX ix_ai_usage_project_id ON ai_usage (project_id)").await?;
    ops::exec(conn, r#"CREATE TABLE ai_insight (
	id VARCHAR NOT NULL, 
	project_id VARCHAR NOT NULL, 
	kind VARCHAR NOT NULL, 
	"key" VARCHAR NOT NULL, 
	ticket_id VARCHAR, 
	title VARCHAR NOT NULL, 
	detail VARCHAR DEFAULT '' NOT NULL, 
	data VARCHAR DEFAULT '{}' NOT NULL, 
	score FLOAT DEFAULT '0' NOT NULL, 
	state VARCHAR DEFAULT 'open' NOT NULL, 
	snoozed_until VARCHAR, 
	seen BOOLEAN DEFAULT 0 NOT NULL, 
	draft_id VARCHAR, 
	created_at VARCHAR NOT NULL, 
	updated_at VARCHAR NOT NULL, 
	PRIMARY KEY (id), 
	FOREIGN KEY(project_id) REFERENCES project (id)
)"#).await?;
    ops::exec(conn, r"CREATE INDEX ix_ai_insight_project_id ON ai_insight (project_id)").await?;
    ops::exec(conn, r#"CREATE INDEX ix_ai_insight_key ON ai_insight ("key")"#).await?;
    ops::exec(conn, r"CREATE TABLE ai_digest (
	id VARCHAR NOT NULL, 
	project_id VARCHAR NOT NULL, 
	day VARCHAR NOT NULL, 
	summary VARCHAR DEFAULT '{}' NOT NULL, 
	member_id VARCHAR, 
	cost FLOAT DEFAULT '0' NOT NULL, 
	tokens INTEGER DEFAULT '0' NOT NULL, 
	created_at VARCHAR NOT NULL, 
	PRIMARY KEY (id), 
	FOREIGN KEY(project_id) REFERENCES project (id)
)").await?;
    ops::exec(conn, r"CREATE INDEX ix_ai_digest_project_id ON ai_digest (project_id)").await?;
    Ok(())
}
