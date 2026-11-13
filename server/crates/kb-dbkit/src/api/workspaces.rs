//! `/workspaces`: the boards kept on this computer and the switch between them (App settings › Storage & backup ›
//! Workspaces, and the switcher in the sidebar). See `crate::workspaces`.

use axum::Json;
use kb_base::error::{Body, Path as UrlPath};
use kb_base::{ApiError, ApiResult, Routes};
use serde::Deserialize;
use serde_json::{Value, json};

use crate::api::database::{ConnectionBody, target_of};
use crate::probe;
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
    /// A PostgreSQL or MySQL/MariaDB database the board lives in (the fields of the database wizard, or `url`); left
    /// out, the board is a SQLite file in the folder.
    #[serde(default)]
    connection: Option<ConnectionBody>,
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
        Error::Unusable(message) => ApiError::unprocessable(json!({"code": "not_usable", "message": message})),
        Error::Failed(message) => ApiError::code(500, message),
    }
}

fn overview() -> Value {
    let items = workspaces::list();
    let active = items.iter().find(|item| item.active).map(|item| item.workspace.id.clone());
    json!({
        "items": items.iter().map(workspaces::Item::as_json).collect::<Vec<_>>(),
        "active_id": active,
        "switchable": workspaces::locked().is_none(),
        "reason": workspaces::locked(),
        // names the board open now: a window sends it back with its changes (`x-kanban-board`)
        "board": kb_db::database::board_token(),
    })
}

/// Every workspace, the one in use marked, and whether a switch is possible on this database.
async fn get_workspaces() -> Json<Value> {
    Json(overview())
}

/// Add a workspace (nothing is switched).
async fn post_workspace(Body(body): Body<NewWorkspace>) -> ApiResult<Json<Value>> {
    let server = match body.connection.as_ref().filter(|c| c.engine.as_deref() != Some("sqlite")) {
        Some(connection) => Some(usable_server(connection).await?),
        None => None,
    };
    let item = workspaces::add(&body.name, body.folder.as_deref(), server.as_ref()).map_err(failure)?;
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

/// The database of a new workspace, after a test of it: it must answer, and be empty or already hold a board.
async fn usable_server(connection: &ConnectionBody) -> ApiResult<kb_db::targets::Target> {
    let target = target_of(connection)?;
    let report = probe::test(&target).await?;
    match workspaces::problem_of(&report) {
        None => Ok(target),
        Some(message) => Err(ApiError::unprocessable(json!({
            "code": "not_usable",
            "message": message,
            "report": report.as_dict(),
        }))),
    }
}
