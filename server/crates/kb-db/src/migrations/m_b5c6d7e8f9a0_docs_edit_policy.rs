//! `server/alembic/versions/b5c6d7e8f9a0_docs_edit_policy.py`
//!
//! docs_edit_policy on project; docs_comment_event.page_id nullable (access requests)

use sea_orm::ConnectionTrait;

use super::ops::{self, StepResult, Table};

/// `upgrade()` of revision `b5c6d7e8f9a0`.
pub(super) async fn upgrade<C: ConnectionTrait>(conn: &C) -> StepResult {
    ops::exec(conn, r"ALTER TABLE project ADD COLUMN docs_edit_policy VARCHAR DEFAULT 'members' NOT NULL").await?;
    // docs_comment_event.page_id becomes nullable (access requests have no page): the table is written again
    let mut table = Table::reflect(conn, "docs_comment_event").await?;
    table.column("page_id")?.not_null = false;
    table.rebuild(conn).await?;
    Ok(())
}
