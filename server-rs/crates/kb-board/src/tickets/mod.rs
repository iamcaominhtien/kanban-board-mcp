//! Tickets (`services/tickets.py`). The Python file is one module; here each part is a file named for what it holds,
//! in the order of the Python file:
//!
//! - `mod.rs` (lines 1-46): the JSON columns (`_loads`, `_dumps`), the error type, and what the whole area shares;
//! - `validate.rs` (lines 48-212): limits, `[[doc references]]` and `@mentions` in a text, the field validators and
//!   the parent rules;
//! - `search.rs` (lines 28-36 and 215-242): the fuzzy score of a ticket for a query;
//! - `core.rs` (lines 245-446): list, lane counts, get, create;
//! - `update.rs` (lines 449-753): the audited partial update with the status rules;
//! - `delete.rs` (lines 756-796): deleting a ticket and what pointed at it;
//! - `comments.rs` (lines 804-988): comments, who they notify, soft delete and restore;
//! - `criteria.rs` (lines 995-1082): acceptance criteria;
//! - `sub_tasks.rs` (lines 1089-1176): the checklist of sub-tasks;
//! - `work_log.rs` (lines 1187-1423): the work log (debug notes) with attachments and links;
//! - `test_cases.rs` (lines 1430-1645): test cases;
//! - `activities.rs` (lines 1647-1697): the project's activity feed;
//! - `blocks.rs` (lines 1704-1808): blocks / blocked by;
//! - `links.rs` (lines 1814-1966): the other relations between two tickets;
//! - `branches.rs` (lines 1972-2495): branches, the commit graph and commit details of the linked repository;
//! - `reopen.rs` (lines 2494-2862): reopen, undo reopen, the Pending flag and resume;
//! - `schemas.rs`: the request models of the core routes (`models.py` and `api/tickets.py`).

use kb_base::{pyjson, pytext};
use kb_db::Session;
use kb_db::entities::ticket;
use kb_db::sea_orm::{ActiveModelTrait, DbErr, IntoActiveModel, Iterable, ModelTrait};
use serde_json::Value;

use crate::git_repo::GitError;

pub mod activities;
pub mod blocks;
pub mod branches;
pub mod comments;
pub mod core;
pub mod criteria;
pub mod delete;
pub mod links;
pub mod reopen;
pub mod schemas;
pub mod search;
pub mod sub_tasks;
pub mod test_cases;
pub mod update;
pub mod validate;
pub mod work_log;

pub use self::core::{MAX_NEW_CRITERIA, NewTicket, create_ticket, get_ticket, lane_counts, list_tickets};
pub use activities::{ActivityEventRead, get_project_activities};
pub use blocks::{link_block, unlink_block};
pub use branches::{
    BranchChanges, NewBranch, VALID_BRANCH_STATUSES, add_branch, checkout_branch, default_base_branch, delete_branch,
    get_branch_graph, get_commit_detail, list_branches, update_branch,
};
pub use comments::{add_comment, delete_comment, restore_comment, update_comment};
pub use criteria::{add_acceptance_criterion, delete_acceptance_criterion, toggle_acceptance_criterion};
pub use delete::delete_ticket;
pub use links::{VALID_RELATION_TYPES, add_ticket_link, remove_ticket_link};
pub use reopen::{
    MAX_REASON_LEN, PendingReason, ReopenOptions, clear_pending, reopen_ticket, set_pending, undo_reopen,
};
pub use schemas::{TicketCreateBody, TicketUpdate};
pub use sub_tasks::{add_sub_task, delete_sub_task, toggle_sub_task};
pub use test_cases::{NewTestCase, TestCaseChanges, add_test_case, delete_test_case, update_test_case};
pub use update::update_ticket;
pub use validate::{
    MAX_AC_TEXT, MAX_COMMENT, MAX_ESTIMATE, MAX_SUB_TASK_TEXT, MAX_TAG_LEN, MAX_TAGS, MAX_TITLE, mention_ids,
};
pub use work_log::{
    MAX_WORK_LOG_NOTE, NewWorkLog, WORK_LOG_KINDS, WORK_LOG_ROLES, WorkLogChanges, add_work_log, delete_work_log,
    update_work_log,
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

/// `session.add(ticket)`, `await session.commit()`, `await session.refresh(ticket)`: the changed ticket stored and
/// made permanent. Returns the row as stored.
pub(crate) async fn commit(
    session: &Session,
    before: &ticket::Model,
    after: ticket::Model,
) -> Result<ticket::Model, Error> {
    let ticket = save(session, before, after).await?;
    session.commit().await?;
    Ok(ticket)
}

/// `value.get(key)` of an item of a JSON column: the value under `key`, or null (`None`) when it has none.
pub(crate) fn field<'a>(item: &'a Value, key: &str) -> &'a Value {
    item.get(key).unwrap_or(&Value::Null)
}

/// `item[key] = value` on an item of a JSON column (an item that is not an object is left as it is; Python fails
/// on it).
pub(crate) fn put(item: &mut Value, key: &str, value: Value) {
    if let Some(object) = item.as_object_mut() {
        object.insert(key.to_string(), value);
    }
}

/// `str(value)` of a value read from a JSON column, as an f-string prints it: text as it is, anything else as
/// Python shows the object (`None`, `True`, `1.5`, `['a', 'b']`, `{'k': 1}`).
pub(crate) fn py_str(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        other => py_repr(other),
    }
}

/// `repr(value)` of a value read from a JSON column.
pub(crate) fn py_repr(value: &Value) -> String {
    match value {
        Value::String(text) => pytext::repr(text),
        Value::Array(items) => format!("[{}]", items.iter().map(py_repr).collect::<Vec<_>>().join(", ")),
        Value::Object(object) => {
            let pairs: Vec<String> =
                object.iter().map(|(key, value)| format!("{}: {}", pytext::repr(key), py_repr(value))).collect();
            format!("{{{}}}", pairs.join(", "))
        }
        scalar => pyjson::py_str(scalar),
    }
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

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_stored_value_prints_as_python_prints_it() {
        assert_eq!(py_str(&json!("it's")), "it's");
        assert_eq!(py_str(&Value::Null), "None");
        assert_eq!(py_str(&json!(true)), "True");
        assert_eq!(py_str(&json!(2.0)), "2.0");
        assert_eq!(py_str(&json!(["a", 1, null, "it's"])), r#"['a', 1, None, "it's"]"#);
        assert_eq!(py_str(&json!({"k": [false], "n": 1.5})), "{'k': [False], 'n': 1.5}");
    }
}
