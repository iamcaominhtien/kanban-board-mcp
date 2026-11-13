//! `idea_evidence` (Python model `IdeaEvidence`). Generated from the Python model by `contract/gen_entities.py` (removed in 5.0.0, with the Python server); now edited by hand.

use sea_orm::ActiveValue::{NotSet, Set};
use sea_orm::entity::prelude::*;
use serde::{Deserialize, Serialize};

/// A link, file or note that supports or disproves an assumption (table).
#[derive(Clone, Debug, PartialEq, DeriveEntityModel, Serialize, Deserialize)]
#[sea_orm(table_name = "idea_evidence")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false)]
    pub id: String,
    pub assumption_id: String,
    /// see EVIDENCE_KINDS
    pub kind: String,
    pub title: String,
    /// URL, attachment id or the note text
    #[sea_orm(column_name = "ref")]
    #[serde(rename = "ref")]
    pub r#ref: String,
    pub created_by: Option<String>,
    pub created_at: String,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}

/// A new row with the defaults of the Python model `IdeaEvidence`.
/// Set before saving: `assumption_id`.
pub fn new() -> ActiveModel {
    ActiveModel {
        id: Set(kb_base::time::uuid4()),
        assumption_id: NotSet,
        kind: Set("link".to_string()),
        title: Set("".to_string()),
        r#ref: Set("".to_string()),
        created_by: Set(None),
        created_at: Set(kb_base::time::now_iso()),
    }
}
