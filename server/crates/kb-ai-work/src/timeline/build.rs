//! The sequence diagram's data: `timeline` and `timeline_at` (`timeline.py`'s `timeline`).

use std::collections::HashMap;

use chrono::{DateTime, Duration, FixedOffset, Utc};
use kb_base::{pyjson, pytext};
use kb_db::Session;
use kb_db::entities::{ai_run, ai_run_message, ticket};
use kb_db::sea_orm::{ColumnTrait, DbErr, EntityTrait, QueryFilter, QueryOrder, QuerySelect};
use serde_json::{Map, Value, json};

use super::*;

/// The sequence diagram's data for a window and a scope (the whole project, one team, or one ticket with its
/// sub-tickets).
pub async fn timeline(session: &Session, project_id: &str, opts: &TimelineOpts) -> Result<Value, DbErr> {
    timeline_at(session, project_id, opts, Utc::now().fixed_offset()).await
}

/// `ticket_id` and its sub-tickets, or None when no ticket is asked for.
pub(crate) async fn scope_of(session: &Session, ticket_id: Option<&str>) -> Result<Option<Vec<String>>, DbErr> {
    let Some(ticket_id) = ticket_id.filter(|t| !t.is_empty()) else {
        return Ok(None);
    };
    let kids: Vec<String> = ticket::Entity::find()
        .filter(ticket::Column::ParentId.eq(ticket_id))
        .select_only()
        .column(ticket::Column::Id)
        .into_tuple::<String>()
        .all(session)
        .await?;
    let mut ids = vec![ticket_id.to_string()];
    for k in kids {
        if !ids.contains(&k) {
            ids.push(k);
        }
    }
    Ok(Some(ids))
}

/// `timeline` at the moment `now` (what `datetime.now(UTC)` gave).
pub async fn timeline_at(
    session: &Session,
    project_id: &str,
    opts: &TimelineOpts,
    now: DateTime<FixedOffset>,
) -> Result<Value, DbErr> {
    let range_key = if RANGES.contains(&opts.range_key.as_str()) { opts.range_key.as_str() } else { "today" };
    let (a, b) = window(range_key, now, opts.since, opts.until);
    let settings = kb_ai::store::get_settings(session, project_id).await?;
    let ticket_id = opts.ticket_id.as_deref().filter(|t| !t.is_empty());
    let team_id = opts.team_id.as_deref().filter(|t| !t.is_empty());

    let scope_ids = scope_of(session, ticket_id).await?;

    let mut stmt = ai_run::Entity::find()
        .filter(ai_run::Column::ProjectId.eq(project_id))
        .filter(ai_run::Column::Kind.eq("team"))
        .filter(ai_run::Column::QueuedAt.lte(iso(&b)));
    if let Some(ids) = &scope_ids {
        stmt = stmt.filter(ai_run::Column::TicketId.is_in(ids.clone()));
    }
    if let Some(team) = team_id {
        stmt = stmt.filter(ai_run::Column::MemberId.eq(team));
    }
    let candidates = stmt.order_by_desc(ai_run::Column::QueuedAt).limit(MAX_RUNS).all(session).await?;
    let runs: Vec<ai_run::Model> = candidates
        .into_iter()
        .rev()
        .filter(|r| {
            parse(r.ended_at.as_deref()).unwrap_or(now) >= a
                && (r.state != "queued" || parse(Some(&r.queued_at)).unwrap_or(a) <= b)
        })
        .collect();
    let run_ids: Vec<String> = runs.iter().map(|r| r.id.clone()).collect();
    let agents_of = load_agents(session, &run_ids).await?;

    let teams = load_teams(session, project_id).await?;
    let mut used: Vec<String> = Vec::new();
    for r in &runs {
        if teams.has(&r.member_id) && !used.contains(&r.member_id) {
            used.push(r.member_id.clone());
        }
    }
    let held = settings.paused_all;
    let by_name = name_map(session, project_id, &teams).await?;

    let sender_team = |name: Option<&str>, receiver: &str| -> Option<String> {
        let key = pytext::strip(name.unwrap_or("")).to_lowercase();
        by_name.get(&key).filter(|tid| tid.as_str() != receiver).cloned()
    };
    fn add_sender(used: &mut Vec<String>, sender: &str, receiver: &str) {
        // a team that wrote a note is drawn to the left of the team that got it (the note runs left to right)
        match used.iter().position(|u| u == receiver) {
            Some(i) => used.insert(i, sender.to_string()),
            None => used.push(sender.to_string()),
        }
    }

    let mut bars: Vec<Map<String, Value>> = Vec::new();
    let mut arrows: Vec<Map<String, Value>> = Vec::new();
    let mut waits: Vec<Value> = Vec::new();
    // team -> role lane ids, in order of first call
    let mut role_lanes: HashMap<String, Vec<String>> = HashMap::new();
    // lane -> (team id, agent type)
    let mut role_info: HashMap<String, (String, String)> = HashMap::new();
    let mut calls: HashMap<String, usize> = HashMap::new();

    let runs_by_id: HashMap<&str, &ai_run::Model> = runs.iter().map(|r| (r.id.as_str(), r)).collect();
    for r in &runs {
        if !teams.has(&r.member_id) {
            continue;
        }
        let lead = r.member_id.as_str();
        bars.push(bar(r, lead, held));
        let queued_at = r.queued_at.as_str();
        let active = ACTIVE.contains(&r.state.as_str());
        let landed: Option<&str> = match r.started_at.as_deref().filter(|s| !s.is_empty()) {
            Some(s) => Some(s),
            None if active => None,
            None => r.ended_at.as_deref().filter(|e| !e.is_empty()),
        };
        let wait_s = match (parse(Some(queued_at)), parse(landed)) {
            (Some(q0), Some(q1)) => Some(Ord::max(total_seconds(q1, q0).trunc() as i64, 0)),
            _ => None,
        };
        // the person's instruction: not for a schedule, a GitHub event or the API (nobody sat there)
        // a note from another team starts a run too (`message` from the ticket chat, `ai_message` from `ai_run message`):
        // it is an arrow from that team's lead; a note whose sender is no team (the board's agent) draws none
        let from_team =
            if NOTE_TRIGGERS.contains(&r.trigger.as_str()) { sender_team(Some(&r.started_by), lead) } else { None };
        if matches!(r.trigger.as_str(), "assign" | "run_button" | "message" | "docs_threads" | "retry")
            || (r.trigger == "ai_message" && from_team.is_some())
        {
            if let Some(from) = &from_team {
                if !used.contains(from) {
                    add_sender(&mut used, from, &r.member_id);
                }
            }
            arrows.push(arrow(
                &format!("{}:assign", r.id),
                Some(queued_at),
                if from_team.is_some() { "note" } else { "assign" },
                from_team.as_deref().unwrap_or("you"),
                lead,
                r.ticket_id.as_deref(),
                Some(&r.id),
                ArrowExtras {
                    to_at: Some(landed.unwrap_or(queued_at).to_string()),
                    wait_s,
                    by: Some(r.started_by.clone()),
                    ..ArrowExtras::default()
                },
            ));
        }
        for ag in agents_of.get(&r.id).map(Vec::as_slice).unwrap_or(&[]) {
            let agent_type =
                ag.get("agent_type").filter(|v| pyjson::truthy(v)).and_then(Value::as_str).unwrap_or("agent");
            let lane = format!("{lead}:{agent_type}");
            if !role_info.contains_key(&lane) {
                role_info.insert(lane.clone(), (lead.to_string(), agent_type.to_string()));
                role_lanes.entry(lead.to_string()).or_default().push(lane.clone());
            }
            for span in ag.get("spans").and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&[]) {
                let n = calls.entry(lane.clone()).or_insert(0);
                *n += 1;
                let n = *n;
                let cb = call_bar(r, ag, &lane, n, n, span);
                let cb_id = str_of(&cb, "id").to_string();
                let span_start = span.get("start").and_then(Value::as_str);
                arrows.push(arrow(
                    &format!("{cb_id}:handoff"),
                    span_start,
                    "handoff",
                    lead,
                    &lane,
                    r.ticket_id.as_deref(),
                    Some(&cb_id),
                    ArrowExtras::default(),
                ));
                let cb_end =
                    cb.get("ended_at").filter(|v| pyjson::truthy(v)).and_then(Value::as_str).map(str::to_string);
                if let (Some(end), Some(_)) = (&cb_end, span_end(span)) {
                    arrows.push(arrow(
                        &format!("{cb_id}:report"),
                        Some(end),
                        "report",
                        &lane,
                        lead,
                        r.ticket_id.as_deref(),
                        Some(&cb_id),
                        ArrowExtras::default(),
                    ));
                }
                bars.push(cb);
            }
        }
        let q = object_of(r.question.as_deref());
        let asked = parse(q.get("asked_at").and_then(Value::as_str));
        if let Some(asked_at) = asked.filter(|asked| *asked <= b) {
            let answered = parse(q.get("answered_at").and_then(Value::as_str));
            let text = text_field(&q, "text");
            let options: Vec<String> = match q.get("options") {
                Some(Value::Array(items)) if !items.is_empty() => {
                    items.iter().map(|o| first_chars(&pyjson::py_str(o), 80)).take(6).collect()
                }
                _ => Vec::new(),
            };
            let asked_text = q.get("asked_at").cloned().unwrap_or(Value::Null);
            waits.push(json!({
                "id": format!("{}:q", r.id),
                "member_id": lead,
                "ticket_id": r.ticket_id,
                "run_id": r.id,
                "kind": "question",
                "from": asked_text,
                "to": q.get("answered_at").cloned().unwrap_or(Value::Null),
                "text": first_chars(&text, 240),
                "options": options,
            }));
            arrows.push(arrow(
                &format!("{}:ask", r.id),
                q.get("asked_at").and_then(Value::as_str),
                "ask",
                lead,
                "you",
                r.ticket_id.as_deref(),
                Some(&r.id),
                ArrowExtras { label: Some(first_chars(&text, 120)), ..ArrowExtras::default() },
            ));
            if let Some(answered_at) = answered.filter(|a| *a <= b) {
                arrows.push(arrow(
                    &format!("{}:answer", r.id),
                    q.get("answered_at").and_then(Value::as_str),
                    "answer",
                    "you",
                    lead,
                    r.ticket_id.as_deref(),
                    Some(&r.id),
                    ArrowExtras {
                        wait_s: Some(total_seconds(answered_at, asked_at).trunc() as i64),
                        by: q.get("answered_by").filter(|v| !v.is_null()).map(pyjson::py_str),
                        ..ArrowExtras::default()
                    },
                ));
            }
        }
        if r.state == "finished" {
            if let Some(ended) = r.ended_at.as_deref().filter(|e| !e.is_empty()) {
                arrows.push(arrow(
                    &format!("{}:done", r.id),
                    Some(ended),
                    "report",
                    lead,
                    "you",
                    r.ticket_id.as_deref(),
                    Some(&r.id),
                    ArrowExtras::default(),
                ));
            }
        }
    }

    // a person's note to a lead that is already working
    if !runs_by_id.is_empty() {
        let messages = ai_run_message::Entity::find()
            .filter(ai_run_message::Column::RunId.is_in(run_ids.clone()))
            .filter(ai_run_message::Column::Direction.eq("in"))
            .all(session)
            .await?;
        for m in messages {
            let Some(r) = runs_by_id.get(m.run_id.as_str()) else {
                continue;
            };
            let at = parse(Some(&m.at));
            let Some(at) = at.filter(|at| teams.has(&r.member_id) && *at >= a && *at <= b) else {
                continue;
            };
            if parse(Some(&r.queued_at)).unwrap_or(at) >= at - Duration::seconds(2) {
                // the instruction that started the run is the assign arrow
                continue;
            }
            let from_team = sender_team(Some(&m.peer), &r.member_id);
            if let Some(from) = &from_team {
                if !used.contains(from) {
                    add_sender(&mut used, from, &r.member_id);
                }
            }
            arrows.push(arrow(
                &m.id,
                Some(&m.at),
                if from_team.is_some() { "note" } else { "assign" },
                from_team.as_deref().unwrap_or("you"),
                &r.member_id,
                r.ticket_id.as_deref(),
                None,
                ArrowExtras {
                    to_at: Some(m.delivered_at.clone().filter(|d| !d.is_empty()).unwrap_or_else(|| m.at.clone())),
                    label: Some(first_chars(&m.text, 120)),
                    by: Some(m.peer.clone()).filter(|p| !p.is_empty()),
                    ..ArrowExtras::default()
                },
            ));
        }
    }

    arrows.retain(|x| parse(x.get("at").and_then(Value::as_str)).unwrap_or(a) <= b);

    // lifelines: you, then each team's lead followed by the roles it called (the team map's order)
    let live_runs: Vec<&ai_run::Model> = runs.iter().filter(|r| ACTIVE.contains(&r.state.as_str())).collect();
    let open_roles: Vec<String> = bars
        .iter()
        .filter(|x| x.get("role").is_some_and(pyjson::truthy) && x.get("ended_at").is_none_or(Value::is_null))
        .map(|x| str_of(x, "member_id").to_string())
        .collect();

    let state_of = |team_id: &str, lane: Option<&str>| -> &'static str {
        let Some(team) = teams.team(team_id) else {
            return "idle";
        };
        if OFFLINE.contains(&team.health.as_str()) {
            return "offline";
        }
        let mine: Vec<&&ai_run::Model> = live_runs.iter().filter(|r| r.member_id == team_id).collect();
        if let Some(lane) = lane {
            return if held || team.paused {
                "paused"
            } else if open_roles.iter().any(|o| o == lane) {
                "working"
            } else {
                "idle"
            };
        }
        if mine.iter().any(|r| r.state == "needs_input") {
            return "waiting";
        }
        if held || team.paused {
            return "paused";
        }
        if mine.iter().any(|r| matches!(r.state.as_str(), "starting" | "running")) {
            return "working";
        }
        if mine.is_empty() { "idle" } else { "queued" }
    };

    let mut shown: Vec<String> = used.clone();
    if let Some(t) = team_id.filter(|t| teams.has(t)) {
        if !shown.iter().any(|s| s == t) {
            // one team on show: it is drawn even when nothing ran in the window
            shown.push(t.to_string());
        }
    }
    if scope_ids.is_none() && team_id.is_none() {
        for t in &teams.order {
            if !used.contains(t) && teams.member(t).is_some_and(|m| m.kind == "ai") {
                shown.push(t.clone());
            }
        }
    }
    let many = shown.len() > 1;
    let lane_name = |tid: &str, role: Option<&str>| -> String {
        let team = teams.member(tid).map(|m| m.name.clone()).unwrap_or_default();
        match role {
            None => {
                if many {
                    team
                } else {
                    "Lead".to_string()
                }
            }
            Some(role) => {
                if many {
                    format!("{} ({team})", role_label(role))
                } else {
                    role_label(role)
                }
            }
        }
    };

    let mut lifelines: Vec<Value> = vec![json!({
        "id": "you",
        "kind": "you",
        "name": "You",
        "color": "#1E2A22",
        // a dot like the AIs': amber while a run waits for your answer, grey otherwise
        "state": if live_runs.iter().any(|r| r.state == "needs_input") { "waiting" } else { "idle" },
    })];
    for tid in &shown {
        let Some(m) = teams.member(tid) else {
            continue;
        };
        lifelines.push(json!({
            "id": tid,
            "kind": "ai",
            "lead": true,
            "team_id": tid,
            "team_name": m.name,
            "name": lane_name(tid, None),
            "color": m.color,
            "state": state_of(tid, None),
            "quiet": !used.contains(tid),
        }));
        for lane in role_lanes.get(tid).map(Vec::as_slice).unwrap_or(&[]) {
            let role = role_info.get(lane).map(|(_, t)| t.as_str()).unwrap_or("agent");
            lifelines.push(json!({
                "id": lane,
                "kind": "ai",
                "team_id": tid,
                "name": lane_name(tid, Some(role)),
                "color": role_color(role),
                "state": state_of(tid, Some(lane)),
            }));
        }
    }

    let mut grouped = group(&arrows, GROUP_WITHIN_S);
    let crowded = grouped.len() > MAX_ARROWS;
    if crowded {
        grouped = group(&arrows, CROWDED_WITHIN_S);
    }
    let truncated = grouped.len() > MAX_ARROWS;
    if truncated {
        grouped = grouped.split_off(grouped.len() - MAX_ARROWS);
    }

    let mut density = vec![0i64; DENSITY_BUCKETS];
    let span_s = total_seconds(b, a).max(1.0);
    let buckets = DENSITY_BUCKETS as f64;
    for x in &bars {
        if x.get("role").is_some_and(pyjson::truthy) {
            continue;
        }
        let s = parse(x.get("started_at").and_then(Value::as_str))
            .or_else(|| parse(x.get("queued_at").and_then(Value::as_str)));
        let e = parse(x.get("ended_at").and_then(Value::as_str)).unwrap_or(now);
        let Some(s) = s else {
            continue;
        };
        let i0 = Ord::max((total_seconds(s, a) / span_s * buckets) as i64, 0);
        let i1 = Ord::min((total_seconds(e, a) / span_s * buckets) as i64, DENSITY_BUCKETS as i64 - 1);
        for i in i0..=i1 {
            density[i as usize] += 1;
        }
    }

    let mut last_end: Option<DateTime<FixedOffset>> = None;
    for x in &bars {
        if let Some(at) =
            x.get("ended_at").filter(|v| pyjson::truthy(v)).and_then(Value::as_str).and_then(|e| parse(Some(e)))
        {
            if last_end.is_none_or(|cur| at > cur) {
                last_end = Some(at);
            }
        }
    }

    let live_ids: Vec<String> = live_runs.iter().map(|r| r.id.clone()).take(12).collect();
    let steps_now = last_steps(session, &live_ids).await?;
    let mut ticket_ids: Vec<String> = Vec::new();
    for r in &runs {
        if let Some(t) = r.ticket_id.as_deref().filter(|t| !t.is_empty()) {
            if !ticket_ids.iter().any(|x| x == t) {
                ticket_ids.push(t.to_string());
            }
        }
    }
    let titles: Vec<ticket::Model> = if ticket_ids.is_empty() {
        Vec::new()
    } else {
        ticket::Entity::find().filter(ticket::Column::Id.is_in(ticket_ids)).all(session).await?
    };
    let title_of = |id: Option<&str>| titles.iter().find(|t| Some(t.id.as_str()) == id);
    let mut live: Vec<Value> = Vec::new();
    for r in live_runs.iter().take(12) {
        let Some(m) = teams.member(&r.member_id) else {
            continue;
        };
        let since_at = parse(r.started_at.as_deref()).or_else(|| parse(Some(&r.queued_at)));
        live.push(json!({
            "run_id": r.id,
            "member_id": r.member_id,
            "member_name": m.name,
            "ticket_id": r.ticket_id.clone().unwrap_or_default(),
            "ticket_title": title_of(r.ticket_id.as_deref()).map(|t| t.title.clone()).unwrap_or_default(),
            "state": match r.state.as_str() { "needs_input" => "waiting_you", "queued" => "queued", _ => "working" },
            "mode": r.mode,
            "trigger": r.trigger,
            "sender": r.started_by,
            "elapsed_s": since_at.map(|s| total_seconds(now, s).trunc() as i64),
            "step": steps_now.get(&r.id).cloned().unwrap_or_default(),
        }));
    }

    let mut pauses: Vec<Value> = Vec::new();
    if settings.paused_all && settings.paused_at.as_deref().is_some_and(|p| !p.is_empty()) {
        pauses.push(json!({
            "from": settings.paused_at,
            "to": null,
            "by": null,
            "reason": settings.paused_reason,
            "resumed_by": null,
        }));
    }
    let mut tickets = Map::new();
    for t in &titles {
        if bars.iter().any(|x| str_of(x, "ticket_id") == t.id) {
            tickets.insert(t.id.clone(), json!({"title": t.title, "status": t.status}));
        }
    }
    Ok(json!({
        "range": range_key,
        "since": iso(&a),
        "until": iso(&b),
        "now": iso(&now),
        "following": b >= now - Duration::seconds(5),
        "scope": {
            "kind": if ticket_id.is_some() { "ticket" } else { "team" },
            "ticket_id": opts.ticket_id,
            "team_id": opts.team_id,
        },
        "lifelines": lifelines,
        "bars": bars,
        "arrows": grouped,
        "waits": waits,
        "touches": [],
        "docs": [],
        "pauses": pauses,
        "paused_all": settings.paused_all,
        "paused_at": if settings.paused_all { json!(settings.paused_at) } else { Value::Null },
        "paused_by": null,
        "live": live,
        "density": density,
        "truncated": truncated,
        "grouped_harder": crowded,
        "last_ended_at": last_end.map(|d| iso(&d)),
        "tickets": tickets,
        "autopilot": {"on": false, "delegate": null, "grace_min": null},
    }))
}
