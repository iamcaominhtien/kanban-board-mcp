//! `server/alembic/versions/e5f6a7b8c9d0_add_links.py`
//!
//! add_links

use sea_orm::ConnectionTrait;

use super::ops::{self, StepResult};

/// `upgrade()` of revision `e5f6a7b8c9d0`.
pub(super) async fn upgrade<C: ConnectionTrait>(conn: &C) -> StepResult {
    ops::exec(conn, r"ALTER TABLE ticket ADD COLUMN links VARCHAR DEFAULT '[]' NOT NULL").await?;
    Ok(())
}
