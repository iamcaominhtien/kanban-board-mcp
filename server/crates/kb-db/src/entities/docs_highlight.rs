//! `docs_highlight` (Rich Docs, migration `e4b6d8f0a2c3`). Written by hand, in the style of the generated entities.

use sea_orm::ActiveValue::{NotSet, Set};
use sea_orm::entity::prelude::*;
use serde::{Deserialize, Serialize};

/// A coloured passage of a rich page, which can carry a comment thread.
#[derive(Clone, Debug, PartialEq, DeriveEntityModel, Serialize, Deserialize)]
#[sea_orm(table_name = "docs_highlight")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false)]
    pub id: String,
    pub page_id: String,
    /// The block the passage starts in
    pub block_id: String,
    /// Character offset of the start in `block_id`
    pub start_offset: i32,
    /// Character offset of the end, in `end_block_id` when that is set
    pub end_offset: i32,
    /// The block the passage ends in when it crosses blocks
    pub end_block_id: Option<String>,
    /// The highlighted text when it was made
    pub quote: String,
    /// Text just before the quote, to find it again
    pub prefix: Option<String>,
    /// Text just after the quote, to find it again
    pub suffix: Option<String>,
    pub color: String,
    pub author: String,
    pub created_at: String,
    /// The comment thread on the passage
    pub thread_id: Option<String>,
    /// ok | moved | changed
    pub state: String,
    pub deleted_at: Option<String>,
    pub deleted_by: Option<String>,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}

/// A new row with the defaults of the table.
/// Set before saving: `page_id`, `block_id`, `start_offset`, `end_offset`, `quote`, `color`, `author`.
pub fn new() -> ActiveModel {
    ActiveModel {
        id: Set(kb_base::time::uuid4()),
        page_id: NotSet,
        block_id: NotSet,
        start_offset: NotSet,
        end_offset: NotSet,
        end_block_id: Set(None),
        quote: NotSet,
        prefix: Set(None),
        suffix: Set(None),
        color: NotSet,
        author: NotSet,
        created_at: Set(kb_base::time::now_iso()),
        thread_id: Set(None),
        state: Set("ok".to_string()),
        deleted_at: Set(None),
        deleted_by: Set(None),
    }
}
