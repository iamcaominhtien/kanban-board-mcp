//! `member` (Python model `Member`). Generated from the Python model by `contract/gen_entities.py` (removed in 5.0.0, with the Python server); now edited by hand.

use sea_orm::ActiveValue::{NotSet, Set};
use sea_orm::entity::prelude::*;
use serde::{Deserialize, Serialize};

/// Project member who can be assigned tickets or mentioned (table).
#[derive(Clone, Debug, PartialEq, DeriveEntityModel, Serialize, Deserialize)]
#[sea_orm(table_name = "member")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false)]
    pub id: String,
    pub project_id: String,
    pub name: String,
    /// hex color for avatar background
    pub color: String,
    /// Docs comment rights: viewer reads, member comments and resolves, admin also deletes any comment.
    pub role: String,
    /// human | ai. An AI member keeps its connection and limits in AiMember (same id).
    pub kind: String,
    pub created_at: String,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}

/// A new row with the defaults of the Python model `Member`.
/// Set before saving: `project_id`, `name`, `color`.
pub fn new() -> ActiveModel {
    ActiveModel {
        id: Set(kb_base::time::uuid4()),
        project_id: NotSet,
        name: NotSet,
        color: NotSet,
        role: Set("member".to_string()),
        kind: Set("human".to_string()),
        created_at: Set(kb_base::time::now_iso()),
    }
}
