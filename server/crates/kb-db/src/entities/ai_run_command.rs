//! `ai_run_command` (Python model `AiRunCommand`). Generated from the Python model by `contract/gen_entities.py` (removed in 5.0.0, with the Python server); now edited by hand.

use sea_orm::ActiveValue::{NotSet, Set};
use sea_orm::entity::prelude::*;
use serde::{Deserialize, Serialize};

/// What the API asks the runner process to do with a run (AI v2 stage 6): start, cancel, message, answer (table).
#[derive(Clone, Debug, PartialEq, DeriveEntityModel, Serialize, Deserialize)]
#[sea_orm(table_name = "ai_run_command")]
pub struct Model {
    #[sea_orm(primary_key)]
    pub id: i32,
    pub run_id: String,
    /// start | cancel | message | answer | restart
    pub command: String,
    pub payload: String,
    pub created_at: String,
    pub taken_at: Option<String>,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}

/// A new row with the defaults of the Python model `AiRunCommand`.
/// Set before saving: `run_id`, `command`.
pub fn new() -> ActiveModel {
    ActiveModel {
        id: NotSet,
        run_id: NotSet,
        command: NotSet,
        payload: Set("{}".to_string()),
        created_at: Set(kb_base::time::now_iso()),
        taken_at: Set(None),
    }
}
