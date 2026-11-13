//! `server/alembic/versions/a2b3c4d5e6f7_add_idea_ticket_promoted_unique.py`
//!
//! add_idea_ticket_promoted_unique

use sea_orm::ConnectionTrait;

use super::ops::{StepResult, Table};

/// `upgrade()` of revision `a2b3c4d5e6f7`.
pub(super) async fn upgrade<C: ConnectionTrait>(conn: &C) -> StepResult {
    // a UNIQUE constraint cannot be added to a SQLite table: the table is written again, as Alembic's batch mode did
    let mut table = Table::reflect(conn, "idea_ticket").await?;
    table
        .uniques
        .push((Some("uq_idea_ticket_promoted_to_ticket_id".to_string()), vec!["promoted_to_ticket_id".to_string()]));
    table.rebuild(conn).await?;
    Ok(())
}
