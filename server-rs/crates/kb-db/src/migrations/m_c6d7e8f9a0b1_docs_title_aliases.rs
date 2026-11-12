//! `server/alembic/versions/c6d7e8f9a0b1_docs_title_aliases.py`
//!
//! docs_title_aliases: old page titles keep resolving after a rename

use sea_orm::ConnectionTrait;

use super::ops::{self, StepResult};

/// `upgrade()` of revision `c6d7e8f9a0b1`.
pub(super) async fn upgrade<C: ConnectionTrait>(conn: &C) -> StepResult {
    ops::exec(conn, r"CREATE TABLE docs_title_aliases (
	id VARCHAR NOT NULL, 
	page_id VARCHAR NOT NULL, 
	old_title VARCHAR NOT NULL, 
	PRIMARY KEY (id), 
	FOREIGN KEY(page_id) REFERENCES docs_page (id)
)").await?;
    ops::exec(conn, r"CREATE INDEX ix_docs_title_aliases_page_id ON docs_title_aliases (page_id)").await?;
    Ok(())
}
