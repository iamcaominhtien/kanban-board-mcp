//! Docs operations (`operations/docs.py`). Only what the ticket tools call is here: linking a Docs page to a ticket
//! by hand. The rest of the file belongs to the docs tools.

use kb_docs::Error as DocsFailure;
use serde_json::Value;

use crate::common::{self, ToolError, ToolResult, notify_on_success};

/// `_docs_error`: a failure of the Docs service as the tool words it: the message, a full stop, and for a conflict
/// what to do next.
pub fn docs_error(err: DocsFailure) -> ToolError {
    match err {
        DocsFailure::Docs(exc) => {
            let hint = if exc.code == "conflict" {
                " Call docs_read(action='get') again, re-apply your edit on the new version, and retry."
            } else {
                ""
            };
            ToolError::Value(format!("{}.{hint}", exc.message))
        }
        DocsFailure::Value(message) => ToolError::Value(message),
        DocsFailure::Db(err) => err.into(),
        DocsFailure::Other(message) => ToolError::Other(message),
    }
}

/// Link a Docs page to a ticket manually (shown under 'Linked docs' on the ticket).
pub async fn link_ticket_doc(ticket_id: &str, page_id: &str) -> ToolResult {
    notify_on_success(async {
        let session = common::async_session();
        let linked = kb_docs::docs::link_ticket_doc(&session, ticket_id, page_id).await.map_err(docs_error)?;
        Ok(Value::Object(linked))
    })
    .await
}

/// Remove a manual link between a Docs page and a ticket.
pub async fn unlink_ticket_doc(ticket_id: &str, page_id: &str) -> ToolResult {
    notify_on_success(async {
        let session = common::async_session();
        let removed = kb_docs::docs::unlink_ticket_doc(&session, ticket_id, page_id).await.map_err(docs_error)?;
        Ok(Value::Object(removed))
    })
    .await
}
