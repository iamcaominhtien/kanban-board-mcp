//! `server/alembic/versions/c1d2e3f4a5b7_canvas_pin_anchor.py`
//!
//! canvas_thread.anchor: a comment pin remembers the element it was put on, not only a position

use sea_orm::ConnectionTrait;

use super::ops::{self, StepResult};

/// `upgrade()` of revision `c1d2e3f4a5b7`.
pub(super) async fn upgrade<C: ConnectionTrait>(conn: &C) -> StepResult {
    ops::exec(conn, r"ALTER TABLE canvas_thread ADD COLUMN anchor VARCHAR").await?;
    Ok(())
}
