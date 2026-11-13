//! `docs_link` (Python model `DocsLink`). Generated from the Python model by `contract/gen_entities.py` (removed in 5.0.0, with the Python server); now edited by hand.

use sea_orm::ActiveValue::{NotSet, Set};
use sea_orm::entity::prelude::*;
use serde::{Deserialize, Serialize};

/// Reference index: one row per [[page]] or ticket key in a published page.
#[derive(Clone, Debug, PartialEq, DeriveEntityModel, Serialize, Deserialize)]
#[sea_orm(table_name = "docs_link")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false)]
    pub id: String,
    pub source_page_id: String,
    pub source_section: Option<String>,
    pub target_page_id: Option<String>,
    pub target_title: Option<String>,
    pub target_anchor: Option<String>,
    pub target_ticket_id: Option<String>,
    pub display_text: Option<String>,
    pub snippet: String,
    /// page: written in a published page; manual: a person linked a ticket to a page.
    /// (Mentions in a ticket's description or comments are derived on read, not stored.)
    pub origin: String,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}

/// A new row with the defaults of the Python model `DocsLink`.
/// Set before saving: `source_page_id`.
pub fn new() -> ActiveModel {
    ActiveModel {
        id: Set(kb_base::time::uuid4()),
        source_page_id: NotSet,
        source_section: Set(None),
        target_page_id: Set(None),
        target_title: Set(None),
        target_anchor: Set(None),
        target_ticket_id: Set(None),
        display_text: Set(None),
        snippet: Set("".to_string()),
        origin: Set("page".to_string()),
    }
}
