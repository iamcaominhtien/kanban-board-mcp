//! The Idea Space data model as the services use it: `models.py` lines 154-190 (the allowed values), 199-478 (the
//! tables, which are `kb_db::entities::idea_*`) and 2405-2441 (`idea_readiness`).
//!
//! `IdeaTicket` has four relationships with `lazy="selectin"`: every query of ideas also reads its assumptions (with
//! their evidence), votes, comments and log entries, ordered as the relationship says. `Idea` is an idea row with
//! those records; `load` and `load_many` read them with the same queries, and the code reads them again exactly where
//! the Python code reads `idea.assumption_records` after a reload.

use std::ops::Deref;

use kb_db::Session;
use kb_db::entities::{idea_assumption, idea_comment, idea_evidence, idea_log_entry, idea_ticket, idea_vote};
use kb_db::sea_orm::{
    ActiveModelBehavior, ActiveModelTrait, ColumnTrait, DbErr, EntityTrait, IntoActiveModel, Iterable, ModelTrait,
    QueryFilter, QueryOrder,
};
use serde_json::{Map, Value, json};

/// `IDEA_STATUSES`.
pub const IDEA_STATUSES: [&str; 4] = ["draft", "in_review", "approved", "dropped"];
/// `IDEA_STAGES`: the Idea Space stages.
pub const IDEA_STAGES: [&str; 7] = ["inbox", "exploring", "ready", "building", "parked", "shipped", "archived"];
/// `IDEA_SOURCES`.
pub const IDEA_SOURCES: [&str; 8] = ["manual", "selection", "doc", "comment", "ticket", "picture", "ai", "import"];
/// `ASSUMPTION_IMPACTS`.
pub const ASSUMPTION_IMPACTS: [&str; 3] = ["low", "medium", "high"];
/// `ASSUMPTION_STATUSES`.
pub const ASSUMPTION_STATUSES: [&str; 4] = ["untested", "testing", "validated", "disproved"];
/// `EVIDENCE_KINDS`.
pub const EVIDENCE_KINDS: [&str; 7] = ["comment", "file", "link", "ticket", "sketch", "diagram", "note"];
/// `ARCHIVE_REASONS`.
pub const ARCHIVE_REASONS: [&str; 5] = ["already_exists", "too_big", "not_now", "wrong_direction", "other"];
/// `LOG_KINDS`.
pub const LOG_KINDS: [&str; 6] = ["note", "research", "interview", "experiment", "finding", "decision"];
/// `WORKSPACE_RETENTIONS`.
pub const WORKSPACE_RETENTIONS: [&str; 3] = ["open_then_30", "30_days", "forever"];
/// `IDEA_COLORS`.
pub const IDEA_COLORS: [&str; 7] = ["yellow", "orange", "lime", "pink", "blue", "purple", "teal"];

/// An assumption with its evidence (`IdeaAssumption.evidence`: ordered by `created_at`).
#[derive(Debug, Clone, PartialEq)]
pub struct AssumptionRecord {
    /// The `idea_assumption` row.
    pub row: idea_assumption::Model,
    /// Its evidence, oldest first.
    pub evidence: Vec<idea_evidence::Model>,
}

impl Deref for AssumptionRecord {
    type Target = idea_assumption::Model;

    fn deref(&self) -> &Self::Target {
        &self.row
    }
}

/// An idea with the records its relationships load.
#[derive(Debug, Clone, PartialEq)]
pub struct Idea {
    /// The `idea_ticket` row; the services change it and `save` writes the difference.
    pub row: idea_ticket::Model,
    /// The row as it was read, to find what changed.
    pub(crate) loaded: idea_ticket::Model,
    /// `assumption_records`, ordered by `position`.
    pub assumption_records: Vec<AssumptionRecord>,
    /// `vote_records`.
    pub vote_records: Vec<idea_vote::Model>,
    /// `comment_records`, oldest first.
    pub comment_records: Vec<idea_comment::Model>,
    /// `log_records`, oldest first.
    pub log_records: Vec<idea_log_entry::Model>,
}

impl Deref for Idea {
    type Target = idea_ticket::Model;

    fn deref(&self) -> &Self::Target {
        &self.row
    }
}

impl Idea {
    /// The assumption records as the bare rows.
    pub fn assumptions(&self) -> impl Iterator<Item = &idea_assumption::Model> {
        self.assumption_records.iter().map(|a| &a.row)
    }
}

/// How many parents SQLAlchemy puts in one `IN (...)` of a selectin load.
const SELECTIN_CHUNK: usize = 500;

/// The records of ideas, read the way the selectin loaders read them (one query per kind and chunk of 500 parents).
pub async fn load_many(session: &Session, rows: Vec<idea_ticket::Model>) -> Result<Vec<Idea>, DbErr> {
    let mut out: Vec<Idea> = rows
        .into_iter()
        .map(|row| Idea {
            loaded: row.clone(),
            row,
            assumption_records: Vec::new(),
            vote_records: Vec::new(),
            comment_records: Vec::new(),
            log_records: Vec::new(),
        })
        .collect();
    for chunk in out.chunks_mut(SELECTIN_CHUNK) {
        let ids: Vec<String> = chunk.iter().map(|idea| idea.row.id.clone()).collect();
        let assumptions = idea_assumption::Entity::find()
            .filter(idea_assumption::Column::IdeaId.is_in(ids.clone()))
            .order_by_asc(idea_assumption::Column::Position)
            .all(session)
            .await?;
        let mut evidence = if assumptions.is_empty() {
            Vec::new()
        } else {
            idea_evidence::Entity::find()
                .filter(idea_evidence::Column::AssumptionId.is_in(assumptions.iter().map(|a| a.id.clone())))
                .order_by_asc(idea_evidence::Column::CreatedAt)
                .all(session)
                .await?
        };
        let votes = idea_vote::Entity::find().filter(idea_vote::Column::IdeaId.is_in(ids.clone())).all(session).await?;
        let comments = idea_comment::Entity::find()
            .filter(idea_comment::Column::IdeaId.is_in(ids.clone()))
            .order_by_asc(idea_comment::Column::CreatedAt)
            .all(session)
            .await?;
        let logs = idea_log_entry::Entity::find()
            .filter(idea_log_entry::Column::IdeaId.is_in(ids))
            .order_by_asc(idea_log_entry::Column::CreatedAt)
            .all(session)
            .await?;
        for idea in chunk.iter_mut() {
            for a in assumptions.iter().filter(|a| a.idea_id == idea.row.id) {
                let (mine, rest): (Vec<_>, Vec<_>) = evidence.drain(..).partition(|e| e.assumption_id == a.id);
                evidence = rest;
                idea.assumption_records.push(AssumptionRecord { row: a.clone(), evidence: mine });
            }
            idea.vote_records = votes.iter().filter(|v| v.idea_id == idea.row.id).cloned().collect();
            idea.comment_records = comments.iter().filter(|c| c.idea_id == idea.row.id).cloned().collect();
            idea.log_records = logs.iter().filter(|e| e.idea_id == idea.row.id).cloned().collect();
        }
    }
    Ok(out)
}

/// The records of one idea.
pub async fn load(session: &Session, row: idea_ticket::Model) -> Result<Idea, DbErr> {
    let mut ideas = load_many(session, vec![row]).await?;
    Ok(ideas.remove(0))
}

/// `idea_readiness(assumptions)`: how ready an idea is, worked out from its assumptions (design: "F. Readiness").
///
/// Only high-impact assumptions decide it; if none is high-impact, every assumption must be validated. An idea with
/// no assumptions is "not_started", never "ready".
///
/// Returns `{state: not_started|growing|ready|at_risk, total, untested, testing, validated, disproved, high_open
/// (high-impact ones not yet validated), high_disproved, next_id (the assumption to test first)}`.
pub fn idea_readiness<'a>(assumptions: impl IntoIterator<Item = &'a idea_assumption::Model>) -> Map<String, Value> {
    let items: Vec<&idea_assumption::Model> = assumptions.into_iter().collect();
    let count = |status: &str| items.iter().filter(|a| a.status == status).count();
    let high: Vec<&idea_assumption::Model> = items.iter().copied().filter(|a| a.impact == "high").collect();
    let deciding = if high.is_empty() { &items } else { &high };
    let high_open: Vec<&&idea_assumption::Model> = high.iter().filter(|a| a.status != "validated").collect();
    let high_disproved = high.iter().filter(|a| a.status == "disproved").count();
    let state = if items.is_empty() {
        "not_started"
    } else if high_disproved > 0 {
        "at_risk"
    } else if deciding.iter().all(|a| a.status == "validated") && count("disproved") == 0 {
        "ready"
    } else {
        "growing"
    };
    let first = high_open.iter().find(|a| a.status != "disproved");
    let mut out = Map::new();
    out.insert("state".into(), json!(state));
    out.insert("total".into(), json!(items.len()));
    for status in crate::model::ASSUMPTION_STATUSES {
        out.insert(status.into(), json!(count(status)));
    }
    out.insert("high_open".into(), json!(high_open.len()));
    out.insert("high_disproved".into(), json!(high_disproved));
    out.insert("next_id".into(), first.map_or(Value::Null, |a| json!(a.id)));
    out
}
