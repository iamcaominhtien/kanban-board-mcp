//! `server/alembic/versions/c5d7e9f1a3b6_ai_team_manager.py`
//!
//! AI team manager: a workflow keeps what the board decided along the way (the quota allowance after a person let it
//! go on, a test-first send-back, a split) in one JSON column.

use sea_orm::ConnectionTrait;

use super::ops::{self, StepResult};

/// `upgrade()` of revision `c5d7e9f1a3b6`.
pub(super) async fn upgrade<C: ConnectionTrait>(conn: &C) -> StepResult {
    ops::add_missing_columns(conn, "ai_ticket_workflow", &[("meta", "VARCHAR DEFAULT '{}' NOT NULL")]).await?;
    Ok(())
}
