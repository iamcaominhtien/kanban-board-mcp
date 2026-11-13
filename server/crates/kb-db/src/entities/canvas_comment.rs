//! `canvas_comment` (Python model `CanvasComment`). Generated from the Python model by `contract/gen_entities.py` (removed in 5.0.0, with the Python server); now edited by hand.

use sea_orm::ActiveValue::{NotSet, Set};
use sea_orm::entity::prelude::*;
use serde::{Deserialize, Serialize};

/// One comment of a canvas thread (same shape as a Docs comment).
#[derive(Clone, Debug, PartialEq, DeriveEntityModel, Serialize, Deserialize)]
#[sea_orm(table_name = "canvas_comment")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false)]
    pub id: String,
    pub thread_id: String,
    pub author: String,
    pub body: String,
    pub mentions: String,
    /// JSON {member} on an AI team's comment
    pub ai: Option<String>,
    pub created_at: String,
    pub edited_at: Option<String>,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}

/// A new row with the defaults of the Python model `CanvasComment`.
/// Set before saving: `thread_id`.
pub fn new() -> ActiveModel {
    ActiveModel {
        id: Set(kb_base::time::uuid4()),
        thread_id: NotSet,
        author: Set("user".to_string()),
        body: Set("".to_string()),
        mentions: Set("[]".to_string()),
        ai: Set(None),
        created_at: Set(kb_base::time::now_iso()),
        edited_at: Set(None),
    }
}
