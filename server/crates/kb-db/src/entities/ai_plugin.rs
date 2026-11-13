//! `ai_plugin` (Python model `AiPlugin`). Generated from the Python model by `contract/gen_entities.py` (removed in 5.0.0, with the Python server); now edited by hand.

use sea_orm::ActiveValue::{NotSet, Set};
use sea_orm::entity::prelude::*;
use serde::{Deserialize, Serialize};

/// A plugin installed on a project from a git URL, a marketplace or a folder (services/ai/plugins.py) (table).
#[derive(Clone, Debug, PartialEq, DeriveEntityModel, Serialize, Deserialize)]
#[sea_orm(table_name = "ai_plugin")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false)]
    pub id: String,
    pub project_id: Option<String>,
    pub name: String,
    /// git | marketplace | folder
    pub source_kind: String,
    pub source: String,
    #[sea_orm(column_name = "ref")]
    #[serde(rename = "ref")]
    pub r#ref: Option<String>,
    /// the marketplace entry
    pub plugin: Option<String>,
    pub skills_wanted: String,
    pub commit: Option<String>,
    pub version: Option<String>,
    pub description: Option<String>,
    /// the installed copy
    pub path: Option<String>,
    pub skills: String,
    pub hooks: i32,
    pub mcp: i32,
    pub size_bytes: i32,
    pub pinned: bool,
    /// the project default
    pub default_on: bool,
    /// role pack keys that get it
    pub roles: String,
    /// {member_id: on/off}: a member's own switch
    pub members: String,
    pub previous: Option<String>,
    pub installed_by: Option<String>,
    pub installed_at: String,
    pub updated_at: String,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}

/// A new row with the defaults of the Python model `AiPlugin`.
/// Set before saving: `name`, `source`.
pub fn new() -> ActiveModel {
    ActiveModel {
        id: Set(kb_base::time::prefixed_id("plg_", 12)),
        project_id: Set(None),
        name: NotSet,
        source_kind: Set("git".to_string()),
        source: NotSet,
        r#ref: Set(None),
        plugin: Set(None),
        skills_wanted: Set("[]".to_string()),
        commit: Set(None),
        version: Set(None),
        description: Set(None),
        path: Set(None),
        skills: Set("[]".to_string()),
        hooks: Set(0),
        mcp: Set(0),
        size_bytes: Set(0),
        pinned: Set(false),
        default_on: Set(false),
        roles: Set("[]".to_string()),
        members: Set("{}".to_string()),
        previous: Set(None),
        installed_by: Set(None),
        installed_at: Set(kb_base::time::now_iso()),
        updated_at: Set(kb_base::time::now_iso()),
    }
}
