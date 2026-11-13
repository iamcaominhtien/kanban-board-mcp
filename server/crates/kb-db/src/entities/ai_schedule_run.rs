//! `ai_schedule_run` (Python model `AiScheduleRun`). Generated from the Python model by `contract/gen_entities.py` (removed in 5.0.0, with the Python server); now edited by hand.

use sea_orm::ActiveValue::{NotSet, Set};
use sea_orm::entity::prelude::*;
use serde::{Deserialize, Serialize};

use crate::float::Float;

/// One slot of a schedule: the run(s) it started, how each check turned out and what the reviewer said.
#[derive(Clone, Debug, PartialEq, DeriveEntityModel, Serialize, Deserialize)]
#[sea_orm(table_name = "ai_schedule_run")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false)]
    pub id: String,
    pub schedule_id: String,
    pub project_id: String,
    pub ticket_id: String,
    /// UTC ISO of the planned start
    pub slot_at: String,
    /// waiting | ask | running | reviewing | fixing | passed | partly | failed | skipped | cancelled
    pub state: String,
    pub catch_up: bool,
    /// who ran it (the backup when used)
    pub member_id: Option<String>,
    /// JSON, in order (retries and fix rounds)
    pub run_ids: String,
    pub attempts: i32,
    pub fix_round: i32,
    pub results: String,
    pub review: String,
    pub note: Option<String>,
    pub started_at: Option<String>,
    pub ended_at: Option<String>,
    pub duration_s: i32,
    #[sea_orm(column_type = "Double")]
    pub cost_usd: Float,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}

/// A new row with the defaults of the Python model `AiScheduleRun`.
/// Set before saving: `schedule_id`, `project_id`, `ticket_id`, `slot_at`.
pub fn new() -> ActiveModel {
    ActiveModel {
        id: Set(kb_base::time::uuid4()),
        schedule_id: NotSet,
        project_id: NotSet,
        ticket_id: NotSet,
        slot_at: NotSet,
        state: Set("waiting".to_string()),
        catch_up: Set(false),
        member_id: Set(None),
        run_ids: Set("[]".to_string()),
        attempts: Set(0),
        fix_round: Set(0),
        results: Set("[]".to_string()),
        review: Set("{}".to_string()),
        note: Set(None),
        started_at: Set(None),
        ended_at: Set(None),
        duration_s: Set(0),
        cost_usd: Set(Float(0.0)),
        created_at: Set(kb_base::time::now_iso()),
        updated_at: Set(kb_base::time::now_iso()),
    }
}
