//! `server/alembic/versions/a3c5e7f9b1d4_ai_ticket_pace.py`
//!
//! Fast mode: a ticket keeps its pace (set without running anything), and its workflow a copy of it
//!
//! Additive: a new table (no row is the normal pace), and a nullable column on ai_ticket_workflow that every existing
//! workflow starts with empty (the normal pace).

use sea_orm::ConnectionTrait;

use super::ops::{self, StepResult};

/// `upgrade()` of revision `a3c5e7f9b1d4`.
pub(super) async fn upgrade<C: ConnectionTrait>(conn: &C) -> StepResult {
    ops::exec(conn, r"ALTER TABLE ai_ticket_workflow ADD COLUMN pace VARCHAR").await?;
    ops::exec(
        conn,
        r"CREATE TABLE ai_ticket_pace (
	ticket_id VARCHAR NOT NULL, 
	project_id VARCHAR NOT NULL, 
	pace VARCHAR NOT NULL, 
	set_by VARCHAR, 
	set_at VARCHAR NOT NULL, 
	PRIMARY KEY (ticket_id)
)",
    )
    .await?;
    ops::exec(conn, r"CREATE INDEX ix_ai_ticket_pace_project_id ON ai_ticket_pace (project_id)").await?;
    Ok(())
}
