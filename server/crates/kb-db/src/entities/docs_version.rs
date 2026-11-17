//! `docs_version` (Python model `DocsVersion`). Generated from the Python model by `contract/gen_entities.py` (removed in 5.0.0, with the Python server); now edited by hand.

use sea_orm::ActiveValue::{NotSet, Set};
use sea_orm::entity::prelude::*;
use serde::{Deserialize, Serialize};

/// Immutable published version of a Docs page (table).
#[derive(Clone, Debug, PartialEq, DeriveEntityModel, Serialize, Deserialize)]
#[sea_orm(table_name = "docs_version")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false)]
    pub id: String,
    pub page_id: String,
    pub version: i32,
    pub title: String,
    pub markdown: String,
    pub author: String,
    pub note: Option<String>,
    pub created_at: String,
    /// JSON {diagram id: version} the page used when it was published; restoring the page restores them
    pub diagram_versions: String,
    /// The author accepted AI text in this version (History marks it; the page itself is never stamped)
    pub with_ai: bool,
    /// `md` (Markdown in `markdown`) or `rich` (the page is the JSON in `content`)
    #[serde(default = "markdown_format")]
    pub format: String,
    /// The page as rich JSON; None while `format` is `md`
    #[serde(default)]
    pub content: Option<String>,
    /// Plain-text projection of `content`, for search and AI; None while `format` is `md`
    #[serde(default)]
    pub text: Option<String>,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}

/// A new row with the defaults of the Python model `DocsVersion`.
/// Set before saving: `page_id`, `version`, `title`.
pub fn new() -> ActiveModel {
    ActiveModel {
        id: Set(kb_base::time::uuid4()),
        page_id: NotSet,
        version: NotSet,
        title: NotSet,
        markdown: Set("".to_string()),
        author: Set("user".to_string()),
        note: Set(None),
        created_at: Set(kb_base::time::now_iso()),
        diagram_versions: Set("{}".to_string()),
        with_ai: Set(false),
        format: Set("md".to_string()),
        content: Set(None),
        text: Set(None),
    }
}

/// The `format` of a row written before format 1 (a dump of an older database has no such column).
fn markdown_format() -> String {
    "md".to_string()
}
