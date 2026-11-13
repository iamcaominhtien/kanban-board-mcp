//! `api/tickets.py`, lines 443-560: reopening a closed ticket and undoing it, the Pending flag and Resume.

use axum::Json;
use kb_base::error::{Body, OptionalBody, Path};
use kb_base::{ApiError, ApiResult, Routes};
use serde::Deserialize;

use super::{bad_request, changed, uncaught, user};
use crate::schemas::TicketRead;
use crate::tickets::schemas::literal;
use crate::tickets::{
    Error, PendingReason, ReopenOptions, clear_pending, get_ticket, reopen_ticket, set_pending, undo_reopen,
};

/// The routes of this part.
pub(super) fn routes() -> Routes {
    Routes::new()
        .post("/tickets/{ticket_id}/reopen", post_reopen)
        .post("/tickets/{ticket_id}/reopen/undo", post_undo_reopen)
        .put("/tickets/{ticket_id}/pending", put_pending)
        .delete("/tickets/{ticket_id}/pending", delete_pending_route)
        .post("/tickets/{ticket_id}/resume", delete_pending_route)
}

/// `raise HTTPException(status_code=<code>, detail=str(exc))` for a `ValueError`; anything else is a 500.
fn refused(err: Error, code: impl Fn(&str) -> u16) -> ApiError {
    match err {
        Error::Value(message) => ApiError::code(code(&message), message),
        other => bad_request(other),
    }
}

/// Request body to reopen a ticket.
#[derive(Debug, Deserialize)]
struct ReopenBody {
    #[serde(default)]
    reason: Option<String>,
    #[serde(default)]
    reset_ac: bool,
    #[serde(default)]
    reset_tests: bool,
    #[serde(default)]
    unassign: bool,
    #[serde(default)]
    reopen_parent: bool,
    #[serde(default = "user")]
    actor: Option<String>,
}

/// Reopen a ticket that was Done or Won't Do, moving it to To Do.
async fn post_reopen(Path(ticket_id): Path<String>, Body(body): Body<ReopenBody>) -> ApiResult<Json<TicketRead>> {
    let session = kb_db::session();
    let options = ReopenOptions {
        reason: body.reason.as_deref(),
        reset_ac: body.reset_ac,
        reset_tests: body.reset_tests,
        unassign: body.unassign,
        reopen_parent: body.reopen_parent,
        actor: body.actor.as_deref(),
    };
    let ticket = reopen_ticket(&session, &ticket_id, options).await.map_err(|err| {
        // The status changed since the dialog opened (someone else reopened it): conflict
        refused(err, |message| if message.contains("can be reopened") { 409 } else { 400 })
    })?;
    changed(ticket).await
}

/// Undo the latest reopen (toast Undo).
async fn post_undo_reopen(Path(ticket_id): Path<String>) -> ApiResult<Json<TicketRead>> {
    let session = kb_db::session();
    let ticket = undo_reopen(&session, &ticket_id).await.map_err(|err| refused(err, |_| 409))?;
    changed(ticket).await
}

literal! {
    /// `Literal["ticket", "person", "party"]`.
    PendingReasonType { Ticket => "ticket", Person => "person", Party => "party" }
}

/// Request body to mark a ticket as pending.
#[derive(Debug, Deserialize)]
struct SetPendingBody {
    reason_type: PendingReasonType,
    #[serde(default)]
    ticket_id: Option<String>,
    #[serde(default)]
    member_id: Option<String>,
    #[serde(default)]
    party: Option<String>,
    #[serde(default)]
    note: Option<String>,
    #[serde(default)]
    add_blocked_by: bool,
    #[serde(default = "user")]
    actor: Option<String>,
}

/// Set the Pending flag on a ticket.
async fn put_pending(Path(ticket_id): Path<String>, Body(body): Body<SetPendingBody>) -> ApiResult<Json<TicketRead>> {
    let session = kb_db::session();
    let reason = PendingReason {
        reason_type: body.reason_type.as_str(),
        ticket_target_id: body.ticket_id.as_deref(),
        member_id: body.member_id.as_deref(),
        party: body.party.as_deref(),
        note: body.note.as_deref(),
        add_blocked_by: body.add_blocked_by,
        actor: body.actor.as_deref(),
    };
    let ticket = set_pending(&session, &ticket_id, reason).await.map_err(|err| {
        refused(err, |message| if message.contains("cannot be marked as pending") { 422 } else { 400 })
    })?;
    changed(ticket).await
}

/// Request body to resume a pending ticket.
#[derive(Debug, Deserialize)]
struct ClearPendingBody {
    #[serde(default)]
    reason: Option<String>,
    #[serde(default)]
    add_comment: bool,
    #[serde(default = "user")]
    actor: Option<String>,
}

/// Resume a pending ticket.
async fn delete_pending_route(
    Path(ticket_id): Path<String>,
    OptionalBody(body): OptionalBody<ClearPendingBody>,
) -> ApiResult<Json<TicketRead>> {
    let b = body.unwrap_or(ClearPendingBody { reason: None, add_comment: false, actor: user() });
    let session = kb_db::session();
    let current = get_ticket(&session, &ticket_id).await?;
    if current.is_some_and(|current| !current.pending) {
        // someone resumed it meanwhile: nothing is applied
        return Err(ApiError::conflict(format!("{ticket_id} is no longer pending")));
    }
    // nothing is caught here: a reason that is too long is a 500
    let ticket = clear_pending(&session, &ticket_id, b.reason.as_deref(), b.add_comment, b.actor.as_deref())
        .await
        .map_err(uncaught)?;
    changed(ticket).await
}
