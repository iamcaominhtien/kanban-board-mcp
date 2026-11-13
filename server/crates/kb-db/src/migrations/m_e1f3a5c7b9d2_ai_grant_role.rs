//! `server/alembic/versions/e1f3a5c7b9d2_ai_grant_role.py`
//!
//! A remembered answer can cover every AI member with a role (issue #275: "always for this role")

use sea_orm::ConnectionTrait;

use super::ops::{self, StepResult};

/// `upgrade()` of revision `e1f3a5c7b9d2`.
pub(super) async fn upgrade<C: ConnectionTrait>(conn: &C) -> StepResult {
    ops::exec(conn, r"ALTER TABLE ai_grant ADD COLUMN role VARCHAR").await?;
    ops::exec(conn, r"CREATE INDEX ix_ai_grant_role ON ai_grant (role)").await?;
    Ok(())
}
