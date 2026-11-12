//! `server/alembic/versions/c3d4e5f6a7b8_add_members_and_ticket_assignee.py`
//!
//! add_members_and_ticket_assignee

use sea_orm::ConnectionTrait;

use super::ops::{self, StepResult};

/// `upgrade()` of revision `c3d4e5f6a7b8`.
pub(super) async fn upgrade<C: ConnectionTrait>(conn: &C) -> StepResult {
    ops::exec(conn, r"CREATE TABLE member (
	id VARCHAR NOT NULL, 
	project_id VARCHAR NOT NULL, 
	name VARCHAR NOT NULL, 
	color VARCHAR NOT NULL, 
	created_at VARCHAR NOT NULL, 
	PRIMARY KEY (id), 
	FOREIGN KEY(project_id) REFERENCES project (id)
)").await?;
    // batch_alter_table("ticket"): Alembic rebuilt the table to add the two columns and their named links to
    // member; a column added with its link written on it gives the same table
    ops::exec(
        conn,
        "ALTER TABLE ticket ADD COLUMN created_by VARCHAR CONSTRAINT fk_ticket_created_by REFERENCES member (id)",
    )
    .await?;
    ops::exec(
        conn,
        "ALTER TABLE ticket ADD COLUMN assignee VARCHAR CONSTRAINT fk_ticket_assignee REFERENCES member (id)",
    )
    .await?;
    Ok(())
}
