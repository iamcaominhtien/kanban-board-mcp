//! `server/alembic/versions/a7c1e3f5b9d2_ai_accounts.py`
//!
//! AI accounts: several logins of the same AI CLI, and the account an AI member runs as.

use sea_orm::ConnectionTrait;

use super::ops::{self, StepResult};

/// `upgrade()` of revision `a7c1e3f5b9d2`.
pub(super) async fn upgrade<C: ConnectionTrait>(conn: &C) -> StepResult {
    ops::exec(
        conn,
        r#"CREATE TABLE ai_account (
	id VARCHAR NOT NULL, 
	name VARCHAR NOT NULL, 
	cli VARCHAR NOT NULL, 
	folder VARCHAR NOT NULL, 
	status VARCHAR DEFAULT 'needs_sign_in' NOT NULL, 
	status_detail VARCHAR, 
	email VARCHAR, 
	"plan" VARCHAR, 
	method VARCHAR, 
	checked_at VARCHAR, 
	signed_out_at VARCHAR, 
	signed_out_how VARCHAR, 
	created_by VARCHAR, 
	created_at VARCHAR NOT NULL, 
	updated_at VARCHAR NOT NULL, 
	PRIMARY KEY (id)
)"#,
    )
    .await?;
    ops::exec(conn, r"CREATE UNIQUE INDEX ix_ai_account_name ON ai_account (name)").await?;
    ops::exec(conn, r"ALTER TABLE ai_member ADD COLUMN account_id VARCHAR").await?;
    ops::exec(conn, r"CREATE INDEX ix_ai_member_account_id ON ai_member (account_id)").await?;
    Ok(())
}
