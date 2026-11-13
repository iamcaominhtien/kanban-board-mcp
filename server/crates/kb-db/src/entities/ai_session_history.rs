//! `ai_session_history` (Python model `AiSessionHistory`). Generated from the Python model by `contract/gen_entities.py` (removed in 5.0.0, with the Python server); now edited by hand.

use sea_orm::ActiveValue::{NotSet, Set};
use sea_orm::entity::prelude::*;
use serde::{Deserialize, Serialize};

/// A closed conversation of an AI team on a ticket: what its lead was asked and did, in a title and a summary, with
/// the Claude Code session ids and the runs it spanned. Made when a person starts the team over; read by any AI that
/// works on the ticket or on the board (table).
#[derive(Clone, Debug, PartialEq, DeriveEntityModel, Serialize, Deserialize)]
#[sea_orm(table_name = "ai_session_history")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false)]
    pub id: String,
    pub project_id: String,
    pub ticket_id: String,
    /// the team
    pub member_id: String,
    pub title: String,
    pub summary: String,
    pub session_ids: String,
    /// JSON list of run ids, oldest first
    pub run_ids: String,
    pub started_at: Option<String>,
    pub ended_at: String,
    pub created_by: String,
    pub summarised_by: String,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}

/// A new row with the defaults of the Python model `AiSessionHistory`.
/// Set before saving: `project_id`, `ticket_id`, `member_id`.
pub fn new() -> ActiveModel {
    ActiveModel {
        id: Set(kb_base::time::prefixed_id("ses_", 12)),
        project_id: NotSet,
        ticket_id: NotSet,
        member_id: NotSet,
        title: Set("".to_string()),
        summary: Set("".to_string()),
        session_ids: Set("[]".to_string()),
        run_ids: Set("[]".to_string()),
        started_at: Set(None),
        ended_at: Set(kb_base::time::now_iso()),
        created_by: Set("".to_string()),
        summarised_by: Set("".to_string()),
    }
}
