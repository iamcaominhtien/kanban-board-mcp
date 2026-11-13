//! `idea_counter` (Python model `IdeaCounter`). Generated from the Python model by `contract/gen_entities.py` (removed in 5.0.0, with the Python server); now edited by hand.

use sea_orm::ActiveValue::{NotSet, Set};
use sea_orm::entity::prelude::*;
use serde::{Deserialize, Serialize};

/// Singleton row that numbers idea tickets (table).
#[derive(Clone, Debug, PartialEq, DeriveEntityModel, Serialize, Deserialize)]
#[sea_orm(table_name = "idea_counter")]
pub struct Model {
    #[sea_orm(primary_key)]
    pub id: i32,
    pub counter: i32,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}

/// A new row with the defaults of the Python model `IdeaCounter`.
pub fn new() -> ActiveModel {
    ActiveModel { id: NotSet, counter: Set(0) }
}
