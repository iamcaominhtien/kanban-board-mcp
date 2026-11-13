//! Reading a schedule (`services/ai/schedules.py` lines 225 to 365): `limits_of`, `_names`, `summary_text`,
//! `run_to_dict`, `to_dict`.

use std::collections::HashMap;

use kb_ai::store::{get_profile, loads, parse_iso};
use kb_db::Session;
use kb_db::entities::{ai_schedule, ai_schedule_run, member, ticket};
use kb_db::sea_orm::{ColumnTrait, DbErr, EntityTrait, QueryFilter, QueryOrder, QuerySelect};
use serde_json::{Map, Value, json};

use super::check::offline_risk;
use super::when::{clock_time, fmt_day, in_words, once_at, tz_label, when_label};
use super::{Error, default_limits};
use crate::pynum::round_to;

/// Run limits with defaults.
pub fn limits_of(s: &ai_schedule::Model) -> Map<String, Value> {
    let mut out = default_limits();
    if let Value::Object(own) = loads(Some(&s.limits), json!({})) {
        for (key, value) in own {
            out.insert(key, value);
        }
    }
    out
}

/// `_names`: the names of these members, by id.
pub async fn names<'a>(
    session: &Session,
    ids: impl IntoIterator<Item = Option<&'a str>>,
) -> Result<HashMap<String, String>, DbErr> {
    let mut wanted: Vec<&str> = ids.into_iter().flatten().filter(|id| !id.is_empty()).collect();
    wanted.sort_unstable();
    wanted.dedup();
    if wanted.is_empty() {
        return Ok(HashMap::new());
    }
    let rows = member::Entity::find().filter(member::Column::Id.is_in(wanted)).all(session).await?;
    Ok(rows.into_iter().map(|m| (m.id, m.name)).collect())
}

/// `text[0].lower() + text[1:]`.
pub(crate) fn lower_first(text: &str) -> String {
    let mut chars = text.chars();
    match chars.next() {
        Some(first) => first.to_lowercase().chain(chars).collect(),
        None => String::new(),
    }
}

/// The plain-language "In short" line (C).
pub async fn summary_text(session: &Session, s: &ai_schedule::Model) -> Result<String, Error> {
    let names = names(session, [Some(s.member_id.as_str()), s.backup_member_id.as_deref()]).await?;
    let ai = names.get(&s.member_id).map_or("The team", String::as_str);
    let tzl = tz_label(&s.tz, None)?;
    let when = if s.kind == "once" {
        match once_at(s)? {
            Some(at) => format!("On {} at {} ({tzl})", fmt_day(at, &s.tz)?, clock_time(at, &s.tz)?),
            None => "Once".to_string(),
        }
    } else {
        let label = lower_first(&when_label(s)?);
        let when = match label.strip_prefix("every ") {
            Some(rest) => format!("Every {rest}"),
            None => format!("Every {label}"),
        };
        let when = when.replace("Every weekdays", "Every weekday").replace("Every weekends", "Every weekend");
        format!("{} ({tzl})", when.replace("Every every day", "Every day"))
    };
    let mut parts =
        vec![format!("{when}, {ai} works on {}.", s.ticket_id), "The lead decides what to do and reports.".to_string()];
    if let Some(backup) = s.backup_member_id.as_deref().filter(|b| !b.is_empty()) {
        parts.push(format!(
            "If {ai} is unavailable, {} runs it.",
            names.get(backup).map_or("the backup team", String::as_str)
        ));
    }
    if s.kind == "repeat" && s.ends == "after" && s.ends_after.is_some_and(|n| n != 0) {
        parts.push(format!("It ends after {} runs.", s.ends_after.unwrap_or(0)));
    } else if s.kind == "repeat" && s.ends == "on_date" && s.ends_on.as_deref().is_some_and(|e| !e.is_empty()) {
        parts.push(format!("It ends on {}.", s.ends_on.as_deref().unwrap_or("")));
    }
    parts.push("It never moves past Review.".to_string());
    Ok(parts.join(" "))
}

/// One slot for the UI. (`names` None: no names.)
pub fn run_to_dict(r: &ai_schedule_run::Model, names: Option<&HashMap<String, String>>) -> Map<String, Value> {
    // `names.get(r.member_id or "")`
    let member_name = names.and_then(|names| names.get(r.member_id.as_deref().unwrap_or("")));
    let mut out = Map::new();
    out.insert("id".into(), json!(r.id));
    out.insert("schedule_id".into(), json!(r.schedule_id));
    out.insert("ticket_id".into(), json!(r.ticket_id));
    out.insert("slot_at".into(), json!(r.slot_at));
    out.insert("state".into(), json!(r.state));
    out.insert("catch_up".into(), json!(r.catch_up));
    out.insert("member_id".into(), json!(r.member_id));
    out.insert("member_name".into(), json!(member_name));
    out.insert("run_ids".into(), loads(Some(&r.run_ids), json!([])));
    out.insert("attempts".into(), json!(r.attempts));
    out.insert("note".into(), json!(r.note));
    out.insert("started_at".into(), json!(r.started_at));
    out.insert("ended_at".into(), json!(r.ended_at));
    out.insert("duration_s".into(), json!(r.duration_s));
    out.insert("cost_usd".into(), json!(round_to(r.cost_usd.get(), 4)));
    out
}

/// A schedule for the UI: settings, labels and the last slot. (`last` None: the newest slot is read.)
pub async fn to_dict(
    session: &Session,
    s: &ai_schedule::Model,
    last: Option<&ai_schedule_run::Model>,
) -> Result<Map<String, Value>, Error> {
    let names = names(session, [Some(s.member_id.as_str()), s.backup_member_id.as_deref()]).await?;
    let ticket = ticket::Entity::find_by_id(s.ticket_id.as_str()).one(session).await?;
    let (_, profile) = get_profile(session, &s.member_id).await?;
    let nxt = parse_iso(s.next_run_at.as_deref());
    let read;
    let last = match last {
        Some(last) => Some(last),
        None => {
            read = ai_schedule_run::Entity::find()
                .filter(ai_schedule_run::Column::ScheduleId.eq(s.id.as_str()))
                .order_by_desc(ai_schedule_run::Column::SlotAt)
                .limit(1)
                .one(session)
                .await?;
            read.as_ref()
        }
    };
    let ticket_changed = ticket.as_ref().is_some_and(|t| {
        s.ticket_seen_at
            .as_deref()
            .is_some_and(|seen| !seen.is_empty() && !t.updated_at.is_empty() && t.updated_at.as_str() > seen)
    });
    let mut out = Map::new();
    out.insert("id".into(), json!(s.id));
    out.insert("project_id".into(), json!(s.project_id));
    out.insert("ticket_id".into(), json!(s.ticket_id));
    out.insert("ticket_title".into(), json!(ticket.as_ref().map(|t| t.title.as_str())));
    out.insert("ticket_status".into(), json!(ticket.as_ref().map(|t| t.status.as_str())));
    out.insert("member_id".into(), json!(s.member_id));
    out.insert("member_name".into(), json!(names.get(&s.member_id)));
    out.insert("connection".into(), json!(profile.as_ref().map(|p| p.connection.as_str())));
    out.insert("backup_member_id".into(), json!(s.backup_member_id));
    out.insert("backup_member_name".into(), json!(names.get(s.backup_member_id.as_deref().unwrap_or(""))));
    out.insert("created_by".into(), json!(s.created_by));
    out.insert("kind".into(), json!(s.kind));
    out.insert("run_at".into(), json!(s.run_at));
    out.insert("days".into(), loads(Some(&s.days), json!([])));
    out.insert("time".into(), json!(s.time));
    out.insert("tz".into(), json!(s.tz));
    out.insert("tz_label".into(), json!(tz_label(&s.tz, None)?));
    out.insert("ends".into(), json!(s.ends));
    out.insert("ends_after".into(), json!(s.ends_after));
    out.insert("ends_on".into(), json!(s.ends_on));
    out.insert("window_end".into(), json!(s.window_end));
    out.insert("limits".into(), Value::Object(limits_of(s)));
    out.insert("catch_up".into(), json!(s.catch_up));
    out.insert("catch_up_hours".into(), json!(s.catch_up_hours));
    out.insert("notify".into(), loads(Some(&s.notify), json!([])));
    out.insert("notify_people".into(), loads(Some(&s.notify_people), json!([])));
    out.insert("instruction".into(), json!(s.instruction));
    out.insert("state".into(), json!(s.state));
    out.insert("paused_reason".into(), json!(s.paused_reason));
    out.insert("failures_in_row".into(), json!(s.failures_in_row));
    out.insert("runs_count".into(), json!(s.runs_count));
    out.insert("next_run_at".into(), json!(s.next_run_at));
    out.insert("next_in".into(), json!(nxt.map(|at| in_words(at.to_utc(), None))));
    out.insert("when".into(), json!(when_label(s)?));
    out.insert("offline_risk".into(), json!(offline_risk(session, s, profile.as_ref()).await?));
    out.insert("ticket_changed".into(), json!(ticket_changed));
    out.insert("last_run".into(), json!(last.map(|last| run_to_dict(last, Some(&names)))));
    out.insert("created_at".into(), json!(s.created_at));
    out.insert("updated_at".into(), json!(s.updated_at));
    Ok(out)
}
