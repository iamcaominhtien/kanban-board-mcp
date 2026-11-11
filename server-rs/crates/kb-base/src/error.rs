//! Errors as the REST API answers them.
//!
//! FastAPI's `HTTPException(status, detail)` is `ApiError`: the body is `{"detail": ...}` where the detail is a
//! string or any JSON value. A request the server cannot read (a body that is not the expected JSON, a bad query
//! value) is a 422 whose detail is a list of `{type, loc, msg}`, as FastAPI answers. Anything else that goes wrong
//! is a 500 with the plain text `Internal Server Error`, and is logged.

use axum::Json;
use axum::extract::rejection::{JsonRejection, PathRejection, QueryRejection};
use axum::extract::{FromRequest, FromRequestParts, Request};
use axum::http::request::Parts;
use axum::http::{HeaderMap, HeaderName, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use serde::de::DeserializeOwned;
use serde_json::{Value, json};

/// What a handler returns.
pub type ApiResult<T> = Result<T, ApiError>;

/// `HTTPException`: a status, the `detail` of the JSON body, and optional headers.
#[derive(Debug, Clone)]
pub struct ApiError {
    pub status: StatusCode,
    pub detail: Value,
    pub headers: Vec<(String, String)>,
}

impl ApiError {
    /// `HTTPException(status_code=status, detail=detail)`.
    pub fn new(status: StatusCode, detail: impl Into<Value>) -> Self {
        Self { status, detail: detail.into(), headers: Vec::new() }
    }

    /// `HTTPException(status_code=code, detail=detail)` with the status as a number.
    pub fn code(code: u16, detail: impl Into<Value>) -> Self {
        Self::new(StatusCode::from_u16(code).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR), detail)
    }

    /// 400.
    pub fn bad_request(detail: impl Into<Value>) -> Self {
        Self::new(StatusCode::BAD_REQUEST, detail)
    }

    /// 403.
    pub fn forbidden(detail: impl Into<Value>) -> Self {
        Self::new(StatusCode::FORBIDDEN, detail)
    }

    /// 404.
    pub fn not_found(detail: impl Into<Value>) -> Self {
        Self::new(StatusCode::NOT_FOUND, detail)
    }

    /// 409.
    pub fn conflict(detail: impl Into<Value>) -> Self {
        Self::new(StatusCode::CONFLICT, detail)
    }

    /// 422 with a plain detail (an `HTTPException(422, ...)` raised by a handler, not a validation list).
    pub fn unprocessable(detail: impl Into<Value>) -> Self {
        Self::new(StatusCode::UNPROCESSABLE_ENTITY, detail)
    }

    /// 422 as FastAPI's request validation answers: one `{type, loc, msg}` entry.
    pub fn validation(loc: &[&str], msg: impl Into<String>, kind: &str) -> Self {
        Self::new(StatusCode::UNPROCESSABLE_ENTITY, json!([{"type": kind, "loc": loc, "msg": msg.into()}]))
    }

    /// 500 for an unexpected failure: logged, answered as Starlette does.
    pub fn internal(err: impl std::fmt::Display) -> Self {
        tracing::error!("Unhandled error: {err}");
        Self { status: StatusCode::INTERNAL_SERVER_ERROR, detail: Value::Null, headers: Vec::new() }
    }

    /// Add a response header.
    pub fn header(mut self, name: &str, value: &str) -> Self {
        self.headers.push((name.to_string(), value.to_string()));
        self
    }

    /// The detail as text, when it is a string.
    pub fn message(&self) -> Option<&str> {
        self.detail.as_str()
    }
}

impl std::fmt::Display for ApiError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match &self.detail {
            Value::String(s) => write!(f, "{} {s}", self.status.as_u16()),
            other => write!(f, "{} {other}", self.status.as_u16()),
        }
    }
}

impl std::error::Error for ApiError {}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let mut headers = HeaderMap::new();
        for (name, value) in &self.headers {
            if let (Ok(name), Ok(value)) = (HeaderName::try_from(name.as_str()), HeaderValue::try_from(value.as_str())) {
                headers.insert(name, value);
            }
        }
        if self.status == StatusCode::INTERNAL_SERVER_ERROR && self.detail.is_null() {
            return (self.status, headers, "Internal Server Error").into_response();
        }
        (self.status, headers, Json(json!({"detail": self.detail}))).into_response()
    }
}

/// Unexpected failures (a database error, an IO error) are a 500, as an unhandled exception is in FastAPI.
macro_rules! internal_from {
    ($($ty:ty),* $(,)?) => {$(
        impl From<$ty> for ApiError {
            fn from(err: $ty) -> Self {
                ApiError::internal(err)
            }
        }
    )*};
}
internal_from!(std::io::Error, serde_json::Error, std::fmt::Error, tokio::task::JoinError);

/// A JSON body, answered with FastAPI's 422 when it cannot be read (`Json<T>` of axum answers 400/415/422 with a
/// plain text body, which the app does not understand).
#[derive(Debug, Clone, Copy, Default)]
pub struct Body<T>(pub T);

impl<S, T> FromRequest<S> for Body<T>
where
    S: Send + Sync,
    T: DeserializeOwned,
{
    type Rejection = ApiError;

    async fn from_request(req: Request, state: &S) -> Result<Self, Self::Rejection> {
        let bytes = match axum::body::Bytes::from_request(req, state).await {
            Ok(bytes) => bytes,
            Err(err) => return Err(ApiError::validation(&["body"], err.to_string(), "value_error")),
        };
        if bytes.is_empty() {
            return Err(ApiError::validation(&["body"], "Field required", "missing"));
        }
        let de = &mut serde_json::Deserializer::from_slice(&bytes);
        match serde_path_to_error::deserialize::<_, T>(de) {
            Ok(value) => Ok(Body(value)),
            Err(err) => Err(body_error(&err)),
        }
    }
}

fn body_error<E: std::fmt::Display>(err: &serde_path_to_error::Error<E>) -> ApiError {
    let path = err.path().to_string();
    let msg = err.inner().to_string();
    let mut loc: Vec<Value> = vec![json!("body")];
    if path != "." && !path.is_empty() {
        for part in path.split('.') {
            // "items[2]" is two steps of the location: "items", 2
            let (name, indexes) = match part.split_once('[') {
                Some((name, rest)) => (name, Some(rest)),
                None => (part, None),
            };
            if !name.is_empty() {
                loc.push(json!(name));
            }
            if let Some(rest) = indexes {
                for index in rest.split(['[', ']']).filter(|s| !s.is_empty()) {
                    loc.push(index.parse::<u64>().map(Value::from).unwrap_or_else(|_| json!(index)));
                }
            }
        }
    }
    let (kind, msg) = if let Some(field) = msg.strip_prefix("missing field `").and_then(|m| m.split('`').next()) {
        loc.push(json!(field));
        ("missing", "Field required".to_string())
    } else if msg.starts_with("unknown field") {
        ("extra_forbidden", "Extra inputs are not permitted".to_string())
    } else if msg.starts_with("expected") || msg.starts_with("EOF") || msg.contains("at line") && loc.len() == 1 {
        ("json_invalid", format!("JSON decode error: {msg}"))
    } else {
        ("value_error", msg)
    };
    ApiError::new(StatusCode::UNPROCESSABLE_ENTITY, json!([{"type": kind, "loc": loc, "msg": msg}]))
}

/// Query parameters, answered with FastAPI's 422 when one cannot be read.
#[derive(Debug, Clone, Copy, Default)]
pub struct Query<T>(pub T);

impl<S, T> FromRequestParts<S> for Query<T>
where
    S: Send + Sync,
    T: DeserializeOwned,
{
    type Rejection = ApiError;

    async fn from_request_parts(parts: &mut Parts, state: &S) -> Result<Self, Self::Rejection> {
        match axum::extract::Query::<T>::from_request_parts(parts, state).await {
            Ok(axum::extract::Query(value)) => Ok(Query(value)),
            Err(err) => Err(query_error(&err)),
        }
    }
}

fn query_error(err: &QueryRejection) -> ApiError {
    let text = err.body_text();
    let msg = text.strip_prefix("Failed to deserialize query string: ").unwrap_or(&text).to_string();
    if let Some(field) = msg.strip_prefix("missing field `").and_then(|m| m.split('`').next()) {
        return ApiError::validation(&["query", field], "Field required", "missing");
    }
    ApiError::validation(&["query"], msg, "value_error")
}

/// Path parameters, answered with FastAPI's 422 when one cannot be read (a number expected, text given).
#[derive(Debug, Clone, Copy, Default)]
pub struct Path<T>(pub T);

impl<S, T> FromRequestParts<S> for Path<T>
where
    S: Send + Sync,
    T: DeserializeOwned + Send,
{
    type Rejection = ApiError;

    async fn from_request_parts(parts: &mut Parts, state: &S) -> Result<Self, Self::Rejection> {
        match axum::extract::Path::<T>::from_request_parts(parts, state).await {
            Ok(axum::extract::Path(value)) => Ok(Path(value)),
            Err(err) => Err(path_error(&err)),
        }
    }
}

fn path_error(err: &PathRejection) -> ApiError {
    ApiError::validation(&["path"], err.body_text(), "value_error")
}

impl From<JsonRejection> for ApiError {
    fn from(err: JsonRejection) -> Self {
        ApiError::validation(&["body"], err.body_text(), "value_error")
    }
}
