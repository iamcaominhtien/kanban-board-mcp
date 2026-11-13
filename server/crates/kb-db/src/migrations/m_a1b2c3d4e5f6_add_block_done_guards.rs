//! `server/alembic/versions/a1b2c3d4e5f6_add_block_done_guards.py`
//!
//! feat: add block_done_if_acs_incomplete and block_done_if_tcs_incomplete to ticket

use sea_orm::ConnectionTrait;

use super::ops::{self, StepResult};

/// `upgrade()` of revision `a1b2c3d4e5f6`.
pub(super) async fn upgrade<C: ConnectionTrait>(conn: &C) -> StepResult {
    // only the columns an existing database lacks. Alembic rebuilt the table for them (a default written as an
    // expression); the table is the same with ADD COLUMN
    ops::add_missing_columns(
        conn,
        "ticket",
        &[
            ("block_done_if_acs_incomplete", "BOOLEAN DEFAULT 0 NOT NULL"),
            ("block_done_if_tcs_incomplete", "BOOLEAN DEFAULT 0 NOT NULL"),
        ],
    )
    .await?;
    Ok(())
}
