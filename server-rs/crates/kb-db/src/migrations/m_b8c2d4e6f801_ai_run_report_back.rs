//! `server/alembic/versions/b8c2d4e6f801_ai_run_report_back.py`
//!
//! ai_run_report_back

use sea_orm::ConnectionTrait;

use super::ops::{self, StepResult};

/// `upgrade()` of revision `b8c2d4e6f801`.
pub(super) async fn upgrade<C: ConnectionTrait>(conn: &C) -> StepResult {
    ops::exec(conn, r"ALTER TABLE ai_run ADD COLUMN report_back VARCHAR").await?;
    Ok(())
}
