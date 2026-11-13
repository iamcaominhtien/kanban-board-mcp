//! `server/alembic/versions/d4e6f8a0b123_ai_origin.py`
//!
//! ai_origin: where a person's decision or run start came from (a tool acting for them)

use sea_orm::ConnectionTrait;

use super::ops::{self, StepResult};

/// `upgrade()` of revision `d4e6f8a0b123`.
pub(super) async fn upgrade<C: ConnectionTrait>(conn: &C) -> StepResult {
    ops::exec(conn, r"ALTER TABLE ai_approval ADD COLUMN decided_via VARCHAR").await?;
    ops::exec(conn, r"ALTER TABLE ai_run ADD COLUMN started_via VARCHAR").await?;
    Ok(())
}
