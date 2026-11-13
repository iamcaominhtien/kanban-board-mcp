//! `notification` (Python model `Notification`). Generated from the Python model by `contract/gen_entities.py` (removed in 5.0.0, with the Python server); now edited by hand.

use sea_orm::ActiveValue::{NotSet, Set};
use sea_orm::entity::prelude::*;
use serde::{Deserialize, Serialize};

/// One notification for one recipient (a person's key, or "ai:<member id>"), built from the log. Events of one
/// group (same kind and project inside 10 minutes, or the same request) are merged into one row (table).
#[derive(Clone, Debug, PartialEq, DeriveEntityModel, Serialize, Deserialize)]
#[sea_orm(table_name = "notification")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false)]
    pub id: String,
    pub recipient: String,
    /// the first event of the row
    pub event_id: i32,
    /// the newest event merged in
    pub last_event_id: i32,
    pub project_id: Option<String>,
    pub kind: String,
    pub needs: bool,
    pub group_key: String,
    pub count: i32,
    pub items: String,
    pub target_kind: Option<String>,
    pub target_id: Option<String>,
    pub ticket_id: Option<String>,
    pub page_id: Option<String>,
    pub member_id: Option<String>,
    pub actor: Option<String>,
    pub title: String,
    pub body: String,
    pub data: String,
    pub inapp: bool,
    pub desktop: bool,
    pub read_at: Option<String>,
    pub done_at: Option<String>,
    pub done_reason: Option<String>,
    pub done_by: Option<String>,
    pub snoozed_until: Option<String>,
    pub cleared_at: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}

/// A new row with the defaults of the Python model `Notification`.
/// Set before saving: `recipient`, `event_id`, `last_event_id`, `kind`, `group_key`.
pub fn new() -> ActiveModel {
    ActiveModel {
        id: Set(kb_base::time::prefixed_id("nt_", 12)),
        recipient: NotSet,
        event_id: NotSet,
        last_event_id: NotSet,
        project_id: Set(None),
        kind: NotSet,
        needs: Set(false),
        group_key: NotSet,
        count: Set(1),
        items: Set("[]".to_string()),
        target_kind: Set(None),
        target_id: Set(None),
        ticket_id: Set(None),
        page_id: Set(None),
        member_id: Set(None),
        actor: Set(None),
        title: Set("".to_string()),
        body: Set("".to_string()),
        data: Set("{}".to_string()),
        inapp: Set(true),
        desktop: Set(false),
        read_at: Set(None),
        done_at: Set(None),
        done_reason: Set(None),
        done_by: Set(None),
        snoozed_until: Set(None),
        cleared_at: Set(None),
        created_at: Set(kb_base::time::now_iso()),
        updated_at: Set(kb_base::time::now_iso()),
    }
}
