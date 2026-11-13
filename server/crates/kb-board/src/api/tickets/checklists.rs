//! `api/tickets.py`, lines 677-780: acceptance criteria and sub-tasks (checklist items).

use axum::Json;
use kb_base::error::{Body, Path};
use kb_base::{ApiResult, Routes};
use serde::Deserialize;

use super::{bad_request, changed, uncaught};
use crate::schemas::TicketRead;
use crate::tickets::{
    add_acceptance_criterion, add_sub_task, delete_acceptance_criterion, delete_sub_task, toggle_acceptance_criterion,
    toggle_sub_task,
};

/// The routes of this part.
pub(super) fn routes() -> Routes {
    Routes::new()
        .post("/tickets/{ticket_id}/acceptance-criteria", post_ac)
        .patch("/tickets/{ticket_id}/acceptance-criteria/{criterion_id}/toggle", toggle_ac)
        .delete("/tickets/{ticket_id}/acceptance-criteria/{criterion_id}", del_ac)
        .post("/tickets/{ticket_id}/sub-tasks", post_sub_task)
        .patch("/tickets/{ticket_id}/sub-tasks/{sub_task_id}/toggle", toggle_sub_task_route)
        .delete("/tickets/{ticket_id}/sub-tasks/{sub_task_id}", del_sub_task)
}

// ---------------------------------------------------------------------------
// Acceptance criteria
// ---------------------------------------------------------------------------

/// Request body to add an acceptance criterion.
#[derive(Debug, Deserialize)]
struct ACBody {
    text: String,
}

/// Add an acceptance criterion.
async fn post_ac(Path(ticket_id): Path<String>, Body(body): Body<ACBody>) -> ApiResult<Json<TicketRead>> {
    let session = kb_db::session();
    let ticket = add_acceptance_criterion(&session, &ticket_id, &body.text).await.map_err(bad_request)?;
    changed(ticket).await
}

/// Toggle an acceptance criterion.
async fn toggle_ac(Path((ticket_id, criterion_id)): Path<(String, String)>) -> ApiResult<Json<TicketRead>> {
    let session = kb_db::session();
    let ticket = toggle_acceptance_criterion(&session, &ticket_id, &criterion_id).await.map_err(uncaught)?;
    changed(ticket).await
}

/// Delete an acceptance criterion.
async fn del_ac(Path((ticket_id, criterion_id)): Path<(String, String)>) -> ApiResult<Json<TicketRead>> {
    let session = kb_db::session();
    let ticket = delete_acceptance_criterion(&session, &ticket_id, &criterion_id).await.map_err(uncaught)?;
    changed(ticket).await
}

// ---------------------------------------------------------------------------
// Sub-tasks (checklist items)
// ---------------------------------------------------------------------------

/// Request body to add a sub-task.
#[derive(Debug, Deserialize)]
struct SubTaskBody {
    text: String,
}

/// Add a sub-task.
async fn post_sub_task(Path(ticket_id): Path<String>, Body(body): Body<SubTaskBody>) -> ApiResult<Json<TicketRead>> {
    let session = kb_db::session();
    let ticket = add_sub_task(&session, &ticket_id, &body.text).await.map_err(bad_request)?;
    changed(ticket).await
}

/// Toggle a sub-task.
async fn toggle_sub_task_route(Path((ticket_id, sub_task_id)): Path<(String, String)>) -> ApiResult<Json<TicketRead>> {
    let session = kb_db::session();
    let ticket = toggle_sub_task(&session, &ticket_id, &sub_task_id).await.map_err(uncaught)?;
    changed(ticket).await
}

/// Delete a sub-task.
async fn del_sub_task(Path((ticket_id, sub_task_id)): Path<(String, String)>) -> ApiResult<Json<TicketRead>> {
    let session = kb_db::session();
    let ticket = delete_sub_task(&session, &ticket_id, &sub_task_id).await.map_err(uncaught)?;
    changed(ticket).await
}
