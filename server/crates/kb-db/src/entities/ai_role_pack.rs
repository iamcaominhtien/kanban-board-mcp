//! `ai_role_pack` (Python model `AiRolePack`). Generated from the Python model by `contract/gen_entities.py` (removed in 5.0.0, with the Python server); now edited by hand.

use sea_orm::ActiveValue::{NotSet, Set};
use sea_orm::entity::prelude::*;
use serde::{Deserialize, Serialize};

/// A project's own role pack, or its edited copy of a ready-made one (services/ai/packs.py) (table).
#[derive(Clone, Debug, PartialEq, DeriveEntityModel, Serialize, Deserialize)]
#[sea_orm(table_name = "ai_role_pack")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false)]
    pub id: String,
    pub project_id: String,
    pub key: String,
    pub name: String,
    pub version: i32,
    pub body: String,
    /// JSON list of the pack's roles as subagents (AI v2): [{key, name, description, prompt, model, effort, tools}]
    pub roles: String,
    pub history: String,
    pub created_at: String,
    pub updated_at: String,
    pub updated_by: Option<String>,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}

/// A new row with the defaults of the Python model `AiRolePack`.
/// Set before saving: `project_id`, `key`, `name`.
pub fn new() -> ActiveModel {
    ActiveModel {
        id: Set(kb_base::time::prefixed_id("pck_", 12)),
        project_id: NotSet,
        key: NotSet,
        name: NotSet,
        version: Set(1),
        body: Set("{}".to_string()),
        roles: Set("[]".to_string()),
        history: Set("[]".to_string()),
        created_at: Set(kb_base::time::now_iso()),
        updated_at: Set(kb_base::time::now_iso()),
        updated_by: Set(None),
    }
}
