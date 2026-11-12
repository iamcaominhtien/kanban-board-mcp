//! `server/alembic/versions/a3b4c5d6e7f8_ai_where_you_work.py`
//!
//! ai_where_you_work: scoped chats (scope id, chosen member) and a per-project AI switch

use sea_orm::ConnectionTrait;

use super::ops::{self, StepResult};

/// `upgrade()` of revision `a3b4c5d6e7f8`.
pub(super) async fn upgrade<C: ConnectionTrait>(conn: &C) -> StepResult {
    ops::exec(conn, r"ALTER TABLE ai_chat ADD COLUMN scope_id VARCHAR").await?;
    ops::exec(conn, r"ALTER TABLE ai_chat ADD COLUMN member_id VARCHAR").await?;
    ops::exec(conn, r"CREATE INDEX ix_ai_chat_scope_id ON ai_chat (scope_id)").await?;
    // batch_alter_table("ai_project_settings"): Alembic rebuilt the table for these columns; the table is the same with ADD COLUMN
    ops::exec(conn, r"ALTER TABLE ai_project_settings ADD COLUMN ai_enabled BOOLEAN DEFAULT 1 NOT NULL").await?;
    ops::exec(conn, r"UPDATE ai_chat SET scope_id = ticket_id WHERE scope = 'ticket'").await?;
    ops::exec(conn, r"UPDATE ai_chat SET scope_id = doc_id WHERE scope = 'doc'").await?;
    Ok(())
}
