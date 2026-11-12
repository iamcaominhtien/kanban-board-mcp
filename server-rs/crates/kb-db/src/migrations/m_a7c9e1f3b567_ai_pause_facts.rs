//! `server/alembic/versions/a7c9e1f3b567_ai_pause_facts.py`
//!
//! ai_pause_facts: what Pause all AI chose, saved for the banner and for Resume

use sea_orm::ConnectionTrait;

use super::ops::{self, StepResult};

/// `upgrade()` of revision `a7c9e1f3b567`.
pub(super) async fn upgrade<C: ConnectionTrait>(conn: &C) -> StepResult {
    ops::exec(conn, r"ALTER TABLE ai_project_settings ADD COLUMN paused_let_finish BOOLEAN DEFAULT '0' NOT NULL").await?;
    ops::exec(conn, r"ALTER TABLE ai_project_settings ADD COLUMN paused_safe_before BOOLEAN DEFAULT '0' NOT NULL").await?;
    Ok(())
}
