//! `server/alembic/versions/c3d9a1b7e5f2_sketches.py`
//!
//! sketches: paint-style drawings (a PNG and an editable source kept in the uploads folder)

use sea_orm::ConnectionTrait;

use super::ops::{self, StepResult};

/// `upgrade()` of revision `c3d9a1b7e5f2`.
pub(super) async fn upgrade<C: ConnectionTrait>(conn: &C) -> StepResult {
    ops::exec(conn, r"CREATE TABLE sketch (
	id VARCHAR NOT NULL, 
	project_id VARCHAR, 
	owner_kind VARCHAR DEFAULT 'doc' NOT NULL, 
	owner_id VARCHAR DEFAULT '' NOT NULL, 
	title VARCHAR DEFAULT 'Sketch' NOT NULL, 
	width INTEGER DEFAULT '840' NOT NULL, 
	height INTEGER DEFAULT '500' NOT NULL, 
	layer_count INTEGER DEFAULT '1' NOT NULL, 
	version INTEGER DEFAULT '1' NOT NULL, 
	png_bytes INTEGER DEFAULT '0' NOT NULL, 
	source_bytes INTEGER DEFAULT '0' NOT NULL, 
	created_by VARCHAR NOT NULL, 
	created_at VARCHAR NOT NULL, 
	updated_by VARCHAR NOT NULL, 
	updated_at VARCHAR NOT NULL, 
	deleted_at VARCHAR, 
	deleted_by VARCHAR, 
	PRIMARY KEY (id), 
	FOREIGN KEY(project_id) REFERENCES project (id)
)").await?;
    ops::exec(conn, r"CREATE INDEX ix_sketch_project_id ON sketch (project_id)").await?;
    ops::exec(conn, r"CREATE INDEX ix_sketch_owner_id ON sketch (owner_id)").await?;
    Ok(())
}
