//! `docs_export` (Rich Docs, migration `e4b6d8f0a2c3`). Written by hand, in the style of the generated entities.

use sea_orm::ActiveValue::{NotSet, Set};
use sea_orm::entity::prelude::*;
use serde::{Deserialize, Serialize};

/// An export of a page, its children, a space or a book to a file, and how far it has got.
#[derive(Clone, Debug, PartialEq, DeriveEntityModel, Serialize, Deserialize)]
#[sea_orm(table_name = "docs_export")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false)]
    pub id: String,
    pub project_id: String,
    /// None when the whole space is exported
    pub page_id: Option<String>,
    /// page | children | space | book
    pub scope: String,
    /// pdf | docx | html | md
    pub format: String,
    /// JSON export options
    pub options: Option<String>,
    /// running | ready | failed | cancelled | expired
    pub state: String,
    /// What the export is doing now
    pub step: Option<String>,
    /// Where the file is kept while it is ready
    pub file_path: Option<String>,
    /// The name the download gets
    pub file_name: Option<String>,
    /// Size of the file in bytes (no 64-bit column type is used in this schema)
    pub size: Option<i32>,
    /// Why it failed
    pub error: Option<String>,
    pub created_by: String,
    pub created_at: String,
    pub finished_at: Option<String>,
    /// When the file is removed
    pub expires_at: Option<String>,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}

/// A new row with the defaults of the table.
/// Set before saving: `project_id`, `scope`, `format`, `created_by`.
pub fn new() -> ActiveModel {
    ActiveModel {
        id: Set(kb_base::time::uuid4()),
        project_id: NotSet,
        page_id: Set(None),
        scope: NotSet,
        format: NotSet,
        options: Set(None),
        state: Set("running".to_string()),
        step: Set(None),
        file_path: Set(None),
        file_name: Set(None),
        size: Set(None),
        error: Set(None),
        created_by: NotSet,
        created_at: Set(kb_base::time::now_iso()),
        finished_at: Set(None),
        expires_at: Set(None),
    }
}
