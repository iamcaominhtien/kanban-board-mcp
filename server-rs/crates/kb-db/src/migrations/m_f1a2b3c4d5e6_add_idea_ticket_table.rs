//! `server/alembic/versions/f1a2b3c4d5e6_add_idea_ticket_table.py`
//!
//! add_idea_ticket_table

use sea_orm::ConnectionTrait;

use super::ops::{self, StepResult};

/// `upgrade()` of revision `f1a2b3c4d5e6`.
pub(super) async fn upgrade<C: ConnectionTrait>(conn: &C) -> StepResult {
    ops::exec(conn, r"CREATE TABLE idea_counter (
	id INTEGER NOT NULL, 
	counter INTEGER DEFAULT '0' NOT NULL, 
	PRIMARY KEY (id)
)").await?;
    ops::exec(conn, r"INSERT INTO idea_counter (id, counter) VALUES (1, 0)").await?;
    ops::exec(conn, r"CREATE TABLE idea_ticket (
	id VARCHAR NOT NULL, 
	project_id VARCHAR NOT NULL, 
	title VARCHAR NOT NULL, 
	description VARCHAR DEFAULT '' NOT NULL, 
	idea_status VARCHAR DEFAULT 'raw' NOT NULL, 
	idea_color VARCHAR DEFAULT '#F5C518' NOT NULL, 
	idea_emoji VARCHAR DEFAULT '💡' NOT NULL, 
	idea_energy VARCHAR, 
	tags VARCHAR DEFAULT '[]' NOT NULL, 
	problem_statement VARCHAR, 
	ice_impact INTEGER DEFAULT '3' NOT NULL, 
	ice_effort INTEGER DEFAULT '3' NOT NULL, 
	ice_confidence INTEGER DEFAULT '3' NOT NULL, 
	revisit_date VARCHAR, 
	last_touched_at VARCHAR, 
	promoted_to_ticket_id VARCHAR, 
	promoted_at VARCHAR, 
	activity_trail VARCHAR DEFAULT '[]' NOT NULL, 
	microthoughts VARCHAR DEFAULT '[]' NOT NULL, 
	assumptions VARCHAR DEFAULT '[]' NOT NULL, 
	created_at VARCHAR NOT NULL, 
	updated_at VARCHAR NOT NULL, 
	PRIMARY KEY (id), 
	FOREIGN KEY(project_id) REFERENCES project (id)
)").await?;
    ops::exec(conn, r"CREATE INDEX ix_idea_ticket_project_id ON idea_ticket (project_id)").await?;
    Ok(())
}
