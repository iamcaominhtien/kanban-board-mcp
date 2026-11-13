//! `server/alembic/versions/c4e6a8b0d2f1_repair_docs_ai_ignore.py`
//!
//! Repair: create docs_ai_ignore on databases whose docs_ai migration ran before that table was part of it
//!
//! A pre-release build ran revision a1d0c5a1b2c3 without docs_ai_ignore, and alembic never runs a revision twice, so those
//! databases have the other Docs AI tables but not this one. Deleting a project ran
//! ``DELETE FROM docs_ai_ignore ...`` and failed with "no such table" (a 500); "Check this page" ignores would fail the same.
//!
//! Idempotent: a database that already has the table is left alone.

use sea_orm::ConnectionTrait;

use super::ops::{self, StepResult};

/// `upgrade()` of revision `c4e6a8b0d2f1`.
pub(super) async fn upgrade<C: ConnectionTrait>(conn: &C) -> StepResult {
    // Idempotent: a database that already has the table is left alone.
    if ops::has_table(conn, "docs_ai_ignore").await? {
        return Ok(());
    }
    ops::exec(
        conn,
        r#"CREATE TABLE docs_ai_ignore (
	page_id VARCHAR NOT NULL, 
	"key" VARCHAR NOT NULL, 
	"by" VARCHAR DEFAULT 'user' NOT NULL, 
	at VARCHAR NOT NULL, 
	PRIMARY KEY (page_id, "key")
)"#,
    )
    .await?;
    Ok(())
}
