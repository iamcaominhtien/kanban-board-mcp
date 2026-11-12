//! `server/alembic/versions/b3e5f7a9c1d2_docs_ai_page_sessions.py`
//!
//! docs_ai_session: one Claude Code session for each (Docs page, AI member)

use sea_orm::ConnectionTrait;

use super::ops::{self, StepResult};

/// `upgrade()` of revision `b3e5f7a9c1d2`.
pub(super) async fn upgrade<C: ConnectionTrait>(conn: &C) -> StepResult {
    ops::exec(
        conn,
        r"CREATE TABLE docs_ai_session (
	scope VARCHAR NOT NULL, 
	member_id VARCHAR NOT NULL, 
	project_id VARCHAR NOT NULL, 
	session_id VARCHAR NOT NULL, 
	calls INTEGER DEFAULT '0' NOT NULL, 
	updated_at VARCHAR NOT NULL, 
	PRIMARY KEY (scope, member_id), 
	FOREIGN KEY(project_id) REFERENCES project (id)
)",
    )
    .await?;
    ops::exec(conn, r"CREATE INDEX ix_docs_ai_session_project_id ON docs_ai_session (project_id)").await?;
    Ok(())
}
