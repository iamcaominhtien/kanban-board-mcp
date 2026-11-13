//! `api/schedules.py`: AI schedules API (design/screens/ai-schedules.md): list, preview, create, edit, pause, run now,
//! dry run, history, week view, card states and notifications. Errors carry a `code` (invalid, forbidden, conflict,
//! unavailable...).
//!
//! `ScheduleError` is answered by `schedule_error_handler` of the Python file: `{"detail": message, "code": code,
//! ...extra}` with the status its code maps to (400 for a code the table does not know). `main.py` registers this
//! router second, right after the projects' one; no route that the Rust app registers before `kb_ai_api` can take
//! one of its paths, so `routes()` of the crate merges it last.

use axum::Json;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use chrono::{DateTime, TimeZone, Timelike, Utc};
use kb_ai_run::schedules::{self as svc, ScheduleError};
use kb_base::error::{Body, Path, Query};
use kb_base::{ApiError, ApiResult, Routes, activity, time as kbtime};
use kb_db::Session;
use kb_db::entities::project;
use kb_db::sea_orm::{DbErr, EntityTrait};
use serde::Deserialize;
use serde_json::{Map, Value, json};

use crate::model::{Kind, fields};

/// The routes of this file, in the order of the Python file.
pub fn routes() -> Routes {
    Routes::new()
        .get("/projects/{project_id}/ai/schedules", list_schedules)
        .get("/projects/{project_id}/ai/schedules/history", schedule_history)
        .get("/projects/{project_id}/ai/schedules/week", schedule_week)
        .get("/projects/{project_id}/ai/schedules/cards", schedule_cards)
        .get("/projects/{project_id}/ai/schedules/events", schedule_events)
        .post("/projects/{project_id}/ai/schedules/preview", preview_schedule)
        .post("/projects/{project_id}/ai/schedules/dry-run", dry_run_schedule)
        .post("/projects/{project_id}/ai/schedules", create_schedule)
        .get("/ai/schedules/{schedule_id}", get_schedule)
        .patch("/ai/schedules/{schedule_id}", patch_schedule)
        .delete("/ai/schedules/{schedule_id}", delete_schedule)
        .post("/ai/schedules/{schedule_id}/pause", pause_schedule)
        .post("/ai/schedules/{schedule_id}/resume", resume_schedule)
        .post("/ai/schedules/{schedule_id}/run-now", run_schedule_now)
        .post("/ai/schedule-runs/{run_id}/action", schedule_run_action)
}

/// What a handler of this file fails with: a `ScheduleError` (its own body), or an ordinary error.
enum Failure {
    Schedule(ScheduleError),
    Api(ApiError),
}

impl IntoResponse for Failure {
    fn into_response(self) -> Response {
        match self {
            Failure::Api(err) => err.into_response(),
            Failure::Schedule(err) => {
                // `STATUS.get(exc.code, 400)`
                let status = match err.code.as_str() {
                    "not_found" => 404,
                    "invalid" => 422,
                    "forbidden" => 403,
                    "conflict" | "unavailable" => 409,
                    _ => 400,
                };
                let mut body = Map::new();
                body.insert("detail".into(), json!(err.message));
                body.insert("code".into(), json!(err.code));
                for (key, value) in err.extra {
                    body.insert(key, value);
                }
                (StatusCode::from_u16(status).unwrap_or(StatusCode::BAD_REQUEST), Json(Value::Object(body)))
                    .into_response()
            }
        }
    }
}

impl From<svc::Error> for Failure {
    fn from(err: svc::Error) -> Self {
        match err {
            svc::Error::Schedule(err) => Failure::Schedule(err),
            svc::Error::Db(err) => Failure::Api(err.into()),
            svc::Error::Other(message) => Failure::Api(ApiError::internal(message)),
        }
    }
}

impl From<DbErr> for Failure {
    fn from(err: DbErr) -> Self {
        Failure::Api(err.into())
    }
}

impl From<ApiError> for Failure {
    fn from(err: ApiError) -> Self {
        Failure::Api(err)
    }
}

type Reply<T> = Result<T, Failure>;

/// `svc_activity.current_actor() or "user"`.
fn by() -> String {
    let actor = activity::current_actor();
    if actor.is_empty() { "user".to_string() } else { actor }
}

/// `_project`: a `ScheduleError("not_found", ...)` for a project that is not there.
async fn project_exists(session: &Session, project_id: &str) -> Reply<()> {
    if project::Entity::find_by_id(project_id).one(session).await?.is_none() {
        return Err(Failure::Schedule(ScheduleError::new("not_found", "Project not found.")));
    }
    Ok(())
}

/// `ScheduleBody`'s fields, in the order the model declares them.
const SCHEDULE_FIELDS: [(&str, Kind); 18] = [
    ("ticket_id", Kind::Str),
    ("member_id", Kind::Str),
    ("backup_member_id", Kind::Str),
    ("kind", Kind::Str),
    ("run_at", Kind::Str),
    ("days", Kind::IntList),
    ("time", Kind::Str),
    ("tz", Kind::Str),
    ("ends", Kind::Str),
    ("ends_after", Kind::Int),
    ("ends_on", Kind::Str),
    ("window_end", Kind::Str),
    ("limits", Kind::Object),
    ("catch_up", Kind::Str),
    ("catch_up_hours", Kind::Float),
    ("notify", Kind::StrList),
    ("notify_people", Kind::StrList),
    ("instruction", Kind::Str),
];

/// `_data(body)` of a `ScheduleBody`.
fn schedule_data(body: Map<String, Value>) -> ApiResult<Map<String, Value>> {
    fields(body, &SCHEDULE_FIELDS)
}

/// `_data(body)` of a `PreviewBody`: the schedule's fields, and the `schedule_id` it names.
fn preview_data(body: Map<String, Value>) -> ApiResult<(Map<String, Value>, Option<String>)> {
    let schedule_id = fields(body.clone(), &[("schedule_id", Kind::Str)])?
        .get("schedule_id")
        .and_then(Value::as_str)
        .map(str::to_string);
    Ok((schedule_data(body)?, schedule_id))
}

/// The 422 of a query parameter outside its bounds.
fn out_of_range(name: &str, kind: &str, msg: &str) -> ApiError {
    ApiError::validation(&["query", name], msg, kind)
}

/// A query integer that must lie in `low..=high`.
fn bounded(name: &str, value: i64, low: i64, high: i64) -> ApiResult<i64> {
    if value < low {
        return Err(out_of_range(
            name,
            "greater_than_equal",
            &format!("Input should be greater than or equal to {low}"),
        ));
    }
    if value > high {
        return Err(out_of_range(name, "less_than_equal", &format!("Input should be less than or equal to {high}")));
    }
    Ok(value)
}

#[derive(Debug, Deserialize)]
struct ListQuery {
    #[serde(default)]
    ticket_id: Option<String>,
}

/// Schedules with their last run, tab counts and the next-24 h badge.
async fn list_schedules(
    Path(project_id): Path<String>,
    Query(query): Query<ListQuery>,
) -> Reply<Json<Map<String, Value>>> {
    let session = kb_db::session();
    project_exists(&session, &project_id).await?;
    Ok(Json(svc::list_for(&session, &project_id, query.ticket_id.as_deref()).await?))
}

#[derive(Debug, Deserialize)]
struct HistoryQuery {
    #[serde(default = "fifty")]
    limit: i64,
}

fn fifty() -> i64 {
    50
}

/// Scheduled runs across the project, newest first.
async fn schedule_history(
    Path(project_id): Path<String>,
    Query(query): Query<HistoryQuery>,
) -> Reply<Json<Vec<Map<String, Value>>>> {
    let limit = bounded("limit", query.limit, 1, 200)?;
    let session = kb_db::session();
    project_exists(&session, &project_id).await?;
    Ok(Json(svc::history(&session, &project_id, None, limit as u64).await?))
}

#[derive(Debug, Deserialize)]
struct WeekQuery {
    #[serde(default)]
    start: Option<String>,
    #[serde(default = "seven")]
    days: i64,
}

fn seven() -> i64 {
    7
}

/// Planned runs per team from `start` (default: today, UTC midnight).
async fn schedule_week(
    Path(project_id): Path<String>,
    Query(query): Query<WeekQuery>,
) -> Reply<Json<Map<String, Value>>> {
    let days = bounded("days", query.days, 1, 31)?;
    let session = kb_db::session();
    project_exists(&session, &project_id).await?;
    let at: DateTime<Utc> = match query.start.as_deref().filter(|s| !s.is_empty()) {
        Some(start) => match kbtime::parse_iso(start) {
            Some(parsed) => parsed.utc(),
            None => return Err(Failure::Schedule(ScheduleError::new("invalid", "start must be an ISO date."))),
        },
        None => {
            let now = Utc::now();
            now.with_hour(0)
                .and_then(|t| t.with_minute(0))
                .and_then(|t| t.with_second(0))
                .and_then(|t| t.with_nanosecond(0))
                .unwrap_or_else(|| Utc.timestamp_opt(0, 0).unwrap())
        }
    };
    Ok(Json(svc::week(&session, &project_id, at, days).await?))
}

/// Card footer state per ticket.
async fn schedule_cards(Path(project_id): Path<String>) -> Reply<Json<Vec<Value>>> {
    let session = kb_db::session();
    project_exists(&session, &project_id).await?;
    let states = svc::for_tickets(&session, &project_id).await?;
    Ok(Json(
        states
            .into_iter()
            .map(|(ticket_id, state)| {
                let mut row = Map::new();
                row.insert("ticket_id".into(), json!(ticket_id));
                if let Value::Object(rest) = state {
                    for (k, v) in rest {
                        row.insert(k, v);
                    }
                }
                Value::Object(row)
            })
            .collect(),
    ))
}

#[derive(Debug, Deserialize)]
struct EventsQuery {
    #[serde(default)]
    after: i64,
}

/// Notifications since `after` (the last id the client showed).
async fn schedule_events(
    Path(project_id): Path<String>,
    Query(query): Query<EventsQuery>,
) -> Json<Vec<Map<String, Value>>> {
    Json(svc::events_since(&project_id, query.after))
}

/// Summary, next 5 runs and checks for the editor, without saving.
async fn preview_schedule(
    Path(project_id): Path<String>,
    Body(body): Body<Map<String, Value>>,
) -> Reply<Json<Map<String, Value>>> {
    let (data, schedule_id) = preview_data(body)?;
    let session = kb_db::session();
    project_exists(&session, &project_id).await?;
    Ok(Json(svc::preview(&session, &project_id, &data, &by(), schedule_id.as_deref()).await?))
}

/// What the team would do. Changes nothing.
async fn dry_run_schedule(
    Path(project_id): Path<String>,
    Body(body): Body<Map<String, Value>>,
) -> Reply<Json<Map<String, Value>>> {
    let (data, schedule_id) = preview_data(body)?;
    let session = kb_db::session();
    project_exists(&session, &project_id).await?;
    Ok(Json(svc::dry_run(&session, schedule_id.as_deref(), &project_id, &data, &by()).await?))
}

/// Create a schedule; 422 with `problems` when a check fails.
async fn create_schedule(
    Path(project_id): Path<String>,
    Body(body): Body<Map<String, Value>>,
) -> Reply<(StatusCode, Json<Map<String, Value>>)> {
    let data = schedule_data(body)?;
    let session = kb_db::session();
    project_exists(&session, &project_id).await?;
    let s = svc::create(&session, &project_id, &data, &by()).await?;
    Ok((StatusCode::CREATED, Json(svc::to_dict(&session, &s, None).await?)))
}

/// One schedule with stats and run history.
async fn get_schedule(Path(schedule_id): Path<String>) -> Reply<Json<Map<String, Value>>> {
    let session = kb_db::session();
    Ok(Json(svc::detail(&session, &schedule_id).await?))
}

/// Edit (creator or admin).
async fn patch_schedule(
    Path(schedule_id): Path<String>,
    Body(body): Body<Map<String, Value>>,
) -> Reply<Json<Map<String, Value>>> {
    let data = schedule_data(body)?;
    let session = kb_db::session();
    let s = svc::update(&session, &schedule_id, &data, &by()).await?;
    Ok(Json(svc::to_dict(&session, &s, None).await?))
}

/// Delete (creator or admin).
async fn delete_schedule(Path(schedule_id): Path<String>) -> Reply<StatusCode> {
    let session = kb_db::session();
    svc::delete(&session, &schedule_id, &by()).await?;
    Ok(StatusCode::NO_CONTENT)
}

/// Pause: no new runs start.
async fn pause_schedule(Path(schedule_id): Path<String>) -> Reply<Json<Map<String, Value>>> {
    let session = kb_db::session();
    let s = svc::set_paused(&session, &schedule_id, true, &by(), None).await?;
    Ok(Json(svc::to_dict(&session, &s, None).await?))
}

/// Resume from now; the failure count resets.
async fn resume_schedule(Path(schedule_id): Path<String>) -> Reply<Json<Map<String, Value>>> {
    let session = kb_db::session();
    let s = svc::set_paused(&session, &schedule_id, false, &by(), None).await?;
    Ok(Json(svc::to_dict(&session, &s, None).await?))
}

/// Start a run now, outside the plan.
async fn run_schedule_now(Path(schedule_id): Path<String>) -> Reply<Json<Map<String, Value>>> {
    let session = kb_db::session();
    let r = svc::run_now(&session, &schedule_id, &by()).await?;
    Ok(Json(svc::run_to_dict(&r, None)))
}

/// start (run late), skip, or use_member (run on another team).
#[derive(Debug, Deserialize)]
struct SlotAction {
    action: String,
    #[serde(default)]
    member_id: Option<String>,
}

/// Answer a waiting run: start it late, skip it, or run it on another team.
async fn schedule_run_action(
    Path(run_id): Path<String>,
    Body(body): Body<SlotAction>,
) -> Reply<Json<Map<String, Value>>> {
    let session = kb_db::session();
    let r = svc::slot_action(&session, &run_id, &body.action, &by(), body.member_id.as_deref()).await?;
    Ok(Json(svc::run_to_dict(&r, None)))
}
