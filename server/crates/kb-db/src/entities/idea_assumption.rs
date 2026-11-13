//! `idea_assumption` (Python model `IdeaAssumption`). Generated from the Python model by `contract/gen_entities.py` (removed in 5.0.0, with the Python server); now edited by hand.

use sea_orm::ActiveValue::{NotSet, Set};
use sea_orm::entity::prelude::*;
use serde::{Deserialize, Serialize};

/// One assumption of an idea, with how much it matters and how well it is tested (table).
#[derive(Clone, Debug, PartialEq, DeriveEntityModel, Serialize, Deserialize)]
#[sea_orm(table_name = "idea_assumption")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false)]
    pub id: String,
    pub idea_id: String,
    pub position: i32,
    pub text: String,
    /// see ASSUMPTION_IMPACTS
    pub impact: String,
    /// see ASSUMPTION_STATUSES
    pub status: String,
    /// a ticket that tests it
    pub test_ticket_id: Option<String>,
    pub ai: bool,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}

/// A new row with the defaults of the Python model `IdeaAssumption`.
/// Set before saving: `idea_id`, `text`.
pub fn new() -> ActiveModel {
    ActiveModel {
        id: Set(kb_base::time::uuid4()),
        idea_id: NotSet,
        position: Set(0),
        text: NotSet,
        impact: Set("medium".to_string()),
        status: Set("untested".to_string()),
        test_ticket_id: Set(None),
        ai: Set(false),
        created_at: Set(kb_base::time::now_iso()),
        updated_at: Set(kb_base::time::now_iso()),
    }
}
