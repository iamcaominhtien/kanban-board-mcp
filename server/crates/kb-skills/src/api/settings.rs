//! `api/settings.py` (prefix `/settings`): the data folder and its move, storage info, MCP client status / install /
//! remove, and the "Full control over MCP" switch.

use std::io;
use std::path::{Path, PathBuf};

use axum::Json;
use kb_base::error::{Body, Path as UrlPath, Query};
use kb_base::{ApiError, ApiResult, Routes, config, pytext};
use kb_db::database as db;
use kb_db::sea_orm::ConnectionTrait;
use kb_files::{pathlib, uploads};
use serde::Deserialize;
use serde_json::{Value, json};

use crate::hooks;
use crate::mcp_clients::{self, Failure};

/// The routes of this file (a `/settings` router with no prefix on the handlers, so each path is written whole).
pub fn routes() -> Routes {
    Routes::new()
        .get("/settings", get_settings)
        .get("/settings/mcp-control", get_mcp_control)
        .post("/settings/mcp-control", set_mcp_control)
        .post("/settings/data-path", set_data_path)
        .get("/settings/mcp-clients/{client_id}", get_mcp_client)
        .post("/settings/mcp-clients/{client_id}/install", install_mcp_client)
        .post("/settings/mcp-clients/{client_id}/remove", remove_mcp_client)
        .post("/settings/mcp-clients/{client_id}/test", test_mcp_client)
        .post("/settings/mcp-clients/{client_id}/open-file", open_mcp_config)
}

/// Request body for changing the data folder.
#[derive(Debug, Deserialize)]
struct DataPathRequest {
    /// Absolute path to the new data folder.
    path: String,
}

/// Request body for the "Full control over MCP" switch.
#[derive(Debug, Deserialize)]
struct McpControlRequest {
    enabled: bool,
    /// Turning it on needs the person to confirm in the dialog.
    #[serde(default)]
    accept_risks: bool,
}

/// Scope and folder identifying where an MCP client config lives.
#[derive(Debug, Deserialize)]
struct McpTarget {
    #[serde(default)]
    scope: Option<String>,
    #[serde(default)]
    folder: Option<String>,
}

/// The query string of `GET /settings/mcp-clients/{client_id}`.
#[derive(Debug, Deserialize)]
struct ClientQuery {
    #[serde(default)]
    scope: Option<String>,
    #[serde(default)]
    folder: Option<String>,
}

/// `str(path)` of a path that may have no folder part (`Path("kanban.db").parent` is `.`).
fn parent_text(path: &Path) -> String {
    match path.parent() {
        Some(parent) if !parent.as_os_str().is_empty() => parent.display().to_string(),
        _ => ".".to_string(),
    }
}

/// Return current data folder and uploads folder paths.
async fn get_settings() -> Json<Value> {
    let db_path = db::get_db_path();
    let uploads_dir = uploads::get_uploads_dir(false);
    Json(json!({
        "db_path": db_path.display().to_string(),
        "data_folder": parent_text(&db_path),
        "uploads_dir": uploads_dir.display().to_string(),
    }))
}

/// Whether MCP clients may act on the AI team with a person's full rights.
async fn get_mcp_control() -> Json<Value> {
    Json(json!({"enabled": config::get_flag(config::MCP_FULL_CONTROL)}))
}

/// Turn "Full control over MCP" on (only with `accept_risks`) or off.
async fn set_mcp_control(Body(req): Body<McpControlRequest>) -> ApiResult<Json<Value>> {
    if req.enabled && !req.accept_risks {
        return Err(ApiError::bad_request("Confirm that you accept the risks to turn on full control over MCP."));
    }
    config::set_flag(config::MCP_FULL_CONTROL, req.enabled).map_err(ApiError::internal)?;
    tracing::warn!(target: "api.settings", "MCP full control turned {}", if req.enabled { "on" } else { "off" });
    Ok(Json(json!({"enabled": req.enabled})))
}

/// `os.environ[name] = value` for the uploads folder: `uploads::resolve_uploads_dir` reads it first, so the folder
/// the app serves follows the move at once.
fn set_uploads_env(value: &Path) {
    uploads::set_uploads_dir_env(value);
}

/// `shutil.move(src, dst)`: a rename, or a copy and delete across file systems; a folder `dst` takes `src` inside it.
fn shutil_move(src: &Path, dst: &Path) -> io::Result<()> {
    let mut real_dst = dst.to_path_buf();
    if dst.is_dir() {
        real_dst = dst.join(src.file_name().unwrap_or_default());
        if real_dst.exists() {
            return Err(io::Error::new(
                io::ErrorKind::AlreadyExists,
                format!("Destination path '{}' already exists", real_dst.display()),
            ));
        }
    }
    if std::fs::rename(src, &real_dst).is_ok() {
        return Ok(());
    }
    let meta = std::fs::symlink_metadata(src)?;
    if meta.is_dir() {
        copy_tree(src, &real_dst)?;
        std::fs::remove_dir_all(src)
    } else {
        copy_entry(src, &real_dst)?;
        std::fs::remove_file(src)
    }
}

/// `shutil.copy2` / `os.symlink` for one entry of a copy.
fn copy_entry(src: &Path, dst: &Path) -> io::Result<()> {
    let meta = std::fs::symlink_metadata(src)?;
    if meta.file_type().is_symlink() {
        let target = std::fs::read_link(src)?;
        #[cfg(unix)]
        return std::os::unix::fs::symlink(target, dst);
        #[cfg(not(unix))]
        return std::fs::copy(src, dst).map(|_| ());
    }
    std::fs::copy(src, dst)?;
    if let Ok(modified) = meta.modified() {
        std::fs::File::options().write(true).open(dst).and_then(|f| f.set_modified(modified)).ok();
    }
    Ok(())
}

/// `shutil.copytree(src, dst, symlinks=True)`.
fn copy_tree(src: &Path, dst: &Path) -> io::Result<()> {
    std::fs::create_dir(dst)?;
    for item in std::fs::read_dir(src)? {
        let item = item?;
        let to = dst.join(item.file_name());
        if item.file_type()?.is_dir() {
            copy_tree(&item.path(), &to)?;
        } else {
            copy_entry(&item.path(), &to)?;
        }
    }
    if let Ok(meta) = std::fs::metadata(src) {
        std::fs::set_permissions(dst, meta.permissions()).ok();
    }
    Ok(())
}

/// Move kanban.db and uploads/ to a new folder.
/// 1. Resolve and validate the path is absolute.
/// 2. Move kanban.db to new_folder/kanban.db.
/// 3. Move uploads/ to new_folder/uploads/.
/// 4. Persist new folder to config.
/// 5. Reinit DB engine.
async fn set_data_path(Body(req): Body<DataPathRequest>) -> ApiResult<Json<Value>> {
    let raw = pytext::strip(&req.path);
    if raw.is_empty() {
        return Err(ApiError::bad_request("Path must not be empty"));
    }

    // `os.path.realpath` resolves symlinks and `..` before the check, and the check is a prefix test on the text
    let home_str = pathlib::resolve(&config::home_dir()).display().to_string();
    let resolved = if raw.contains('\0') { PathBuf::from(raw) } else { pathlib::resolve(Path::new(raw)) };
    let resolved_str = resolved.display().to_string();

    let sep = std::path::MAIN_SEPARATOR;
    let home_root = format!("{}{sep}", home_str.trim_end_matches(sep));
    if !resolved_str.starts_with(&home_root) {
        return Err(ApiError::bad_request("Data folder must be within your home directory"));
    }

    // All subsequent operations use the validated, fully-resolved path.
    let new_folder = resolved;
    std::fs::create_dir_all(&new_folder).map_err(ApiError::internal)?;

    let old_db_path = db::get_db_path();
    let new_db_check = new_folder.join("kanban.db");
    let current_db_check = old_db_path.clone();
    if new_db_check.exists()
        && std::fs::metadata(&new_db_check).map(|m| m.len() > 0).unwrap_or(false)
        && current_db_check != new_db_check
    {
        return Err(ApiError::conflict(format!(
            "A database already exists at {}. Remove it first or choose a different folder.",
            new_db_check.display()
        )));
    }
    let old_uploads = uploads::get_uploads_dir(false);
    let old_config_folder = config::get_data_folder();

    let current_db = old_db_path.clone();
    let current_uploads = old_uploads.clone();

    let new_db = new_folder.join("kanban.db");
    let new_uploads = new_folder.join("uploads");

    let moved: Result<(), String> = async {
        // Not in the Python code: fold the write-ahead log into the file first. SQLite does not checkpoint a database
        // that was renamed while open, so changes still in `kanban.db-wal` would stay behind and be lost.
        if db::is_sqlite() {
            let _ = db::conn().execute_unprepared("PRAGMA wal_checkpoint(FULL)").await;
        }

        // Move DB file
        if current_db.exists() && current_db != new_db {
            shutil_move(&current_db, &new_db).map_err(|e| e.to_string())?;
        }

        // Move uploads dir
        if current_uploads.exists() && current_uploads != new_uploads {
            if new_uploads.exists() {
                for item in std::fs::read_dir(&current_uploads).map_err(|e| e.to_string())? {
                    let item = item.map_err(|e| e.to_string())?;
                    shutil_move(&item.path(), &new_uploads.join(item.file_name())).map_err(|e| e.to_string())?;
                }
                let _ = std::fs::remove_dir_all(&current_uploads);
            } else {
                shutil_move(&current_uploads, &new_uploads).map_err(|e| e.to_string())?;
            }
        }

        // Update KANBAN_UPLOADS_DIR env var in process
        set_uploads_env(&new_uploads);

        // Persist config
        config::set_data_folder(&new_folder).map_err(|e| e.to_string())?;

        // Reinit DB to point to new location
        db::reinit_db(Some(new_db.clone())).await.map_err(|e| e.to_string())
    }
    .await;

    if moved.is_err() {
        // Best-effort rollback
        let rolled: Result<(), String> = async {
            if new_db.exists() && !old_db_path.exists() {
                shutil_move(&new_db, &old_db_path).map_err(|e| e.to_string())?;
            }
            if new_uploads.exists() && !old_uploads.exists() {
                shutil_move(&new_uploads, &old_uploads).map_err(|e| e.to_string())?;
            }
            if let Some(folder) = &old_config_folder {
                config::set_data_folder(folder).map_err(|e| e.to_string())?;
            }
            set_uploads_env(&old_uploads);
            db::reinit_db(Some(old_db_path.clone())).await.map_err(|e| e.to_string())
        }
        .await;
        if let Err(err) = rolled {
            tracing::error!(target: "api.settings", "Rollback failed during data folder move: {err}");
        }
        return Err(ApiError::code(500, "Failed to move data folder. Attempted rollback."));
    }

    Ok(Json(json!({
        "db_path": new_db.display().to_string(),
        "data_folder": new_folder.display().to_string(),
        "uploads_dir": new_uploads.display().to_string(),
        "warning": "If you use VS Code MCP integration, restart the MCP server to pick up the new data path.",
    })))
}

/// `_tool_count()`.
async fn tool_count() -> usize {
    hooks::tool_count().await
}

/// `_mcp_call`: a `BadRequest` is a 400; anything else is a 500.
fn mcp_call(result: Result<Value, Failure>) -> ApiResult<Json<Value>> {
    match result {
        Ok(value) => Ok(Json(value)),
        Err(failure) => Err(failure_to_error(failure)),
    }
}

fn failure_to_error(failure: Failure) -> ApiError {
    match failure {
        Failure::BadRequest(message) => ApiError::bad_request(message),
        Failure::Internal(message) => ApiError::internal(message),
    }
}

/// State of the kanban entry in Claude Code / Antigravity for one scope.
async fn get_mcp_client(UrlPath(client_id): UrlPath<String>, Query(q): Query<ClientQuery>) -> ApiResult<Json<Value>> {
    let count = tool_count().await;
    mcp_call(mcp_clients::get_status(&client_id, q.scope.as_deref(), q.folder.as_deref(), count))
}

/// Add (or replace) the kanban entry. Expected failures are returned as `error` on the status.
async fn install_mcp_client(
    UrlPath(client_id): UrlPath<String>,
    Body(target): Body<McpTarget>,
) -> ApiResult<Json<Value>> {
    let count = tool_count().await;
    mcp_call(mcp_clients::install(&client_id, target.scope.as_deref(), target.folder.as_deref(), count).await)
}

/// Remove only the kanban entry.
async fn remove_mcp_client(
    UrlPath(client_id): UrlPath<String>,
    Body(target): Body<McpTarget>,
) -> ApiResult<Json<Value>> {
    let count = tool_count().await;
    mcp_call(mcp_clients::remove(&client_id, target.scope.as_deref(), target.folder.as_deref(), count).await)
}

fn unknown_client(client_id: &str) -> ApiError {
    ApiError::not_found(format!("Unknown MCP client '{client_id}'"))
}

/// Start the installed server and list its tools.
async fn test_mcp_client(UrlPath(client_id): UrlPath<String>, Body(target): Body<McpTarget>) -> ApiResult<Json<Value>> {
    if client_id != "claude-code" && client_id != "antigravity" {
        return Err(unknown_client(&client_id));
    }
    mcp_call(mcp_clients::test_connection(&client_id, target.scope.as_deref(), target.folder.as_deref()).await)
}

/// Open the client's config file in the default editor.
async fn open_mcp_config(UrlPath(client_id): UrlPath<String>, Body(target): Body<McpTarget>) -> ApiResult<Json<Value>> {
    if client_id != "claude-code" && client_id != "antigravity" {
        return Err(unknown_client(&client_id));
    }
    let path = mcp_clients::config_file(&client_id, target.scope.as_deref(), target.folder.as_deref())
        .map_err(failure_to_error)?;
    mcp_clients::open_file(&path).map_err(failure_to_error)?;
    Ok(Json(json!({"path": path.display().to_string()})))
}
