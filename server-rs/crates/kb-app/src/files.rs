//! The routes `main.py` defines itself: the draw.io editor, the uploaded files, and the built UI.

use std::path::PathBuf;
use std::sync::Mutex;

use axum::extract::Query as AxumQuery;
use axum::http::{HeaderMap, Method};
use axum::response::Response;
use axum::routing::get;
use axum::{Json, extract::rejection::QueryRejection};
use serde_json::{Value, json};

use kb_base::error::Path;
use kb_base::{ApiError, ApiResult, Routes};
use kb_files::file_response::{internal_server_error, redirect};
use kb_files::{FileResponse, drawio_bundle, file_response, pathlib, uploads};

/// Set here, not by the platform's registry (Windows can map .js to text/plain)
const DRAWIO_TYPES: [(&str, &str); 14] = [
    (".html", "text/html"),
    (".js", "text/javascript"),
    (".css", "text/css"),
    (".json", "application/json"),
    (".svg", "image/svg+xml"),
    (".png", "image/png"),
    (".gif", "image/gif"),
    (".jpg", "image/jpeg"),
    (".ico", "image/x-icon"),
    (".txt", "text/plain; charset=utf-8"),
    (".xml", "application/xml"),
    (".woff", "font/woff"),
    (".woff2", "font/woff2"),
    (".ttf", "font/ttf"),
];

/// `GET /drawio`: the shipped draw.io editor lives under its folder (its own files are named relative to it).
async fn drawio_root() -> Response {
    redirect(&format!("{}/", drawio_bundle::PATH))
}

/// `GET /drawio/{file_path:path}`: a file of the draw.io editor shipped with the app.
async fn drawio_file(file_path: &str, method: &Method, headers: &HeaderMap) -> ApiResult<Response> {
    let Some(folder) = drawio_bundle::directory() else {
        return Err(ApiError::not_found("No draw.io editor in this install"));
    };
    let requested = if file_path.is_empty() { "index.html" } else { file_path };
    // Python raises ValueError for a NUL character in a path, which nothing catches here
    if requested.contains('\0') {
        return Ok(internal_server_error());
    }
    let mut target = pathlib::resolve(&folder.join(requested));
    if target.is_dir() {
        target = target.join("index.html");
    }
    if !target.starts_with(&folder) || !target.is_file() {
        return Err(ApiError::not_found("Not found"));
    }
    let suffix = pathlib::suffix(&target.to_string_lossy()).to_lowercase();
    let mut response = FileResponse::new(&target).header("Cache-Control", "public, max-age=3600");
    if let Some((_, media_type)) = DRAWIO_TYPES.iter().find(|(ext, _)| *ext == suffix) {
        response = response.media_type(media_type);
    }
    Ok(response.respond(method, headers).await)
}

async fn serve_drawio(Path(file_path): Path<String>, method: Method, headers: HeaderMap) -> ApiResult<Response> {
    drawio_file(&file_path, &method, &headers).await
}

async fn serve_drawio_index(method: Method, headers: HeaderMap) -> ApiResult<Response> {
    drawio_file("", &method, &headers).await
}

/// The draw.io routes, which `main.py` registers before the areas' routers (neither is in the OpenAPI schema).
pub fn drawio_routes() -> Routes {
    // `/drawio/` is a path of its own for axum (a catch-all needs one character); for Starlette `{file_path:path}`
    // matches an empty one
    Routes::new()
        .hidden(drawio_bundle::PATH, get(drawio_root))
        .hidden(&format!("{}/", drawio_bundle::PATH), get(serve_drawio_index))
        .hidden(&format!("{}/{{file_path:path}}", drawio_bundle::PATH), get(serve_drawio))
}

/// `GET /upload-info/{file_path:path}`: where an uploaded file is stored on this computer, for the desktop app's
/// "Open in app".
async fn upload_info_for(file_path: &str) -> ApiResult<Json<Value>> {
    let Some(resolved) = uploads::resolve_upload_path(file_path) else {
        return Err(ApiError::bad_request("Invalid path"));
    };
    if !resolved.is_file() {
        return Err(ApiError::not_found("File not found"));
    }
    let size = std::fs::metadata(&resolved)?.len();
    let name = resolved.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    Ok(Json(json!({
        "path": pathlib::resolve(&resolved).to_string_lossy(),
        "name": name,
        "size": size,
    })))
}

async fn upload_info(Path(file_path): Path<String>) -> ApiResult<Json<Value>> {
    upload_info_for(&file_path).await
}

async fn upload_info_root() -> ApiResult<Json<Value>> {
    upload_info_for("").await
}

/// The query of `GET /uploads/...`: `name`, `download`, `inline` and `view`.
#[derive(Default)]
struct UploadQuery {
    name: Option<String>,
    download: bool,
    inline: bool,
    view: bool,
}

/// A `bool` query parameter as FastAPI reads it (Pydantic's strings for true and false; anything else is a 422).
#[allow(clippy::result_large_err)] // `ApiError` is the foundation's error type
fn bool_param(pairs: &[(String, String)], name: &str) -> ApiResult<bool> {
    // the last value wins, as in Starlette's `QueryParams.get`
    let Some((_, value)) = pairs.iter().rev().find(|(key, _)| key == name) else { return Ok(false) };
    match value.to_ascii_lowercase().as_str() {
        "1" | "on" | "t" | "true" | "y" | "yes" => Ok(true),
        "0" | "off" | "f" | "false" | "n" | "no" => Ok(false),
        _ => Err(ApiError::new(
            axum::http::StatusCode::UNPROCESSABLE_ENTITY,
            json!([{
                "type": "bool_parsing",
                "loc": ["query", name],
                "msg": "Input should be a valid boolean, unable to interpret input",
                "input": value,
            }]),
        )),
    }
}

impl UploadQuery {
    #[allow(clippy::result_large_err)] // `ApiError` is the foundation's error type
    fn parse(query: Result<AxumQuery<Vec<(String, String)>>, QueryRejection>) -> ApiResult<Self> {
        let pairs = query.map(|AxumQuery(pairs)| pairs).unwrap_or_default();
        Ok(Self {
            name: pairs.iter().rev().find(|(key, _)| key == "name").map(|(_, value)| value.clone()),
            download: bool_param(&pairs, "download")?,
            inline: bool_param(&pairs, "inline")?,
            view: bool_param(&pairs, "view")?,
        })
    }
}

/// `GET /uploads/{file_path:path}`: an uploaded file inline (images, viewable types) or as a download.
async fn upload_file(
    file_path: &str,
    query: UploadQuery,
    method: &Method,
    request_headers: &HeaderMap,
) -> ApiResult<Response> {
    let Some(resolved) = uploads::resolve_upload_path(file_path) else {
        return Err(ApiError::bad_request("Invalid path"));
    };
    if !resolved.is_file() {
        return Err(ApiError::not_found("File not found"));
    }
    let local_path = pathlib::resolve(&resolved).to_string_lossy().into_owned();
    let resolved_text = resolved.to_string_lossy().into_owned();
    let resolved_name = resolved.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let ext = pathlib::suffix(&resolved_text).to_lowercase();
    let media_type = uploads::mime_by_extension(&ext).unwrap_or("application/octet-stream");

    let download_name: String = pathlib::name(&query.name.unwrap_or_default().replace('\\', "/"))
        .chars()
        .filter(|c| pathlib::is_printable(*c))
        .take(200)
        .collect();
    let download_name = if download_name.is_empty() { resolved_name } else { download_name };

    let is_image = uploads::is_supported_image(&ext);
    let wants_inline = (query.inline || query.view) && uploads::is_viewable_inline(&ext) && ext != ".html";

    let mut headers: Vec<(&str, String)> = vec![("X-Content-Type-Options", "nosniff".to_string())];
    // A header can only carry latin-1; a folder such as C:\Users\Tiến would crash the response. The desktop app asks
    // GET /upload-info/... for the path instead.
    if local_path.chars().all(|c| u32::from(c) < 256) {
        headers.push(("X-File-Path", local_path));
    }
    if ext == ".svg" {
        // An SVG is a picture, never a page: if it is opened on its own, nothing in it can run or load
        headers.push(("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; sandbox".to_string()));
    }

    let mut response = FileResponse::new(&resolved);
    for (name, value) in &headers {
        response = response.header(name, value);
    }
    if !query.download && (is_image || wants_inline) {
        return Ok(response.media_type(media_type).respond(method, request_headers).await);
    }
    Ok(response
        .media_type("application/octet-stream")
        .filename(&download_name)
        .content_disposition_type("attachment")
        .respond(method, request_headers)
        .await)
}

async fn serve_upload(
    Path(file_path): Path<String>,
    query: Result<AxumQuery<Vec<(String, String)>>, QueryRejection>,
    method: Method,
    headers: HeaderMap,
) -> ApiResult<Response> {
    upload_file(&file_path, UploadQuery::parse(query)?, &method, &headers).await
}

async fn serve_upload_root(
    query: Result<AxumQuery<Vec<(String, String)>>, QueryRejection>,
    method: Method,
    headers: HeaderMap,
) -> ApiResult<Response> {
    upload_file("", UploadQuery::parse(query)?, &method, &headers).await
}

/// The routes `main.py` registers after the areas' routers and before the UI: `/upload-info` and `/uploads`.
pub fn upload_routes() -> Routes {
    Routes::new()
        .get("/upload-info/{file_path:path}", upload_info)
        .hidden("/upload-info/", get(upload_info_root))
        .get("/uploads/{file_path:path}", serve_upload)
        .hidden("/uploads/", get(serve_upload_root))
}

// ---------------------------------------------------------------------------
// Static UI serving (used by packaged Electron builds)
// ---------------------------------------------------------------------------

/// The first built UI found, kept (the Python server keeps it too; none found is looked for again).
static UI_DIST_DIR: Mutex<Option<PathBuf>> = Mutex::new(None);

/// The folder of the built UI: `KANBAN_UI_DIST`, or `ui/dist` of the checkout.
fn get_ui_dist() -> Option<PathBuf> {
    let mut cached = UI_DIST_DIR.lock().unwrap_or_else(|e| e.into_inner());
    if cached.is_some() {
        return cached.clone();
    }
    let env_val = std::env::var("KANBAN_UI_DIST").unwrap_or_default();
    if !env_val.is_empty() {
        let candidate = PathBuf::from(&env_val);
        if candidate.is_dir() {
            *cached = Some(pathlib::resolve(&candidate));
            return cached.clone();
        }
    }
    let candidate = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../ui/dist");
    if candidate.is_dir() {
        *cached = Some(pathlib::resolve(&candidate));
        return cached.clone();
    }
    None
}

/// `GET /`: the built UI's index page.
async fn serve_root(method: Method, headers: HeaderMap) -> ApiResult<Response> {
    if let Some(dist) = get_ui_dist() {
        let index = dist.join("index.html");
        if index.is_file() {
            return Ok(FileResponse::new(index).media_type("text/html").respond(&method, &headers).await);
        }
    }
    Err(ApiError::not_found("UI not built"))
}

/// `GET /{full_path:path}`: a built UI asset, falling back to the SPA index for client routes.
async fn spa_file(full_path: &str, method: &Method, headers: &HeaderMap) -> ApiResult<Response> {
    let Some(dist) = get_ui_dist() else { return Err(ApiError::not_found("UI not built")) };
    // Canonicalize and enforce that requested path stays within the UI dist directory
    let dist_resolved = pathlib::resolve(&dist);
    if pathlib::is_absolute(full_path) {
        return Err(ApiError::bad_request("Invalid path"));
    }
    let safe_parts = pathlib::parts(full_path);
    if safe_parts.contains(&"..") {
        return Err(ApiError::bad_request("Invalid path"));
    }
    // Python raises ValueError for a NUL character in a path, which nothing catches here
    if full_path.contains('\0') {
        return Ok(internal_server_error());
    }
    let mut joined = dist_resolved.clone();
    joined.extend(&safe_parts);
    let requested = pathlib::resolve(&joined);
    if !requested.starts_with(&dist_resolved) {
        return Err(ApiError::bad_request("Invalid path"));
    }
    if requested.is_file() {
        return Ok(file_response(requested, method, headers).await);
    }
    let index = dist.join("index.html");
    if index.is_file() {
        return Ok(FileResponse::new(index).media_type("text/html").respond(method, headers).await);
    }
    Err(ApiError::not_found("Not found"))
}

async fn serve_spa(Path(full_path): Path<String>, method: Method, headers: HeaderMap) -> ApiResult<Response> {
    spa_file(&full_path, &method, &headers).await
}

/// The static UI: `GET /` and the catch-all, registered last so every other route wins.
pub fn ui_routes() -> Routes {
    Routes::new().get("/", serve_root).get("/{full_path:path}", serve_spa)
}
