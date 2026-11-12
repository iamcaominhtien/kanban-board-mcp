//! `server/alembic/versions/d5e6f7a8b9c0_add_project_repo_path.py`
//!
//! add_project_repo_path

use sea_orm::ConnectionTrait;

use super::ops::{self, StepResult};

/// `upgrade()` of revision `d5e6f7a8b9c0`.
pub(super) async fn upgrade<C: ConnectionTrait>(conn: &C) -> StepResult {
    ops::exec(conn, r"ALTER TABLE project ADD COLUMN repo_path VARCHAR").await?;
    Ok(())
}
