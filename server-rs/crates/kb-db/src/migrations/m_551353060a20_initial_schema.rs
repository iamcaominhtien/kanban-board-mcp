//! `server/alembic/versions/551353060a20_initial_schema.py`
//!
//! initial_schema

use sea_orm::ConnectionTrait;

use super::ops::{self, StepResult};

/// `upgrade()` of revision `551353060a20`.
pub(super) async fn upgrade<C: ConnectionTrait>(conn: &C) -> StepResult {
    ops::exec(conn, r"CREATE TABLE project (
	id VARCHAR NOT NULL, 
	name VARCHAR NOT NULL, 
	prefix VARCHAR NOT NULL, 
	color VARCHAR NOT NULL, 
	ticket_counter INTEGER NOT NULL, 
	PRIMARY KEY (id), 
	UNIQUE (prefix)
)").await?;
    ops::exec(conn, r"CREATE TABLE ticket (
	id VARCHAR NOT NULL, 
	project_id VARCHAR NOT NULL, 
	title VARCHAR NOT NULL, 
	description VARCHAR NOT NULL, 
	type VARCHAR NOT NULL, 
	status VARCHAR NOT NULL, 
	priority VARCHAR NOT NULL, 
	estimate FLOAT, 
	due_date VARCHAR, 
	tags VARCHAR NOT NULL, 
	parent_id VARCHAR, 
	comments VARCHAR NOT NULL, 
	acceptance_criteria VARCHAR NOT NULL, 
	activity_log VARCHAR NOT NULL, 
	work_log VARCHAR NOT NULL, 
	test_cases VARCHAR NOT NULL, 
	created_at VARCHAR NOT NULL, 
	updated_at VARCHAR NOT NULL, 
	PRIMARY KEY (id), 
	FOREIGN KEY(parent_id) REFERENCES ticket (id), 
	FOREIGN KEY(project_id) REFERENCES project (id)
)").await?;
    Ok(())
}
