//! `server/alembic/versions/b9c0d1e2f3a4_add_docs.py`
//!
//! add_docs

use sea_orm::ConnectionTrait;

use super::ops::{self, StepResult};

/// `upgrade()` of revision `b9c0d1e2f3a4`.
pub(super) async fn upgrade<C: ConnectionTrait>(conn: &C) -> StepResult {
    ops::exec(conn, r"CREATE TABLE docs_page (
	id VARCHAR NOT NULL, 
	project_id VARCHAR NOT NULL, 
	parent_id VARCHAR, 
	position INTEGER DEFAULT '0' NOT NULL, 
	title VARCHAR NOT NULL, 
	slug VARCHAR NOT NULL, 
	status VARCHAR DEFAULT 'draft' NOT NULL, 
	version INTEGER DEFAULT '0' NOT NULL, 
	created_by VARCHAR DEFAULT 'user' NOT NULL, 
	updated_by VARCHAR DEFAULT 'user' NOT NULL, 
	created_at VARCHAR NOT NULL, 
	updated_at VARCHAR NOT NULL, 
	deleted_at VARCHAR, 
	deleted_by VARCHAR, 
	deleted_root_id VARCHAR, 
	PRIMARY KEY (id), 
	FOREIGN KEY(project_id) REFERENCES project (id), 
	FOREIGN KEY(parent_id) REFERENCES docs_page (id)
)").await?;
    ops::exec(conn, r"CREATE INDEX ix_docs_page_project_id ON docs_page (project_id)").await?;
    ops::exec(conn, r"CREATE TABLE docs_version (
	id VARCHAR NOT NULL, 
	page_id VARCHAR NOT NULL, 
	version INTEGER NOT NULL, 
	title VARCHAR NOT NULL, 
	markdown VARCHAR DEFAULT '' NOT NULL, 
	author VARCHAR DEFAULT 'user' NOT NULL, 
	note VARCHAR, 
	created_at VARCHAR NOT NULL, 
	PRIMARY KEY (id), 
	FOREIGN KEY(page_id) REFERENCES docs_page (id)
)").await?;
    ops::exec(conn, r"CREATE INDEX ix_docs_version_page_id ON docs_version (page_id)").await?;
    ops::exec(conn, r"CREATE TABLE docs_draft (
	id VARCHAR NOT NULL, 
	page_id VARCHAR NOT NULL, 
	author VARCHAR DEFAULT 'user' NOT NULL, 
	title VARCHAR NOT NULL, 
	markdown VARCHAR DEFAULT '' NOT NULL, 
	base_version INTEGER DEFAULT '0' NOT NULL, 
	updated_at VARCHAR NOT NULL, 
	PRIMARY KEY (id), 
	FOREIGN KEY(page_id) REFERENCES docs_page (id)
)").await?;
    ops::exec(conn, r"CREATE INDEX ix_docs_draft_page_id ON docs_draft (page_id)").await?;
    ops::exec(conn, r"CREATE TABLE docs_link (
	id VARCHAR NOT NULL, 
	source_page_id VARCHAR NOT NULL, 
	source_section VARCHAR, 
	target_page_id VARCHAR, 
	target_title VARCHAR, 
	target_anchor VARCHAR, 
	target_ticket_id VARCHAR, 
	display_text VARCHAR, 
	snippet VARCHAR DEFAULT '' NOT NULL, 
	PRIMARY KEY (id), 
	FOREIGN KEY(source_page_id) REFERENCES docs_page (id)
)").await?;
    ops::exec(conn, r"CREATE INDEX ix_docs_link_source_page_id ON docs_link (source_page_id)").await?;
    ops::exec(conn, r"CREATE INDEX ix_docs_link_target_page_id ON docs_link (target_page_id)").await?;
    ops::exec(conn, r"CREATE INDEX ix_docs_link_target_ticket_id ON docs_link (target_ticket_id)").await?;
    Ok(())
}
