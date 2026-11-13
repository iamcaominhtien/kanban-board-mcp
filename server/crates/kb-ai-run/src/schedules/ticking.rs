//! The loop (`services/ai/schedules.py` lines 1203 to 1861): `start_scheduler`, `stop_scheduler`, `_loop`, `tick`,
//! `_deadline`, `_instruction`, `_try_start`, `_publish_board`, `_set`, `_close`, `_follow`, `_short`, `_restart`,
//! `dry_run`, `for_tickets`.

use std::time::Duration as StdDuration;

use chrono::{DateTime, Duration, Timelike, Utc};
use kb_ai::store::{loads, now_iso, parse_iso, py_int};
use kb_base::{ctx, events, pyjson, pytext};
use kb_db::Session;
use kb_db::database;
use kb_db::entities::{ai_run, ai_schedule, ai_schedule_run, ticket};
use kb_db::save_model;
use kb_db::sea_orm::{ActiveModelTrait, ActiveValue::Set, ColumnTrait, EntityTrait, QueryFilter, SqlErr};
use serde_json::{Map, Value, json};

use super::check::{apply, availability, blank};
use super::edit::{get_or_404, set_paused};
use super::notify::{activity, notify};
use super::read::{limits_of, names};
use super::when::{advance, clock_time, day_name, fold_of, hm, in_words, wall_to_utc, zone};
use super::{
    AUTO_PAUSE_AFTER, BUSY_MAX_WAIT_MIN, ENDED, Error, LATE_AFTER_S, OPEN, RT, ScheduleError, refuse, role_of, tick_s,
};
use crate::pynum::{fmt_g, round_to, sum};
use crate::runs::{self as svc_runs, NewRun, RunError};
use crate::{clock, seams};

/// Start the schedule loop (called from the app's lifespan, inside the runtime).
pub fn start_scheduler() {
    let mut inner = RT.inner();
    if inner.task.as_ref().is_none_or(|task| task.is_finished()) {
        inner.task = Some(ctx::spawn(run_loop()));
    }
}

/// Stop the loop.
pub async fn stop_scheduler() {
    let task = RT.inner().task.take();
    if let Some(task) = task {
        if !task.is_finished() {
            task.abort();
            let _ = task.await;
        }
    }
}

/// `_loop`: a tick, then a pause, for ever; a tick that fails is logged.
async fn run_loop() {
    loop {
        if let Err(err) = tick(None).await {
            tracing::error!(target: "kanban.ai.schedules", "Schedule tick failed: {err}");
        }
        tokio::time::sleep(StdDuration::from_secs_f64(tick_s())).await;
    }
}

/// `parse_iso(slot)` of a planned start; Python fails on one that is no time.
fn slot_time(slot: &str) -> Result<DateTime<Utc>, Error> {
    parse_iso(Some(slot)).map(|at| at.to_utc()).ok_or_else(|| Error::Other(format!("{slot:?} is not a time")))
}

/// Open due slots, retry waiting ones, follow running ones. (`now` None: now.)
pub async fn tick(now: Option<DateTime<Utc>>) -> Result<(), Error> {
    let _one_at_a_time = RT.lock.lock().await;
    let now = now.unwrap_or_else(clock::now);
    let mut opened: Vec<String> = Vec::new();
    let follow_list: Vec<(String, String)> = {
        let session = database::session();
        let due = ai_schedule::Entity::find()
            .filter(ai_schedule::Column::State.eq("active"))
            .filter(ai_schedule::Column::NextRunAt.is_not_null())
            .filter(ai_schedule::Column::NextRunAt.lte(kb_base::time::iso(&now)))
            .all(&session)
            .await?;
        for read in due {
            let mut s = read.clone();
            let Some(slot) = s.next_run_at.clone() else { continue };
            let mut srun = ai_schedule_run::new();
            srun.schedule_id = Set(s.id.clone());
            srun.project_id = Set(s.project_id.clone());
            srun.ticket_id = Set(s.ticket_id.clone());
            srun.slot_at = Set(slot.clone());
            let schedule_id = s.id.clone();
            s.runs_count += 1;
            advance(&mut s, slot_time(&slot)?, false)?;
            let written = async {
                let srun = srun.insert(&session).await?;
                save_model(&session, &read, s).await?;
                session.commit().await?;
                Ok::<_, kb_db::sea_orm::DbErr>(srun)
            };
            match written.await {
                Ok(srun) => opened.push(srun.id),
                Err(err) if matches!(err.sql_err(), Some(SqlErr::UniqueConstraintViolation(_))) => {
                    // this slot already started (restart): only move on
                    session.rollback().await?;
                    if let Some(read) = ai_schedule::Entity::find_by_id(schedule_id.as_str()).one(&session).await? {
                        let mut again = read.clone();
                        advance(&mut again, slot_time(&slot)?, false)?;
                        save_model(&session, &read, again).await?;
                        session.commit().await?;
                    }
                    continue;
                }
                Err(err) => return Err(err.into()),
            }
        }
        ai_schedule_run::Entity::find()
            .filter(ai_schedule_run::Column::State.is_in(OPEN))
            .all(&session)
            .await?
            .into_iter()
            .map(|r| (r.id, r.state))
            .collect()
    };
    for sid in &opened {
        try_start(sid, StartOpts { now: Some(now), ..Default::default() }).await?;
    }
    for (sid, state) in &follow_list {
        if opened.contains(sid) {
            continue;
        }
        match state.as_str() {
            "waiting" | "ask" => try_start(sid, StartOpts { now: Some(now), ..Default::default() }).await?,
            "running" => follow(sid, now).await?,
            _ => {}
        }
    }
    Ok(())
}

/// `timedelta(hours=hours)`.
fn hours(hours: f64) -> Duration {
    Duration::microseconds((hours * 3_600_000_000.0).round_ties_even() as i64)
}

/// `_deadline`: the latest a slot may start: the catch-up time, or the allowed window's end when set.
pub fn deadline(s: &ai_schedule::Model, slot: DateTime<Utc>) -> Result<DateTime<Utc>, Error> {
    let mut end = slot + hours(if s.catch_up_hours != 0.0 { s.catch_up_hours.get() } else { 2.0 });
    if let Some(window_end) = s.window_end.as_deref().filter(|w| !w.is_empty()) {
        let (h, m) = hm(Some(window_end))?;
        let tz = zone(Some(&s.tz))?;
        // on the clock of the zone: the window's end today, or tomorrow when that has passed
        let local = slot.with_timezone(&tz).naive_local();
        let mut fold = fold_of(&tz, slot);
        let mut w = local
            .with_hour(h)
            .and_then(|w| w.with_minute(m))
            .and_then(|w| w.with_second(0))
            .and_then(|w| w.with_nanosecond(0))
            .unwrap_or(local);
        if w <= local {
            w += Duration::days(1);
            fold = false;
        }
        end = wall_to_utc(&tz, w, fold);
    }
    Ok(end)
}

/// `_instruction`: what the lead of a scheduled run is told.
pub fn instruction(s: &ai_schedule::Model, extra: &str) -> String {
    let mut lines = vec![format!("This is a scheduled run (schedule by {}).", s.created_by)];
    let own = pytext::strip(&s.instruction);
    if !own.is_empty() {
        lines.push(own.to_string());
    }
    if !extra.is_empty() {
        lines.push(extra.to_string());
    }
    lines.push(
        "You decide when the work is done; say in your final report what was done and what was not. Do not move the \
         ticket past Review."
            .to_string(),
    );
    lines.join("\n\n")
}

/// The keyword arguments of `_try_start`.
#[derive(Debug, Clone, Copy, Default)]
pub struct StartOpts<'a> {
    /// The time of the tick (None: now).
    pub now: Option<DateTime<Utc>>,
    /// A person asked for the start (Run now, or the answer to a waiting slot).
    pub manual: bool,
    /// The team to run it on instead of the schedule's.
    pub member_id: Option<&'a str>,
}

/// `str(value)` of a text that may be Python's `None`.
fn or_none(text: Option<&str>) -> &str {
    text.unwrap_or("None")
}

/// `(b - a).total_seconds()`.
fn seconds(a: DateTime<Utc>, b: DateTime<Utc>) -> f64 {
    let delta = b - a;
    delta.num_microseconds().map_or_else(|| delta.num_milliseconds() as f64 / 1e3, |us| us as f64 / 1e6)
}

/// `_try_start`: start the slot's run when the team can; otherwise wait, use the backup, ask or skip per the
/// catch-up rule.
pub async fn try_start(srun_id: &str, opts: StartOpts<'_>) -> Result<(), Error> {
    let StartOpts { now, manual, member_id } = opts;
    let member_id = member_id.filter(|m| !m.is_empty());
    let now = now.unwrap_or_else(clock::now);
    let (s, slot, ticket) = {
        let session = database::session();
        let Some(srun) = ai_schedule_run::Entity::find_by_id(srun_id).one(&session).await? else { return Ok(()) };
        if !matches!(srun.state.as_str(), "waiting" | "ask") {
            return Ok(());
        }
        let Some(s) = ai_schedule::Entity::find_by_id(srun.schedule_id.as_str()).one(&session).await? else {
            return Ok(());
        };
        let slot = parse_iso(Some(&srun.slot_at)).map_or(now, |at| at.to_utc());
        let ticket = ticket::Entity::find_by_id(s.ticket_id.as_str()).one(&session).await?;
        (s, slot, ticket)
    };
    let Some(ticket) = ticket else {
        let opts = CloseOpts { end_schedule: true, ..Default::default() };
        return close(srun_id, "skipped", Some("Skipped: the ticket was deleted.".into()), opts).await;
    };
    if s.state == "paused" && !manual {
        // a slot already waiting when the schedule was paused does not start behind the person's back
        return close(srun_id, "skipped", Some("Skipped: the schedule is paused.".into()), CloseOpts::default()).await;
    }
    if matches!(ticket.status.as_str(), "done" | "wont_do") {
        let label = if ticket.status == "done" { "Done" } else { "Won’t Do" };
        let note = format!("Skipped: {} is {label}.", ticket.id);
        return close(srun_id, "skipped", Some(note), CloseOpts::default()).await;
    }
    let prev = {
        let session = database::session();
        if role_of(&session, &s.project_id, &s.created_by).await? == "viewer" {
            let reason = format!("{} lost permission to assign this team", s.created_by);
            set_paused(&session, &s.id, true, &s.created_by, Some(&reason)).await?;
            let note = "Skipped: the creator lost permission. The schedule is paused.";
            return close(srun_id, "skipped", Some(note.into()), CloseOpts::default()).await;
        }
        ai_schedule_run::Entity::find()
            .filter(ai_schedule_run::Column::ScheduleId.eq(s.id.as_str()))
            .filter(ai_schedule_run::Column::Id.ne(srun_id))
            .filter(ai_schedule_run::Column::State.eq("running"))
            .one(&session)
            .await?
    };
    if prev.is_some() {
        let note = "Skipped: the last run of this schedule is still going.";
        return close(srun_id, "skipped", Some(note.into()), CloseOpts::default()).await;
    }
    let mut chosen: Option<String> = None;
    let mut why: Option<String> = None;
    {
        let session = database::session();
        let candidates: Vec<&str> = match member_id {
            Some(member_id) => vec![member_id],
            None => vec![s.member_id.as_str(), s.backup_member_id.as_deref().unwrap_or("")],
        };
        for mid in candidates.into_iter().filter(|c| !c.is_empty()) {
            let (ok, reason) = availability(&session, Some(mid), &s.project_id).await?;
            if ok {
                chosen = Some(mid.to_string());
                break;
            }
            why = why.filter(|w| !w.is_empty()).or(reason);
        }
    }
    let deadline = deadline(&s, slot)?;
    let told = CloseOpts { notify: Some("failed"), ..Default::default() };
    let Some(chosen) = chosen else {
        let why = or_none(why.as_deref());
        if !manual && now > deadline {
            let note = format!(
                "Skipped: {why} for more than {} hours. {} was told.",
                fmt_g(s.catch_up_hours.get()),
                s.created_by
            );
            return close(srun_id, "skipped", Some(note), told).await;
        }
        if s.catch_up == "skip" && !manual {
            let note = format!("Skipped: {why}. {} was told.", s.created_by);
            return close(srun_id, "skipped", Some(note), told).await;
        }
        let state = if s.catch_up == "ask" { "ask" } else { "waiting" };
        let until = clock_time(deadline, &s.tz)?;
        let note = if state == "waiting" {
            format!("Waiting: {why}. Starts when it is back, until {until}. Then it is skipped.")
        } else {
            format!("{why}. Run it late?")
        };
        set(srun_id, SlotFields { state: Some(state.into()), note: Some(Some(note)), ..Default::default() }).await?;
        if manual {
            return refuse("unavailable", format!("{why}."));
        }
        return Ok(());
    };
    if s.catch_up == "ask" && !manual && seconds(slot, now) > LATE_AFTER_S && now <= deadline {
        let note = "The run is late. Run it now?".to_string();
        return set(srun_id, SlotFields { state: Some("ask".into()), note: Some(Some(note)), ..Default::default() })
            .await;
    }
    if !manual && now > deadline {
        let note = format!("Skipped: the allowed time ended before it could start. {} was told.", s.created_by);
        return close(srun_id, "skipped", Some(note), told).await;
    }
    let late = seconds(slot, now) > LATE_AFTER_S && !manual;
    let created = {
        let session = database::session();
        let new = NewRun {
            ticket_id: Some(&s.ticket_id),
            member_id: &chosen,
            trigger: "schedule",
            started_by: &s.created_by,
            instruction: &instruction(&s, ""),
            ..Default::default()
        };
        svc_runs::create_run(&session, new).await
    };
    let run = match created {
        Ok(run) => run,
        Err(RunError::Conflict(exc)) => {
            if manual {
                return refuse("conflict", exc);
            }
            let note = format!("Waiting: {exc}");
            let fields = SlotFields { state: Some("waiting".into()), note: Some(Some(note)), ..Default::default() };
            return set(srun_id, fields).await;
        }
        Err(RunError::Run(exc)) => {
            if manual {
                return refuse("unavailable", exc);
            }
            return close(srun_id, "skipped", Some(format!("Skipped: {exc}")), told).await;
        }
        Err(RunError::Db(err)) => return Err(Error::Db(err)),
        Err(other) => return Err(Error::Other(other.to_string())),
    };
    let names = {
        let session = database::session();
        names(&session, [Some(chosen.as_str())]).await?
    };
    let mut note: Option<String> = None;
    if late {
        note = Some(format!("Started {} when it was back.", clock_time(now, &s.tz)?));
    }
    if chosen != s.member_id && member_id.is_none() {
        let before = note.map(|n| format!("{n} ")).unwrap_or_default();
        note = Some(format!("{before}Ran on the backup team, {}.", or_none(names.get(&chosen).map(String::as_str))));
    }
    set(
        srun_id,
        SlotFields {
            state: Some("running".into()),
            member_id: Some(chosen.clone()),
            run_ids: Some(pyjson::dumps(&json!([run.id]))),
            attempts: Some(1),
            catch_up: Some(late),
            started_at: Some(now_iso()),
            note: Some(note),
        },
    )
    .await?;
    let ai = names.get(&chosen).map_or("The team", String::as_str);
    activity(
        &s.ticket_id,
        &format!("started a scheduled run on {} (schedule by {})", s.ticket_id, s.created_by),
        ai,
        None,
    )
    .await?;
    let mut extra = Map::new();
    extra.insert("run_id".into(), json!(run.id));
    extra.insert("action".into(), json!("open_run"));
    notify(&s, "started", &format!("{} run started by schedule", s.ticket_id), extra);
    Ok(())
}

/// `_publish_board`: tell open pages that schedules changed.
pub(crate) async fn publish_board() {
    events::publish(events::INVALIDATE, &[]).await;
}

/// The fields `_set` puts on a slot (None: left as it is; `note` Some(None): no note).
#[derive(Debug, Clone, Default)]
pub(crate) struct SlotFields {
    pub(crate) state: Option<String>,
    pub(crate) note: Option<Option<String>>,
    pub(crate) member_id: Option<String>,
    pub(crate) run_ids: Option<String>,
    pub(crate) attempts: Option<i32>,
    pub(crate) catch_up: Option<bool>,
    pub(crate) started_at: Option<String>,
}

/// `_set`: change fields of a slot and tell the pages.
pub(crate) async fn set(srun_id: &str, fields: SlotFields) -> Result<(), Error> {
    {
        let session = database::session();
        let Some(read) = ai_schedule_run::Entity::find_by_id(srun_id).one(&session).await? else {
            return Ok(());
        };
        let mut srun = read.clone();
        if let Some(state) = fields.state {
            srun.state = state;
        }
        if let Some(note) = fields.note {
            srun.note = note;
        }
        if let Some(member_id) = fields.member_id {
            srun.member_id = Some(member_id);
        }
        if let Some(run_ids) = fields.run_ids {
            srun.run_ids = run_ids;
        }
        if let Some(attempts) = fields.attempts {
            srun.attempts = attempts;
        }
        if let Some(catch_up) = fields.catch_up {
            srun.catch_up = catch_up;
        }
        if let Some(started_at) = fields.started_at {
            srun.started_at = Some(started_at);
        }
        srun.updated_at = now_iso();
        save_model(&session, &read, srun).await?;
        session.commit().await?;
    }
    publish_board().await;
    Ok(())
}

/// The keyword arguments of `_close`.
#[derive(Debug, Clone, Copy, Default)]
pub struct CloseOpts<'a> {
    /// The event a skipped slot is told under (None: "failed").
    pub notify: Option<&'a str>,
    /// The schedule ends with this slot (its ticket is gone).
    pub end_schedule: bool,
}

fn slot_extra(srun_id: &str, action: &str, skipped: bool) -> Map<String, Value> {
    let mut extra = Map::new();
    extra.insert("srun_id".into(), json!(srun_id));
    extra.insert("action".into(), json!(action));
    if skipped {
        extra.insert("skipped".into(), json!(true));
    }
    extra
}

/// `_close`: end a slot: totals, the failure count (3 in a row pause), Activity and the notification.
pub async fn close(srun_id: &str, state: &str, note: Option<String>, opts: CloseOpts<'_>) -> Result<(), Error> {
    let mut note = note;
    let mut paused_now = false;
    let (s, srun_member, names) = {
        let session = database::session();
        let Some(read) = ai_schedule_run::Entity::find_by_id(srun_id).one(&session).await? else {
            return Ok(());
        };
        let mut srun = read.clone();
        if ENDED.contains(&srun.state.as_str()) {
            return Ok(());
        }
        let s = ai_schedule::Entity::find_by_id(srun.schedule_id.as_str()).one(&session).await?;
        let run_ids: Vec<String> = match loads(Some(&srun.run_ids), json!([])) {
            Value::Array(ids) => ids.iter().filter_map(|id| id.as_str().map(str::to_string)).collect(),
            _ => Vec::new(),
        };
        let mut cost = 0.0;
        if !run_ids.is_empty() {
            let rows = ai_run::Entity::find().filter(ai_run::Column::Id.is_in(run_ids)).all(&session).await?;
            cost = sum(rows.iter().map(|r| r.cost_usd.get()));
        }
        if srun.state == "running" {
            if let Some(started_with) = srun.note.as_deref().filter(|n| !n.is_empty()) {
                // keep how it started (catch-up, backup team)
                let joined = format!("{started_with} {}", note.as_deref().unwrap_or(""));
                note = Some(pytext::strip(&joined).to_string());
            }
        }
        srun.state = state.to_string();
        srun.note = note.clone();
        srun.ended_at = Some(now_iso());
        let started = parse_iso(srun.started_at.as_deref());
        srun.duration_s = started.map_or(0, |started| seconds(started.to_utc(), clock::now()).trunc() as i32);
        srun.cost_usd = cost.into();
        srun.updated_at = now_iso();
        let srun_member = srun.member_id.clone();
        save_model(&session, &read, srun).await?;
        let s = match s {
            None => None,
            Some(read) => {
                let mut s = read.clone();
                if state == "failed" {
                    s.failures_in_row += 1;
                    if s.failures_in_row >= AUTO_PAUSE_AFTER && s.state == "active" {
                        s.state = "paused".to_string();
                        s.paused_reason = Some(format!(
                            "Failed {} runs in a row: {}",
                            s.failures_in_row,
                            note.as_deref().filter(|n| !n.is_empty()).unwrap_or("see the last run")
                        ));
                        paused_now = true;
                    }
                } else if matches!(state, "passed" | "partly") {
                    s.failures_in_row = 0;
                }
                if let Some(ticket) = ticket::Entity::find_by_id(s.ticket_id.as_str()).one(&session).await? {
                    // the schedule's own run edits are not "edited since"
                    s.ticket_seen_at = Some(ticket.updated_at);
                }
                if opts.end_schedule {
                    s.state = "ended".to_string();
                    s.next_run_at = None;
                } else if s.state == "active" && s.next_run_at.as_deref().unwrap_or("").is_empty() {
                    s.state = "ended".to_string();
                }
                Some(save_model(&session, &read, s).await?)
            }
        };
        session.commit().await?;
        let names = names(&session, [srun_member.as_deref()]).await?;
        (s, srun_member, names)
    };
    let Some(s) = s else { return Ok(()) };
    let member = srun_member.as_deref().filter(|m| !m.is_empty());
    let who = member.and_then(|m| names.get(m)).map_or(s.created_by.as_str(), String::as_str);
    let said = note.as_deref().unwrap_or("");
    match state {
        "skipped" => {
            let reason = said.strip_prefix("Skipped: ").unwrap_or(said);
            activity(
                &s.ticket_id,
                &format!("skipped a scheduled run on {}: {reason}", s.ticket_id),
                if member.is_some() { who } else { "Schedule" },
                None,
            )
            .await?;
            notify(
                &s,
                opts.notify.filter(|n| !n.is_empty()).unwrap_or("failed"),
                &format!("{} skipped: {}", s.ticket_id, reason.trim_end_matches('.')),
                slot_extra(srun_id, "reschedule", true),
            );
        }
        "failed" => notify(
            &s,
            "failed",
            &format!("{} scheduled run failed: {}", s.ticket_id, or_none(note.as_deref())),
            slot_extra(srun_id, "open", false),
        ),
        "partly" => notify(
            &s,
            "finished",
            &format!("{} partly done: {}", s.ticket_id, or_none(note.as_deref())),
            slot_extra(srun_id, "open", false),
        ),
        _ => {}
    }
    if paused_now {
        activity(
            &s.ticket_id,
            &format!("paused the schedule for {}: failed {AUTO_PAUSE_AFTER} runs in a row", s.ticket_id),
            "Schedule",
            None,
        )
        .await?;
        notify(
            &s,
            "failed",
            &format!("Schedule paused for {}: failed {AUTO_PAUSE_AFTER} runs in a row", s.ticket_id),
            slot_extra(srun_id, "open", false),
        );
    }
    publish_board().await;
    Ok(())
}

/// `int(value or default)` of a limit.
fn limit_or(value: Option<&Value>, default: i128) -> Result<i128, Error> {
    match value.filter(|v| pyjson::truthy(v)) {
        None => Ok(default),
        Some(value) => py_int(value)
            .ok_or_else(|| Error::Other(format!("invalid literal for int() with base 10: {}", pyjson::py_repr(value)))),
    }
}

/// `float(value)` of a limit.
fn limit_float(value: &Value) -> Result<f64, Error> {
    match value {
        Value::Number(n) => n.as_f64(),
        Value::Bool(b) => Some(f64::from(u8::from(*b))),
        Value::String(text) => pytext::strip(text).replace('_', "").parse::<f64>().ok(),
        _ => None,
    }
    .ok_or_else(|| Error::Other(format!("could not convert string to float: {}", pyjson::py_repr(value))))
}

/// `_follow`: watch the slot's current run: limits, questions, and what to do when it ends. The run's lead decides
/// when the work is done; the board only closes the slot with what it reported.
async fn follow(srun_id: &str, now: DateTime<Utc>) -> Result<(), Error> {
    let (srun, s, run) = {
        let session = database::session();
        let Some(srun) = ai_schedule_run::Entity::find_by_id(srun_id).one(&session).await? else { return Ok(()) };
        if srun.state != "running" {
            return Ok(());
        }
        let s = ai_schedule::Entity::find_by_id(srun.schedule_id.as_str()).one(&session).await?;
        let last = match loads(Some(&srun.run_ids), json!([])) {
            Value::Array(ids) => ids.last().and_then(Value::as_str).map(str::to_string),
            _ => None,
        };
        let run = match last {
            Some(id) => ai_run::Entity::find_by_id(id).one(&session).await?,
            None => None,
        };
        (srun, s, run)
    };
    let (Some(s), Some(run)) = (s, run) else {
        return close(srun_id, "failed", Some("The run was lost.".into()), CloseOpts::default()).await;
    };
    let lim = limits_of(&s);
    if run.state == "queued" {
        let queued = parse_iso(Some(&run.queued_at)).map_or(now, |at| at.to_utc());
        if now - queued > Duration::minutes(BUSY_MAX_WAIT_MIN) {
            let reason = format!("No free run within {BUSY_MAX_WAIT_MIN} min");
            // (a `RunError` of the cancel is not caught here in Python either: the tick fails)
            svc_runs::cancel(&run.id, "schedule", Some(&reason), None, false).await.map_err(run_failure)?;
            let note = format!("Skipped: no free run within {BUSY_MAX_WAIT_MIN} min.");
            let told = CloseOpts { notify: Some("failed"), ..Default::default() };
            return close(srun_id, "skipped", Some(note), told).await;
        }
        return Ok(());
    }
    if matches!(run.state.as_str(), "starting" | "running" | "needs_input") {
        let started = parse_iso(run.started_at.as_deref()).map(|at| at.to_utc());
        let limit = limit_or(lim.get("stop_after_min"), 45)?;
        let over_time = run.state != "needs_input"
            && started.is_some_and(|started| {
                (now - started).num_microseconds().is_none_or(|us| i128::from(us) > limit * 60_000_000)
            });
        let max_cost = lim.get("max_cost").filter(|v| !v.is_null());
        let over_cost = match max_cost {
            Some(max_cost) if run.metered => run.cost_usd >= limit_float(max_cost)?,
            _ => false,
        };
        if over_time || over_cost {
            let why = if over_time {
                format!("Stopped at the {limit} min limit.")
            } else {
                let max_cost = max_cost.map(limit_float).transpose()?.unwrap_or_default();
                format!("Stopped at the ${max_cost:.2} cost limit.")
            };
            match svc_runs::cancel(&run.id, "schedule", Some(&why), None, false).await {
                Ok(_) => {}
                // (a run that has just ended cannot be stopped: the slot is closed all the same)
                Err(err) if err.is_run_error() => {}
                Err(err) => return Err(run_failure(err)),
            }
            return close(srun_id, "partly", Some(why), CloseOpts::default()).await;
        }
        if run.state == "needs_input" && RT.inner().asked.insert(run.id.clone()) {
            let mut extra = Map::new();
            extra.insert("run_id".into(), json!(run.id));
            extra.insert("action".into(), json!("open_run"));
            notify(&s, "needs_input", &format!("{} scheduled run needs input", s.ticket_id), extra);
        }
        return Ok(());
    }
    if run.state == "cancelled" {
        if run.ended_by.as_deref() == Some("schedule") {
            return Ok(());
        }
        let by = run.ended_by.as_deref().filter(|b| !b.is_empty()).unwrap_or("a person");
        return close(srun_id, "cancelled", Some(format!("Run cancelled by {by}.")), CloseOpts::default()).await;
    }
    if matches!(run.state.as_str(), "failed" | "timed_out") {
        let reason = run.ended_reason.as_deref().filter(|r| !r.is_empty()).unwrap_or("no reason given");
        if i128::from(srun.attempts) < 1 + limit_or(lim.get("retries"), 0)? {
            return restart(srun_id, &s, &run, &format!("The last attempt failed: {reason}. Try again.")).await;
        }
        let retried = if srun.attempts > 1 { " Retried, failed again." } else { "" };
        let note = format!("Run {}: {reason}.{retried}", run.state.replace('_', " "));
        return close(srun_id, "failed", Some(note), CloseOpts::default()).await;
    }
    // finished: the lead's own report says how it went
    let report = match loads(Some(&run.report), json!({})) {
        Value::Object(report) => report,
        _ => Map::new(),
    };
    let text_or = |key: &str, default: &str| match report.get(key).filter(|v| pyjson::truthy(v)) {
        Some(Value::String(text)) => text.clone(),
        Some(other) => pyjson::py_str(other),
        None => default.to_string(),
    };
    let status = text_or("status", "done");
    let said = short(&text_or("summary", run.summary.as_deref().unwrap_or("")), 200);
    let said = if said.is_empty() { String::new() } else { format!(" {said}") };
    if matches!(status.as_str(), "partial" | "blocked" | "question") {
        let note = format!("The lead reported {status}.{said}");
        return close(srun_id, "partly", Some(note), CloseOpts::default()).await;
    }
    close(srun_id, "passed", Some(format!("Finished.{said}")), CloseOpts::default()).await?;
    let mut extra = Map::new();
    extra.insert("run_id".into(), json!(run.id));
    extra.insert("action".into(), json!("open"));
    notify(&s, "finished", &format!("{} scheduled run finished", s.ticket_id), extra);
    Ok(())
}

/// An error of the runs that the loop does not catch.
fn run_failure(err: RunError) -> Error {
    match err {
        RunError::Db(err) => Error::Db(err),
        other => Error::Other(other.to_string()),
    }
}

/// `_short`: one line of an error, cut: a CLI's last stderr lines can be a whole traceback (Python's default
/// `limit`: 160).
pub fn short(text: &str, limit: usize) -> String {
    let one = pytext::squash(text);
    if one.chars().count() <= limit {
        return one;
    }
    let cut: String = one.chars().take(limit.saturating_sub(1)).collect();
    format!("{}…", cut.trim_end_matches(pytext::is_space))
}

/// `_restart`: start the slot's run again after a failed attempt, on the conversation it had.
async fn restart(srun_id: &str, s: &ai_schedule::Model, run: &ai_run::Model, extra: &str) -> Result<(), Error> {
    let fields = {
        let session = database::session();
        let Some(srun) = ai_schedule_run::Entity::find_by_id(srun_id).one(&session).await? else {
            return Err(Error::Other(format!("scheduled run {srun_id} is gone")));
        };
        let fresh = ai_schedule::Entity::find_by_id(s.id.as_str()).one(&session).await?;
        let slot = parse_iso(Some(&srun.slot_at)).map_or_else(clock::now, |at| at.to_utc());
        // nothing starts again behind a paused schedule; a run cut off when the board closed is not started again
        // past its allowed time either (a retry after the run itself ended is not held to it)
        if fresh.is_some_and(|fresh| fresh.state == "paused") {
            let note = "Not started again: the schedule is paused.";
            return close(srun_id, "skipped", Some(note.into()), CloseOpts::default()).await;
        }
        if run.ended_by.as_deref() == Some("board") && clock::now() > deadline(s, slot)? {
            let note = "Not started again: its allowed time has passed.";
            return close(srun_id, "skipped", Some(note.into()), CloseOpts::default()).await;
        }
        let member_id = srun.member_id.as_deref().filter(|m| !m.is_empty()).unwrap_or(&s.member_id);
        let new = NewRun {
            ticket_id: Some(&s.ticket_id),
            member_id,
            trigger: "schedule",
            started_by: &s.created_by,
            instruction: &instruction(s, extra),
            resume_session: run.session_id.as_deref(),
            ..Default::default()
        };
        let new = match svc_runs::create_run(&session, new).await {
            Ok(new) => new,
            Err(err) if err.is_run_error() => {
                let note = format!("Could not start again: {err}");
                return close(srun_id, "failed", Some(note), CloseOpts::default()).await;
            }
            Err(err) => return Err(run_failure(err)),
        };
        let mut ids = match loads(Some(&srun.run_ids), json!([])) {
            Value::Array(ids) => ids,
            _ => Vec::new(),
        };
        ids.push(json!(new.id));
        SlotFields {
            run_ids: Some(pyjson::dumps(&Value::Array(ids))),
            attempts: Some(srun.attempts + 1),
            ..Default::default()
        }
    };
    set(srun_id, fields).await
}

/// What the AI would do, without doing it (C "Dry run"): a plan from the board's assistant (the `schedule-dry-run`
/// skill, through `seams::Assistant::turn`). Nothing is changed.
pub async fn dry_run(
    session: &Session,
    schedule_id: Option<&str>,
    project_id: &str,
    data: &Map<String, Value>,
    by: &str,
) -> Result<Map<String, Value>, Error> {
    let mut s = blank(project_id, by)?;
    if let Some(schedule_id) = schedule_id.filter(|id| !id.is_empty()) {
        s = get_or_404(session, schedule_id).await?;
    }
    let nulls = apply(&mut s, data)?;
    let Some(ticket) = ticket::Entity::find_by_id(s.ticket_id.as_str()).one(session).await? else {
        return refuse("invalid", "Pick a ticket first.");
    };
    let criteria: Vec<Value> = match loads(Some(&ticket.acceptance_criteria), json!([])) {
        Value::Array(items) => items.iter().map(|a| a.get("text").cloned().unwrap_or(Value::Null)).collect(),
        _ => Vec::new(),
    };
    let names = names(session, [Some(s.member_id.as_str())]).await?;
    if nulls.contains(&"instruction") {
        // (`s.instruction.strip()` of a `None` in Python)
        return Err(Error::Other("'NoneType' object has no attribute 'strip'".to_string()));
    }
    let mut inputs = Map::new();
    inputs.insert("ticket_id".into(), json!(ticket.id));
    inputs.insert("title".into(), json!(ticket.title));
    inputs.insert("description".into(), json!(ticket.description.chars().take(6000).collect::<String>()));
    inputs.insert("acceptance_criteria".into(), Value::Array(criteria));
    inputs.insert("instruction".into(), json!(instruction(&s, "")));
    let Some(assistant) = seams::assistant() else {
        return Err(Error::Other("The board's assistant is not part of this server yet.".to_string()));
    };
    let ask = seams::AssistAsk {
        name: format!("schedule:{}:dry-run", if s.id.is_empty() { "new" } else { s.id.as_str() }),
        skill: "schedule-dry-run".to_string(),
        inputs,
        by: by.to_string(),
        feature: "schedule_dry_run".to_string(),
        ticket_id: Some(ticket.id.clone()),
        fresh: true,
        timeout_s: 300.0,
    };
    let out = match assistant.turn(project_id, ask).await {
        Ok(out) => out,
        Err(seams::AssistFailure::Assist(exc)) => {
            return refuse("unavailable", format!("The dry run failed: {exc}"));
        }
        Err(seams::AssistFailure::Other(exc)) => return Err(Error::Other(exc)),
    };
    if out.state != "finished" {
        return Err(Error::Schedule(ScheduleError::new(
            "unavailable",
            format!("The dry run failed: {}", or_none(out.error.as_deref())),
        )));
    }
    let text = match out.data.get("text").filter(|v| pyjson::truthy(v)) {
        Some(Value::String(text)) => text.clone(),
        Some(other) => pyjson::py_str(other),
        None => out.text.clone(),
    };
    let mut result = Map::new();
    result.insert("text".into(), json!(pytext::strip(&text)));
    result
        .insert("member_name".into(), json!(names.get(&s.member_id).filter(|n| !n.is_empty()).unwrap_or(&out.member)));
    result.insert("cost".into(), json!(round_to(out.cost, 4)));
    result.insert("metered".into(), json!(false));
    Ok(result)
}

/// Card footer state per ticket (E2): next run, starts soon, missed and waiting, paused.
pub async fn for_tickets(session: &Session, project_id: &str) -> Result<Map<String, Value>, Error> {
    let rows = ai_schedule::Entity::find()
        .filter(ai_schedule::Column::ProjectId.eq(project_id))
        .filter(ai_schedule::Column::State.is_in(["active", "paused"]))
        .all(session)
        .await?;
    let waiting: std::collections::HashMap<String, ai_schedule_run::Model> = ai_schedule_run::Entity::find()
        .filter(ai_schedule_run::Column::ProjectId.eq(project_id))
        .filter(ai_schedule_run::Column::State.is_in(["waiting", "ask"]))
        .all(session)
        .await?
        .into_iter()
        .map(|r| (r.schedule_id.clone(), r))
        .collect();
    let now = clock::now();
    let rank = |state: &str| match state {
        "missed" => 0,
        "soon" => 1,
        "planned" => 2,
        _ => 3,
    };
    let mut out: Map<String, Value> = Map::new();
    for s in &rows {
        let mut item = Map::new();
        if s.state == "paused" {
            item.insert("state".into(), json!("paused"));
            item.insert("label".into(), json!("Schedule paused"));
        } else if let Some(slot) = waiting.get(&s.id) {
            item.insert("state".into(), json!("missed"));
            item.insert(
                "label".into(),
                json!(if slot.state == "waiting" { "Missed, waiting for the app" } else { "Late: run it?" }),
            );
        } else {
            let Some(at) = parse_iso(s.next_run_at.as_deref()).map(|at| at.to_utc()) else { continue };
            let soon = at - now <= Duration::minutes(60);
            let local = at.with_timezone(&zone(Some(&s.tz))?);
            item.insert("state".into(), json!(if soon { "soon" } else { "planned" }));
            item.insert(
                "label".into(),
                json!(if soon {
                    format!("Starts {}", in_words(at, Some(now)))
                } else {
                    format!("{} {}", day_name(&local), local.format("%H:%M"))
                }),
            );
            item.insert("at".into(), json!(s.next_run_at));
        }
        item.insert("schedule_id".into(), json!(s.id));
        item.insert("member_id".into(), json!(s.member_id));
        let state = item["state"].as_str().unwrap_or("").to_string();
        let at = item.get("at").and_then(Value::as_str).unwrap_or("").to_string();
        let better = match out.get(&s.ticket_id) {
            None => true,
            Some(cur) => {
                let cur_state = cur["state"].as_str().unwrap_or("");
                rank(&state) < rank(cur_state)
                    || (state == "planned"
                        && cur_state == "planned"
                        && at.as_str() < cur.get("at").and_then(Value::as_str).unwrap_or(""))
            }
        };
        if better {
            out.insert(s.ticket_id.clone(), Value::Object(item));
        }
    }
    Ok(out)
}
