//! `server/alembic/versions/f3a4b5c6d7e8_diagrams.py`
//!
//! diagrams: draw.io diagrams, their versions, the editor setting and the page-version pins

use sea_orm::ConnectionTrait;

use super::ops::{self, StepResult};

/// `upgrade()` of revision `f3a4b5c6d7e8`.
pub(super) async fn upgrade<C: ConnectionTrait>(conn: &C) -> StepResult {
    ops::exec(conn, r"ALTER TABLE docs_version ADD COLUMN diagram_versions VARCHAR DEFAULT '{}' NOT NULL").await?;
    ops::exec(
        conn,
        r"CREATE TABLE diagram (
	id VARCHAR NOT NULL, 
	project_id VARCHAR NOT NULL, 
	label VARCHAR DEFAULT 'Diagram' NOT NULL, 
	summary VARCHAR DEFAULT '' NOT NULL, 
	item_kind VARCHAR, 
	item_id VARCHAR, 
	version INTEGER DEFAULT '1' NOT NULL, 
	created_by VARCHAR NOT NULL, 
	created_at VARCHAR NOT NULL, 
	updated_by VARCHAR NOT NULL, 
	updated_at VARCHAR NOT NULL, 
	deleted_at VARCHAR, 
	deleted_by VARCHAR, 
	PRIMARY KEY (id), 
	FOREIGN KEY(project_id) REFERENCES project (id)
)",
    )
    .await?;
    ops::exec(conn, r"CREATE INDEX ix_diagram_project_id ON diagram (project_id)").await?;
    ops::exec(conn, r"CREATE INDEX ix_diagram_item_id ON diagram (item_id)").await?;
    ops::exec(
        conn,
        r"CREATE TABLE diagram_version (
	id VARCHAR NOT NULL, 
	diagram_id VARCHAR NOT NULL, 
	version INTEGER NOT NULL, 
	source VARCHAR DEFAULT '' NOT NULL, 
	svg VARCHAR DEFAULT '' NOT NULL, 
	author VARCHAR NOT NULL, 
	note VARCHAR, 
	created_at VARCHAR NOT NULL, 
	PRIMARY KEY (id), 
	FOREIGN KEY(diagram_id) REFERENCES diagram (id)
)",
    )
    .await?;
    ops::exec(conn, r"CREATE INDEX ix_diagram_version_diagram_id ON diagram_version (diagram_id)").await?;
    ops::exec(
        conn,
        r"CREATE TABLE diagram_settings (
	id INTEGER NOT NULL, 
	mode VARCHAR DEFAULT 'self-hosted' NOT NULL, 
	url VARCHAR DEFAULT '' NOT NULL, 
	PRIMARY KEY (id)
)",
    )
    .await?;
    Ok(())
}
