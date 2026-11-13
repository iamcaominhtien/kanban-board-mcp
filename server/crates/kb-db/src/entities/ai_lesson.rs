//! `ai_lesson` (Python model `AiLesson`). Generated from the Python model by `contract/gen_entities.py` (removed in 5.0.0, with the Python server); now edited by hand.

use sea_orm::ActiveValue::{NotSet, Set};
use sea_orm::entity::prelude::*;
use serde::{Deserialize, Serialize};

/// One thing the project's AIs learned: proposed by an AI, kept or dropped by a person (table).
#[derive(Clone, Debug, PartialEq, DeriveEntityModel, Serialize, Deserialize)]
#[sea_orm(table_name = "ai_lesson")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false)]
    pub id: String,
    pub project_id: String,
    pub text: String,
    /// proposed | kept | dropped | none (a ticket read by the light model with nothing to propose)
    pub state: String,
    pub source_ticket_id: Option<String>,
    pub source_run_id: Option<String>,
    pub proposed_by: Option<String>,
    pub kept_by: Option<String>,
    /// runs whose prompt carried it
    pub uses: i32,
    pub last_used_at: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}

/// A new row with the defaults of the Python model `AiLesson`.
/// Set before saving: `project_id`.
pub fn new() -> ActiveModel {
    ActiveModel {
        id: Set(kb_base::time::prefixed_id("lsn_", 12)),
        project_id: NotSet,
        text: Set("".to_string()),
        state: Set("proposed".to_string()),
        source_ticket_id: Set(None),
        source_run_id: Set(None),
        proposed_by: Set(None),
        kept_by: Set(None),
        uses: Set(0),
        last_used_at: Set(None),
        created_at: Set(kb_base::time::now_iso()),
        updated_at: Set(kb_base::time::now_iso()),
    }
}
