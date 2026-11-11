//! Bringing an existing database from an older revision to the head.
//!
//! The Python server ran its Alembic chain here. The port of the chain is phase P6 of the migration plan
//! (`docs/specs/rust-migration.md`); until then a database that is not at head is refused, never changed.

use sea_orm::ConnectionTrait;

use crate::database::{DatabaseError, SchemaError};
use crate::schema;

/// Apply the migrations the database has not had yet.
pub async fn upgrade<C: ConnectionTrait>(conn: &C) -> Result<(), DatabaseError> {
    let current = schema::current_revisions(conn).await?;
    let head = schema::head_revision();
    if current.len() == 1 && current[0] == head {
        return Ok(());
    }
    Err(SchemaError {
        code: "older",
        message: format!(
            "This database is at migration {} and this build cannot upgrade it yet (head is {head}).",
            current.first().map(String::as_str).unwrap_or("(none)")
        ),
    }
    .into())
}
