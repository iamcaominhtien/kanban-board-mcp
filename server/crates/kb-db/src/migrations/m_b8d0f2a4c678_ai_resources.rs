//! `server/alembic/versions/b8d0f2a4c678_ai_resources.py`
//!
//! ai_resources: RAM of a run's CLI (peak, last, restarts), the memory limit and a member's resource tools

use sea_orm::ConnectionTrait;

use super::ops::{self, StepResult};

/// `upgrade()` of revision `b8d0f2a4c678`.
pub(super) async fn upgrade<C: ConnectionTrait>(conn: &C) -> StepResult {
    ops::exec(conn, r"ALTER TABLE ai_run ADD COLUMN peak_rss_mb FLOAT").await?;
    ops::exec(conn, r"ALTER TABLE ai_run ADD COLUMN last_rss_mb FLOAT").await?;
    ops::exec(conn, r"ALTER TABLE ai_run ADD COLUMN restarts VARCHAR DEFAULT '[]' NOT NULL").await?;
    ops::exec(conn, r"ALTER TABLE ai_member ADD COLUMN resource_access VARCHAR DEFAULT 'none' NOT NULL").await?;
    ops::exec(conn, r"ALTER TABLE ai_project_settings ADD COLUMN run_memory_limit_mb INTEGER DEFAULT '4096' NOT NULL")
        .await?;
    Ok(())
}
