//! `ai_digest` (Python model `AiDigest`). Generated from the Python model by `contract/gen_entities.py` (removed in 5.0.0, with the Python server); now edited by hand.

use sea_orm::ActiveValue::{NotSet, Set};
use sea_orm::entity::prelude::*;
use serde::{Deserialize, Serialize};

use crate::float::Float;

/// The standup summary written at each board-health check.
#[derive(Clone, Debug, PartialEq, DeriveEntityModel, Serialize, Deserialize)]
#[sea_orm(table_name = "ai_digest")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false)]
    pub id: String,
    pub project_id: String,
    pub day: String,
    pub summary: String,
    pub member_id: Option<String>,
    #[sea_orm(column_type = "Double")]
    pub cost: Float,
    pub tokens: i32,
    pub created_at: String,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}

/// A new row with the defaults of the Python model `AiDigest`.
/// Set before saving: `project_id`, `day`.
pub fn new() -> ActiveModel {
    ActiveModel {
        id: Set(kb_base::time::uuid4()),
        project_id: NotSet,
        day: NotSet,
        summary: Set("{}".to_string()),
        member_id: Set(None),
        cost: Set(Float(0.0)),
        tokens: Set(0),
        created_at: Set(kb_base::time::now_iso()),
    }
}
