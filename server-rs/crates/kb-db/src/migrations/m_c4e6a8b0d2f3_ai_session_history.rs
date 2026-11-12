//! `server/alembic/versions/c4e6a8b0d2f3_ai_session_history.py`
//!
//! AI v2: the history of a team's conversations on a ticket.
//!
//! A team's lead keeps one Claude Code conversation on a ticket. When a person starts it over, the old one is closed into a
//! row here: a title, a summary and the ids of its sessions and runs. Other AIs read these rows (`ai_run` action `history`)
//! and a new conversation is told of the last ones.

use sea_orm::ConnectionTrait;

use super::ops::Kind::{S, T};
use super::ops::{self, StepResult};

/// `upgrade()` of revision `c4e6a8b0d2f3`: make the table and its indexes unless a database made from the models
/// already has them.
pub(super) async fn upgrade<C: ConnectionTrait>(conn: &C) -> StepResult {
    ops::create_table_if_missing(
        conn,
        "ai_session_history",
        &[
            ("id", S, false),
            ("project_id", S, false),
            ("ticket_id", S, false),
            ("member_id", S, false),
            ("title", T, false),
            ("summary", T, false),
            ("session_ids", T, false),
            ("run_ids", T, false),
            ("started_at", T, true),
            ("ended_at", T, false),
            ("created_by", T, false),
            ("summarised_by", T, false),
        ],
        "id",
    )
    .await?;
    ops::create_index_if_missing(conn, "ix_ai_session_history_project_id", "ai_session_history", &["project_id"])
        .await?;
    ops::create_index_if_missing(conn, "ix_ai_session_history_ticket_id", "ai_session_history", &["ticket_id"]).await?;
    Ok(())
}
