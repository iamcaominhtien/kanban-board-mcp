//! `server/alembic/versions/a7c9e1f3b5d8_ai_repo_scan_job.py`
//!
//! ai_repo_scan_job: the AI setting up a project's commands (its job and its proposal)

use sea_orm::ConnectionTrait;

use super::ops::{self, StepResult};

/// `upgrade()` of revision `a7c9e1f3b5d8`.
pub(super) async fn upgrade<C: ConnectionTrait>(conn: &C) -> StepResult {
    ops::exec(conn, r"ALTER TABLE ai_repo_scan ADD COLUMN job VARCHAR DEFAULT '{}' NOT NULL").await?;
    ops::exec(conn, r"ALTER TABLE ai_repo_scan ADD COLUMN proposal VARCHAR DEFAULT '{}' NOT NULL").await?;
    Ok(())
}
