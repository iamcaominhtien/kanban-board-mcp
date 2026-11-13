//! Validation and preview (`services/ai/schedules.py` lines 368 to 735): `FIELDS`, `_apply`, `availability`,
//! `_slots_in_use`, `_running_tickets`, `assess`, `_overlaps`, `_offline_risk`, `_offline_history`, `preview`.

use chrono::{DateTime, Duration, Utc};
use kb_ai::budget;
use kb_ai::store::{get_profile, get_settings, loads, py_int};
use kb_base::{pyjson, time};
use kb_db::Session;
use kb_db::entities::{ai_run, ai_schedule, ai_schedule_run, ai_team, ticket};
use kb_db::sea_orm::ActiveValue::Set;
use kb_db::sea_orm::{ColumnTrait, DbErr, EntityTrait, QueryFilter, QueryOrder, QuerySelect, TryIntoModel};
use serde_json::{Map, Value, json};

use super::read::{limits_of, summary_text};
use super::when::{day_name, fmt_day, fold_of, hm, in_words, once_at, slots, wall_to_utc, zone};
use super::{BUSY_MAX_WAIT_MIN, Error, role_of};
use crate::clock;
use crate::pynum::fmt_g;

/// The fields of a schedule a person sets, in the order they are applied.
pub const FIELDS: [&str; 18] = [
    "ticket_id",
    "member_id",
    "backup_member_id",
    "kind",
    "run_at",
    "days",
    "time",
    "tz",
    "ends",
    "ends_after",
    "ends_on",
    "window_end",
    "limits",
    "catch_up",
    "catch_up_hours",
    "notify",
    "notify_people",
    "instruction",
];
/// The fields kept as JSON text.
pub const JSON_FIELDS: [&str; 4] = ["days", "limits", "notify", "notify_people"];

/// `AiSchedule(project_id=project_id, ticket_id="", member_id="", created_by=by)`: a schedule that is not stored.
pub(crate) fn blank(project_id: &str, by: &str) -> Result<ai_schedule::Model, Error> {
    let mut s = ai_schedule::new();
    s.project_id = Set(project_id.to_string());
    s.ticket_id = Set(String::new());
    s.member_id = Set(String::new());
    s.created_by = Set(by.to_string());
    s.try_into_model().map_err(Error::Db)
}

fn wrong_kind<T>(key: &str, value: &Value) -> Result<T, Error> {
    Err(Error::Other(format!("{key} cannot be {value}")))
}

/// `_apply`: put the sent fields on the schedule. Returns the fields that were sent as `null` although their column
/// cannot be empty (Python keeps `None` on the object; here the model holds the empty value, and what Python does
/// with the `None` is done by the callers: see `assess_with` and `create`).
pub fn apply(s: &mut ai_schedule::Model, data: &Map<String, Value>) -> Result<Vec<&'static str>, Error> {
    let mut nulls: Vec<&'static str> = Vec::new();
    for key in FIELDS {
        let Some(value) = data.get(key) else { continue };
        if JSON_FIELDS.contains(&key) {
            let text = match value {
                Value::Null if key == "limits" => pyjson::dumps(&json!({})),
                Value::Null => pyjson::dumps(&json!([])),
                value => pyjson::dumps(value),
            };
            match key {
                "days" => s.days = text,
                "limits" => s.limits = text,
                "notify" => s.notify = text,
                _ => s.notify_people = text,
            }
            continue;
        }
        match key {
            "backup_member_id" | "window_end" | "ends_on" | "run_at" => {
                let text = match value {
                    Value::Null => None,
                    Value::String(text) => Some(text.clone()).filter(|t| !t.is_empty()),
                    other => return wrong_kind(key, other),
                };
                match key {
                    "backup_member_id" => s.backup_member_id = text,
                    "window_end" => s.window_end = text,
                    "ends_on" => s.ends_on = text,
                    _ => s.run_at = text,
                }
            }
            "ends_after" => {
                s.ends_after = match value {
                    Value::Null => None,
                    Value::Number(_) | Value::Bool(_) => match py_int(value).map(i32::try_from) {
                        Some(Ok(n)) => Some(n),
                        _ => return wrong_kind(key, value),
                    },
                    other => return wrong_kind(key, other),
                };
            }
            "catch_up_hours" => {
                s.catch_up_hours = match value {
                    Value::Null => {
                        nulls.push(key);
                        kb_db::Float(0.0)
                    }
                    Value::Number(n) => n.as_f64().unwrap_or(0.0).into(),
                    Value::Bool(b) => f64::from(u8::from(*b)).into(),
                    other => return wrong_kind(key, other),
                };
            }
            _ => {
                let text = match value {
                    Value::Null => {
                        nulls.push(key);
                        String::new()
                    }
                    Value::String(text) => text.clone(),
                    other => return wrong_kind(key, other),
                };
                match key {
                    "ticket_id" => s.ticket_id = text,
                    "member_id" => s.member_id = text,
                    "kind" => s.kind = text,
                    "time" => s.time = text,
                    "tz" => s.tz = text,
                    "ends" => s.ends = text,
                    "catch_up" => s.catch_up = text,
                    _ => s.instruction = text,
                }
            }
        }
    }
    Ok(nulls)
}

/// Whether the team can start now (paused, kill switch, connection, budget); the reason when not.
pub async fn availability(
    session: &Session,
    member_id: Option<&str>,
    project_id: &str,
) -> Result<(bool, Option<String>), DbErr> {
    let Some(member_id) = member_id.filter(|m| !m.is_empty()) else {
        return Ok((false, Some("No team chosen".to_string())));
    };
    let (member, profile) = get_profile(session, member_id).await?;
    let (Some(member), Some(profile)) = (member.filter(|m| m.kind == "ai"), profile) else {
        return Ok((false, Some("The team was removed".to_string())));
    };
    let settings = get_settings(session, project_id).await?;
    if settings.paused_all {
        return Ok((false, Some("AI is paused for this project".to_string())));
    }
    if profile.paused {
        return Ok((false, Some(format!("{} is paused", member.name))));
    }
    let unwell = match profile.health.as_str() {
        "key_invalid" => Some(format!("{}: API key invalid", member.name)),
        "not_logged_in" => Some(format!("{} is signed out", member.name)),
        "runner_missing" => Some(format!("{}: the desktop app is closed", member.name)),
        "model_retired" => Some(format!("{}: model retired", member.name)),
        _ => None,
    };
    if unwell.is_some() {
        return Ok((false, unwell));
    }
    // the only limit left in AI v2 is the runs a day (design: "Scheduled runs per day used up (3 of 3); resets at
    // 00:00")
    if let Some((_label, reason)) = budget::blocked(session, &profile, &settings, Some("schedule")).await? {
        return Ok((false, Some(reason)));
    }
    Ok((true, None))
}

/// `_slots_in_use`: how many runs of the team work now.
pub(crate) async fn slots_in_use(session: &Session, member_id: &str) -> Result<usize, DbErr> {
    Ok(running_tickets(session, member_id, None).await?.len())
}

/// `_running_tickets`: the tickets a team has runs on, in the given run states (default: working now).
pub(crate) async fn running_tickets(
    session: &Session,
    member_id: &str,
    states: Option<&[&str]>,
) -> Result<Vec<Option<String>>, DbErr> {
    let rows = ai_run::Entity::find()
        .filter(ai_run::Column::MemberId.eq(member_id))
        .filter(ai_run::Column::State.is_in(states.unwrap_or(&["starting", "running"]).iter().copied()))
        .all(session)
        .await?;
    Ok(rows.into_iter().map(|r| r.ticket_id).collect())
}

fn check(level: &str, text: impl Into<String>, key: &str) -> Value {
    json!({"level": level, "text": text.into(), "key": key})
}

/// `int(value or 0)` of a limit.
fn limit_int(value: Option<&Value>) -> Result<i128, Error> {
    match value.filter(|v| pyjson::truthy(v)) {
        None => Ok(0),
        Some(value) => py_int(value)
            .ok_or_else(|| Error::Other(format!("invalid literal for int() with base 10: {}", pyjson::py_repr(value)))),
    }
}

/// `f"{s.catch_up_hours:g}"`; a schedule whose hours were sent as `null` has none to show (a `TypeError` in
/// Python).
fn hours_text(s: &ai_schedule::Model, nulls: &[&str]) -> Result<String, Error> {
    if nulls.contains(&"catch_up_hours") {
        return Err(Error::Other("unsupported format string passed to NoneType.__format__".to_string()));
    }
    Ok(fmt_g(s.catch_up_hours.get()))
}

fn is_blocking(check: &Value) -> bool {
    check["level"] == "error" && matches!(check["key"].as_str(), Some("when" | "ends"))
}

/// Problems and confirmations shown beside the editor (C "Checks", F). `level`: ok | warn | error. (`now` None:
/// now.)
pub async fn assess(
    session: &Session,
    s: &ai_schedule::Model,
    by: &str,
    now: Option<DateTime<Utc>>,
) -> Result<Vec<Value>, Error> {
    assess_with(session, s, by, now, &[]).await
}

/// `assess` of a schedule some of whose fields were sent as `null` (`nulls`: what `apply` returned). Python keeps
/// the `None` on the object, and two of its checks then read differently: a time that is `None` is named so, and
/// catch-up hours that are `None` cannot be written into the note of a team on the desktop app (a `TypeError`).
pub async fn assess_with(
    session: &Session,
    s: &ai_schedule::Model,
    by: &str,
    now: Option<DateTime<Utc>>,
    nulls: &[&str],
) -> Result<Vec<Value>, Error> {
    let now = now.unwrap_or_else(clock::now);
    let mut out: Vec<Value> = Vec::new();

    let ticket = match s.ticket_id.as_str() {
        "" => None,
        id => ticket::Entity::find_by_id(id).one(session).await?,
    };
    match ticket.as_ref().filter(|t| t.project_id == s.project_id) {
        None => out.push(check("error", "Pick a ticket of this project.", "ticket")),
        Some(t) if matches!(t.status.as_str(), "done" | "wont_do") => out.push(check(
            "error",
            format!(
                "{} is {}: a schedule needs an open ticket.",
                t.id,
                if t.status == "done" { "Done" } else { "Won’t Do" }
            ),
            "ticket",
        )),
        Some(_) => {}
    }
    let (member, profile) = match s.member_id.as_str() {
        "" => (None, None),
        id => get_profile(session, id).await?,
    };
    match (&member, &profile) {
        (Some(m), Some(profile)) if m.project_id == s.project_id && m.kind == "ai" => {
            if profile.connection == "inbox" {
                out.push(check(
                    "error",
                    format!("{} has an inbox only: the board cannot start it at a set time.", m.name),
                    "member",
                ));
            }
            let role = role_of(session, &s.project_id, by).await?;
            if role == "viewer" {
                out.push(check(
                    "error",
                    format!("You cannot schedule {}. Ask an owner for permission to assign it.", m.name),
                    "member",
                ));
            } else if let Some(t) = &ticket {
                out.push(check("ok", format!("You may assign this team to {}", t.id), "permission"));
            }
            let (ok, why) = availability(session, Some(&s.member_id), &s.project_id).await?;
            let busy = slots_in_use(session, &s.member_id).await? as i64;
            let free = (i64::from(profile.max_parallel) - busy).max(0);
            if ok && free == 0 {
                // F "Slot busy": the run waits in the queue, but only so long
                let running: Vec<String> = running_tickets(session, &s.member_id, None)
                    .await?
                    .into_iter()
                    .map(|t| t.unwrap_or_else(|| "None".to_string()))
                    .collect();
                let ahead = running_tickets(session, &s.member_id, Some(&["queued"])).await?.len();
                let who = if running.is_empty() {
                    String::new()
                } else {
                    format!("{} is running. ", running.iter().take(2).cloned().collect::<Vec<_>>().join(", "))
                };
                out.push(check(
                    "warn",
                    format!(
                        "{} has no free run. {who}This run queues at position #{} and starts when a run frees. Max \
                         wait {BUSY_MAX_WAIT_MIN} min, then it is skipped.",
                        m.name,
                        ahead + 1
                    ),
                    "runner",
                ));
            } else if ok {
                out.push(check(
                    "ok",
                    format!(
                        "{} can start now, {free} of {} run{} free",
                        m.name,
                        profile.max_parallel,
                        if profile.max_parallel != 1 { "s" } else { "" }
                    ),
                    "runner",
                ));
            } else {
                out.push(check(
                    "warn",
                    format!(
                        "{}. At the time it {}.",
                        why.as_deref().unwrap_or("None"),
                        if s.backup_member_id.as_deref().is_some_and(|b| !b.is_empty()) {
                            "runs on the backup team"
                        } else {
                            "follows the catch-up rule"
                        }
                    ),
                    "runner",
                ));
            }
            if profile.connection == "local" {
                if s.catch_up == "run" {
                    out.push(check(
                        "warn",
                        format!(
                            "Teams run only while the desktop app is open. Catch-up is on ({} h).",
                            hours_text(s, nulls)?
                        ),
                        "local",
                    ));
                } else {
                    out.push(check(
                        "warn",
                        "Teams run only while the desktop app is open. If it is closed at the time, the run is skipped.",
                        "local",
                    ));
                }
            }
        }
        _ => out.push(check("error", "Pick a team of this project.", "member")),
    }
    if let Some(backup) = s.backup_member_id.as_deref().filter(|b| !b.is_empty()) {
        if backup == s.member_id {
            out.push(check("error", "The backup team must be a different team.", "backup"));
        } else {
            let (bm, bp) = get_profile(session, backup).await?;
            let fits =
                matches!((&bm, &bp), (Some(bm), Some(bp)) if bm.project_id == s.project_id && bp.connection != "inbox");
            if !fits {
                out.push(check(
                    "error",
                    "The backup team must be a team of this project the board can start.",
                    "backup",
                ));
            }
        }
    }
    let lim = limits_of(s);
    if !(5..=600).contains(&limit_int(lim.get("stop_after_min"))?) {
        out.push(check("error", "Stop after must be 5 to 600 minutes.", "limits"));
    }
    if !(0..=3).contains(&limit_int(lim.get("retries"))?) {
        out.push(check("error", "Retries must be 0 to 3.", "limits"));
    }
    if !matches!(s.catch_up.as_str(), "run" | "skip" | "ask") {
        out.push(check("error", "Pick what happens when it cannot run on time.", "catch_up"));
    }
    if !(0.0 < s.catch_up_hours && s.catch_up_hours <= 24.0) {
        out.push(check("error", "Catch-up must be up to 24 hours.", "catch_up"));
    }
    // (a `ScheduleError` of the zone or of a time is one more problem of "when"; what was found before it stays)
    let mut when_checks: Vec<Value> = Vec::new();
    let timed = (|| -> Result<(), Error> {
        let tz = zone(Some(&s.tz))?;
        if s.kind == "once" {
            match once_at(s)? {
                None => when_checks.push(check("error", "Pick the date and time.", "when")),
                Some(at) if now < at && at <= now + Duration::minutes(1) => when_checks.push(check(
                    "error",
                    "That is less than a minute away. Pick a later time, or use Run now.",
                    "when",
                )),
                Some(at) if at <= now => {
                    // the same time of day on the first day it has not passed yet
                    let local = at.with_timezone(&tz).naive_local();
                    let mut fold = fold_of(&tz, at);
                    let mut nxt = now.with_timezone(&tz).date_naive().and_time(local.time());
                    while wall_to_utc(&tz, nxt, fold) <= now {
                        nxt += Duration::days(1);
                        fold = false;
                    }
                    when_checks.push(check(
                        "error",
                        format!(
                            "That time has passed. Next free time: {}, {}.",
                            fmt_day(wall_to_utc(&tz, nxt, fold), &s.tz)?,
                            nxt.format("%H:%M")
                        ),
                        "when",
                    ));
                }
                Some(_) => {}
            }
        } else if s.kind == "repeat" {
            hm(if nulls.contains(&"time") { None } else { Some(&s.time) })?;
            if !pyjson::truthy(&loads(Some(&s.days), json!([]))) {
                when_checks.push(check("error", "Pick at least one day.", "when"));
            }
            if s.ends == "after" && s.ends_after.is_none_or(|n| n <= 0) {
                when_checks.push(check("error", "Enter how many runs.", "ends"));
            }
            if s.ends == "on_date" && s.ends_on.as_deref().unwrap_or("").is_empty() {
                when_checks.push(check("error", "Pick the end date.", "ends"));
            }
        } else {
            when_checks.push(check("error", "kind must be once or repeat.", "when"));
        }
        if let Some(window_end) = s.window_end.as_deref().filter(|w| !w.is_empty()) {
            hm(Some(window_end))?;
        }
        Ok(())
    })();
    out.append(&mut when_checks);
    match timed {
        Ok(()) => {}
        Err(Error::Schedule(exc)) => out.push(check("error", exc.message, "when")),
        Err(other) => return Err(other),
    }
    if !out.iter().any(is_blocking) && member.is_some() {
        out.extend(overlaps(session, s, now).await?);
        out.extend(offline_history(session, s, nulls).await?);
    }
    Ok(out)
}

/// `_overlaps`: other schedules of the same team that start within an hour of this one (at most three).
pub(crate) async fn overlaps(
    session: &Session,
    s: &ai_schedule::Model,
    now: DateTime<Utc>,
) -> Result<Vec<Value>, Error> {
    let mine = slots(s, now, 10)?;
    if mine.is_empty() {
        return Ok(Vec::new());
    }
    let others = ai_schedule::Entity::find()
        .filter(ai_schedule::Column::ProjectId.eq(s.project_id.as_str()))
        .filter(ai_schedule::Column::MemberId.eq(s.member_id.as_str()))
        .filter(ai_schedule::Column::State.eq("active"))
        .filter(ai_schedule::Column::Id.ne(s.id.as_str()))
        .all(session)
        .await?;
    let mut out: Vec<Value> = Vec::new();
    for o in &others {
        for at in slots(o, now, 10)? {
            if mine.iter().any(|m| (at - *m).num_microseconds().is_some_and(|us| us.abs() < 3_600_000_000)) {
                let local = at.with_timezone(&zone(Some(&s.tz))?);
                out.push(check(
                    "warn",
                    format!(
                        "{} is scheduled for the same team at {} on {}. It will wait for a free run.",
                        o.ticket_id,
                        local.format("%H:%M"),
                        day_name(&local)
                    ),
                    "overlap",
                ));
                break;
            }
        }
    }
    out.truncate(3);
    Ok(out)
}

/// `_offline_risk`: B1 "Desktop app often closed at 02:00" under the next run: a team that missed two of its last
/// six starts.
pub(crate) async fn offline_risk(
    session: &Session,
    s: &ai_schedule::Model,
    profile: Option<&ai_team::Model>,
) -> Result<Option<String>, Error> {
    if s.state != "active" || profile.is_none_or(|p| p.connection != "local") {
        return Ok(None);
    }
    if offline_history(session, s, &[]).await?.is_empty() {
        return Ok(None);
    }
    let at: String = if s.kind == "repeat" {
        s.time.clone()
    } else {
        s.run_at.as_deref().unwrap_or("").chars().skip(11).take(5).collect()
    };
    Ok(Some(if at.is_empty() {
        "Desktop app is often closed".to_string()
    } else {
        format!("Desktop app often closed at {at}")
    }))
}

/// `_offline_history`: the warning of a team whose desktop app was closed for two or more of its last six
/// scheduled runs.
pub(crate) async fn offline_history(
    session: &Session,
    s: &ai_schedule::Model,
    nulls: &[&str],
) -> Result<Vec<Value>, Error> {
    let rows = ai_schedule_run::Entity::find()
        .filter(ai_schedule_run::Column::MemberId.eq(s.member_id.as_str()))
        .order_by_desc(ai_schedule_run::Column::SlotAt)
        .limit(6)
        .all(session)
        .await?;
    let missed = rows
        .iter()
        .filter(|r| {
            let note = r.note.as_deref().unwrap_or("");
            r.catch_up || (r.state == "skipped" && (note.contains("closed") || note.contains("offline")))
        })
        .count();
    if missed < 2 {
        return Ok(Vec::new());
    }
    let catch_up =
        if s.catch_up == "run" { format!(" Catch-up is on ({} h).", hours_text(s, nulls)?) } else { String::new() };
    Ok(vec![check(
        "warn",
        format!("The desktop app was closed for {missed} of its last {} scheduled runs.{catch_up}", rows.len()),
        "offline",
    )])
}

/// Summary, next 5 runs and checks for the editor, without saving.
pub async fn preview(
    session: &Session,
    project_id: &str,
    data: &Map<String, Value>,
    by: &str,
    schedule_id: Option<&str>,
) -> Result<Map<String, Value>, Error> {
    let schedule_id = schedule_id.filter(|id| !id.is_empty());
    let mut s = blank(project_id, by)?;
    if let Some(id) = schedule_id {
        if let Some(existing) = ai_schedule::Entity::find_by_id(id).one(session).await? {
            s = existing;
        }
    }
    s.id = schedule_id.unwrap_or("").to_string();
    let nulls = apply(&mut s, data)?;
    let now = clock::now();
    let checks = assess_with(session, &s, by, Some(now), &nulls).await?;
    let mut nxt: Vec<Value> = Vec::new();
    let mut summary = String::new();
    if !checks.iter().any(is_blocking) {
        for at in slots(&s, now, 5)? {
            let local = at.with_timezone(&zone(Some(&s.tz))?);
            nxt.push(json!({
                "at": time::iso(&at),
                "day": format!("{} {}", day_name(&local), chrono::Datelike::day(&local)),
                "time": local.format("%H:%M").to_string(),
                "in": in_words(at, Some(now)),
            }));
        }
        if !s.member_id.is_empty() && !s.ticket_id.is_empty() {
            summary = summary_text(session, &s).await?;
        }
    }
    let mut out = Map::new();
    out.insert("summary".into(), json!(summary));
    out.insert("next_runs".into(), Value::Array(nxt));
    out.insert("checks".into(), Value::Array(checks));
    Ok(out)
}
