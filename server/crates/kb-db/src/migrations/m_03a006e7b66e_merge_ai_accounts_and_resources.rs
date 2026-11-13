//! `server/alembic/versions/03a006e7b66e_merge_ai_accounts_and_resources.py`
//!
//! merge ai accounts and resources

use sea_orm::ConnectionTrait;

use super::ops::StepResult;

/// `upgrade()` of revision `03a006e7b66e`.
pub(super) async fn upgrade<C: ConnectionTrait>(_conn: &C) -> StepResult {
    Ok(())
}
