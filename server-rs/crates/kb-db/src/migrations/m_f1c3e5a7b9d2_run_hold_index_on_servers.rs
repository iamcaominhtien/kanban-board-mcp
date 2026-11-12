//! `server/alembic/versions/f1c3e5a7b9d2_run_hold_index_on_servers.py`
//!
//! The ticket hold index holds only active work runs on PostgreSQL and MySQL too
//!
//! `ux_ai_run_ticket_hold` was made on PostgreSQL and MySQL without its WHERE (only SQLite's was declared), so it held
//! every run ever made: a ticket that had one AI run could never get a second ("already held by another AI run").
//! PostgreSQL gets the partial index SQLite has; MySQL, which has no partial index, a plain one (create_run checks the
//! hold itself). Nothing changes on SQLite.

use sea_orm::ConnectionTrait;

use super::ops::{self, StepResult};

const NAME: &str = "ux_ai_run_ticket_hold";
const WHERE: &str = "mode = 'work' AND behind_run_id IS NULL \
                     AND state IN ('queued', 'starting', 'running', 'needs_input')";

/// `upgrade()` of revision `f1c3e5a7b9d2`.
pub(super) async fn upgrade<C: ConnectionTrait>(conn: &C) -> StepResult {
    let dialect = ops::dialect(conn);
    if dialect == "sqlite" {
        return Ok(());
    }
    if ops::index_names(conn, "ai_run").await?.iter().any(|name| name == NAME) {
        if dialect == "mysql" {
            ops::exec(conn, &format!("DROP INDEX {NAME} ON ai_run")).await?;
        } else {
            ops::exec(conn, &format!("DROP INDEX {NAME}")).await?;
        }
    }
    if dialect == "postgresql" {
        ops::exec(conn, &format!("CREATE UNIQUE INDEX {NAME} ON ai_run (ticket_id) WHERE {WHERE}")).await?;
    } else {
        ops::exec(conn, &format!("CREATE INDEX {NAME} ON ai_run (ticket_id)")).await?;
    }
    Ok(())
}
