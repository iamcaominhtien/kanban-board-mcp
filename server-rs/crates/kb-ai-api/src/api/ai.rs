//! `api/ai.py`: AI v2 API: teams, project AI settings, the overview and the board's run chips, the runs and what a
//! person does to them, the live panel, the Timeline and Flow, "You stepped in" and Health.

use axum::Json;
use axum::extract::RawQuery;
use axum::http::StatusCode;
use chrono::{DateTime, FixedOffset, TimeZone, Utc};
use kb_ai::store::{active_runs, get_profile, get_settings, loads, save};
use kb_ai::{budget as svc_budget, ops as svc_ops, steps as svc_steps};
use kb_ai_know::roles as svc_roles;
use kb_ai_run::runs::RunError;
use kb_ai_run::{compact, health as svc_health, resources as svc_resources, runs as svc_runs, session_history};
use kb_ai_run::{teams as svc_teams, touches as svc_touches};
use kb_ai_work::activity as svc_activity_roles;
use kb_ai_work::flow::{self as svc_flow, FlowOpts};
use kb_ai_work::timeline::{self as svc_timeline, TimelineOpts};
use kb_base::error::{Body, Path, Query};
use kb_base::{ApiError, ApiResult, Routes, activity, events, pyjson, pytext, time as kbtime};
use kb_db::Session;
use kb_db::entities::{ai_project_settings, ai_run, ai_run_message, ai_team, member, project};
use kb_db::sea_orm::{ColumnTrait, EntityTrait, QueryFilter, QueryOrder, QuerySelect};
use serde::Deserialize;
use serde_json::{Map, Value, json};

use crate::model::{Kind, fields, limit_of};

/// The routes of this file, in the order of the Python file.
pub fn routes() -> Routes {
    Routes::new()
        .get("/ai/packs/teams", get_team_packs)
        .get("/ai/packs/roles", get_role_catalogue)
        .get("/projects/{project_id}/ai/teams", get_teams)
        .add("POST", "/projects/{project_id}/ai/teams", axum::routing::post(post_team))
        .get("/ai/teams/{member_id}", get_team)
        .patch("/ai/teams/{member_id}", patch_team)
        .post("/ai/teams/{member_id}/pause", post_pause)
        .post("/ai/teams/{member_id}/resume", post_resume)
        .post("/ai/teams/{member_id}/test", post_test)
        .get("/ai/teams/{member_id}/removal-impact", get_removal_impact)
        .post("/ai/teams/{member_id}/remove", post_remove)
        .get("/projects/{project_id}/ai/settings", get_ai_settings)
        .patch("/projects/{project_id}/ai/settings", patch_ai_settings)
        .post("/projects/{project_id}/ai/pause-all", post_pause_all)
        .post("/projects/{project_id}/ai/resume-all", post_resume_all)
        .get("/projects/{project_id}/ai/overview", get_overview)
        .get("/projects/{project_id}/ai/board", get_board)
        .post("/tickets/{ticket_id}/ai/run", post_ticket_run)
        .get("/tickets/{ticket_id}/ai/runs", get_ticket_runs)
        .get("/projects/{project_id}/ai/runs", get_project_runs)
        .get("/ai/runs/{run_id}", get_run)
        .get("/ai/runs/{run_id}/steps", get_run_steps)
        .get("/ai/runs/{run_id}/steps/{seq}/output", get_step_output)
        .get("/ai/runs/{run_id}/messages", get_run_messages)
        .post("/ai/runs/{run_id}/cancel", post_cancel)
        .post("/ai/runs/{run_id}/restart", post_restart)
        .get("/projects/{project_id}/ai/resources", get_resources)
        .get("/tickets/{ticket_id}/ai/sessions", get_sessions)
        .post("/tickets/{ticket_id}/ai/sessions/new", post_new_session)
        .post("/tickets/{ticket_id}/ai/compact", post_compact)
        .post("/ai/runs/{run_id}/answer", post_answer)
        .post("/ai/runs/{run_id}/message", post_message)
        .post("/ai/runs/{run_id}/retry", post_retry)
        .get("/projects/{project_id}/ai/live", get_live)
        .get("/projects/{project_id}/ai/team/activity", get_project_activity)
        .get("/ai/teams/{member_id}/activity", get_team_activity)
        .get("/projects/{project_id}/ai/recent", get_recent)
        .get("/projects/{project_id}/ai/team/timeline", get_timeline)
        .get("/projects/{project_id}/ai/team/flow", get_flow_map)
        .get("/projects/{project_id}/ai/team/flow/scopes", get_flow_scopes)
        .get("/projects/{project_id}/ai/team/touches", get_touches)
        .put("/projects/{project_id}/ai/team/touches/mark", put_touch_mark)
        .add("POST", "/projects/{project_id}/ai/team/touches/lesson", axum::routing::post(post_touch_lesson))
        .get("/projects/{project_id}/ai/team/health", get_health)
}

/// `svc_activity.current_actor() or "user"`.
fn by() -> String {
    let actor = activity::current_actor();
    if actor.is_empty() { "user".to_string() } else { actor }
}

/// `_project`: the 404 of a project that is not there.
async fn project_exists(session: &Session, project_id: &str) -> ApiResult<()> {
    if project::Entity::find_by_id(project_id).one(session).await?.is_none() {
        return Err(ApiError::not_found("Project not found"));
    }
    Ok(())
}

/// `_team`: the member and the profile of an AI team, or the 404.
async fn team_of(session: &Session, member_id: &str) -> ApiResult<(member::Model, ai_team::Model)> {
    let (member, profile) = get_profile(session, member_id).await?;
    match (member, profile) {
        (Some(member), Some(profile)) if member.kind == "ai" || member.kind == "ai_removed" => Ok((member, profile)),
        _ => Err(ApiError::not_found("AI team not found")),
    }
}

/// `svc_teams.describe(session, member, profile)` of the team, after `_team`.
async fn described(session: &Session, member_id: &str) -> ApiResult<Json<Map<String, Value>>> {
    let (member, profile) = team_of(session, member_id).await?;
    Ok(Json(svc_teams::describe(session, &member, &profile, None).await.map_err(team_failure)?))
}

/// What a team service refuses with, where the Python route does not catch it: a 500 (a database error as well).
fn team_failure(err: svc_teams::Error) -> ApiError {
    match err {
        svc_teams::Error::Db(err) => err.into(),
        other => ApiError::internal(other),
    }
}

/// `_err(exc, 422)` for what a team service raises as a `ValueError`; anything else is a 500.
fn team_value_422(err: svc_teams::Error) -> ApiError {
    if err.is_value_error() { ApiError::unprocessable(err.to_string()) } else { team_failure(err) }
}

/// A run service's failure in a route that catches `ValueError` with `status`; anything else is a 500.
fn run_value(err: RunError, status: u16) -> ApiError {
    match err {
        RunError::Db(err) => err.into(),
        err if err.is_value_error() => ApiError::code(status, err.to_string()),
        other => ApiError::internal(other),
    }
}

/// `to_dict` of a run, or the 500 Python gives for a run that is gone (`to_dict(None)`).
fn run_dict(run: Option<ai_run::Model>) -> ApiResult<Json<Map<String, Value>>> {
    match run {
        Some(run) => Ok(Json(svc_runs::to_dict(&run))),
        None => Err(ApiError::internal("'NoneType' object has no attribute 'id'")),
    }
}

async fn invalidate() {
    events::publish("invalidate", &[]).await;
}

// --------------------------------------------------------------------------- teams

/// The ready-made team packs (which roles a team brings) and the role catalogue.
async fn get_team_packs() -> Json<Vec<Map<String, Value>>> {
    Json(svc_roles::team_packs())
}

/// Every ready-made role a team may use as a subagent.
async fn get_role_catalogue() -> Json<Vec<Value>> {
    Json(svc_roles::public(&svc_roles::catalogue()))
}

#[derive(Debug, Deserialize)]
struct TeamsQuery {
    #[serde(default)]
    include_removed: bool,
}

/// The project's AI teams with status, slots and assigned tickets.
async fn get_teams(
    Path(project_id): Path<String>,
    Query(query): Query<TeamsQuery>,
) -> ApiResult<Json<Vec<Map<String, Value>>>> {
    let session = kb_db::session();
    project_exists(&session, &project_id).await?;
    Ok(Json(svc_teams::list_teams(&session, &project_id, query.include_removed).await.map_err(team_failure)?))
}

/// `TeamBody`'s fields, in the order the model declares them.
const TEAM_FIELDS: [(&str, Kind); 19] = [
    ("name", Kind::Str),
    ("color", Kind::Str),
    ("description", Kind::Str),
    ("cli_path", Kind::Str),
    ("working_dir", Kind::Str),
    ("account_id", Kind::Str),
    ("model", Kind::Str),
    ("effort", Kind::Str),
    ("persona", Kind::Str),
    ("pack_key", Kind::Str),
    ("permission_mode", Kind::Str),
    ("max_parallel", Kind::Int),
    ("daily_budget", Kind::Float),
    ("monthly_cap", Kind::Float),
    ("max_runs_per_day", Kind::Int),
    ("tokens_per_day", Kind::Int),
    ("cap_per_run", Kind::Float),
    ("scope", Kind::Str),
    ("config", Kind::Object),
];

/// Add a team. Its runner and sign-in are checked right away.
async fn post_team(
    Path(project_id): Path<String>,
    Body(body): Body<Map<String, Value>>,
) -> ApiResult<(StatusCode, Json<Map<String, Value>>)> {
    let data = fields(body, &TEAM_FIELDS)?;
    let session = kb_db::session();
    project_exists(&session, &project_id).await?;
    let member = match svc_teams::create(&session, &project_id, &data, &by()).await {
        Ok(member) => member,
        Err(err) if err.is_value_error() => {
            session.rollback().await?;
            return Err(ApiError::unprocessable(err.to_string()));
        }
        Err(err) => return Err(team_failure(err)),
    };
    svc_teams::test_connection(&session, &member.id).await.map_err(team_failure)?;
    invalidate().await;
    let Json(team) = described(&session, &member.id).await?;
    Ok((StatusCode::CREATED, Json(team)))
}

/// One team.
async fn get_team(Path(member_id): Path<String>) -> ApiResult<Json<Map<String, Value>>> {
    let session = kb_db::session();
    described(&session, &member_id).await
}

/// Edit a team.
async fn patch_team(
    Path(member_id): Path<String>,
    Body(body): Body<Map<String, Value>>,
) -> ApiResult<Json<Map<String, Value>>> {
    let data = fields(body, &TEAM_FIELDS)?;
    let session = kb_db::session();
    team_of(&session, &member_id).await?;
    if let Err(err) = svc_teams::update(&session, &member_id, &data, &by()).await {
        if err.is_value_error() {
            session.rollback().await?;
        }
        return Err(team_value_422(err));
    }
    invalidate().await;
    described(&session, &member_id).await
}

/// Pause one team.
#[derive(Debug, Deserialize)]
struct PauseBody {
    #[serde(default)]
    cancel_current: bool,
    #[serde(default)]
    reason: Option<String>,
}

/// Pause: new work queues; the current run finishes, or is cancelled when asked.
async fn post_pause(Path(member_id): Path<String>, Body(body): Body<PauseBody>) -> ApiResult<Json<Map<String, Value>>> {
    let session = kb_db::session();
    team_of(&session, &member_id).await?;
    svc_teams::set_paused(&session, &member_id, true, &by(), body.cancel_current, body.reason.as_deref())
        .await
        .map_err(team_failure)?;
    invalidate().await;
    described(&session, &member_id).await
}

/// Resume a paused team.
async fn post_resume(Path(member_id): Path<String>) -> ApiResult<Json<Map<String, Value>>> {
    let session = kb_db::session();
    team_of(&session, &member_id).await?;
    svc_teams::set_paused(&session, &member_id, false, &by(), false, None).await.map_err(team_failure)?;
    invalidate().await;
    described(&session, &member_id).await
}

/// Check the runner and the sign-in of the team's account.
async fn post_test(Path(member_id): Path<String>) -> ApiResult<Json<Map<String, Value>>> {
    let session = kb_db::session();
    team_of(&session, &member_id).await?;
    let result = svc_teams::test_connection(&session, &member_id).await.map_err(team_failure)?;
    invalidate().await;
    Ok(Json(result))
}

/// Open tickets and runs in flight that removing the team affects.
async fn get_removal_impact(Path(member_id): Path<String>) -> ApiResult<Json<Map<String, Value>>> {
    let session = kb_db::session();
    team_of(&session, &member_id).await?;
    Ok(Json(svc_teams::removal_impact(&session, &member_id).await.map_err(team_failure)?))
}

/// What happens to the team's open tickets.
#[derive(Debug, Deserialize)]
struct RemoveBody {
    #[serde(default)]
    tickets: RemoveTickets,
    #[serde(default)]
    reassign_to: Option<String>,
}

/// `Literal["reassign", "unassign"]`.
#[derive(Debug, Default, Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
enum RemoveTickets {
    Reassign,
    #[default]
    Unassign,
}

/// Remove a team: its tickets go to a person or to nobody, its runs are cancelled.
async fn post_remove(
    Path(member_id): Path<String>,
    Body(body): Body<RemoveBody>,
) -> ApiResult<Json<Map<String, Value>>> {
    let session = kb_db::session();
    team_of(&session, &member_id).await?;
    let tickets = match body.tickets {
        RemoveTickets::Reassign => "reassign",
        RemoveTickets::Unassign => "unassign",
    };
    let result = svc_teams::remove(&session, &member_id, &by(), tickets, body.reassign_to.as_deref())
        .await
        .map_err(team_value_422)?;
    invalidate().await;
    Ok(Json(result))
}

// --------------------------------------------------------------------------- settings

/// The project's AI settings for the API. `reports_cost`: a run of the project has reported a real cost.
fn settings_dict(s: &ai_project_settings::Model, reports_cost: bool) -> Value {
    json!({
        "reports_cost": reports_cost,
        "project_id": s.project_id,
        "paused_all": s.paused_all,
        "paused_at": s.paused_at,
        "paused_reason": s.paused_reason,
        "board_daily_cap": s.board_daily_cap,
        "board_monthly_budget": s.board_monthly_budget,
        "board_tokens_per_day": s.board_tokens_per_day,
        "board_max_parallel": s.board_max_parallel,
        "board_runs_per_day": s.board_runs_per_day,
        "board_at_cap": s.board_at_cap,
        "run_memory_limit_mb": s.run_memory_limit_mb,
        "audit_retention_days": s.audit_retention_days,
        "permission_mode": s.permission_mode,
        "deny_list": loads(Some(&s.deny_list), json!([])),
        "lessons_mode": s.lessons_mode,
        "lessons_max": s.lessons_max,
        "ops": loads(Some(&s.ops), json!({})),
    })
}

/// The settings as the API shows them, with the cost flag of the project.
async fn settings_view(session: &Session, settings: &ai_project_settings::Model) -> ApiResult<Json<Value>> {
    Ok(Json(settings_dict(settings, svc_budget::reports_cost(session, &settings.project_id).await?)))
}

/// The project's AI settings.
async fn get_ai_settings(Path(project_id): Path<String>) -> ApiResult<Json<Value>> {
    let session = kb_db::session();
    project_exists(&session, &project_id).await?;
    let settings = get_settings(&session, &project_id).await?;
    settings_view(&session, &settings).await
}

/// `SettingsBody`'s fields, in the order the model declares them.
const SETTINGS_FIELDS: [(&str, Kind); 13] = [
    ("board_daily_cap", Kind::Float),
    ("board_monthly_budget", Kind::Float),
    ("board_tokens_per_day", Kind::Int),
    ("board_max_parallel", Kind::Int),
    ("board_runs_per_day", Kind::Int),
    ("board_at_cap", Kind::Str),
    ("run_memory_limit_mb", Kind::Int),
    ("audit_retention_days", Kind::Int),
    ("permission_mode", Kind::Str),
    ("deny_list", Kind::StrList),
    ("lessons_mode", Kind::Str),
    ("lessons_max", Kind::Int),
    ("ops", Kind::Object),
];

/// `data.get(key)`, a text (or None).
fn text_in<'a>(data: &'a Map<String, Value>, key: &str) -> Option<&'a str> {
    data.get(key).and_then(Value::as_str)
}

/// The value of an integer column (`None` for null); a number that does not fit the column is a 422.
fn int_column(key: &str, value: &Value) -> ApiResult<Option<i32>> {
    if value.is_null() {
        return Ok(None);
    }
    match value.as_i64().and_then(|n| i32::try_from(n).ok()) {
        Some(n) => Ok(Some(n)),
        None => Err(ApiError::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            json!([{"type": "int_parsing", "loc": ["body", key], "msg": "Input should be a valid integer"}]),
        )),
    }
}

/// `setattr(settings, key, value)` for a column other than `deny_list` and `ops`, after the check that a column that
/// cannot be empty is not given null.
fn set_column(settings: &mut ai_project_settings::Model, key: &str, value: &Value) -> ApiResult<()> {
    let empty = value.is_null();
    let cannot_be_empty = matches!(
        key,
        "board_max_parallel"
            | "board_at_cap"
            | "run_memory_limit_mb"
            | "permission_mode"
            | "lessons_mode"
            | "lessons_max"
    );
    if empty && cannot_be_empty {
        let spaced = key.replace('_', " ");
        let mut chars = spaced.chars();
        let capital = chars.next().map(|c| c.to_uppercase().collect::<String>() + chars.as_str()).unwrap_or_default();
        return Err(ApiError::unprocessable(format!("{capital} cannot be empty.")));
    }
    let text = || value.as_str().unwrap_or_default().to_string();
    match key {
        "board_daily_cap" => settings.board_daily_cap = value.as_f64(),
        "board_monthly_budget" => settings.board_monthly_budget = value.as_f64(),
        "board_tokens_per_day" => settings.board_tokens_per_day = int_column(key, value)?,
        "board_max_parallel" => settings.board_max_parallel = int_column(key, value)?.unwrap_or_default(),
        "board_runs_per_day" => settings.board_runs_per_day = int_column(key, value)?,
        "board_at_cap" => settings.board_at_cap = text(),
        "run_memory_limit_mb" => settings.run_memory_limit_mb = int_column(key, value)?.unwrap_or_default(),
        "audit_retention_days" => settings.audit_retention_days = int_column(key, value)?,
        "permission_mode" => settings.permission_mode = text(),
        "lessons_mode" => settings.lessons_mode = text(),
        "lessons_max" => settings.lessons_max = int_column(key, value)?.unwrap_or_default(),
        _ => {}
    }
    Ok(())
}

/// Change the project's AI settings.
async fn patch_ai_settings(
    Path(project_id): Path<String>,
    Body(body): Body<Map<String, Value>>,
) -> ApiResult<Json<Value>> {
    let data = fields(body, &SETTINGS_FIELDS)?;
    let session = kb_db::session();
    project_exists(&session, &project_id).await?;
    let mut settings = get_settings(&session, &project_id).await?;
    if !matches!(text_in(&data, "permission_mode"), None | Some("bypass" | "auto")) {
        return Err(ApiError::unprocessable("The permission mode is bypass or auto."));
    }
    if !matches!(text_in(&data, "board_at_cap"), None | Some("pause" | "stop")) {
        return Err(ApiError::unprocessable("At the cap: pause or stop."));
    }
    if !matches!(text_in(&data, "lessons_mode"), None | Some("auto" | "review")) {
        return Err(ApiError::unprocessable("Lessons are kept auto or after review."));
    }
    for (key, value) in &data {
        if key == "deny_list" || key == "ops" {
            continue;
        }
        set_column(&mut settings, key, value)?;
    }
    if let Some(list) = data.get("deny_list") {
        // `[str(r).strip() for r in (data["deny_list"] or []) if str(r).strip()]`
        let rules: Vec<String> = list
            .as_array()
            .map(|items| items.iter().filter_map(Value::as_str).map(|r| pytext::strip(r).to_string()).collect())
            .unwrap_or_default();
        let rules: Vec<String> = rules.into_iter().filter(|r| !r.is_empty()).collect();
        settings.deny_list = pyjson::dumps(&json!(rules));
    }
    if let Some(Value::Object(patch)) = data.get("ops") {
        svc_ops::update(&mut settings, patch);
    }
    let settings = save(&session, settings).await?;
    session.commit().await?;
    invalidate().await;
    settings_view(&session, &settings).await
}

/// Stop every AI of the project.
#[derive(Debug, Deserialize)]
struct PauseAllBody {
    #[serde(default)]
    reason: Option<String>,
    #[serde(default = "yes")]
    cancel_running: bool,
}

fn yes() -> bool {
    true
}

/// The kill switch: nothing new starts; running runs are cancelled unless asked to finish.
async fn post_pause_all(Path(project_id): Path<String>, Body(body): Body<PauseAllBody>) -> ApiResult<Json<Value>> {
    let session = kb_db::session();
    project_exists(&session, &project_id).await?;
    let mut settings = get_settings(&session, &project_id).await?;
    settings.paused_all = true;
    settings.paused_at = Some(kbtime::now_iso());
    // `body.reason or f"Paused by {_by()}"`
    settings.paused_reason = Some(match body.reason.as_deref() {
        Some(reason) if !reason.is_empty() => reason.to_string(),
        _ => format!("Paused by {}", by()),
    });
    let settings = save(&session, settings).await?;
    session.commit().await?;
    let reason = settings.paused_reason.clone().unwrap_or_default();
    let mut detail = Map::new();
    detail.insert("reason".into(), json!(reason));
    detail.insert("cancel_running".into(), json!(body.cancel_running));
    svc_touches::record_pause(&project_id, "project_paused", &by(), Some(detail)).await;
    if body.cancel_running {
        for r in active_runs(&session, None, None).await? {
            if r.project_id == project_id && matches!(r.state.as_str(), "starting" | "running" | "queued") {
                match svc_runs::cancel(&r.id, &by(), Some(&reason), None, false).await {
                    Ok(_) => {}
                    Err(err) if err.is_run_error() => {}
                    Err(err) => return Err(run_value(err, 500)),
                }
            }
        }
    }
    invalidate().await;
    settings_view(&session, &settings).await
}

/// Lift the kill switch.
async fn post_resume_all(Path(project_id): Path<String>) -> ApiResult<Json<Value>> {
    let session = kb_db::session();
    project_exists(&session, &project_id).await?;
    let mut settings = get_settings(&session, &project_id).await?;
    settings.paused_all = false;
    settings.paused_at = None;
    settings.paused_reason = None;
    let settings = save(&session, settings).await?;
    session.commit().await?;
    svc_touches::record_pause(&project_id, "project_resumed", &by(), None).await;
    svc_runs::RT.wake.set();
    invalidate().await;
    settings_view(&session, &settings).await
}

// --------------------------------------------------------------------------- overview and board

fn text_of(team: &Map<String, Value>, key: &str) -> Value {
    team.get(key).cloned().unwrap_or(Value::Null)
}

/// Counts for the AI Team page header: teams, runs by state, the kill switch. No steps.
async fn get_overview(Path(project_id): Path<String>) -> ApiResult<Json<Value>> {
    let session = kb_db::session();
    project_exists(&session, &project_id).await?;
    let settings = get_settings(&session, &project_id).await?;
    let teams = svc_teams::list_teams(&session, &project_id, false).await.map_err(team_failure)?;
    let runs = ai_run::Entity::find().filter(ai_run::Column::ProjectId.eq(project_id.as_str())).all(&session).await?;
    let mut by_state = Map::new();
    for r in &runs {
        let n = by_state.get(&r.state).and_then(Value::as_i64).unwrap_or(0);
        by_state.insert(r.state.clone(), json!(n + 1));
    }
    let teams: Vec<Value> = teams
        .iter()
        .map(|t| {
            json!({
                "id": text_of(t, "id"),
                "name": text_of(t, "name"),
                "color": text_of(t, "color"),
                "status": text_of(t, "status"),
                "slots_in_use": text_of(t, "slots_in_use"),
                "queued": text_of(t, "queued"),
                "health": text_of(t, "health"),
            })
        })
        .collect();
    let active: Vec<Value> = runs
        .iter()
        .filter(|r| matches!(r.state.as_str(), "queued" | "starting" | "running" | "needs_input"))
        .map(|r| json!({"run_id": r.id, "ticket_id": r.ticket_id, "member_id": r.member_id, "state": r.state}))
        .collect();
    Ok(Json(json!({
        "project_id": project_id,
        "paused_all": settings.paused_all,
        "paused_reason": settings.paused_reason,
        "teams": teams,
        "runs": by_state,
        "active": active,
    })))
}

/// What a board card shows per ticket: the latest run's state, its team and when it moved. No steps.
async fn get_board(Path(project_id): Path<String>) -> ApiResult<Json<Value>> {
    let session = kb_db::session();
    project_exists(&session, &project_id).await?;
    let rows = ai_run::Entity::find()
        .filter(ai_run::Column::ProjectId.eq(project_id.as_str()))
        .filter(ai_run::Column::TicketId.is_not_null())
        .order_by_desc(ai_run::Column::QueuedAt)
        .all(&session)
        .await?;
    let mut out = Map::new();
    for r in rows {
        let Some(ticket_id) = r.ticket_id.clone() else { continue };
        if out.contains_key(&ticket_id) {
            continue;
        }
        let question = match r.question.as_deref() {
            Some(text) if !text.is_empty() => loads(Some(text), Value::Null),
            _ => Value::Null,
        };
        out.insert(
            ticket_id,
            json!({
                "run_id": r.id,
                "member_id": r.member_id,
                "state": r.state,
                "number": r.number,
                "started_at": r.started_at,
                "ended_at": r.ended_at,
                "last_output_at": r.last_output_at,
                "steps_count": r.steps_count,
                "summary": r.summary,
                "question": question,
            }),
        );
    }
    Ok(Json(json!({"tickets": out})))
}

// --------------------------------------------------------------------------- runs

/// `_run`: the run, or the 404.
async fn run_of(session: &Session, run_id: &str) -> ApiResult<ai_run::Model> {
    match ai_run::Entity::find_by_id(run_id).one(session).await? {
        Some(run) => Ok(run),
        None => Err(ApiError::not_found("Run not found")),
    }
}

/// Start a run on a ticket, or tell its running lead something.
#[derive(Debug, Deserialize)]
struct RunBody {
    #[serde(default)]
    team_id: Option<String>,
    #[serde(default)]
    instruction: Option<String>,
    #[serde(default)]
    mode: RunMode,
}

/// `Literal["work", "ask"]`.
#[derive(Debug, Default, Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
enum RunMode {
    #[default]
    Work,
    Ask,
}

/// Run the ticket's team on it (the assignee, the given team, or the project's only team). A lead already on the
/// ticket hears the instruction instead of a second run starting.
async fn post_ticket_run(
    Path(ticket_id): Path<String>,
    Body(body): Body<RunBody>,
) -> ApiResult<Json<Map<String, Value>>> {
    let session = kb_db::session();
    let mode = match body.mode {
        RunMode::Work => "work",
        RunMode::Ask => "ask",
    };
    let run = svc_runs::start_on_ticket(
        &session,
        &ticket_id,
        body.team_id.as_deref(),
        &by(),
        body.instruction.as_deref().unwrap_or(""),
        mode,
    )
    .await
    .map_err(|err| match err {
        RunError::Conflict(message) => ApiError::code(409, message),
        other => run_value(other, 422),
    })?;
    invalidate().await;
    Ok(Json(svc_runs::to_dict(&run)))
}

#[derive(Debug, Deserialize)]
struct TicketRunsQuery {
    #[serde(default = "thirty")]
    limit: i64,
}

fn thirty() -> i64 {
    30
}

/// The ticket's runs, newest first, without steps.
async fn get_ticket_runs(
    Path(ticket_id): Path<String>,
    Query(query): Query<TicketRunsQuery>,
) -> ApiResult<Json<Vec<Map<String, Value>>>> {
    let session = kb_db::session();
    let rows = ai_run::Entity::find()
        .filter(ai_run::Column::TicketId.eq(ticket_id.as_str()))
        .order_by_desc(ai_run::Column::QueuedAt)
        .limit(limit_of(query.limit))
        .all(&session)
        .await?;
    Ok(Json(rows.iter().map(svc_runs::to_dict).collect()))
}

#[derive(Debug, Deserialize)]
struct ProjectRunsQuery {
    #[serde(default = "sixty")]
    limit: i64,
    #[serde(default)]
    state: Option<String>,
}

fn sixty() -> i64 {
    60
}

/// The project's runs, newest first, without steps.
async fn get_project_runs(
    Path(project_id): Path<String>,
    Query(query): Query<ProjectRunsQuery>,
) -> ApiResult<Json<Vec<Map<String, Value>>>> {
    let session = kb_db::session();
    project_exists(&session, &project_id).await?;
    let mut stmt = ai_run::Entity::find().filter(ai_run::Column::ProjectId.eq(project_id.as_str()));
    if let Some(state) = query.state.as_deref().filter(|s| !s.is_empty()) {
        stmt = stmt.filter(ai_run::Column::State.is_in(state.split(',')));
    }
    let rows = stmt.order_by_desc(ai_run::Column::QueuedAt).limit(limit_of(query.limit)).all(&session).await?;
    Ok(Json(rows.iter().map(svc_runs::to_dict).collect()))
}

#[derive(Debug, Deserialize)]
struct RunQuery {
    #[serde(default = "fifty")]
    steps: i64,
}

fn fifty() -> i64 {
    50
}

/// One run with its subagents and its newest `steps` steps.
async fn get_run(Path(run_id): Path<String>, Query(query): Query<RunQuery>) -> ApiResult<Json<Value>> {
    let session = kb_db::session();
    let run = run_of(&session, &run_id).await?;
    let mut out = svc_runs::to_dict(&run);
    out.insert("agents".into(), json!(svc_steps::agents(&session, &run_id).await?));
    out.insert("steps".into(), json!(svc_steps::read(&session, &run_id, 0, limit_of(query.steps), None, true).await?));
    Ok(Json(Value::Object(out)))
}

#[derive(Debug, Deserialize)]
struct StepsQuery {
    #[serde(default)]
    after: i64,
    #[serde(default = "two_hundred")]
    limit: i64,
    #[serde(default)]
    agent: Option<String>,
}

fn two_hundred() -> i64 {
    200
}

/// A page of steps after `after` (a seq); `agent` = lead or an agent id.
async fn get_run_steps(Path(run_id): Path<String>, Query(query): Query<StepsQuery>) -> ApiResult<Json<Vec<Value>>> {
    let session = kb_db::session();
    run_of(&session, &run_id).await?;
    let after = i32::try_from(query.after).unwrap_or(if query.after < 0 { i32::MIN } else { i32::MAX });
    let limit = query.limit.min(500);
    Ok(Json(svc_steps::read(&session, &run_id, after, limit_of(limit), query.agent.as_deref(), false).await?))
}

#[derive(Debug, Deserialize)]
struct StepAt {
    run_id: String,
    seq: i32,
}

/// One step with what its command printed.
async fn get_step_output(Path(at): Path<StepAt>) -> ApiResult<Json<Value>> {
    let session = kb_db::session();
    run_of(&session, &at.run_id).await?;
    match svc_steps::output(&session, &at.run_id, at.seq).await? {
        Some(out) => Ok(Json(out)),
        None => Err(ApiError::not_found("Step not found")),
    }
}

/// Messages into and out of the run.
async fn get_run_messages(Path(run_id): Path<String>) -> ApiResult<Json<Vec<Value>>> {
    let session = kb_db::session();
    run_of(&session, &run_id).await?;
    let rows = ai_run_message::Entity::find()
        .filter(ai_run_message::Column::RunId.eq(run_id.as_str()))
        .order_by_asc(ai_run_message::Column::At)
        .all(&session)
        .await?;
    Ok(Json(
        rows.iter()
            .map(|m| {
                json!({
                    "id": m.id,
                    "direction": m.direction,
                    "peer": m.peer,
                    "text": m.text,
                    "at": m.at,
                    "delivered_at": m.delivered_at,
                })
            })
            .collect(),
    ))
}

/// A message or an answer.
#[derive(Debug, Deserialize)]
struct TextBody {
    #[serde(default)]
    text: String,
}

/// Stop the run; files stay as they are.
async fn post_cancel(Path(run_id): Path<String>) -> ApiResult<Json<Map<String, Value>>> {
    let session = kb_db::session();
    run_of(&session, &run_id).await?;
    let run = svc_runs::cancel(&run_id, &by(), None, None, false).await.map_err(|e| run_value(e, 409))?;
    invalidate().await;
    run_dict(run)
}

/// Start the run's Claude Code again inside the same run: it resumes its conversation and memory is released.
async fn post_restart(Path(run_id): Path<String>) -> ApiResult<Json<Value>> {
    let session = kb_db::session();
    run_of(&session, &run_id).await?;
    svc_runs::restart_run(&run_id, &by()).await.map_err(|e| run_value(e, 409))?;
    invalidate().await;
    Ok(Json(json!({"restarting": true})))
}

/// RAM and CPU of the machine, the project's limits, and its running (and recently ended) runs.
async fn get_resources(Path(project_id): Path<String>) -> ApiResult<Json<Map<String, Value>>> {
    let session = kb_db::session();
    project_exists(&session, &project_id).await?;
    Ok(Json(svc_resources::snapshot(&project_id).await?))
}

/// The closed conversations of the ticket's team, newest first.
async fn get_sessions(Path(ticket_id): Path<String>) -> ApiResult<Json<Vec<Map<String, Value>>>> {
    Ok(Json(session_history::list_for_ticket(&ticket_id, 20).await?))
}

/// Start the team over on this ticket: its conversation is closed into the history, the next run begins anew.
async fn post_new_session(Path(ticket_id): Path<String>) -> ApiResult<Json<Map<String, Value>>> {
    let row = session_history::start_over(&ticket_id, &by()).await.map_err(|e| run_value(e, 409))?;
    invalidate().await;
    Ok(Json(row))
}

/// `/compact` in the ticket chat: the lead's conversation is summarised (when it is working, after its step).
async fn post_compact(Path(ticket_id): Path<String>) -> ApiResult<Json<Map<String, Value>>> {
    Ok(Json(compact::compact_ticket(&ticket_id, &by()).await.map_err(|e| run_value(e, 409))?))
}

/// Answer the lead's question; the run resumes its conversation.
async fn post_answer(Path(run_id): Path<String>, Body(body): Body<TextBody>) -> ApiResult<Json<Map<String, Value>>> {
    let session = kb_db::session();
    run_of(&session, &run_id).await?;
    let run = svc_runs::answer(&run_id, &by(), &body.text).await.map_err(|e| run_value(e, 409))?;
    invalidate().await;
    run_dict(run)
}

/// Tell the run something: live when its lead runs, else its next turn.
async fn post_message(Path(run_id): Path<String>, Body(body): Body<TextBody>) -> ApiResult<Json<Map<String, Value>>> {
    let session = kb_db::session();
    run_of(&session, &run_id).await?;
    let out = svc_runs::send_message(&run_id, &body.text, &by(), None, true).await.map_err(|e| run_value(e, 422))?;
    Ok(Json(out))
}

/// A new run on the same ticket and conversation.
async fn post_retry(Path(run_id): Path<String>) -> ApiResult<Json<Map<String, Value>>> {
    let session = kb_db::session();
    run_of(&session, &run_id).await?;
    let run = svc_runs::retry(&run_id, &by()).await.map_err(|e| run_value(e, 409))?;
    invalidate().await;
    Ok(Json(svc_runs::to_dict(&run)))
}

#[derive(Debug, Deserialize)]
struct LiveQuery {
    #[serde(default = "hundred")]
    limit: i64,
}

fn hundred() -> i64 {
    100
}

/// The newest steps of the project's active runs (the live panel).
async fn get_live(Path(project_id): Path<String>, Query(query): Query<LiveQuery>) -> ApiResult<Json<Value>> {
    let session = kb_db::session();
    project_exists(&session, &project_id).await?;
    let rows = ai_run::Entity::find()
        .filter(ai_run::Column::ProjectId.eq(project_id.as_str()))
        .filter(ai_run::Column::State.is_in(["starting", "running", "needs_input"]))
        .all(&session)
        .await?;
    let limit = query.limit;
    // `max(5, limit // max(1, len(rows)))`: floor division
    let each = limit.div_euclid((rows.len() as i64).max(1)).max(5);
    let mut out: Vec<Value> = Vec::new();
    for r in &rows {
        for mut s in svc_steps::read(&session, &r.id, 0, limit_of(each), None, true).await? {
            if let Value::Object(map) = &mut s {
                map.insert("ticket_id".into(), json!(r.ticket_id));
                map.insert("member_id".into(), json!(r.member_id));
            }
            out.push(s);
        }
    }
    out.sort_by(|a, b| {
        let at = |v: &Value| v.get("at").and_then(Value::as_str).unwrap_or_default().to_string();
        at(a).cmp(&at(b))
    });
    // `out[-limit:]`
    let start = if limit > 0 {
        out.len().saturating_sub(limit as usize)
    } else if limit == 0 {
        0
    } else {
        (limit.unsigned_abs() as usize).min(out.len())
    };
    let steps = out.split_off(start);
    Ok(Json(
        json!({"runs": rows.iter().map(|r| Value::Object(svc_runs::to_dict(r))).collect::<Vec<_>>(), "steps": steps}),
    ))
}

/// What each team's lead and roles do now, when they last worked, runs and steps today (no money: cost is per run).
async fn get_project_activity(Path(project_id): Path<String>) -> ApiResult<Json<Value>> {
    let session = kb_db::session();
    project_exists(&session, &project_id).await?;
    let teams: Vec<Value> = svc_teams::list_teams(&session, &project_id, false)
        .await
        .map_err(team_failure)?
        .into_iter()
        .map(Value::Object)
        .collect();
    Ok(Json(json!({"teams": svc_activity_roles::project_activity(&session, &teams).await?})))
}

/// One team's lead and roles: now, last worked, runs and steps today.
async fn get_team_activity(Path(member_id): Path<String>) -> ApiResult<Json<Value>> {
    let session = kb_db::session();
    let (member, profile) = team_of(&session, &member_id).await?;
    let team = svc_teams::describe(&session, &member, &profile, None).await.map_err(team_failure)?;
    let keys: Vec<String> = match team.get("roles") {
        Some(Value::Array(roles)) => {
            roles.iter().map(|r| r.get("key").and_then(Value::as_str).unwrap_or_default().to_string()).collect()
        }
        _ => Vec::new(),
    };
    Ok(Json(svc_activity_roles::team_activity(&session, &member_id, &keys).await?))
}

#[derive(Debug, Deserialize)]
struct RecentQuery {
    #[serde(default)]
    team_id: Option<String>,
    #[serde(default = "eight")]
    limit: i64,
}

fn eight() -> i64 {
    8
}

/// Runs that just ended with the first line of their report, and the latest notes into and out of runs.
async fn get_recent(Path(project_id): Path<String>, Query(query): Query<RecentQuery>) -> ApiResult<Json<Value>> {
    let session = kb_db::session();
    project_exists(&session, &project_id).await?;
    let limit = query.limit.clamp(1, 50) as u64;
    Ok(Json(svc_activity_roles::recent(&session, &project_id, query.team_id.as_deref(), limit).await?))
}

/// Whether the query string names `name` with no value (`since=`): `Option<String>` reads that as absent, Pydantic's
/// `Optional[datetime]` refuses it.
fn named_empty(raw: Option<&str>, name: &str) -> bool {
    let pairs: Vec<(String, String)> = serde_urlencoded::from_str(raw.unwrap_or_default()).unwrap_or_default();
    pairs.iter().any(|(key, value)| key == name && value.is_empty())
}

/// The query of the Timeline and the Flow map.
#[derive(Debug, Deserialize)]
struct WindowQuery {
    #[serde(default = "today")]
    range: String,
    #[serde(default)]
    since: Option<String>,
    #[serde(default)]
    until: Option<String>,
    #[serde(default)]
    ticket_id: Option<String>,
    #[serde(default)]
    team_id: Option<String>,
}

fn today() -> String {
    "today".to_string()
}

/// `Optional[datetime]` of a query string, as Pydantic reads it: ISO 8601 (a date alone is midnight), or seconds
/// since the epoch. A value with no zone is read as UTC.
fn datetime_query(name: &str, value: Option<&str>) -> ApiResult<Option<DateTime<FixedOffset>>> {
    let Some(text) = value else { return Ok(None) };
    let bad = || {
        ApiError::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            json!([{"type": "datetime_from_date_parsing", "loc": ["query", name],
                    "msg": "Input should be a valid datetime or date"}]),
        )
    };
    if let Some(parsed) = kbtime::parse_iso(text) {
        return Ok(Some(match parsed {
            kbtime::Parsed::Aware(at) => at,
            kbtime::Parsed::Naive(at) => Utc.from_utc_datetime(&at).fixed_offset(),
        }));
    }
    match pytext::strip(text).parse::<f64>() {
        Ok(seconds) if seconds.is_finite() => {
            let micros = (seconds * 1_000_000.0).round() as i64;
            DateTime::<Utc>::from_timestamp_micros(micros).map(|at| Some(at.fixed_offset())).ok_or_else(bad)
        }
        _ => Err(bad()),
    }
}

/// The Timeline: a sequence diagram of the teams' runs in a window (the whole project, one team or one ticket).
async fn get_timeline(
    Path(project_id): Path<String>,
    RawQuery(raw): RawQuery,
    Query(query): Query<WindowQuery>,
) -> ApiResult<Json<Value>> {
    let session = kb_db::session();
    let since = datetime_query("since", query.since.as_deref().or(named_empty(raw.as_deref(), "since").then_some("")))?;
    let until = datetime_query("until", query.until.as_deref().or(named_empty(raw.as_deref(), "until").then_some("")))?;
    project_exists(&session, &project_id).await?;
    let opts =
        TimelineOpts { range_key: query.range, since, until, ticket_id: query.ticket_id, team_id: query.team_id };
    Ok(Json(svc_timeline::timeline(&session, &project_id, &opts).await?))
}

/// Flow, the Map: the person, the teams (with their roles) and the tickets worked, and the edges between them.
async fn get_flow_map(
    Path(project_id): Path<String>,
    RawQuery(raw): RawQuery,
    Query(query): Query<WindowQuery>,
) -> ApiResult<Json<Value>> {
    let session = kb_db::session();
    let since = datetime_query("since", query.since.as_deref().or(named_empty(raw.as_deref(), "since").then_some("")))?;
    let until = datetime_query("until", query.until.as_deref().or(named_empty(raw.as_deref(), "until").then_some("")))?;
    project_exists(&session, &project_id).await?;
    let opts = FlowOpts { range_key: query.range, since, until, ticket_id: query.ticket_id, team_id: query.team_id };
    Ok(Json(svc_flow::flow_map(&session, &project_id, &opts).await?))
}

/// Flow's scope picker: the teams, the Stories and the tickets with AI work.
async fn get_flow_scopes(Path(project_id): Path<String>) -> ApiResult<Json<Value>> {
    let session = kb_db::session();
    project_exists(&session, &project_id).await?;
    Ok(Json(svc_flow::flow_scopes(&session, &project_id).await?))
}

// --------------------------------------------------------------------------- You stepped in

/// `Literal["needed", "avoidable"]`.
#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
enum Mark {
    Needed,
    Avoidable,
}

/// The mark a person gives to one touch.
#[derive(Debug, Deserialize)]
struct MarkBody {
    key: String,
    #[serde(default)]
    mark: Option<Mark>,
}

/// The lesson a person writes from an avoidable touch (empty: a draft).
#[derive(Debug, Deserialize)]
struct TouchLessonBody {
    key: String,
    #[serde(default)]
    text: Option<String>,
}

#[derive(Debug, Deserialize)]
struct TouchesQuery {
    #[serde(default = "seven_days")]
    range: String,
    #[serde(default)]
    team_id: Option<String>,
    #[serde(default)]
    kind: Option<String>,
    #[serde(default)]
    mark: Option<String>,
}

fn seven_days() -> String {
    "7d".to_string()
}

/// A touch service's failure: a `TouchError` is the 409 of these routes.
fn touch_failure(err: svc_touches::Error) -> ApiError {
    match err {
        svc_touches::Error::Touch(message) => ApiError::conflict(message),
        svc_touches::Error::Db(err) => err.into(),
        svc_touches::Error::Other(message) => ApiError::internal(message),
    }
}

/// Every time a person had to touch the work of the project's AI teams, newest first, in a range.
async fn get_touches(Path(project_id): Path<String>, Query(query): Query<TouchesQuery>) -> ApiResult<Json<Value>> {
    let session = kb_db::session();
    project_exists(&session, &project_id).await?;
    let out = svc_touches::stepped_in(
        &session,
        &project_id,
        &query.range,
        query.team_id.as_deref(),
        query.kind.as_deref(),
        query.mark.as_deref(),
    )
    .await?;
    Ok(Json(Value::Object(out)))
}

/// Mark a touch needed or avoidable (mark null takes the mark away). The mark stays.
async fn put_touch_mark(
    Path(project_id): Path<String>,
    Body(body): Body<MarkBody>,
) -> ApiResult<Json<Map<String, Value>>> {
    let session = kb_db::session();
    project_exists(&session, &project_id).await?;
    let mark = body.mark.map(|m| match m {
        Mark::Needed => "needed",
        Mark::Avoidable => "avoidable",
    });
    let out = svc_touches::set_mark(&session, &project_id, &body.key, mark, &by()).await.map_err(touch_failure)?;
    invalidate().await;
    Ok(Json(out))
}

/// "Make a lesson" from an avoidable touch: a proposed lesson in Memory.
async fn post_touch_lesson(
    Path(project_id): Path<String>,
    Body(body): Body<TouchLessonBody>,
) -> ApiResult<(StatusCode, Json<Map<String, Value>>)> {
    let session = kb_db::session();
    project_exists(&session, &project_id).await?;
    let out = svc_touches::make_lesson(&session, &project_id, &body.key, body.text.as_deref(), &by())
        .await
        .map_err(touch_failure)?;
    invalidate().await;
    Ok((StatusCode::CREATED, Json(out)))
}

// --------------------------------------------------------------------------- Health

#[derive(Debug, Deserialize)]
struct HealthQuery {
    #[serde(default = "seven_days")]
    range: String,
}

/// Is the AI team healthy: a verdict, five measures, a row per team and what to fix (last 7 or 30 days).
async fn get_health(Path(project_id): Path<String>, Query(query): Query<HealthQuery>) -> ApiResult<Json<Value>> {
    let session = kb_db::session();
    project_exists(&session, &project_id).await?;
    Ok(Json(Value::Object(svc_health::health(&session, &project_id, &query.range).await?)))
}
