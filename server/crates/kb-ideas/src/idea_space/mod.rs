//! `services/idea_space.py`: Idea Space rules: stage moves, triage decisions, merge, votes, evidence, comments,
//! research log and counts.
//!
//! The data model is in `models.py` (IdeaTicket and its records) and the one-time conversion in the
//! `idea_space_model` migration; basic create/update lives in `services/idea_tickets.py`. The Python file is one
//! module; here each part is a file named for what it holds, in the order of the Python file:
//!
//! - `mod.rs` (lines 1-92): the allowed values, the rule error, `get_or_raise` and `_save`;
//! - `listing.rs` (lines 93-293): listing, counts and "sorted this week";
//! - `stages.rs` (lines 296-487): stage moves, undo and parking several ideas;
//! - `page.rs` (lines 490-632): project assignment, the idea page and the outcome after shipping;
//! - `merge.rs` (lines 635-783): merging ideas, undoing a merge and votes;
//! - `assumptions.rs` (lines 786-953): evidence, test tickets and what a test showed;
//! - `comments.rs` (lines 956-1031): comments;
//! - `log.rs` (lines 1034-1139): the research log;
//! - `activity.rs` (lines 1142-1220): the activity list and the warnings of a list row.

use kb_base::{pyjson, time};
use kb_db::Session;
use serde_json::{Map, Value};

use crate::error::{Error, value_error};
use crate::idea_tickets::{commit_and_reload, reload};
use crate::model::Idea;

mod activity;
mod assumptions;
mod comments;
mod listing;
mod log;
mod merge;
mod page;
mod stages;

pub use crate::error::IdeaRuleError;
pub use activity::{ACTIVITY_FILTERS, STALE_DAYS, WAITING_DAYS, activity, warnings};
pub use assumptions::{add_evidence, create_test_ticket, delete_evidence, list_evidence, resolve_assumption};
pub use comments::{add_comment, delete_comment, edit_comment, list_comments};
pub use listing::{ListFilter, SORTED_DAYS, counts, list_ideas, sorted_this_week};
pub use log::{LogChanges, add_log_entry, delete_log_entry, list_log, log_entry_as_evidence, update_log_entry};
pub use merge::{MERGE_UNDO_MINUTES, merge, undo_merge, vote};
pub use page::{PageChanges, Sent, assign_project, record_outcome, update_page};
pub use stages::{MoveStage, move_stage, park_many, undo_last_move};

/// The stages an idea is open in (`OPEN_STAGES`).
pub const OPEN_STAGES: [&str; 4] = ["inbox", "exploring", "ready", "parked"];
/// The stages the "Active" filter shows (`ACTIVE_STAGES`).
pub const ACTIVE_STAGES: [&str; 3] = ["exploring", "ready", "building"];
/// The stages an idea is closed in (`CLOSED_STAGES`).
pub const CLOSED_STAGES: [&str; 2] = ["shipped", "archived"];

/// The legacy status the current Idea board shows for each stage (`LEGACY_STATUS_FOR_STAGE`). A stage that is not
/// one of the seven is Python's `KeyError`, a 500.
pub fn legacy_status_for_stage(stage: &str) -> Result<&'static str, Error> {
    match stage {
        "inbox" | "parked" => Ok("draft"),
        "exploring" => Ok("in_review"),
        "ready" | "building" | "shipped" => Ok("approved"),
        "archived" => Ok("dropped"),
        other => Err(Error::Other(format!("KeyError: '{other}'"))),
    }
}

/// `_now()`.
pub(crate) fn now() -> String {
    time::now_iso()
}

/// `_json(value, fallback)`: the value a JSON column holds, or the fallback for an empty column or JSON that does
/// not parse.
pub(crate) fn json_or(value: &str, fallback: Value) -> Value {
    if value.is_empty() {
        return fallback;
    }
    serde_json::from_str(value).unwrap_or(fallback)
}

/// `"".join(chr(255 - ord(c)) for c in text)`: a sort key that puts later text first. Compare the keys as lists.
pub(crate) fn neg(text: &str) -> Vec<i64> {
    text.chars().map(|c| 255 - i64::from(u32::from(c))).collect()
}

/// `value.get(key)` of a JSON object that may be something else.
pub(crate) fn get<'a>(value: &'a Value, key: &str) -> &'a Value {
    value.get(key).unwrap_or(&Value::Null)
}

/// `json.dumps(object)` of a dict.
pub(crate) fn dumps_map(map: &Map<String, Value>) -> String {
    pyjson::dumps(map)
}

/// The idea with all its records loaded. Fails with `ValueError` if there is no such idea.
pub async fn get_or_raise(session: &Session, idea_id: &str) -> Result<Idea, Error> {
    use kb_db::entities::idea_ticket;
    use kb_db::sea_orm::EntityTrait;
    match idea_ticket::Entity::find_by_id(idea_id).one(session).await? {
        None => value_error(format!("Idea ticket '{idea_id}' not found")),
        Some(_) => reload(session, idea_id).await,
    }
}

/// `_save(session, idea)`: touch the idea, save it and read it again.
pub(crate) async fn save(session: &Session, idea: &mut Idea) -> Result<Idea, Error> {
    let now = now();
    idea.row.updated_at = now.clone();
    idea.row.last_touched_at = Some(now);
    commit_and_reload(session, idea).await
}
