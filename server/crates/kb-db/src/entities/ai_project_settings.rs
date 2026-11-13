//! `ai_project_settings` (Python model `AiProjectSettings`). Generated from the Python model by `contract/gen_entities.py` (removed in 5.0.0, with the Python server); now edited by hand.

use sea_orm::ActiveValue::{NotSet, Set};
use sea_orm::entity::prelude::*;
use serde::{Deserialize, Serialize};

use crate::float::Float;

/// Per-project AI settings (AI v2): the kill switch, board-wide limits, the permission mode of runs, the deny list,
/// how lessons are kept, and the v2 operations JSON (services/ai/ops.py) (table).
#[derive(Clone, Debug, PartialEq, DeriveEntityModel, Serialize, Deserialize)]
#[sea_orm(table_name = "ai_project_settings")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false)]
    pub project_id: String,
    pub paused_all: bool,
    pub paused_at: Option<String>,
    pub paused_reason: Option<String>,
    #[sea_orm(column_type = "Double")]
    pub board_daily_cap: Option<Float>,
    #[sea_orm(column_type = "Double")]
    pub board_monthly_budget: Option<Float>,
    pub board_tokens_per_day: Option<i32>,
    pub board_max_parallel: i32,
    pub board_runs_per_day: Option<i32>,
    /// pause | stop
    pub board_at_cap: String,
    pub run_memory_limit_mb: i32,
    pub audit_retention_days: Option<i32>,
    pub run_retention_days: Option<i32>,
    pub permission_mode: String,
    pub deny_list: String,
    /// auto | review
    pub lessons_mode: String,
    pub lessons_max: i32,
    pub ops: String,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}

/// A new row with the defaults of the Python model `AiProjectSettings`.
/// Set before saving: `project_id`.
pub fn new() -> ActiveModel {
    ActiveModel {
        project_id: NotSet,
        paused_all: Set(false),
        paused_at: Set(None),
        paused_reason: Set(None),
        board_daily_cap: Set(None),
        board_monthly_budget: Set(None),
        board_tokens_per_day: Set(None),
        board_max_parallel: Set(4),
        board_runs_per_day: Set(None),
        board_at_cap: Set("pause".to_string()),
        run_memory_limit_mb: Set(4096),
        audit_retention_days: Set(Some(90)),
        run_retention_days: Set(None),
        permission_mode: Set("bypass".to_string()),
        deny_list: Set("[]".to_string()),
        lessons_mode: Set("auto".to_string()),
        lessons_max: Set(40),
        ops: Set("{}".to_string()),
    }
}
