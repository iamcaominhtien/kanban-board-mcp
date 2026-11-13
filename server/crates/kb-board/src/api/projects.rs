//! `api/projects.py`: the routes under `/projects`.

use axum::Json;
use axum::http::StatusCode;
use kb_base::error::{Body, Path};
use kb_base::{ApiError, ApiResult, Routes, activity, events};
use kb_doctext::docs_access;

use crate::projects::{Error, create_project, delete_project, get_project, list_projects, update_project};
use crate::schemas::{ProjectCreate, ProjectRead, ProjectUpdate};

/// `except ValueError as exc: raise HTTPException(status_code=400, detail=str(exc))`; anything else is a 500.
fn bad_request(err: Error) -> ApiError {
    match err {
        Error::Value(message) => ApiError::bad_request(message),
        Error::Db(err) => err.into(),
        Error::Other(message) => ApiError::internal(message),
    }
}

/// The routes of this file.
pub fn routes() -> Routes {
    Routes::new()
        .get("/projects", get_projects)
        .post("/projects", post_project)
        .get("/projects/{project_id}", get_one_project)
        .patch("/projects/{project_id}", patch_project)
        .delete("/projects/{project_id}", del_project)
}

/// List all projects.
async fn get_projects() -> ApiResult<Json<Vec<ProjectRead>>> {
    let session = kb_db::session();
    let projects = list_projects(&session).await?;
    Ok(Json(projects.into_iter().map(ProjectRead::from).collect()))
}

/// Create a project.
async fn post_project(Body(data): Body<ProjectCreate>) -> ApiResult<(StatusCode, Json<ProjectRead>)> {
    let session = kb_db::session();
    let project = create_project(&session, &data).await.map_err(bad_request)?;
    events::publish("invalidate", &[]).await;
    Ok((StatusCode::CREATED, Json(ProjectRead::from(project))))
}

/// Get a project by id.
async fn get_one_project(Path(project_id): Path<String>) -> ApiResult<Json<ProjectRead>> {
    let session = kb_db::session();
    let Some(project) = get_project(&session, &project_id).await? else {
        return Err(ApiError::not_found("Project not found"));
    };
    Ok(Json(ProjectRead::from(project)))
}

/// Update a project's name, color, linked repo or Docs settings (Docs settings: admins only).
async fn patch_project(
    Path(project_id): Path<String>,
    Body(data): Body<ProjectUpdate>,
) -> ApiResult<Json<ProjectRead>> {
    let session = kb_db::session();
    if data.docs_enabled.is_some() || data.docs_edit_policy.is_some() {
        let members = docs_access::members_of(&session, &project_id).await?;
        if docs_access::role_in(&members, &activity::current_actor()) != "admin" {
            return Err(ApiError::forbidden("Only project admins can change Docs settings."));
        }
    }
    let Some(project) = update_project(&session, &project_id, &data).await.map_err(bad_request)? else {
        return Err(ApiError::not_found("Project not found"));
    };
    events::publish("invalidate", &[]).await;
    Ok(Json(ProjectRead::from(project)))
}

/// Delete a project with its tickets and everything else in it.
async fn del_project(Path(project_id): Path<String>) -> ApiResult<StatusCode> {
    let session = kb_db::session();
    let found = delete_project(&session, &project_id).await.map_err(bad_request)?;
    if !found {
        return Err(ApiError::not_found("Project not found"));
    }
    events::publish("invalidate", &[]).await;
    Ok(StatusCode::NO_CONTENT)
}
