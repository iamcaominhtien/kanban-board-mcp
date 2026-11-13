//! Acceptance criteria and sub-tasks.

use kb_board::tickets as svc_tickets;

use crate::common::{ToolError, ToolResult, edit_ticket, notify_on_success};

/// Add an acceptance criterion: one checklist item that defines when the ticket is done (starts unchecked).
/// Returns the updated ticket.
pub async fn add_acceptance_criterion(ticket_id: &str, description: &str) -> ToolResult {
    notify_on_success(edit_ticket(ticket_id, None, |s, _| async move {
        svc_tickets::add_acceptance_criterion(&s, ticket_id, description).await.map_err(ToolError::from)
    }))
    .await
}

/// Flip a criterion between not-done and done (call it again to undo). Check the current state in the returned
/// ticket's `acceptance_criteria[].done`. Returns the updated ticket.
pub async fn toggle_acceptance_criterion(ticket_id: &str, criterion_id: &str) -> ToolResult {
    notify_on_success(edit_ticket(ticket_id, Some(("criterion", criterion_id)), |s, cid| async move {
        svc_tickets::toggle_acceptance_criterion(&s, ticket_id, &cid.unwrap_or_default()).await.map_err(ToolError::from)
    }))
    .await
}

/// Delete a criterion permanently. Returns the updated ticket.
pub async fn delete_acceptance_criterion(ticket_id: &str, criterion_id: &str) -> ToolResult {
    notify_on_success(edit_ticket(ticket_id, Some(("criterion", criterion_id)), |s, cid| async move {
        svc_tickets::delete_acceptance_criterion(&s, ticket_id, &cid.unwrap_or_default()).await.map_err(ToolError::from)
    }))
    .await
}

/// Add a sub-task: a checklist step inside this ticket (not a ticket; for real child tickets use parent_id).
/// Returns the updated ticket.
pub async fn add_sub_task(ticket_id: &str, text: &str) -> ToolResult {
    notify_on_success(edit_ticket(ticket_id, None, |s, _| async move {
        svc_tickets::add_sub_task(&s, ticket_id, text).await.map_err(ToolError::from)
    }))
    .await
}

/// Flip a sub-task between not-done and done. Returns the updated ticket.
pub async fn toggle_sub_task(ticket_id: &str, sub_task_id: &str) -> ToolResult {
    notify_on_success(edit_ticket(ticket_id, Some(("sub_task", sub_task_id)), |s, sid| async move {
        svc_tickets::toggle_sub_task(&s, ticket_id, &sid.unwrap_or_default()).await.map_err(ToolError::from)
    }))
    .await
}

/// Delete a sub-task. Returns the updated ticket.
pub async fn delete_sub_task(ticket_id: &str, sub_task_id: &str) -> ToolResult {
    notify_on_success(edit_ticket(ticket_id, Some(("sub_task", sub_task_id)), |s, sid| async move {
        svc_tickets::delete_sub_task(&s, ticket_id, &sid.unwrap_or_default()).await.map_err(ToolError::from)
    }))
    .await
}
