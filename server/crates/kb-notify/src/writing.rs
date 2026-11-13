//! Part of `services/notifications.py`: lines 716 to 1103, "Writing: the log, then one row per recipient".

use std::collections::HashMap;

use chrono::{DateTime, Duration, Utc};
use kb_db::Session;
use kb_db::entities::{ai_schedule_run, notification, notify_event, notify_follow, notify_prefs};
use kb_db::sea_orm::{ActiveModelTrait, ActiveValue, ColumnTrait, EntityTrait, Order, QueryFilter, QueryOrder};
use serde_json::{Map, Value, json};

use crate::db::save_notification;
use crate::delivery::{LATER, PENDING, announce, mark_dirty};
use crate::error::{NotifyError, Result};
use crate::features::on_comment_event;
use crate::follow::quiet_by_follows;
use crate::helpers::{self, dumps, iso, loads_list, loads_map, parse, person_key, pop, utcnow};
use crate::kinds::{GROUP_ITEMS_KEPT, GROUP_NAMES_MAX, GROUP_WINDOW_MINUTES};
use crate::recipients::{followers, recipient_keys};
use crate::settings::{Prefs, event_switch, prefs_of};

/// Whether a kind is Needs you (the follow module asks it through here).
pub fn is_needs_kind(kind: &str) -> bool {
    helpers::is_needs(kind)
}

/// The key of the group a row belongs to (events of one group merge into one row).
pub fn group_key(
    kind: &str,
    project_id: Option<&str>,
    target_kind: Option<&str>,
    target_id: Option<&str>,
    ticket_id: Option<&str>,
) -> String {
    let project = || project_id.filter(|p| !p.is_empty()).unwrap_or("-");
    if helpers::is_needs(kind) {
        // Needs you items group only when they are the same request (a question asked again); failures of one
        // ticket are one row, as Retry answers them all
        if ["run_failed", "run_stopped_memory", "board_fault"].contains(&kind) {
            if let Some(ticket) = ticket_id.filter(|t| !t.is_empty()) {
                return format!("{kind}:ticket:{ticket}");
            }
        }
        if let Some(target) = target_id.filter(|t| !t.is_empty()) {
            return format!("{kind}:{}:{target}", target_kind.filter(|t| !t.is_empty()).unwrap_or("-"));
        }
        // nothing to point at: one row per project, never across projects
        return format!("{kind}:project:{}", project());
    }
    format!("{kind}:{}", project())
}

/// What an event says, for `emit` (`EmitFields`): its project (`None` when it is about no one project), who is
/// told, its words, what it points at, who caused it, its data, and `since` (when the thing began, if before now).
#[derive(Debug, Clone, Default)]
pub struct EmitFields {
    /// The project, or `None` for an event about no one project.
    pub project_id: Option<String>,
    /// Recipient keys.
    pub recipients: Vec<String>,
    /// The headline (kept to 300 characters).
    pub title: String,
    /// The words under it (kept to 2000 characters).
    pub body: Option<String>,
    /// What it points at: run, account, ticket, page, thread...
    pub target_kind: Option<String>,
    /// The id of what it points at.
    pub target_id: Option<String>,
    /// The ticket it is about.
    pub ticket_id: Option<String>,
    /// The Docs page it is about.
    pub page_id: Option<String>,
    /// The AI member it is about.
    pub member_id: Option<String>,
    /// Who caused it.
    pub actor: Option<String>,
    /// Facts, stored as JSON.
    pub data: Option<Map<String, Value>>,
    /// When the thing began, if before now.
    pub since: Option<String>,
}

fn clip(text: &str, max: usize) -> String {
    text.chars().take(max).collect()
}

/// Append an event to the log and write (or merge into) one row per recipient. Returns the event id.
///
/// The person who caused an information event is not told about it. Every event is recorded, even when nobody is
/// left to tell (the day card and a later `wait` read the log). Without a `session` it uses one of its own.
pub async fn emit(kind: &str, session: Option<&Session>, fields: EmitFields) -> Result<i32> {
    if crate::kinds::kind_info(kind).is_none() {
        return Err(NotifyError::value(format!("Unknown notification kind: {kind}")));
    }
    match session {
        Some(s) => emit_in(s, kind, fields).await,
        None => {
            let s = kb_db::session();
            emit_in(&s, kind, fields).await
        }
    }
}

async fn emit_in(session: &Session, kind: &str, fields: EmitFields) -> Result<i32> {
    let needs = helpers::is_needs(kind);
    let keys = keys_to_tell(&fields.recipients, fields.actor.as_deref(), needs);
    let data = fields.data.clone().unwrap_or_default();
    let mut row = notify_event::new();
    row.project_id = ActiveValue::Set(fields.project_id.clone());
    row.kind = ActiveValue::Set(kind.to_string());
    row.op = ActiveValue::Set("new".into());
    row.needs = ActiveValue::Set(needs);
    row.target_kind = ActiveValue::Set(fields.target_kind.clone());
    row.target_id = ActiveValue::Set(fields.target_id.clone());
    row.ticket_id = ActiveValue::Set(fields.ticket_id.clone());
    row.page_id = ActiveValue::Set(fields.page_id.clone());
    row.member_id = ActiveValue::Set(fields.member_id.clone());
    row.actor = ActiveValue::Set(fields.actor.clone());
    row.title = ActiveValue::Set(clip(&fields.title, 300));
    row.body = ActiveValue::Set(clip(fields.body.as_deref().unwrap_or(""), 2000));
    row.data = ActiveValue::Set(dumps(&Value::Object(data.clone())));
    row.recipients = ActiveValue::Set(dumps(&json!(keys)));
    let ev = row.insert(session).await?;
    let gk = group_key(
        kind,
        ev.project_id.as_deref(),
        ev.target_kind.as_deref(),
        ev.target_id.as_deref(),
        ev.ticket_id.as_deref(),
    );
    let now = utcnow();
    let item = json!({
        "event_id": ev.id,
        "title": ev.title,
        "body": clip(&ev.body, 200),
        "ticket_id": ev.ticket_id,
        "member_id": ev.member_id,
        "actor": ev.actor,
        "at": ev.created_at,
    });
    // Read what every recipient's row depends on in three queries, not three per recipient: the event's insert holds
    // the database's write lock until the commit below, and each await while it is held lets other work run first
    let mut known = recipients_state(session, &keys, &gk, ev.needs, now).await?;
    for key in &keys {
        if let Some((prefs, follows, row)) = known.remove(key) {
            write_row(session, key, &ev, &prefs, &follows, row, &item, &data, &gk, now, fields.since.as_deref())
                .await?;
        }
    }
    session.commit().await?;
    announce(Some(ev.id)).await;
    Ok(ev.id)
}

/// Each recipient once. The person who caused an information event is not told about it.
pub fn keys_to_tell(recipients: &[String], actor: Option<&str>, needs: bool) -> Vec<String> {
    let mut keys: Vec<String> = Vec::new();
    for r in recipients {
        if !r.is_empty() && !keys.contains(r) {
            keys.push(r.clone());
        }
    }
    if let Some(actor) = actor.filter(|a| !a.is_empty()) {
        if !needs {
            let me = person_key(Some(actor));
            keys.retain(|k| *k != me);
        }
    }
    keys
}

type Known = (Prefs, Vec<notify_follow::Model>, Option<notification::Model>);

/// For each recipient: their settings, their active follows and mutes, and the open row of this group an event
/// merges into (a Needs you row always, an information row while it is inside the group window).
pub async fn recipients_state(
    session: &Session,
    keys: &[String],
    group_key: &str,
    needs: bool,
    now: DateTime<Utc>,
) -> Result<HashMap<String, Known>> {
    if keys.is_empty() {
        return Ok(HashMap::new());
    }
    let prefs_rows: HashMap<String, notify_prefs::Model> = notify_prefs::Entity::find()
        .filter(notify_prefs::Column::Recipient.is_in(keys.iter().cloned()))
        .all(session)
        .await?
        .into_iter()
        .map(|r| (r.recipient.clone(), r))
        .collect();
    let mut follows: HashMap<String, Vec<notify_follow::Model>> =
        keys.iter().map(|k| (k.clone(), Vec::new())).collect();
    for f in notify_follow::Entity::find()
        .filter(notify_follow::Column::Recipient.is_in(keys.iter().cloned()))
        .all(session)
        .await?
    {
        let still = parse(f.until.as_deref()).is_none_or(|until| until > now);
        if still {
            follows.entry(f.recipient.clone()).or_default().push(f);
        }
    }
    let mut open_rows: HashMap<String, notification::Model> = HashMap::new();
    let candidates = notification::Entity::find()
        .filter(notification::Column::Recipient.is_in(keys.iter().cloned()))
        .filter(notification::Column::GroupKey.eq(group_key))
        .filter(notification::Column::DoneAt.is_null())
        .filter(notification::Column::ClearedAt.is_null())
        .order_by(notification::Column::CreatedAt, Order::Asc)
        .order_by(notification::Column::Id, Order::Asc)
        .all(session)
        .await?;
    for r in candidates {
        if open_rows.contains_key(&r.recipient) {
            continue;
        }
        let first = parse(Some(&r.created_at));
        if needs || first.is_some_and(|f| now.signed_duration_since(f) <= Duration::minutes(GROUP_WINDOW_MINUTES)) {
            open_rows.insert(r.recipient.clone(), r);
        }
    }
    let mut out = HashMap::new();
    for k in keys {
        let prefs = prefs_of(prefs_rows.get(k));
        out.insert(k.clone(), (prefs, follows.remove(k).unwrap_or_default(), open_rows.remove(k)));
    }
    Ok(out)
}

/// One recipient's row of an event: merged into `row` (their open row of its group), or a new row.
pub async fn write_row(
    session: &Session,
    key: &str,
    ev: &notify_event::Model,
    prefs: &Prefs,
    follows: &[notify_follow::Model],
    row: Option<notification::Model>,
    item: &Value,
    data: &Map<String, Value>,
    group_key: &str,
    now: DateTime<Utc>,
    since: Option<&str>,
) -> Result<()> {
    let (inapp, desktop) = event_switch(prefs, &ev.kind);
    let quiet =
        quiet_by_follows(follows, &ev.kind, ev.project_id.as_deref(), ev.ticket_id.as_deref(), ev.page_id.as_deref());
    if let Some(before) = row.filter(|_| ev.kind != "day_card") {
        let mut after = before.clone();
        merge_into(&mut after, ev, item, data, now);
        return save_notification(session, &before, &after).await;
    }
    let mut n = notification::new();
    n.recipient = ActiveValue::Set(key.to_string());
    n.event_id = ActiveValue::Set(ev.id);
    n.last_event_id = ActiveValue::Set(ev.id);
    n.project_id = ActiveValue::Set(ev.project_id.clone());
    n.kind = ActiveValue::Set(ev.kind.clone());
    n.needs = ActiveValue::Set(ev.needs);
    n.group_key = ActiveValue::Set(group_key.to_string());
    n.items = ActiveValue::Set(dumps(&json!([item])));
    n.target_kind = ActiveValue::Set(ev.target_kind.clone());
    n.target_id = ActiveValue::Set(ev.target_id.clone());
    n.ticket_id = ActiveValue::Set(ev.ticket_id.clone());
    n.page_id = ActiveValue::Set(ev.page_id.clone());
    n.member_id = ActiveValue::Set(ev.member_id.clone());
    n.actor = ActiveValue::Set(ev.actor.clone());
    n.title = ActiveValue::Set(ev.title.clone());
    n.body = ActiveValue::Set(ev.body.clone());
    n.data = ActiveValue::Set(ev.data.clone());
    n.inapp = ActiveValue::Set(inapp && !quiet);
    n.desktop = ActiveValue::Set(desktop && !quiet);
    // how long it has waited counts from when the thing began (an AI's question: when it asked)
    n.created_at = ActiveValue::Set(since.filter(|s| !s.is_empty()).unwrap_or(&ev.created_at).to_string());
    n.updated_at = ActiveValue::Set(ev.created_at.clone());
    n.insert(session).await?;
    Ok(())
}

/// One more event in an open row: counted, unread again, and its words updated. A reminder of the same request is
/// not one more thing: the row only comes back (newest event, unread, not snoozed).
pub fn merge_into(
    row: &mut notification::Model,
    ev: &notify_event::Model,
    item: &Value,
    data: &Map<String, Value>,
    now: DateTime<Utc>,
) {
    row.last_event_id = ev.id;
    row.read_at = None;
    row.updated_at = iso(&now);
    let mut kept = loads_map(Some(&row.data));
    if data.get("reminder").is_some_and(kb_base::pyjson::truthy) {
        row.snoozed_until = None;
        // remembered, so the "unanswered for N minutes" reminder comes once per request (#270)
        kept.insert("reminded_at".into(), json!(iso(&now)));
        row.data = dumps(&Value::Object(kept));
        return;
    }
    if pop(&mut kept, "reminded_at").is_some() {
        // a new event is a new request for attention: it may remind again if it too stays unanswered
        row.data = dumps(&Value::Object(kept));
    }
    let mut items = loads_list(Some(&row.items));
    items.push(item.clone());
    let from = items.len().saturating_sub(GROUP_ITEMS_KEPT);
    row.items = dumps(&Value::Array(items[from..].to_vec()));
    row.count += 1;
    if ev.needs {
        row.snoozed_until = None;
        // the latest words of the same request (a failure again, a question asked again); a safety reminder of it
        // ("has waited 6 h") keeps the request's own words
        if !data.get("safety_id").is_some_and(kb_base::pyjson::truthy) {
            row.title = ev.title.clone();
            row.body = ev.body.clone();
        }
        if ev.target_kind.as_deref() == Some("run") || row.target_kind.as_deref() != Some("run") {
            row.target_kind = ev.target_kind.clone();
            row.target_id = ev.target_id.clone();
        }
    } else {
        row.title = group_title(&ev.kind, &items, i64::from(row.count));
        row.body = group_body(&items, Some(i64::from(row.count)));
        let mut merged = loads_map(Some(&row.data));
        for (k, v) in data {
            merged.insert(k.clone(), v.clone());
        }
        row.data = dumps(&Value::Object(merged));
    }
}

/// An event queued by `enqueue`: what `emit` takes, plus the names to turn into recipient keys and the ticket whose
/// followers are told too.
#[derive(Debug, Clone, Default)]
pub struct PendingEvent {
    /// The kind of the event.
    pub kind: String,
    /// The event's fields (`recipients` may be empty when `names` is given).
    pub fields: EmitFields,
    /// Names to turn into recipient keys (`recipient_keys`), if any.
    pub names: Option<Vec<Option<String>>>,
    /// A ticket whose followers are told as well.
    pub follow_ticket: Option<String>,
}

/// Record an event from synchronous code (the schedules' own feed); the loop writes it within a second.
pub fn enqueue(event: PendingEvent) {
    PENDING.lock().unwrap_or_else(|e| e.into_inner()).push_back(event);
    mark_dirty();
}

/// Write the events queued by synchronous callers.
pub async fn flush_pending() -> Result<i64> {
    let mut n = 0;
    loop {
        let next = LATER.lock().unwrap_or_else(|e| e.into_inner()).pop_front();
        let Some(fields) = next else { break };
        on_comment_event(fields).await;
        n += 1;
    }
    loop {
        let next = PENDING.lock().unwrap_or_else(|e| e.into_inner()).pop_front();
        let Some(mut item) = next else { break };
        let kind = item.kind.clone();
        let result = async {
            prepare_pending(&mut item).await?;
            emit(&kind, None, item.fields.clone()).await
        }
        .await;
        match result {
            Ok(_) => n += 1,
            // a notification never breaks the feature that sent it
            Err(e) => tracing::error!("Could not record a {kind} notification: {e}"),
        }
    }
    Ok(n)
}

/// A queued event's names become recipient keys, and a scheduled slot points at its last run.
pub async fn prepare_pending(item: &mut PendingEvent) -> Result<()> {
    let s = kb_db::session();
    if let Some(names) = &item.names {
        let refs: Vec<Option<&str>> = names.iter().map(|n| n.as_deref()).collect();
        item.fields.recipients = recipient_keys(&s, item.fields.project_id.as_deref(), &refs).await?;
    }
    // the bell on a ticket brings "comments, runs and schedule events of this ticket" (design, Notifications)
    if let Some(watched) = item.follow_ticket.take().filter(|w| !w.is_empty()) {
        let mut all = item.fields.recipients.clone();
        all.extend(followers(&s, "ticket", Some(&watched)).await?);
        let mut seen: Vec<String> = Vec::new();
        for r in all {
            if !seen.contains(&r) {
                seen.push(r);
            }
        }
        item.fields.recipients = seen;
    }
    if item.fields.target_kind.as_deref() == Some("schedule_run")
        && item.fields.target_id.as_deref().is_some_and(|t| !t.is_empty())
    {
        point_at_last_run(&s, &mut item.fields).await?;
    }
    Ok(())
}

/// A scheduled slot points at its last run, so Retry and "retried" work as for any run.
pub async fn point_at_last_run(session: &Session, item: &mut EmitFields) -> Result<()> {
    let target = item.target_id.clone().unwrap_or_default();
    let srun = ai_schedule_run::Entity::find_by_id(target.clone()).one(session).await?;
    let run_ids = srun.map(|s| loads_list(Some(&s.run_ids))).unwrap_or_default();
    if let Some(last) = run_ids.last() {
        let mut data = item.data.clone().unwrap_or_default();
        data.insert("srun_id".into(), json!(target));
        item.data = Some(data);
        item.target_kind = Some("run".into());
        item.target_id =
            Some(helpers::as_str(Some(last)).map(str::to_string).unwrap_or_else(|| kb_base::pyjson::py_str(last)));
    }
    Ok(())
}

const GROUP_TITLES: [(&str, &str); 8] = [
    ("ai_finished", "{n} AI finished work"),
    ("schedule", "{n} scheduled runs ended"),
    ("schedule_started", "{n} scheduled runs started"),
    ("page_published", "{n} pages were published"),
    ("comment", "{n} new comments in threads you follow"),
    ("run_cancelled", "{n} runs were cancelled"),
    ("budget_warning", "{n} budget warnings"),
    ("access_request", "{n} people asked for access to Docs"),
];

/// The headline of a grouped row.
pub fn group_title(kind: &str, _items: &[Value], count: i64) -> String {
    let n = if count > GROUP_NAMES_MAX { "20+".to_string() } else { count.to_string() };
    let template = GROUP_TITLES.iter().find(|(k, _)| *k == kind).map(|(_, t)| *t).unwrap_or("{n} updates");
    template.replace("{n}", &n)
}

/// The words under the headline of a grouped row: who, and which tickets.
pub fn group_body(items: &[Value], count: Option<i64>) -> String {
    let total = count.filter(|c| *c != 0).unwrap_or(items.len() as i64);
    if total > GROUP_NAMES_MAX {
        return format!("{total} in 10 minutes");
    }
    let mut names: Vec<String> = Vec::new();
    for i in items {
        let who = helpers::as_str(i.get("actor")).unwrap_or("");
        if !who.is_empty() && !names.iter().any(|n| n == who) {
            names.push(who.to_string());
        }
    }
    let mut tickets: Vec<String> = Vec::new();
    for i in items {
        if let Some(t) = helpers::as_str(i.get("ticket_id")).filter(|t| !t.is_empty()) {
            if !tickets.iter().any(|x| x == t) {
                tickets.push(t.to_string());
            }
        }
    }
    tickets.sort_by_key(|t| ticket_order(t));
    let mut parts: Vec<String> = Vec::new();
    if !names.is_empty() {
        let shown = &names[..names.len().min(4)];
        let more = names.len() - shown.len();
        let mut text = shown.join(", ");
        if more > 0 {
            text.push_str(&format!(" and {more} more"));
        }
        parts.push(text);
    }
    if let (Some(first), Some(last)) = (tickets.first(), tickets.last()) {
        parts.push(if tickets.len() == 1 { first.clone() } else { format!("{first} to {last}") });
    }
    parts.join(" · ")
}

/// The sort key of a ticket id: its prefix, then its number.
pub fn ticket_order(t: &str) -> (String, i64) {
    if let Some((prefix, number)) = t.rsplit_once('-') {
        if !prefix.is_empty()
            && prefix.chars().all(|c| c.is_ascii_alphabetic())
            && !number.is_empty()
            && number.chars().all(|c| c.is_ascii_digit())
        {
            if let Ok(n) = number.parse::<i64>() {
                return (prefix.to_string(), n);
            }
        }
    }
    (t.to_string(), 0)
}
