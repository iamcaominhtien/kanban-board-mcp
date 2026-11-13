//! The REST routes of this area, one module per Python file (`api/docs_ai/`, `assist.py`, `ai_editor.py`,
//! `ai_sketch.py`, `idea_ai.py`).
//!
//! `main.py` includes `docs_ai_router` right after the Docs router and the others (`assist_router`,
//! `ai_editor_router`, `ai_sketch_router`, `idea_ai_router`) after the AI team's routers. No route of the routers
//! between them has the shape and the method of a route of `docs_ai_router`, so [`routes`] gives all five in one
//! block, in the order of `main.py`.
//!
//! Errors: `DocsAiError` and `AssistError` have handlers in the app that answer `{"detail": message, "code": code,
//! ...extra}` (no wrapper), with the status of the code; [`Failure`] is that answer next to an ordinary
//! `HTTPException`.

use axum::Json;
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use kb_base::{ApiError, Routes, activity};
use kb_db::sea_orm::DbErr;
use serde::{Deserialize, Deserializer};
use serde_json::{Map, Value, json};

use crate::assistant::errors::{AssistError, Error as AssistFailure};
use crate::docs_ai::errors::{DocsAiError, Error as DocsAiFailure};

pub mod ai_editor;
pub mod ai_sketch;
pub mod assist;
pub mod docs_ai;
pub mod idea_ai;

/// Every route of this area in one block (`docs_ai_router`, `assist_router`, `ai_editor_router`, `ai_sketch_router`,
/// `idea_ai_router`, the order of `main.py`).
pub fn routes() -> Routes {
    Routes::new()
        .merge(docs_ai::routes())
        .merge(assist::routes())
        .merge(ai_editor::routes())
        .merge(ai_sketch::routes())
        .merge(idea_ai::routes())
}

/// What a route of this area answers when it fails.
#[derive(Debug)]
pub enum Failure {
    /// `HTTPException`, `DocsError` and the like.
    Api(ApiError),
    /// The answer of `DocsAiError` or `AssistError`: a status and the whole body.
    Json(u16, Value),
}

/// A route's result.
pub type Res<T> = Result<T, Failure>;

impl IntoResponse for Failure {
    fn into_response(self) -> Response {
        match self {
            Failure::Api(err) => err.into_response(),
            Failure::Json(status, body) => {
                (StatusCode::from_u16(status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR), Json(body)).into_response()
            }
        }
    }
}

impl From<ApiError> for Failure {
    fn from(err: ApiError) -> Self {
        Failure::Api(err)
    }
}

impl From<DbErr> for Failure {
    fn from(err: DbErr) -> Self {
        Failure::Api(err.into())
    }
}

/// `{"detail": message, "code": code, **extra}`.
fn coded(status: u16, code: &str, message: &str, extra: &Map<String, Value>) -> Failure {
    let mut body = Map::new();
    body.insert("detail".into(), json!(message));
    body.insert("code".into(), json!(code));
    for (key, value) in extra {
        body.insert(key.clone(), value.clone());
    }
    Failure::Json(status, Value::Object(body))
}

/// `docs_ai_error_handler`.
pub(crate) fn docs_ai_error(err: &DocsAiError) -> Failure {
    coded(err.status(), &err.code, &err.message, &err.extra)
}

/// `assist_error_handler`: `STATUS.get(exc.code, 400)`.
pub(crate) fn assist_error(err: &AssistError) -> Failure {
    coded(crate::assistant::errors::status(&err.code).unwrap_or(400), &err.code, &err.message, &err.extra)
}

/// A failure of a Docs call: a `DocsError` through the handler of `main.py` (it echoes `x-request-id`).
pub(crate) fn docs_failure(headers: &HeaderMap, err: kb_docs::Error) -> Failure {
    match err {
        kb_docs::Error::Json { status, body } => Failure::Json(status, body),
        other => Failure::Api(kb_docs::api::docs_error(headers, other)),
    }
}

/// A failure of a Docs AI function as the app answers it.
pub(crate) fn docs_ai_failure(headers: &HeaderMap, err: DocsAiFailure) -> Failure {
    match err {
        DocsAiFailure::DocsAi(e) => docs_ai_error(&e),
        DocsAiFailure::Assist(e) => assist_error(&e),
        DocsAiFailure::Docs(e) => docs_failure(headers, e),
        DocsAiFailure::Db(e) => e.into(),
        other @ (DocsAiFailure::Ticket(_) | DocsAiFailure::Other(_)) => Failure::Api(ApiError::internal(other)),
    }
}

/// A failure of an assistant function as the app answers it (`AssistError` has a handler, the rest is a 500).
pub(crate) fn assist_failure(err: AssistFailure) -> Failure {
    match err {
        AssistFailure::Assist(e) => assist_error(&e),
        AssistFailure::Db(e) => e.into(),
        other @ (AssistFailure::Value(_) | AssistFailure::Other(_)) => Failure::Api(ApiError::internal(other)),
    }
}

/// `svc_activity.current_actor() or "user"`.
pub(crate) fn by() -> String {
    let actor = activity::current_actor();
    if actor.is_empty() { "user".to_string() } else { actor }
}

/// A field that may be left out or sent as `null` (`model_dump(exclude_unset=True)` tells the two apart): `None`
/// is "not sent".
pub(crate) fn sent<'de, D, T>(deserializer: D) -> Result<Option<Option<T>>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::<T>::deserialize(deserializer).map(Some)
}

/// Put a sent field into a map (`model_dump(exclude_unset=True)`).
pub(crate) fn put<T: serde::Serialize>(out: &mut Map<String, Value>, key: &str, value: &Option<Option<T>>) {
    if let Some(value) = value {
        out.insert(key.to_string(), serde_json::to_value(value).unwrap_or(Value::Null));
    }
}

/// `" ".join(text.split())`: runs of white space (Python's) become one space.
pub(crate) fn squash(text: &str) -> String {
    kb_base::pytext::split(text).join(" ")
}

/// `dict[str, bool]`: every value of the map must be a boolean (a 422 at `loc + [key]` otherwise).
pub(crate) fn bool_map(map: &Map<String, Value>, loc: &[&str]) -> Res<()> {
    for (key, value) in map {
        if !value.is_boolean() {
            let mut at: Vec<&str> = loc.to_vec();
            at.push(key);
            return Err(Failure::Api(ApiError::validation(&at, "Input should be a valid boolean", "bool_type")));
        }
    }
    Ok(())
}
