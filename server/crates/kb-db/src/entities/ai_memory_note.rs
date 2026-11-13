//! `ai_memory_note` (Python model `AiMemoryNote`). Generated from the Python model by `contract/gen_entities.py` (removed in 5.0.0, with the Python server); now edited by hand.

use sea_orm::ActiveValue::{NotSet, Set};
use sea_orm::entity::prelude::*;
use serde::{Deserialize, Serialize};

/// A note an AI keeps across runs (services/ai/memory.py, issue #274): what works in this repository, the commands,
/// where things are, a person's feedback. Kept by a role (every member of the role reads it), by one member (a member
/// with no role) or on one ticket (every later run on that ticket reads it). Live at once, shown to people and
/// editable; capped per scope (table).
#[derive(Clone, Debug, PartialEq, DeriveEntityModel, Serialize, Deserialize)]
#[sea_orm(table_name = "ai_memory_note")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false)]
    pub id: String,
    pub project_id: String,
    /// role | member | ticket
    pub scope: String,
    pub scope_key: String,
    pub text: String,
    /// learned | feedback (a person told the AI)
    pub kind: String,
    /// a member's name or a person's
    pub written_by: Option<String>,
    pub source_run_id: Option<String>,
    pub source_ticket_id: Option<String>,
    /// runs whose prompt carried it
    pub uses: i32,
    pub last_used_at: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}

/// A new row with the defaults of the Python model `AiMemoryNote`.
/// Set before saving: `project_id`.
pub fn new() -> ActiveModel {
    ActiveModel {
        id: Set(kb_base::time::prefixed_id("mem_", 12)),
        project_id: NotSet,
        scope: Set("role".to_string()),
        scope_key: Set("".to_string()),
        text: Set("".to_string()),
        kind: Set("learned".to_string()),
        written_by: Set(None),
        source_run_id: Set(None),
        source_ticket_id: Set(None),
        uses: Set(0),
        last_used_at: Set(None),
        created_at: Set(kb_base::time::now_iso()),
        updated_at: Set(kb_base::time::now_iso()),
    }
}
