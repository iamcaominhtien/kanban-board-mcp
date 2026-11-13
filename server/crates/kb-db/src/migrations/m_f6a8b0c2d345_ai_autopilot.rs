//! `server/alembic/versions/f6a8b0c2d345_ai_autopilot.py`
//!
//! ai_autopilot: ask-before-Docs-edits switch and the Autopilot delegation

use sea_orm::ConnectionTrait;

use super::ops::{self, StepResult};

/// `upgrade()` of revision `f6a8b0c2d345`.
pub(super) async fn upgrade<C: ConnectionTrait>(conn: &C) -> StepResult {
    ops::exec(conn, r"ALTER TABLE ai_project_settings ADD COLUMN docs_edits_ask BOOLEAN DEFAULT '0' NOT NULL").await?;
    ops::exec(conn, r"ALTER TABLE ai_project_settings ADD COLUMN autopilot VARCHAR DEFAULT '{}' NOT NULL").await?;
    Ok(())
}
