//! `server/alembic/versions/a1d0c5a1b2c3_docs_ai.py`
//!
//! docs_ai: per-project Docs AI settings, jobs, proposals, freshness checks, page flags, chat summaries

use sea_orm::ConnectionTrait;

use super::ops::{self, StepResult};

/// `upgrade()` of revision `a1d0c5a1b2c3`.
pub(super) async fn upgrade<C: ConnectionTrait>(conn: &C) -> StepResult {
    // batch_alter_table("docs_page"): Alembic rebuilt the table for these columns; the table is the same with ADD COLUMN
    ops::exec(conn, r"ALTER TABLE docs_page ADD COLUMN ai_hidden BOOLEAN DEFAULT 0 NOT NULL").await?;
    ops::exec(conn, r"ALTER TABLE docs_page ADD COLUMN ai_guidance BOOLEAN DEFAULT 0 NOT NULL").await?;
    // batch_alter_table("docs_version"): Alembic rebuilt the table for these columns; the table is the same with ADD COLUMN
    ops::exec(conn, r"ALTER TABLE docs_version ADD COLUMN with_ai BOOLEAN DEFAULT 0 NOT NULL").await?;
    ops::exec(conn, r"ALTER TABLE docs_draft ADD COLUMN ai_source VARCHAR").await?;
    ops::exec(conn, r"ALTER TABLE docs_comment ADD COLUMN ai VARCHAR").await?;
    ops::exec(conn, r"ALTER TABLE ai_chat ADD COLUMN summary VARCHAR DEFAULT '' NOT NULL").await?;
    ops::exec(conn, r"ALTER TABLE ai_chat ADD COLUMN summary_upto VARCHAR").await?;
    ops::exec(conn, r"ALTER TABLE ai_chat ADD COLUMN compactions INTEGER DEFAULT '0' NOT NULL").await?;
    ops::exec(conn, r"CREATE TABLE docs_ai_settings (
	project_id VARCHAR NOT NULL, 
	enabled BOOLEAN DEFAULT 1 NOT NULL, 
	member_id VARCHAR, 
	read_scope VARCHAR DEFAULT 'except_hidden' NOT NULL, 
	picked_pages VARCHAR DEFAULT '[]' NOT NULL, 
	style_page_id VARCHAR, 
	edits_mode VARCHAR DEFAULT 'direct' NOT NULL, 
	proposal_days INTEGER DEFAULT '7' NOT NULL, 
	freshness_on BOOLEAN DEFAULT 1 NOT NULL, 
	guidance_limit INTEGER DEFAULT '8000' NOT NULL, 
	digest_on BOOLEAN DEFAULT 1 NOT NULL, 
	updated_by VARCHAR, 
	updated_at VARCHAR NOT NULL, 
	PRIMARY KEY (project_id), 
	FOREIGN KEY(project_id) REFERENCES project (id)
)").await?;
    ops::exec(conn, r"CREATE TABLE docs_ai_job (
	id VARCHAR NOT NULL, 
	project_id VARCHAR NOT NULL, 
	page_id VARCHAR, 
	thread_id VARCHAR, 
	comment_id VARCHAR, 
	member_id VARCHAR, 
	kind VARCHAR NOT NULL, 
	state VARCHAR DEFAULT 'queued' NOT NULL, 
	started_by VARCHAR DEFAULT 'user' NOT NULL, 
	instruction VARCHAR DEFAULT '' NOT NULL, 
	session_id VARCHAR, 
	reads VARCHAR DEFAULT '[]' NOT NULL, 
	steps VARCHAR DEFAULT '[]' NOT NULL, 
	result VARCHAR DEFAULT '{}' NOT NULL, 
	error VARCHAR DEFAULT '{}' NOT NULL, 
	tokens_in INTEGER DEFAULT '0' NOT NULL, 
	tokens_out INTEGER DEFAULT '0' NOT NULL, 
	cost_usd FLOAT DEFAULT '0' NOT NULL, 
	metered BOOLEAN DEFAULT 0 NOT NULL, 
	reply_comment_id VARCHAR, 
	queued_at VARCHAR NOT NULL, 
	started_at VARCHAR, 
	ended_at VARCHAR, 
	PRIMARY KEY (id), 
	FOREIGN KEY(project_id) REFERENCES project (id)
)").await?;
    ops::exec(conn, r"CREATE INDEX ix_docs_ai_job_project_id ON docs_ai_job (project_id)").await?;
    ops::exec(conn, r"CREATE INDEX ix_docs_ai_job_page_id ON docs_ai_job (page_id)").await?;
    ops::exec(conn, r"CREATE INDEX ix_docs_ai_job_thread_id ON docs_ai_job (thread_id)").await?;
    ops::exec(conn, r"CREATE INDEX ix_docs_ai_job_member_id ON docs_ai_job (member_id)").await?;
    ops::exec(conn, r"CREATE INDEX ix_docs_ai_job_kind ON docs_ai_job (kind)").await?;
    ops::exec(conn, r"CREATE INDEX ix_docs_ai_job_state ON docs_ai_job (state)").await?;
    ops::exec(conn, r"CREATE TABLE docs_ai_proposal (
	id VARCHAR NOT NULL, 
	project_id VARCHAR NOT NULL, 
	page_id VARCHAR NOT NULL, 
	member_id VARCHAR NOT NULL, 
	run_id VARCHAR, 
	job_id VARCHAR, 
	ticket_id VARCHAR, 
	approval_id VARCHAR, 
	on_behalf_of VARCHAR, 
	base_version INTEGER DEFAULT '0' NOT NULL, 
	status VARCHAR DEFAULT 'waiting' NOT NULL, 
	summary VARCHAR DEFAULT '' NOT NULL, 
	changes VARCHAR DEFAULT '[]' NOT NULL, 
	created_at VARCHAR NOT NULL, 
	expires_at VARCHAR, 
	decided_by VARCHAR, 
	decided_at VARCHAR, 
	decision_note VARCHAR, 
	PRIMARY KEY (id), 
	FOREIGN KEY(project_id) REFERENCES project (id), 
	FOREIGN KEY(page_id) REFERENCES docs_page (id)
)").await?;
    ops::exec(conn, r"CREATE INDEX ix_docs_ai_proposal_project_id ON docs_ai_proposal (project_id)").await?;
    ops::exec(conn, r"CREATE INDEX ix_docs_ai_proposal_page_id ON docs_ai_proposal (page_id)").await?;
    ops::exec(conn, r"CREATE INDEX ix_docs_ai_proposal_member_id ON docs_ai_proposal (member_id)").await?;
    ops::exec(conn, r"CREATE INDEX ix_docs_ai_proposal_status ON docs_ai_proposal (status)").await?;
    ops::exec(conn, r"CREATE TABLE docs_ai_check (
	page_id VARCHAR NOT NULL, 
	project_id VARCHAR NOT NULL, 
	state VARCHAR DEFAULT 'ok' NOT NULL, 
	reasons VARCHAR DEFAULT '[]' NOT NULL, 
	based_on_version INTEGER DEFAULT '0' NOT NULL, 
	deps_hash VARCHAR DEFAULT '' NOT NULL, 
	checked_at VARCHAR NOT NULL, 
	ok_until VARCHAR, 
	ok_hash VARCHAR, 
	dismissed VARCHAR DEFAULT '[]' NOT NULL, 
	job_id VARCHAR, 
	PRIMARY KEY (page_id), 
	FOREIGN KEY(page_id) REFERENCES docs_page (id), 
	FOREIGN KEY(project_id) REFERENCES project (id)
)").await?;
    ops::exec(conn, r"CREATE INDEX ix_docs_ai_check_project_id ON docs_ai_check (project_id)").await?;
    ops::exec(conn, r"CREATE TABLE docs_ai_health (
	project_id VARCHAR NOT NULL, 
	data VARCHAR DEFAULT '{}' NOT NULL, 
	checked_at VARCHAR, 
	digest_at VARCHAR, 
	PRIMARY KEY (project_id), 
	FOREIGN KEY(project_id) REFERENCES project (id)
)").await?;
    ops::exec(conn, r#"CREATE TABLE docs_ai_ignore (
	page_id VARCHAR NOT NULL, 
	"key" VARCHAR NOT NULL, 
	"by" VARCHAR DEFAULT 'user' NOT NULL, 
	at VARCHAR NOT NULL, 
	PRIMARY KEY (page_id, "key")
)"#).await?;
    Ok(())
}
