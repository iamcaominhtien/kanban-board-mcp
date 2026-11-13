//! `server/alembic/versions/b2c3d4e5f6a7_add_wont_do_reason.py`
//!
//! add_wont_do_reason

use sea_orm::ConnectionTrait;

use super::ops::{self, StepResult};

/// `upgrade()` of revision `b2c3d4e5f6a7`.
pub(super) async fn upgrade<C: ConnectionTrait>(conn: &C) -> StepResult {
    ops::exec(conn, r"ALTER TABLE ticket ADD COLUMN wont_do_reason VARCHAR").await?;
    Ok(())
}
