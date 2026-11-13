//! `/workspaces`: the boards kept on this computer and the switch between them (App settings › Storage & backup ›
//! Workspaces, and the switcher in the sidebar). See `crate::workspaces`.

use axum::Json;
use kb_base::error::{Body, Path as UrlPath};
use kb_base::{ApiError, ApiResult, Routes};
use serde::Deserialize;
use serde_json::{Value, json};

use crate::workspaces::{self, Error};

/// The routes of this file.
pub fn routes() -> Routes {
    Routes::new()
        .get("/workspaces", get_workspaces)
        .post("/workspaces", post_workspace)
        .patch("/workspaces/{workspace_id}", patch_workspace)
        .delete("/workspaces/{workspace_id}", delete_workspace)
        .post("/workspaces/{workspace_id}/switch", post_switch)
}

/// Body of `POST /workspaces`.
#[derive(Debug, Deserialize)]
struct NewWorkspace {
    name: String,
    /// The data folder; left out, a new folder is made next to the settings file.
    #[serde(default)]
    folder: Option<String>,
}

/// Body of `PATCH /workspaces/{id}`.
#[derive(Debug, Deserialize)]
struct RenameWorkspace {
    name: String,
}

fn failure(error: Error) -> ApiError {
    match error {
        Error::Invalid(message) => ApiError::bad_request(message),
        Error::NotFound => ApiError::not_found("Workspace not found"),
        Error::Taken(message) | Error::Unsupported(message) | Error::Busy(message) => ApiError::conflict(message),
        Error::Failed(message) => ApiError::code(500, message),
    }
}

fn overview() -> Value {
    let items = workspaces::list();
    let active = items.iter().find(|item| item.active).map(|item| item.workspace.id.clone());
    json!({
        "items": items.iter().map(workspaces::Item::as_json).collect::<Vec<_>>(),
        "active_id": active,
        "switchable": workspaces::unsupported().is_none(),
        "reason": workspaces::unsupported(),
    })
}

/// Every workspace, the one in use marked, and whether a switch is possible on this database.
async fn get_workspaces() -> Json<Value> {
    Json(overview())
}

/// Add a workspace (nothing is switched).
async fn post_workspace(Body(body): Body<NewWorkspace>) -> ApiResult<Json<Value>> {
    let item = workspaces::add(&body.name, body.folder.as_deref()).map_err(failure)?;
    Ok(Json(item.as_json()))
}

/// Rename a workspace.
async fn patch_workspace(
    UrlPath(workspace_id): UrlPath<String>,
    Body(body): Body<RenameWorkspace>,
) -> ApiResult<Json<Value>> {
    Ok(Json(workspaces::rename(&workspace_id, &body.name).map_err(failure)?.as_json()))
}

/// Forget a workspace (its folder and data stay on disk).
async fn delete_workspace(UrlPath(workspace_id): UrlPath<String>) -> ApiResult<Json<Value>> {
    workspaces::remove(&workspace_id).map_err(failure)?;
    Ok(Json(overview()))
}

/// Open another workspace now.
async fn post_switch(UrlPath(workspace_id): UrlPath<String>) -> ApiResult<Json<Value>> {
    workspaces::switch(&workspace_id).await.map_err(failure)?;
    Ok(Json(overview()))
}
