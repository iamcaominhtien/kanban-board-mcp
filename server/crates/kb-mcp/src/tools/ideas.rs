//! The Idea Space tools: read ideas and their assumptions, and add to the Inbox. Python registers the operations
//! themselves as the tools; here each reads its arguments and calls the operation.

use serde_json::{Map, Value};

use crate::common::{ToolResult, arg_list, arg_str, arg_text};
use crate::operations as ops;

/// List ideas (Idea Space), the ones closest to ready first.
pub async fn list_idea_tickets(args: Map<String, Value>) -> ToolResult {
    let (project_id, stage, q) = (arg_str(&args, "project_id"), arg_str(&args, "stage"), arg_str(&args, "q"));
    ops::list_idea_tickets(project_id.as_deref(), stage.as_deref(), q.as_deref()).await
}

/// Get one idea in full.
pub async fn get_idea_ticket(args: Map<String, Value>) -> ToolResult {
    ops::get_idea_ticket(&arg_text(&args, "ticket_id")).await
}

/// The assumptions of an idea and its readiness.
pub async fn list_idea_assumptions(args: Map<String, Value>) -> ToolResult {
    ops::list_idea_assumptions(&arg_text(&args, "ticket_id")).await
}

/// The idea's change history, newest first.
pub async fn get_idea_activity_trail(args: Map<String, Value>) -> ToolResult {
    ops::get_idea_activity_trail(&arg_text(&args, "ticket_id")).await
}

/// Suggest an idea: it lands in the Inbox of the Idea Space for a person to sort.
pub async fn create_idea_ticket(args: Map<String, Value>) -> ToolResult {
    let description = arg_str(&args, "description");
    let (project_id, why, ticket_id) =
        (arg_str(&args, "project_id"), arg_str(&args, "why"), arg_str(&args, "ticket_id"));
    ops::create_idea_ticket(
        &arg_text(&args, "title"),
        description.as_deref().unwrap_or_default(),
        project_id.as_deref(),
        why.as_deref(),
        ticket_id.as_deref(),
        arg_list(&args, "tags"),
    )
    .await
}
