//! `server/alembic/versions/1e1bb4aa5fa4_merge_multiple_heads.py`
//!
//! merge_multiple_heads

use sea_orm::ConnectionTrait;

use super::ops::StepResult;

/// `upgrade()` of revision `1e1bb4aa5fa4`.
pub(super) async fn upgrade<C: ConnectionTrait>(_conn: &C) -> StepResult {
    Ok(())
}
