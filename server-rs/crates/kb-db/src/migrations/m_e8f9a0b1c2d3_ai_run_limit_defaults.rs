//! `server/alembic/versions/e8f9a0b1c2d3_ai_run_limit_defaults.py`
//!
//! ai: run limits apply to scheduled and AI-started runs only (new defaults: 15 per ticket, 100 per board); a Board AI
//! chat keeps one Claude Code session (ai_chat.session_id)

use sea_orm::ConnectionTrait;

use super::ops::{self, StepResult};

/// `upgrade()` of revision `e8f9a0b1c2d3`.
pub(super) async fn upgrade<C: ConnectionTrait>(conn: &C) -> StepResult {
    ops::exec(conn, r"ALTER TABLE ai_chat ADD COLUMN session_id VARCHAR").await?;
    ops::exec(conn, r"UPDATE ai_project_settings SET runs_per_ticket_per_day = 15 WHERE runs_per_ticket_per_day = 6").await?;
    ops::exec(conn, r"UPDATE ai_project_settings SET board_runs_per_day = 100 WHERE board_runs_per_day = 60").await?;
    Ok(())
}
