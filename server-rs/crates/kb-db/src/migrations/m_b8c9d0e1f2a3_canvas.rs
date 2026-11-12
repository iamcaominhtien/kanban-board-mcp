//! `server/alembic/versions/b8c9d0e1f2a3_canvas.py`
//!
//! canvas: boards, notes and comments on one large plane (a peer of Sketch and Diagram)

use sea_orm::ConnectionTrait;

use super::ops::{self, StepResult};

/// `upgrade()` of revision `b8c9d0e1f2a3`.
pub(super) async fn upgrade<C: ConnectionTrait>(conn: &C) -> StepResult {
    ops::exec(conn, r"CREATE TABLE canvas (
	id VARCHAR NOT NULL, 
	project_id VARCHAR, 
	owner_kind VARCHAR DEFAULT 'doc' NOT NULL, 
	owner_id VARCHAR DEFAULT '' NOT NULL, 
	page_id VARCHAR, 
	title VARCHAR DEFAULT 'Canvas' NOT NULL, 
	rev INTEGER DEFAULT '1' NOT NULL, 
	version INTEGER DEFAULT '0' NOT NULL, 
	board_count INTEGER DEFAULT '0' NOT NULL, 
	total_bytes INTEGER DEFAULT '0' NOT NULL, 
	created_by VARCHAR NOT NULL, 
	created_at VARCHAR NOT NULL, 
	updated_by VARCHAR NOT NULL, 
	updated_at VARCHAR NOT NULL, 
	deleted_at VARCHAR, 
	deleted_by VARCHAR, 
	PRIMARY KEY (id), 
	FOREIGN KEY(project_id) REFERENCES project (id)
)").await?;
    ops::exec(conn, r"CREATE INDEX ix_canvas_project_id ON canvas (project_id)").await?;
    ops::exec(conn, r"CREATE INDEX ix_canvas_owner_id ON canvas (owner_id)").await?;
    ops::exec(conn, r"CREATE INDEX ix_canvas_page_id ON canvas (page_id)").await?;
    ops::exec(conn, r"CREATE TABLE canvas_version (
	id VARCHAR NOT NULL, 
	canvas_id VARCHAR NOT NULL, 
	version INTEGER NOT NULL, 
	name VARCHAR, 
	reason VARCHAR DEFAULT 'done' NOT NULL, 
	author VARCHAR NOT NULL, 
	note VARCHAR, 
	changes VARCHAR DEFAULT '{}' NOT NULL, 
	summary VARCHAR DEFAULT '' NOT NULL, 
	doc VARCHAR DEFAULT '{}' NOT NULL, 
	created_at VARCHAR NOT NULL, 
	PRIMARY KEY (id), 
	FOREIGN KEY(canvas_id) REFERENCES canvas (id)
)").await?;
    ops::exec(conn, r"CREATE INDEX ix_canvas_version_canvas_id ON canvas_version (canvas_id)").await?;
    ops::exec(conn, r"CREATE UNIQUE INDEX uq_canvas_version ON canvas_version (canvas_id, version)").await?;
    ops::exec(conn, r"CREATE TABLE canvas_thread (
	id VARCHAR NOT NULL, 
	canvas_id VARCHAR NOT NULL, 
	number INTEGER DEFAULT '1' NOT NULL, 
	board_id VARCHAR, 
	x FLOAT DEFAULT '0.5' NOT NULL, 
	y FLOAT DEFAULT '0.5' NOT NULL, 
	page VARCHAR, 
	status VARCHAR DEFAULT 'open' NOT NULL, 
	created_by VARCHAR NOT NULL, 
	created_at VARCHAR NOT NULL, 
	resolved_by VARCHAR, 
	resolved_at VARCHAR, 
	PRIMARY KEY (id), 
	FOREIGN KEY(canvas_id) REFERENCES canvas (id)
)").await?;
    ops::exec(conn, r"CREATE INDEX ix_canvas_thread_canvas_id ON canvas_thread (canvas_id)").await?;
    ops::exec(conn, r"CREATE TABLE canvas_comment (
	id VARCHAR NOT NULL, 
	thread_id VARCHAR NOT NULL, 
	author VARCHAR NOT NULL, 
	body VARCHAR DEFAULT '' NOT NULL, 
	mentions VARCHAR DEFAULT '[]' NOT NULL, 
	ai VARCHAR, 
	created_at VARCHAR NOT NULL, 
	edited_at VARCHAR, 
	PRIMARY KEY (id), 
	FOREIGN KEY(thread_id) REFERENCES canvas_thread (id)
)").await?;
    ops::exec(conn, r"CREATE INDEX ix_canvas_comment_thread_id ON canvas_comment (thread_id)").await?;
    ops::exec(conn, r"CREATE TABLE canvas_proposal (
	id VARCHAR NOT NULL, 
	canvas_id VARCHAR NOT NULL, 
	author VARCHAR NOT NULL, 
	member_id VARCHAR, 
	job_id VARCHAR, 
	request VARCHAR DEFAULT '' NOT NULL, 
	note VARCHAR DEFAULT '' NOT NULL, 
	status VARCHAR DEFAULT 'open' NOT NULL, 
	changes VARCHAR DEFAULT '[]' NOT NULL, 
	version INTEGER, 
	created_at VARCHAR NOT NULL, 
	decided_by VARCHAR, 
	decided_at VARCHAR, 
	PRIMARY KEY (id), 
	FOREIGN KEY(canvas_id) REFERENCES canvas (id)
)").await?;
    ops::exec(conn, r"CREATE INDEX ix_canvas_proposal_canvas_id ON canvas_proposal (canvas_id)").await?;
    ops::exec(conn, r"ALTER TABLE docs_page ADD COLUMN kind VARCHAR DEFAULT 'page' NOT NULL").await?;
    Ok(())
}
