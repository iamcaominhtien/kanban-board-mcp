//! `diagram_version` (Python model `DiagramVersion`). Generated from the Python model by `contract/gen_entities.py` (removed in 5.0.0, with the Python server); now edited by hand.

use sea_orm::ActiveValue::{NotSet, Set};
use sea_orm::entity::prelude::*;
use serde::{Deserialize, Serialize};

/// One saved version of a diagram: the editable ``.drawio`` source and its SVG preview.
#[derive(Clone, Debug, PartialEq, DeriveEntityModel, Serialize, Deserialize)]
#[sea_orm(table_name = "diagram_version")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false)]
    pub id: String,
    pub diagram_id: String,
    pub version: i32,
    pub source: String,
    pub svg: String,
    /// who drew the preview: editor (draw.io itself, exact) | agent (an SVG the agent supplied) | basic (the server's plain drawing)
    pub preview_kind: String,
    pub author: String,
    pub note: Option<String>,
    pub created_at: String,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}

/// A new row with the defaults of the Python model `DiagramVersion`.
/// Set before saving: `diagram_id`, `version`.
pub fn new() -> ActiveModel {
    ActiveModel {
        id: Set(kb_base::time::uuid4()),
        diagram_id: NotSet,
        version: NotSet,
        source: Set("".to_string()),
        svg: Set("".to_string()),
        preview_kind: Set("editor".to_string()),
        author: Set("user".to_string()),
        note: Set(None),
        created_at: Set(kb_base::time::now_iso()),
    }
}
