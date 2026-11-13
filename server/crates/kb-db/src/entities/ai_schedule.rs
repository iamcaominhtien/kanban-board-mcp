//! `ai_schedule` (Python model `AiSchedule`). Generated from the Python model by `contract/gen_entities.py` (removed in 5.0.0, with the Python server); now edited by hand.

use sea_orm::ActiveValue::{NotSet, Set};
use sea_orm::entity::prelude::*;
use serde::{Deserialize, Serialize};

use crate::float::Float;

/// An AI member works on a ticket at a set time, once or on repeat (design/screens/ai-schedules.md).
#[derive(Clone, Debug, PartialEq, DeriveEntityModel, Serialize, Deserialize)]
#[sea_orm(table_name = "ai_schedule")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false)]
    pub id: String,
    pub project_id: String,
    pub ticket_id: String,
    pub member_id: String,
    pub backup_member_id: Option<String>,
    pub created_by: String,
    /// once | repeat
    pub kind: String,
    pub run_at: Option<String>,
    /// repeat: JSON weekday numbers, Monday = 0
    pub days: String,
    /// repeat: local HH:MM in `tz`
    pub time: String,
    pub tz: String,
    /// never | after | on_date
    pub ends: String,
    pub ends_after: Option<i32>,
    /// YYYY-MM-DD
    pub ends_on: Option<String>,
    pub window_end: Option<String>,
    /// JSON {criteria, tests: {on, command, cwd}, summary, branch, ai_checks: [text]}
    pub checks: String,
    /// JSON {on, reviewer_id, fix_rounds}
    pub review: String,
    /// JSON {stop_after_min, retries, max_cost}
    pub limits: String,
    /// run | skip | ask
    pub catch_up: String,
    #[sea_orm(column_type = "Double")]
    pub catch_up_hours: Float,
    pub notify: String,
    /// JSON extra people besides the creator
    pub notify_people: String,
    pub instruction: String,
    /// active | paused | ended
    pub state: String,
    pub paused_reason: Option<String>,
    pub failures_in_row: i32,
    pub runs_count: i32,
    /// UTC ISO
    pub next_run_at: Option<String>,
    pub ticket_seen_at: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}

/// A new row with the defaults of the Python model `AiSchedule`.
/// Set before saving: `project_id`, `ticket_id`, `member_id`.
pub fn new() -> ActiveModel {
    ActiveModel {
        id: Set(kb_base::time::prefixed_id("sch_", 12)),
        project_id: NotSet,
        ticket_id: NotSet,
        member_id: NotSet,
        backup_member_id: Set(None),
        created_by: Set("user".to_string()),
        kind: Set("repeat".to_string()),
        run_at: Set(None),
        days: Set("[0,1,2,3,4]".to_string()),
        time: Set("02:00".to_string()),
        tz: Set("UTC".to_string()),
        ends: Set("never".to_string()),
        ends_after: Set(None),
        ends_on: Set(None),
        window_end: Set(None),
        checks: Set("{}".to_string()),
        review: Set("{}".to_string()),
        limits: Set("{}".to_string()),
        catch_up: Set("run".to_string()),
        catch_up_hours: Set(Float(2.0)),
        notify: Set("[\"started\",\"needs_input\",\"failed\",\"finished\"]".to_string()),
        notify_people: Set("[]".to_string()),
        instruction: Set("".to_string()),
        state: Set("active".to_string()),
        paused_reason: Set(None),
        failures_in_row: Set(0),
        runs_count: Set(0),
        next_run_at: Set(None),
        ticket_seen_at: Set(None),
        created_at: Set(kb_base::time::now_iso()),
        updated_at: Set(kb_base::time::now_iso()),
    }
}
