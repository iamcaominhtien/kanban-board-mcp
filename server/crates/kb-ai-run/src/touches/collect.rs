//! Reading the touches (`services/ai/touches.py` lines 228 to 629): `_cancelled_runs`, `_with_pause`, `_touch`,
//! `collect`, `stepped_in`.

use std::collections::{HashMap, HashSet};

use chrono::{DateTime, Duration, FixedOffset, Utc};
use kb_ai::store::{ai_names, parse_iso};
use kb_base::{pyjson, time};
use kb_db::Session;
use kb_db::entities::{ai_audit, ai_run, ai_run_message, ai_touch_mark, member};
use kb_db::sea_orm::{ColumnTrait, Condition, DbErr, EntityTrait, QueryFilter, QuerySelect, QueryTrait};
use serde_json::{Map, Value, json};

use super::{
    DEFAULT_RANGE, EDIT_ACTION, KINDS, LIMIT, PAUSE_ACTIONS, RANGES, RUN_ENDED, SIGNIN_ACTION, STOP_WITH_PAUSE_S,
    answers_of, clip, is_person, kind_label, object_of, seconds_between, since_of, text_of,
};
use crate::{clock, compact};

/// `_cancelled_runs`: whether this audit entry is a pause or removal that also stopped the team's runs (so those
/// stops belong to it).
fn cancelled_runs(e: &ai_audit::Model) -> bool {
    if e.action == "team_removed" {
        return true;
    }
    let d = object_of(Some(&e.detail));
    match e.action.as_str() {
        "team_paused" => d.get("cancel_current").is_some_and(pyjson::truthy),
        // an entry from before the flag was kept: assume it stopped them
        "project_paused" => d.get("cancel_running").is_none_or(pyjson::truthy),
        _ => false,
    }
}

/// `_with_pause`: whether this run was stopped as part of the same person's pause or removal of its team.
fn with_pause(r: &ai_run::Model, pauses: &[(Option<String>, Option<DateTime<FixedOffset>>)]) -> bool {
    let Some(ended) = parse_iso(r.ended_at.as_deref()) else { return false };
    pauses.iter().any(|(who, at)| {
        *who == r.ended_by && at.is_some_and(|at| seconds_between(&at, &ended).abs() <= STOP_WITH_PAUSE_S as f64)
    })
}

/// What `_touch` takes besides the key, the kind, the time and who.
#[derive(Default)]
struct TouchOf {
    team_ids: Vec<Value>,
    ticket_id: Option<String>,
    run_id: Option<String>,
    details: String,
    via: Value,
}

/// `_touch`: one touch as the tab shows it (no mark yet).
fn touch(key: String, kind: &str, at: Value, who: Value, of: TouchOf) -> Map<String, Value> {
    let mut out = Map::new();
    out.insert("id".into(), json!(key));
    out.insert("kind".into(), json!(kind));
    out.insert("label".into(), json!(kind_label(kind)));
    out.insert("at".into(), at);
    out.insert("who".into(), who);
    out.insert("via".into(), of.via);
    out.insert("team_ids".into(), Value::Array(of.team_ids));
    out.insert("ticket_id".into(), json!(of.ticket_id));
    out.insert("run_id".into(), json!(of.run_id));
    out.insert("details".into(), json!(of.details));
    out.insert("mark".into(), Value::Null);
    out.insert("marked_by".into(), Value::Null);
    out.insert("marked_at".into(), Value::Null);
    out.insert("lesson_id".into(), Value::Null);
    out
}

/// `a or b` of two texts.
fn or_text(a: String, b: impl FnOnce() -> String) -> String {
    if a.is_empty() { b() } else { a }
}

/// Every touch of the project since this time, newest first (team ids, not names: the caller adds them).
///
/// With `key` only the rows that touch can come from are read (its run, its message, its audit entry): marking a
/// touch or making a lesson from it does not read the whole range again.
pub async fn collect(
    session: &Session,
    project_id: &str,
    since: DateTime<Utc>,
    key: Option<&str>,
) -> Result<Vec<Map<String, Value>>, DbErr> {
    let key = key.filter(|k| !k.is_empty());
    let mut iso = time::iso(&since);
    let ai = ai_names(session, project_id).await?;
    let mut out: Vec<Map<String, Value>> = Vec::new();
    // where a keyed touch comes from: a run, a message (and its run) or an audit entry
    let (src, rest) = match key.unwrap_or("").split_once(':') {
        Some((src, rest)) => (src, rest),
        None => (key.unwrap_or(""), ""),
    };
    let mut run_id: Option<String> = match key {
        Some(_) if !matches!(src, "msg" | "audit") => Some(rest.split(':').next().unwrap_or("").to_string()),
        _ => None,
    };
    let msg_id = (src == "msg").then_some(rest);
    let audit_id = (src == "audit").then_some(rest);
    let mut audit_iso = iso.clone();
    if let Some(msg_id) = msg_id.filter(|id| !id.is_empty()) {
        let m = ai_run_message::Entity::find_by_id(msg_id).one(session).await?;
        run_id = Some(m.map_or_else(|| "-".to_string(), |m| m.run_id));
    }
    if key.is_some() {
        iso = String::new(); // the key says what to read: no window
        audit_iso = String::new();
        if let ("stop", Some(run_id)) = (src, run_id.as_deref().filter(|id| !id.is_empty())) {
            let r = ai_run::Entity::find_by_id(run_id).one(session).await?;
            let ended = r.and_then(|r| parse_iso(r.ended_at.as_deref()));
            // a stop is judged against the pauses made around the time it ended
            audit_iso = match ended {
                Some(ended) => time::iso(&(ended - Duration::seconds(STOP_WITH_PAUSE_S + 1))),
                None => "~".to_string(),
            };
        }
    }

    let mut run_stmt =
        ai_run::Entity::find().filter(ai_run::Column::ProjectId.eq(project_id)).filter(ai_run::Column::Kind.eq("team"));
    run_stmt = if key.is_some() {
        run_stmt.filter(ai_run::Column::Id.eq(run_id.as_deref().filter(|id| !id.is_empty()).unwrap_or("-")))
    } else {
        run_stmt.filter(
            Condition::any()
                .add(ai_run::Column::QueuedAt.gte(iso.as_str()))
                .add(ai_run::Column::EndedAt.gte(iso.as_str()))
                .add(ai_run::Column::EndedAt.is_null()),
        )
    };
    let runs = run_stmt.all(session).await?;
    let mut by_id: HashMap<String, ai_run::Model> = runs.iter().map(|r| (r.id.clone(), r.clone())).collect();
    let mut actions = vec![EDIT_ACTION, SIGNIN_ACTION, "team_removed"];
    actions.extend(PAUSE_ACTIONS);
    let mut audit_stmt = ai_audit::Entity::find()
        .filter(ai_audit::Column::ProjectId.eq(project_id))
        .filter(ai_audit::Column::CreatedAt.gte(audit_iso.as_str()))
        .filter(ai_audit::Column::Action.is_in(actions));
    if let Some(audit_id) = audit_id.filter(|id| !id.is_empty()) {
        audit_stmt = audit_stmt.filter(ai_audit::Column::Id.eq(audit_id));
    } else if key.is_some() && src != "stop" {
        audit_stmt = audit_stmt.filter(ai_audit::Column::Id.eq("-")); // a run's touch needs no audit entry
    }
    let rows = audit_stmt.all(session).await?;
    // when a person paused or removed a team: the runs they stopped with it are part of that
    let pauses: Vec<(Option<String>, Option<DateTime<FixedOffset>>)> = rows
        .iter()
        .filter(|e| cancelled_runs(e))
        .map(|e| (e.on_behalf_of.clone(), parse_iso(Some(&e.created_at))))
        .collect();
    let mut answered: HashMap<String, Vec<(String, String)>> = HashMap::new(); // run id -> [(who, when)]
    for r in &runs {
        let team = vec![json!(r.member_id)];
        let of = |details: String| TouchOf {
            team_ids: team.clone(),
            ticket_id: r.ticket_id.clone(),
            run_id: Some(r.id.clone()),
            details,
            via: Value::Null,
        };
        for a in answers_of(r) {
            // (an answer is kept with the time and the name as texts)
            let at = a.get("at").and_then(Value::as_str).unwrap_or("");
            let by = a.get("by").and_then(Value::as_str);
            if !at.is_empty() && at >= iso.as_str() && is_person(by, Some(&ai)) {
                answered.entry(r.id.clone()).or_default().push((by.unwrap_or("").to_string(), at.to_string()));
                let index = a.get("index").and_then(Value::as_u64).unwrap_or(0);
                let key = if index == 0 { format!("answer:{}", r.id) } else { format!("answer:{}:{index}", r.id) };
                let text = a.get("text").map(text_of).unwrap_or_default();
                let answer = a.get("answer").map(text_of).unwrap_or_default();
                let details = format!("“{}” → “{}”", clip(Some(&text), 110), clip(Some(&answer), 110));
                out.push(touch(key, "answer", json!(at), json!(by), of(details)));
            }
        }
        if r.queued_at.as_str() >= iso.as_str() && is_person(Some(&r.started_by), Some(&ai)) {
            if r.trigger == "run_button" {
                let details = or_text(clip(Some(&r.instruction), 160), || format!("Run #{}", r.number));
                out.push(touch(
                    format!("run:{}", r.id),
                    "run_by_hand",
                    json!(r.queued_at),
                    json!(r.started_by),
                    of(details),
                ));
            } else if r.trigger == "retry" {
                out.push(touch(
                    format!("retry:{}", r.id),
                    "retry",
                    json!(r.queued_at),
                    json!(r.started_by),
                    of(format!("Run #{} continues the one before it", r.number)),
                ));
            }
        }
        let ended_at = r.ended_at.as_deref().unwrap_or("");
        if r.state == "cancelled"
            && r.stop_code.as_deref().unwrap_or("").is_empty()
            && !ended_at.is_empty()
            && ended_at >= iso.as_str()
            && is_person(r.ended_by.as_deref(), Some(&ai))
            && !with_pause(r, &pauses)
        {
            let details = or_text(clip(r.ended_reason.as_deref(), 160), || format!("Run #{} stopped", r.number));
            out.push(touch(
                format!("stop:{}", r.id),
                "stop",
                json!(ended_at),
                json!(r.ended_by.as_deref().unwrap_or("")),
                of(details),
            ));
        }
    }

    // a message into a run, not from an AI session
    let mut msg_stmt = ai_run_message::Entity::find()
        .filter(ai_run_message::Column::Direction.eq("in"))
        .filter(ai_run_message::Column::At.gte(iso.as_str()))
        .filter(
            ai_run_message::Column::RunId.in_subquery(
                ai_run::Entity::find()
                    .select_only()
                    .column(ai_run::Column::Id)
                    .filter(ai_run::Column::ProjectId.eq(project_id))
                    .into_query(),
            ),
        );
    if let Some(msg_id) = msg_id.filter(|id| !id.is_empty()) {
        msg_stmt = msg_stmt.filter(ai_run_message::Column::Id.eq(msg_id));
    } else if key.is_some() {
        msg_stmt = msg_stmt.filter(ai_run_message::Column::Id.eq("-")); // only a message touch reads messages
    }
    let msgs = msg_stmt.all(session).await?;
    let missing: Vec<&str> =
        msgs.iter().filter(|m| !by_id.contains_key(&m.run_id)).map(|m| m.run_id.as_str()).collect();
    if !missing.is_empty() {
        for r in ai_run::Entity::find().filter(ai_run::Column::Id.is_in(missing)).all(session).await? {
            by_id.insert(r.id.clone(), r);
        }
    }
    for m in &msgs {
        let Some(run) = by_id.get(&m.run_id) else { continue };
        // /compact is a command, not a message to the lead
        if run.kind != "team" || !is_person(Some(&m.peer), Some(&ai)) || m.text == compact::WISH {
            continue;
        }
        if RUN_ENDED.contains(&run.state.as_str())
            && run.ended_at.as_deref().is_some_and(|ended| !ended.is_empty() && ended <= m.at.as_str())
        {
            continue; // sent to a run that had ended: it only started a new run, which is not a touch
        }
        let near_an_answer = answered.get(&m.run_id).is_some_and(|list| {
            list.iter().any(|(who, at)| {
                let sent = parse_iso(Some(&m.at)).unwrap_or_else(|| clock::now().fixed_offset());
                let said = parse_iso(Some(at)).unwrap_or_else(|| clock::now().fixed_offset());
                *who == m.peer && seconds_between(&said, &sent).abs() < 10.0
            })
        });
        if near_an_answer {
            continue; // an answer sent through the message box is one touch, not two
        }
        out.push(touch(
            format!("msg:{}", m.id),
            "message",
            json!(m.at),
            json!(m.peer),
            TouchOf {
                team_ids: vec![json!(run.member_id)],
                ticket_id: run.ticket_id.clone(),
                run_id: Some(run.id.clone()),
                details: format!("“{}”", clip(Some(&m.text), 140)),
                via: Value::Null,
            },
        ));
    }

    for e in &rows {
        if e.action == "team_removed" || !is_person(e.on_behalf_of.as_deref(), Some(&ai)) {
            continue;
        }
        let d = object_of(Some(&e.detail));
        let via = d.get("via").cloned().unwrap_or(Value::Null);
        let who = json!(e.on_behalf_of.as_deref().unwrap_or(""));
        let own_team: Vec<Value> = e.member_id.iter().filter(|id| !id.is_empty()).map(|id| json!(id)).collect();
        let key = format!("audit:{}", e.id);
        if e.action == EDIT_ACTION {
            let what = match d.get("what").filter(|v| pyjson::truthy(v)) {
                Some(what) => text_of(what),
                None => "the ticket".to_string(),
            };
            out.push(touch(
                key,
                "edit",
                json!(e.created_at),
                who,
                TouchOf {
                    team_ids: own_team,
                    ticket_id: e.target.clone(),
                    run_id: e.run_id.clone(),
                    details: format!("Changed {what} while the lead was working"),
                    via,
                },
            ));
        } else if e.action == SIGNIN_ACTION {
            let team_ids = match d.get("team_ids") {
                Some(Value::Array(ids)) => ids.clone(),
                _ => Vec::new(),
            };
            let account = d.get("account").map(text_of).unwrap_or_default();
            out.push(touch(
                key,
                "signin",
                json!(e.created_at),
                who,
                TouchOf {
                    team_ids, details: format!("Signed in the account “{account}”"), via, ..Default::default()
                },
            ));
        } else {
            let whole = e.action.starts_with("project_");
            let verb = if e.action.ends_with("paused") { "Paused" } else { "Resumed" };
            let what = if whole {
                "all the project's AI"
            } else if e.member_name.is_empty() {
                "a team"
            } else {
                e.member_name.as_str()
            };
            out.push(touch(
                key,
                "pause",
                json!(e.created_at),
                who,
                TouchOf { team_ids: own_team, details: format!("{verb} {what}"), via, ..Default::default() },
            ));
        }
    }

    // newest first; touches of the same moment stay in the order they were found
    let at_of = |t: &Map<String, Value>| t.get("at").and_then(Value::as_str).unwrap_or("").to_string();
    out.sort_by_key(|t| std::cmp::Reverse(at_of(t)));
    let mut mark_stmt = ai_touch_mark::Entity::find().filter(ai_touch_mark::Column::ProjectId.eq(project_id));
    if let Some(key) = key {
        mark_stmt = mark_stmt.filter(ai_touch_mark::Column::Key.eq(key));
    }
    let marks: HashMap<String, ai_touch_mark::Model> =
        mark_stmt.all(session).await?.into_iter().map(|m| (m.key.clone(), m)).collect();
    for t in &mut out {
        let Some(m) = t.get("id").and_then(Value::as_str).and_then(|id| marks.get(id)) else { continue };
        t.insert("mark".into(), json!(m.mark));
        t.insert("marked_by".into(), json!(m.marked_by));
        t.insert("marked_at".into(), json!(m.marked_at));
        t.insert("lesson_id".into(), json!(m.lesson_id));
    }
    Ok(out)
}

/// `round(x, 1)`: the nearest one-decimal value, a tie going to the even digit as Python's does.
fn round1(x: f64) -> f64 {
    format!("{x:.1}").parse().unwrap_or(x)
}

/// The tab: totals of the range, a row per kind and per team, and the touches (filtered by team, kind and mark).
/// Python's default `range_key`: `DEFAULT_RANGE`.
pub async fn stepped_in(
    session: &Session,
    project_id: &str,
    range_key: &str,
    team_id: Option<&str>,
    kind: Option<&str>,
    mark: Option<&str>,
) -> Result<Map<String, Value>, DbErr> {
    let (team_id, kind, mark) =
        (team_id.filter(|v| !v.is_empty()), kind.filter(|v| !v.is_empty()), mark.filter(|v| !v.is_empty()));
    let since = since_of(range_key, None);
    let mut touches = collect(session, project_id, since, None).await?;
    let teams = member::Entity::find()
        .filter(member::Column::ProjectId.eq(project_id))
        .filter(member::Column::Kind.is_in(["ai", "ai_removed"]))
        .all(session)
        .await?;
    let names: HashMap<&str, &str> = teams.iter().map(|m| (m.id.as_str(), m.name.as_str())).collect();
    let iso = time::iso(&since);
    let runs = ai_run::Entity::find()
        .filter(ai_run::Column::ProjectId.eq(project_id))
        .filter(ai_run::Column::Kind.eq("team"))
        .filter(ai_run::Column::QueuedAt.gte(iso.as_str()))
        .all(session)
        .await?;
    let mut runs_by_team: HashMap<&str, i64> = HashMap::new();
    for r in &runs {
        *runs_by_team.entry(r.member_id.as_str()).or_default() += 1;
    }
    let tickets: HashSet<&str> = runs.iter().filter_map(|r| r.ticket_id.as_deref()).filter(|t| !t.is_empty()).collect();
    let ids_of = |t: &Map<String, Value>| -> Vec<Value> {
        match t.get("team_ids") {
            Some(Value::Array(ids)) => ids.clone(),
            _ => Vec::new(),
        }
    };
    for t in &mut touches {
        let ids = ids_of(t);
        let team_names: Vec<&str> = ids
            .iter()
            .filter_map(|i| i.as_str().and_then(|i| names.get(i).copied()))
            .filter(|n| !n.is_empty())
            .collect();
        let team_name = if team_names.is_empty() { "All teams".to_string() } else { team_names.join(", ") };
        t.insert("team_names".into(), json!(team_names));
        t.insert("team_id".into(), ids.first().cloned().unwrap_or(Value::Null));
        t.insert("team_name".into(), json!(team_name));
    }
    let mut kinds: HashMap<String, i64> = HashMap::new();
    let mut per_team: HashMap<String, i64> = HashMap::new();
    let (mut on_tickets, mut needed, mut avoidable, mut unmarked) = (0i64, 0i64, 0i64, 0i64);
    for t in &touches {
        *kinds.entry(t.get("kind").and_then(Value::as_str).unwrap_or("").to_string()).or_default() += 1;
        for i in ids_of(t) {
            if let Some(i) = i.as_str() {
                *per_team.entry(i.to_string()).or_default() += 1;
            }
        }
        if t.get("ticket_id").and_then(Value::as_str).is_some_and(|id| tickets.contains(id)) {
            on_tickets += 1;
        }
        match t.get("mark").and_then(Value::as_str) {
            Some("needed") => needed += 1,
            Some("avoidable") => avoidable += 1,
            Some(_) => {}
            None => unmarked += 1,
        }
    }
    let total = touches.len();
    let items: Vec<&Map<String, Value>> = touches
        .iter()
        .filter(|t| {
            let t_mark = t.get("mark").and_then(Value::as_str).filter(|m| !m.is_empty());
            team_id.is_none_or(|id| ids_of(t).iter().any(|i| i.as_str() == Some(id)))
                && kind.is_none_or(|k| t.get("kind").and_then(Value::as_str) == Some(k))
                && mark.is_none_or(|m| (m == "unmarked" && t_mark.is_none()) || t_mark == Some(m))
        })
        .collect();

    let mut totals = Map::new();
    totals.insert("touches".into(), json!(total));
    totals.insert("needed".into(), json!(needed));
    totals.insert("avoidable".into(), json!(avoidable));
    totals.insert("unmarked".into(), json!(unmarked));
    totals.insert("tickets".into(), json!(tickets.len()));
    totals.insert("runs".into(), json!(runs.len()));
    totals.insert(
        "per_ticket".into(),
        if tickets.is_empty() { Value::Null } else { json!(round1(on_tickets as f64 / tickets.len() as f64)) },
    );
    let mut out = Map::new();
    out.insert(
        "range".into(),
        json!(if RANGES.iter().any(|(k, _)| *k == range_key) { range_key } else { DEFAULT_RANGE }),
    );
    out.insert("since".into(), json!(iso));
    out.insert("totals".into(), Value::Object(totals));
    out.insert(
        "kinds".into(),
        KINDS
            .iter()
            .filter_map(|(k, label)| {
                kinds.get(*k).filter(|n| **n != 0).map(|n| json!({"key": k, "label": label, "total": n}))
            })
            .collect(),
    );
    out.insert("all_kinds".into(), KINDS.iter().map(|(k, label)| json!({"key": k, "label": label})).collect());
    out.insert(
        "teams".into(),
        teams
            .iter()
            .filter_map(|m| {
                let touched = per_team.get(&m.id).copied().unwrap_or(0);
                let ran = runs_by_team.get(m.id.as_str()).copied().unwrap_or(0);
                if !(m.kind == "ai" || touched != 0 || ran != 0) {
                    return None;
                }
                let per_10_runs =
                    if ran != 0 { json!(round1(touched as f64 * 10.0 / ran as f64)) } else { Value::Null };
                Some(json!({
                    "id": m.id,
                    "name": m.name,
                    "removed": m.kind == "ai_removed",
                    "touches": touched,
                    "runs": ran,
                    "per_10_runs": per_10_runs,
                }))
            })
            .collect(),
    );
    out.insert("items".into(), items.iter().take(LIMIT).map(|t| Value::Object((*t).clone())).collect());
    out.insert("truncated".into(), json!(items.len() > LIMIT));
    Ok(out)
}
