//! `api/idea_tickets.py`: the basic idea routes under `/api/idea-tickets` (list, create, get, patch, delete, the
//! legacy status and the old assumption and microthought routes). The Idea Space router is included before this one,
//! so its fixed paths (`/counts`, `/similar`, ...) win over `/{ticket_id}`; see `mod.rs`.

use axum::Json;
use axum::http::StatusCode;
use kb_base::error::{Body, Path, Query};
use kb_base::{ApiError, ApiResult, activity, events};
use serde::Deserialize;

use super::idea_space::{read, reads};
use super::{Entry, delete, get, patch, post};
use crate::Error;
use crate::idea_tickets::{
    NewIdea, add_assumption, add_microthought, create_idea_ticket, delete_assumption, delete_idea_ticket,
    delete_microthought, get_idea_ticket, list_idea_tickets, update_assumption_status, update_idea_status,
    update_idea_ticket,
};
use crate::schemas::{
    AssumptionBody, AssumptionStatusBody, IdeaStatusUpdateBody, IdeaTicketCreateBody, IdeaTicketRead, IdeaTicketUpdate,
    MicrothoughtBody,
};

/// The routes of this file, in the order of the Python file.
pub(super) fn entries() -> Vec<Entry> {
    vec![
        get("/api/idea-tickets", get_idea_tickets),
        post("/api/idea-tickets", post_idea_ticket),
        get("/api/idea-tickets/{idea_id}", get_one_idea_ticket),
        patch("/api/idea-tickets/{idea_id}", patch_idea_ticket),
        delete("/api/idea-tickets/{idea_id}", del_idea_ticket),
        post("/api/idea-tickets/{idea_id}/assumptions", post_assumption),
        patch("/api/idea-tickets/{idea_id}/assumptions/{assumption_id}", patch_assumption_status),
        post("/api/idea-tickets/{idea_id}/microthoughts", post_microthought),
        delete("/api/idea-tickets/{idea_id}/assumptions/{assumption_id}", del_assumption),
        delete("/api/idea-tickets/{idea_id}/microthoughts/{microthought_id}", del_microthought),
        patch("/api/idea-tickets/{idea_id}/status", patch_idea_status),
    ]
}

/// `_404(detail)`.
fn not_found() -> ApiError {
    ApiError::not_found("Idea ticket not found")
}

/// `except ValueError as exc: raise HTTPException(status_code=400, detail=str(exc))`; anything else is a 500.
fn bad_request(err: Error) -> ApiError {
    match err {
        Error::Value(message) => ApiError::bad_request(message),
        Error::Rule(rule) => ApiError::bad_request(rule.message),
        Error::Db(err) => err.into(),
        Error::Other(message) => ApiError::internal(message),
    }
}

/// A route that catches nothing: a `ValueError` is a 500 like any other exception.
fn uncaught(err: Error) -> ApiError {
    match err {
        Error::Db(err) => err.into(),
        other => ApiError::internal(other),
    }
}

/// The query of the list route: `project_id` is required.
#[derive(Debug, Deserialize)]
struct ListQuery {
    project_id: String,
    #[serde(default)]
    idea_status: Option<String>,
    #[serde(default)]
    q: Option<String>,
}

/// List a project's idea tickets, filtered by status or text.
async fn get_idea_tickets(Query(query): Query<ListQuery>) -> ApiResult<Json<Vec<IdeaTicketRead>>> {
    let session = kb_db::session();
    let tickets = list_idea_tickets(&session, &query.project_id, query.idea_status.as_deref(), query.q.as_deref())
        .await
        .map_err(uncaught)?;
    Ok(Json(reads(&session, &tickets).await?))
}

/// Create an idea ticket.
async fn post_idea_ticket(Body(body): Body<IdeaTicketCreateBody>) -> ApiResult<(StatusCode, Json<IdeaTicketRead>)> {
    let session = kb_db::session();
    let author = activity::current_actor();
    let new = NewIdea {
        title: &body.title,
        description: &body.description,
        idea_color: &body.idea_color,
        idea_emoji: &body.idea_emoji,
        idea_energy: body.idea_energy.map(|e| e.as_str()),
        tags: Some(&body.tags),
        problem_statement: body.problem_statement.as_deref(),
        source: body.source.as_str(),
        author: Some(&author),
        source_ref: body.source_ref.as_ref(),
    };
    let ticket = create_idea_ticket(&session, body.project_id.as_deref(), new).await.map_err(bad_request)?;
    events::publish("invalidate", &[]).await;
    Ok((StatusCode::CREATED, Json(read(&session, &ticket).await?)))
}

/// Get an idea ticket by id.
async fn get_one_idea_ticket(Path(ticket_id): Path<String>) -> ApiResult<Json<IdeaTicketRead>> {
    let session = kb_db::session();
    let Some(ticket) = get_idea_ticket(&session, &ticket_id).await.map_err(uncaught)? else {
        return Err(not_found());
    };
    Ok(Json(read(&session, &ticket).await?))
}

/// Update an idea ticket.
async fn patch_idea_ticket(
    Path(ticket_id): Path<String>,
    Body(data): Body<IdeaTicketUpdate>,
) -> ApiResult<Json<IdeaTicketRead>> {
    let session = kb_db::session();
    let author = activity::current_actor();
    let Some(ticket) =
        update_idea_ticket(&session, &ticket_id, Some(&author), &data.fields).await.map_err(bad_request)?
    else {
        return Err(not_found());
    };
    events::publish("invalidate", &[]).await;
    Ok(Json(read(&session, &ticket).await?))
}

/// Delete an idea ticket.
async fn del_idea_ticket(Path(ticket_id): Path<String>) -> ApiResult<StatusCode> {
    let session = kb_db::session();
    if !delete_idea_ticket(&session, &ticket_id).await.map_err(uncaught)? {
        return Err(not_found());
    }
    events::publish("invalidate", &[]).await;
    Ok(StatusCode::NO_CONTENT)
}

/// Add an assumption to an idea.
async fn post_assumption(
    Path(ticket_id): Path<String>,
    Body(body): Body<AssumptionBody>,
) -> ApiResult<Json<IdeaTicketRead>> {
    let session = kb_db::session();
    let author = activity::current_actor();
    let ticket = add_assumption(&session, &ticket_id, &body.text, body.impact.as_str(), Some(&author), false)
        .await
        .map_err(bad_request)?;
    events::publish("invalidate", &[]).await;
    Ok(Json(read(&session, &ticket).await?))
}

/// Set an assumption's status.
async fn patch_assumption_status(
    Path((ticket_id, assumption_id)): Path<(String, String)>,
    Body(body): Body<AssumptionStatusBody>,
) -> ApiResult<Json<IdeaTicketRead>> {
    let session = kb_db::session();
    let ticket = update_assumption_status(
        &session,
        &ticket_id,
        &assumption_id,
        body.status.as_str(),
        Some(crate::idea_tickets::DEFAULT_AUTHOR),
    )
    .await
    .map_err(bad_request)?;
    events::publish("invalidate", &[]).await;
    Ok(Json(read(&session, &ticket).await?))
}

/// Add a microthought to an idea.
async fn post_microthought(
    Path(ticket_id): Path<String>,
    Body(body): Body<MicrothoughtBody>,
) -> ApiResult<Json<IdeaTicketRead>> {
    let session = kb_db::session();
    let ticket = add_microthought(&session, &ticket_id, &body.text, Some(crate::idea_tickets::DEFAULT_AUTHOR))
        .await
        .map_err(bad_request)?;
    events::publish("invalidate", &[]).await;
    Ok(Json(read(&session, &ticket).await?))
}

/// Delete an assumption.
async fn del_assumption(Path((ticket_id, assumption_id)): Path<(String, String)>) -> ApiResult<Json<IdeaTicketRead>> {
    let session = kb_db::session();
    let author = activity::current_actor();
    let ticket = delete_assumption(&session, &ticket_id, &assumption_id, Some(&author)).await.map_err(bad_request)?;
    events::publish("invalidate", &[]).await;
    Ok(Json(read(&session, &ticket).await?))
}

/// Delete a microthought.
async fn del_microthought(
    Path((ticket_id, microthought_id)): Path<(String, String)>,
) -> ApiResult<Json<IdeaTicketRead>> {
    let session = kb_db::session();
    let ticket = delete_microthought(&session, &ticket_id, &microthought_id).await.map_err(bad_request)?;
    events::publish("invalidate", &[]).await;
    Ok(Json(read(&session, &ticket).await?))
}

/// Move an idea to a new status.
async fn patch_idea_status(
    Path(ticket_id): Path<String>,
    Body(body): Body<IdeaStatusUpdateBody>,
) -> ApiResult<Json<IdeaTicketRead>> {
    let session = kb_db::session();
    let author = activity::current_actor();
    let ticket = update_idea_status(&session, &ticket_id, &body.new_status, body.reason.as_deref(), Some(&author))
        .await
        .map_err(bad_request)?;
    events::publish("invalidate", &[]).await;
    Ok(Json(read(&session, &ticket).await?))
}
