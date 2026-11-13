//! `server/alembic/versions/a8b9c0d1e2f3_add_sub_tasks.py`
//!
//! add_sub_tasks

use sea_orm::ConnectionTrait;

use super::ops::{self, StepResult};

/// `upgrade()` of revision `a8b9c0d1e2f3`.
pub(super) async fn upgrade<C: ConnectionTrait>(conn: &C) -> StepResult {
    ops::exec(conn, r"ALTER TABLE ticket ADD COLUMN sub_tasks VARCHAR DEFAULT '[]' NOT NULL").await?;
    Ok(())
}
