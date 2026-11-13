//! `server/alembic/versions/e2a4c6e8b0d1_ai_touch_mark.py`
//!
//! AI v2: the mark a person gives to a touch ("You stepped in" tab: needed | avoidable) and the lesson made from it.
//!
//! One small table, nullable lesson link, nothing else changes. The touches themselves are worked out from runs,
//! messages and the audit log; only the person's mark needs a place to live.

use sea_orm::ConnectionTrait;

use super::ops::Kind::S;
use super::ops::{self, StepResult};

/// `upgrade()` of revision `e2a4c6e8b0d1`: make the table and its index unless a database made from the models
/// already has them.
pub(super) async fn upgrade<C: ConnectionTrait>(conn: &C) -> StepResult {
    ops::create_table_if_missing(
        conn,
        "ai_touch_mark",
        &[
            ("key", S, false),
            ("project_id", S, false),
            ("mark", S, false),
            ("marked_by", S, true),
            ("marked_at", S, false),
            ("lesson_id", S, true),
        ],
        "key",
    )
    .await?;
    ops::create_index_if_missing(conn, "ix_ai_touch_mark_project_id", "ai_touch_mark", &["project_id"]).await?;
    Ok(())
}
