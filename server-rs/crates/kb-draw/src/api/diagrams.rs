//! `api/diagrams.py`: the routes of the diagrams.

use axum::Json;
use axum::extract::{DefaultBodyLimit, RawQuery};
use axum::http::{HeaderMap, HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, post, put};
use kb_base::error::{Body, Path};
use kb_base::{ApiResult, Routes, events};
use serde_json::{Map, Value};

use super::{docs_error, query_bool, query_int, query_pairs, query_str};
use crate::diagrams::{self as svc, DiagramChange, NewDiagram};
use crate::schemas::{DiagramCreate, DiagramSettingsBody, DiagramUpdate};

/// The preview is only ever shown through `<img>`; these headers also stop it running if opened directly.
const SVG_HEADERS: [(&str, &str); 3] = [
    ("content-security-policy", "default-src 'none'; style-src 'unsafe-inline'; sandbox"),
    ("x-content-type-options", "nosniff"),
    ("cache-control", "private, max-age=0, must-revalidate"),
];

/// The routes of this file.
pub fn routes() -> Routes {
    Routes::new()
        .get("/projects/{project_id}/diagrams", get_diagrams)
        // a drawing may be up to 2 MB (plus its preview): the body limit of the extractors is lifted
        .add("POST", "/projects/{project_id}/diagrams", post(post_diagram).layer(DefaultBodyLimit::disable()))
        .get("/diagrams/settings", get_diagram_settings)
        .get("/diagrams/editor-check", get_diagram_editor_check)
        .put("/diagrams/settings", put_diagram_settings)
        // FastAPI falls through a path whose method is not served by the static route to `/diagrams/{diagram_id}`
        .hidden("DELETE", "/diagrams/settings", delete(delete_settings_as_id))
        .hidden("PUT", "/diagrams/editor-check", put(put_editor_check_as_id).layer(DefaultBodyLimit::disable()))
        .hidden("DELETE", "/diagrams/editor-check", delete(delete_editor_check_as_id))
        .get("/diagrams/{diagram_id}", get_diagram)
        .add("PUT", "/diagrams/{diagram_id}", put(put_diagram).layer(DefaultBodyLimit::disable()))
        .delete("/diagrams/{diagram_id}", del_diagram)
        .post("/diagrams/{diagram_id}/restore", post_restore_diagram)
        .get("/diagrams/{diagram_id}/versions", get_diagram_versions)
        .get("/diagrams/{diagram_id}/svg", get_diagram_svg)
        .get("/diagrams/{diagram_id}/download", get_diagram_download)
}

/// The board's address as the caller reached it: the built-in editor is served there.
fn origin(headers: &HeaderMap) -> String {
    let host = headers.get(header::HOST).and_then(|h| h.to_str().ok()).unwrap_or("localhost");
    format!("http://{host}")
}

fn json(map: Map<String, Value>) -> Json<Value> {
    Json(Value::Object(map))
}

/// List a project's diagrams, or the unlinked ones in the Recycle Bin.
async fn get_diagrams(
    headers: HeaderMap,
    Path(project_id): Path<String>,
    RawQuery(query): RawQuery,
) -> ApiResult<Json<Value>> {
    let deleted = query_bool(&query_pairs(query.as_deref()), "deleted")?;
    let session = kb_db::session();
    let list = svc::list_diagrams(&session, &project_id, deleted).await.map_err(|e| docs_error(&headers, e))?;
    Ok(Json(Value::Array(list.into_iter().map(Value::Object).collect())))
}

/// Save a new diagram: the `.drawio` source and its SVG preview (2 MB limit each).
async fn post_diagram(
    headers: HeaderMap,
    Path(project_id): Path<String>,
    Body(body): Body<DiagramCreate>,
) -> ApiResult<(StatusCode, Json<Value>)> {
    let session = kb_db::session();
    let new = NewDiagram {
        label: body.label,
        source: body.source,
        svg: body.svg,
        summary: body.summary,
        item_kind: body.item_kind,
        item_id: body.item_id,
        preview_kind: "editor".into(),
    };
    let out = svc::create_diagram(&session, &project_id, new).await.map_err(|e| docs_error(&headers, e))?;
    events::publish("invalidate", &[]).await;
    Ok((StatusCode::CREATED, json(out)))
}

/// Where the draw.io editor runs.
async fn get_diagram_settings(headers: HeaderMap) -> ApiResult<Json<Value>> {
    let session = kb_db::session();
    let out = svc::get_settings(&session, Some(&origin(&headers))).await.map_err(|e| docs_error(&headers, e))?;
    Ok(json(out))
}

/// Whether the self-hosted draw.io editor answers, asked before the editor opens: without one (the default
/// http://localhost:8080 that the app does not ship) it spun for 20 seconds before saying so.
async fn get_diagram_editor_check(headers: HeaderMap) -> ApiResult<Json<Value>> {
    let session = kb_db::session();
    let out = svc::editor_check(&session, Some(&origin(&headers))).await.map_err(|e| docs_error(&headers, e))?;
    Ok(json(out))
}

/// Choose the built-in, a self-hosted or the public draw.io editor (admin only).
async fn put_diagram_settings(headers: HeaderMap, Body(body): Body<DiagramSettingsBody>) -> ApiResult<Json<Value>> {
    let session = kb_db::session();
    let out = svc::set_settings(&session, &body.mode, body.url.as_deref(), Some(&origin(&headers)))
        .await
        .map_err(|e| docs_error(&headers, e))?;
    Ok(json(out))
}

/// Read a diagram; `source=true` adds the `.drawio` XML (for the editor).
async fn get_diagram(
    headers: HeaderMap,
    Path(diagram_id): Path<String>,
    RawQuery(query): RawQuery,
) -> ApiResult<Json<Value>> {
    let pairs = query_pairs(query.as_deref());
    let version = query_int(&pairs, "version")?;
    let source = query_bool(&pairs, "source")?;
    let session = kb_db::session();
    let out = svc::get_diagram(&session, &diagram_id, version, source).await.map_err(|e| docs_error(&headers, e))?;
    Ok(json(out))
}

async fn put_diagram_impl(headers: &HeaderMap, diagram_id: &str, body: DiagramUpdate) -> ApiResult<Json<Value>> {
    let session = kb_db::session();
    let change = DiagramChange {
        base_version: body.base_version,
        source: body.source,
        svg: body.svg,
        label: body.label,
        summary: body.summary,
        note: None,
        preview_kind: "editor".into(),
    };
    let out = svc::update_diagram(&session, diagram_id, change).await.map_err(|e| docs_error(headers, e))?;
    events::publish("invalidate", &[]).await;
    Ok(json(out))
}

/// Save a new version; 409 `diagram_conflict` if someone saved a newer one.
async fn put_diagram(
    headers: HeaderMap,
    Path(diagram_id): Path<String>,
    Body(body): Body<DiagramUpdate>,
) -> ApiResult<Json<Value>> {
    put_diagram_impl(&headers, &diagram_id, body).await
}

async fn del_diagram_impl(headers: &HeaderMap, diagram_id: &str) -> ApiResult<Json<Value>> {
    let session = kb_db::session();
    let out = svc::delete_diagram(&session, diagram_id).await.map_err(|e| docs_error(headers, e))?;
    events::publish("invalidate", &[]).await;
    Ok(json(out))
}

/// Unlink a diagram. It is kept in the Recycle Bin and can be restored.
async fn del_diagram(headers: HeaderMap, Path(diagram_id): Path<String>) -> ApiResult<Json<Value>> {
    del_diagram_impl(&headers, &diagram_id).await
}

async fn delete_settings_as_id(headers: HeaderMap) -> ApiResult<Json<Value>> {
    del_diagram_impl(&headers, "settings").await
}

async fn delete_editor_check_as_id(headers: HeaderMap) -> ApiResult<Json<Value>> {
    del_diagram_impl(&headers, "editor-check").await
}

async fn put_editor_check_as_id(headers: HeaderMap, Body(body): Body<DiagramUpdate>) -> ApiResult<Json<Value>> {
    put_diagram_impl(&headers, "editor-check", body).await
}

/// Bring an unlinked diagram back.
async fn post_restore_diagram(headers: HeaderMap, Path(diagram_id): Path<String>) -> ApiResult<Json<Value>> {
    let session = kb_db::session();
    let out = svc::restore_diagram(&session, &diagram_id).await.map_err(|e| docs_error(&headers, e))?;
    events::publish("invalidate", &[]).await;
    Ok(json(out))
}

/// List the saved versions, newest first.
async fn get_diagram_versions(headers: HeaderMap, Path(diagram_id): Path<String>) -> ApiResult<Json<Value>> {
    let session = kb_db::session();
    let list = svc::list_versions(&session, &diagram_id).await.map_err(|e| docs_error(&headers, e))?;
    Ok(Json(Value::Array(list)))
}

fn plain_response(content: String, media_type: &str, extra: &[(&str, String)]) -> Response {
    let mut response = (StatusCode::OK, content).into_response();
    let headers = response.headers_mut();
    headers.insert(header::CONTENT_TYPE, HeaderValue::from_str(media_type).unwrap_or(HeaderValue::from_static("")));
    for (name, value) in
        SVG_HEADERS.iter().map(|(n, v)| (*n, v.to_string())).chain(extra.iter().map(|(n, v)| (*n, v.clone())))
    {
        if let (Ok(name), Ok(value)) = (header::HeaderName::try_from(name), HeaderValue::from_str(&value)) {
            headers.insert(name, value);
        }
    }
    response
}

/// The SVG preview shown on the page.
async fn get_diagram_svg(
    headers: HeaderMap,
    Path(diagram_id): Path<String>,
    RawQuery(query): RawQuery,
) -> ApiResult<Response> {
    let version = query_int(&query_pairs(query.as_deref()), "version")?;
    let session = kb_db::session();
    let (content, media, _) =
        svc::read_file(&session, &diagram_id, "svg", version).await.map_err(|e| docs_error(&headers, e))?;
    Ok(plain_response(content, media, &[]))
}

/// Download the diagram as `.drawio` (editable) or `.svg`.
async fn get_diagram_download(
    headers: HeaderMap,
    Path(diagram_id): Path<String>,
    RawQuery(query): RawQuery,
) -> ApiResult<Response> {
    let pairs = query_pairs(query.as_deref());
    let format = query_str(&pairs, "format", "drawio");
    let version = query_int(&pairs, "version")?;
    let kind = if format == "svg" { "svg" } else { "drawio" };
    let session = kb_db::session();
    let (content, media, name) =
        svc::read_file(&session, &diagram_id, kind, version).await.map_err(|e| docs_error(&headers, e))?;
    Ok(plain_response(
        content,
        media,
        &[
            ("content-disposition", format!("attachment; filename=\"{name}\"")),
            ("access-control-expose-headers", "Content-Disposition".to_string()),
        ],
    ))
}
