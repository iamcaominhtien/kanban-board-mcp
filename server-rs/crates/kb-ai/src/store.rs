//! Small loaders shared by the AI services (`services/ai/store.py`).

use std::collections::HashSet;

use chrono::{DateTime, FixedOffset};
use kb_base::time::{self, Parsed};
use kb_db::Session;
use kb_db::database;
use kb_db::entities::{ai_project_settings, ai_run, ai_team, member};
use kb_db::sea_orm::{ColumnTrait, DbErr, EntityTrait, QueryFilter};
use serde_json::Value;

/// Current UTC time, ISO formatted.
pub fn now_iso() -> String {
    time::now_iso()
}

/// Parse an ISO time, or None. A time without an offset is read as UTC.
pub fn parse_iso(value: Option<&str>) -> Option<DateTime<FixedOffset>> {
    let value = value.filter(|v| !v.is_empty())?;
    match time::parse_iso(value)? {
        Parsed::Aware(dt) => Some(dt),
        Parsed::Naive(dt) => {
            Some(chrono::TimeZone::from_utc_datetime(&FixedOffset::east_opt(0)?, &dt))
        }
    }
}

/// `json.loads` that falls back to `default` (for `None`, an empty string or text that is not JSON).
pub fn loads(value: Option<&str>, default: Value) -> Value {
    match value {
        None | Some("") => default,
        Some(text) => serde_json::from_str(text).unwrap_or(default),
    }
}

/// The Member row and its AI profile (either may be None).
pub async fn get_profile(
    session: &Session,
    member_id: &str,
) -> Result<(Option<member::Model>, Option<ai_team::Model>), DbErr> {
    let member = member::Entity::find_by_id(member_id).one(session).await?;
    let profile = ai_team::Entity::find_by_id(member_id).one(session).await?;
    Ok((member, profile))
}

/// The project's AI settings, created with defaults on first use.
pub async fn get_settings(session: &Session, project_id: &str) -> Result<ai_project_settings::Model, DbErr> {
    if let Some(settings) = ai_project_settings::Entity::find_by_id(project_id).one(session).await? {
        return Ok(settings);
    }
    let mut row = ai_project_settings::new();
    row.project_id = kb_db::sea_orm::ActiveValue::Set(project_id.to_string());
    database::insert_missing(session, row).await?;
    session.commit().await?;
    ai_project_settings::Entity::find_by_id(project_id)
        .one(session)
        .await?
        .ok_or_else(|| DbErr::RecordNotFound(format!("ai_project_settings {project_id}")))
}

/// Names of the project's AI members (current and removed): text they wrote is data only.
pub async fn ai_names(session: &Session, project_id: &str) -> Result<HashSet<String>, DbErr> {
    let rows = member::Entity::find()
        .filter(member::Column::ProjectId.eq(project_id))
        .filter(member::Column::Kind.is_in(["ai", "ai_removed"]))
        .all(session)
        .await?;
    Ok(rows.into_iter().map(|m| m.name).collect())
}

/// Runs that are queued, starting, running or waiting for input.
pub async fn active_runs(
    session: &Session,
    member_id: Option<&str>,
    ticket_id: Option<&str>,
) -> Result<Vec<ai_run::Model>, DbErr> {
    let mut stmt =
        ai_run::Entity::find().filter(ai_run::Column::State.is_in(["queued", "starting", "running", "needs_input"]));
    if let Some(member_id) = member_id.filter(|m| !m.is_empty()) {
        stmt = stmt.filter(ai_run::Column::MemberId.eq(member_id));
    }
    if let Some(ticket_id) = ticket_id.filter(|t| !t.is_empty()) {
        stmt = stmt.filter(ai_run::Column::TicketId.eq(ticket_id));
    }
    stmt.all(session).await
}

/// Write every column of a row that the caller changed in memory: SQLAlchemy's `session.add(row)` followed by a
/// commit. Returns the stored row. The caller commits.
pub async fn save<C, M, A>(conn: &C, model: M) -> Result<<A::Entity as EntityTrait>::Model, DbErr>
where
    C: kb_db::sea_orm::ConnectionTrait,
    M: kb_db::sea_orm::IntoActiveModel<A>,
    A: kb_db::sea_orm::ActiveModelTrait + kb_db::sea_orm::ActiveModelBehavior + Send,
    <A::Entity as EntityTrait>::Model: kb_db::sea_orm::IntoActiveModel<A>,
{
    kb_db::sea_orm::ActiveModelTrait::update(model.into_active_model().reset_all(), conn).await
}

/// Python's `int(value)` for the JSON values a setting or an event may hold: `None` where Python raises.
pub fn py_int(value: &Value) -> Option<i128> {
    crate::ops::py_int(value)
}

fn text_value(value: &Value) -> String {
    match value {
        Value::String(s) => s.clone(),
        Value::Null => String::new(),
        other => kb_base::pyjson::py_str(other),
    }
}

fn opt_text(value: &Value) -> Option<String> {
    if value.is_null() { None } else { Some(text_value(value)) }
}

fn int_value(value: &Value) -> Option<i32> {
    py_int(value).and_then(|n| i32::try_from(n).ok())
}

fn float_value(value: &Value) -> Option<f64> {
    match value {
        Value::Number(n) => n.as_f64(),
        Value::Bool(b) => Some(f64::from(u8::from(*b))),
        _ => None,
    }
}

/// `setattr(run, key, value)` for a column of the run: puts `value` on the row's active model as a change. A key that
/// is not a column of `AiRun` is ignored (Python would put a plain attribute on the object that is never saved) and
/// `false` is returned; so is a value that does not fit the column.
pub fn set_run_field(row: &mut ai_run::ActiveModel, key: &str, value: &Value) -> bool {
    use kb_db::sea_orm::ActiveValue::Set;
    macro_rules! text {
        ($field:ident) => {{ row.$field = Set(text_value(value)); true }};
    }
    macro_rules! opt_text_field {
        ($field:ident) => {{ row.$field = Set(opt_text(value)); true }};
    }
    macro_rules! int {
        ($field:ident) => {
            match int_value(value) { Some(n) => { row.$field = Set(n); true } None => false }
        };
    }
    macro_rules! opt_int {
        ($field:ident) => {
            if value.is_null() { row.$field = Set(None); true } else {
                match int_value(value) { Some(n) => { row.$field = Set(Some(n)); true } None => false }
            }
        };
    }
    macro_rules! float {
        ($field:ident) => {
            match float_value(value) { Some(n) => { row.$field = Set(n); true } None => false }
        };
    }
    macro_rules! opt_float {
        ($field:ident) => {
            if value.is_null() { row.$field = Set(None); true } else {
                match float_value(value) { Some(n) => { row.$field = Set(Some(n)); true } None => false }
            }
        };
    }
    macro_rules! boolean {
        ($field:ident) => {{ row.$field = Set(kb_base::pyjson::truthy(value)); true }};
    }
    match key {
        "project_id" => text!(project_id),
        "kind" => text!(kind),
        "ticket_id" => opt_text_field!(ticket_id),
        "target" => opt_text_field!(target),
        "member_id" => text!(member_id),
        "number" => int!(number),
        "mode" => text!(mode),
        "trigger" => text!(trigger),
        "depth" => int!(depth),
        "state" => text!(state),
        "started_by" => text!(started_by),
        "instruction" => text!(instruction),
        "reply_comment_id" => opt_text_field!(reply_comment_id),
        "queued_at" => text!(queued_at),
        "started_at" => opt_text_field!(started_at),
        "ended_at" => opt_text_field!(ended_at),
        "last_output_at" => opt_text_field!(last_output_at),
        "ended_reason" => opt_text_field!(ended_reason),
        "ended_by" => opt_text_field!(ended_by),
        "exit_code" => opt_int!(exit_code),
        "summary" => opt_text_field!(summary),
        "report" => text!(report),
        "question" => opt_text_field!(question),
        "answer" => opt_text_field!(answer),
        "session_id" => opt_text_field!(session_id),
        "session_name" => opt_text_field!(session_name),
        "files" => text!(files),
        "tokens_in" => int!(tokens_in),
        "tokens_out" => int!(tokens_out),
        "tokens_cached" => opt_int!(tokens_cached),
        "cost_usd" => float!(cost_usd),
        "metered" => boolean!(metered),
        "context_used" => opt_int!(context_used),
        "context_window" => opt_int!(context_window),
        "pid" => opt_int!(pid),
        "token_hash" => opt_text_field!(token_hash),
        "model" => opt_text_field!(model),
        "effort" => opt_text_field!(effort),
        "paused" => boolean!(paused),
        "paused_at" => opt_text_field!(paused_at),
        "stop_code" => opt_text_field!(stop_code),
        "peak_rss_mb" => opt_float!(peak_rss_mb),
        "last_rss_mb" => opt_float!(last_rss_mb),
        "restarts" => text!(restarts),
        "diagnosis" => opt_text_field!(diagnosis),
        "retries" => text!(retries),
        "retry_at" => opt_text_field!(retry_at),
        "account_id" => opt_text_field!(account_id),
        "debug_log" => opt_text_field!(debug_log),
        "steps_count" => int!(steps_count),
        "waiting_reason" => opt_text_field!(waiting_reason),
        "live" => boolean!(live),
        "details_removed_at" => opt_text_field!(details_removed_at),
        _ => false,
    }
}
