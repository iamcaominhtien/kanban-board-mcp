//! Create, change, pause (`services/ai/schedules.py` lines 738 to 898): `_may_manage`, `create`, `update`,
//! `set_paused`, `delete`, `get_or_404`, `run_now`, `slot_action`.

use kb_ai::store::{now_iso, save};
use kb_base::time;
use kb_db::Session;
use kb_db::entities::{ai_schedule, ai_schedule_run, ticket};
use kb_db::sea_orm::{ActiveModelTrait, ActiveValue::Set, ColumnTrait, EntityTrait, ModelTrait, QueryFilter};
use serde_json::{Map, Value, json};

use super::check::{apply, assess_with, blank};
use super::notify::activity;
use super::read::lower_first;
use super::ticking::{CloseOpts, StartOpts, close, publish_board, try_start};
use super::when::{advance, when_label};
use super::{Error, OPEN, ScheduleError, refuse, role_of};
use crate::clock;

/// `_may_manage`: only who made the schedule, or an admin, changes it.
async fn may_manage(session: &Session, s: &ai_schedule::Model, by: &str) -> Result<(), Error> {
    if by == s.created_by {
        return Ok(());
    }
    if role_of(session, &s.project_id, by).await? == "admin" {
        return Ok(());
    }
    refuse("forbidden", format!("Only {} (who made it) or an admin can change this schedule.", s.created_by))
}

/// The problems of `assess` that stop a save, as the `ScheduleError` Python raises with them.
async fn refuse_problems(
    session: &Session,
    s: &ai_schedule::Model,
    by: &str,
    nulls: &[&'static str],
) -> Result<(), Error> {
    let problems: Vec<Value> =
        assess_with(session, s, by, None, nulls).await?.into_iter().filter(|c| c["level"] == "error").collect();
    if let Some(first) = problems.first() {
        let mut extra = Map::new();
        let message = first["text"].as_str().unwrap_or("").to_string();
        extra.insert("problems".into(), Value::Array(problems));
        return Err(Error::Schedule(ScheduleError { code: "invalid".to_string(), message, extra }));
    }
    Ok(())
}

/// `NOT NULL constraint failed`: what the database answers to a column that cannot be empty.
fn not_null<T>(column: &str) -> Result<T, Error> {
    Err(Error::Other(format!("NOT NULL constraint failed: ai_schedule.{column}")))
}

/// Validate and save; the first run is planned at once.
pub async fn create(
    session: &Session,
    project_id: &str,
    data: &Map<String, Value>,
    by: &str,
) -> Result<ai_schedule::Model, Error> {
    let mut s = blank(project_id, by)?;
    let nulls = apply(&mut s, data)?;
    refuse_problems(session, &s, by, &nulls).await?;
    // a field that was sent as `null` and that no check refused: a new row is stored with the column's default
    // (SQLAlchemy leaves a `None` out of an INSERT); a column without one cannot be empty
    let defaults = blank(project_id, by)?;
    for column in &nulls {
        match *column {
            "kind" => s.kind = defaults.kind.clone(),
            "time" => s.time = defaults.time.clone(),
            "tz" => s.tz = defaults.tz.clone(),
            "ends" => s.ends = defaults.ends.clone(),
            "catch_up" => s.catch_up = defaults.catch_up.clone(),
            "catch_up_hours" => s.catch_up_hours = defaults.catch_up_hours,
            "instruction" => s.instruction = defaults.instruction.clone(),
            other => return not_null(other),
        }
    }
    let ticket = ticket::Entity::find_by_id(s.ticket_id.as_str()).one(session).await?;
    s.ticket_seen_at = ticket.map(|t| t.updated_at);
    advance(&mut s, clock::now(), true)?;
    let s = ai_schedule::ActiveModel::from(s).reset_all().insert(session).await?;
    session.commit().await?;
    activity(
        &s.ticket_id,
        &format!("created a schedule for {}: {}", s.ticket_id, lower_first(&when_label(&s)?)),
        by,
        None,
    )
    .await?;
    publish_board().await;
    Ok(s)
}

/// Change settings; the next run is re-planned.
pub async fn update(
    session: &Session,
    schedule_id: &str,
    data: &Map<String, Value>,
    by: &str,
) -> Result<ai_schedule::Model, Error> {
    let mut s = get_or_404(session, schedule_id).await?;
    may_manage(session, &s, by).await?;
    if data.get("ticket_id").is_some_and(|wanted| *wanted != json!(s.ticket_id)) {
        return refuse("invalid", "A schedule stays on its ticket. Make a new one for another ticket.");
    }
    let nulls = apply(&mut s, data)?;
    // a column that cannot be empty was sent as `null`: the database refuses the UPDATE, which Python's session
    // sends before the first question of the checks
    if let Some(column) = nulls.first() {
        return not_null(column);
    }
    refuse_problems(session, &s, by, &nulls).await?;
    let ticket = ticket::Entity::find_by_id(s.ticket_id.as_str()).one(session).await?;
    s.ticket_seen_at = ticket.map(|t| t.updated_at);
    s.updated_at = now_iso();
    if s.state == "ended" {
        s.state = "active".to_string();
    }
    if s.state == "active" {
        advance(&mut s, clock::now(), true)?;
    }
    let s = save(session, s).await?;
    session.commit().await?;
    publish_board().await;
    Ok(s)
}

/// Pause or resume; resuming clears the failure count and plans the next run from now. (`reason` None: "Paused by
/// <who>".)
pub async fn set_paused(
    session: &Session,
    schedule_id: &str,
    paused: bool,
    by: &str,
    reason: Option<&str>,
) -> Result<ai_schedule::Model, Error> {
    let mut s = get_or_404(session, schedule_id).await?;
    may_manage(session, &s, by).await?;
    if paused {
        s.state = "paused".to_string();
        s.paused_reason =
            Some(reason.filter(|r| !r.is_empty()).map_or_else(|| format!("Paused by {by}"), str::to_string));
    } else {
        if s.state == "ended" {
            return refuse("invalid", "This schedule has ended. Edit it to plan new runs.");
        }
        s.state = "active".to_string();
        s.paused_reason = None;
        s.failures_in_row = 0;
        advance(&mut s, clock::now(), true)?;
    }
    s.updated_at = now_iso();
    let s = save(session, s).await?;
    session.commit().await?;
    publish_board().await;
    Ok(s)
}

/// Delete the schedule and its history; a run in progress keeps going as a normal run.
pub async fn delete(session: &Session, schedule_id: &str, by: &str) -> Result<(), Error> {
    let s = get_or_404(session, schedule_id).await?;
    may_manage(session, &s, by).await?;
    let runs = ai_schedule_run::Entity::find()
        .filter(ai_schedule_run::Column::ScheduleId.eq(s.id.as_str()))
        .all(session)
        .await?;
    for r in runs {
        r.delete(session).await?;
    }
    s.clone().delete(session).await?;
    session.commit().await?;
    activity(&s.ticket_id, &format!("deleted the schedule for {}", s.ticket_id), by, None).await?;
    publish_board().await;
    Ok(())
}

/// The schedule, or ScheduleError not_found.
pub async fn get_or_404(session: &Session, schedule_id: &str) -> Result<ai_schedule::Model, Error> {
    match ai_schedule::Entity::find_by_id(schedule_id).one(session).await? {
        Some(s) => Ok(s),
        None => refuse("not_found", "Schedule not found."),
    }
}

/// `await session.refresh(srun)`.
async fn refreshed(session: &Session, srun: ai_schedule_run::Model) -> Result<ai_schedule_run::Model, Error> {
    Ok(ai_schedule_run::Entity::find_by_id(srun.id.as_str()).one(session).await?.unwrap_or(srun))
}

/// Start a slot now, outside the plan (does not move the next planned run).
pub async fn run_now(session: &Session, schedule_id: &str, by: &str) -> Result<ai_schedule_run::Model, Error> {
    let s = get_or_404(session, schedule_id).await?;
    may_manage(session, &s, by).await?;
    let busy = ai_schedule_run::Entity::find()
        .filter(ai_schedule_run::Column::ScheduleId.eq(s.id.as_str()))
        .filter(ai_schedule_run::Column::State.is_in(OPEN))
        .one(session)
        .await?;
    if busy.is_some() {
        return refuse("conflict", "The last run of this schedule is still going.");
    }
    let mut srun = ai_schedule_run::new();
    srun.schedule_id = Set(s.id.clone());
    srun.project_id = Set(s.project_id.clone());
    srun.ticket_id = Set(s.ticket_id.clone());
    srun.slot_at = Set(time::iso(&clock::now()));
    let srun = srun.insert(session).await?;
    session.commit().await?;
    try_start(&srun.id, StartOpts { manual: true, ..Default::default() }).await?;
    refreshed(session, srun).await
}

/// A person answers a waiting slot: run it late, skip it, or run it on another AI.
pub async fn slot_action(
    session: &Session,
    srun_id: &str,
    action: &str,
    by: &str,
    member_id: Option<&str>,
) -> Result<ai_schedule_run::Model, Error> {
    let Some(srun) = ai_schedule_run::Entity::find_by_id(srun_id).one(session).await? else {
        return refuse("not_found", "Scheduled run not found.");
    };
    let s = get_or_404(session, &srun.schedule_id).await?;
    may_manage(session, &s, by).await?;
    if !matches!(srun.state.as_str(), "waiting" | "ask") {
        return refuse("conflict", "This run is not waiting any more.");
    }
    match action {
        "skip" => close(&srun.id, "skipped", Some(format!("Skipped by {by}.")), CloseOpts::default()).await?,
        "start" | "use_member" => {
            try_start(&srun.id, StartOpts { manual: true, member_id, ..Default::default() }).await?;
        }
        _ => return refuse("invalid", "action must be start, skip or use_member."),
    }
    refreshed(session, srun).await
}
