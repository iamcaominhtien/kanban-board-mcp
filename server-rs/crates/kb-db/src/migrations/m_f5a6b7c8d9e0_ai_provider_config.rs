//! `server/alembic/versions/f5a6b7c8d9e0_ai_provider_config.py`
//!
//! AI provider configuration: per-member config state (version, written files, ticks) and the shared library.

use sea_orm::ConnectionTrait;

use super::ops::{self, StepResult};

/// `upgrade()` of revision `f5a6b7c8d9e0`.
pub(super) async fn upgrade<C: ConnectionTrait>(conn: &C) -> StepResult {
    ops::exec(conn, r"CREATE TABLE ai_config_state (
	member_id VARCHAR NOT NULL, 
	version INTEGER DEFAULT '1' NOT NULL, 
	synced_at VARCHAR, 
	synced_files INTEGER DEFAULT '0' NOT NULL, 
	ticks VARCHAR DEFAULT '[]' NOT NULL, 
	files VARCHAR DEFAULT '{}' NOT NULL, 
	hooks_ok VARCHAR DEFAULT '{}' NOT NULL, 
	reset_snapshot VARCHAR, 
	updated_at VARCHAR NOT NULL, 
	PRIMARY KEY (member_id), 
	FOREIGN KEY(member_id) REFERENCES ai_member (id)
)").await?;
    ops::exec(conn, r"CREATE TABLE ai_library_item (
	id VARCHAR NOT NULL, 
	project_id VARCHAR NOT NULL, 
	type VARCHAR NOT NULL, 
	name VARCHAR NOT NULL, 
	description VARCHAR DEFAULT '' NOT NULL, 
	content VARCHAR DEFAULT '' NOT NULL, 
	version INTEGER DEFAULT '1' NOT NULL, 
	history VARCHAR DEFAULT '[]' NOT NULL, 
	created_by VARCHAR, 
	created_at VARCHAR NOT NULL, 
	updated_at VARCHAR NOT NULL, 
	PRIMARY KEY (id), 
	FOREIGN KEY(project_id) REFERENCES project (id)
)").await?;
    ops::exec(conn, r"CREATE INDEX ix_ai_library_item_project_id ON ai_library_item (project_id)").await?;
    Ok(())
}
