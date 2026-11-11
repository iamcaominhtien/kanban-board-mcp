//! `api/workspace.py`: the workspace settings, the sweep, and a ticket's workspace folder.

use axum::Json;
use axum::extract::{DefaultBodyLimit, RawQuery};
use axum::extract::multipart::{Multipart, MultipartRejection};
use axum::http::{HeaderMap, Method};
use axum::response::{IntoResponse, Response};
use axum::routing::post;
use kb_base::error::{Body, Path, Query};
use kb_base::{ApiError, ApiResult, Routes, events};
use kb_db::entities::workspace_settings;
use kb_files::FileResponse;
use serde::Deserialize;
use serde_json::{Value, json};

use crate::schemas::{TicketRead, WorkspaceSettingsUpdate};
use crate::workspace::{self, Error, MAX_UPLOAD_BYTES};

/// Request body for a ticket's workspace retention override.
#[derive(Debug, Deserialize)]
struct TicketRetentionBody {
    /// None = inherit, 0 = keep forever
    #[serde(default)]
    retention_days: Option<i32>,
}

/// Request body naming a folder inside a workspace.
#[derive(Debug, Deserialize)]
struct FolderBody {
    path: String,
}

/// Request body for the expired-workspace sweep.
#[derive(Debug, Deserialize)]
struct SweepBody {
    #[serde(default)]
    dry_run: bool,
}

/// `Literal["move", "copy"]`.
#[derive(Debug, Default, Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
enum MoveMode {
    #[default]
    Move,
    Copy,
}

/// Move or copy a ticket's workspace to another ticket.
#[derive(Debug, Deserialize)]
struct MoveBody {
    to_ticket_id: String,
    #[serde(default)]
    mode: MoveMode,
}

/// The query of `GET .../workspace/file`; `download` is read from the raw query (`download_flag`).
#[derive(Debug, Deserialize)]
struct FileQuery {
    path: String,
}

/// `except (LookupError, WorkspaceError)`: a missing ticket or entry is a 404, a refused request a 400; anything else
/// is a 500.
fn http(err: Error) -> ApiError {
    match err {
        // `str(exc).strip("'\"")`
        Error::Lookup(message) => ApiError::not_found(message.trim_matches(['\'', '"'])),
        Error::Workspace(message) => ApiError::bad_request(message),
        Error::Db(err) => err.into(),
        Error::Io(err) => err.into(),
        Error::Other(message) => ApiError::internal(message),
    }
}

/// The `download` query value (`bool = False`) as Pydantic reads it: a name given without a value is an empty string,
/// which is not a bool; the last of several values counts.
fn download_flag(raw_query: Option<&str>) -> ApiResult<bool> {
    let pairs: Vec<(String, String)> = serde_urlencoded::from_str(raw_query.unwrap_or("")).unwrap_or_default();
    let Some((_, value)) = pairs.iter().rev().find(|(name, _)| name == "download") else {
        return Ok(false);
    };
    match value.to_lowercase().as_str() {
        "1" | "true" | "t" | "yes" | "y" | "on" => Ok(true),
        "0" | "false" | "f" | "no" | "n" | "off" => Ok(false),
        _ => Err(ApiError::validation(
            &["query", "download"],
            "Input should be a valid boolean, unable to interpret input",
            "bool_parsing",
        )),
    }
}

/// The routes of this file.
pub fn routes() -> Routes {
    Routes::new()
        .get("/workspace/settings", get_settings)
        .patch("/workspace/settings", patch_settings)
        .post("/workspace/sweep", sweep)
        .get("/tickets/{ticket_id}/workspace", get_ticket_workspace)
        .patch("/tickets/{ticket_id}/workspace/retention", patch_ticket_workspace_retention)
        .post("/tickets/{ticket_id}/workspace/init", init_workspace)
        .post("/tickets/{ticket_id}/workspace/open", open_workspace)
        .post("/tickets/{ticket_id}/workspace/folders", create_workspace_folder)
        // the form carries a file of up to 50 MB: the body limit of the extractors is lifted, the handler caps what it keeps
        .add(
            "POST",
            "/tickets/{ticket_id}/workspace/files",
            post(upload_workspace_file).layer(DefaultBodyLimit::disable()),
        )
        .get("/tickets/{ticket_id}/workspace/file", get_workspace_file)
        .post("/tickets/{ticket_id}/workspace/move", move_workspace)
        .delete("/tickets/{ticket_id}/workspace/entry", delete_workspace_entry)
}

/// Get the workspace settings.
async fn get_settings() -> ApiResult<Json<workspace_settings::Model>> {
    let session = kb_db::session();
    Ok(Json(workspace::get_workspace_settings(&session).await.map_err(http)?))
}

/// Update the workspace settings.
async fn patch_settings(Body(body): Body<WorkspaceSettingsUpdate>) -> ApiResult<Json<workspace_settings::Model>> {
    let session = kb_db::session();
    let settings = workspace::update_workspace_settings(
        &session,
        body.enabled,
        body.root_path.as_deref(),
        body.default_retention_days,
    )
    .await
    .map_err(http)?;
    events::publish("invalidate", &[]).await;
    Ok(Json(settings))
}

/// Delete (or with `dry_run`, list) expired workspaces.
async fn sweep(Body(body): Body<SweepBody>) -> ApiResult<Json<Value>> {
    let session = kb_db::session();
    let removed = workspace::sweep_expired(&session, body.dry_run).await.map_err(http)?;
    if !removed.is_empty() && !body.dry_run {
        events::publish("invalidate", &[]).await;
    }
    Ok(Json(json!({"dry_run": body.dry_run, "removed": removed})))
}

/// Get a ticket's workspace folder and entries.
async fn get_ticket_workspace(Path(ticket_id): Path<String>) -> ApiResult<Json<Value>> {
    let session = kb_db::session();
    match workspace::get_ticket_workspace(&session, &ticket_id).await.map_err(http)? {
        Some(info) => Ok(Json(info)),
        None => Err(ApiError::not_found("Ticket not found")),
    }
}

/// Set a ticket's workspace retention override.
async fn patch_ticket_workspace_retention(
    Path(ticket_id): Path<String>,
    Body(body): Body<TicketRetentionBody>,
) -> ApiResult<Json<TicketRead>> {
    let session = kb_db::session();
    let ticket =
        workspace::set_ticket_workspace_retention(&session, &ticket_id, body.retention_days).await.map_err(http)?;
    let Some(ticket) = ticket else {
        return Err(ApiError::not_found("Ticket not found"));
    };
    events::publish("invalidate", &[]).await;
    Ok(Json(TicketRead::from_ticket(ticket)?))
}

/// Create a ticket's workspace folder.
async fn init_workspace(Path(ticket_id): Path<String>) -> ApiResult<Json<Value>> {
    let session = kb_db::session();
    let folder = workspace::init_ticket_workspace(&session, &ticket_id).await.map_err(http)?;
    Ok(Json(json!({"path": folder.to_string_lossy(), "exists": true})))
}

/// Open a ticket's workspace folder in the file manager.
async fn open_workspace(Path(ticket_id): Path<String>) -> ApiResult<Json<Value>> {
    let session = kb_db::session();
    let path = workspace::open_in_file_manager(&session, &ticket_id).await.map_err(http)?;
    Ok(Json(json!({"path": path})))
}

/// Create a folder inside a ticket's workspace.
async fn create_workspace_folder(
    Path(ticket_id): Path<String>,
    Body(body): Body<FolderBody>,
) -> ApiResult<Json<Value>> {
    let session = kb_db::session();
    let name = workspace::create_folder(&session, &ticket_id, &body.path).await.map_err(http)?;
    Ok(Json(json!({"name": name})))
}

/// Upload a file into a ticket's workspace.
async fn upload_workspace_file(
    Path(ticket_id): Path<String>,
    multipart: Result<Multipart, MultipartRejection>,
) -> ApiResult<Json<Value>> {
    let parse_error = || ApiError::bad_request("There was an error parsing the body");
    let missing = || ApiError::validation(&["body", "file"], "Field required", "missing");
    let mut multipart = multipart.map_err(|_| missing())?;
    let mut file: Option<(String, Vec<u8>)> = None;
    let mut directory = String::new();
    while let Some(mut field) = multipart.next_field().await.map_err(|_| parse_error())? {
        match field.name() {
            Some("file") if field.file_name().is_some() => {
                let filename = field.file_name().unwrap_or("").to_string();
                // `file.read(MAX_UPLOAD_BYTES + 1)`: what is past the limit is read and dropped
                let mut data: Vec<u8> = Vec::new();
                while let Some(chunk) = field.chunk().await.map_err(|_| parse_error())? {
                    let room = (MAX_UPLOAD_BYTES + 1).saturating_sub(data.len());
                    data.extend_from_slice(&chunk[..chunk.len().min(room)]);
                }
                file = Some((filename, data));
            }
            Some("directory") => directory = field.text().await.map_err(|_| parse_error())?,
            _ => {}
        }
    }
    let Some((filename, data)) = file else {
        return Err(missing());
    };
    let session = kb_db::session();
    let saved = workspace::save_upload(&session, &ticket_id, &directory, &filename, data).await.map_err(http)?;
    Ok(Json(saved))
}

/// Download or preview a file from a ticket's workspace.
async fn get_workspace_file(
    Path(ticket_id): Path<String>,
    Query(query): Query<FileQuery>,
    RawQuery(raw_query): RawQuery,
    method: Method,
    headers: HeaderMap,
) -> ApiResult<Response> {
    let download = download_flag(raw_query.as_deref())?;
    let session = kb_db::session();
    let (target, image_type) = workspace::resolve_file(&session, &ticket_id, &query.path).await.map_err(http)?;
    drop(session);
    const NOSNIFF: &str = "nosniff";
    if download {
        let name = target.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        return Ok(FileResponse::new(&target)
            .filename(&name)
            .media_type("application/octet-stream")
            .header("X-Content-Type-Options", NOSNIFF)
            .respond(&method, &headers)
            .await);
    }
    if !image_type.is_empty() {
        return Ok(FileResponse::new(&target)
            .media_type(image_type)
            .header("X-Content-Type-Options", NOSNIFF)
            .respond(&method, &headers)
            .await);
    }
    let preview = workspace::read_text_preview_async(target).await.map_err(http)?;
    Ok(([("x-content-type-options", NOSNIFF)], Json(preview)).into_response())
}

/// Move (or copy) the ticket's workspace folder to another ticket of the same project.
async fn move_workspace(Path(ticket_id): Path<String>, Body(body): Body<MoveBody>) -> ApiResult<Json<Value>> {
    let session = kb_db::session();
    let mode = match body.mode {
        MoveMode::Move => "move",
        MoveMode::Copy => "copy",
    };
    Ok(Json(workspace::move_to_ticket(&session, &ticket_id, &body.to_ticket_id, mode).await.map_err(http)?))
}

/// Delete a file or folder from a ticket's workspace.
async fn delete_workspace_entry(
    Path(ticket_id): Path<String>,
    Query(query): Query<PathQuery>,
) -> ApiResult<Json<Value>> {
    let session = kb_db::session();
    workspace::delete_entry(&session, &ticket_id, &query.path).await.map_err(http)?;
    Ok(Json(json!({"deleted": query.path})))
}

/// The query of `DELETE .../workspace/entry`.
#[derive(Debug, Deserialize)]
struct PathQuery {
    path: String,
}
