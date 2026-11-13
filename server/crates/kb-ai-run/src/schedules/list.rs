//! Listing (`services/ai/schedules.py` lines 901 to 1110): `list_for`, `history`, `_report_of`, `detail`, `week`.

use std::collections::HashMap;

use chrono::{DateTime, Duration, Utc};
use kb_ai::store::{get_profile, loads, parse_iso};
use kb_base::{pyjson, pytext, time};
use kb_db::Session;
use kb_db::entities::{ai_run, ai_schedule, ai_schedule_run};
use kb_db::sea_orm::{ColumnTrait, EntityTrait, QueryFilter, QueryOrder, QuerySelect};
use serde_json::{Map, Value, json};

use super::check::{assess, availability};
use super::edit::get_or_404;
use super::read::{names, run_to_dict, summary_text, to_dict};
use super::when::slots;
use super::{ENDED, Error};
use crate::clock;
use crate::pynum::{round_to, sum};

/// `str(value)` of a JSON value.
fn text_of(value: &Value) -> String {
    match value {
        Value::String(s) => s.clone(),
        other => pyjson::py_str(other),
    }
}

/// Schedules with their last slot, counts for the tab filters and the next-24 h badge.
pub async fn list_for(
    session: &Session,
    project_id: &str,
    ticket_id: Option<&str>,
) -> Result<Map<String, Value>, Error> {
    let mut stmt = ai_schedule::Entity::find().filter(ai_schedule::Column::ProjectId.eq(project_id));
    if let Some(ticket_id) = ticket_id.filter(|t| !t.is_empty()) {
        stmt = stmt.filter(ai_schedule::Column::TicketId.eq(ticket_id));
    }
    let rows = stmt.all(session).await?;
    let mut items: Vec<Map<String, Value>> = Vec::new();
    for s in &rows {
        items.push(to_dict(session, s, None).await?);
    }
    items.sort_by_key(|d| {
        let next = d.get("next_run_at").and_then(Value::as_str).filter(|n| !n.is_empty()).unwrap_or("9999");
        (d.get("state").and_then(Value::as_str) != Some("active"), next.to_string())
    });
    let now = clock::now();
    let soon = rows
        .iter()
        .filter(|s| {
            s.state == "active"
                && parse_iso(s.next_run_at.as_deref()).is_some_and(|at| at.to_utc() - now <= Duration::hours(24))
        })
        .count();
    let hist = ai_schedule_run::Entity::find()
        .filter(ai_schedule_run::Column::ProjectId.eq(project_id))
        .filter(ai_schedule_run::Column::State.is_in(ENDED))
        .all(session)
        .await?;
    let count = |state: &str| rows.iter().filter(|s| s.state == state).count();
    let mut out = Map::new();
    out.insert("items".into(), items.into_iter().map(Value::Object).collect());
    out.insert("next24h".into(), json!(soon));
    out.insert(
        "counts".into(),
        json!({
            "upcoming": count("active"),
            "paused": count("paused"),
            "ended": count("ended"),
            "history": hist.len(),
        }),
    );
    Ok(out)
}

/// Ended and open slots, newest first. (Python's default `limit`: 50.)
pub async fn history(
    session: &Session,
    project_id: &str,
    schedule_id: Option<&str>,
    limit: u64,
) -> Result<Vec<Map<String, Value>>, Error> {
    let mut stmt = ai_schedule_run::Entity::find().filter(ai_schedule_run::Column::ProjectId.eq(project_id));
    if let Some(schedule_id) = schedule_id.filter(|s| !s.is_empty()) {
        stmt = stmt.filter(ai_schedule_run::Column::ScheduleId.eq(schedule_id));
    }
    let rows = stmt.order_by_desc(ai_schedule_run::Column::SlotAt).limit(limit).all(session).await?;
    let names = names(session, rows.iter().map(|r| r.member_id.as_deref())).await?;
    // the lead's report of the slot's last run: what the history row and its open view show
    let last_of = |r: &ai_schedule_run::Model| -> Option<String> {
        match loads(Some(&r.run_ids), json!([])) {
            Value::Array(ids) => ids.last().filter(|id| pyjson::truthy(id)).map(text_of),
            _ => None,
        }
    };
    let wanted: Vec<String> = rows.iter().filter_map(last_of).collect();
    let runs: HashMap<String, ai_run::Model> = if wanted.is_empty() {
        HashMap::new()
    } else {
        ai_run::Entity::find()
            .filter(ai_run::Column::Id.is_in(wanted))
            .all(session)
            .await?
            .into_iter()
            .map(|x| (x.id.clone(), x))
            .collect()
    };
    let mut out = Vec::new();
    for r in &rows {
        let mut d = run_to_dict(r, Some(&names));
        d.insert("report".into(), json!(report_of(last_of(r).and_then(|id| runs.get(&id)))));
        out.push(d);
    }
    Ok(out)
}

/// `_report_of`: the lead's report on a run, trimmed for the schedule history: summary, open items, branch and PR.
pub fn report_of(run: Option<&ai_run::Model>) -> Option<Map<String, Value>> {
    let run = run.filter(|r| r.state == "finished")?;
    let rep = match loads(Some(&run.report), json!({})) {
        Value::Object(rep) => rep,
        _ => Map::new(),
    };
    let truthy = |key: &str| rep.get(key).filter(|v| pyjson::truthy(v));
    let said = match truthy("summary") {
        Some(value) => text_of(value),
        None => run.summary.clone().unwrap_or_default(),
    };
    let summary = pytext::strip(&said);
    if summary.is_empty() && truthy("open_items").is_none() {
        return None;
    }
    let open_items: Vec<Value> = match truthy("open_items") {
        Some(Value::Array(items)) => {
            items.iter().take(8).map(|x| json!(text_of(x).chars().take(300).collect::<String>())).collect()
        }
        _ => Vec::new(),
    };
    let mut out = Map::new();
    out.insert("status".into(), json!(truthy("status").map_or_else(|| "done".to_string(), text_of)));
    out.insert("summary".into(), json!(summary.chars().take(2000).collect::<String>()));
    out.insert("open_items".into(), Value::Array(open_items));
    out.insert("branch".into(), rep.get("branch").cloned().unwrap_or(Value::Null));
    out.insert("pr_url".into(), rep.get("pr_url").cloned().unwrap_or(Value::Null));
    out.insert("run_id".into(), json!(run.id));
    Some(out)
}

/// One schedule: settings, stats over the last runs and the run history (D).
pub async fn detail(session: &Session, schedule_id: &str) -> Result<Map<String, Value>, Error> {
    let s = get_or_404(session, schedule_id).await?;
    let mut out = to_dict(session, &s, None).await?;
    let runs = history(session, &s.project_id, Some(&s.id), 100).await?;
    let state_of = |r: &Map<String, Value>| r.get("state").and_then(Value::as_str).unwrap_or("").to_string();
    let cost_of = |r: &Map<String, Value>| r.get("cost_usd").and_then(Value::as_f64).unwrap_or(0.0);
    let ended: Vec<&Map<String, Value>> =
        runs.iter().filter(|r| ENDED.contains(&state_of(r).as_str()) && state_of(r) != "skipped").collect();
    let timed: Vec<i64> =
        ended.iter().filter_map(|r| r.get("duration_s").and_then(Value::as_i64)).filter(|d| *d != 0).collect();
    // `int(sum(timed) / len(timed))`
    let avg_s = (!timed.is_empty()).then(|| (timed.iter().sum::<i64>() as f64 / timed.len() as f64).trunc() as i64);
    // (Python's `sum` of no numbers is the int 0, and `round` keeps it one)
    let cost = if runs.is_empty() { json!(0) } else { json!(round_to(sum(runs.iter().map(cost_of)), 4)) };
    out.insert(
        "stats".into(),
        json!({
            "passed": ended.iter().filter(|r| state_of(r) == "passed").count(),
            "of": ended.len(),
            "avg_s": avg_s,
            "cost": cost,
            "metered": runs.iter().any(|r| cost_of(r) > 0.0),
        }),
    );
    out.insert("runs".into(), runs.into_iter().map(Value::Object).collect());
    out.insert("summary".into(), json!(summary_text(session, &s).await?));
    // a one-off whose time has come is being run (or waits for its AI): "that time has passed" is for the editor
    let problems: Vec<Value> = if s.state != "ended" {
        assess(session, &s, &s.created_by, None)
            .await?
            .into_iter()
            .filter(|c| c["level"] != "ok" && !(s.kind == "once" && c["key"] == "when"))
            .collect()
    } else {
        Vec::new()
    };
    out.insert("problems".into(), Value::Array(problems));
    Ok(out)
}

/// Planned runs per AI in a range (B2): overlaps (will queue) and the desktop-app-closed risk. (Python's default
/// `days`: 7.) The members are listed in the order their first run or slot is met (Python lists them in the order of
/// a set, which is no order).
pub async fn week(
    session: &Session,
    project_id: &str,
    start: DateTime<Utc>,
    days: i64,
) -> Result<Map<String, Value>, Error> {
    let end = start + Duration::days(days);
    let rows = ai_schedule::Entity::find()
        .filter(ai_schedule::Column::ProjectId.eq(project_id))
        .filter(ai_schedule::Column::State.is_in(["active", "paused"]))
        .all(session)
        .await?;
    let mut items: Vec<Map<String, Value>> = Vec::new();
    for s in &rows {
        for at in slots(s, start - Duration::seconds(1), 50)? {
            if at >= end {
                break;
            }
            let mut item = Map::new();
            item.insert("schedule_id".into(), json!(s.id));
            item.insert("ticket_id".into(), json!(s.ticket_id));
            item.insert("member_id".into(), json!(s.member_id));
            item.insert("at".into(), json!(time::iso(&at)));
            item.insert("kind".into(), json!("run"));
            item.insert("paused".into(), json!(s.state == "paused"));
            items.push(item);
        }
    }
    let past = ai_schedule_run::Entity::find()
        .filter(ai_schedule_run::Column::ProjectId.eq(project_id))
        .filter(ai_schedule_run::Column::SlotAt.gte(time::iso(&start)))
        .filter(ai_schedule_run::Column::SlotAt.lt(time::iso(&end)))
        .all(session)
        .await?;
    for r in &past {
        let mut item = Map::new();
        item.insert("schedule_id".into(), json!(r.schedule_id));
        item.insert("ticket_id".into(), json!(r.ticket_id));
        item.insert("member_id".into(), json!(r.member_id));
        item.insert("at".into(), json!(r.slot_at));
        item.insert("kind".into(), json!("past"));
        item.insert("state".into(), json!(r.state));
        item.insert("paused".into(), json!(false));
        items.push(item);
    }
    let member_of = |i: &Map<String, Value>| i.get("member_id").and_then(Value::as_str).unwrap_or("").to_string();
    let at_of = |i: &Map<String, Value>| i.get("at").and_then(Value::as_str).unwrap_or("").to_string();
    let mut members: Vec<(String, Value)> = Vec::new();
    for item in &items {
        let mid = member_of(item);
        if mid.is_empty() || members.iter().any(|(id, _)| *id == mid) {
            continue;
        }
        let (m, p) = get_profile(session, &mid).await?;
        let (ok, why) = availability(session, Some(&mid), project_id).await?;
        let described = json!({
            "id": mid,
            "name": m.map_or_else(|| "Removed team".to_string(), |m| m.name),
            "connection": p.as_ref().map(|p| p.connection.clone()),
            "max_parallel": p.as_ref().map_or(1, |p| p.max_parallel),
            "available": ok,
            "reason": why,
        });
        members.push((mid, described));
    }
    // per member, the planned runs that are not paused, soonest first
    let mut by_member: Vec<(String, Vec<usize>)> = Vec::new();
    for (index, item) in items.iter().enumerate() {
        if item["kind"] == "run" && item["paused"] == false {
            let mid = member_of(item);
            match by_member.iter_mut().find(|(id, _)| *id == mid) {
                Some((_, list)) => list.push(index),
                None => by_member.push((mid, vec![index])),
            }
        }
    }
    for (mid, mut list) in by_member {
        list.sort_by_key(|index| at_of(&items[*index]));
        let member = members.iter().find(|(id, _)| *id == mid).map(|(_, m)| m);
        let cap = member.and_then(|m| m["max_parallel"].as_i64()).unwrap_or(1);
        let risky = member.is_some_and(|m| m["connection"] == "local" && m["available"] == false);
        for index in &list {
            let (Some(at), mine) = (parse_iso(Some(&at_of(&items[*index]))), at_of(&items[*index])) else { continue };
            let near: Vec<String> = list
                .iter()
                .filter(|other| *other != index)
                .map(|other| at_of(&items[*other]))
                .filter(|other| {
                    parse_iso(Some(other))
                        .and_then(|o| (o - at).num_microseconds())
                        .is_some_and(|us| us.abs() < 3_600_000_000)
                })
                .collect();
            if near.len() as i64 >= cap && near.iter().any(|other| *other < mine) {
                items[*index].insert("overlap".into(), json!(true));
            }
            if risky {
                items[*index].insert("risk".into(), json!("App closed?"));
            }
        }
    }
    items.sort_by_key(at_of);
    let mut out = Map::new();
    out.insert("start".into(), json!(time::iso(&start)));
    out.insert("days".into(), json!(days));
    out.insert("items".into(), items.into_iter().map(Value::Object).collect());
    out.insert("members".into(), members.into_iter().map(|(_, m)| m).collect());
    Ok(out)
}
