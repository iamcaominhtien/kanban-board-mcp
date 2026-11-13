//! `idea_ticket` (Python model `IdeaTicket`). Generated from the Python model by `contract/gen_entities.py` (removed in 5.0.0, with the Python server); now edited by hand.

use sea_orm::ActiveValue::{NotSet, Set};
use sea_orm::entity::prelude::*;
use serde::{Deserialize, Serialize};

/// Idea Space ticket (table).
#[derive(Clone, Debug, PartialEq, DeriveEntityModel, Serialize, Deserialize)]
#[sea_orm(table_name = "idea_ticket")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false)]
    pub id: String,
    /// None = the idea belongs to no project yet.
    pub project_id: Option<String>,
    pub title: String,
    pub description: String,
    /// Legacy status the current Idea board still drives; `stage` is the model that replaces it.
    /// draft|in_review|approved|dropped
    pub idea_status: String,
    /// see IDEA_STAGES
    pub stage: String,
    /// ISO date, Parked ideas only
    pub park_until: Option<String>,
    pub archive_reason: Option<String>,
    /// see IDEA_SOURCES
    pub source: String,
    /// JSON {kind, id, label, quote, url, by, why}: where it came from (a Doc, comment, ticket, AI member).
    pub source_ref: String,
    pub created_by: Option<String>,
    pub owner: Option<String>,
    pub park_note: Option<String>,
    pub archive_note: Option<String>,
    pub stage_changed_at: Option<String>,
    /// JSON snapshot of the fields the last stage move changed, so that move can be undone.
    pub prev_state: String,
    pub merged_into_id: Option<String>,
    pub merged_at: Option<String>,
    pub merge_undo: String,
    pub shipped_at: Option<String>,
    pub outcome: Option<String>,
    pub outcome_note: Option<String>,
    pub former_ticket_id: Option<String>,
    pub effort_guess: Option<String>,
    pub workspace_retention: String,
    /// the idea page, markdown as for Docs
    pub body: String,
    pub details: String,
    pub idea_color: String,
    pub idea_emoji: String,
    /// seed|concept|hot|big_bet
    pub idea_energy: Option<String>,
    /// JSON list of strings
    pub tags: String,
    pub problem_statement: Option<String>,
    pub ice_impact: i32,
    pub ice_effort: i32,
    pub ice_confidence: i32,
    pub revisit_date: Option<String>,
    pub last_touched_at: Option<String>,
    pub promoted_to_ticket_id: Option<String>,
    pub promoted_at: Option<String>,
    /// JSON list of {id, label, at, author}; entries from before the new model have no author.
    pub activity_trail: String,
    /// JSON list of {id, text, at}
    pub microthoughts: String,
    /// Superseded by `assumption_records`; kept only so a conversion can be checked against it.
    pub assumptions: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}

/// A new row with the defaults of the Python model `IdeaTicket`.
/// Set before saving: `id`, `title`.
pub fn new() -> ActiveModel {
    ActiveModel {
        id: NotSet,
        project_id: Set(None),
        title: NotSet,
        description: Set("".to_string()),
        idea_status: Set("draft".to_string()),
        stage: Set("inbox".to_string()),
        park_until: Set(None),
        archive_reason: Set(None),
        source: Set("manual".to_string()),
        source_ref: Set("{}".to_string()),
        created_by: Set(None),
        owner: Set(None),
        park_note: Set(None),
        archive_note: Set(None),
        stage_changed_at: Set(None),
        prev_state: Set("{}".to_string()),
        merged_into_id: Set(None),
        merged_at: Set(None),
        merge_undo: Set("{}".to_string()),
        shipped_at: Set(None),
        outcome: Set(None),
        outcome_note: Set(None),
        former_ticket_id: Set(None),
        effort_guess: Set(None),
        workspace_retention: Set("open_then_30".to_string()),
        body: Set("".to_string()),
        details: Set("".to_string()),
        idea_color: Set("yellow".to_string()),
        idea_emoji: Set("💡".to_string()),
        idea_energy: Set(None),
        tags: Set("[]".to_string()),
        problem_statement: Set(None),
        ice_impact: Set(3),
        ice_effort: Set(3),
        ice_confidence: Set(3),
        revisit_date: Set(None),
        last_touched_at: Set(None),
        promoted_to_ticket_id: Set(None),
        promoted_at: Set(None),
        activity_trail: Set("[]".to_string()),
        microthoughts: Set("[]".to_string()),
        assumptions: Set("[]".to_string()),
        created_at: Set(kb_base::time::now_iso()),
        updated_at: Set(kb_base::time::now_iso()),
    }
}
