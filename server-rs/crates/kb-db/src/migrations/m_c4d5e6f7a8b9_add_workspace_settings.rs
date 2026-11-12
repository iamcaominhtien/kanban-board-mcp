//! `server/alembic/versions/c4d5e6f7a8b9_add_workspace_settings.py`
//!
//! add_workspace_settings

use sea_orm::ConnectionTrait;

use super::ops::{self, StepResult};

/// `upgrade()` of revision `c4d5e6f7a8b9`.
pub(super) async fn upgrade<C: ConnectionTrait>(conn: &C) -> StepResult {
    ops::exec(conn, r"CREATE TABLE workspace_settings (
	id INTEGER NOT NULL, 
	enabled BOOLEAN DEFAULT 1 NOT NULL, 
	root_path VARCHAR DEFAULT '~/kanban-workspace' NOT NULL, 
	default_retention_days INTEGER DEFAULT '14', 
	PRIMARY KEY (id)
)").await?;
    ops::exec(conn, r"ALTER TABLE ticket ADD COLUMN workspace_retention_days INTEGER").await?;
    Ok(())
}
