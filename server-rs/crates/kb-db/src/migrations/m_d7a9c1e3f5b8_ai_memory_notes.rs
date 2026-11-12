//! `server/alembic/versions/d7a9c1e3f5b8_ai_memory_notes.py`
//!
//! Issue #274: notes an AI keeps across runs (per role, member or ticket), and what memory a run's prompt carried
//!
//! Additive: a new table, and a nullable column on ai_run that every existing run starts with empty.

use sea_orm::ConnectionTrait;

use super::ops::{self, StepResult};

/// `upgrade()` of revision `d7a9c1e3f5b8`.
pub(super) async fn upgrade<C: ConnectionTrait>(conn: &C) -> StepResult {
    ops::exec(conn, r"CREATE TABLE ai_memory_note (
	id VARCHAR NOT NULL, 
	project_id VARCHAR NOT NULL, 
	scope VARCHAR NOT NULL, 
	scope_key VARCHAR NOT NULL, 
	text VARCHAR NOT NULL, 
	kind VARCHAR NOT NULL, 
	written_by VARCHAR, 
	source_run_id VARCHAR, 
	source_ticket_id VARCHAR, 
	uses INTEGER NOT NULL, 
	last_used_at VARCHAR, 
	created_at VARCHAR NOT NULL, 
	updated_at VARCHAR NOT NULL, 
	PRIMARY KEY (id)
)").await?;
    ops::exec(conn, r"CREATE INDEX ix_ai_memory_note_project_id ON ai_memory_note (project_id)").await?;
    ops::exec(conn, r"CREATE INDEX ix_ai_memory_note_scope ON ai_memory_note (scope)").await?;
    ops::exec(conn, r"CREATE INDEX ix_ai_memory_note_scope_key ON ai_memory_note (scope_key)").await?;
    ops::exec(conn, r"ALTER TABLE ai_run ADD COLUMN memory_used VARCHAR").await?;
    Ok(())
}
