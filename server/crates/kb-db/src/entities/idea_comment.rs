//! `idea_comment` (Python model `IdeaComment`). Generated from the Python model by `contract/gen_entities.py` (removed in 5.0.0, with the Python server); now edited by hand.

use sea_orm::ActiveValue::{NotSet, Set};
use sea_orm::entity::prelude::*;
use serde::{Deserialize, Serialize};

/// A comment on an idea's page; AI answers carry the `ai` flag and the run they came from (table).
#[derive(Clone, Debug, PartialEq, DeriveEntityModel, Serialize, Deserialize)]
#[sea_orm(table_name = "idea_comment")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false)]
    pub id: String,
    pub idea_id: String,
    pub author: Option<String>,
    pub body: String,
    pub ai: bool,
    pub run_id: Option<String>,
    pub created_at: String,
    pub edited_at: Option<String>,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}

/// A new row with the defaults of the Python model `IdeaComment`.
/// Set before saving: `idea_id`.
pub fn new() -> ActiveModel {
    ActiveModel {
        id: Set(kb_base::time::uuid4()),
        idea_id: NotSet,
        author: Set(None),
        body: Set("".to_string()),
        ai: Set(false),
        run_id: Set(None),
        created_at: Set(kb_base::time::now_iso()),
        edited_at: Set(None),
    }
}
