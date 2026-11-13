//! `docs_anchor_aliases` (Python model `DocsAnchorAlias`). Generated from the Python model by `contract/gen_entities.py` (removed in 5.0.0, with the Python server); now edited by hand.

use sea_orm::ActiveValue::{NotSet, Set};
use sea_orm::entity::prelude::*;
use serde::{Deserialize, Serialize};

/// A heading that was renamed: ``[[Page#old-slug]]`` keeps resolving to ``new_slug``.
#[derive(Clone, Debug, PartialEq, DeriveEntityModel, Serialize, Deserialize)]
#[sea_orm(table_name = "docs_anchor_aliases")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false)]
    pub id: String,
    pub page_id: String,
    pub old_slug: String,
    pub new_slug: String,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}

/// A new row with the defaults of the Python model `DocsAnchorAlias`.
/// Set before saving: `page_id`, `old_slug`, `new_slug`.
pub fn new() -> ActiveModel {
    ActiveModel { id: Set(kb_base::time::uuid4()), page_id: NotSet, old_slug: NotSet, new_slug: NotSet }
}
