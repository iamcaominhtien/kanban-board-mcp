//! `server/alembic/versions/8f3a9c2d1e4b_add_blocks_blocked_by.py`
//!
//! add_blocks_blocked_by

use sea_orm::ConnectionTrait;

use super::ops::StepResult;

/// `upgrade()` of revision `8f3a9c2d1e4b`.
pub(super) async fn upgrade<C: ConnectionTrait>(_conn: &C) -> StepResult {
    // columns added by 9a4b5c6d7e8f
    Ok(())
}
