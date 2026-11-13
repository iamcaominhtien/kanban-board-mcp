//! `server/alembic/versions/b3c4d5e6f7a8_add_branches_column.py`
//!
//! add_branches_column

use sea_orm::ConnectionTrait;

use super::ops::{self, StepResult};

/// `upgrade()` of revision `b3c4d5e6f7a8`.
pub(super) async fn upgrade<C: ConnectionTrait>(conn: &C) -> StepResult {
    ops::exec(conn, r"ALTER TABLE ticket ADD COLUMN branches VARCHAR DEFAULT '[]' NOT NULL").await?;
    Ok(())
}
