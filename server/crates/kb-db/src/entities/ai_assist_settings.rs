//! `ai_assist_settings` (Python model `AiAssistSettings`). Generated from the Python model by `contract/gen_entities.py` (removed in 5.0.0, with the Python server); now edited by hand.

use sea_orm::ActiveValue::{NotSet, Set};
use sea_orm::entity::prelude::*;
use serde::{Deserialize, Serialize};

use crate::float::Float;

/// Board-wide settings of the Board AI assistant: features, language, style, data scope, limits and the
/// board-health schedule (design/screens/ai-board-assistant.md, H). One row (id 1).
#[derive(Clone, Debug, PartialEq, DeriveEntityModel, Serialize, Deserialize)]
#[sea_orm(table_name = "ai_assist_settings")]
pub struct Model {
    #[sea_orm(primary_key)]
    pub id: i32,
    /// JSON {chat, drafting, split, test_cases, health, docs}: bool
    pub features: String,
    pub language: String,
    /// neutral | friendly | concise
    pub tone: String,
    pub style_guide: String,
    #[sea_orm(column_type = "Double")]
    pub monthly_cap: Option<Float>,
    #[sea_orm(column_type = "Double")]
    pub per_request_cap: Option<Float>,
    /// pause | warn
    pub over_cap: String,
    /// JSON {project_id: bool}; a project not listed is shared
    pub data_scope: String,
    /// JSON list of docs page ids, never sent
    pub excluded_docs: String,
    /// JSON: schedule and noise controls of board health
    pub health: String,
    pub paused_until: Option<String>,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}

/// A new row with the defaults of the Python model `AiAssistSettings`.
pub fn new() -> ActiveModel {
    ActiveModel {
        id: NotSet,
        features: Set("{}".to_string()),
        language: Set("English (US)".to_string()),
        tone: Set("neutral".to_string()),
        style_guide: Set("".to_string()),
        monthly_cap: Set(Some(Float(20.0))),
        per_request_cap: Set(Some(Float(0.25))),
        over_cap: Set("pause".to_string()),
        data_scope: Set("{}".to_string()),
        excluded_docs: Set("[]".to_string()),
        health: Set("{}".to_string()),
        paused_until: Set(None),
    }
}
