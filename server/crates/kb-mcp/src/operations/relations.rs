//! Blocks and links between tickets.

use kb_board::tickets as svc_tickets;
use serde_json::{Value, json};

use crate::common::{self, ToolError, ToolResult, missing_ticket, notify_on_success, ticket_to_dict};

/// The error of a block call that names a ticket that does not exist.
fn missing_pair(blocker_id: &str, blocked_id: &str) -> ToolError {
    ToolError::Value(format!("Ticket '{blocker_id}' or '{blocked_id}' not found. Use list_tickets to see ticket IDs."))
}

/// Record that `blocker_id` blocks `blocked_id` ('IAM-4 cannot proceed until IAM-3 is done'); the blocked ticket shows
/// a lock on the board. Both tickets must be in the same project; circular chains are refused. Statuses do not change.
/// Returns {blocker, blocked} (both updated tickets).
pub async fn block_ticket(blocker_id: &str, blocked_id: &str) -> ToolResult {
    notify_on_success(async {
        let session = common::async_session();
        let Some((blocker, blocked)) = svc_tickets::link_block(&session, blocker_id, blocked_id).await? else {
            return Err(missing_pair(blocker_id, blocked_id));
        };
        Ok(json!({
            "blocker": Value::Object(ticket_to_dict(blocker, false)?),
            "blocked": Value::Object(ticket_to_dict(blocked, false)?),
        }))
    })
    .await
}

/// Remove a block created by block_ticket (e.g. because the dependency no longer applies). Returns {blocker, blocked}.
pub async fn unblock_ticket(blocker_id: &str, blocked_id: &str) -> ToolResult {
    notify_on_success(async {
        let session = common::async_session();
        let Some((blocker, blocked)) = svc_tickets::unlink_block(&session, blocker_id, blocked_id).await? else {
            return Err(missing_pair(blocker_id, blocked_id));
        };
        Ok(json!({
            "blocker": Value::Object(ticket_to_dict(blocker, false)?),
            "blocked": Value::Object(ticket_to_dict(blocked, false)?),
        }))
    })
    .await
}

/// Create a non-blocking relation between two tickets (use block_ticket for dependencies).
/// Returns {id, target_id, relation_type}; keep `id` if you may need unlink_tickets later.
pub async fn link_tickets(ticket_id: &str, target_id: &str, relation_type: &str) -> ToolResult {
    notify_on_success(async {
        let session = common::async_session();
        Ok(svc_tickets::add_ticket_link(&session, ticket_id, target_id, relation_type).await?)
    })
    .await
}

/// Remove a relation made by link_tickets (and its inverse on the other ticket). Returns {"removed": link_id}.
pub async fn unlink_tickets(ticket_id: &str, link_id: &str) -> ToolResult {
    notify_on_success(async {
        let removed = {
            let session = common::async_session();
            if svc_tickets::get_ticket(&session, ticket_id).await?.is_none() {
                return Err(missing_ticket(ticket_id));
            }
            svc_tickets::remove_ticket_link(&session, ticket_id, link_id).await?
        };
        if !removed {
            return Err(ToolError::Value(format!(
                "Link '{link_id}' not found on {ticket_id}. A link has a different id on each of its two tickets: use the \
                 ticket you gave to manage_ticket(action='link'), or read the ids from get_ticket('{ticket_id}').links."
            )));
        }
        Ok(json!({"removed": link_id}))
    })
    .await
}
