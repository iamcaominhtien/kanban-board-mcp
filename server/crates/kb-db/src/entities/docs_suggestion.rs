//! `docs_suggestion` (Rich Docs, migration `e4b6d8f0a2c3`). Written by hand, in the style of the generated entities.

use sea_orm::ActiveValue::{NotSet, Set};
use sea_orm::entity::prelude::*;
use serde::{Deserialize, Serialize};

/// A change proposed to a rich page, waiting for a person to accept or reject it.
#[derive(Clone, Debug, PartialEq, DeriveEntityModel, Serialize, Deserialize)]
#[sea_orm(table_name = "docs_suggestion")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false)]
    pub id: String,
    pub page_id: String,
    /// The block it changes; None for an insert at the start
    pub block_id: Option<String>,
    /// The block an insert goes after
    pub after_block_id: Option<String>,
    /// replace | insert | delete | attrs
    pub kind: String,
    /// JSON: the proposed blocks or attributes
    pub content: Option<String>,
    /// JSON snapshot of the block when it was suggested
    pub before: Option<String>,
    /// The page version the suggestion was made on
    pub base_version: i32,
    /// The team or member name that proposed it
    pub author: String,
    pub member_id: Option<String>,
    /// The AI run that proposed it
    pub run_id: Option<String>,
    /// Why
    pub note: Option<String>,
    /// pending | accepted | rejected
    pub state: String,
    pub decided_by: Option<String>,
    pub decided_at: Option<String>,
    pub created_at: String,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}

/// A new row with the defaults of the table.
/// Set before saving: `page_id`, `kind`, `base_version`, `author`.
pub fn new() -> ActiveModel {
    ActiveModel {
        id: Set(kb_base::time::uuid4()),
        page_id: NotSet,
        block_id: Set(None),
        after_block_id: Set(None),
        kind: NotSet,
        content: Set(None),
        before: Set(None),
        base_version: NotSet,
        author: NotSet,
        member_id: Set(None),
        run_id: Set(None),
        note: Set(None),
        state: Set("pending".to_string()),
        decided_by: Set(None),
        decided_at: Set(None),
        created_at: Set(kb_base::time::now_iso()),
    }
}
