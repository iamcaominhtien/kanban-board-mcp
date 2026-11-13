//! `server/alembic/versions/d4e5f6a7b8c9_add_start_date.py`
//!
//! add_start_date

use sea_orm::ConnectionTrait;

use super::ops::{self, StepResult};

/// `upgrade()` of revision `d4e5f6a7b8c9`.
pub(super) async fn upgrade<C: ConnectionTrait>(conn: &C) -> StepResult {
    ops::exec(conn, r"ALTER TABLE ticket ADD COLUMN start_date VARCHAR").await?;
    Ok(())
}
