//! `server/alembic/versions/c3d5e7f9a012_ai_run_tokens_cached.py`
//!
//! ai_run_tokens_cached

use sea_orm::ConnectionTrait;

use super::ops::{self, StepResult};

/// `upgrade()` of revision `c3d5e7f9a012`.
pub(super) async fn upgrade<C: ConnectionTrait>(conn: &C) -> StepResult {
    ops::exec(conn, r"ALTER TABLE ai_run ADD COLUMN tokens_cached INTEGER").await?;
    Ok(())
}
