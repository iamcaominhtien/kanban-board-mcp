//! Part of `services/notifications.py`: lines 2742 to 3100, "The day in one card, and retention".

use std::collections::{BTreeSet, HashMap};

use chrono::{DateTime, Duration, FixedOffset, Utc};
use kb_db::Session;
use kb_db::entities::{ai_run, ai_schedule, notification, notify_event, notify_prefs, project};
use kb_db::sea_orm::sea_query::{Expr, ExprTrait};
use kb_db::sea_orm::{ColumnTrait, EntityTrait, Order, PaginatorTrait, QueryFilter, QueryOrder, QuerySelect};
use serde_json::{Map, Value, json};

use crate::error::{NotifyError, Result};
use crate::helpers::{self, iso, loads_map, local, midnight, parse, person_key, plural, truthy, utcnow};
use crate::reading::is_snoozed;
use crate::settings::{get_prefs, global, retention_days, set_global};
use crate::writing::{EmitFields, emit, ticket_order};

/// Every person who has settings or a row (never an AI member): the day card goes to each of them.
pub async fn people(session: &Session) -> Result<Vec<String>> {
    let mut keys: BTreeSet<String> = BTreeSet::new();
    keys.insert("user".into());
    let prefs: Vec<String> = notify_prefs::Entity::find()
        .select_only()
        .column(notify_prefs::Column::Recipient)
        .into_tuple::<String>()
        .all(session)
        .await?;
    keys.extend(prefs);
    let rows: Vec<String> = notification::Entity::find()
        .select_only()
        .column(notification::Column::Recipient)
        .distinct()
        .into_tuple::<String>()
        .all(session)
        .await?;
    keys.extend(rows);
    Ok(keys.into_iter().filter(|k| k != "*" && !k.starts_with("ai:")).collect())
}

/// The day in numbers and lines, counted from the log and the runs. Nothing is asked of an AI.
pub async fn build_day_card(
    session: &Session,
    me: &str,
    since: DateTime<FixedOffset>,
    until: DateTime<FixedOffset>,
) -> Result<Value> {
    let (s_iso, u_iso) = (iso(&since), iso(&until));
    let runs = runs_of_the_day(session, me, &s_iso, &u_iso).await?;
    let finished: Vec<&ai_run::Model> = runs.iter().filter(|r| r.state == "finished").collect();
    let failed: Vec<&ai_run::Model> = runs.iter().filter(|r| r.state == "failed" || r.state == "timed_out").collect();
    // `round(sum(cost or 0), 2)`: a sum of zeros is the integer 0, not 0.0
    let spent = if runs.iter().any(|r| r.cost_usd != 0.0) {
        let total: f64 = runs.iter().map(|r| r.cost_usd).sum();
        let rounded = format!("{total:.2}").parse::<f64>().unwrap_or(total);
        json!(rounded)
    } else {
        json!(0)
    };
    let now = utcnow();
    let (waiting_open, snoozed) = waiting_of(session, me, now).await?;
    let projects: HashMap<String, project::Model> =
        project::Entity::find().all(session).await?.into_iter().map(|p| (p.id.clone(), p)).collect();
    let mut lines = finished_lines(&finished, &projects);
    let not_retried = not_retried(session, &failed).await?;
    if !failed.is_empty() {
        lines.push(failed_line(&failed, &not_retried));
    }
    if !waiting_open.is_empty() {
        lines.push(waiting_line(&waiting_open, now));
    }
    let published = published_between(session, &s_iso, &u_iso).await?;
    if published != 0 {
        lines.push(docs_line(published));
    }
    if !snoozed.is_empty() {
        let titles: Vec<&str> = snoozed.iter().take(2).map(|r| r.title.as_str()).collect();
        lines.push(json!({
            "kind": "snoozed",
            "text": format!("{} still snoozed: {}.", snoozed.len(), titles.join(", ")),
        }));
    }
    if let Some(t) = tomorrow_line(session, now).await? {
        lines.push(t);
    }
    let quiet = runs.is_empty() && waiting_open.is_empty() && published == 0;
    if quiet {
        lines = vec![json!({"kind": "quiet", "text": "A quiet day: nothing ran and nothing waits for you."})];
    }
    let mut project_ids: BTreeSet<String> = runs.iter().map(|r| r.project_id.clone()).collect();
    project_ids.extend(waiting_open.iter().filter_map(|r| r.project_id.clone()).filter(|p| !p.is_empty()));
    Ok(json!({
        "since": s_iso,
        "until": u_iso,
        "finished": finished.len(),
        "failed": failed.len(),
        // only what has not been retried yet, so "Retry both failed" never starts a run twice
        "failed_runs": not_retried.iter().map(|r| r.id.clone()).collect::<Vec<_>>(),
        "waiting": waiting_open.len(),
        "waiting_ids": waiting_open.iter().map(|r| r.id.clone()).collect::<Vec<_>>(),
        "snoozed": snoozed.len(),
        "spent": spent,
        "projects": project_ids.len(),
        "lines": lines,
        "quiet": quiet,
    }))
}

/// The recipient's open Needs you rows: (still waiting, oldest first; snoozed).
pub async fn waiting_of(
    session: &Session,
    me: &str,
    now: DateTime<Utc>,
) -> Result<(Vec<notification::Model>, Vec<notification::Model>)> {
    let waiting = notification::Entity::find()
        .filter(notification::Column::Recipient.eq(me))
        .filter(notification::Column::Needs.eq(true))
        .filter(notification::Column::DoneAt.is_null())
        .all(session)
        .await?;
    let (snoozed, mut open): (Vec<_>, Vec<_>) = waiting.into_iter().partition(|r| is_snoozed(r, now));
    open.sort_by(|a, b| a.created_at.cmp(&b.created_at));
    Ok((open, snoozed))
}

/// The work runs that ended in the span: every one for the board's own user, else the person's own runs and the
/// runs of the projects they have notifications in.
pub async fn runs_of_the_day(session: &Session, me: &str, s_iso: &str, u_iso: &str) -> Result<Vec<ai_run::Model>> {
    let runs = ai_run::Entity::find()
        .filter(ai_run::Column::EndedAt.gte(s_iso))
        .filter(ai_run::Column::EndedAt.lt(u_iso))
        .filter(ai_run::Column::Mode.eq("work"))
        .all(session)
        .await?;
    if me == "user" {
        return Ok(runs);
    }
    let mine_projects: BTreeSet<Option<String>> = notification::Entity::find()
        .filter(notification::Column::Recipient.eq(me))
        .all(session)
        .await?
        .into_iter()
        .map(|r| r.project_id)
        .collect();
    Ok(runs
        .into_iter()
        .filter(|r| person_key(Some(&r.started_by)) == me || mine_projects.contains(&Some(r.project_id.clone())))
        .collect())
}

/// One line per project with finished runs, the busiest first.
pub fn finished_lines(finished: &[&ai_run::Model], projects: &HashMap<String, project::Model>) -> Vec<Value> {
    let mut order: Vec<String> = Vec::new();
    let mut by_project: HashMap<String, Vec<&ai_run::Model>> = HashMap::new();
    for r in finished {
        if !by_project.contains_key(&r.project_id) {
            order.push(r.project_id.clone());
        }
        by_project.entry(r.project_id.clone()).or_default().push(r);
    }
    let mut groups: Vec<(String, Vec<&ai_run::Model>)> =
        order.into_iter().map(|pid| (pid.clone(), by_project.remove(&pid).unwrap_or_default())).collect();
    groups.sort_by_key(|(_, rs)| std::cmp::Reverse(rs.len()));
    let mut lines = Vec::new();
    for (pid, rs) in groups {
        let name = projects.get(&pid).map(|p| p.name.clone()).unwrap_or_else(|| "A project".to_string());
        let mut tickets: Vec<String> = rs.iter().filter_map(|r| r.ticket_id.clone()).collect();
        tickets.sort_by_key(|t| ticket_order(t));
        tickets.dedup();
        let n = rs.len() as i64;
        let mut text = format!("{name}: {n} AI run{} finished", plural(n));
        if !tickets.is_empty() {
            let more = if tickets.len() > 3 { " and more" } else { "" };
            let shown: Vec<&str> = tickets.iter().take(3).map(String::as_str).collect();
            text.push_str(&format!(" on {}{more}", shown.join(", ")));
        }
        lines.push(json!({"kind": "project", "project_id": pid, "text": format!("{text}.")}));
    }
    lines
}

/// The failed runs with no later run of their ticket.
pub async fn not_retried<'a>(session: &Session, failed: &[&'a ai_run::Model]) -> Result<Vec<&'a ai_run::Model>> {
    let mut out = Vec::new();
    for r in failed {
        let newer = ai_run::Entity::find()
            .filter(ai_run::Column::TicketId.eq(r.ticket_id.clone()))
            .filter(ai_run::Column::Mode.eq("work"))
            .filter(ai_run::Column::QueuedAt.gt(r.ended_at.clone().unwrap_or_else(|| r.queued_at.clone())))
            .one(session)
            .await?;
        if newer.is_none() {
            out.push(*r);
        }
    }
    Ok(out)
}

/// The line about failed runs.
pub fn failed_line(failed: &[&ai_run::Model], not_retried: &[&ai_run::Model]) -> Value {
    let mut parts = Vec::new();
    for r in failed.iter().take(3) {
        let reason = r.ended_reason.clone().filter(|s| !s.is_empty()).unwrap_or_else(|| r.state.replace('_', " "));
        let why = reason.split(". ").next().unwrap_or("");
        parts.push(format!("{} ({})", helpers::opt_str(&r.ticket_id), helpers::head_chars(why, 60)));
    }
    let end = if failed.len() > not_retried.len() {
        "."
    } else if failed.len() == 2 {
        ". Neither has been retried."
    } else {
        ". Not retried yet."
    };
    json!({
        "kind": "failed",
        "text": format!("{} run{} failed: {}{end}", failed.len(), plural(failed.len() as i64), parts.join(", ")),
    })
}

/// The line about what still waits for the person.
pub fn waiting_line(waiting_open: &[notification::Model], now: DateTime<Utc>) -> Value {
    let oldest = &waiting_open[0];
    let when = parse(Some(&oldest.created_at)).map(|d| local(&d)).unwrap_or_else(|| local(&now));
    let t = when.format("%H:%M").to_string();
    let from_data = if oldest.data.is_empty() {
        None
    } else {
        loads_map(Some(&oldest.data)).get("member_name").filter(|v| truthy(Some(v))).map(kb_base::pyjson::py_str)
    };
    let who = from_data.or_else(|| oldest.actor.clone().filter(|a| !a.is_empty())).unwrap_or_default();
    let about = if who.is_empty() {
        format!(" — {}", oldest.title)
    } else {
        let what = oldest.ticket_id.clone().filter(|t| !t.is_empty()).unwrap_or_else(|| oldest.title.clone());
        format!(" — {who} on {what}")
    };
    json!({
        "kind": "waiting",
        "text": format!("{} still wait for you, the oldest since {t}{about}.", waiting_open.len()),
    })
}

/// How many pages were published in the span.
pub async fn published_between(session: &Session, s_iso: &str, u_iso: &str) -> Result<i64> {
    let n = notify_event::Entity::find()
        .filter(notify_event::Column::Kind.eq("page_published"))
        .filter(notify_event::Column::CreatedAt.gte(s_iso))
        .filter(notify_event::Column::CreatedAt.lt(u_iso))
        .count(session)
        .await?;
    Ok(n as i64)
}

/// The line about Docs.
pub fn docs_line(published: i64) -> Value {
    json!({"kind": "docs", "text": format!("Docs: {published} page{} published.", plural(published))})
}

/// Tomorrow's scheduled runs, or `None` when there are none.
pub async fn tomorrow_line(session: &Session, now: DateTime<Utc>) -> Result<Option<Value>> {
    let tomorrow0 = midnight(&(local(&now) + Duration::days(1)));
    let tomorrow1 = tomorrow0 + Duration::days(1);
    let sched = ai_schedule::Entity::find()
        .filter(ai_schedule::Column::State.eq("active"))
        .filter(ai_schedule::Column::NextRunAt.gte(iso(&tomorrow0.with_timezone(&Utc))))
        .filter(ai_schedule::Column::NextRunAt.lt(iso(&tomorrow1.with_timezone(&Utc))))
        .all(session)
        .await?;
    if sched.is_empty() {
        return Ok(None);
    }
    let first = sched.iter().filter_map(|s| parse(s.next_run_at.as_deref().filter(|n| !n.is_empty()))).min();
    let Some(first) = first else {
        return Ok(None);
    };
    let n = sched.len() as i64;
    Ok(Some(json!({
        "kind": "tomorrow",
        "text": format!("Tomorrow: {n} scheduled run{}, the first at {}.", plural(n), local(&first).format("%H:%M")),
    })))
}

/// At the card time (weekdays at 18:00 by default) write each person's card for the day, once. Only what happened
/// since the last card; a closed app writes it the next time it runs, with the date.
pub async fn write_day_cards(now: Option<DateTime<Utc>>, force_for: Option<&str>) -> Result<i64> {
    let now = now.unwrap_or_else(utcnow);
    let local_now = local(&now);
    let mut n = 0;
    let session = kb_db::session();
    let people: Vec<String> = match force_for.filter(|f| !f.is_empty()) {
        Some(f) => vec![f.to_string()],
        None => people(&session).await?,
    };
    let forced = force_for.is_some_and(|f| !f.is_empty());
    for me in people {
        let prefs = get_prefs(&session, &me).await?;
        let card_prefs =
            prefs.get("day_card").filter(|v| truthy(Some(v))).and_then(Value::as_object).cloned().unwrap_or_default();
        if !forced && !card_due(&card_prefs, &local_now) {
            continue;
        }
        let id = day_id(&me, &local_now, &now, forced);
        // the scheduled card of the day is written once: a card asked for now ("Sum up today") neither stands in
        // for it nor makes it come again
        if !forced && card_of(&session, &me, &id).await?.is_some() {
            continue;
        }
        let last = latest_scheduled_card(&session, &me).await?;
        let since = card_since(last.as_ref(), &local_now)
            .ok_or_else(|| NotifyError::Internal("'NoneType' object has no attribute 'isoformat'".into()))?;
        let facts = build_day_card(&session, &me, since, now.fixed_offset()).await?;
        let projects = facts.get("projects").and_then(Value::as_i64).unwrap_or(0);
        let body = format!(
            "{} · {} · {projects} project{}",
            local_now.format("%a %d %b"),
            local_now.format("%H:%M"),
            plural(projects)
        );
        emit(
            "day_card",
            Some(&session),
            EmitFields {
                project_id: None,
                recipients: vec![me.clone()],
                title: "Today on your boards".into(),
                body: Some(body),
                target_kind: Some("day".into()),
                target_id: Some(id),
                data: match facts {
                    Value::Object(m) => Some(m),
                    _ => Some(Map::new()),
                },
                ..Default::default()
            },
        )
        .await?;
        n += 1;
    }
    Ok(n)
}

/// The person's card that points at this day id.
pub async fn card_of(session: &Session, me: &str, day_id: &str) -> Result<Option<notification::Model>> {
    Ok(notification::Entity::find()
        .filter(notification::Column::Recipient.eq(me))
        .filter(notification::Column::Kind.eq("day_card"))
        .filter(notification::Column::TargetId.eq(day_id))
        .one(session)
        .await?)
}

/// The person's latest card written at the card time (not one asked for now): a card counts from it.
pub async fn latest_scheduled_card(session: &Session, me: &str) -> Result<Option<notification::Model>> {
    Ok(notification::Entity::find()
        .filter(notification::Column::Recipient.eq(me))
        .filter(notification::Column::Kind.eq("day_card"))
        .filter(notification::Column::TargetId.not_like(format!("%{FORCED}%")))
        .order_by(notification::Column::CreatedAt, Order::Desc)
        .one(session)
        .await?)
}

/// Whether a person's card is due now: it is on, today is one of its days and its time has come.
pub fn card_due(card: &Map<String, Value>, local: &DateTime<FixedOffset>) -> bool {
    use chrono::Datelike;
    let on = card.get("on").is_none_or(kb_base::pyjson::truthy);
    let weekday = i128::from(local.weekday().num_days_from_monday());
    let in_days = match card.get("days") {
        Some(Value::Array(days)) => days.iter().any(|d| crate::helpers::py_int(d).is_ok_and(|n| n == weekday)),
        Some(_) => false,
        None => weekday <= 4,
    };
    if !on || !in_days {
        return false;
    }
    let time = helpers::as_str(card.get("time")).unwrap_or("18:00");
    local.format("%H:%M").to_string().as_str() >= time
}

/// What a card points at: the person's day (one card a day), or this moment for a card asked for now.
pub fn day_id(me: &str, local: &DateTime<FixedOffset>, now: &DateTime<Utc>, forced: bool) -> String {
    let id = format!("{me}:{}", local.date_naive().format("%Y-%m-%d"));
    if forced { format!("{id}{FORCED}{}", now.timestamp()) } else { id }
}

/// What the day id of a card asked for now has after the day.
pub const FORCED: &str = ":now:";

/// A card counts from the last scheduled card, or from midnight for the first one.
pub fn card_since(last: Option<&notification::Model>, local: &DateTime<FixedOffset>) -> Option<DateTime<FixedOffset>> {
    match last {
        Some(l) => parse(Some(&l.created_at)),
        None => Some(midnight(local).with_timezone(&Utc).fixed_offset()),
    }
}

/// Retention is the only thing that deletes: rows and log events older than the setting (90 days by default). The id
/// of the newest deleted event is kept, so a cursor older than that gets "cursor too old".
pub async fn prune(now: Option<DateTime<Utc>>) -> Result<i64> {
    let now = now.unwrap_or_else(utcnow);
    let session = kb_db::session();
    let days = retention_days(&session).await?;
    let cutoff = Duration::try_days(days)
        .and_then(|d| now.checked_sub_signed(d))
        .map(|d| iso(&d))
        .ok_or_else(|| NotifyError::Internal("date value out of range".into()))?;
    let last: Option<Option<i32>> = notify_event::Entity::find()
        .filter(notify_event::Column::CreatedAt.lt(cutoff.clone()))
        .select_only()
        .column_as(Expr::col(notify_event::Column::Id).max(), "last")
        .into_tuple::<Option<i32>>()
        .one(&session)
        .await?;
    let r1 = notification::Entity::delete_many()
        .filter(notification::Column::UpdatedAt.lt(cutoff.clone()))
        // an open Needs you row is work still waiting: it stays until it is done
        .filter(
            kb_db::sea_orm::Condition::any()
                .add(notification::Column::Needs.eq(false))
                .add(notification::Column::DoneAt.is_not_null()),
        )
        .exec(&session)
        .await?;
    notify_event::Entity::delete_many().filter(notify_event::Column::CreatedAt.lt(cutoff)).exec(&session).await?;
    if let Some(last) = last.flatten().filter(|l| *l != 0) {
        let g = global(&session).await?;
        let current = crate::reading::pruned_through(&g);
        set_global(&session, &[("pruned_through", json!(current.max(i128::from(last)) as i64))]).await?;
    }
    session.commit().await?;
    Ok(r1.rows_affected as i64)
}
