//! AI Team, Flow, the Map view and the scope picker (AI v2). Port of `services/ai/flow.py`.
//!
//! The Map answers "how does work pass between the teams and you": nodes are the person, the teams (each with the roles
//! it called) and the tickets being worked; edges are the team that took a ticket, notes between teams (`ai_run message`),
//! questions to the person and their answers, parent and child tickets, and blocked-by. Like the Timeline it is built from
//! rows that already exist (`ai_run`, `ai_run_agent`, `ai_run_message`, the tickets) and nothing is tracked for it.

use std::collections::{HashMap, HashSet};
use std::hash::Hash;

use chrono::{DateTime, FixedOffset, Utc};
use kb_base::{pyjson, pytext};
use kb_db::Session;
use kb_db::entities::{ai_run, ai_run_agent, ai_run_message, ai_team, ticket};
use kb_db::sea_orm::{ColumnTrait, DbErr, EntityTrait, QueryFilter, QueryOrder, QuerySelect};
use serde_json::{Map, Value, json};

use crate::timeline::{
    ACTIVE, MAX_RUNS, NOTE_TRIGGERS, Teams, load_teams, name_map, parse, role_color, role_label, scope_of, window,
};

/// The tickets the scope picker lists.
pub const MAX_PICKER_TICKETS: usize = 200;
/// The tickets a map draws before it says "narrow the range".
pub const MAX_MAP_TICKETS: usize = 60;

/// A dict that remembers the order its keys were added in.
struct Ordered<K, V> {
    keys: Vec<K>,
    map: HashMap<K, V>,
}

impl<K: Hash + Eq + Clone, V> Ordered<K, V> {
    fn new() -> Self {
        Self { keys: Vec::new(), map: HashMap::new() }
    }

    /// `d.setdefault(key, make())`.
    fn entry(&mut self, key: K, make: impl FnOnce() -> V) -> &mut V {
        if !self.map.contains_key(&key) {
            self.keys.push(key.clone());
            self.map.insert(key.clone(), make());
        }
        self.map.get_mut(&key).expect("the key was just added")
    }

    /// `d[key] = value`: a new key goes last, an old one keeps its place.
    fn put(&mut self, key: K, value: V) {
        if !self.map.contains_key(&key) {
            self.keys.push(key.clone());
        }
        self.map.insert(key, value);
    }

    fn iter(&self) -> impl Iterator<Item = (&K, &V)> {
        self.keys.iter().filter_map(|k| self.map.get(k).map(|v| (k, v)))
    }

    fn values(&self) -> impl Iterator<Item = &V> {
        self.iter().map(|(_, v)| v)
    }
}

/// `_ids(raw)`: the strings of a JSON list column, empty for anything else.
pub fn ids(raw: Option<&str>) -> Vec<String> {
    let text = raw.filter(|r| !r.is_empty()).unwrap_or("[]");
    match serde_json::from_str::<Value>(text) {
        Ok(Value::Array(items)) => items.iter().map(pyjson::py_str).collect(),
        _ => Vec::new(),
    }
}

/// `_team_state`.
pub fn team_state(team: &ai_team::Model, mine: &[&ai_run::Model], held: bool) -> &'static str {
    if matches!(team.health.as_str(), "runner_missing" | "not_logged_in") {
        return "offline";
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
    if mine.iter().any(|r| ACTIVE.contains(&r.state.as_str())) { "queued" } else { "idle" }
}

fn first_chars(text: &str, n: usize) -> String {
    text.chars().take(n).collect()
}

fn lower_name(name: &str) -> String {
    pytext::strip(name).to_lowercase()
}

#[derive(Default)]
struct Take {
    count: i64,
    live: bool,
    waiting: bool,
}

#[derive(Default)]
struct Ask {
    asked: i64,
    answered: i64,
    open: i64,
    tickets: Vec<String>,
    text: String,
}

struct Note {
    count: i64,
    tickets: Vec<String>,
    text: String,
}

/// What `flow_map` takes after the session and the project (the keyword arguments).
#[derive(Debug, Clone)]
pub struct FlowOpts {
    /// `hour`, `today`, `24h`, `7d`, or `all` (the whole life of the scope).
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

impl Default for FlowOpts {
    fn default() -> Self {
        Self { range_key: "today".to_string(), since: None, until: None, ticket_id: None, team_id: None }
    }
}

/// The nodes and edges of the Map for a range and a scope (the whole project, one team, or one ticket with its
/// sub-tickets). `range_key` `all` is the whole life of the scope.
pub async fn flow_map(session: &Session, project_id: &str, opts: &FlowOpts) -> Result<Value, DbErr> {
    flow_map_at(session, project_id, opts, Utc::now().fixed_offset()).await
}

/// `flow_map` at the moment `now` (what `datetime.now(UTC)` gave).
pub async fn flow_map_at(
    session: &Session,
    project_id: &str,
    opts: &FlowOpts,
    now: DateTime<FixedOffset>,
) -> Result<Value, DbErr> {
    let range_key = opts.range_key.as_str();
    let settings = kb_ai::store::get_settings(session, project_id).await?;
    let held = settings.paused_all;
    let teams = load_teams(session, project_id).await?;
    let ticket_id = opts.ticket_id.as_deref().filter(|t| !t.is_empty());
    let team_id = opts.team_id.as_deref().filter(|t| !t.is_empty());

    let scope_ids = scope_of(session, ticket_id).await?;

    let mut stmt = ai_run::Entity::find().filter(ai_run::Column::ProjectId.eq(project_id)).filter(ai_run::Column::Kind.eq("team"));
    let (a, b) = if range_key != "all" {
        let (a, b) = window(range_key, now, opts.since, opts.until);
        stmt = stmt.filter(ai_run::Column::QueuedAt.lte(crate::timeline::iso(&b)));
        (Some(a), Some(b))
    } else {
        (None, None)
    };
    if let Some(ids) = &scope_ids {
        stmt = stmt.filter(ai_run::Column::TicketId.is_in(ids.clone()));
    }
    if let Some(team) = team_id {
        stmt = stmt.filter(ai_run::Column::MemberId.eq(team));
    }
    let candidates = stmt.order_by_desc(ai_run::Column::QueuedAt).limit(MAX_RUNS).all(session).await?;
    let runs: Vec<ai_run::Model> = candidates
        .iter()
        .filter(|r| teams.has(&r.member_id) && a.is_none_or(|a| parse(r.ended_at.as_deref()).unwrap_or(now) >= a))
        .cloned()
        .collect();
    let run_ids: Vec<String> = runs.iter().map(|r| r.id.clone()).collect();
    let runs_by_id: HashMap<&str, &ai_run::Model> = runs.iter().map(|r| (r.id.as_str(), r)).collect();

    // notes: the receiver's run is what records one, so a view of one team (or of one ticket) also reads the runs other
    // teams started on a note from a team in view; they feed the note edges only, never the takes or the tickets
    let mut note_runs: Vec<ai_run::Model> = runs.clone();
    // runs of other teams read only for the notes the team in view sent them
    let mut extra_ids: HashSet<String> = HashSet::new();
    if let Some(tid) = team_id.filter(|t| teams.has(t)) {
        let mine_name = lower_name(&teams.member(tid).map(|m| m.name.clone()).unwrap_or_default());
        let extra = ai_run::Entity::find()
            .filter(ai_run::Column::ProjectId.eq(project_id))
            .filter(ai_run::Column::Kind.eq("team"))
            .filter(ai_run::Column::Trigger.is_in(NOTE_TRIGGERS))
            .filter(ai_run::Column::MemberId.ne(tid))
            .order_by_desc(ai_run::Column::QueuedAt)
            .limit(MAX_RUNS)
            .all(session)
            .await?;
        let have: HashSet<&str> = run_ids.iter().map(String::as_str).collect();
        let added: Vec<ai_run::Model> = extra
            .into_iter()
            .filter(|r| {
                !have.contains(r.id.as_str())
                    && teams.has(&r.member_id)
                    && lower_name(&r.started_by) == mine_name
                    && a.is_none_or(|a| parse(r.ended_at.as_deref()).unwrap_or(now) >= a)
                    && b.is_none_or(|b| parse(Some(&r.queued_at)).unwrap_or(now) <= b)
            })
            .collect();
        extra_ids = added.iter().map(|r| r.id.clone()).collect();
        note_runs.extend(added);
    }
    let note_run_ids: Vec<String> = note_runs.iter().map(|r| r.id.clone()).collect();
    let note_runs_by_id: HashMap<&str, &ai_run::Model> = note_runs.iter().map(|r| (r.id.as_str(), r)).collect();

    // roles each team called in these runs (a call is one stretch of work; the count is what the lead used them for)
    let mut roles: HashMap<String, Ordered<String, i64>> = HashMap::new();
    if !run_ids.is_empty() {
        let agents =
            ai_run_agent::Entity::find().filter(ai_run_agent::Column::RunId.is_in(run_ids.clone())).all(session).await?;
        for ag in agents {
            if let Some(r) = runs_by_id.get(ag.run_id.as_str()) {
                let role = if ag.agent_type.is_empty() { "agent".to_string() } else { ag.agent_type.clone() };
                *roles.entry(r.member_id.clone()).or_insert_with(Ordered::new).entry(role, || 0) += 1;
            }
        }
    }

    // takes: the team that worked a ticket
    let mut takes: Ordered<(String, String), Take> = Ordered::new();
    for r in &runs {
        let Some(ticket) = r.ticket_id.as_deref().filter(|t| !t.is_empty()) else {
            continue;
        };
        let e = takes.entry((r.member_id.clone(), ticket.to_string()), Take::default);
        e.count += 1;
        if ACTIVE.contains(&r.state.as_str()) {
            e.live = true;
        }
        if r.state == "needs_input" {
            e.waiting = true;
        }
    }

    // questions to the person and their answers, by team
    let mut asks: Ordered<String, Ask> = Ordered::new();
    for r in &runs {
        let q = match kb_ai::store::loads(r.question.as_deref(), Value::Null) {
            Value::Object(map) => map,
            _ => Map::new(),
        };
        let Some(asked) = parse(q.get("asked_at").and_then(Value::as_str)) else {
            continue;
        };
        if b.is_some_and(|b| asked > b) || a.is_some_and(|a| asked < a) {
            continue;
        }
        let e = asks.entry(r.member_id.clone(), Ask::default);
        e.asked += 1;
        if q.get("answered_at").is_some_and(pyjson::truthy) {
            e.answered += 1;
        } else if r.state == "needs_input" {
            // a question of a run that ended unanswered waits for nobody
            e.open += 1;
        }
        if let Some(t) = r.ticket_id.as_deref().filter(|t| !t.is_empty()) {
            if !e.tickets.iter().any(|x| x == t) {
                e.tickets.push(t.to_string());
            }
        }
        e.text = first_chars(q.get("text").filter(|v| pyjson::truthy(v)).map(pyjson::py_str).unwrap_or_default().as_str(), 160);
    }

    // notes between teams: a team's note to a ticket's team arrives as a message from the sender's name
    let by_name = name_map(session, project_id, &teams).await?;
    let mut notes: Ordered<(String, String), Note> = Ordered::new();
    let mut add_note = |frm: &str, to: &str, ticket: Option<&str>, text: &str| {
        let e = notes.entry((frm.to_string(), to.to_string()), || Note { count: 0, tickets: Vec::new(), text: String::new() });
        e.count += 1;
        if let Some(t) = ticket.filter(|t| !t.is_empty()) {
            if !e.tickets.iter().any(|x| x == t) {
                e.tickets.push(t.to_string());
            }
        }
        e.text = first_chars(text, 160);
    };
    for r in &note_runs {
        let sender = by_name.get(&lower_name(&r.started_by));
        let queued = parse(Some(&r.queued_at));
        let in_window = queued.is_some_and(|q| a.is_none_or(|a| q >= a) && b.is_none_or(|b| q <= b));
        if let Some(sender) = sender {
            if NOTE_TRIGGERS.contains(&r.trigger.as_str()) && *sender != r.member_id && in_window {
                add_note(sender, &r.member_id, r.ticket_id.as_deref(), "");
            }
        }
    }
    if !note_run_ids.is_empty() {
        let messages = ai_run_message::Entity::find()
            .filter(ai_run_message::Column::RunId.is_in(note_run_ids.clone()))
            .filter(ai_run_message::Column::Direction.eq("in"))
            .all(session)
            .await?;
        for m in messages {
            let Some(r) = note_runs_by_id.get(m.run_id.as_str()) else {
                continue;
            };
            let sender = by_name.get(&lower_name(&m.peer));
            let at = parse(Some(&m.at));
            let (Some(sender), Some(at)) = (sender, at) else {
                continue;
            };
            if *sender == r.member_id {
                continue;
            }
            if extra_ids.contains(&r.id) && Some(sender.as_str()) != team_id {
                // another team's run, read for this team's notes only: a third team's note is not this view's
                continue;
            }
            if a.is_some_and(|a| at < a) || b.is_some_and(|b| at > b) {
                continue;
            }
            let started = parse(Some(&r.queued_at));
            if NOTE_TRIGGERS.contains(&r.trigger.as_str())
                && started.is_some_and(|s| crate::timeline::total_seconds(s, at).abs() < 2.0)
                && lower_name(&r.started_by) == lower_name(&m.peer)
            {
                // the message that started a run is counted from the run itself
                continue;
            }
            add_note(sender, &r.member_id, r.ticket_id.as_deref(), &m.text);
        }
    }

    // tickets: the ones worked, plus the parents and blockers they point at (drawn dim, for the edges)
    let mut worked: Vec<String> = Vec::new();
    for r in &runs {
        if let Some(t) = r.ticket_id.as_deref().filter(|t| !t.is_empty()) {
            if !worked.iter().any(|x| x == t) {
                worked.push(t.to_string());
            }
        }
    }
    let truncated = worked.len() > MAX_MAP_TICKETS;
    worked.truncate(MAX_MAP_TICKETS);
    let mut rows: Ordered<String, ticket::Model> = Ordered::new();
    if !worked.is_empty() {
        for t in ticket::Entity::find().filter(ticket::Column::Id.is_in(worked.clone())).all(session).await? {
            let id = t.id.clone();
            rows.put(id, t);
        }
    }
    let mut context_ids: Vec<String> = Vec::new();
    for t in rows.values() {
        let mut others: Vec<String> = Vec::new();
        if let Some(p) = &t.parent_id {
            others.push(p.clone());
        }
        others.extend(ids(Some(&t.blocked_by)));
        for other in others {
            if !other.is_empty() && !rows.map.contains_key(&other) && !context_ids.contains(&other) {
                context_ids.push(other);
            }
        }
    }
    if !context_ids.is_empty() {
        for t in ticket::Entity::find().filter(ticket::Column::Id.is_in(context_ids)).all(session).await? {
            if t.project_id == project_id {
                let id = t.id.clone();
                rows.put(id, t);
            }
        }
    }
    let edge_ids: HashSet<&String> = rows.map.keys().collect();

    let mut live_by_ticket: HashMap<String, &'static str> = HashMap::new();
    for r in &runs {
        let Some(t) = r.ticket_id.as_deref().filter(|t| !t.is_empty()) else {
            continue;
        };
        if ACTIVE.contains(&r.state.as_str()) && live_by_ticket.get(t) != Some(&"waiting") {
            live_by_ticket.insert(t.to_string(), if r.state == "needs_input" { "waiting" } else { "working" });
        }
    }
    let mut teams_of: HashMap<String, Vec<String>> = HashMap::new();
    for ((tid, ticket), _) in takes.iter() {
        teams_of.entry(ticket.clone()).or_default().push(tid.clone());
    }

    let tickets: Vec<Value> = rows
        .values()
        .map(|t| {
            let mut blocked: Vec<String> = Vec::new();
            for x in ids(Some(&t.blocked_by)) {
                if edge_ids.contains(&x) && x != t.id && !blocked.contains(&x) {
                    blocked.push(x);
                }
            }
            json!({
                "id": t.id,
                "title": t.title,
                "status": t.status,
                "type": t.r#type,
                "parent_id": t.parent_id.as_ref().filter(|p| edge_ids.contains(p)),
                "blocked_by": blocked,
                "context": !worked.contains(&t.id),
                "live": live_by_ticket.get(&t.id),
                "teams": teams_of.get(&t.id).cloned().unwrap_or_default(),
            })
        })
        .collect();

    // a team's state is about everything it does now, not only the runs of the scope
    let live_rows = ai_run::Entity::find()
        .filter(ai_run::Column::ProjectId.eq(project_id))
        .filter(ai_run::Column::Kind.eq("team"))
        .filter(ai_run::Column::State.is_in(ACTIVE))
        .all(session)
        .await?;
    let mut live_now: HashMap<&str, Vec<&ai_run::Model>> = HashMap::new();
    for r in &live_rows {
        live_now.entry(r.member_id.as_str()).or_default().push(r);
    }
    let note_ends: HashSet<&String> = notes.keys.iter().flat_map(|(x, y)| [x, y]).collect();
    let mut team_nodes: Vec<Value> = Vec::new();
    for tid in &teams.order {
        let (Some(m), Some(tm)) = (teams.member(tid), teams.team(tid)) else {
            continue;
        };
        if team_id.is_some_and(|t| tid != t) && !note_ends.contains(tid) {
            continue;
        }
        let mine: Vec<&ai_run::Model> = runs.iter().filter(|r| r.member_id == *tid).collect();
        let distinct: HashSet<&str> = mine.iter().filter_map(|r| r.ticket_id.as_deref()).filter(|t| !t.is_empty()).collect();
        let mut role_list: Vec<(&String, &i64)> = roles.get(tid).map(|o| o.iter().collect()).unwrap_or_default();
        role_list.sort_by_key(|(_, n)| -**n);
        team_nodes.push(json!({
            "id": tid,
            "name": m.name,
            "color": m.color,
            "state": team_state(tm, live_now.get(tid.as_str()).map(Vec::as_slice).unwrap_or(&[]), held),
            "runs": mine.len(),
            "tickets": distinct.len(),
            "roles": role_list.iter().map(|(role, n)| json!({
                "id": format!("{tid}:{role}"),
                "name": role_label(role),
                "color": role_color(role),
                "calls": n,
            })).collect::<Vec<_>>(),
        }));
    }

    let mut edges: Vec<Value> = Vec::new();
    for ((tid, ticket), e) in takes.iter() {
        if edge_ids.contains(ticket) {
            edges.push(json!({
                "id": format!("take:{tid}:{ticket}"),
                "kind": "take",
                "from": tid,
                "to": ticket,
                "count": e.count,
                "live": e.live,
                "waiting": e.waiting,
                "tickets": [ticket],
            }));
        }
    }
    for ((frm, to), e) in notes.iter() {
        edges.push(json!({
            "id": format!("note:{frm}:{to}"),
            "kind": "note",
            "from": frm,
            "to": to,
            "count": e.count,
            "tickets": e.tickets,
            "label": e.text,
            "live": false,
        }));
    }
    for (tid, e) in asks.iter() {
        edges.push(json!({
            "id": format!("ask:{tid}"),
            "kind": "ask",
            "from": tid,
            "to": "you",
            "count": e.asked,
            "tickets": e.tickets,
            "label": e.text,
            "live": e.open > 0,
        }));
        if e.answered > 0 {
            edges.push(json!({
                "id": format!("answer:{tid}"),
                "kind": "answer",
                "from": "you",
                "to": tid,
                "count": e.answered,
                "tickets": e.tickets,
                "live": false,
            }));
        }
    }
    for t in &tickets {
        let id = t["id"].as_str().unwrap_or("");
        if let Some(parent) = t["parent_id"].as_str() {
            edges.push(json!({
                "id": format!("child:{parent}:{id}"),
                "kind": "child",
                "from": parent,
                "to": id,
                "count": 1,
                "tickets": [id],
                "live": false,
            }));
        }
        for blocker in t["blocked_by"].as_array().map(Vec::as_slice).unwrap_or(&[]) {
            let blocker = blocker.as_str().unwrap_or("");
            edges.push(json!({
                "id": format!("blocked:{blocker}:{id}"),
                "kind": "blocked",
                "from": blocker,
                "to": id,
                "count": 1,
                "tickets": [id],
                "live": false,
            }));
        }
    }

    let open_questions: i64 = asks.values().map(|e| e.open).sum();
    Ok(json!({
        "range": range_key,
        "since": a.map(|a| crate::timeline::iso(&a)),
        "until": b.map(|b| crate::timeline::iso(&b)),
        "now": crate::timeline::iso(&now),
        "scope": {"ticket_id": opts.ticket_id, "team_id": opts.team_id},
        "paused_all": held,
        "you": {
            "asked": asks.values().map(|e| e.asked).sum::<i64>(),
            "waiting": open_questions,
        },
        "teams": team_nodes,
        "tickets": tickets,
        "edges": edges,
        "runs": runs.len(),
        "truncated": truncated,
        // the newest runs only were read: an old range or "all time" may be missing the oldest ones
        "runs_truncated": candidates.len() as u64 >= MAX_RUNS,
        "all_teams": teams.order.len(),
    }))
}

struct PerTicket {
    at: String,
    live: bool,
    waiting: bool,
    teams: Vec<String>,
}

/// What the scope picker offers: the teams, the Stories with AI work and the tickets the teams worked (newest
/// first), each with whether a run is live now.
pub async fn flow_scopes(session: &Session, project_id: &str) -> Result<Value, DbErr> {
    let teams: Teams = load_teams(session, project_id).await?;
    let recent = ai_run::Entity::find()
        .filter(ai_run::Column::ProjectId.eq(project_id))
        .filter(ai_run::Column::Kind.eq("team"))
        .order_by_desc(ai_run::Column::QueuedAt)
        .limit(MAX_RUNS)
        .all(session)
        .await?;
    let mut per_team: HashMap<&str, (i64, bool)> = teams.order.iter().map(|t| (t.as_str(), (0, false))).collect();
    let mut per_ticket: Ordered<String, PerTicket> = Ordered::new();
    for r in &recent {
        if let Some(e) = per_team.get_mut(r.member_id.as_str()) {
            e.0 += 1;
            e.1 = e.1 || ACTIVE.contains(&r.state.as_str());
        }
        if let Some(t) = r.ticket_id.as_deref().filter(|t| !t.is_empty()) {
            let e = per_ticket
                .entry(t.to_string(), || PerTicket { at: r.queued_at.clone(), live: false, waiting: false, teams: Vec::new() });
            e.live = e.live || ACTIVE.contains(&r.state.as_str());
            e.waiting = e.waiting || r.state == "needs_input";
            if !e.teams.contains(&r.member_id) {
                e.teams.push(r.member_id.clone());
            }
        }
    }
    let ids: Vec<String> = per_ticket.keys.iter().take(MAX_PICKER_TICKETS).cloned().collect();
    let mut tickets: Ordered<String, ticket::Model> = Ordered::new();
    if !ids.is_empty() {
        for t in ticket::Entity::find().filter(ticket::Column::Id.is_in(ids.clone())).all(session).await? {
            let id = t.id.clone();
            tickets.put(id, t);
        }
    }
    // a Story is listed when it is a Story with a worked child, or was worked itself
    let mut parents: Vec<String> = Vec::new();
    for t in tickets.values() {
        if let Some(p) = t.parent_id.as_deref().filter(|p| !p.is_empty()) {
            if !parents.iter().any(|x| x == p) {
                parents.push(p.to_string());
            }
        }
    }
    let mut stories: Ordered<String, ticket::Model> = Ordered::new();
    if !parents.is_empty() {
        for t in ticket::Entity::find()
            .filter(ticket::Column::Id.is_in(parents))
            .filter(ticket::Column::Type.eq("story"))
            .all(session)
            .await?
        {
            let id = t.id.clone();
            stories.put(id, t);
        }
    }
    for (i, t) in tickets.iter() {
        if t.r#type == "story" {
            stories.put(i.clone(), t.clone());
        }
    }
    let mut children: HashMap<String, Vec<String>> = HashMap::new();
    for t in tickets.values() {
        if let Some(p) = t.parent_id.as_ref().filter(|p| stories.map.contains_key(*p) && **p != t.id) {
            children.entry(p.clone()).or_default().push(t.id.clone());
        }
    }
    let story_row = |s: &ticket::Model| -> Value {
        let kids: Vec<String> = children.get(&s.id).cloned().unwrap_or_default();
        let mine: Vec<&String> = std::iter::once(&s.id).chain(kids.iter()).collect();
        json!({
            "id": s.id,
            "title": s.title,
            "status": s.status,
            "tickets": kids.len(),
            "done": kids.iter().filter(|k| tickets.map.get(*k).is_some_and(|t| t.status == "done")).count(),
            "live": mine.iter().any(|i| per_ticket.map.get(*i).is_some_and(|e| e.live)),
            "waiting": mine.iter().any(|i| per_ticket.map.get(*i).is_some_and(|e| e.waiting)),
        })
    };
    let mut story_rows: Vec<Value> = stories.values().map(story_row).collect();
    // `sorted(key=lambda x: (not x["live"], x["id"]))`: live first, then by id
    story_rows.sort_by(|x, y| {
        let live = |v: &Value| !v["live"].as_bool().unwrap_or(false);
        live(x).cmp(&live(y)).then_with(|| x["id"].as_str().unwrap_or("").cmp(y["id"].as_str().unwrap_or("")))
    });
    Ok(json!({
        "teams": teams.order.iter().filter_map(|tid| {
            let m = teams.member(tid)?;
            let (runs, live) = per_team.get(tid.as_str()).copied().unwrap_or((0, false));
            Some(json!({"id": tid, "name": m.name, "color": m.color, "runs": runs, "live": live}))
        }).collect::<Vec<_>>(),
        "stories": story_rows,
        "tickets": ids.iter().filter_map(|i| tickets.map.get(i)).filter(|t| t.r#type != "story").filter_map(|t| {
            let e = per_ticket.map.get(&t.id)?;
            Some(json!({
                "id": t.id,
                "title": t.title,
                "status": t.status,
                "type": t.r#type,
                "story_id": t.parent_id.as_ref().filter(|p| stories.map.contains_key(*p)),
                "live": e.live,
                "waiting": e.waiting,
                "at": e.at,
                "teams": e.teams,
            }))
        }).collect::<Vec<_>>(),
    }))
}
