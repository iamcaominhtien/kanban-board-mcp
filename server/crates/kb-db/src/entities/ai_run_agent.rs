//! `ai_run_agent` (Python model `AiRunAgent`). Generated from the Python model by `contract/gen_entities.py` (removed in 5.0.0, with the Python server); now edited by hand.

use sea_orm::ActiveValue::{NotSet, Set};
use sea_orm::entity::prelude::*;
use serde::{Deserialize, Serialize};

/// A subagent of a run: the role it plays and when it worked (table).
#[derive(Clone, Debug, PartialEq, DeriveEntityModel, Serialize, Deserialize)]
#[sea_orm(table_name = "ai_run_agent")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false)]
    pub id: String,
    pub run_id: String,
    pub agent_type: String,
    pub claude_id: Option<String>,
    pub started_at: String,
    pub ended_at: Option<String>,
    pub steps_count: i32,
    pub last_text: Option<String>,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}

/// A new row with the defaults of the Python model `AiRunAgent`.
/// Set before saving: `id`, `run_id`.
pub fn new() -> ActiveModel {
    ActiveModel {
        id: NotSet,
        run_id: NotSet,
        agent_type: Set("".to_string()),
        claude_id: Set(None),
        started_at: Set(kb_base::time::now_iso()),
        ended_at: Set(None),
        steps_count: Set(0),
        last_text: Set(None),
    }
}
