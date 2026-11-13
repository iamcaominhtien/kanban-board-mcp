//! `ai_run_transcript` (Python model `AiRunTranscript`). Generated from the Python model by `contract/gen_entities.py` (removed in 5.0.0, with the Python server); now edited by hand.

use sea_orm::ActiveValue::{NotSet, Set};
use sea_orm::entity::prelude::*;
use serde::{Deserialize, Serialize};

/// The board's own copy of a run's conversation: a compressed file in the data folder (services/ai/transcripts.py)
/// (table). The run's summary stays on `AiRun` forever; this file follows the notification retention unless pinned.
#[derive(Clone, Debug, PartialEq, DeriveEntityModel, Serialize, Deserialize)]
#[sea_orm(table_name = "ai_run_transcript")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false)]
    pub run_id: String,
    pub project_id: String,
    pub member_id: Option<String>,
    pub path: String,
    pub bytes: i32,
    pub events: i32,
    pub pinned: bool,
    pub pinned_by: Option<String>,
    pub started_at: String,
    pub ended_at: Option<String>,
    /// Set when the retention removed the file; the row stays so the run says "transcript removed after N days"
    pub deleted_at: Option<String>,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}

/// A new row with the defaults of the Python model `AiRunTranscript`.
/// Set before saving: `run_id`, `project_id`, `path`.
pub fn new() -> ActiveModel {
    ActiveModel {
        run_id: NotSet,
        project_id: NotSet,
        member_id: Set(None),
        path: NotSet,
        bytes: Set(0),
        events: Set(0),
        pinned: Set(false),
        pinned_by: Set(None),
        started_at: Set(kb_base::time::now_iso()),
        ended_at: Set(None),
        deleted_at: Set(None),
    }
}
