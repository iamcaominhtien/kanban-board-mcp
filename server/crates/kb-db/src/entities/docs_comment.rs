//! `docs_comment` (Python model `DocsComment`). Generated from the Python model by `contract/gen_entities.py` (removed in 5.0.0, with the Python server); now edited by hand.

use sea_orm::ActiveValue::{NotSet, Set};
use sea_orm::entity::prelude::*;
use serde::{Deserialize, Serialize};

/// One comment in a thread; the first is the thread's opening comment.
#[derive(Clone, Debug, PartialEq, DeriveEntityModel, Serialize, Deserialize)]
#[sea_orm(table_name = "docs_comment")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false)]
    pub id: String,
    pub thread_id: String,
    pub author: String,
    pub body: String,
    /// JSON list of member ids
    pub mentions: String,
    pub created_at: String,
    pub edited_at: Option<String>,
    /// Set on an AI member's reply: JSON {member_id, job_id, cost, sources: [], can_suggest: bool}
    pub ai: Option<String>,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}

/// A new row with the defaults of the Python model `DocsComment`.
/// Set before saving: `thread_id`.
pub fn new() -> ActiveModel {
    ActiveModel {
        id: Set(kb_base::time::uuid4()),
        thread_id: NotSet,
        author: Set("user".to_string()),
        body: Set("".to_string()),
        mentions: Set("[]".to_string()),
        created_at: Set(kb_base::time::now_iso()),
        edited_at: Set(None),
        ai: Set(None),
    }
}
