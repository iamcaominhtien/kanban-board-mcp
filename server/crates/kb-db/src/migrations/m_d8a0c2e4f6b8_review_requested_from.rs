//! `server/alembic/versions/d8a0c2e4f6b8_review_requested_from.py`
//!
//! ticket.review_requested_from: whose review a ticket in Review waits for (issue #269, MainBoard Review column)
//!
//! Nullable and empty for every existing ticket: a card shows "Review requested — Name" only once it is set.

use sea_orm::ConnectionTrait;

use super::ops::{self, StepResult};

/// `upgrade()` of revision `d8a0c2e4f6b8`.
pub(super) async fn upgrade<C: ConnectionTrait>(conn: &C) -> StepResult {
    ops::exec(conn, r"ALTER TABLE ticket ADD COLUMN review_requested_from VARCHAR").await?;
    Ok(())
}
