//! `server/alembic/versions/f7a8b9c0d1e2_add_project_worktree_settings.py`
//!
//! add_project_worktree_settings

use sea_orm::ConnectionTrait;

use super::ops::{self, StepResult};

/// `upgrade()` of revision `f7a8b9c0d1e2`.
pub(super) async fn upgrade<C: ConnectionTrait>(conn: &C) -> StepResult {
    // batch_alter_table("project"): Alembic rebuilt the table for these columns; the table is the same with ADD COLUMN
    ops::exec(conn, r"ALTER TABLE project ADD COLUMN worktree_template VARCHAR").await?;
    ops::exec(conn, r"ALTER TABLE project ADD COLUMN worktree_by_default BOOLEAN DEFAULT 0 NOT NULL").await?;
    Ok(())
}
