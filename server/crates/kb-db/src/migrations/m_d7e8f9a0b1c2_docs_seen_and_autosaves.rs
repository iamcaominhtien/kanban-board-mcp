//! `server/alembic/versions/d7e8f9a0b1c2_docs_seen_and_autosaves.py`
//!
//! docs: per-user last viewed version (docs_page_seen), docs_follow and docs_draft.saves

use sea_orm::ConnectionTrait;

use super::ops::{self, StepResult};

/// `upgrade()` of revision `d7e8f9a0b1c2`.
pub(super) async fn upgrade<C: ConnectionTrait>(conn: &C) -> StepResult {
    ops::exec(
        conn,
        r"CREATE TABLE docs_page_seen (
	id VARCHAR NOT NULL, 
	page_id VARCHAR NOT NULL, 
	viewer VARCHAR NOT NULL, 
	version INTEGER DEFAULT '0' NOT NULL, 
	seen_at VARCHAR NOT NULL, 
	PRIMARY KEY (id), 
	FOREIGN KEY(page_id) REFERENCES docs_page (id)
)",
    )
    .await?;
    ops::exec(conn, r"CREATE INDEX ix_docs_page_seen_page_id ON docs_page_seen (page_id)").await?;
    ops::exec(
        conn,
        r"CREATE TABLE docs_follow (
	id VARCHAR NOT NULL, 
	project_id VARCHAR NOT NULL, 
	follower VARCHAR NOT NULL, 
	created_at VARCHAR NOT NULL, 
	PRIMARY KEY (id), 
	FOREIGN KEY(project_id) REFERENCES project (id)
)",
    )
    .await?;
    ops::exec(conn, r"CREATE INDEX ix_docs_follow_project_id ON docs_follow (project_id)").await?;
    ops::exec(conn, r"ALTER TABLE docs_draft ADD COLUMN saves INTEGER DEFAULT '1' NOT NULL").await?;
    Ok(())
}
