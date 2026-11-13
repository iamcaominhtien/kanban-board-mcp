//! `services/idea_space.py`, lines 93-293: listing ideas, the counts and what a person sorted this week.

use std::cmp::Ordering;

use chrono::{Duration, Utc};
use kb_base::{pyjson, pytext};
use kb_db::Session;
use kb_db::entities::idea_ticket;
use kb_db::sea_orm::{ColumnTrait, QueryFilter};
use serde_json::{Map, Value, json};

use super::{ACTIVE_STAGES, get, neg};
use crate::error::{Error, value_error};
use crate::idea_tickets::{select_ideas, wake_parked_ideas};
use crate::model::{IDEA_STAGES, Idea, idea_readiness, load_many};

/// How many days back "You sorted 7 ideas this week" looks (`SORTED_DAYS`).
pub const SORTED_DAYS: i64 = 7;

/// `_rank(idea)`: the sort key of "Readiness": the ideas closest to ready first, then the most recently touched.
fn rank(idea: &Idea) -> (i64, f64, Vec<i64>) {
    let r = idea_readiness(idea.assumptions());
    let order = match r["state"].as_str() {
        Some("ready") => 0,
        Some("growing") => 1,
        Some("at_risk") => 2,
        _ => 3,
    };
    let total = r["total"].as_f64().unwrap_or(0.0);
    let tested = if total != 0.0 { r["validated"].as_f64().unwrap_or(0.0) / total } else { 0.0 };
    (order, -tested, neg(&idea.row.updated_at))
}

/// The tags of an idea as text (`[str(t) for t in _json(idea.tags, [])]`). A column that holds `null` (a tags update
/// that sent null stores it) is not iterable: Python's `TypeError`, a 500.
fn tags_of(idea: &Idea) -> Result<Vec<String>, Error> {
    if idea.row.tags.is_empty() {
        return Ok(Vec::new());
    }
    match serde_json::from_str::<Value>(&idea.row.tags) {
        // JSON that does not parse is the fallback `[]`
        Err(_) => Ok(Vec::new()),
        Ok(_) => Ok(crate::idea_tickets::iterate_json(&idea.row.tags)?.iter().map(pyjson::py_str).collect()),
    }
}

/// `_matches_text(idea, q)`: every word of `q` is somewhere in the idea's text.
fn matches_text(idea: &Idea, q: &str) -> Result<bool, Error> {
    let needle = pytext::strip(q).to_lowercase();
    let assumptions: Vec<&str> = idea.assumptions().map(|a| a.text.as_str()).collect();
    let tags = tags_of(idea)?.join(" ");
    let hay = [
        idea.row.id.as_str(),
        idea.row.title.as_str(),
        idea.row.description.as_str(),
        idea.row.body.as_str(),
        idea.row.problem_statement.as_deref().unwrap_or(""),
        tags.as_str(),
        &assumptions.join(" "),
    ]
    .join(" ")
    .to_lowercase();
    Ok(pytext::split(&needle).into_iter().all(|word| hay.contains(word)))
}

/// What `list_ideas` filters and sorts by, with the Python defaults.
#[derive(Debug, Clone)]
pub struct ListFilter<'a> {
    /// The project to look at when `scope` is "project".
    pub project_id: Option<&'a str>,
    /// "project" (one project), "all" (every idea) or "none" (ideas with no project).
    pub scope: &'a str,
    /// Only ideas in these stages.
    pub stages: &'a [String],
    /// Only Exploring, Ready and Building ideas (the "Active" filter).
    pub active: bool,
    /// Words that all have to appear in the title, text, tags or an assumption.
    pub q: Option<&'a str>,
    /// Only ideas from this source.
    pub source: Option<&'a str>,
    /// Only ideas with this tag.
    pub tag: Option<&'a str>,
    /// readiness (default), updated, created, votes or title.
    pub sort: &'a str,
}

impl Default for ListFilter<'_> {
    fn default() -> Self {
        Self {
            project_id: None,
            scope: "project",
            stages: &[],
            active: false,
            q: None,
            source: None,
            tag: None,
            sort: "readiness",
        }
    }
}

/// List ideas for the Idea Space views. Parked ideas whose date has come are returned to the Inbox first.
pub async fn list_ideas(session: &Session, filter: &ListFilter<'_>) -> Result<Vec<Idea>, Error> {
    if !["project", "all", "none"].contains(&filter.scope) {
        return value_error("scope must be project, all or none");
    }
    let project_id = filter.project_id.filter(|p| !p.is_empty());
    if filter.scope == "project" && project_id.is_none() {
        return value_error("project_id is required when scope is project");
    }
    wake_parked_ideas(session, if filter.scope == "project" { filter.project_id } else { None }).await?;
    let mut stmt = select_ideas(session);
    if filter.scope == "project" {
        stmt = stmt.filter(idea_ticket::Column::ProjectId.eq(filter.project_id.unwrap_or("")));
    } else if filter.scope == "none" {
        stmt = stmt.filter(idea_ticket::Column::ProjectId.is_null());
    }
    for stage in filter.stages {
        if !IDEA_STAGES.contains(&stage.as_str()) {
            return value_error(format!("Unknown stage '{stage}'"));
        }
    }
    if !filter.stages.is_empty() {
        stmt = stmt.filter(idea_ticket::Column::Stage.is_in(filter.stages.iter().cloned()));
    }
    if filter.active {
        stmt = stmt.filter(idea_ticket::Column::Stage.is_in(ACTIVE_STAGES));
    }
    if let Some(source) = filter.source.filter(|s| !s.is_empty()) {
        stmt = stmt.filter(idea_ticket::Column::Source.eq(source));
    }
    let mut ideas = load_many(session, stmt.all(session).await?).await?;
    if let Some(tag) = filter.tag.filter(|t| !t.is_empty()) {
        let mut kept = Vec::new();
        for idea in ideas {
            if tags_of(&idea)?.iter().any(|t| t == tag) {
                kept.push(idea);
            }
        }
        ideas = kept;
    }
    if let Some(q) = filter.q.filter(|q| !pytext::strip(q).is_empty()) {
        let mut kept = Vec::new();
        for idea in ideas {
            if matches_text(&idea, q)? {
                kept.push(idea);
            }
        }
        ideas = kept;
    }
    match filter.sort {
        "readiness" => ideas.sort_by(|a, b| {
            let (ka, kb) = (rank(a), rank(b));
            ka.0.cmp(&kb.0).then(ka.1.partial_cmp(&kb.1).unwrap_or(Ordering::Equal)).then(ka.2.cmp(&kb.2))
        }),
        "updated" => ideas.sort_by_key(|i| neg(&i.row.updated_at)),
        "created" => ideas.sort_by_key(|i| neg(&i.row.created_at)),
        "votes" => ideas.sort_by_key(|i| -(i.vote_records.len() as i64)),
        "title" => ideas.sort_by_key(|i| i.row.title.to_lowercase()),
        _ => return value_error("sort must be one of: readiness, updated, created, votes, title"),
    }
    Ok(ideas)
}

/// An empty `bucket()`: `{stages: {stage: 0}, active: 0, total: 0}`.
fn bucket() -> Map<String, Value> {
    let mut stages = Map::new();
    for stage in IDEA_STAGES {
        stages.insert(stage.to_string(), json!(0));
    }
    let mut out = Map::new();
    out.insert("stages".into(), Value::Object(stages));
    out.insert("active".into(), json!(0));
    out.insert("total".into(), json!(0));
    out
}

/// `b[key] += 1` of a counter in a bucket.
fn bump(target: &mut Map<String, Value>, key: &str) {
    let n = target.get(key).and_then(Value::as_i64).unwrap_or(0);
    target.insert(key.to_string(), json!(n + 1));
}

/// Counts for the project switcher, the stage filters and the sidebar badge.
///
/// Returns `{all: {...}, none: {...}, projects: [{project_id, ...}], total_inbox}` (the inbox of all projects, for
/// the sidebar badge), where each `{...}` is `{stages, active, total (not archived)}`.
pub async fn counts(session: &Session) -> Result<Map<String, Value>, Error> {
    wake_parked_ideas(session, None).await?;
    let ideas = select_ideas(session).all(session).await?;

    let mut all = bucket();
    let mut none = bucket();
    let mut projects: Vec<(String, Map<String, Value>)> = Vec::new();
    for idea in &ideas {
        let mut targets: Vec<&mut Map<String, Value>> = vec![&mut all];
        match &idea.project_id {
            None => targets.push(&mut none),
            Some(project_id) => {
                let at = match projects.iter().position(|(id, _)| id == project_id) {
                    Some(at) => at,
                    None => {
                        let mut entry = Map::new();
                        entry.insert("project_id".into(), json!(project_id));
                        entry.extend(bucket());
                        projects.push((project_id.clone(), entry));
                        projects.len() - 1
                    }
                };
                targets.push(&mut projects[at].1);
            }
        }
        for b in targets {
            if let Some(Value::Object(stages)) = b.get_mut("stages") {
                bump(stages, &idea.stage);
            }
            if ACTIVE_STAGES.contains(&idea.stage.as_str()) {
                bump(b, "active");
            }
            if idea.stage != "archived" {
                bump(b, "total");
            }
        }
    }
    let total_inbox = all["stages"]["inbox"].clone();
    let mut result = Map::new();
    result.insert("all".into(), Value::Object(all));
    result.insert("none".into(), Value::Object(none));
    result.insert("projects".into(), Value::Array(projects.into_iter().map(|(_, p)| Value::Object(p)).collect()));
    result.insert("total_inbox".into(), total_inbox);
    Ok(result)
}

/// What a decision on an Inbox idea is called in "You sorted 7 ideas this week: 3 kept, ..." (ICT-9)
fn sorted_as_name(stage: &str) -> Option<&'static str> {
    match stage {
        "exploring" => Some("kept"),
        "parked" => Some("parked"),
        "archived" => Some("archived"),
        _ => None,
    }
}

/// `str(value)` of `meta.get("to")`.
fn text_of(value: &Value) -> String {
    pyjson::py_str(value)
}

/// How this person last sorted this idea out of the Inbox since `since`: kept, parked, merged, archived, or None
/// (not sorted by them, or the move was undone). Read from the activity the moves already write.
fn sorted_as(idea: &idea_ticket::Model, person: Option<&str>, since: &str) -> Option<&'static str> {
    let mut out: Option<&'static str> = None;
    let empty = Value::Object(Map::new());
    for e in crate::idea_tickets::safe_json(&idea.activity_trail) {
        if !e.is_object() {
            continue;
        }
        let at = get(&e, "at").as_str().unwrap_or("");
        if at < since {
            continue;
        }
        let meta = if get(&e, "meta").is_object() { get(&e, "meta") } else { &empty };
        let kind = get(&e, "kind").as_str();
        let label = match get(&e, "label") {
            Value::Null => String::new(),
            other if !pyjson::truthy(other) => String::new(),
            other => text_of(other),
        };
        let undo = pyjson::truthy(get(meta, "undo")) || label.ends_with(" undone");
        let undone_stage = kind == Some("stage") && undo && get(meta, "to").as_str() == Some("inbox");
        let undone_merge = kind == Some("merge") && undo && pyjson::truthy(get(meta, "target"));
        if undone_stage || undone_merge {
            out = None;
        } else if get(&e, "author").as_str() != person {
            continue;
        } else if kind == Some("stage") && !undo && get(meta, "from").as_str() == Some("inbox") {
            out = sorted_as_name(&text_of(get(meta, "to")));
        } else if kind == Some("merge")
            && pyjson::truthy(get(meta, "target"))
            && get(meta, "from").as_str() == Some("inbox")
        {
            out = Some("merged");
        }
    }
    out
}

/// How many Inbox ideas this person sorted in the last 7 days, by decision (the empty Triage inbox, ICT-9).
///
/// Returns `{total, kept, parked, merged, archived, days}`.
pub async fn sorted_this_week(
    session: &Session,
    person: Option<&str>,
    scope: &str,
    project_id: Option<&str>,
) -> Result<Map<String, Value>, Error> {
    let mut stmt = select_ideas(session);
    if scope == "project" {
        stmt = match project_id {
            Some(project_id) => stmt.filter(idea_ticket::Column::ProjectId.eq(project_id)),
            None => stmt.filter(idea_ticket::Column::ProjectId.is_null()),
        };
    } else if scope == "none" {
        stmt = stmt.filter(idea_ticket::Column::ProjectId.is_null());
    }
    let since = kb_base::time::iso(&(Utc::now() - Duration::days(SORTED_DAYS)));
    let mut kept = 0;
    let mut parked = 0;
    let mut merged = 0;
    let mut archived = 0;
    for idea in stmt.all(session).await? {
        match sorted_as(&idea, person, &since) {
            Some("kept") => kept += 1,
            Some("parked") => parked += 1,
            Some("merged") => merged += 1,
            Some("archived") => archived += 1,
            _ => {}
        }
    }
    let mut out = Map::new();
    out.insert("total".into(), json!(kept + parked + merged + archived));
    out.insert("kept".into(), json!(kept));
    out.insert("parked".into(), json!(parked));
    out.insert("merged".into(), json!(merged));
    out.insert("archived".into(), json!(archived));
    out.insert("days".into(), json!(SORTED_DAYS));
    Ok(out)
}
