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
use kb_db::entities::{ai_run, ai_run_agent, ai_run_message, ai_run_step, ai_team, member, ticket};
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
    let kind: Option<&str> = if closed_by_run { end_kind(r) } else if end_truthy { Some("ok") } else { None };
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
    out.insert("steps".into(), json!(agent.get("steps_count").filter(|v| pyjson::truthy(v)).cloned().unwrap_or(json!(0))));
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
    Ok(seen.into_iter().filter(|(n, ids)| ids.len() == 1 && !people.contains(n)).map(|(n, ids)| (n, ids[0].clone())).collect())
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
        let from_team = if NOTE_TRIGGERS.contains(&r.trigger.as_str()) { sender_team(Some(&r.started_by), lead) } else { None };
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
            let agent_type = ag.get("agent_type").filter(|v| pyjson::truthy(v)).and_then(Value::as_str).unwrap_or("agent");
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
                let cb_end = cb.get("ended_at").filter(|v| pyjson::truthy(v)).and_then(Value::as_str).map(str::to_string);
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
            None => if many { team } else { "Lead".to_string() },
            Some(role) => if many { format!("{} ({team})", role_label(role)) } else { role_label(role) },
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
        let s = parse(x.get("started_at").and_then(Value::as_str)).or_else(|| parse(x.get("queued_at").and_then(Value::as_str)));
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
        if let Some(at) = x.get("ended_at").filter(|v| pyjson::truthy(v)).and_then(Value::as_str).and_then(|e| parse(Some(e))) {
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
