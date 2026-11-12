//! `server/alembic/versions/c9d0e1f2a3b4_idea_ai_helpers.py`
//!
//! idea_ai_helpers: AI settings, triage advice and weekly digests of the Idea Space; AI mark on assumptions

use sea_orm::ConnectionTrait;

use super::ops::{self, StepResult};

/// `upgrade()` of revision `c9d0e1f2a3b4`.
pub(super) async fn upgrade<C: ConnectionTrait>(conn: &C) -> StepResult {
    ops::exec(conn, r"ALTER TABLE idea_assumption ADD COLUMN ai BOOLEAN DEFAULT 0 NOT NULL").await?;
    ops::exec(conn, r"CREATE TABLE idea_ai_settings (
	project_id VARCHAR NOT NULL, 
	enabled BOOLEAN DEFAULT 1 NOT NULL, 
	triage_advice BOOLEAN DEFAULT 1 NOT NULL, 
	weekly_grooming BOOLEAN DEFAULT 1 NOT NULL, 
	ask BOOLEAN DEFAULT 1 NOT NULL, 
	read_docs BOOLEAN DEFAULT 1 NOT NULL, 
	read_repo BOOLEAN DEFAULT 1 NOT NULL, 
	daily_cap FLOAT DEFAULT '1.0' NOT NULL, 
	updated_at VARCHAR NOT NULL, 
	PRIMARY KEY (project_id)
)").await?;
    ops::exec(conn, r"CREATE TABLE idea_advice (
	id VARCHAR NOT NULL, 
	idea_id VARCHAR NOT NULL, 
	action VARCHAR NOT NULL, 
	reason VARCHAR DEFAULT '' NOT NULL, 
	confidence VARCHAR DEFAULT 'medium' NOT NULL, 
	target_id VARCHAR, 
	archive_reason VARCHAR, 
	park_days INTEGER, 
	idea_stamp VARCHAR DEFAULT '' NOT NULL, 
	member_id VARCHAR, 
	cost FLOAT DEFAULT '0' NOT NULL, 
	state VARCHAR DEFAULT 'open' NOT NULL, 
	created_at VARCHAR NOT NULL, 
	PRIMARY KEY (id), 
	FOREIGN KEY(idea_id) REFERENCES idea_ticket (id)
)").await?;
    ops::exec(conn, r"CREATE INDEX ix_idea_advice_idea_id ON idea_advice (idea_id)").await?;
    ops::exec(conn, r"CREATE TABLE idea_digest (
	id VARCHAR NOT NULL, 
	project_id VARCHAR DEFAULT '' NOT NULL, 
	text VARCHAR DEFAULT '' NOT NULL, 
	items VARCHAR DEFAULT '[]' NOT NULL, 
	ai BOOLEAN DEFAULT 0 NOT NULL, 
	member_id VARCHAR, 
	cost FLOAT DEFAULT '0' NOT NULL, 
	ideas_read INTEGER DEFAULT '0' NOT NULL, 
	created_at VARCHAR NOT NULL, 
	PRIMARY KEY (id)
)").await?;
    ops::exec(conn, r"CREATE INDEX ix_idea_digest_project_id ON idea_digest (project_id)").await?;
    Ok(())
}
