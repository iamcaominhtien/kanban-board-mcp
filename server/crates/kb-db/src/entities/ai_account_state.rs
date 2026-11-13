//! `ai_account_state` (Python model `AiAccountState`). Generated from the Python model by `contract/gen_entities.py` (removed in 5.0.0, with the Python server); now edited by hand.

use sea_orm::ActiveValue::{NotSet, Set};
use sea_orm::entity::prelude::*;
use serde::{Deserialize, Serialize};

use crate::float::Float;

/// The usage window and run limit of one Claude account, or of "local" (members on the person's own login)
/// (table). Read from the CLI's `rate_limit_event` (services/ai/quota.py).
#[derive(Clone, Debug, PartialEq, DeriveEntityModel, Serialize, Deserialize)]
#[sea_orm(table_name = "ai_account_state")]
pub struct Model {
    /// AiAccount.id, or "local"
    #[sea_orm(primary_key, auto_increment = false)]
    pub key: String,
    pub max_parallel: i32,
    pub move_urgent: bool,
    /// 0..1
    #[sea_orm(column_type = "Double")]
    pub five_hour_used: Option<Float>,
    pub five_hour_resets_at: Option<String>,
    pub five_hour_status: Option<String>,
    #[sea_orm(column_type = "Double")]
    pub seven_day_used: Option<Float>,
    pub seven_day_resets_at: Option<String>,
    pub seven_day_status: Option<String>,
    pub held_until: Option<String>,
    pub held_reason: Option<String>,
    pub updated_at: Option<String>,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}

/// A new row with the defaults of the Python model `AiAccountState`.
/// Set before saving: `key`.
pub fn new() -> ActiveModel {
    ActiveModel {
        key: NotSet,
        max_parallel: Set(2),
        move_urgent: Set(false),
        five_hour_used: Set(None),
        five_hour_resets_at: Set(None),
        five_hour_status: Set(None),
        seven_day_used: Set(None),
        seven_day_resets_at: Set(None),
        seven_day_status: Set(None),
        held_until: Set(None),
        held_reason: Set(None),
        updated_at: Set(None),
    }
}
