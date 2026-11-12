//! Part of `services/notifications.py`: lines 3103 to 3282, "The loop": the reminder of unanswered rows, waking
//! snoozed rows, and the background task that reconciles, wakes, reminds, writes day cards and prunes.

use std::sync::{Arc, LazyLock, Mutex};
use std::time::Duration;

use chrono::{DateTime, Duration as ChronoDuration, Utc};
use kb_base::events;
use kb_db::entities::{notification, notify_event};
use kb_db::sea_orm::{ActiveModelTrait, ActiveValue, ColumnTrait, EntityTrait, QueryFilter};
use serde_json::{Map, Value, json};
use tokio::task::JoinHandle;
use tokio::time::Instant;

use crate::daycard::{prune, write_day_cards};
use crate::db::save_notification;
use crate::delivery::{DIRTY, Event, announce, mark_dirty};
use crate::error::Result;
use crate::helpers::{dumps, iso, loads_map, parse, utcnow};
use crate::kinds::REMIND_EVERY_S;
use crate::resolving::reconcile;
use crate::settings::{Prefs, get_prefs, in_quiet_hours, remind_after};
use crate::writing::{EmitFields, emit};

/// `_task`: the loop's task, while it runs.
static TASK: LazyLock<Mutex<Option<JoinHandle<()>>>> = LazyLock::new(|| Mutex::new(None));

/// The name `start()` registers its `events::on_publish` listener under, so a second `start()` keeps one.
const ON_PUBLISH_KEY: usize = 0x4e4f_5449;

/// Do not let it slip (#270): a Needs you row still open and unread `remind_after_min` minutes after its newest
/// event notifies once more. The reminder is one more event on the same row (it comes back unread and does not
/// count as a new item), so the panel, a toast, the browser notifier and the desktop notifier all see it the way
/// they see any other change. Once per request: the row remembers `reminded_at` until a new event arrives. Not
/// during quiet hours (it waits for them to end), not for a snoozed, closed, cleared or unreachable row, and never
/// for an AI recipient. Returns how many reminders were sent.
pub async fn remind_unanswered(now: Option<DateTime<Utc>>) -> Result<i64> {
    let now = now.unwrap_or_else(utcnow);
    let mut sent = 0;
    let session = kb_db::session();
    let rows = notification::Entity::find()
        .filter(notification::Column::Needs.eq(true))
        .filter(notification::Column::DoneAt.is_null())
        .filter(notification::Column::ClearedAt.is_null())
        .filter(notification::Column::ReadAt.is_null())
        .all(&session)
        .await?;
    let mut prefs_of: std::collections::HashMap<String, Prefs> = std::collections::HashMap::new();
    for r in rows {
        if r.recipient.starts_with("ai:") || !(r.inapp || r.desktop) {
            continue;
        }
        if r.snoozed_until
            .as_deref()
            .filter(|s| !s.is_empty())
            .is_some_and(|s| parse(Some(s)).map_or(now, |d| d.with_timezone(&Utc)) > now)
        {
            continue;
        }
        let data = loads_map(Some(&r.data));
        if data.get("reminded_at").is_some_and(kb_base::pyjson::truthy)
            || data.get("gone").is_some_and(kb_base::pyjson::truthy)
        {
            continue;
        }
        if !prefs_of.contains_key(&r.recipient) {
            prefs_of.insert(r.recipient.clone(), get_prefs(&session, &r.recipient).await?);
        }
        let prefs = &prefs_of[&r.recipient];
        let minutes = remind_after(prefs);
        let last = parse(Some(&r.updated_at));
        let waited_enough = last.is_some_and(|l| now.signed_duration_since(l) >= ChronoDuration::minutes(minutes));
        if minutes <= 0 || !waited_enough {
            continue;
        }
        if in_quiet_hours(prefs, Some(now)) {
            continue;
        }
        let mut reminder = Map::new();
        reminder.insert("reminder".into(), json!(true));
        emit(
            &r.kind,
            Some(&session),
            EmitFields {
                project_id: r.project_id.clone(),
                recipients: vec![r.recipient.clone()],
                title: r.title.clone(),
                body: Some(r.body.clone()),
                target_kind: r.target_kind.clone(),
                target_id: r.target_id.clone(),
                ticket_id: r.ticket_id.clone(),
                page_id: r.page_id.clone(),
                member_id: r.member_id.clone(),
                actor: r.actor.clone(),
                data: Some(reminder),
                ..Default::default()
            },
        )
        .await?;
        sent += 1;
    }
    Ok(sent)
}

/// A snooze that ran out brings its row back: one event per target, the row points at it and is unread again, so
/// the panel, the count, a toast and the desktop notifier all see it come back (design C, "brings it back in 1
/// hour"). Returns the newest event id, or `None` when nothing woke.
pub async fn wake_snoozed(now: Option<DateTime<Utc>>) -> Result<Option<i32>> {
    let now = now.unwrap_or_else(utcnow);
    let session = kb_db::session();
    let rows = notification::Entity::find()
        .filter(notification::Column::SnoozedUntil.is_not_null())
        .filter(notification::Column::SnoozedUntil.lte(iso(&now)))
        .filter(notification::Column::DoneAt.is_null())
        .all(&session)
        .await?;
    if rows.is_empty() {
        return Ok(None);
    }
    type Target = (String, Option<String>, Option<String>, Option<String>, Option<String>);
    let mut order: Vec<Target> = Vec::new();
    let mut targets: std::collections::HashMap<Target, Vec<notification::Model>> = std::collections::HashMap::new();
    for r in rows {
        let key =
            (r.kind.clone(), r.target_kind.clone(), r.target_id.clone(), r.project_id.clone(), r.ticket_id.clone());
        if !targets.contains_key(&key) {
            order.push(key.clone());
        }
        targets.entry(key).or_default().push(r);
    }
    let mut last = None;
    for key in order {
        let (kind, tk, tid, pid, ticket) = key.clone();
        let group = targets.remove(&key).unwrap_or_default();
        let mut recipients: Vec<String> = group.iter().map(|r| r.recipient.clone()).collect();
        recipients.sort();
        recipients.dedup();
        let mut ev = notify_event::new();
        ev.project_id = ActiveValue::Set(pid);
        ev.kind = ActiveValue::Set(kind);
        ev.op = ActiveValue::Set("wake".into());
        ev.needs = ActiveValue::Set(group[0].needs);
        ev.target_kind = ActiveValue::Set(tk);
        ev.target_id = ActiveValue::Set(tid);
        ev.ticket_id = ActiveValue::Set(ticket);
        ev.title = ActiveValue::Set(group[0].title.clone());
        ev.recipients = ActiveValue::Set(dumps(&Value::from(recipients)));
        let ev = ev.insert(&session).await?;
        last = Some(ev.id);
        for r in &group {
            let mut after = r.clone();
            after.snoozed_until = None;
            after.read_at = None;
            after.last_event_id = ev.id;
            save_notification(&session, r, &after).await?;
        }
    }
    session.commit().await?;
    announce(last).await;
    Ok(last)
}

/// Once, on the first start after the upgrade: what was already waiting for a person gets its row, since the old
/// toast hooks are gone and nothing else would write one (an open question, an account found signed out). Returns
/// how many were written.
pub async fn backfill_waiting() -> Result<i64> {
    Ok(0)
}

/// How often the loop checks the open Needs you rows without being told, in seconds.
pub const RECONCILE_EVERY_S: f64 = 15.0;
/// The longest a busy board waits between two passes, in seconds.
pub const RECONCILE_MAX_PAUSE_S: f64 = 3.0;

/// When the loop last did each of its jobs (`None`: never, so the first round does them all).
struct Schedule {
    last_full: Option<Instant>,
    last_hour: Option<Instant>,
    last_remind: Option<Instant>,
}

fn due(last: Option<Instant>, now: Instant, every_s: f64) -> bool {
    last.is_none_or(|l| now.duration_since(l).as_secs_f64() >= every_s)
}

async fn round(state: &mut Schedule, dirty: &Event) -> Result<()> {
    // many changes at once are one check: wait for a change, but look at the clock every second
    let _ = tokio::time::timeout(Duration::from_secs(1), dirty.wait()).await;
    let t = Instant::now();
    let mut pause = 0.25; // many changes at once are one check
    if dirty.is_set() || due(state.last_full, t, RECONCILE_EVERY_S) {
        dirty.clear();
        state.last_full = Some(t);
        reconcile().await?;
        wake_snoozed(None).await?;
        // A pass reads every open row (a quarter of a second on a big board). While AIs change the board without a
        // pause, it runs at most a tenth of the time: a row closes a little later, the board keeps its CPU for the
        // requests.
        pause = f64::min(f64::max(pause, 10.0 * t.elapsed().as_secs_f64()), RECONCILE_MAX_PAUSE_S);
    }
    if due(state.last_remind, t, REMIND_EVERY_S) {
        state.last_remind = Some(t);
        remind_unanswered(None).await?;
    }
    if due(state.last_hour, t, 60.0) {
        state.last_hour = Some(t);
        write_day_cards(None, None).await?;
        prune(None).await?;
    }
    tokio::time::sleep(Duration::from_secs_f64(pause)).await;
    Ok(())
}

async fn run_loop() {
    let dirty = DIRTY.lock().unwrap_or_else(|e| e.into_inner()).clone().unwrap_or_else(|| Arc::new(Event::new()));
    // never stops the loop
    if let Err(e) = backfill_waiting().await {
        tracing::error!("Could not write the rows of what was already waiting: {e}");
    }
    let mut state = Schedule { last_full: None, last_hour: None, last_remind: None };
    loop {
        if let Err(e) = round(&mut state, &dirty).await {
            tracing::error!("Notification loop failed: {e}");
            tokio::time::sleep(Duration::from_secs(2)).await;
        }
    }
}

/// Start the loop that closes rows, writes day cards and prunes. Call it inside the runtime, at startup.
pub fn start() {
    let mut task = TASK.lock().unwrap_or_else(|e| e.into_inner());
    if task.as_ref().is_none_or(|t| t.is_finished()) {
        *DIRTY.lock().unwrap_or_else(|e| e.into_inner()) = Some(Arc::new(Event::new()));
        events::on_publish(ON_PUBLISH_KEY, mark_dirty);
        *task = Some(tokio::spawn(run_loop()));
    }
}

/// Stop the loop.
pub async fn stop() {
    let task = TASK.lock().unwrap_or_else(|e| e.into_inner()).take();
    if let Some(task) = task {
        task.abort();
        let _ = task.await;
    }
}

/// Whether the loop is running (`_task is not None and not _task.done()`).
pub fn loop_running() -> bool {
    TASK.lock().unwrap_or_else(|e| e.into_inner()).as_ref().is_some_and(|t| !t.is_finished())
}
