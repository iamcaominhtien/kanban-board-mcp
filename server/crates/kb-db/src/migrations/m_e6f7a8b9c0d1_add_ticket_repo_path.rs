//! `server/alembic/versions/e6f7a8b9c0d1_add_ticket_repo_path.py`
//!
//! add_ticket_repo_path

use sea_orm::ConnectionTrait;

use super::ops::{self, StepResult};

/// `upgrade()` of revision `e6f7a8b9c0d1`.
pub(super) async fn upgrade<C: ConnectionTrait>(conn: &C) -> StepResult {
    ops::exec(conn, r"ALTER TABLE ticket ADD COLUMN repo_path VARCHAR").await?;
    Ok(())
}
