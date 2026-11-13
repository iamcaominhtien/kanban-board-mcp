//! `server/alembic/versions/c6f8a0b2d4e6_ai_run_details_removed_at.py`
//!
//! OPS-7: mark a run whose details (transcript, steps, prompt) the run history retention removed
//!
//! Additive and nullable: every existing run starts with it empty (nothing removed), as before.

use sea_orm::ConnectionTrait;

use super::ops::{self, StepResult};

/// `upgrade()` of revision `c6f8a0b2d4e6`.
pub(super) async fn upgrade<C: ConnectionTrait>(conn: &C) -> StepResult {
    ops::exec(conn, r"ALTER TABLE ai_run ADD COLUMN details_removed_at VARCHAR").await?;
    Ok(())
}
