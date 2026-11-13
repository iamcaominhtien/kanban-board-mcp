//! The REST routes of this area.

use axum::http::HeaderMap;
use kb_base::{ApiError, ApiResult, Routes};
use serde_json::{Value, json};

pub mod canvases;
pub mod diagrams;
pub mod sketches;

/// Every route of this area (the app merges them, in the order the Python app included its routers).
pub fn routes() -> Routes {
    // the order of `main.py`: diagrams, sketches, canvases
    Routes::new().merge(diagrams::routes()).merge(sketches::routes()).merge(canvases::routes())
}

/// `docs_error_handler` of `api/docs.py`: every `DocsError` answers `{detail: {code, message, request_id, ...}}` and
/// an `x-request-id` header (the caller's, cut to 64 characters, else a new one of 12).
pub fn docs_error(headers: &HeaderMap, err: crate::Error) -> ApiError {
    match err {
        crate::Error::Docs(e) => {
            let sent = headers.get("x-request-id").map(|v| String::from_utf8_lossy(v.as_bytes()).into_owned());
            let sent: String = kb_base::pytext::strip(sent.as_deref().unwrap_or("")).chars().take(64).collect();
            let request_id = if sent.is_empty() { kb_base::time::uuid4_hex().chars().take(12).collect() } else { sent };
            let mut detail = serde_json::Map::new();
            detail.insert("code".into(), json!(e.code));
            detail.insert("message".into(), json!(e.message));
            detail.insert("request_id".into(), json!(request_id));
            for (k, v) in e.extra {
                detail.insert(k, v);
            }
            ApiError::code(e.status, Value::Object(detail)).header("x-request-id", &request_id)
        }
        crate::Error::Db(e) => e.into(),
        crate::Error::Value(m) => ApiError::internal(m),
        crate::Error::Io(e) => e.into(),
    }
}

/// The query string as `(name, value)` pairs.
pub(crate) fn query_pairs(raw: Option<&str>) -> Vec<(String, String)> {
    serde_urlencoded::from_str(raw.unwrap_or("")).unwrap_or_default()
}

fn last<'a>(pairs: &'a [(String, String)], name: &str) -> Option<&'a str> {
    pairs.iter().rev().find(|(n, _)| n == name).map(|(_, v)| v.as_str())
}

/// A `bool = False` query parameter as Pydantic reads it; the last of several values counts.
pub(crate) fn query_bool(pairs: &[(String, String)], name: &str) -> ApiResult<bool> {
    let Some(value) = last(pairs, name) else { return Ok(false) };
    match value.to_lowercase().as_str() {
        "1" | "true" | "t" | "yes" | "y" | "on" => Ok(true),
        "0" | "false" | "f" | "no" | "n" | "off" => Ok(false),
        _ => Err(ApiError::validation(
            &["query", name],
            "Input should be a valid boolean, unable to interpret input",
            "bool_parsing",
        )),
    }
}

/// An `int | None = None` query parameter.
pub(crate) fn query_int(pairs: &[(String, String)], name: &str) -> ApiResult<Option<i32>> {
    let Some(value) = last(pairs, name) else { return Ok(None) };
    match value.trim().parse::<i32>() {
        Ok(n) => Ok(Some(n)),
        Err(_) => Err(ApiError::validation(
            &["query", name],
            "Input should be a valid integer, unable to parse string as an integer",
            "int_parsing",
        )),
    }
}

/// A required `str` query parameter.
pub(crate) fn query_required(pairs: &[(String, String)], name: &str) -> ApiResult<String> {
    last(pairs, name)
        .map(str::to_string)
        .ok_or_else(|| ApiError::validation(&["query", name], "Field required", "missing"))
}

/// An optional `str` query parameter with a default.
pub(crate) fn query_str(pairs: &[(String, String)], name: &str, default: &str) -> String {
    last(pairs, name).unwrap_or(default).to_string()
}
