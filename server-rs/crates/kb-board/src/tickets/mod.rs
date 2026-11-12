//! Tickets (`services/tickets.py`), part 1: the ticket itself. The Python file is one module; here each part is a
//! file named for what it holds, in the order of the Python file:
//!
//! - `mod.rs` (lines 1-46): the JSON columns (`_loads`, `_dumps`), the error type, and what the whole area shares;
//! - `validate.rs` (lines 48-212): limits, `[[doc references]]` and `@mentions` in a text, the field validators and
//!   the parent rules;
//! - `search.rs` (lines 28-36 and 215-242): the fuzzy score of a ticket for a query;
//! - `core.rs` (lines 245-446): list, lane counts, get, create;
//! - `update.rs` (lines 449-753): the audited partial update with the status rules;
//! - `delete.rs` (lines 756-796): deleting a ticket and what pointed at it;
//! - `schemas.rs`: the request models of the core routes (`models.py` and `api/tickets.py`).
//!
//! The sub-entities (comments, criteria, sub-tasks, work log, test cases, blocks, links, branches, reopen, pending:
//! lines 799-2862) are ported after this; the helpers they need are `pub(crate)` here.

use kb_base::pyjson;
use kb_db::Session;
use kb_db::entities::ticket;
use kb_db::sea_orm::{ActiveModelTrait, DbErr, IntoActiveModel, Iterable, ModelTrait};
use serde_json::Value;

use crate::git_repo::GitError;

pub mod core;
pub mod delete;
pub mod schemas;
pub mod search;
pub mod update;
pub mod validate;

pub use self::core::{MAX_NEW_CRITERIA, NewTicket, create_ticket, get_ticket, lane_counts, list_tickets};
pub use delete::delete_ticket;
pub use schemas::{TicketCreateBody, TicketUpdate};
pub use update::update_ticket;
pub use validate::{
    MAX_AC_TEXT, MAX_COMMENT, MAX_ESTIMATE, MAX_SUB_TASK_TEXT, MAX_TAG_LEN, MAX_TAGS, MAX_TITLE, mention_ids,
};

/// What a function of this module fails with.
#[derive(Debug)]
pub enum Error {
    /// `ValueError`: the text is the message (a 400 on the REST routes).
    Value(String),
    /// `sqlalchemy.exc.NoResultFound`: the project of a new ticket does not exist (the MCP tools catch it; on a
    /// REST route it is a 500).
    NoResult(String),
    /// The database call failed.
    Db(DbErr),
    /// Any other exception (git could not be run, a stored value of a kind the code does not expect): a 500.
    Other(String),
}

impl From<DbErr> for Error {
    fn from(err: DbErr) -> Self {
        Error::Db(err)
    }
}

impl From<GitError> for Error {
    fn from(err: GitError) -> Self {
        match err {
            GitError::Repo(message) => Error::Value(message),
            other => Error::Other(other.to_string()),
        }
    }
}

impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Error::Value(message) | Error::NoResult(message) | Error::Other(message) => f.write_str(message),
            Error::Db(err) => write!(f, "{err}"),
        }
    }
}

/// `ValueError(message)`.
pub(crate) fn value_error<T>(message: impl Into<String>) -> Result<T, Error> {
    Err(Error::Value(message.into()))
}

/// `_loads`: the list a JSON column holds (`[]` for an empty column). JSON that does not parse is Python's
/// `JSONDecodeError`, a `ValueError`; anything but a list is not something the code expects.
pub(crate) fn loads(value: &str) -> Result<Vec<Value>, Error> {
    if value.is_empty() {
        return Ok(Vec::new());
    }
    match serde_json::from_str::<Value>(value) {
        Ok(Value::Array(items)) => Ok(items),
        Ok(other) => Err(Error::Other(format!("a JSON column holds {other}, not a list"))),
        Err(err) => Err(Error::Value(err.to_string())),
    }
}

/// `_dumps`: `json.dumps(value)`, the bytes a JSON column stores.
pub(crate) fn dumps(value: &[Value]) -> String {
    pyjson::dumps(&value)
}

/// `session.add(row)` for a ticket that was loaded and then changed: an UPDATE of the columns that differ from
/// `before` (nothing is sent when none does). Returns the row as stored.
pub(crate) async fn save(
    session: &Session,
    before: &ticket::Model,
    after: ticket::Model,
) -> Result<ticket::Model, DbErr> {
    let mut row = before.clone().into_active_model();
    for column in ticket::Column::iter() {
        let value = after.get(column);
        if value != before.get(column) {
            row.set(column, value);
        }
    }
    if !row.is_changed() {
        return Ok(after);
    }
    row.update(session).await
}

/// The eight columns of the Pending flag, cleared.
pub(crate) fn clear_pending_flags(ticket: &mut ticket::Model) {
    ticket.pending = false;
    ticket.pending_reason_type = None;
    ticket.pending_ticket_id = None;
    ticket.pending_member_id = None;
    ticket.pending_party = None;
    ticket.pending_note = None;
    ticket.pending_since = None;
    ticket.pending_by = None;
}

/// A ticket row with the defaults of a new one, for the unit tests of this crate.
#[cfg(test)]
pub(crate) fn blank_ticket(id: &str) -> ticket::Model {
    ticket::Model {
        id: id.to_string(),
        project_id: "p".into(),
        title: "t".into(),
        description: String::new(),
        r#type: "task".into(),
        status: "backlog".into(),
        priority: "medium".into(),
        estimate: None,
        due_date: None,
        tags: "[]".into(),
        parent_id: None,
        comments: "[]".into(),
        acceptance_criteria: "[]".into(),
        sub_tasks: "[]".into(),
        activity_log: "[]".into(),
        work_log: "[]".into(),
        test_cases: "[]".into(),
        start_date: None,
        wont_do_reason: None,
        created_by: None,
        assignee: None,
        blocks: "[]".into(),
        blocked_by: "[]".into(),
        block_done_if_acs_incomplete: false,
        block_done_if_tcs_incomplete: false,
        links: "[]".into(),
        branches: "[]".into(),
        workspace_retention_days: None,
        repo_path: None,
        reopen_count: 0,
        last_reopened_at: None,
        last_reopened_by: None,
        last_reopen_reason: None,
        reopen_history: "[]".into(),
        pending: false,
        pending_reason_type: None,
        pending_ticket_id: None,
        pending_member_id: None,
        pending_party: None,
        pending_note: None,
        pending_since: None,
        pending_by: None,
        from_idea_id: None,
        tests_assumption_id: None,
        wave_pin: None,
        review_requested_from: None,
        created_at: String::new(),
        updated_at: String::new(),
    }
}
