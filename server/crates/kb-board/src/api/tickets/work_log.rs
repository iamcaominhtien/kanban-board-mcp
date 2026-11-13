//! `api/tickets.py`, lines 783-880: the work log of a ticket.

use axum::Json;
use kb_base::error::{Body, Path};
use kb_base::{ApiResult, Routes};
use serde::Deserialize;
use serde_json::{Map, Value};

use super::{bad_request, changed, uncaught};
use crate::schemas::TicketRead;
use crate::tickets::schemas::literal;
use crate::tickets::{NewWorkLog, WorkLogChanges, add_work_log, delete_work_log, update_work_log};

/// The routes of this part.
pub(super) fn routes() -> Routes {
    Routes::new()
        .post("/tickets/{ticket_id}/work-log", post_work_log)
        .patch("/tickets/{ticket_id}/work-log/{log_id}", patch_work_log)
        .delete("/tickets/{ticket_id}/work-log/{log_id}", del_work_log)
}

literal! {
    /// `Literal["investigation", "fix_attempt", "root_cause", "blocked", "resolved"]`.
    WorkLogKind {
        Investigation => "investigation",
        FixAttempt => "fix_attempt",
        RootCause => "root_cause",
        Blocked => "blocked",
        Resolved => "resolved",
    }
}

literal! {
    /// `Literal["PM", "Developer", "BA", "Tester", "Designer", "Other"]`.
    WorkLogRole {
        Pm => "PM",
        Developer => "Developer",
        Ba => "BA",
        Tester => "Tester",
        Designer => "Designer",
        Other => "Other",
    }
}

fn default_kind() -> WorkLogKind {
    WorkLogKind::Investigation
}

/// `list[dict[str, Any]]` as the list of values the service takes.
fn objects(items: Vec<Map<String, Value>>) -> Vec<Value> {
    items.into_iter().map(Value::Object).collect()
}

/// Request body to add a work-log entry.
#[derive(Debug, Deserialize)]
struct WorkLogBody {
    author: String,
    role: WorkLogRole,
    note: String,
    #[serde(default = "default_kind")]
    kind: WorkLogKind,
    #[serde(default)]
    pinned: bool,
    #[serde(default)]
    attachments: Vec<Map<String, Value>>,
    #[serde(default)]
    linked_branch: Option<String>,
    #[serde(default)]
    linked_test_case: Option<String>,
}

/// Request body to edit a work-log entry.
#[derive(Debug, Deserialize)]
struct WorkLogUpdateBody {
    #[serde(default)]
    author: Option<String>,
    #[serde(default)]
    role: Option<WorkLogRole>,
    #[serde(default)]
    note: Option<String>,
    #[serde(default)]
    kind: Option<WorkLogKind>,
    #[serde(default)]
    pinned: Option<bool>,
    #[serde(default)]
    attachments: Option<Vec<Map<String, Value>>>,
    #[serde(default)]
    linked_branch: Option<String>,
    #[serde(default)]
    linked_test_case: Option<String>,
}

/// Add a work-log entry.
async fn post_work_log(Path(ticket_id): Path<String>, Body(body): Body<WorkLogBody>) -> ApiResult<Json<TicketRead>> {
    let session = kb_db::session();
    let attachments = objects(body.attachments);
    let new = NewWorkLog {
        author: &body.author,
        role: body.role.as_str(),
        note: &body.note,
        kind: body.kind.as_str(),
        pinned: body.pinned,
        attachments: Some(&attachments),
        linked_branch: body.linked_branch.as_deref(),
        linked_test_case: body.linked_test_case.as_deref(),
    };
    let ticket = add_work_log(&session, &ticket_id, new).await.map_err(bad_request)?;
    changed(ticket).await
}

/// Edit a work-log entry.
async fn patch_work_log(
    Path((ticket_id, log_id)): Path<(String, String)>,
    Body(body): Body<WorkLogUpdateBody>,
) -> ApiResult<Json<TicketRead>> {
    let session = kb_db::session();
    let attachments = body.attachments.map(objects);
    let changes = WorkLogChanges {
        note: body.note.as_deref(),
        kind: body.kind.map(WorkLogKind::as_str),
        pinned: body.pinned,
        attachments: attachments.as_deref(),
        linked_branch: body.linked_branch.as_deref(),
        linked_test_case: body.linked_test_case.as_deref(),
        author: body.author.as_deref(),
        role: body.role.map(WorkLogRole::as_str),
    };
    let ticket = update_work_log(&session, &ticket_id, &log_id, changes).await.map_err(bad_request)?;
    changed(ticket).await
}

/// Delete a work-log entry.
async fn del_work_log(Path((ticket_id, log_id)): Path<(String, String)>) -> ApiResult<Json<TicketRead>> {
    let session = kb_db::session();
    let ticket = delete_work_log(&session, &ticket_id, &log_id).await.map_err(uncaught)?;
    changed(ticket).await
}
