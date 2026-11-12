//! The work log (the "Debug Space" tab).

use kb_board::tickets::{self as svc_tickets, NewWorkLog, WorkLogChanges};

use crate::common::{ToolError, ToolResult, attach_from_run, edit_ticket, notify_on_success};

/// Append an entry to the ticket's debug journal (the Debug Space tab): keep a running record of what you
/// investigated, tried and found, so humans (and later sessions) can follow along. In an AI run a picture or a
/// document (a log, an Excel sheet, a PDF) named by its path in your working folder is attached:
/// ![error](qa/evidence/err.png). Returns the updated ticket.
///
/// `role` is one of `WORK_LOG_ROLES` and `kind` one of `WORK_LOG_KINDS` (the tool's table checks them).
#[allow(clippy::too_many_arguments)]
pub async fn add_work_log(
    ticket_id: &str,
    author: &str,
    role: &str,
    note: &str,
    kind: &str,
    pinned: bool,
    linked_branch: Option<&str>,
    linked_test_case: Option<&str>,
) -> ToolResult {
    notify_on_success(async {
        let note = attach_from_run(Some(note), None).await?.unwrap_or_default();
        edit_ticket(ticket_id, None, |s, _| async move {
            let new = NewWorkLog {
                kind,
                pinned,
                linked_branch,
                linked_test_case,
                ..NewWorkLog::new(author, role, &note)
            };
            svc_tickets::add_work_log(&s, ticket_id, new).await.map_err(ToolError::from)
        })
        .await
    })
    .await
}

/// Correct or extend a work log entry. To record that a problem is fixed, add a new entry with kind 'resolved'
/// instead of editing the old one (that keeps the history). Omitted fields are unchanged. Returns the updated ticket.
pub async fn update_work_log(
    ticket_id: &str,
    log_id: &str,
    note: Option<&str>,
    kind: Option<&str>,
    pinned: Option<bool>,
    linked_branch: Option<&str>,
    linked_test_case: Option<&str>,
) -> ToolResult {
    notify_on_success(async {
        let note = attach_from_run(note, None).await?;
        edit_ticket(ticket_id, Some(("work_log", log_id)), |s, lid| async move {
            let changes = WorkLogChanges {
                note: note.as_deref(),
                kind,
                pinned,
                linked_branch,
                linked_test_case,
                ..WorkLogChanges::default()
            };
            svc_tickets::update_work_log(&s, ticket_id, &lid.unwrap_or_default(), changes)
                .await
                .map_err(ToolError::from)
        })
        .await
    })
    .await
}

/// Delete a work log entry permanently. Returns the updated ticket.
pub async fn delete_work_log(ticket_id: &str, log_id: &str) -> ToolResult {
    notify_on_success(edit_ticket(ticket_id, Some(("work_log", log_id)), |s, lid| async move {
        svc_tickets::delete_work_log(&s, ticket_id, &lid.unwrap_or_default()).await.map_err(ToolError::from)
    }))
    .await
}
