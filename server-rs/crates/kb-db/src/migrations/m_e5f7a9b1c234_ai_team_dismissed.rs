//! `server/alembic/versions/e5f7a9b1c234_ai_team_dismissed.py`
//!
//! ai_team_dismissed: suggestions dismissed in AI Team › Health

use sea_orm::ConnectionTrait;

use super::ops::{self, StepResult};

/// `upgrade()` of revision `e5f7a9b1c234`.
pub(super) async fn upgrade<C: ConnectionTrait>(conn: &C) -> StepResult {
    ops::exec(conn, r"ALTER TABLE ai_project_settings ADD COLUMN team_dismissed VARCHAR DEFAULT '[]' NOT NULL").await?;
    Ok(())
}
