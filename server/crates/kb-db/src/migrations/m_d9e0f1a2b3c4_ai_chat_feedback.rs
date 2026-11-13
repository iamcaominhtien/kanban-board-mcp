//! `server/alembic/versions/d9e0f1a2b3c4_ai_chat_feedback.py`
//!
//! Thumbs up / down on Board AI answers.

use sea_orm::ConnectionTrait;

use super::ops::{self, StepResult};

/// `upgrade()` of revision `d9e0f1a2b3c4`.
pub(super) async fn upgrade<C: ConnectionTrait>(conn: &C) -> StepResult {
    ops::exec(conn, r"ALTER TABLE ai_chat_message ADD COLUMN feedback VARCHAR DEFAULT '{}' NOT NULL").await?;
    Ok(())
}
