//! `ai_library_item` (Python model `AiLibraryItem`). Generated from the Python model by `contract/gen_entities.py` (removed in 5.0.0, with the Python server); now edited by hand.

use sea_orm::ActiveValue::{NotSet, Set};
use sea_orm::entity::prelude::*;
use serde::{Deserialize, Serialize};

/// A skill, snippet, MCP server or tool defined once for the board and attached to many AI members (table).
#[derive(Clone, Debug, PartialEq, DeriveEntityModel, Serialize, Deserialize)]
#[sea_orm(table_name = "ai_library_item")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false)]
    pub id: String,
    pub project_id: String,
    /// skill | snippet | mcp_server | tool
    #[sea_orm(column_name = "type")]
    #[serde(rename = "type")]
    pub r#type: String,
    pub name: String,
    pub description: String,
    pub content: String,
    pub version: i32,
    /// JSON [{version, content, description, at, by, note}] of every earlier version, newest last
    pub history: String,
    pub created_by: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}

/// A new row with the defaults of the Python model `AiLibraryItem`.
/// Set before saving: `project_id`, `type`, `name`.
pub fn new() -> ActiveModel {
    ActiveModel {
        id: Set(kb_base::time::uuid4()),
        project_id: NotSet,
        r#type: NotSet,
        name: NotSet,
        description: Set("".to_string()),
        content: Set("".to_string()),
        version: Set(1),
        history: Set("[]".to_string()),
        created_by: Set(None),
        created_at: Set(kb_base::time::now_iso()),
        updated_at: Set(kb_base::time::now_iso()),
    }
}
