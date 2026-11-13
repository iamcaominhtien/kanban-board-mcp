//! `server/alembic/versions/b7c8d9e0f1a2_ai_auto_trip.py`
//!
//! AI auto-trip rules per project (switches and thresholds).

use sea_orm::ConnectionTrait;

use super::ops::{self, StepResult};

/// `upgrade()` of revision `b7c8d9e0f1a2`.
pub(super) async fn upgrade<C: ConnectionTrait>(conn: &C) -> StepResult {
    ops::exec(conn, r"ALTER TABLE ai_project_settings ADD COLUMN auto_trip VARCHAR DEFAULT '{}' NOT NULL").await?;
    Ok(())
}
