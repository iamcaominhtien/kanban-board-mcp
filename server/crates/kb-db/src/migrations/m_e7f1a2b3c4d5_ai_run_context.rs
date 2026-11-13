//! `server/alembic/versions/e7f1a2b3c4d5_ai_run_context.py`
//!
//! ai_run_context

use sea_orm::ConnectionTrait;

use super::ops::{self, StepResult};

/// `upgrade()` of revision `e7f1a2b3c4d5`.
pub(super) async fn upgrade<C: ConnectionTrait>(conn: &C) -> StepResult {
    ops::exec(conn, r"ALTER TABLE ai_run ADD COLUMN context_used INTEGER").await?;
    ops::exec(conn, r"ALTER TABLE ai_run ADD COLUMN context_window INTEGER").await?;
    Ok(())
}
