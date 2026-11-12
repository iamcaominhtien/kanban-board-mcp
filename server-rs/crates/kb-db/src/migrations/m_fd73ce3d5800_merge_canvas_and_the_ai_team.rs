//! `server/alembic/versions/fd73ce3d5800_merge_canvas_and_the_ai_team.py`
//!
//! merge canvas and the AI team

use sea_orm::ConnectionTrait;

use super::ops::StepResult;

/// `upgrade()` of revision `fd73ce3d5800`.
pub(super) async fn upgrade<C: ConnectionTrait>(_conn: &C) -> StepResult {
    Ok(())
}
