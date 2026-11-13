//! `ai_knowledge_doc` (Python model `AiKnowledgeDoc`). Generated from the Python model by `contract/gen_entities.py` (removed in 5.0.0, with the Python server); now edited by hand.

use sea_orm::ActiveValue::{NotSet, Set};
use sea_orm::entity::prelude::*;
use serde::{Deserialize, Serialize};

/// A document of the knowledge base: its text, a summary and keywords, in a project's store or the shared one
/// (services/ai/kb.py) (table).
#[derive(Clone, Debug, PartialEq, DeriveEntityModel, Serialize, Deserialize)]
#[sea_orm(table_name = "ai_knowledge_doc")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false)]
    pub id: String,
    pub project_id: Option<String>,
    /// project | shared
    pub store: String,
    pub title: String,
    /// text | pdf | image | code | docs_page
    pub kind: String,
    pub text: String,
    pub summary: Option<String>,
    pub keywords: String,
    pub answers: String,
    /// model | code
    pub described_by: Option<String>,
    pub source_name: Option<String>,
    pub upload_url: Option<String>,
    pub private: bool,
    pub tokens: i32,
    pub created_by: Option<String>,
    pub created_at: String,
    pub last_read_at: Option<String>,
    pub deleted_at: Option<String>,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}

/// A new row with the defaults of the Python model `AiKnowledgeDoc`.
/// Set before saving: `title`.
pub fn new() -> ActiveModel {
    ActiveModel {
        id: Set(kb_base::time::prefixed_id("kb_", 12)),
        project_id: Set(None),
        store: Set("project".to_string()),
        title: NotSet,
        kind: Set("text".to_string()),
        text: Set("".to_string()),
        summary: Set(None),
        keywords: Set("[]".to_string()),
        answers: Set("[]".to_string()),
        described_by: Set(None),
        source_name: Set(None),
        upload_url: Set(None),
        private: Set(false),
        tokens: Set(0),
        created_by: Set(None),
        created_at: Set(kb_base::time::now_iso()),
        last_read_at: Set(None),
        deleted_at: Set(None),
    }
}
