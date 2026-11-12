//! `server/alembic/versions/e2f3a4b5c6d7_docs_comments.py`
//!
//! docs_comments: comment threads, replies, read marks, activity events, member role

use sea_orm::ConnectionTrait;

use super::ops::{self, StepResult};

/// `upgrade()` of revision `e2f3a4b5c6d7`.
pub(super) async fn upgrade<C: ConnectionTrait>(conn: &C) -> StepResult {
    ops::exec(conn, r"ALTER TABLE member ADD COLUMN role VARCHAR DEFAULT 'member' NOT NULL").await?;
    ops::exec(conn, r"CREATE TABLE docs_comment_thread (
	id VARCHAR NOT NULL, 
	page_id VARCHAR NOT NULL, 
	kind VARCHAR DEFAULT 'inline' NOT NULL, 
	status VARCHAR DEFAULT 'open' NOT NULL, 
	anchor_quote VARCHAR, 
	anchor_prefix VARCHAR DEFAULT '' NOT NULL, 
	anchor_suffix VARCHAR DEFAULT '' NOT NULL, 
	anchor_section VARCHAR, 
	anchor_state VARCHAR DEFAULT 'attached' NOT NULL, 
	anchor_pos INTEGER, 
	created_by VARCHAR NOT NULL, 
	created_at VARCHAR NOT NULL, 
	resolved_by VARCHAR, 
	resolved_at VARCHAR, 
	PRIMARY KEY (id), 
	FOREIGN KEY(page_id) REFERENCES docs_page (id)
)").await?;
    ops::exec(conn, r"CREATE INDEX ix_docs_comment_thread_page_id ON docs_comment_thread (page_id)").await?;
    ops::exec(conn, r"CREATE TABLE docs_comment (
	id VARCHAR NOT NULL, 
	thread_id VARCHAR NOT NULL, 
	author VARCHAR NOT NULL, 
	body VARCHAR NOT NULL, 
	mentions VARCHAR DEFAULT '[]' NOT NULL, 
	created_at VARCHAR NOT NULL, 
	edited_at VARCHAR, 
	PRIMARY KEY (id), 
	FOREIGN KEY(thread_id) REFERENCES docs_comment_thread (id)
)").await?;
    ops::exec(conn, r"CREATE INDEX ix_docs_comment_thread_id ON docs_comment (thread_id)").await?;
    ops::exec(conn, r"CREATE TABLE docs_comment_read (
	id VARCHAR NOT NULL, 
	thread_id VARCHAR NOT NULL, 
	reader VARCHAR NOT NULL, 
	read_at VARCHAR NOT NULL, 
	PRIMARY KEY (id), 
	FOREIGN KEY(thread_id) REFERENCES docs_comment_thread (id)
)").await?;
    ops::exec(conn, r"CREATE INDEX ix_docs_comment_read_thread_id ON docs_comment_read (thread_id)").await?;
    ops::exec(conn, r"CREATE TABLE docs_comment_event (
	id VARCHAR NOT NULL, 
	project_id VARCHAR NOT NULL, 
	page_id VARCHAR NOT NULL, 
	thread_id VARCHAR, 
	comment_id VARCHAR, 
	kind VARCHAR NOT NULL, 
	actor VARCHAR NOT NULL, 
	mentioned VARCHAR DEFAULT '[]' NOT NULL, 
	recipients VARCHAR DEFAULT '[]' NOT NULL, 
	page_title VARCHAR DEFAULT '' NOT NULL, 
	snippet VARCHAR DEFAULT '' NOT NULL, 
	created_at VARCHAR NOT NULL, 
	PRIMARY KEY (id), 
	FOREIGN KEY(project_id) REFERENCES project (id), 
	FOREIGN KEY(page_id) REFERENCES docs_page (id)
)").await?;
    ops::exec(conn, r"CREATE INDEX ix_docs_comment_event_project_id ON docs_comment_event (project_id)").await?;
    ops::exec(conn, r"CREATE INDEX ix_docs_comment_event_page_id ON docs_comment_event (page_id)").await?;
    Ok(())
}
