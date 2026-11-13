//! `idea_vote` (Python model `IdeaVote`). Generated from the Python model by `contract/gen_entities.py` (removed in 5.0.0, with the Python server); now edited by hand.

use sea_orm::ActiveValue::{NotSet, Set};
use sea_orm::entity::prelude::*;
use serde::{Deserialize, Serialize};

/// One person's vote ("I want this") on an idea; a person votes once (table).
#[derive(Clone, Debug, PartialEq, DeriveEntityModel, Serialize, Deserialize)]
#[sea_orm(table_name = "idea_vote")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false)]
    pub id: String,
    pub idea_id: String,
    /// member id or user name
    pub voter: String,
    pub created_at: String,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}

/// A new row with the defaults of the Python model `IdeaVote`.
/// Set before saving: `idea_id`, `voter`.
pub fn new() -> ActiveModel {
    ActiveModel {
        id: Set(kb_base::time::uuid4()),
        idea_id: NotSet,
        voter: NotSet,
        created_at: Set(kb_base::time::now_iso()),
    }
}
