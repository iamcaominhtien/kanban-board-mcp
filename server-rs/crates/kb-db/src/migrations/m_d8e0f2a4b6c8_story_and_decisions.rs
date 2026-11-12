//! `server/alembic/versions/d8e0f2a4b6c8_story_and_decisions.py`
//!
//! Story (a ticket the PM owns from the goal to Done) and the decisions the PM took in a person's place

use sea_orm::ConnectionTrait;

use super::ops::{self, StepResult};

/// `upgrade()` of revision `d8e0f2a4b6c8`.
pub(super) async fn upgrade<C: ConnectionTrait>(conn: &C) -> StepResult {
    ops::exec(
        conn,
        r#"CREATE TABLE story (
	ticket_id VARCHAR NOT NULL, 
	project_id VARCHAR NOT NULL, 
	state VARCHAR DEFAULT 'draft' NOT NULL, 
	approve VARCHAR DEFAULT 'person' NOT NULL, 
	budget_tokens INTEGER DEFAULT '0' NOT NULL, 
	pm_id VARCHAR, 
	"plan" VARCHAR DEFAULT '{}' NOT NULL, 
	paused BOOLEAN DEFAULT 0 NOT NULL, 
	review_note VARCHAR, 
	history VARCHAR DEFAULT '[]' NOT NULL, 
	meta VARCHAR DEFAULT '{}' NOT NULL, 
	created_by VARCHAR, 
	created_at VARCHAR NOT NULL, 
	handed_at VARCHAR, 
	started_at VARCHAR, 
	closed_at VARCHAR, 
	PRIMARY KEY (ticket_id), 
	FOREIGN KEY(ticket_id) REFERENCES ticket (id)
)"#,
    )
    .await?;
    ops::exec(conn, r"CREATE INDEX ix_story_project_id ON story (project_id)").await?;
    ops::exec(conn, r"CREATE INDEX ix_story_state ON story (state)").await?;
    ops::exec(
        conn,
        r"CREATE TABLE ai_decision (
	id VARCHAR NOT NULL, 
	project_id VARCHAR NOT NULL, 
	ticket_id VARCHAR, 
	story_id VARCHAR, 
	member_id VARCHAR, 
	kind VARCHAR NOT NULL, 
	title VARCHAR NOT NULL, 
	why VARCHAR DEFAULT '' NOT NULL, 
	ref VARCHAR DEFAULT '{}' NOT NULL, 
	state VARCHAR DEFAULT 'in_effect' NOT NULL, 
	overridden_by VARCHAR, 
	overridden_at VARCHAR, 
	override_note VARCHAR, 
	at VARCHAR NOT NULL, 
	PRIMARY KEY (id)
)",
    )
    .await?;
    ops::exec(conn, r"CREATE INDEX ix_ai_decision_project_id ON ai_decision (project_id)").await?;
    ops::exec(conn, r"CREATE INDEX ix_ai_decision_ticket_id ON ai_decision (ticket_id)").await?;
    ops::exec(conn, r"CREATE INDEX ix_ai_decision_story_id ON ai_decision (story_id)").await?;
    ops::exec(conn, r"CREATE INDEX ix_ai_decision_at ON ai_decision (at)").await?;
    Ok(())
}
