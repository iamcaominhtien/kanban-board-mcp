//! `api/logs.py`: errors reported by the web UI, and the export of the application log.

use std::collections::VecDeque;
use std::convert::Infallible;
use std::sync::Mutex;
use std::time::Instant;

use axum::body::Body as HttpBody;
use axum::http::{HeaderValue, StatusCode, header};
use axum::response::Response;
use bytes::Bytes;
use chrono::{DateTime, FixedOffset, Local};
use kb_base::error::{Body, Query};
use kb_base::time;
use kb_base::{ApiError, ApiResult, Routes, pytext, version};
use kb_log::app_logging;
use serde::Deserialize;
use serde_json::{Value, json};

/// The server accepts requests from any origin, so cap what a client can write.
const CLIENT_LOGS_PER_MINUTE: usize = 60;
static CLIENT_LOG_TIMES: Mutex<VecDeque<Instant>> = Mutex::new(VecDeque::new());

fn default_level() -> String {
    "error".to_string()
}

/// An error or warning reported by the web UI.
#[derive(Debug, Deserialize)]
struct ClientLogEntry {
    /// `^(warning|error)$`
    #[serde(default = "default_level")]
    level: String,
    /// at most 2000 characters
    message: String,
    /// at most 8000 characters
    #[serde(default)]
    stack: Option<String>,
    /// at most 500 characters
    #[serde(default)]
    url: Option<String>,
}

impl ClientLogEntry {
    /// The checks of the `Field(...)` constraints, as FastAPI's 422 lists them.
    fn validate(&self) -> ApiResult<()> {
        let mut errors: Vec<Value> = Vec::new();
        if self.level != "warning" && self.level != "error" {
            errors.push(json!({
                "type": "string_pattern_mismatch",
                "loc": ["body", "level"],
                "msg": "String should match pattern '^(warning|error)$'",
            }));
        }
        for (name, value, max) in [
            ("message", Some(&self.message), 2000),
            ("stack", self.stack.as_ref(), 8000),
            ("url", self.url.as_ref(), 500),
        ] {
            if value.is_some_and(|text| text.chars().count() > max) {
                errors.push(json!({
                    "type": "string_too_long",
                    "loc": ["body", name],
                    "msg": format!("String should have at most {max} characters"),
                }));
            }
        }
        if errors.is_empty() {
            Ok(())
        } else {
            Err(ApiError::new(StatusCode::UNPROCESSABLE_ENTITY, Value::Array(errors)))
        }
    }
}

/// The query of `GET /logs/export`.
#[derive(Debug, Deserialize)]
struct ExportQuery {
    /// Start of range, ISO-8601
    #[serde(default)]
    since: Option<String>,
    /// End of range, ISO-8601
    #[serde(default)]
    until: Option<String>,
    /// Lowest level to include
    #[serde(default = "default_export_level")]
    level: String,
}

fn default_export_level() -> String {
    "INFO".to_string()
}

/// The routes of this file.
pub fn routes() -> Routes {
    Routes::new().nest("/logs", Routes::new().post("/client", log_client_event).get("/export", export_logs))
}

/// Record an error from the web UI in the application log. Fails with 429 when more than 60 entries arrive within a
/// minute.
async fn log_client_event(Body(entry): Body<ClientLogEntry>) -> ApiResult<StatusCode> {
    entry.validate()?;
    {
        let now = Instant::now();
        let mut times = CLIENT_LOG_TIMES.lock().unwrap_or_else(|e| e.into_inner());
        while times.front().is_some_and(|first| now.duration_since(*first).as_secs_f64() > 60.0) {
            times.pop_front();
        }
        if times.len() >= CLIENT_LOGS_PER_MINUTE {
            return Err(ApiError::code(429, "Too many client log entries"));
        }
        times.push_back(now);
    }
    let url = entry.url.as_deref().filter(|u| !u.is_empty()).map(|u| format!(" (at {u})")).unwrap_or_default();
    let stack = entry.stack.as_deref().filter(|s| !s.is_empty()).map(|s| format!("\n{s}")).unwrap_or_default();
    if entry.level == "error" {
        tracing::error!(target: "ui", "{}{url}{stack}", entry.message);
    } else {
        tracing::warn!(target: "ui", "{}{url}{stack}", entry.message);
    }
    Ok(StatusCode::NO_CONTENT)
}

/// `datetime.fromisoformat(value.strip().replace("Z", "+00:00"))`; an empty value is no bound.
fn parse_time(name: &str, value: Option<&str>) -> ApiResult<Option<DateTime<FixedOffset>>> {
    let Some(value) = value.filter(|v| !v.is_empty()) else {
        return Ok(None);
    };
    match time::parse_iso(&pytext::strip(value).replace('Z', "+00:00")) {
        Some(parsed) => Ok(Some(app_logging::aware(parsed))),
        None => Err(ApiError::bad_request(format!("Invalid '{name}': expected an ISO-8601 date-time"))),
    }
}

/// Download the application log as a text file, optionally limited to a time range.
///
/// `since` and `until` are the inclusive ends of the range (a value without a UTC offset is local server time);
/// `level` the lowest level to include. Fails with 400 for an unparsable time, an inverted range or an unknown level.
async fn export_logs(Query(query): Query<ExportQuery>) -> ApiResult<Response> {
    let start = parse_time("since", query.since.as_deref())?;
    let end = parse_time("until", query.until.as_deref())?;
    if let (Some(start), Some(end)) = (start, end) {
        if start > end {
            return Err(ApiError::bad_request("'since' must not be after 'until'"));
        }
    }
    let level = query.level.to_uppercase();
    if app_logging::level_value(&level).is_none() {
        return Err(ApiError::bad_request(format!("Unknown level: {level}")));
    }

    let header_lines = [
        "# Kanban Board MCP log export".to_string(),
        format!("# Exported: {}", Local::now().format("%Y-%m-%dT%H:%M:%S%:z")),
        format!(
            "# Range: {} -> {}  (level >= {level})",
            query.since.as_deref().filter(|s| !s.is_empty()).unwrap_or("beginning"),
            query.until.as_deref().filter(|s| !s.is_empty()).unwrap_or("now"),
        ),
        format!("# Version: {}", version::version_info().get("version").and_then(Value::as_str).unwrap_or("?")),
        format!(
            "# Platform: {}-{}  Rust {}",
            std::env::consts::OS,
            std::env::consts::ARCH,
            option_env!("CARGO_PKG_RUST_VERSION").unwrap_or("?")
        ),
        format!("# Database: {}", kb_db::database::get_db_path().display()),
        format!("# Log file: {}", app_logging::get_log_path().display()),
        String::new(),
    ];
    let records =
        app_logging::iter_records(start, end, &level).map_err(|err| ApiError::bad_request(err.to_string()))?;

    // the files are read one at a time on a thread of their own, and sent as they come
    let (tx, rx) = tokio::sync::mpsc::channel::<Result<Bytes, Infallible>>(16);
    tokio::task::spawn_blocking(move || {
        if tx.blocking_send(Ok(Bytes::from(format!("{}\n", header_lines.join("\n"))))).is_err() {
            return;
        }
        let mut found = false;
        for record in records {
            found = true;
            if tx.blocking_send(Ok(Bytes::from(record))).is_err() {
                return;
            }
        }
        if !found {
            let _ = tx.blocking_send(Ok(Bytes::from_static(b"# (no log entries in this range)\n")));
        }
    });

    let stamp = Local::now().format("%Y%m%d-%H%M%S");
    let mut response = Response::new(HttpBody::from_stream(tokio_stream::wrappers::ReceiverStream::new(rx)));
    let headers = response.headers_mut();
    headers.insert(header::CONTENT_TYPE, HeaderValue::from_static("text/plain; charset=utf-8"));
    if let Ok(value) = HeaderValue::try_from(format!("attachment; filename=kanban-log-{stamp}.log")) {
        headers.insert(header::CONTENT_DISPOSITION, value);
    }
    Ok(response)
}
