//! `notify_prefs` (Python model `NotifyPrefs`). Generated from the Python model by `contract/gen_entities.py` (removed in 5.0.0, with the Python server); now edited by hand.

use sea_orm::ActiveValue::{NotSet, Set};
use sea_orm::entity::prelude::*;
use serde::{Deserialize, Serialize};

/// Settings › Notifications of one recipient (JSON); the row "*" holds the app-wide retention (table).
#[derive(Clone, Debug, PartialEq, DeriveEntityModel, Serialize, Deserialize)]
#[sea_orm(table_name = "notify_prefs")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false)]
    pub recipient: String,
    pub prefs: String,
    pub updated_at: String,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}

/// A new row with the defaults of the Python model `NotifyPrefs`.
/// Set before saving: `recipient`.
pub fn new() -> ActiveModel {
    ActiveModel { recipient: NotSet, prefs: Set("{}".to_string()), updated_at: Set(kb_base::time::now_iso()) }
}
