//! `server/alembic/versions/d1e2f3a4b5c6_add_reopen_and_pending_fields.py`
//!
//! add_reopen_and_pending_fields

use sea_orm::ConnectionTrait;

use super::ops::{self, StepResult};

/// `upgrade()` of revision `d1e2f3a4b5c6`.
pub(super) async fn upgrade<C: ConnectionTrait>(conn: &C) -> StepResult {
    // batch_alter_table("ticket"): Alembic rebuilt the table for these columns (their default is written as an
    // expression); ADD COLUMN gives the same table
    ops::exec(conn, r"ALTER TABLE ticket ADD COLUMN reopen_count INTEGER DEFAULT '0' NOT NULL").await?;
    ops::exec(conn, r"ALTER TABLE ticket ADD COLUMN last_reopened_at VARCHAR").await?;
    ops::exec(conn, r"ALTER TABLE ticket ADD COLUMN last_reopened_by VARCHAR").await?;
    ops::exec(conn, r"ALTER TABLE ticket ADD COLUMN last_reopen_reason VARCHAR").await?;
    ops::exec(conn, r"ALTER TABLE ticket ADD COLUMN reopen_history VARCHAR DEFAULT '[]' NOT NULL").await?;
    ops::exec(conn, r"ALTER TABLE ticket ADD COLUMN pending BOOLEAN DEFAULT 0 NOT NULL").await?;
    ops::exec(conn, r"ALTER TABLE ticket ADD COLUMN pending_reason_type VARCHAR").await?;
    ops::exec(conn, r"ALTER TABLE ticket ADD COLUMN pending_ticket_id VARCHAR").await?;
    ops::exec(conn, r"ALTER TABLE ticket ADD COLUMN pending_member_id VARCHAR").await?;
    ops::exec(conn, r"ALTER TABLE ticket ADD COLUMN pending_party VARCHAR").await?;
    ops::exec(conn, r"ALTER TABLE ticket ADD COLUMN pending_note VARCHAR").await?;
    ops::exec(conn, r"ALTER TABLE ticket ADD COLUMN pending_since VARCHAR").await?;
    ops::exec(conn, r"ALTER TABLE ticket ADD COLUMN pending_by VARCHAR").await?;
    Ok(())
}
