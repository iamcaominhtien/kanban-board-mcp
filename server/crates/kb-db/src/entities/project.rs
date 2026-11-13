//! `project` (Python model `Project`). Generated from the Python model by `contract/gen_entities.py` (removed in 5.0.0, with the Python server); now edited by hand.

use sea_orm::ActiveValue::{NotSet, Set};
use sea_orm::entity::prelude::*;
use serde::{Deserialize, Serialize};

/// Kanban project (table).
#[derive(Clone, Debug, PartialEq, DeriveEntityModel, Serialize, Deserialize)]
#[sea_orm(table_name = "project")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false)]
    pub id: String,
    pub name: String,
    /// e.g. "IAM", uppercase, max 6 chars
    pub prefix: String,
    /// hex accent color
    pub color: String,
    pub ticket_counter: i32,
    pub repo_path: Option<String>,
    pub worktree_template: Option<String>,
    pub worktree_by_default: bool,
    pub docs_enabled: bool,
    pub docs_edit_policy: String,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}

/// A new row with the defaults of the Python model `Project`.
/// Set before saving: `name`, `prefix`, `color`.
pub fn new() -> ActiveModel {
    ActiveModel {
        id: Set(kb_base::time::uuid4()),
        name: NotSet,
        prefix: NotSet,
        color: NotSet,
        ticket_counter: Set(0),
        repo_path: Set(None),
        worktree_template: Set(None),
        worktree_by_default: Set(false),
        docs_enabled: Set(true),
        docs_edit_policy: Set("members".to_string()),
    }
}
