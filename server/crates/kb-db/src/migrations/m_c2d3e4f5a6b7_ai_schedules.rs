//! `server/alembic/versions/c2d3e4f5a6b7_ai_schedules.py`
//!
//! AI schedules: an AI member works on a ticket at a set time, and each slot's outcome.

use sea_orm::ConnectionTrait;

use super::ops::{self, StepResult};

/// `upgrade()` of revision `c2d3e4f5a6b7`.
pub(super) async fn upgrade<C: ConnectionTrait>(conn: &C) -> StepResult {
    ops::exec(
        conn,
        r"CREATE TABLE ai_schedule (
	id VARCHAR NOT NULL, 
	project_id VARCHAR NOT NULL, 
	ticket_id VARCHAR NOT NULL, 
	member_id VARCHAR NOT NULL, 
	backup_member_id VARCHAR, 
	created_by VARCHAR DEFAULT 'user' NOT NULL, 
	kind VARCHAR DEFAULT 'repeat' NOT NULL, 
	run_at VARCHAR, 
	days VARCHAR DEFAULT '[0,1,2,3,4]' NOT NULL, 
	time VARCHAR DEFAULT '02:00' NOT NULL, 
	tz VARCHAR DEFAULT 'UTC' NOT NULL, 
	ends VARCHAR DEFAULT 'never' NOT NULL, 
	ends_after INTEGER, 
	ends_on VARCHAR, 
	window_end VARCHAR, 
	checks VARCHAR DEFAULT '{}' NOT NULL, 
	review VARCHAR DEFAULT '{}' NOT NULL, 
	limits VARCHAR DEFAULT '{}' NOT NULL, 
	catch_up VARCHAR DEFAULT 'run' NOT NULL, 
	catch_up_hours FLOAT DEFAULT '2' NOT NULL, 
	notify VARCHAR DEFAULT '[]' NOT NULL, 
	notify_people VARCHAR DEFAULT '[]' NOT NULL, 
	instruction VARCHAR DEFAULT '' NOT NULL, 
	state VARCHAR DEFAULT 'active' NOT NULL, 
	paused_reason VARCHAR, 
	failures_in_row INTEGER DEFAULT '0' NOT NULL, 
	runs_count INTEGER DEFAULT '0' NOT NULL, 
	next_run_at VARCHAR, 
	ticket_seen_at VARCHAR, 
	created_at VARCHAR NOT NULL, 
	updated_at VARCHAR NOT NULL, 
	PRIMARY KEY (id), 
	FOREIGN KEY(project_id) REFERENCES project (id)
)",
    )
    .await?;
    ops::exec(conn, r"CREATE INDEX ix_ai_schedule_member_id ON ai_schedule (member_id)").await?;
    ops::exec(conn, r"CREATE INDEX ix_ai_schedule_state ON ai_schedule (state)").await?;
    ops::exec(conn, r"CREATE INDEX ix_ai_schedule_ticket_id ON ai_schedule (ticket_id)").await?;
    ops::exec(conn, r"CREATE INDEX ix_ai_schedule_project_id ON ai_schedule (project_id)").await?;
    ops::exec(conn, r"CREATE INDEX ix_ai_schedule_next_run_at ON ai_schedule (next_run_at)").await?;
    ops::exec(
        conn,
        r"CREATE TABLE ai_schedule_run (
	id VARCHAR NOT NULL, 
	schedule_id VARCHAR NOT NULL, 
	project_id VARCHAR NOT NULL, 
	ticket_id VARCHAR NOT NULL, 
	slot_at VARCHAR NOT NULL, 
	state VARCHAR DEFAULT 'waiting' NOT NULL, 
	catch_up BOOLEAN DEFAULT 0 NOT NULL, 
	member_id VARCHAR, 
	run_ids VARCHAR DEFAULT '[]' NOT NULL, 
	attempts INTEGER DEFAULT '0' NOT NULL, 
	fix_round INTEGER DEFAULT '0' NOT NULL, 
	results VARCHAR DEFAULT '[]' NOT NULL, 
	review VARCHAR DEFAULT '{}' NOT NULL, 
	note VARCHAR, 
	started_at VARCHAR, 
	ended_at VARCHAR, 
	duration_s INTEGER DEFAULT '0' NOT NULL, 
	cost_usd FLOAT DEFAULT '0' NOT NULL, 
	created_at VARCHAR NOT NULL, 
	updated_at VARCHAR NOT NULL, 
	PRIMARY KEY (id), 
	FOREIGN KEY(schedule_id) REFERENCES ai_schedule (id)
)",
    )
    .await?;
    ops::exec(conn, r"CREATE INDEX ix_ai_schedule_run_project_id ON ai_schedule_run (project_id)").await?;
    ops::exec(conn, r"CREATE INDEX ix_ai_schedule_run_ticket_id ON ai_schedule_run (ticket_id)").await?;
    ops::exec(conn, r"CREATE INDEX ix_ai_schedule_run_state ON ai_schedule_run (state)").await?;
    ops::exec(conn, r"CREATE INDEX ix_ai_schedule_run_schedule_id ON ai_schedule_run (schedule_id)").await?;
    ops::exec(conn, r"CREATE UNIQUE INDEX ux_ai_schedule_slot ON ai_schedule_run (schedule_id, slot_at)").await?;
    Ok(())
}
