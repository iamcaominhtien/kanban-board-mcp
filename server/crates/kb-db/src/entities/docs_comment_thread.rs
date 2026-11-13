//! `docs_comment_thread` (Python model `DocsCommentThread`). Generated from the Python model by `contract/gen_entities.py` (removed in 5.0.0, with the Python server); now edited by hand.

use sea_orm::ActiveValue::{NotSet, Set};
use sea_orm::entity::prelude::*;
use serde::{Deserialize, Serialize};

/// A comment thread on a Docs page: inline (tied to selected text) or page-level.
#[derive(Clone, Debug, PartialEq, DeriveEntityModel, Serialize, Deserialize)]
#[sea_orm(table_name = "docs_comment_thread")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false)]
    pub id: String,
    pub page_id: String,
    /// inline | page
    pub kind: String,
    /// open | resolved
    pub status: String,
    pub anchor_quote: Option<String>,
    pub anchor_prefix: String,
    pub anchor_suffix: String,
    pub anchor_section: Option<String>,
    /// attached | orphaned
    pub anchor_state: String,
    pub anchor_pos: Option<i32>,
    pub created_by: String,
    pub created_at: String,
    pub resolved_by: Option<String>,
    pub resolved_at: Option<String>,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}

/// A new row with the defaults of the Python model `DocsCommentThread`.
/// Set before saving: `page_id`.
pub fn new() -> ActiveModel {
    ActiveModel {
        id: Set(kb_base::time::uuid4()),
        page_id: NotSet,
        kind: Set("inline".to_string()),
        status: Set("open".to_string()),
        anchor_quote: Set(None),
        anchor_prefix: Set("".to_string()),
        anchor_suffix: Set("".to_string()),
        anchor_section: Set(None),
        anchor_state: Set("attached".to_string()),
        anchor_pos: Set(None),
        created_by: Set("user".to_string()),
        created_at: Set(kb_base::time::now_iso()),
        resolved_by: Set(None),
        resolved_at: Set(None),
    }
}
