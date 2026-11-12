//! `api/canvases.py`: canvas routes of this half: the canvas itself, its frames, locks, versions, downloads and
//! pictures. Writes that carry files are multipart (or urlencoded, as FastAPI reads a form); the plane itself
//! (layout) is JSON and merges per item. Errors use the Docs error shape `{detail: {code, message, ...}}`. The files
//! of a frame are served as they are (an open web page: no policy, no sandbox).
//!
//! The comment routes (the last seven of the Python file) are in `comments.rs`, registered after these.

use std::collections::HashMap;

use axum::Json;
use axum::extract::multipart::Multipart;
use axum::extract::{DefaultBodyLimit, FromRequest, RawQuery, Request};
use axum::http::{HeaderMap, HeaderName, HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, patch, post, put};
use kb_base::error::{Body, Path};
use kb_base::{ApiError, ApiResult, Routes, events};
use serde::Deserialize;
use serde_json::{Map, Value, json};

use super::{docs_error, query_int, query_pairs, query_required};

pub mod comments;
use crate::canvases::boards::{self, AddBoard, PutContent};
use crate::canvases::content::{Files, put_file};
use crate::canvases::rows::{NewCanvas, Size};
use crate::canvases::save::SaveArgs;
use crate::canvases::{self as svc, MAX_CANVAS_BYTES};

/// The routes of this file.
pub fn routes() -> Routes {
    // forms and sources carry whole frames (up to 5 MB each, 50 MB a canvas): the body limit of the extractors is lifted
    let unlimited = || DefaultBodyLimit::disable();
    Routes::new()
        .get("/canvases", get_canvases)
        .add("POST", "/canvases", post(post_canvas).layer(unlimited()))
        .add("POST", "/canvases/pages", post(post_canvas_page).layer(unlimited()))
        .get("/canvases/{canvas_id}", get_canvas)
        .add("PATCH", "/canvases/{canvas_id}", patch(patch_canvas).layer(unlimited()))
        .delete("/canvases/{canvas_id}", del_canvas)
        .post("/canvases/{canvas_id}/restore", post_restore_canvas)
        .add("POST", "/canvases/{canvas_id}/move-to-docs", post(post_move_to_docs).layer(unlimited()))
        .post("/canvases/{canvas_id}/copy", post_copy)
        .add("POST", "/canvases/{canvas_id}/boards", post(post_board).layer(unlimited()))
        .add("POST", "/canvases/{canvas_id}/import", post(post_import).layer(unlimited()))
        .post("/canvases/{canvas_id}/boards/{board_id}/duplicate", post_duplicate)
        .get("/canvases/{canvas_id}/boards/{board_id}/source", get_source)
        .add("PUT", "/canvases/{canvas_id}/boards/{board_id}/content", put(put_content).layer(unlimited()))
        .add("POST", "/canvases/{canvas_id}/boards/{board_id}/replace", post(post_replace).layer(unlimited()))
        .post("/canvases/{canvas_id}/boards/{board_id}/lock", post_lock)
        .post("/canvases/{canvas_id}/boards/{board_id}/heartbeat", post_heartbeat)
        .add("DELETE", "/canvases/{canvas_id}/boards/{board_id}/lock", delete(del_lock))
        .get("/canvases/{canvas_id}/boards/{board_id}/r/{rev}/{path:path}", get_board_file)
        .get("/canvases/{canvas_id}/boards/{board_id}/snapshot.png", get_snapshot)
        .get("/canvases/{canvas_id}/overview.png", get_overview)
        .get("/canvases/{canvas_id}/download", get_download)
        .get("/canvases/{canvas_id}/versions", get_versions)
        .add("POST", "/canvases/{canvas_id}/versions", post(post_version).layer(unlimited()))
        .get("/canvases/{canvas_id}/compare", get_compare)
        .get("/canvases/{canvas_id}/boards/{board_id}/source-diff", get_source_diff)
        .get("/canvases/{canvas_id}/versions/{n}", get_version)
        .add("PATCH", "/canvases/{canvas_id}/versions/{n}", patch(patch_version).layer(unlimited()))
        .post("/canvases/{canvas_id}/versions/{n}/restore", post_restore_version)
        // the comments: the last routes of the Python file
        .merge(comments::routes())
}

/// A frame's files are open web pages (scripts, CDN links and fonts all run, as when the file is opened in a browser):
/// no Content-Security-Policy and no `sandbox`, here or on the iframe.
const FRAME_HEADERS: [(&str, &str); 3] = [
    ("x-content-type-options", "nosniff"),
    ("access-control-allow-origin", "*"),
    ("cache-control", "private, max-age=31536000, immutable"),
];

type Reply = ApiResult<Json<Value>>;

fn json(map: Map<String, Value>) -> Json<Value> {
    Json(Value::Object(map))
}

fn list(items: Vec<Map<String, Value>>) -> Json<Value> {
    Json(Value::Array(items.into_iter().map(Value::Object).collect()))
}

/// `await _changed()`.
async fn changed() {
    events::publish("invalidate", &[]).await;
}

fn missing(names: &[&str], place: &str) -> ApiError {
    let list: Vec<Value> =
        names.iter().map(|n| json!({"type": "missing", "loc": [place, n], "msg": "Field required"})).collect();
    ApiError::new(StatusCode::UNPROCESSABLE_ENTITY, Value::Array(list))
}

/// A form as FastAPI reads it: the text fields (a repeated one keeps every value; an empty text counts as left out) and
/// the files, each cut one byte past the largest possible canvas so a huge file is refused cheaply.
#[derive(Default)]
struct Form {
    fields: HashMap<String, Vec<String>>,
    files: Vec<(String, Option<String>, Vec<u8>)>,
}

impl Form {
    async fn read(req: Request) -> Form {
        let mut form = Form::default();
        let content_type =
            req.headers().get(header::CONTENT_TYPE).and_then(|v| v.to_str().ok()).unwrap_or("").trim().to_lowercase();
        if content_type.starts_with("multipart/form-data") {
            let Ok(mut multipart) = Multipart::from_request(req, &()).await else { return form };
            while let Ok(Some(mut field)) = multipart.next_field().await {
                let Some(name) = field.name().map(str::to_string) else { continue };
                if let Some(file_name) = field.file_name().map(str::to_string) {
                    let mut data: Vec<u8> = Vec::new();
                    while let Ok(Some(chunk)) = field.chunk().await {
                        let room = (MAX_CANVAS_BYTES + 1).saturating_sub(data.len());
                        data.extend_from_slice(&chunk[..chunk.len().min(room)]);
                    }
                    form.files.push((name, Some(file_name), data));
                } else if let Ok(text) = field.text().await {
                    form.fields.entry(name).or_default().push(text);
                }
            }
        } else if content_type.starts_with("application/x-www-form-urlencoded") {
            if let Ok(bytes) = axum::body::to_bytes(req.into_body(), 1 << 30).await {
                if let Ok(pairs) = serde_urlencoded::from_bytes::<Vec<(String, String)>>(&bytes) {
                    for (k, v) in pairs {
                        form.fields.entry(k).or_default().push(v);
                    }
                }
            }
        }
        form
    }

    /// A `str` form field: the last value; empty is left out.
    fn text(&self, name: &str) -> Option<String> {
        self.fields.get(name).and_then(|v| v.last()).filter(|v| !v.is_empty()).cloned()
    }

    /// A `list[str]` form field.
    fn texts(&self, name: &str) -> Vec<String> {
        self.fields.get(name).cloned().unwrap_or_default()
    }

    /// An `Optional[float]` form field.
    fn float(&self, name: &str) -> ApiResult<Option<f64>> {
        let Some(raw) = self.text(name) else { return Ok(None) };
        match kb_base::pytext::strip(&raw).parse::<f64>() {
            Ok(v) if v.is_finite() || raw.to_lowercase().contains("inf") || raw.to_lowercase().contains("nan") => {
                Ok(Some(v))
            }
            _ => Err(ApiError::validation(
                &["body", name],
                "Input should be a valid number, unable to parse string as a number",
                "float_parsing",
            )),
        }
    }

    /// An `Optional[int]` form field.
    fn int(&self, name: &str) -> ApiResult<Option<i64>> {
        let Some(raw) = self.text(name) else { return Ok(None) };
        kb_base::pytext::strip(&raw).parse::<i64>().map(Some).map_err(|_| {
            ApiError::validation(
                &["body", name],
                "Input should be a valid integer, unable to parse string as an integer",
                "int_parsing",
            )
        })
    }

    /// `_files(uploads, paths)`: `{path: bytes}` of the files named `field`; `paths` (same order) override the file
    /// names (folders).
    fn files_named(&self, field: &str, paths: &[String]) -> Files {
        let mut out: Files = Vec::new();
        for (i, (_, file_name, data)) in self.files.iter().filter(|(n, _, _)| n == field).enumerate() {
            let name = match paths.get(i).filter(|p| !p.is_empty()) {
                Some(p) => p.clone(),
                None => file_name.clone().filter(|n| !n.is_empty()).unwrap_or_else(|| format!("file{i}")),
            };
            put_file(&mut out, name, data.clone());
        }
        out
    }

    fn has_files(&self, field: &str) -> bool {
        self.files.iter().any(|(n, _, _)| n == field)
    }
}

// --- canvases ---------------------------------------------------------------------------------------------------

/// List the canvases of one page, ticket, idea or comment's ticket.
async fn get_canvases(headers: HeaderMap, RawQuery(query): RawQuery) -> Reply {
    let pairs = query_pairs(query.as_deref());
    let (kind, id) = (query_required(&pairs, "owner_kind"), query_required(&pairs, "owner_id"));
    let (kind, id) = match (kind, id) {
        (Ok(k), Ok(i)) => (k, i),
        (k, i) => {
            let names: Vec<&str> = [("owner_kind", k.is_err()), ("owner_id", i.is_err())]
                .iter()
                .filter(|(_, bad)| *bad)
                .map(|(n, _)| *n)
                .collect();
            return Err(missing(&names, "query"));
        }
    };
    let session = kb_db::session();
    Ok(list(svc::rows::list_canvases(&session, &kind, &id).await.map_err(|e| docs_error(&headers, e))?))
}

/// A new canvas.
#[derive(Debug, Deserialize)]
struct NewCanvasBody {
    owner_kind: String,
    owner_id: String,
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    project_id: Option<String>,
    #[serde(default = "blank")]
    start: String,
    #[serde(default = "desktop")]
    size: String,
}

fn blank() -> String {
    "blank".into()
}

fn desktop() -> String {
    "desktop".into()
}

/// Create a canvas for a ticket, comment, Docs page or idea (one empty frame, or none for "from files").
async fn post_canvas(headers: HeaderMap, Body(body): Body<NewCanvasBody>) -> ApiResult<(StatusCode, Json<Value>)> {
    let session = kb_db::session();
    let size = if svc::size_preset(&body.size).is_some() { body.size.clone() } else { "desktop".into() };
    let out = svc::rows::create_canvas(
        &session,
        NewCanvas {
            owner_kind: &body.owner_kind,
            owner_id: &body.owner_id,
            title: body.title.as_deref(),
            project_id: body.project_id.as_deref(),
            page_id: None,
            start: &body.start,
            size: Size::Preset(size),
        },
    )
    .await
    .map_err(|e| docs_error(&headers, e))?;
    changed().await;
    Ok((StatusCode::CREATED, json(out)))
}

/// Docs > New page > Canvas.
#[derive(Debug, Deserialize)]
struct NewCanvasPage {
    project_id: String,
    #[serde(default = "canvas_title")]
    title: String,
    #[serde(default)]
    parent_id: Option<String>,
}

fn canvas_title() -> String {
    "Canvas".into()
}

/// A Docs page of kind `canvas` with its canvas.
async fn post_canvas_page(headers: HeaderMap, Body(body): Body<NewCanvasPage>) -> ApiResult<(StatusCode, Json<Value>)> {
    let session = kb_db::session();
    let out = svc::docs::create_docs_canvas(&session, &body.project_id, &body.title, body.parent_id.as_deref())
        .await
        .map_err(|e| docs_error(&headers, e))?;
    changed().await;
    Ok((StatusCode::CREATED, json(out)))
}

/// The canvas with its file, locks and counts.
async fn get_canvas(headers: HeaderMap, Path(canvas_id): Path<String>) -> Reply {
    let session = kb_db::session();
    Ok(json(svc::rows::get_canvas(&session, &canvas_id).await.map_err(|e| docs_error(&headers, e))?))
}

/// Layout changes merged per item.
#[derive(Debug, Deserialize)]
struct UpsertBody {
    base_rev: i64,
    #[serde(default)]
    upsert: Map<String, Value>,
    #[serde(default)]
    remove: Vec<String>,
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    force: bool,
    #[serde(default)]
    checkpoint: bool,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    note: Option<String>,
}

/// `dict[str, list[dict[str, Any]]]`, checked as Pydantic checks it.
fn upsert_lists(upsert: Map<String, Value>) -> ApiResult<Vec<(String, Vec<Map<String, Value>>)>> {
    let mut out = Vec::new();
    for (key, value) in upsert {
        let Value::Array(items) = value else {
            return Err(ApiError::validation(&["body", "upsert", &key], "Input should be a valid list", "list_type"));
        };
        let mut maps = Vec::new();
        for (i, item) in items.into_iter().enumerate() {
            match item {
                Value::Object(m) => maps.push(m),
                _ => {
                    return Err(ApiError::validation(
                        &["body", "upsert", &key, &i.to_string()],
                        "Input should be a valid dictionary",
                        "dict_type",
                    ));
                }
            }
        }
        out.push((key, maps));
    }
    Ok(out)
}

/// Save layout changes (moves, notes, arrows, labels, tabs). 409 `canvas_conflict` names the items both changed.
async fn patch_canvas(headers: HeaderMap, Path(canvas_id): Path<String>, Body(body): Body<UpsertBody>) -> Reply {
    let upsert = upsert_lists(body.upsert)?;
    let session = kb_db::session();
    let out = svc::save::save(
        &session,
        &canvas_id,
        SaveArgs {
            base_rev: body.base_rev,
            upsert,
            remove: body.remove,
            title: body.title,
            force: body.force,
            checkpoint: body.checkpoint,
            name: body.name,
            note: body.note,
        },
    )
    .await
    .map_err(|e| docs_error(&headers, e))?;
    changed().await;
    Ok(json(out))
}

/// Unlink a canvas. The row and files are kept and it can be restored.
async fn del_canvas(headers: HeaderMap, Path(canvas_id): Path<String>) -> Reply {
    let session = kb_db::session();
    let out = svc::rows::delete_canvas(&session, &canvas_id).await.map_err(|e| docs_error(&headers, e))?;
    changed().await;
    Ok(json(out))
}

/// Bring an unlinked canvas back.
async fn post_restore_canvas(headers: HeaderMap, Path(canvas_id): Path<String>) -> Reply {
    let session = kb_db::session();
    let out = svc::rows::restore_canvas(&session, &canvas_id).await.map_err(|e| docs_error(&headers, e))?;
    changed().await;
    Ok(json(out))
}

/// Move to Docs.
#[derive(Debug, Deserialize)]
struct MoveBody {
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    parent_id: Option<String>,
}

/// Give an inline canvas its own Docs page; the text it came from keeps showing it.
async fn post_move_to_docs(headers: HeaderMap, Path(canvas_id): Path<String>, Body(body): Body<MoveBody>) -> Reply {
    let session = kb_db::session();
    let out = svc::docs::move_to_docs(&session, &canvas_id, body.title.as_deref(), body.parent_id.as_deref())
        .await
        .map_err(|e| docs_error(&headers, e))?;
    changed().await;
    Ok(json(out))
}

/// Save a copy: a second canvas with the same frames, notes and arrows (comments and history stay behind).
async fn post_copy(
    headers: HeaderMap,
    Path(canvas_id): Path<String>,
    RawQuery(query): RawQuery,
) -> ApiResult<(StatusCode, Json<Value>)> {
    let pairs = query_pairs(query.as_deref());
    let title = pairs.iter().rev().find(|(n, _)| n == "title").map(|(_, v)| v.clone());
    let session = kb_db::session();
    let out = boards::copy_canvas(&session, &canvas_id, title.as_deref()).await.map_err(|e| docs_error(&headers, e))?;
    changed().await;
    Ok((StatusCode::CREATED, json(out)))
}

// --- frames -----------------------------------------------------------------------------------------------------

/// Add a frame: an HTML page (files), a picture, a Sketch or Diagram (`ref`), or an empty one.
async fn post_board(
    headers: HeaderMap,
    Path(canvas_id): Path<String>,
    req: Request,
) -> ApiResult<(StatusCode, Json<Value>)> {
    let form = Form::read(req).await;
    let (x, y) = (form.float("x")?, form.float("y")?);
    let paths = form.texts("paths");
    let size = form.text("size").filter(|s| svc::size_preset(s).is_some()).map(Size::Preset);
    let session = kb_db::session();
    let out = boards::add_board(
        &session,
        &canvas_id,
        AddBoard {
            name: form.text("name"),
            kind: form.text("kind").unwrap_or_else(|| "empty".into()),
            page: form.text("page"),
            files: if form.has_files("files") { Some(form.files_named("files", &paths)) } else { None },
            entry: form.text("entry"),
            reference: form.text("ref"),
            size,
            x,
            y,
            fit: false,
        },
    )
    .await
    .map_err(|e| docs_error(&headers, e))?;
    changed().await;
    Ok((StatusCode::CREATED, json(out)))
}

/// Each file becomes a frame: HTML files, pictures, or a ZIP of a built page.
async fn post_import(
    headers: HeaderMap,
    Path(canvas_id): Path<String>,
    req: Request,
) -> ApiResult<(StatusCode, Json<Value>)> {
    let form = Form::read(req).await;
    if !form.has_files("files") {
        return Err(missing(&["files"], "body"));
    }
    let uploads: Vec<(String, Vec<u8>)> = form
        .files
        .iter()
        .filter(|(n, _, _)| n == "files")
        .map(|(_, name, data)| (name.clone().filter(|n| !n.is_empty()).unwrap_or_else(|| "file".into()), data.clone()))
        .collect();
    let session = kb_db::session();
    let out = svc::archive::import_files(&session, &canvas_id, uploads, form.text("page").as_deref(), None)
        .await
        .map_err(|e| docs_error(&headers, e))?;
    changed().await;
    Ok((StatusCode::CREATED, json(out)))
}

/// Copy a frame next to the original.
async fn post_duplicate(
    headers: HeaderMap,
    Path((canvas_id, board_id)): Path<(String, String)>,
) -> ApiResult<(StatusCode, Json<Value>)> {
    let session = kb_db::session();
    let out = boards::duplicate_board(&session, &canvas_id, &board_id).await.map_err(|e| docs_error(&headers, e))?;
    changed().await;
    Ok((StatusCode::CREATED, json(out)))
}

/// The text files of an HTML frame (for the source editor).
async fn get_source(headers: HeaderMap, Path((canvas_id, board_id)): Path<(String, String)>) -> Reply {
    let session = kb_db::session();
    Ok(json(boards::board_source(&session, &canvas_id, &board_id).await.map_err(|e| docs_error(&headers, e))?))
}

/// One text file of a frame.
#[derive(Debug, Deserialize)]
struct SourceFile {
    path: String,
    text: String,
}

/// The new source of a frame.
#[derive(Debug, Deserialize)]
struct ContentBody {
    files: Vec<SourceFile>,
    #[serde(default)]
    entry: Option<String>,
    #[serde(default)]
    base_content_rev: Option<i64>,
    #[serde(default = "yes")]
    release: bool,
}

fn yes() -> bool {
    true
}

/// Save a frame's source (the person editing holds the lock). 423 `board_locked` if somebody else does.
async fn put_content(
    headers: HeaderMap,
    Path((canvas_id, board_id)): Path<(String, String)>,
    Body(body): Body<ContentBody>,
) -> Reply {
    let session = kb_db::session();
    let mut files =
        boards::board_binary_files(&session, &canvas_id, &board_id).await.map_err(|e| docs_error(&headers, e))?;
    for f in body.files {
        put_file(&mut files, f.path, f.text.into_bytes());
    }
    let out = boards::put_board_content(
        &session,
        &canvas_id,
        &board_id,
        &files,
        PutContent {
            entry: body.entry.as_deref(),
            base_content_rev: body.base_content_rev,
            release: body.release,
            ai_team: None,
        },
    )
    .await
    .map_err(|e| docs_error(&headers, e))?;
    changed().await;
    Ok(json(out))
}

/// Replace a frame's content with uploaded files (an HTML file, several files, or a ZIP). `base_content_rev` is the
/// content revision the person saw (0 for an empty frame); a different one is `409 board_conflict`.
async fn post_replace(headers: HeaderMap, Path((canvas_id, board_id)): Path<(String, String)>, req: Request) -> Reply {
    let form = Form::read(req).await;
    if !form.has_files("files") {
        return Err(missing(&["files"], "body"));
    }
    let base_content_rev = form.int("base_content_rev")?;
    let paths = form.texts("paths");
    let mut data = form.files_named("files", &paths);
    if data.len() == 1 {
        let name = data[0].0.to_lowercase();
        if name.ends_with(".zip") {
            let blob = data.remove(0).1;
            data = svc::archive::strip_common_root(svc::archive::unzip(&blob).map_err(|e| docs_error(&headers, e))?);
        } else if name.ends_with(".html") || name.ends_with(".htm") {
            let blob = data.remove(0).1;
            data = vec![("index.html".into(), blob)];
        }
    }
    let session = kb_db::session();
    let out = boards::put_board_content(
        &session,
        &canvas_id,
        &board_id,
        &data,
        PutContent { entry: form.text("entry").as_deref(), base_content_rev, ..Default::default() },
    )
    .await
    .map_err(|e| docs_error(&headers, e))?;
    changed().await;
    Ok(json(out))
}

/// Take the lock on a frame (423 `board_locked` if somebody else has it).
async fn post_lock(headers: HeaderMap, Path((canvas_id, board_id)): Path<(String, String)>) -> Reply {
    let session = kb_db::session();
    let out = boards::lock_board(&session, &canvas_id, &board_id).await.map_err(|e| docs_error(&headers, e))?;
    changed().await;
    Ok(json(out))
}

/// Still editing.
async fn post_heartbeat(headers: HeaderMap, Path((canvas_id, board_id)): Path<(String, String)>) -> Reply {
    let session = kb_db::session();
    Ok(json(boards::heartbeat_board(&session, &canvas_id, &board_id).await.map_err(|e| docs_error(&headers, e))?))
}

/// Let go of the lock.
async fn del_lock(headers: HeaderMap, Path((canvas_id, board_id)): Path<(String, String)>) -> Reply {
    let session = kb_db::session();
    let out = boards::unlock_board(&session, &canvas_id, &board_id).await.map_err(|e| docs_error(&headers, e))?;
    changed().await;
    Ok(json(out))
}

/// A response with these headers added.
fn with_headers(mut response: Response, extra: &[(&str, &str)]) -> Response {
    for (n, v) in extra {
        if let (Ok(name), Ok(value)) = (HeaderName::from_bytes(n.as_bytes()), HeaderValue::from_str(v)) {
            response.headers_mut().insert(name, value);
        }
    }
    response
}

/// A file of a frame at one revision, as it is (an open web page).
async fn get_board_file(
    headers: HeaderMap,
    Path((canvas_id, board_id, rev, path)): Path<(String, String, i64, String)>,
) -> ApiResult<Response> {
    let session = kb_db::session();
    let (data, media) = boards::read_board_file(&session, &canvas_id, &board_id, rev, &path)
        .await
        .map_err(|e| docs_error(&headers, e))?;
    Ok(with_headers(
        (StatusCode::OK, data).into_response(),
        &[FRAME_HEADERS[0], FRAME_HEADERS[1], FRAME_HEADERS[2], ("content-type", media)],
    ))
}

/// A wireframe picture of an HTML or empty frame (drawn below 40% zoom).
async fn get_snapshot(
    headers: HeaderMap,
    Path((canvas_id, board_id)): Path<(String, String)>,
    RawQuery(query): RawQuery,
) -> ApiResult<Response> {
    let rev = query_int(&query_pairs(query.as_deref()), "rev")?;
    let session = kb_db::session();
    let png = boards::board_snapshot(&session, &canvas_id, &board_id, rev.map(i64::from))
        .await
        .map_err(|e| docs_error(&headers, e))?;
    Ok(with_headers(
        (StatusCode::OK, png).into_response(),
        &[("content-type", "image/png"), ("cache-control", "private, max-age=300")],
    ))
}

/// A wireframe picture of one page tab: what an export writes where the canvas stood.
async fn get_overview(
    headers: HeaderMap,
    Path(canvas_id): Path<String>,
    RawQuery(query): RawQuery,
) -> ApiResult<Response> {
    let pairs = query_pairs(query.as_deref());
    let page = pairs.iter().rev().find(|(n, _)| n == "page").map(|(_, v)| v.clone());
    let session = kb_db::session();
    let png = boards::overview_png(&session, &canvas_id, page.as_deref()).await.map_err(|e| docs_error(&headers, e))?;
    Ok(with_headers(
        (StatusCode::OK, png).into_response(),
        &[("content-type", "image/png"), ("cache-control", "private, max-age=0, must-revalidate")],
    ))
}

/// A ZIP of every frame (with `canvas.json`), or of one frame.
async fn get_download(
    headers: HeaderMap,
    Path(canvas_id): Path<String>,
    RawQuery(query): RawQuery,
) -> ApiResult<Response> {
    let pairs = query_pairs(query.as_deref());
    let version = query_int(&pairs, "version")?;
    let board_id = pairs.iter().rev().find(|(n, _)| n == "board_id").map(|(_, v)| v.clone());
    let session = kb_db::session();
    let (data, name) = svc::archive::export_zip(&session, &canvas_id, board_id.as_deref(), version)
        .await
        .map_err(|e| docs_error(&headers, e))?;
    let disposition = format!("attachment; filename=\"{name}\"");
    Ok(with_headers(
        (StatusCode::OK, data).into_response(),
        &[
            ("content-type", "application/zip"),
            ("content-disposition", &disposition),
            ("access-control-expose-headers", "Content-Disposition"),
        ],
    ))
}

// --- versions ---------------------------------------------------------------------------------------------------

/// Versions, newest first.
async fn get_versions(headers: HeaderMap, Path(canvas_id): Path<String>) -> Reply {
    let session = kb_db::session();
    Ok(list(svc::versions::list_versions(&session, &canvas_id).await.map_err(|e| docs_error(&headers, e))?))
}

/// A named version of the canvas as it is now.
#[derive(Debug, Deserialize)]
struct NewVersion {
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    note: Option<String>,
}

/// Make a version now.
async fn post_version(
    headers: HeaderMap,
    Path(canvas_id): Path<String>,
    Body(body): Body<NewVersion>,
) -> ApiResult<(StatusCode, Json<Value>)> {
    let session = kb_db::session();
    let out = svc::versions::make_version(&session, &canvas_id, body.name.as_deref(), body.note.as_deref(), "named")
        .await
        .map_err(|e| docs_error(&headers, e))?;
    changed().await;
    Ok((StatusCode::CREATED, json(out)))
}

/// A required `int` query parameter.
fn query_int_required(pairs: &[(String, String)], name: &str) -> ApiResult<i32> {
    query_required(pairs, name)?.trim().parse::<i32>().map_err(|_| {
        ApiError::validation(
            &["query", name],
            "Input should be a valid integer, unable to parse string as an integer",
            "int_parsing",
        )
    })
}

/// The two versions `a` and `b` of a comparison; FastAPI lists every problem of the two.
fn two_versions(pairs: &[(String, String)]) -> ApiResult<(i32, i32)> {
    let (a, b) = (query_int_required(pairs, "a"), query_int_required(pairs, "b"));
    match (a, b) {
        (Ok(a), Ok(b)) => Ok((a, b)),
        (Err(_), Err(_)) => Err(ApiError::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            json!([
                {"type": "missing", "loc": ["query", "a"], "msg": "Field required"},
                {"type": "missing", "loc": ["query", "b"], "msg": "Field required"}
            ]),
        )),
        (Err(e), _) | (_, Err(e)) => Err(e),
    }
}

/// Two versions board by board.
async fn get_compare(headers: HeaderMap, Path(canvas_id): Path<String>, RawQuery(query): RawQuery) -> Reply {
    let (a, b) = two_versions(&query_pairs(query.as_deref()))?;
    let session = kb_db::session();
    Ok(json(svc::versions::compare(&session, &canvas_id, a, b).await.map_err(|e| docs_error(&headers, e))?))
}

/// Line diff of a frame's source between two versions.
async fn get_source_diff(
    headers: HeaderMap,
    Path((canvas_id, board_id)): Path<(String, String)>,
    RawQuery(query): RawQuery,
) -> Reply {
    let (a, b) = two_versions(&query_pairs(query.as_deref()))?;
    let session = kb_db::session();
    Ok(json(
        svc::versions::source_diff(&session, &canvas_id, &board_id, a, b).await.map_err(|e| docs_error(&headers, e))?,
    ))
}

/// One version with the canvas file as it was.
async fn get_version(headers: HeaderMap, Path((canvas_id, n)): Path<(String, i32)>) -> Reply {
    let session = kb_db::session();
    Ok(json(svc::versions::get_version(&session, &canvas_id, n).await.map_err(|e| docs_error(&headers, e))?))
}

/// Name a version.
#[derive(Debug, Deserialize)]
struct VersionName {
    #[serde(default)]
    name: Option<String>,
}

/// Name (or unname) a version.
async fn patch_version(
    headers: HeaderMap,
    Path((canvas_id, n)): Path<(String, i32)>,
    Body(body): Body<VersionName>,
) -> Reply {
    let session = kb_db::session();
    Ok(json(
        svc::versions::name_version(&session, &canvas_id, n, body.name.as_deref())
            .await
            .map_err(|e| docs_error(&headers, e))?,
    ))
}

/// Restore a version (makes a new version; nothing is lost).
async fn post_restore_version(headers: HeaderMap, Path((canvas_id, n)): Path<(String, i32)>) -> Reply {
    let session = kb_db::session();
    let out = svc::versions::restore_version(&session, &canvas_id, n).await.map_err(|e| docs_error(&headers, e))?;
    changed().await;
    Ok(json(out))
}
