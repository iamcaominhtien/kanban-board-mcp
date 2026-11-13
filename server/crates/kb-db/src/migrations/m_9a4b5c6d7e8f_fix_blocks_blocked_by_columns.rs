//! `server/alembic/versions/9a4b5c6d7e8f_fix_blocks_blocked_by_columns.py`
//!
//! fix: add blocks and blocked_by columns for existing databases

use sea_orm::ConnectionTrait;

use super::ops::{self, StepResult};

/// `upgrade()` of revision `9a4b5c6d7e8f`.
pub(super) async fn upgrade<C: ConnectionTrait>(conn: &C) -> StepResult {
    // only the columns an existing database lacks
    ops::add_missing_columns(
        conn,
        "ticket",
        &[("blocks", "VARCHAR DEFAULT '[]' NOT NULL"), ("blocked_by", "VARCHAR DEFAULT '[]' NOT NULL")],
    )
    .await?;
    Ok(())
}
