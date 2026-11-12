//! AI Team, Flow, the Timeline view: a sequence diagram of the AI teams (design/screens/ai-team-timeline.md). Port of
//! `services/ai/timeline.py`.
//!
//! One read that answers "who did what, when, and who waited for whom" in a window of time (AI v2): a lifeline for the
//! person, one for each team's lead and one for each role the lead called, a bar for each run of a lead and each stretch
//! of work of a role, an arrow for each hand-off, question and answer, and the span in which the whole project was paused.
//! Everything is built from rows that already exist (`ai_run`, `ai_run_agent` with the markers of `ai_run_step`,
//! `ai_run_message`); nothing is tracked for this view. The client draws the axis (it decides where quiet time is folded),
//! so the times here are true times.
//!
//! Times are `DateTime<FixedOffset>`: a `since` from the query keeps the offset it came with, and `isoformat()` of
//! the Python datetime prints it. `timeline_at` takes the moment that `datetime.now(UTC)` gave (the golden vectors and
//! the tests fix it); `timeline` is `timeline_at` with now.

use std::collections::HashMap;

use chrono::{DateTime, Duration, FixedOffset, Local, TimeZone, Utc};
use kb_base::{pyjson, pytext, time};
use kb_db::Session;
use kb_db::entities::{ai_run, ai_run_agent, ai_run_step, ai_team, member};
use kb_db::sea_orm::sea_query::{Expr, ExprTrait};
use kb_db::sea_orm::{ColumnTrait, DbErr, EntityTrait, JoinType, QueryFilter, QueryOrder, QuerySelect};
use serde_json::{Map, Value, json};

use kb_ai::steps as svc_steps;

/// `RANGES`.
pub const RANGES: [&str; 4] = ["hour", "today", "24h", "7d"];
/// `MAX_RUNS`.
pub const MAX_RUNS: u64 = 400;
/// `MAX_ARROWS`.
pub const MAX_ARROWS: usize = 500;
/// `GROUP_WITHIN_S`.
pub const GROUP_WITHIN_S: i64 = 90;
/// Over `MAX_ARROWS` the picture groups harder (ten minutes) before it drops anything.
pub const CROWDED_WITHIN_S: i64 = 600;
/// `DENSITY_BUCKETS`.
pub const DENSITY_BUCKETS: usize = 60;
/// `ACTIVE`.
pub const ACTIVE: [&str; 4] = ["queued", "starting", "running", "needs_input"];
/// What a role looks like when its team has no say: a tint of the design's AI colours, by the role's name.
pub const ROLE_COLORS: [&str; 7] = ["#2F6FB0", "#0F8B8D", "#C2417A", "#2E6F40", "#B8860B", "#5B5FA8", "#7C5CD6"];
/// `OFFLINE`.
pub const OFFLINE: [&str; 2] = ["runner_missing", "not_logged_in"];
/// Triggers of a run that a note started: a person in the ticket chat, or another AI (`ai_run message`).
pub const NOTE_TRIGGERS: [&str; 2] = ["message", "ai_message"];
/// Questions are what a person looks for: never grouped.
pub const ATTENTION: [&str; 2] = ["ask", "answer"];

/// `(a - b).total_seconds()`.
pub(crate) fn total_seconds(a: DateTime<FixedOffset>, b: DateTime<FixedOffset>) -> f64 {
    (a - b).num_microseconds().map_or_else(|| (a - b).num_milliseconds() as f64 / 1e3, |us| us as f64 / 1e6)
}

/// `store.parse_iso`.
pub(crate) fn parse(value: Option<&str>) -> Option<DateTime<FixedOffset>> {
    kb_ai::store::parse_iso(value)
}

/// `datetime.isoformat()`.
pub(crate) fn iso(at: &DateTime<FixedOffset>) -> String {
    time::iso(at)
}

/// The window [since, until] a range names; `since` and `until` (a custom range) win.
pub fn window(
    range_key: &str,
    now: DateTime<FixedOffset>,
    since: Option<DateTime<FixedOffset>>,
    until: Option<DateTime<FixedOffset>>,
) -> (DateTime<FixedOffset>, DateTime<FixedOffset>) {
    window_in(&Local, range_key, now, since, until)
}

/// `window` for the computer's zone `tz` (what "today" means).
pub fn window_in<Z: TimeZone>(
    tz: &Z,
    range_key: &str,
    now: DateTime<FixedOffset>,
    since: Option<DateTime<FixedOffset>>,
    until: Option<DateTime<FixedOffset>>,
) -> (DateTime<FixedOffset>, DateTime<FixedOffset>) {
    if let Some(since) = since {
        return (since, until.unwrap_or(now));
    }
    match range_key {
        "hour" => (now - Duration::hours(1), now),
        "24h" => (now - Duration::hours(24), now),
        "7d" => (now - Duration::days(7), now),
        _ => (kb_ai::budget::today_start_in(tz, now.with_timezone(&Utc)).fixed_offset(), now),
    }
}

/// `"tester"` → `"Tester"`; `"code-reviewer"` → `"Code reviewer"`.
pub fn role_label(agent_type: &str) -> String {
    let base = if agent_type.is_empty() { "agent" } else { agent_type };
    let words = pytext::strip(&base.replace(['-', '_'], " ")).to_string();
    let mut chars = words.chars();
    match chars.next() {
        Some(first) => first.to_uppercase().chain(chars).collect(),
        None => String::new(),
    }
}

/// The three roles the design draws (AiTimeline, AiTeam board 7) have their own colour in the Map and the Timeline.
pub fn named_role_color(agent_type: &str) -> Option<&'static str> {
    match pytext::strip(agent_type).to_lowercase().as_str() {
        "dev" => Some("#2F6FB0"),
        "reviewer" => Some("#7C5CD6"),
        "qa" => Some("#0F8B8D"),
        _ => None,
    }
}

/// `_role_color`.
pub fn role_color(agent_type: &str) -> &'static str {
    if let Some(named) = named_role_color(agent_type) {
        return named;
    }
    let text = if agent_type.is_empty() { "agent" } else { agent_type };
    let sum: u64 = text.chars().map(|c| u64::from(u32::from(c))).sum();
    ROLE_COLORS[(sum % ROLE_COLORS.len() as u64) as usize]
}

/// How a finished run ended, in the words the diagram draws: ok, failed, memory (stopped by the system over the RAM
/// limit), timeout, stopped (a person), pause_all, limit (the account's usage limit was reached); None while it is live.
pub fn end_kind(r: &ai_run::Model) -> Option<&'static str> {
    match r.state.as_str() {
        "finished" => Some("ok"),
        "failed" => {
            if r.stop_code.as_deref() == Some("memory") {
                return Some("memory");
            }
            if r.stop_code.as_deref() == Some("rate_limited") {
                return Some("limit");
            }
            Some(if r.ended_reason.as_deref().unwrap_or("").to_lowercase().contains("timed out") {
                "timeout"
            } else {
                "failed"
            })
        }
        "cancelled" => {
            if r.ended_reason.as_deref().unwrap_or("").starts_with("Pause all") {
                Some("pause_all")
            } else {
                Some("stopped")
            }
        }
        _ => None,
    }
}

fn first_chars(text: &str, n: usize) -> String {
    text.chars().take(n).collect()
}

/// `loads(raw, default)` where the result must be a dict: anything else reads as no dict.
fn object_of(raw: Option<&str>) -> Map<String, Value> {
    match kb_ai::store::loads(raw, Value::Null) {
        Value::Object(map) => map,
        _ => Map::new(),
    }
}

fn text_field(map: &Map<String, Value>, key: &str) -> String {
    map.get(key).filter(|v| pyjson::truthy(v)).map(pyjson::py_str).unwrap_or_default()
}

/// The bar of a run of a lead.
fn bar(r: &ai_run::Model, lane: &str, held: bool) -> Map<String, Value> {
    let q = object_of(r.question.as_deref());
    let report = object_of(Some(&r.report));
    let summary = if r.summary.as_deref().is_some_and(|s| !s.is_empty()) {
        r.summary.clone().unwrap_or_default()
    } else {
        text_field(&report, "summary")
    };
    let mut out = Map::new();
    out.insert("id".into(), json!(r.id));
    out.insert("run_id".into(), json!(r.id));
    out.insert("agent_id".into(), Value::Null);
    out.insert("role".into(), Value::Null);
    out.insert("label".into(), Value::Null);
    out.insert("member_id".into(), json!(lane));
    out.insert("ticket_id".into(), json!(r.ticket_id.clone().unwrap_or_default()));
    out.insert("number".into(), json!(r.number));
    out.insert("mode".into(), json!(r.mode));
    out.insert("state".into(), json!(r.state));
    out.insert("trigger".into(), json!(r.trigger));
    out.insert("autopilot".into(), json!(false));
    out.insert("queued_at".into(), json!(r.queued_at));
    out.insert("started_at".into(), json!(r.started_at));
    out.insert("ended_at".into(), json!(r.ended_at));
    out.insert("end_kind".into(), json!(end_kind(r)));
    out.insert("ended_reason".into(), json!(r.ended_reason));
    out.insert("ended_by".into(), json!(r.ended_by));
    out.insert("stop_code".into(), json!(r.stop_code));
    out.insert("steps".into(), json!(r.steps_count));
    out.insert("tokens_in".into(), json!(r.tokens_in));
    out.insert("tokens_out".into(), json!(r.tokens_out));
    out.insert("tokens_cached".into(), json!(r.tokens_cached));
    out.insert("cost_usd".into(), json!(kb_ai::audit::round4(r.cost_usd)));
    out.insert("metered".into(), json!(r.metered));
    out.insert("summary".into(), json!(first_chars(&summary, 240)));
    out.insert(
        "question".into(),
        if q.is_empty() { Value::Null } else { json!(first_chars(&text_field(&q, "text"), 240)) },
    );
    out.insert("paused".into(), json!(r.paused));
    // a queued run while the whole project is paused is held, not waiting for a runner
    out.insert("held_by_pause".into(), json!(held && r.state == "queued"));
    out.insert("model".into(), json!(r.model));
    out.insert("peak_rss_mb".into(), json!(r.peak_rss_mb));
    out.insert("last_rss_mb".into(), json!(r.last_rss_mb));
    out.insert("restarts".into(), kb_ai::store::loads(Some(&r.restarts), json!([])));
    out
}

/// A span of an agent: `{start, end}`.
fn span_end(span: &Value) -> Option<String> {
    span.get("end").filter(|v| pyjson::truthy(v)).and_then(Value::as_str).map(str::to_string)
}

/// The bar of one stretch of work of a role: it starts when the lead called it and ends when it reported back.
fn call_bar(r: &ai_run::Model, agent: &Value, lane: &str, n: usize, call: usize, span: &Value) -> Map<String, Value> {
    let active = ACTIVE.contains(&r.state.as_str());
    let start = span.get("start").cloned().unwrap_or(Value::Null);
    let end: Option<Value> = match span_end(span) {
        Some(end) => Some(json!(end)),
        None if active => None,
        None => Some(match r.ended_at.as_deref().filter(|e| !e.is_empty()) {
            Some(e) => json!(e),
            None => start.clone(),
        }),
    };
    let closed_by_run = span_end(span).is_none() && !active;
    let end_truthy = end.as_ref().is_some_and(pyjson::truthy);
    let kind: Option<&str> = if closed_by_run {
        end_kind(r)
    } else if end_truthy {
        Some("ok")
    } else {
        None
    };
    let agent_id = agent.get("id").cloned().unwrap_or(Value::Null);
    let agent_type = agent.get("agent_type").filter(|v| pyjson::truthy(v)).and_then(Value::as_str).unwrap_or("agent");
    let ok_or_none = matches!(kind, None | Some("ok"));
    let state = if ok_or_none { json!(if end.is_none() { "running" } else { "finished" }) } else { json!(r.state) };
    let mut out = Map::new();
    out.insert("id".into(), json!(format!("{}:{n}", pyjson::py_str(&agent_id))));
    out.insert("run_id".into(), json!(r.id));
    out.insert("agent_id".into(), agent_id);
    out.insert("role".into(), json!(agent_type));
    out.insert("label".into(), json!(format!("call {call}")));
    out.insert("member_id".into(), json!(lane));
    out.insert("ticket_id".into(), json!(r.ticket_id.clone().unwrap_or_default()));
    out.insert("number".into(), json!(call));
    out.insert("mode".into(), json!(r.mode));
    out.insert("state".into(), state);
    out.insert("trigger".into(), json!("role call"));
    out.insert("autopilot".into(), json!(false));
    out.insert("queued_at".into(), start.clone());
    out.insert("started_at".into(), start);
    out.insert("ended_at".into(), end.clone().unwrap_or(Value::Null));
    out.insert("end_kind".into(), json!(kind));
    out.insert(
        "ended_reason".into(),
        if closed_by_run && kind != Some("ok") { json!(r.ended_reason) } else { Value::Null },
    );
    out.insert("ended_by".into(), Value::Null);
    out.insert("stop_code".into(), Value::Null);
    out.insert(
        "steps".into(),
        json!(agent.get("steps_count").filter(|v| pyjson::truthy(v)).cloned().unwrap_or(json!(0))),
    );
    out.insert("tokens_in".into(), json!(0));
    out.insert("tokens_out".into(), json!(0));
    out.insert("tokens_cached".into(), Value::Null);
    out.insert("cost_usd".into(), json!(0.0));
    out.insert("metered".into(), json!(r.metered));
    let last_text = agent.get("last_text").filter(|v| pyjson::truthy(v)).and_then(Value::as_str).unwrap_or("");
    out.insert("summary".into(), json!(if end_truthy { first_chars(last_text, 240) } else { String::new() }));
    out.insert("question".into(), Value::Null);
    out.insert("paused".into(), json!(false));
    out.insert("held_by_pause".into(), json!(false));
    out.insert("model".into(), json!(r.model));
    out.insert("peak_rss_mb".into(), Value::Null);
    out.insert("last_rss_mb".into(), Value::Null);
    out.insert("restarts".into(), json!([]));
    out
}

/// What `_arrow` takes besides the first seven (the keyword arguments).
#[derive(Default)]
pub(crate) struct ArrowExtras {
    pub to_at: Option<String>,
    pub wait_s: Option<i64>,
    pub label: Option<String>,
    pub by: Option<String>,
}

/// One arrow of the diagram.
pub(crate) fn arrow(
    id: &str,
    at: Option<&str>,
    kind: &str,
    frm: &str,
    to: &str,
    ticket_id: Option<&str>,
    run_id: Option<&str>,
    extras: ArrowExtras,
) -> Map<String, Value> {
    let mut out = Map::new();
    out.insert("id".into(), json!(id));
    out.insert("at".into(), json!(at));
    let to_at = extras.to_at.filter(|t| !t.is_empty()).or_else(|| at.map(str::to_string));
    out.insert("to_at".into(), json!(to_at));
    out.insert("kind".into(), json!(kind));
    out.insert("from".into(), json!(frm));
    out.insert("to".into(), json!(to));
    out.insert("ticket_id".into(), json!(ticket_id.filter(|t| !t.is_empty())));
    out.insert("run_id".into(), json!(run_id));
    out.insert("wait_s".into(), json!(extras.wait_s));
    out.insert("round".into(), json!(0));
    out.insert("label".into(), json!(extras.label));
    out.insert("by".into(), json!(extras.by));
    out
}

fn str_of<'a>(m: &'a Map<String, Value>, key: &str) -> &'a str {
    m.get(key).and_then(Value::as_str).unwrap_or("")
}

/// Close events between the same two lifelines of the same kind become one arrow with a count.
pub fn group(arrows: &[Map<String, Value>], within_s: i64) -> Vec<Map<String, Value>> {
    let mut out: Vec<Map<String, Value>> = Vec::new();
    let mut last: HashMap<(String, String, String), usize> = HashMap::new();
    let mut sorted: Vec<&Map<String, Value>> = arrows.iter().collect();
    sorted.sort_by(|a, b| str_of(a, "at").cmp(str_of(b, "at")));
    for a in sorted {
        let key = (str_of(a, "kind").to_string(), str_of(a, "from").to_string(), str_of(a, "to").to_string());
        let prev = last.get(&key).copied();
        let at = parse(a.get("at").and_then(Value::as_str));
        let prev_at = prev.and_then(|i| parse(out[i].get("at_last").and_then(Value::as_str)));
        if let (Some(i), Some(at), Some(prev_at)) = (prev, at, prev_at) {
            if total_seconds(at, prev_at) <= within_s as f64 && !ATTENTION.contains(&key.0.as_str()) {
                let row = &mut out[i];
                let count = row.get("count").and_then(Value::as_i64).unwrap_or(1) + 1;
                row.insert("count".into(), json!(count));
                row.insert("at_last".into(), a.get("at").cloned().unwrap_or(Value::Null));
                if let Some(Value::Array(items)) = row.get_mut("items") {
                    items.push(json!({"id": a.get("id"), "ticket_id": a.get("ticket_id")}));
                }
                continue;
            }
        }
        let mut row = a.clone();
        row.insert("count".into(), json!(1));
        row.insert("at_last".into(), a.get("at").cloned().unwrap_or(Value::Null));
        row.insert("parent_id".into(), Value::Null);
        row.insert("items".into(), json!([{"id": a.get("id"), "ticket_id": a.get("ticket_id")}]));
        out.push(row);
        last.insert(key, out.len() - 1);
    }
    out
}

/// The subagents (with their stretches of work) of several runs, oldest first, by run.
pub async fn load_agents(session: &Session, run_ids: &[String]) -> Result<HashMap<String, Vec<Value>>, DbErr> {
    if run_ids.is_empty() {
        return Ok(HashMap::new());
    }
    let rows = ai_run_agent::Entity::find()
        .filter(ai_run_agent::Column::RunId.is_in(run_ids.to_vec()))
        .order_by_asc(ai_run_agent::Column::StartedAt)
        .all(session)
        .await?;
    let marks = ai_run_step::Entity::find()
        .filter(ai_run_step::Column::RunId.is_in(run_ids.to_vec()))
        .filter(ai_run_step::Column::Kind.eq("role"))
        .order_by_asc(ai_run_step::Column::Seq)
        .all(session)
        .await?;
    let mut by_agent: HashMap<String, Vec<ai_run_step::Model>> = HashMap::new();
    for m in marks {
        by_agent.entry(m.agent_id.clone().unwrap_or_default()).or_default().push(m);
    }
    let mut out: HashMap<String, Vec<Value>> = HashMap::new();
    for a in rows {
        let mine = by_agent.get(&a.id).map(Vec::as_slice);
        out.entry(a.run_id.clone()).or_default().push(svc_steps::agent_dict(&a, mine));
    }
    Ok(out)
}

/// The title of the newest step of each run (what a live run is doing now).
async fn last_steps(session: &Session, run_ids: &[String]) -> Result<HashMap<String, String>, DbErr> {
    let mut out = HashMap::new();
    for rid in run_ids {
        let row = ai_run_step::Entity::find()
            .filter(ai_run_step::Column::RunId.eq(rid.as_str()))
            .filter(ai_run_step::Column::Kind.ne("role"))
            .order_by_desc(ai_run_step::Column::Seq)
            .limit(1)
            .one(session)
            .await?;
        if let Some(row) = row {
            out.insert(rid.clone(), first_chars(&row.title, 120));
        }
    }
    Ok(out)
}

/// The teams of a project in query order: each team's member row and its AI profile, by member id.
#[derive(Default)]
pub struct Teams {
    /// The ids in the order the query gave them.
    pub order: Vec<String>,
    /// The rows by id.
    pub rows: HashMap<String, (member::Model, ai_team::Model)>,
}

impl Teams {
    /// `tid in teams`.
    pub fn has(&self, id: &str) -> bool {
        self.rows.contains_key(id)
    }

    /// `teams[tid][0]`.
    pub fn member(&self, id: &str) -> Option<&member::Model> {
        self.rows.get(id).map(|(m, _)| m)
    }

    /// `teams[tid][1]`.
    pub fn team(&self, id: &str) -> Option<&ai_team::Model> {
        self.rows.get(id).map(|(_, t)| t)
    }
}

/// `select(Member, AiTeam).join(AiTeam, AiTeam.id == Member.id).where(AiTeam.project_id == project_id)`.
pub async fn load_teams(session: &Session, project_id: &str) -> Result<Teams, DbErr> {
    let mut joined = member::Entity::find().select_also(ai_team::Entity);
    QuerySelect::query(&mut joined).join(
        JoinType::InnerJoin,
        ai_team::Entity,
        Expr::col((ai_team::Entity, ai_team::Column::Id)).equals((member::Entity, member::Column::Id)),
    );
    let rows = joined.filter(ai_team::Column::ProjectId.eq(project_id)).all(session).await?;
    let mut teams = Teams::default();
    for (m, t) in rows {
        let Some(t) = t else {
            continue;
        };
        if !teams.rows.contains_key(&m.id) {
            teams.order.push(m.id.clone());
        }
        teams.rows.insert(m.id.clone(), (m, t));
    }
    Ok(teams)
}

/// Lower-cased name -> team id, for the names that mean exactly one team: a note's sender is known by its name, so
/// a name shared by two teams, or with a person of the project, is left out (it would draw the wrong team).
pub async fn name_map(session: &Session, project_id: &str, teams: &Teams) -> Result<HashMap<String, String>, DbErr> {
    let people: Vec<String> = member::Entity::find()
        .filter(member::Column::ProjectId.eq(project_id))
        .filter(member::Column::Kind.ne("ai"))
        .all(session)
        .await?
        .into_iter()
        .map(|m| pytext::strip(&m.name).to_lowercase())
        .collect();
    let mut seen: Vec<(String, Vec<String>)> = Vec::new();
    for tid in &teams.order {
        let Some(m) = teams.member(tid) else {
            continue;
        };
        let name = pytext::strip(&m.name).to_lowercase();
        match seen.iter_mut().find(|(n, _)| *n == name) {
            Some((_, ids)) => ids.push(tid.clone()),
            None => seen.push((name, vec![tid.clone()])),
        }
    }
    Ok(seen
        .into_iter()
        .filter(|(n, ids)| ids.len() == 1 && !people.contains(n))
        .map(|(n, ids)| (n, ids[0].clone()))
        .collect())
}

/// What `timeline` takes after the session and the project (the keyword arguments).
#[derive(Debug, Clone)]
pub struct TimelineOpts {
    /// `hour`, `today`, `24h` or `7d`; anything else reads as `today`.
    pub range_key: String,
    /// A custom window's start.
    pub since: Option<DateTime<FixedOffset>>,
    /// A custom window's end.
    pub until: Option<DateTime<FixedOffset>>,
    /// Show one ticket and its sub-tickets.
    pub ticket_id: Option<String>,
    /// Show one team.
    pub team_id: Option<String>,
}

impl Default for TimelineOpts {
    fn default() -> Self {
        Self { range_key: "today".to_string(), since: None, until: None, ticket_id: None, team_id: None }
    }
}

mod build;

pub(crate) use build::scope_of;
pub use build::{timeline, timeline_at};
