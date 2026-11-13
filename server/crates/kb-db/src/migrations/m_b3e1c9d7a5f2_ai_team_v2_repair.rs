//! `server/alembic/versions/b3e1c9d7a5f2_ai_team_v2_repair.py`
//!
//! AI team v2 repair: run the AI team v2 upgrade again, which adds only what is missing. A database migrated by an
//! early build of e6611f7871e7 is stamped at that revision but lacks the tables and columns added to it later.

use sea_orm::ConnectionTrait;

use super::m_e6611f7871e7_ai_team_v2;
use super::ops::StepResult;

/// `upgrade()` of revision `b3e1c9d7a5f2`: the AI team v2 upgrade once more.
pub(super) async fn upgrade<C: ConnectionTrait>(conn: &C) -> StepResult {
    m_e6611f7871e7_ai_team_v2::upgrade(conn).await
}
