//! `api/tickets.py`, lines 994-1096: the project's activity feed (for the event timeline), the blocks / blocked-by
//! relation and the extended links between two tickets.

use axum::Json;
use axum::http::StatusCode;
use kb_base::error::{Body, Path, Query};
use kb_base::{ApiError, ApiResult, Routes, events};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use super::{bad_request, given, query_int, uncaught};
use crate::schemas::TicketRead;
use crate::tickets::schemas::literal;
use crate::tickets::{
    ActivityEventRead, add_ticket_link, get_project_activities, link_block, remove_ticket_link, unlink_block,
};
use kb_db::entities::ticket;

/// The routes of this part.
pub(super) fn routes() -> Routes {
    Routes::new()
        .get("/projects/{project_id}/activities", get_project_activities_handler)
        .post("/tickets/{ticket_id}/blocks/{target_id}", post_block)
        .delete("/tickets/{ticket_id}/blocks/{target_id}", delete_block)
        .post("/tickets/{ticket_id}/links", post_ticket_link)
        .delete("/tickets/{ticket_id}/links/{link_id}", delete_ticket_link)
}

// ---------------------------------------------------------------------------
// Project activities (for event timeline)
// ---------------------------------------------------------------------------

/// The query of `GET /projects/{project_id}/activities`.
#[derive(Debug, Deserialize)]
struct ActivitiesQuery {
    #[serde(default, deserialize_with = "given")]
    limit: Option<String>,
}

/// List the project's recent activity.
async fn get_project_activities_handler(
    Path(project_id): Path<String>,
    Query(query): Query<ActivitiesQuery>,
) -> ApiResult<Json<Vec<ActivityEventRead>>> {
    // `limit: int = Query(default=200, ge=1, le=1000)`
    let limit = query_int("limit", query.limit.as_deref(), 200)?;
    if limit < 1 {
        let message = "Input should be greater than or equal to 1";
        return Err(ApiError::validation(&["query", "limit"], message, "greater_than_equal"));
    }
    if limit > 1000 {
        let message = "Input should be less than or equal to 1000";
        return Err(ApiError::validation(&["query", "limit"], message, "less_than_equal"));
    }
    let session = kb_db::session();
    Ok(Json(get_project_activities(&session, &project_id, limit as usize).await.map_err(uncaught)?))
}

// ---------------------------------------------------------------------------
// Block / Blocked-by relationships
// ---------------------------------------------------------------------------

/// Both tickets of a blocks relation.
#[derive(Debug, Serialize)]
struct BlockPairRead {
    blocker: TicketRead,
    blocked: TicketRead,
}

/// `if result is None: _404("One or both tickets not found")`, the announcement, and both tickets.
async fn pair(result: Option<(ticket::Model, ticket::Model)>) -> ApiResult<Json<BlockPairRead>> {
    let Some((blocker, blocked)) = result else {
        return Err(ApiError::not_found("One or both tickets not found"));
    };
    events::publish("invalidate", &[]).await;
    Ok(Json(BlockPairRead { blocker: TicketRead::from_ticket(blocker)?, blocked: TicketRead::from_ticket(blocked)? }))
}

/// Mark a ticket as blocking another.
async fn post_block(Path((ticket_id, target_id)): Path<(String, String)>) -> ApiResult<Json<BlockPairRead>> {
    let session = kb_db::session();
    pair(link_block(&session, &ticket_id, &target_id).await.map_err(bad_request)?).await
}

/// Remove a blocks relation.
async fn delete_block(Path((ticket_id, target_id)): Path<(String, String)>) -> ApiResult<Json<BlockPairRead>> {
    let session = kb_db::session();
    pair(unlink_block(&session, &ticket_id, &target_id).await.map_err(uncaught)?).await
}

// ---------------------------------------------------------------------------
// Extended link relationships
// ---------------------------------------------------------------------------

literal! {
    /// `Literal["relates_to", "causes", "caused_by", "duplicates", "duplicated_by"]`.
    RelationType {
        RelatesTo => "relates_to",
        Causes => "causes",
        CausedBy => "caused_by",
        Duplicates => "duplicates",
        DuplicatedBy => "duplicated_by",
    }
}

/// Request body to link two tickets.
#[derive(Debug, Deserialize)]
struct TicketLinkBody {
    target_id: String,
    relation_type: RelationType,
}

/// A ticket link as returned by the API.
#[derive(Debug, Serialize)]
struct TicketLinkRead {
    id: String,
    target_id: String,
    relation_type: &'static str,
}

impl TicketLinkRead {
    /// `TicketLinkRead(**link)`: a stored link that lacks a field, or holds one of another kind, is the model's
    /// validation error (a 500).
    fn of(link: &Value) -> ApiResult<Self> {
        let invalid = || ApiError::internal(format!("TicketLinkRead: a stored link is not valid: {link}"));
        let text = |key: &str| link.get(key).and_then(Value::as_str).map(str::to_string).ok_or_else(invalid);
        let relation_type: RelationType =
            serde_json::from_value(json!(text("relation_type")?)).map_err(|_| invalid())?;
        Ok(Self { id: text("id")?, target_id: text("target_id")?, relation_type: relation_type.as_str() })
    }
}

/// Link two tickets.
async fn post_ticket_link(
    Path(ticket_id): Path<String>,
    Body(body): Body<TicketLinkBody>,
) -> ApiResult<(StatusCode, Json<TicketLinkRead>)> {
    let session = kb_db::session();
    let link = add_ticket_link(&session, &ticket_id, &body.target_id, body.relation_type.as_str())
        .await
        .map_err(bad_request)?;
    events::publish("invalidate", &[]).await;
    Ok((StatusCode::CREATED, Json(TicketLinkRead::of(&link)?)))
}

/// Remove a ticket link.
async fn delete_ticket_link(Path((ticket_id, link_id)): Path<(String, String)>) -> ApiResult<Json<Value>> {
    let session = kb_db::session();
    let found = remove_ticket_link(&session, &ticket_id, &link_id).await.map_err(uncaught)?;
    if !found {
        return Err(ApiError::not_found("Link not found"));
    }
    events::publish("invalidate", &[]).await;
    Ok(Json(json!({"success": true})))
}
