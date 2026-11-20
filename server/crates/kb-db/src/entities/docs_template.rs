//! `docs_template` (Rich Docs, migration `e4b6d8f0a2c3`). Written by hand, in the style of the generated entities.

use sea_orm::ActiveValue::{NotSet, Set};
use sea_orm::entity::prelude::*;
use serde::{Deserialize, Serialize};

/// A page template: a person's own (`scope` me) or one the project shares (`scope` project).
#[derive(Clone, Debug, PartialEq, DeriveEntityModel, Serialize, Deserialize)]
#[sea_orm(table_name = "docs_template")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false)]
    pub id: String,
    /// The project; None for a person's own template that is not tied to one
    pub project_id: Option<String>,
    /// Who made it (the person's name)
    pub owner: String,
    pub name: String,
    pub description: Option<String>,
    pub category: Option<String>,
    /// What a page made from it keeps: content | structure | style
    pub keeps: String,
    /// me | project
    pub scope: String,
    /// The template body as rich JSON
    pub content: String,
    /// Page settings JSON the template carries; None means the defaults
    pub settings: Option<String>,
    /// How many pages were made from it
    pub used_count: i32,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}

/// A new row with the defaults of the table.
/// Set before saving: `owner`, `name`, `content`.
pub fn new() -> ActiveModel {
    ActiveModel {
        id: Set(kb_base::time::uuid4()),
        project_id: Set(None),
        owner: NotSet,
        name: NotSet,
        description: Set(None),
        category: Set(None),
        keeps: Set("content".to_string()),
        scope: Set("me".to_string()),
        content: NotSet,
        settings: Set(None),
        used_count: Set(0),
        created_at: Set(kb_base::time::now_iso()),
        updated_at: Set(kb_base::time::now_iso()),
    }
}
