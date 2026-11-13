//! `docs_ai_job` (Python model `DocsAiJob`). Generated from the Python model by `contract/gen_entities.py` (removed in 5.0.0, with the Python server); now edited by hand.

use sea_orm::ActiveValue::{NotSet, Set};
use sea_orm::entity::prelude::*;
use serde::{Deserialize, Serialize};

use crate::float::Float;

/// One Docs AI call (ask, thread reply, check, translate, summary, freshness...). The Docs counterpart of an
/// AI run: who asked, which AI answered, which pages it read, what it cost.
#[derive(Clone, Debug, PartialEq, DeriveEntityModel, Serialize, Deserialize)]
#[sea_orm(table_name = "docs_ai_job")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false)]
    pub id: String,
    pub project_id: String,
    pub page_id: Option<String>,
    pub thread_id: Option<String>,
    pub comment_id: Option<String>,
    pub member_id: Option<String>,
    /// ask | thread_reply | thread_summary | check | translate | explain | summary | history_summary | publish_note
    /// | tickets | write | freshness | tidy | suggest_edit
    pub kind: String,
    pub state: String,
    pub started_by: String,
    pub instruction: String,
    pub session_id: Option<String>,
    pub reads: String,
    /// JSON [{at, text}]
    pub steps: String,
    /// JSON, per kind
    pub result: String,
    /// JSON {code, message}
    pub error: String,
    pub tokens_in: i32,
    pub tokens_out: i32,
    #[sea_orm(column_type = "Double")]
    pub cost_usd: Float,
    pub metered: bool,
    pub reply_comment_id: Option<String>,
    pub queued_at: String,
    pub started_at: Option<String>,
    pub ended_at: Option<String>,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}

/// A new row with the defaults of the Python model `DocsAiJob`.
/// Set before saving: `project_id`, `kind`.
pub fn new() -> ActiveModel {
    ActiveModel {
        id: Set(kb_base::time::prefixed_id("dj_", 12)),
        project_id: NotSet,
        page_id: Set(None),
        thread_id: Set(None),
        comment_id: Set(None),
        member_id: Set(None),
        kind: NotSet,
        state: Set("queued".to_string()),
        started_by: Set("user".to_string()),
        instruction: Set("".to_string()),
        session_id: Set(None),
        reads: Set("[]".to_string()),
        steps: Set("[]".to_string()),
        result: Set("{}".to_string()),
        error: Set("{}".to_string()),
        tokens_in: Set(0),
        tokens_out: Set(0),
        cost_usd: Set(Float(0.0)),
        metered: Set(false),
        reply_comment_id: Set(None),
        queued_at: Set(kb_base::time::now_iso()),
        started_at: Set(None),
        ended_at: Set(None),
    }
}
