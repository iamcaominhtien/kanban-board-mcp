//! `server/alembic/versions/c8d9e0f1a2b3_ai_member_projects.py`
//!
//! One AI member in several projects: a copy links to the original.

use sea_orm::ConnectionTrait;

use super::ops::{self, StepResult};

/// `upgrade()` of revision `c8d9e0f1a2b3`.
pub(super) async fn upgrade<C: ConnectionTrait>(conn: &C) -> StepResult {
    ops::exec(conn, r"ALTER TABLE ai_member ADD COLUMN linked_to VARCHAR").await?;
    ops::exec(conn, r"CREATE INDEX ix_ai_member_linked_to ON ai_member (linked_to)").await?;
    Ok(())
}
