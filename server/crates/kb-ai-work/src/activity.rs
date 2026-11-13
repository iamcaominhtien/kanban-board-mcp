//! What a team's roles are doing and have done (AI Team page, AI v2): read from `ai_run`, `ai_run_agent` and
//! `ai_run_step`. There is no cost per role (cost belongs to a run), so this module counts runs and steps, never money.
//! Port of `services/ai/activity.py`.

use std::collections::{HashMap, HashSet};
use std::sync::LazyLock;

use chrono::{DateTime, Utc};
use kb_base::{pyjson, pytext};
use kb_db::Session;
use kb_db::entities::{ai_run, ai_run_agent, ai_run_message, ai_run_step, ticket};
use kb_db::sea_orm::sea_query::{Expr, ExprTrait};
use kb_db::sea_orm::{
    ColumnTrait, Condition, DbErr, EntityTrait, JoinType, PaginatorTrait, QueryFilter, QueryOrder, QuerySelect,
};
use regex::Regex;
use serde_json::{Map, Value, json};

use kb_ai::steps as svc_steps;

/// `WORKING_RUN_STATES`.
pub const WORKING_RUN_STATES: [&str; 3] = ["starting", "running", "needs_input"];
/// `ENDED_RUN_STATES`.
pub const ENDED_RUN_STATES: [&str; 4] = ["finished", "failed", "cancelled", "timed_out"];
/// Steps that say what a role is doing; hooks and markers do not.
pub const QUIET_KINDS: [&str; 4] = ["hook", "role", "start", "end"];

/// Start of today (UTC, as the team's usage counts it): `datetime.now(UTC).date().isoformat()`.
pub fn day_start() -> String {
    day_start_at(Utc::now())
}

/// `day_start` at the moment `now`.
pub fn day_start_at(now: DateTime<Utc>) -> String {
    now.date_naive().format("%Y-%m-%d").to_string()
}

static WIKI_LINK: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\[\[(?:[^\]|]+\|)?([^\]]+)\]\]").expect("a fixed pattern"));

/// The first non-empty line of a report, cleaned of Markdown marks (and `[[page]]` links) and cut short.
pub fn first_line(text: Option<&str>, limit: usize) -> String {
    for raw in pytext::splitlines(text.unwrap_or("")) {
        let line =
            pytext::strip(raw).trim_start_matches(['#', '>', '*', '-', '•', ' ']).replace("**", "").replace('`', "");
        let line = WIKI_LINK.replace_all(&line, "$1").into_owned();
        let line = pytext::strip(&line);
        if !line.is_empty() {
            if line.chars().count() <= limit {
                return line.to_string();
            }
            let cut: String = line.chars().take(limit.saturating_sub(1)).collect();
            return format!("{}…", cut.trim_end_matches(pytext::is_space));
        }
    }
    String::new()
}

/// `first_line(text)` with the default limit of 200.
pub fn first_line_default(text: Option<&str>) -> String {
    first_line(text, 200)
}

async fn ticket_titles(session: &Session, wanted: &[Option<&str>]) -> Result<HashMap<String, String>, DbErr> {
    let mut ids: Vec<String> = Vec::new();
    for w in wanted.iter().flatten().filter(|w| !w.is_empty()) {
        if !ids.iter().any(|i| i == w) {
            ids.push((*w).to_string());
        }
    }
    if ids.is_empty() {
        return Ok(HashMap::new());
    }
    let rows = ticket::Entity::find().filter(ticket::Column::Id.is_in(ids)).all(session).await?;
    Ok(rows.into_iter().map(|t| (t.id, t.title)).collect())
}

async fn newest_step(session: &Session, run_id: &str, agent_id: Option<&str>) -> Result<Option<Value>, DbErr> {
    let mut stmt = ai_run_step::Entity::find()
        .filter(ai_run_step::Column::RunId.eq(run_id))
        .filter(ai_run_step::Column::Kind.is_not_in(QUIET_KINDS));
    stmt = match agent_id.filter(|a| !a.is_empty()) {
        Some(agent) => stmt.filter(ai_run_step::Column::AgentId.eq(agent)),
        None => stmt.filter(ai_run_step::Column::AgentId.is_null()),
    };
    let row = stmt.order_by_desc(ai_run_step::Column::Seq).limit(1).one(session).await?;
    Ok(row.map(|r| json!({"title": r.title, "kind": r.kind, "at": r.at})))
}

/// When the role last stopped (None while it works).
fn span_end(agent: &Value) -> Option<Value> {
    let spans = agent.get("spans").and_then(Value::as_array).filter(|s| !s.is_empty());
    let end = match spans {
        Some(spans) => spans.last().and_then(|s| s.get("end")).cloned().unwrap_or(Value::Null),
        None => agent.get("ended_at").cloned().unwrap_or(Value::Null),
    };
    if Value::is_null(&end) { None } else { Some(end) }
}

fn text(v: &Value, key: &str) -> String {
    v.get(key).and_then(Value::as_str).unwrap_or("").to_string()
}

/// The lead and each role of a team: what it works on now, when it last worked, runs and steps today.
///
/// `role_keys` are the keys of the team's roles, in order. A subagent type that is not a role of the team (one the
/// lead made up) is listed after them, so no work goes missing.
pub async fn team_activity(session: &Session, member_id: &str, role_keys: &[String]) -> Result<Value, DbErr> {
    team_activity_at(session, member_id, role_keys, &day_start()).await
}

/// `team_activity` for the day that starts at `day` (`YYYY-MM-DD`).
pub async fn team_activity_at(
    session: &Session,
    member_id: &str,
    role_keys: &[String],
    day: &str,
) -> Result<Value, DbErr> {
    // runs that matter for "now" and "today": still going, or started or ended today
    let runs = ai_run::Entity::find()
        .filter(ai_run::Column::MemberId.eq(member_id))
        .filter(
            Condition::any()
                .add(ai_run::Column::State.is_in(["starting", "running", "needs_input", "queued"]))
                .add(ai_run::Column::StartedAt.gte(day))
                .add(ai_run::Column::EndedAt.gte(day)),
        )
        .order_by_desc(ai_run::Column::QueuedAt)
        .all(session)
        .await?;
    // the latest agents of each role, even from days ago (for "last worked")
    let mut joined = ai_run_agent::Entity::find().select_also(ai_run::Entity);
    QuerySelect::query(&mut joined).join(
        JoinType::InnerJoin,
        ai_run::Entity,
        Expr::col((ai_run::Entity, ai_run::Column::Id)).equals((ai_run_agent::Entity, ai_run_agent::Column::RunId)),
    );
    let last_agent_rows: Vec<(ai_run_agent::Model, ai_run::Model)> = joined
        .filter(ai_run::Column::MemberId.eq(member_id))
        .order_by_desc(ai_run_agent::Column::StartedAt)
        .limit(400)
        .all(session)
        .await?
        .into_iter()
        .filter_map(|(a, r)| r.map(|r| (a, r)))
        .collect();
    let mut by_run: HashMap<String, ai_run::Model> = runs.iter().map(|r| (r.id.clone(), r.clone())).collect();
    let mut agents_by_run: Vec<(String, Vec<Value>)> = Vec::new();
    for r in &runs {
        if !agents_by_run.iter().any(|(id, _)| *id == r.id) {
            agents_by_run.push((r.id.clone(), svc_steps::agents(session, &r.id).await?));
        }
    }
    for (_, r) in &last_agent_rows {
        by_run.entry(r.id.clone()).or_insert_with(|| r.clone());
    }

    let mut keys: Vec<String> = role_keys.to_vec();
    let mut seen: HashSet<String> = keys.iter().cloned().collect();
    for (agent, _) in &last_agent_rows {
        if !agent.agent_type.is_empty() && !seen.contains(&agent.agent_type) {
            seen.insert(agent.agent_type.clone());
            keys.push(agent.agent_type.clone());
        }
    }

    // steps today per agent (one grouped query), and the lead's own
    let all_agent_ids: Vec<String> =
        agents_by_run.iter().flat_map(|(_, lst)| lst.iter().map(|a| text(a, "id"))).collect();
    let mut steps_today: HashMap<String, i64> = HashMap::new();
    if !all_agent_ids.is_empty() {
        let rows: Vec<(Option<String>, i64)> = ai_run_step::Entity::find()
            .select_only()
            .column(ai_run_step::Column::AgentId)
            .column_as(Expr::col(ai_run_step::Column::Id).count(), "n")
            .filter(ai_run_step::Column::AgentId.is_in(all_agent_ids))
            .filter(ai_run_step::Column::At.gte(day))
            .filter(ai_run_step::Column::Kind.is_not_in(QUIET_KINDS))
            .group_by(ai_run_step::Column::AgentId)
            .into_tuple::<(Option<String>, i64)>()
            .all(session)
            .await?;
        for (agent, n) in rows {
            if let Some(agent) = agent {
                steps_today.insert(agent, n);
            }
        }
    }
    let mut lead_steps_today: i64 = 0;
    if !runs.is_empty() {
        lead_steps_today = ai_run_step::Entity::find()
            .filter(ai_run_step::Column::RunId.is_in(runs.iter().map(|r| r.id.clone()).collect::<Vec<_>>()))
            .filter(ai_run_step::Column::AgentId.is_null())
            .filter(ai_run_step::Column::At.gte(day))
            .filter(ai_run_step::Column::Kind.is_not_in(QUIET_KINDS))
            .count(session)
            .await? as i64;
    }

    let ticket_ids: Vec<Option<&str>> = by_run.values().map(|r| r.ticket_id.as_deref()).collect();
    let titles = ticket_titles(session, &ticket_ids).await?;

    let where_of = |run: &ai_run::Model| -> Map<String, Value> {
        let mut m = Map::new();
        m.insert("run_id".into(), json!(run.id));
        m.insert("ticket_id".into(), json!(run.ticket_id));
        m.insert("ticket_title".into(), json!(titles.get(run.ticket_id.as_deref().unwrap_or(""))));
        m.insert("number".into(), json!(run.number));
        m
    };

    let mut out_roles: Vec<Value> = Vec::new();
    for key in &keys {
        let mut working: Option<(Map<String, Value>, String)> = None;
        let mut runs_today: HashSet<&str> = HashSet::new();
        let mut steps: i64 = 0;
        for (rid, lst) in &agents_by_run {
            let Some(run) = by_run.get(rid) else {
                continue;
            };
            for a in lst {
                if text(a, "agent_type") != *key {
                    continue;
                }
                steps += steps_today.get(&text(a, "id")).copied().unwrap_or(0);
                let is_working = span_end(a).is_none() && WORKING_RUN_STATES.contains(&run.state.as_str());
                if text(a, "started_at").as_str() >= day || is_working {
                    runs_today.insert(rid.as_str());
                }
                if is_working {
                    let mut w = where_of(run);
                    let last_span = a.get("spans").and_then(Value::as_array).and_then(|s| s.last());
                    let start = last_span
                        .and_then(|s| s.get("start"))
                        .filter(|v| pyjson::truthy(v))
                        .cloned()
                        .unwrap_or_else(|| a.get("started_at").cloned().unwrap_or(Value::Null));
                    w.insert("since".into(), start);
                    w.insert("steps_count".into(), a.get("steps_count").cloned().unwrap_or(Value::Null));
                    w.insert("state".into(), json!(run.state));
                    w.insert(
                        "step".into(),
                        newest_step(session, rid, Some(&text(a, "id"))).await?.unwrap_or(Value::Null),
                    );
                    working = Some((w, text(a, "id")));
                }
            }
        }
        let mut last: Option<Value> = None;
        for (agent, run) in &last_agent_rows {
            if agent.agent_type != *key {
                continue;
            }
            if working.as_ref().is_some_and(|(_, id)| *id == agent.id) {
                // that is the stretch it is in now
                continue;
            }
            let mut l = where_of(run);
            let at = match agent.ended_at.as_deref().filter(|e| !e.is_empty()) {
                Some(e) => e.to_string(),
                None => agent.started_at.clone(),
            };
            l.insert("at".into(), json!(at));
            l.insert("steps_count".into(), json!(agent.steps_count));
            let line = first_line(agent.last_text.as_deref(), 160);
            l.insert("text".into(), if line.is_empty() { Value::Null } else { json!(line) });
            last = Some(Value::Object(l));
            break;
        }
        out_roles.push(json!({
            "key": key,
            "working": working.map(|(w, _)| Value::Object(w)),
            "last_worked": last,
            "steps_today": steps,
            "runs_today": runs_today.len(),
        }));
    }

    // the lead itself: working while a run of the team goes
    let live: Vec<&ai_run::Model> = runs.iter().filter(|r| WORKING_RUN_STATES.contains(&r.state.as_str())).collect();
    let lead_working = match live.first() {
        Some(r) => {
            let mut w = where_of(r);
            w.insert("since".into(), json!(r.started_at));
            w.insert("state".into(), json!(r.state));
            w.insert("step".into(), newest_step(session, &r.id, None).await?.unwrap_or(Value::Null));
            w.insert("context_used".into(), json!(r.context_used));
            w.insert("context_window".into(), json!(r.context_window));
            Value::Object(w)
        }
        None => Value::Null,
    };
    let lead_last = runs
        .iter()
        .find(|r| ENDED_RUN_STATES.contains(&r.state.as_str()) && r.ended_at.as_deref().is_some_and(|e| !e.is_empty()));
    let lead_last_worked = match lead_last {
        Some(r) => {
            let mut l = where_of(r);
            l.insert("at".into(), json!(r.ended_at));
            l.insert("state".into(), json!(r.state));
            Value::Object(l)
        }
        None => Value::Null,
    };
    Ok(json!({
        "team_id": member_id,
        "day": day,
        "lead": {
            "working": lead_working,
            "last_worked": lead_last_worked,
            "steps_today": lead_steps_today,
            "runs_today": runs.iter().filter(|r| r.started_at.as_deref().unwrap_or("") >= day).count(),
        },
        "roles": out_roles,
    }))
}

/// `team_activity` of each described team (see `teams.list_teams`), by team id.
pub async fn project_activity(session: &Session, teams: &[Value]) -> Result<Value, DbErr> {
    let mut out = Map::new();
    for t in teams {
        let id = text(t, "id");
        let keys: Vec<String> = match t.get("roles") {
            Some(Value::Array(roles)) => roles.iter().map(|r| text(r, "key")).collect(),
            _ => Vec::new(),
        };
        out.insert(id.clone(), team_activity(session, &id, &keys).await?);
    }
    Ok(Value::Object(out))
}

/// Runs that just ended, each with the first line of its report, and the latest notes into and out of runs.
pub async fn recent(session: &Session, project_id: &str, team_id: Option<&str>, limit: u64) -> Result<Value, DbErr> {
    let team_id = team_id.filter(|t| !t.is_empty());
    let mut stmt = ai_run::Entity::find()
        .filter(ai_run::Column::ProjectId.eq(project_id))
        .filter(ai_run::Column::Kind.eq("team"))
        .filter(ai_run::Column::State.is_in(ENDED_RUN_STATES))
        .filter(ai_run::Column::EndedAt.is_not_null());
    if let Some(team) = team_id {
        stmt = stmt.filter(ai_run::Column::MemberId.eq(team));
    }
    let ended = stmt.order_by_desc(ai_run::Column::EndedAt).limit(limit).all(session).await?;

    let mut joined = ai_run_message::Entity::find().select_also(ai_run::Entity);
    QuerySelect::query(&mut joined).join(
        JoinType::InnerJoin,
        ai_run::Entity,
        Expr::col((ai_run::Entity, ai_run::Column::Id)).equals((ai_run_message::Entity, ai_run_message::Column::RunId)),
    );
    let mut mstmt = joined.filter(ai_run::Column::ProjectId.eq(project_id));
    if let Some(team) = team_id {
        mstmt = mstmt.filter(ai_run::Column::MemberId.eq(team));
    }
    let notes: Vec<(ai_run_message::Model, ai_run::Model)> = mstmt
        .order_by_desc(ai_run_message::Column::At)
        .limit(limit)
        .all(session)
        .await?
        .into_iter()
        .filter_map(|(m, r)| r.map(|r| (m, r)))
        .collect();
    let mut wanted: Vec<Option<&str>> = ended.iter().map(|r| r.ticket_id.as_deref()).collect();
    wanted.extend(notes.iter().map(|(_, r)| r.ticket_id.as_deref()));
    let titles = ticket_titles(session, &wanted).await?;
    let title_of = |id: Option<&str>| titles.get(id.unwrap_or("")).cloned();
    let runs: Vec<Value> = ended
        .iter()
        .map(|r| {
            let report = match kb_ai::store::loads(Some(&r.report), json!({})) {
                Value::Object(m) => m,
                _ => Map::new(),
            };
            let summary: Option<String> = match report.get("summary").filter(|v| pyjson::truthy(v)) {
                Some(v) => Some(pyjson::py_str(v)),
                None => r.summary.clone(),
            };
            let mut line = first_line_default(summary.as_deref());
            if line.is_empty() {
                line = first_line_default(r.ended_reason.as_deref());
            }
            json!({
                "run_id": r.id,
                "ticket_id": r.ticket_id,
                "ticket_title": title_of(r.ticket_id.as_deref()),
                "member_id": r.member_id,
                "number": r.number,
                "state": r.state,
                "ended_at": r.ended_at,
                "steps_count": r.steps_count,
                "line": line,
            })
        })
        .collect();
    let notes: Vec<Value> = notes
        .iter()
        .map(|(m, r)| {
            json!({
                "id": m.id,
                "run_id": r.id,
                "ticket_id": r.ticket_id,
                "ticket_title": title_of(r.ticket_id.as_deref()),
                "member_id": r.member_id,
                "direction": m.direction,
                "peer": m.peer,
                "text": first_line(Some(&m.text), 220),
                "at": m.at,
            })
        })
        .collect();
    Ok(json!({"runs": runs, "notes": notes}))
}
