//! `api/tickets.py`, lines 563-674: the comments of a ticket.

use axum::Json;
use kb_base::error::{Body, Path};
use kb_base::pyjson::{self, truthy};
use kb_base::{ApiResult, Routes, events};
use kb_db::entities::ticket;
use serde::Deserialize;
use serde_json::{Map, Value, json};

use super::{bad_request, not_found, read};
use crate::schemas::TicketRead;
use crate::tickets::{add_comment, delete_comment, get_ticket, restore_comment, update_comment};

/// A comment changes its ticket (the list's counts, the activity) and the Docs pages it names, nothing else: the app
/// refetches only those (`ui/src/hooks/invalidationTopics.ts`), not everything every open window holds.
pub(crate) const COMMENTS_TOPIC: &str = "comments";

/// `changed` of the parent module, with the invalidation named `COMMENTS_TOPIC`.
async fn changed(ticket: Option<ticket::Model>) -> ApiResult<Json<TicketRead>> {
    let Some(ticket) = ticket else {
        return Err(not_found());
    };
    events::publish(events::INVALIDATE, &[COMMENTS_TOPIC]).await;
    read(ticket)
}

/// The routes of this part.
pub(super) fn routes() -> Routes {
    Routes::new()
        .post("/tickets/{ticket_id}/comments", post_comment)
        .patch("/tickets/{ticket_id}/comments/{comment_id}", patch_comment)
        .post("/tickets/{ticket_id}/comments/{comment_id}/restore", undo_delete_comment)
        .delete("/tickets/{ticket_id}/comments/{comment_id}", del_comment)
}

fn loads_comments(ticket: &ticket::Model) -> Vec<Value> {
    let text = if ticket.comments.is_empty() { "[]" } else { ticket.comments.as_str() };
    match serde_json::from_str::<Value>(text) {
        Ok(Value::Array(data)) => data.into_iter().filter(Value::is_object).collect(),
        _ => Vec::new(),
    }
}

/// `Literal["ask", "work", "notify"]`.
#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
enum AiIntent {
    Ask,
    Work,
    Notify,
}

fn default_author() -> String {
    "user".to_string()
}

/// Request body to add a comment.
#[derive(Debug, Deserialize)]
struct CommentBody {
    text: String,
    #[serde(default = "default_author")]
    author: String,
    /// What an @mention of an AI member means: ask (answer in a comment), work (assign + run) or notify
    #[serde(default)]
    #[allow(dead_code)] // read by nothing in the Python route either: the body only checks it
    ai_intent: Option<AiIntent>,
    /// Fast for the AI this comment wakes (a quick answer or result of about the same quality); otherwise the run
    /// follows the ticket's pace
    #[serde(default)]
    #[allow(dead_code)] // as `ai_intent`
    ai_fast: Option<bool>,
    /// A reply under another comment; under an AI's comment it asks that AI again
    #[serde(default)]
    reply_to: Option<String>,
}

/// Request body to edit a comment.
#[derive(Debug, Deserialize)]
struct CommentUpdateBody {
    text: String,
}

/// Add a comment and publish a `comment_added` event.
async fn post_comment(Path(ticket_id): Path<String>, Body(body): Body<CommentBody>) -> ApiResult<Json<TicketRead>> {
    let session = kb_db::session();
    let mut meta: Option<Map<String, Value>> = None;
    if let Some(reply_to) = body.reply_to.as_deref().filter(|reply_to| !reply_to.is_empty()) {
        let current = get_ticket(&session, &ticket_id).await?;
        let target = current.and_then(|current| {
            loads_comments(&current).into_iter().find(|c| c.get("id").and_then(Value::as_str) == Some(reply_to))
        });
        let mut reply = Map::new();
        reply.insert("reply_to".into(), json!(reply_to));
        let asked = target.as_ref().and_then(|target| target.get("ai")).and_then(|ai| ai.get("member_id"));
        if let Some(member_id) = asked.filter(|member_id| truthy(member_id)) {
            reply.insert("asks_again".into(), member_id.clone());
        }
        meta = Some(reply);
    }
    let ticket =
        add_comment(&session, &ticket_id, &body.text, &body.author, meta.as_ref()).await.map_err(bad_request)?;
    let Some(ticket) = ticket else {
        return Err(not_found());
    };
    events::publish(events::INVALIDATE, &[COMMENTS_TOPIC]).await;
    let latest = loads_comments(&ticket).pop();
    if let Some(latest) = latest.filter(|latest| latest.get("notified").is_some_and(truthy)) {
        let Some(comment_id) = latest.get("id") else {
            return Err(kb_base::ApiError::internal("KeyError: 'id'"));
        };
        let event = json!({
            "type": "comment_added",
            "ticket_id": ticket.id,
            "comment_id": comment_id,
            "author": latest.get("author"),
            "notified": latest["notified"],
        });
        events::publish(&pyjson::dumps(&event), &[]).await;
    }
    read(ticket)
}

/// Edit a comment.
async fn patch_comment(
    Path((ticket_id, comment_id)): Path<(String, String)>,
    Body(body): Body<CommentUpdateBody>,
) -> ApiResult<Json<TicketRead>> {
    let session = kb_db::session();
    let ticket = update_comment(&session, &ticket_id, &comment_id, &body.text).await.map_err(bad_request)?;
    changed(ticket).await
}

/// Restore a deleted comment.
async fn undo_delete_comment(Path((ticket_id, comment_id)): Path<(String, String)>) -> ApiResult<Json<TicketRead>> {
    let session = kb_db::session();
    // nothing is caught here
    let ticket = restore_comment(&session, &ticket_id, &comment_id).await.map_err(super::uncaught)?;
    changed(ticket).await
}

/// Delete a comment (restorable).
async fn del_comment(Path((ticket_id, comment_id)): Path<(String, String)>) -> ApiResult<Json<TicketRead>> {
    let session = kb_db::session();
    let ticket = delete_comment(&session, &ticket_id, &comment_id).await.map_err(super::uncaught)?;
    changed(ticket).await
}
