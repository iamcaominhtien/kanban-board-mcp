//! `server/alembic/versions/e8b0d2f4a6c9_board_lookup_indexes.py`
//!
//! Indexes for the board's most frequent lookups: a project's members, a project's tickets (by status), a ticket's
//! children and assignee, a docs page's children
//!
//! Every screen reads members by project (more than 90 queries filter on member.project_id) and the board reads tickets
//! by project; without an index each one scanned the whole table. Additive and safe to run again.

use sea_orm::ConnectionTrait;

use super::ops::{self, StepResult};

const INDEXES: [(&str, &str, &[&str]); 5] = [
    ("ix_member_project_id", "member", &["project_id"]),
    ("ix_ticket_project_status", "ticket", &["project_id", "status"]),
    ("ix_ticket_parent_id", "ticket", &["parent_id"]),
    ("ix_ticket_assignee", "ticket", &["assignee"]),
    ("ix_docs_page_parent_id", "docs_page", &["parent_id"]),
];

/// `upgrade()` of revision `e8b0d2f4a6c9`.
pub(super) async fn upgrade<C: ConnectionTrait>(conn: &C) -> StepResult {
    for (name, table, columns) in INDEXES {
        ops::create_index_if_missing(conn, name, table, columns).await?;
    }
    Ok(())
}
