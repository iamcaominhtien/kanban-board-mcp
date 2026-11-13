//! `ai_worktree` (Python model `AiWorktree`). Generated from the Python model by `contract/gen_entities.py` (removed in 5.0.0, with the Python server); now edited by hand.

use sea_orm::ActiveValue::{NotSet, Set};
use sea_orm::entity::prelude::*;
use serde::{Deserialize, Serialize};

/// A ticket's git worktree, beside the repository, on its own branch and port (services/ai/worktrees.py) (table).
/// The board stores only the mapping; size and uncommitted files are read from git when asked.
#[derive(Clone, Debug, PartialEq, DeriveEntityModel, Serialize, Deserialize)]
#[sea_orm(table_name = "ai_worktree")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false)]
    pub ticket_id: String,
    pub project_id: String,
    /// the main checkout
    pub repo: String,
    pub path: String,
    pub branch: String,
    pub base: String,
    pub port: Option<i32>,
    pub state: String,
    pub handover: Option<String>,
    pub pr_url: Option<String>,
    pub pr_number: Option<i32>,
    pub conflict_files: String,
    pub prepared_at: Option<String>,
    pub prepare_s: Option<i32>,
    pub created_at: String,
    pub last_used_at: Option<String>,
    pub merged_at: Option<String>,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}

/// A new row with the defaults of the Python model `AiWorktree`.
/// Set before saving: `ticket_id`, `project_id`, `repo`, `path`, `branch`.
pub fn new() -> ActiveModel {
    ActiveModel {
        ticket_id: NotSet,
        project_id: NotSet,
        repo: NotSet,
        path: NotSet,
        branch: NotSet,
        base: Set("main".to_string()),
        port: Set(None),
        state: Set("active".to_string()),
        handover: Set(None),
        pr_url: Set(None),
        pr_number: Set(None),
        conflict_files: Set("[]".to_string()),
        prepared_at: Set(None),
        prepare_s: Set(None),
        created_at: Set(kb_base::time::now_iso()),
        last_used_at: Set(None),
        merged_at: Set(None),
    }
}
