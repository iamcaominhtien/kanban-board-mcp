//! `docs_draft` (Python model `DocsDraft`). Generated from the Python model by `contract/gen_entities.py` (removed in 5.0.0, with the Python server); now edited by hand.

use sea_orm::ActiveValue::{NotSet, Set};
use sea_orm::entity::prelude::*;
use serde::{Deserialize, Serialize};

/// Autosaved, per-author working copy of a page.
#[derive(Clone, Debug, PartialEq, DeriveEntityModel, Serialize, Deserialize)]
#[sea_orm(table_name = "docs_draft")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false)]
    pub id: String,
    pub page_id: String,
    pub author: String,
    pub title: String,
    pub markdown: String,
    pub base_version: i32,
    /// autosaves since the draft was started
    pub saves: i32,
    pub updated_at: String,
    /// "Drafted with AI": JSON {kind, from, member_id, gaps: [], sources: [], accepted: bool}; None for a plain draft
    pub ai_source: Option<String>,
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

/// A new row with the defaults of the Python model `DocsDraft`.
/// Set before saving: `page_id`, `title`.
pub fn new() -> ActiveModel {
    ActiveModel {
        id: Set(kb_base::time::uuid4()),
        page_id: NotSet,
        author: Set("user".to_string()),
        title: NotSet,
        markdown: Set("".to_string()),
        base_version: Set(0),
        saves: Set(1),
        updated_at: Set(kb_base::time::now_iso()),
        ai_source: Set(None),
        format: Set("md".to_string()),
        content: Set(None),
        text: Set(None),
    }
}

/// The `format` of a row written before format 1 (a dump of an older database has no such column).
fn markdown_format() -> String {
    "md".to_string()
}
