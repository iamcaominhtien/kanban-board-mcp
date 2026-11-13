//! `server/alembic/versions/d5f7b9c1e3a4_ai_chat_seen_at.py`
//!
//! AI v2: when the owner of a ticket chat last had it open.
//!
//! The chat page tells the board every ~15 s while it is open and in front of the person. A run a chat message started
//! that ends in that time does not send an "AI finished" notice: the answer is already on the screen.

use sea_orm::ConnectionTrait;

use super::ops::{self, StepResult, Types};

/// `upgrade()` of revision `d5f7b9c1e3a4`: add the column unless a database made from the models already has it.
pub(super) async fn upgrade<C: ConnectionTrait>(conn: &C) -> StepResult {
    ops::add_missing_columns(conn, "ai_chat", &[("seen_at", Types::of(conn).s)]).await?;
    Ok(())
}
