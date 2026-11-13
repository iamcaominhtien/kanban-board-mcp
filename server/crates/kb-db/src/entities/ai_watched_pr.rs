//! `ai_watched_pr` (Python model `AiWatchedPr`). Generated from the Python model by `contract/gen_entities.py` (removed in 5.0.0, with the Python server); now edited by hand.

use sea_orm::ActiveValue::{NotSet, Set};
use sea_orm::entity::prelude::*;
use serde::{Deserialize, Serialize};

/// A pull request the board opened, watched with gh while it is open (services/ai/github.py) (table).
#[derive(Clone, Debug, PartialEq, DeriveEntityModel, Serialize, Deserialize)]
#[sea_orm(table_name = "ai_watched_pr")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false)]
    pub ticket_id: String,
    pub project_id: String,
    pub number: i32,
    pub url: Option<String>,
    pub branch: String,
    pub repo: String,
    /// open | closed
    pub state: String,
    /// green | red | pending | none
    pub ci: Option<String>,
    pub red: Option<String>,
    pub seen_comments: String,
    pub pending_comments: String,
    pub checked_at: Option<String>,
    pub last_error: Option<String>,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}

/// A new row with the defaults of the Python model `AiWatchedPr`.
/// Set before saving: `ticket_id`, `project_id`, `number`, `branch`, `repo`.
pub fn new() -> ActiveModel {
    ActiveModel {
        ticket_id: NotSet,
        project_id: NotSet,
        number: NotSet,
        url: Set(None),
        branch: NotSet,
        repo: NotSet,
        state: Set("open".to_string()),
        ci: Set(None),
        red: Set(None),
        seen_comments: Set("[]".to_string()),
        pending_comments: Set("[]".to_string()),
        checked_at: Set(None),
        last_error: Set(None),
    }
}
