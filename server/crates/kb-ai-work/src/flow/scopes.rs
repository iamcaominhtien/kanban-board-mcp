//! The scope picker of the Map: `flow_scopes` (`flow.py`'s `flow_scopes`).

use std::collections::HashMap;

use kb_db::Session;
use kb_db::entities::{ai_run, ticket};
use kb_db::sea_orm::{ColumnTrait, DbErr, EntityTrait, QueryFilter, QueryOrder, QuerySelect};
use serde_json::{Value, json};

use super::{MAX_PICKER_TICKETS, Ordered};
use crate::timeline::{ACTIVE, MAX_RUNS, Teams, load_teams};

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
            let e = per_ticket.entry(t.to_string(), || PerTicket {
                at: r.queued_at.clone(),
                live: false,
                waiting: false,
                teams: Vec::new(),
            });
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
