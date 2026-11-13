//! `server/alembic/versions/46d50ad33691_fix_idea_status_and_color_values.py`
//!
//! fix_idea_status_and_color_values

use sea_orm::ConnectionTrait;

use super::ops::{self, StepResult, Table};

/// `upgrade()` of revision `46d50ad33691`.
pub(super) async fn upgrade<C: ConnectionTrait>(conn: &C) -> StepResult {
    ops::exec(conn, r"UPDATE idea_ticket SET idea_status = 'in_review' WHERE idea_status IN ('brewing', 'validated')")
        .await?;
    ops::exec(conn, r"UPDATE idea_ticket SET idea_status = 'draft' WHERE idea_status = 'raw'").await?;
    ops::exec(conn, r"UPDATE idea_ticket SET idea_color = 'yellow' WHERE idea_color NOT IN ('yellow','orange','lime','pink','blue','purple','teal')").await?;
    // Fix server_default on idea_status column: SQLite cannot change a default in place, the table is written again
    let mut table = Table::reflect(conn, "idea_ticket").await?;
    table.column("idea_status")?.default = Some("'draft'".to_string());
    table.rebuild(conn).await?;
    Ok(())
}
