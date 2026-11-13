//! `idea_advice` (Python model `IdeaAdvice`). Generated from the Python model by `contract/gen_entities.py` (removed in 5.0.0, with the Python server); now edited by hand.

use sea_orm::ActiveValue::{NotSet, Set};
use sea_orm::entity::prelude::*;
use serde::{Deserialize, Serialize};

use crate::float::Float;

/// What the AI suggests for an Inbox idea: Keep, Park, Merge or Archive, with a reason; it never applies it (table).
#[derive(Clone, Debug, PartialEq, DeriveEntityModel, Serialize, Deserialize)]
#[sea_orm(table_name = "idea_advice")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false)]
    pub id: String,
    pub idea_id: String,
    /// keep | park | merge | archive
    pub action: String,
    pub reason: String,
    /// high | medium | low
    pub confidence: String,
    /// the idea to merge into
    pub target_id: Option<String>,
    pub archive_reason: Option<String>,
    pub park_days: Option<i32>,
    pub idea_stamp: String,
    pub member_id: Option<String>,
    #[sea_orm(column_type = "Double")]
    pub cost: Float,
    /// open | accepted | ignored
    pub state: String,
    pub created_at: String,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}

/// A new row with the defaults of the Python model `IdeaAdvice`.
/// Set before saving: `idea_id`, `action`.
pub fn new() -> ActiveModel {
    ActiveModel {
        id: Set(kb_base::time::uuid4()),
        idea_id: NotSet,
        action: NotSet,
        reason: Set("".to_string()),
        confidence: Set("medium".to_string()),
        target_id: Set(None),
        archive_reason: Set(None),
        park_days: Set(None),
        idea_stamp: Set("".to_string()),
        member_id: Set(None),
        cost: Set(Float(0.0)),
        state: Set("open".to_string()),
        created_at: Set(kb_base::time::now_iso()),
    }
}
