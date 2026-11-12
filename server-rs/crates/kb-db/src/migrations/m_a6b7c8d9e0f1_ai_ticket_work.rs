//! `server/alembic/versions/a6b7c8d9e0f1_ai_ticket_work.py`
//!
//! AI work on tickets: pause, a second AI waiting for the hold, raised limits, answer feedback, stop codes.

use sea_orm::ConnectionTrait;

use super::ops::{self, StepResult};

/// `upgrade()` of revision `a6b7c8d9e0f1`.
pub(super) async fn upgrade<C: ConnectionTrait>(conn: &C) -> StepResult {
    ops::exec(conn, r"DROP INDEX ux_ai_run_ticket_hold").await?;
    // batch_alter_table("ai_run"): Alembic rebuilt the table for these columns; the table is the same with ADD COLUMN
    ops::exec(conn, r"ALTER TABLE ai_run ADD COLUMN paused BOOLEAN DEFAULT 0 NOT NULL").await?;
    ops::exec(conn, r"ALTER TABLE ai_run ADD COLUMN paused_at VARCHAR").await?;
    ops::exec(conn, r"ALTER TABLE ai_run ADD COLUMN behind_run_id VARCHAR").await?;
    ops::exec(conn, r"ALTER TABLE ai_run ADD COLUMN queue_after_current BOOLEAN DEFAULT 0 NOT NULL").await?;
    ops::exec(conn, r"ALTER TABLE ai_run ADD COLUMN limit_min INTEGER").await?;
    ops::exec(conn, r"ALTER TABLE ai_run ADD COLUMN replaces_comment_id VARCHAR").await?;
    ops::exec(conn, r"ALTER TABLE ai_run ADD COLUMN feedback VARCHAR").await?;
    ops::exec(conn, r"ALTER TABLE ai_run ADD COLUMN stop_code VARCHAR").await?;
    ops::exec(conn, r"ALTER TABLE ai_run ADD COLUMN blocked_move VARCHAR").await?;
    ops::exec(conn, r"ALTER TABLE ai_run ADD COLUMN context_notes VARCHAR DEFAULT '[]' NOT NULL").await?;
    ops::exec(conn, r"CREATE UNIQUE INDEX ux_ai_run_ticket_hold ON ai_run (ticket_id) WHERE mode = 'work' AND behind_run_id IS NULL AND state IN ('queued', 'starting', 'running', 'needs_input')").await?;
    Ok(())
}
