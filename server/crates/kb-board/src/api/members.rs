//! `api/members.py`: the routes under `/projects/{project_id}/members`.

use axum::Json;
use axum::http::StatusCode;
use kb_base::error::{Body, Path};
use kb_base::{ApiError, ApiResult, Routes, events, pyjson};
use serde_json::Value;

use crate::hooks;
use crate::members::{Error, create_member, list_members, remove_member, set_member_role};
use crate::schemas::{MemberCreate, MemberRead, MemberRoleUpdate};
use kb_base::pytext;

/// `except ValueError as exc: raise HTTPException(status_code=status, detail=str(exc))`; anything else is a 500.
fn value_error(status: StatusCode, err: Error) -> ApiError {
    match err {
        Error::Value(message) => ApiError::new(status, message),
        Error::Db(err) => err.into(),
    }
}

/// The routes of this file.
pub fn routes() -> Routes {
    Routes::new()
        .get("/projects/{project_id}/members", get_members)
        .post("/projects/{project_id}/members", post_member)
        .patch("/projects/{project_id}/members/{member_id}", patch_member)
        .delete("/projects/{project_id}/members/{member_id}", del_member)
}

/// List a project's members.
async fn get_members(Path(project_id): Path<String>) -> ApiResult<Json<Vec<MemberRead>>> {
    let session = kb_db::session();
    let members = list_members(&session, &project_id).await?;
    Ok(Json(members.into_iter().map(MemberRead::from).collect()))
}

/// Add a member to a project.
async fn post_member(
    Path(project_id): Path<String>,
    Body(data): Body<MemberCreate>,
) -> ApiResult<(StatusCode, Json<MemberRead>)> {
    let session = kb_db::session();
    if !["viewer", "member", "admin"].contains(&data.role.as_str()) {
        return Err(ApiError::unprocessable("Invalid role"));
    }
    if pytext::squash(&data.name).is_empty() {
        return Err(ApiError::unprocessable("Enter a name."));
    }
    // Names are unique across people and AI in a project, so @mentions never point at two members
    if let Some(teams) = hooks::ai_teams() {
        let found = teams.check_name(&session, &project_id, &data.name, None).await?;
        if !found.get("ok").is_some_and(pyjson::truthy) {
            let msg = if found.get("conflict").and_then(Value::as_str) == Some("ai") {
                Value::String(format!("An AI member already uses the name “{}”.", pytext::squash(&data.name)))
            } else {
                found.get("message").cloned().unwrap_or(Value::Null)
            };
            return Err(ApiError::conflict(msg));
        }
    }
    let member = create_member(&session, &project_id, &data.name, data.color.as_deref(), &data.role, true).await?;
    events::publish("invalidate", &[]).await;
    Ok((StatusCode::CREATED, Json(MemberRead::from(member))))
}

/// Change a member's Docs role (viewer, member or admin).
async fn patch_member(
    Path((project_id, member_id)): Path<(String, String)>,
    Body(data): Body<MemberRoleUpdate>,
) -> ApiResult<Json<MemberRead>> {
    let session = kb_db::session();
    let member = set_member_role(&session, &project_id, &member_id, &data.role)
        .await
        .map_err(|err| value_error(StatusCode::UNPROCESSABLE_ENTITY, err))?;
    let Some(member) = member else {
        return Err(ApiError::not_found("Member not found"));
    };
    events::publish("invalidate", &[]).await;
    Ok(Json(MemberRead::from(member)))
}

/// Remove a member (rejected while they own tickets).
async fn del_member(Path((project_id, member_id)): Path<(String, String)>) -> ApiResult<StatusCode> {
    let session = kb_db::session();
    let found = remove_member(&session, &project_id, &member_id)
        .await
        .map_err(|err| value_error(StatusCode::BAD_REQUEST, err))?;
    if !found {
        return Err(ApiError::not_found("Member not found"));
    }
    events::publish("invalidate", &[]).await;
    Ok(StatusCode::NO_CONTENT)
}
