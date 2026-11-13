//! `api/sketches.py`: the routes of the sketches.

use std::collections::HashMap;

use axum::extract::multipart::{Multipart, MultipartRejection};
use axum::extract::{DefaultBodyLimit, RawQuery};
use axum::http::{HeaderMap, HeaderName, HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::post;
use kb_base::error::Path;
use kb_base::{ApiError, ApiResult, Routes, events};
use serde_json::{Map, Value, json};

use super::{docs_error, query_bool, query_pairs, query_required};
use crate::sketches::{self as svc, MAX_BYTES};

/// The picture is shown through `<img>`; the source is data. Both must be re-checked on every use, so a conflict is
/// noticed at once, and neither may be sniffed into something else.
const HEADERS: [(&str, &str); 3] = [
    ("x-content-type-options", "nosniff"),
    ("cache-control", "private, max-age=0, must-revalidate"),
    ("access-control-expose-headers", "ETag, Content-Disposition"),
];

/// The routes of this file.
pub fn routes() -> Routes {
    // the forms carry files of up to 10 MB: the body limit of the extractors is lifted, the handlers cap what they keep
    Routes::new()
        .get("/sketches", get_sketches)
        .add("POST", "/sketches", post(post_sketch).layer(DefaultBodyLimit::disable()))
        .get("/sketches/{sketch_id}", get_sketch)
        .add("PUT", "/sketches/{sketch_id}", axum::routing::put(put_sketch).layer(DefaultBodyLimit::disable()))
        .add("POST", "/sketches/{sketch_id}/copy", post(post_sketch_copy).layer(DefaultBodyLimit::disable()))
        .delete("/sketches/{sketch_id}", del_sketch)
        .post("/sketches/{sketch_id}/restore", post_restore_sketch)
        .get("/sketches/{sketch_id}/png", get_sketch_png)
        .get("/sketches/{sketch_id}/source", get_sketch_source)
}

/// A multipart form: its text fields (the last of a repeated name wins, as Starlette's form does) and its files, each
/// cut one byte past the limit so a huge file is refused cheaply.
#[derive(Default)]
struct Form {
    fields: HashMap<String, String>,
    files: HashMap<String, Vec<u8>>,
}

async fn read_form(multipart: Result<Multipart, MultipartRejection>) -> Form {
    let mut form = Form::default();
    let Ok(mut multipart) = multipart else { return form };
    while let Ok(Some(mut field)) = multipart.next_field().await {
        let Some(name) = field.name().map(str::to_string) else { continue };
        if field.file_name().is_some() {
            let mut data: Vec<u8> = Vec::new();
            while let Ok(Some(chunk)) = field.chunk().await {
                let room = (MAX_BYTES + 1).saturating_sub(data.len());
                data.extend_from_slice(&chunk[..chunk.len().min(room)]);
            }
            form.files.insert(name, data);
        } else if let Ok(text) = field.text().await {
            form.fields.insert(name, text);
        }
    }
    form
}

/// FastAPI's answer to a form that lacks required parts: one `missing` entry for each.
fn missing(names: &[&str]) -> ApiError {
    let list: Vec<Value> =
        names.iter().map(|n| json!({"type": "missing", "loc": ["body", n], "msg": "Field required"})).collect();
    ApiError::new(StatusCode::UNPROCESSABLE_ENTITY, Value::Array(list))
}

impl Form {
    fn text(&self, name: &str) -> Option<String> {
        self.fields.get(name).cloned()
    }

    fn missing_of(&self, texts: &[&str], files: &[&str]) -> Vec<String> {
        let mut out: Vec<String> =
            texts.iter().filter(|n| !self.fields.contains_key(**n)).map(|n| n.to_string()).collect();
        out.extend(files.iter().filter(|n| !self.files.contains_key(**n)).map(|n| n.to_string()));
        out
    }

    fn int(&self, name: &str) -> ApiResult<i32> {
        let raw = self.fields.get(name).cloned().unwrap_or_default();
        raw.trim().parse::<i32>().map_err(|_| {
            ApiError::validation(
                &["body", name],
                "Input should be a valid integer, unable to parse string as an integer",
                "int_parsing",
            )
        })
    }

    fn flag(&self, name: &str) -> ApiResult<bool> {
        let Some(raw) = self.fields.get(name) else { return Ok(false) };
        match raw.to_lowercase().as_str() {
            "1" | "true" | "t" | "yes" | "y" | "on" => Ok(true),
            "0" | "false" | "f" | "no" | "n" | "off" => Ok(false),
            _ => Err(ApiError::validation(
                &["body", name],
                "Input should be a valid boolean, unable to interpret input",
                "bool_parsing",
            )),
        }
    }
}

type Json = axum::Json<Value>;

fn json(map: Map<String, Value>) -> Json {
    axum::Json(Value::Object(map))
}

/// List the sketches of one page, ticket or idea.
async fn get_sketches(headers: HeaderMap, RawQuery(query): RawQuery) -> ApiResult<Json> {
    let pairs = query_pairs(query.as_deref());
    let owner_kind = query_required(&pairs, "owner_kind");
    let owner_id = query_required(&pairs, "owner_id");
    let (owner_kind, owner_id) = match (owner_kind, owner_id) {
        (Ok(k), Ok(i)) => (k, i),
        (k, i) => {
            let names: Vec<&str> = [("owner_kind", k.is_err()), ("owner_id", i.is_err())]
                .iter()
                .filter(|(_, bad)| *bad)
                .map(|(n, _)| *n)
                .collect();
            let list: Vec<Value> = names
                .iter()
                .map(|n| json!({"type": "missing", "loc": ["query", n], "msg": "Field required"}))
                .collect();
            return Err(ApiError::new(StatusCode::UNPROCESSABLE_ENTITY, Value::Array(list)));
        }
    };
    let session = kb_db::session();
    let list = svc::list_sketches(&session, &owner_kind, &owner_id).await.map_err(|e| docs_error(&headers, e))?;
    Ok(axum::Json(Value::Array(list.into_iter().map(Value::Object).collect())))
}

/// Save a new sketch: the PNG and the editable source (4096 px and 10 MB per file, 10 layers). `draft_chat` is the
/// scope id the editor kept the AI chat of this not yet saved drawing under; the person's chat moves to the new id.
async fn post_sketch(
    headers: HeaderMap,
    multipart: Result<Multipart, MultipartRejection>,
) -> ApiResult<(StatusCode, Json)> {
    let form = read_form(multipart).await;
    let absent = form.missing_of(&["owner_kind", "owner_id"], &["png", "source"]);
    if !absent.is_empty() {
        return Err(missing(&absent.iter().map(String::as_str).collect::<Vec<_>>()));
    }
    let session = kb_db::session();
    let out = svc::create_sketch(
        &session,
        &form.text("owner_kind").unwrap_or_default(),
        &form.text("owner_id").unwrap_or_default(),
        form.text("title").as_deref(),
        &form.files["png"],
        &form.files["source"],
        form.text("project_id").as_deref(),
    )
    .await
    .map_err(|e| docs_error(&headers, e))?;
    // `draft_chat`: "AI v2 stage 7: the sketch assistant keeps its own chat", nothing to move
    events::publish("invalidate", &[]).await;
    Ok((StatusCode::CREATED, json(out)))
}

/// Read a sketch's details (who owns it, size, version, whether the caller may edit).
async fn get_sketch(headers: HeaderMap, Path(sketch_id): Path<String>) -> ApiResult<Json> {
    let session = kb_db::session();
    Ok(json(svc::get_sketch(&session, &sketch_id).await.map_err(|e| docs_error(&headers, e))?))
}

/// Save a new version; 409 `sketch_conflict` if someone saved a newer one (unless `force`).
async fn put_sketch(
    headers: HeaderMap,
    Path(sketch_id): Path<String>,
    multipart: Result<Multipart, MultipartRejection>,
) -> ApiResult<Json> {
    let form = read_form(multipart).await;
    let absent = form.missing_of(&["base_version"], &["png", "source"]);
    if !absent.is_empty() {
        return Err(missing(&absent.iter().map(String::as_str).collect::<Vec<_>>()));
    }
    let base_version = form.int("base_version")?;
    let force = form.flag("force")?;
    let session = kb_db::session();
    let out = svc::update_sketch(
        &session,
        &sketch_id,
        base_version,
        &form.files["png"],
        &form.files["source"],
        form.text("title").as_deref(),
        force,
    )
    .await
    .map_err(|e| docs_error(&headers, e))?;
    events::publish("invalidate", &[]).await;
    Ok(json(out))
}

/// Save a copy as a second sketch; without files it copies the saved one.
async fn post_sketch_copy(
    headers: HeaderMap,
    Path(sketch_id): Path<String>,
    multipart: Result<Multipart, MultipartRejection>,
) -> ApiResult<(StatusCode, Json)> {
    let mut form = read_form(multipart).await;
    let session = kb_db::session();
    let out = svc::copy_sketch(
        &session,
        &sketch_id,
        form.files.remove("png"),
        form.files.remove("source"),
        form.text("title").as_deref(),
    )
    .await
    .map_err(|e| docs_error(&headers, e))?;
    events::publish("invalidate", &[]).await;
    Ok((StatusCode::CREATED, json(out)))
}

/// Unlink a sketch. The row and the files are kept and it can be restored.
async fn del_sketch(headers: HeaderMap, Path(sketch_id): Path<String>) -> ApiResult<Json> {
    let session = kb_db::session();
    let out = svc::delete_sketch(&session, &sketch_id).await.map_err(|e| docs_error(&headers, e))?;
    events::publish("invalidate", &[]).await;
    Ok(json(out))
}

/// Bring an unlinked sketch back.
async fn post_restore_sketch(headers: HeaderMap, Path(sketch_id): Path<String>) -> ApiResult<Json> {
    let session = kb_db::session();
    let out = svc::restore_sketch(&session, &sketch_id).await.map_err(|e| docs_error(&headers, e))?;
    events::publish("invalidate", &[]).await;
    Ok(json(out))
}

async fn file(headers: &HeaderMap, sketch_id: &str, kind: &str, download: bool) -> ApiResult<Response> {
    let session = kb_db::session();
    let (content, media, name, s) =
        svc::read_file(&session, sketch_id, kind).await.map_err(|e| docs_error(headers, e))?;
    let etag = format!("\"{}-v{}-{kind}\"", s.id, s.version);
    let mut response = if headers.get(header::IF_NONE_MATCH).and_then(|v| v.to_str().ok()) == Some(etag.as_str()) {
        StatusCode::NOT_MODIFIED.into_response()
    } else {
        let mut response = (StatusCode::OK, content).into_response();
        response.headers_mut().insert(header::CONTENT_TYPE, HeaderValue::from_static(media));
        if download {
            if let Ok(value) = HeaderValue::from_str(&format!("attachment; filename=\"{name}\"")) {
                response.headers_mut().insert(header::CONTENT_DISPOSITION, value);
            }
        }
        response
    };
    let out = response.headers_mut();
    for (n, v) in HEADERS {
        out.insert(HeaderName::from_static(n), HeaderValue::from_static(v));
    }
    if let Ok(value) = HeaderValue::from_str(&etag) {
        out.insert(header::ETAG, value);
    }
    Ok(response)
}

/// The PNG shown on the page (always the latest version).
async fn get_sketch_png(
    headers: HeaderMap,
    Path(sketch_id): Path<String>,
    RawQuery(query): RawQuery,
) -> ApiResult<Response> {
    let download = query_bool(&query_pairs(query.as_deref()), "download")?;
    file(&headers, &sketch_id, "png", download).await
}

/// The editable source (JSON with layers) the editor opens.
async fn get_sketch_source(
    headers: HeaderMap,
    Path(sketch_id): Path<String>,
    RawQuery(query): RawQuery,
) -> ApiResult<Response> {
    let download = query_bool(&query_pairs(query.as_deref()), "download")?;
    file(&headers, &sketch_id, "source", download).await
}
