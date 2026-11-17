//! `docs_public_link` (Rich Docs, migration `e4b6d8f0a2c3`). Written by hand, in the style of the generated entities.

use sea_orm::ActiveValue::{NotSet, Set};
use sea_orm::entity::prelude::*;
use serde::{Deserialize, Serialize};

/// A page shared by a secret link that anyone holding it can open.
#[derive(Clone, Debug, PartialEq, DeriveEntityModel, Serialize, Deserialize)]
#[sea_orm(table_name = "docs_public_link")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false)]
    pub id: String,
    pub page_id: String,
    /// The secret in the link; unique
    pub token: String,
    pub created_by: String,
    pub created_at: String,
    /// None = never expires
    pub expires_at: Option<String>,
    /// Whether the public page shows who wrote and commented
    pub show_names: bool,
    /// Whether search engines may index the page
    pub allow_index: bool,
    /// Set when the link was turned off
    pub revoked_at: Option<String>,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}

/// A new row with the defaults of the table.
/// Set before saving: `page_id`, `token`, `created_by`.
pub fn new() -> ActiveModel {
    ActiveModel {
        id: Set(kb_base::time::uuid4()),
        page_id: NotSet,
        token: NotSet,
        created_by: NotSet,
        created_at: Set(kb_base::time::now_iso()),
        expires_at: Set(None),
        show_names: Set(false),
        allow_index: Set(false),
        revoked_at: Set(None),
    }
}
