//! `server/alembic/versions/f7b9d1e3a5c7_ai_run_depth.py`
//!
//! AI runs: how many AI-to-AI hand-offs lie behind a run (KBM-24).
//!
//! A note an AI sends (`ai_run message`, the Board AI routing Docs threads, a team writing to a page) starts a run one
//! deeper than its sender; the send is refused at `runs.MAX_DEPTH`, so AIs cannot keep each other busy. A person's run is 0.

use sea_orm::ConnectionTrait;

use super::ops::{self, StepResult, Types};

/// `upgrade()` of revision `f7b9d1e3a5c7`: add the column unless a database made from the models already has it.
pub(super) async fn upgrade<C: ConnectionTrait>(conn: &C) -> StepResult {
    let depth = format!("INTEGER {}", Types::of(conn).not_null_default("'0'"));
    ops::add_missing_columns(conn, "ai_run", &[("depth", &depth)]).await?;
    Ok(())
}
