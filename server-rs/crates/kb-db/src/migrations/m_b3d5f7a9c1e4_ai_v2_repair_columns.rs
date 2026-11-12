//! `server/alembic/versions/b3d5f7a9c1e4_ai_v2_repair_columns.py`
//!
//! AI v2 repair: add the columns a pre-release run of the AI v2 reset did not make yet.
//!
//! The reset migration (a2b4c6d8e0f1) gained `ai_run.live`, `ai_run.waiting_reason`, `ai_run_agent.claude_id`,
//! `ai_run_step.tool_id` and its index after a development build had already applied it to one database (2026-11-05).
//! A database made by the final reset already has them: this adds only what is missing.

use sea_orm::ConnectionTrait;

use super::ops::{self, StepResult, Types};

/// `upgrade()` of revision `b3d5f7a9c1e4`: add each missing column, then the index on ai_run_step.tool_id.
pub(super) async fn upgrade<C: ConnectionTrait>(conn: &C) -> StepResult {
    let types = Types::of(conn);
    // `server_default=sa.false()`
    let no = if ops::dialect(conn) == "sqlite" { "0" } else { "false" };
    let live = format!("{} {}", types.b, types.not_null_default(no));
    let columns: [(&str, &str, &str); 4] = [
        ("ai_run", "live", &live),
        ("ai_run", "waiting_reason", types.t),
        ("ai_run_agent", "claude_id", types.t),
        ("ai_run_step", "tool_id", types.t),
    ];
    for (table, column, definition) in columns {
        if !ops::has_table(conn, table).await? {
            continue;
        }
        ops::add_missing_columns(conn, table, &[(column, definition)]).await?;
    }
    if ops::has_table(conn, "ai_run_step").await? {
        ops::create_index_if_missing(conn, "ix_ai_run_step_tool_id", "ai_run_step", &["tool_id"]).await?;
    }
    Ok(())
}
