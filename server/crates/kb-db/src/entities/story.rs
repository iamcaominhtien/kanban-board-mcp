//! `story` (Python model `Story`). Generated from the Python model by `contract/gen_entities.py` (removed in 5.0.0, with the Python server); now edited by hand.

use sea_orm::ActiveValue::{NotSet, Set};
use sea_orm::entity::prelude::*;
use serde::{Deserialize, Serialize};

/// A Story: a ticket of type story that the PM owns from the goal to Done (design/screens/ai-story-flow.md B).
/// Its children are the tickets whose parent is the Story; its plan says their order and what waits for what
/// (table).
#[derive(Clone, Debug, PartialEq, DeriveEntityModel, Serialize, Deserialize)]
#[sea_orm(table_name = "story")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false)]
    pub ticket_id: String,
    pub project_id: String,
    pub state: String,
    /// who approves the plan: person | pm
    pub approve: String,
    /// 0: no budget
    pub budget_tokens: i32,
    pub pm_id: Option<String>,
    pub plan: String,
    pub paused: bool,
    pub review_note: Option<String>,
    /// JSON [{at, state, by}]
    pub history: String,
    /// JSON: the PM run under way ({run_id, job})
    pub meta: String,
    pub created_by: Option<String>,
    pub created_at: String,
    pub handed_at: Option<String>,
    /// the plan was approved
    pub started_at: Option<String>,
    pub closed_at: Option<String>,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}

/// A new row with the defaults of the Python model `Story`.
/// Set before saving: `ticket_id`, `project_id`.
pub fn new() -> ActiveModel {
    ActiveModel {
        ticket_id: NotSet,
        project_id: NotSet,
        state: Set("draft".to_string()),
        approve: Set("person".to_string()),
        budget_tokens: Set(0),
        pm_id: Set(None),
        plan: Set("{}".to_string()),
        paused: Set(false),
        review_note: Set(None),
        history: Set("[]".to_string()),
        meta: Set("{}".to_string()),
        created_by: Set(None),
        created_at: Set(kb_base::time::now_iso()),
        handed_at: Set(None),
        started_at: Set(None),
        closed_at: Set(None),
    }
}
