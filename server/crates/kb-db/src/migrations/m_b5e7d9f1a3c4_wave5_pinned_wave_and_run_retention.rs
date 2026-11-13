//! `server/alembic/versions/b5e7d9f1a3c4_wave5_pinned_wave_and_run_retention.py`
//!
//! wave 5: a sub-ticket's pinned execution wave (TDP-1) and the run history retention (OPS-7)
//!
//! Both columns are nullable and start empty for every existing row: a ticket with no pinned wave computes it from
//! Blocked by, and a project with no run retention keeps every run forever, as before.

use sea_orm::ConnectionTrait;

use super::ops::{self, StepResult};

/// `upgrade()` of revision `b5e7d9f1a3c4`.
pub(super) async fn upgrade<C: ConnectionTrait>(conn: &C) -> StepResult {
    ops::exec(conn, r"ALTER TABLE ticket ADD COLUMN wave_pin INTEGER").await?;
    ops::exec(conn, r"ALTER TABLE ai_project_settings ADD COLUMN run_retention_days INTEGER").await?;
    Ok(())
}
