//! `ai_account` (Python model `AiAccount`). Generated from the Python model by `contract/gen_entities.py` (removed in 5.0.0, with the Python server); now edited by hand.

use sea_orm::ActiveValue::{NotSet, Set};
use sea_orm::entity::prelude::*;
use serde::{Deserialize, Serialize};

/// One sign-in of one CLI (claude | codex | opencode | agy), kept in a folder of its own. Several AI members can
/// use the same account. The login is kept by the CLI; the board never reads it (table).
#[derive(Clone, Debug, PartialEq, DeriveEntityModel, Serialize, Deserialize)]
#[sea_orm(table_name = "ai_account")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false)]
    pub id: String,
    /// unique per computer
    pub name: String,
    /// claude | codex | opencode | agy
    pub cli: String,
    /// absolute path of the account's own folder
    pub folder: String,
    /// signed_in | needs_sign_in | signing_in | cli_missing; "checking" and "not_ready" are shown, not stored
    pub status: String,
    pub status_detail: Option<String>,
    /// only Claude Code reports who
    pub email: Option<String>,
    pub plan: Option<String>,
    pub method: Option<String>,
    pub checked_at: Option<String>,
    pub signed_out_at: Option<String>,
    /// run | check
    pub signed_out_how: Option<String>,
    pub created_by: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}

/// A new row with the defaults of the Python model `AiAccount`.
/// Set before saving: `name`, `cli`, `folder`.
pub fn new() -> ActiveModel {
    ActiveModel {
        id: Set(kb_base::time::prefixed_id("acct_", 10)),
        name: NotSet,
        cli: NotSet,
        folder: NotSet,
        status: Set("needs_sign_in".to_string()),
        status_detail: Set(None),
        email: Set(None),
        plan: Set(None),
        method: Set(None),
        checked_at: Set(None),
        signed_out_at: Set(None),
        signed_out_how: Set(None),
        created_by: Set(None),
        created_at: Set(kb_base::time::now_iso()),
        updated_at: Set(kb_base::time::now_iso()),
    }
}
