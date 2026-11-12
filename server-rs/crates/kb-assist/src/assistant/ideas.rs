//! The AI helpers of the Idea Space on the assistant engine (AI v2): triage advice, Shape with AI, Ask, Prepare a
//! ticket and the grooming digest. Each is one turn with a skill; the ideas are given to the skill (the board's tools
//! do not read ideas). Nothing is applied for the person: the results come back as suggestions
//! (`services/assistant/ideas.py`, lines 1 to 555).

use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::sync::{LazyLock, Mutex, MutexGuard};

use chrono::Utc;
use kb_ai::store::loads;
use kb_base::{ctx, pyjson, pytext, time};
use kb_db::Session;
use kb_db::entities::{ai_usage, idea_advice, idea_ai_settings, idea_assumption, idea_digest, idea_ticket, project};
use kb_db::sea_orm::ActiveValue::Set;
use kb_db::sea_orm::sea_query::{Expr, Func, SimpleExpr};
use kb_db::sea_orm::{
    ActiveModelTrait, ColumnTrait, DbErr, EntityTrait, IntoActiveModel, ModelTrait, QueryFilter, QueryOrder,
    QuerySelect,
};
use serde_json::{Map, Value, json};
use tokio::task::AbortHandle;

use super::engine::{self, Turn, TurnOpts};
use super::errors::{AssistError, Error as AssistFailure};
use super::sessions;
use super::settings::round_to;

/// The feature the Idea Space's turns are metered as.
pub const FEATURE: &str = "ideas";
/// The stages an idea has left (it is not open any more).
pub const OPEN_STAGES_OFF: [&str; 3] = ["archived", "shipped", "merged"];
/// The switches of a project's ideas.
pub const SETTING_KEYS: [&str; 7] =
    ["enabled", "triage_advice", "weekly_grooming", "ask", "read_docs", "read_repo", "daily_cap"];
/// The kinds of help Shape gives.
pub const SHAPE_KINDS: [&str; 6] = ["problem", "assumptions", "tests", "effort", "exists", "ask"];

/// `SHAPES`: the task of each shape request that can be stopped.
static SHAPES: LazyLock<Mutex<HashMap<String, AbortHandle>>> = LazyLock::new(|| Mutex::new(HashMap::new()));

fn shapes() -> MutexGuard<'static, HashMap<String, AbortHandle>> {
    SHAPES.lock().unwrap_or_else(|e| e.into_inner())
}

/// The Idea Space's AI cannot help now: `off`, `no_member`, `unavailable`, `cap`, `failed`, `bad_answer`, `stopped`,
/// `not_found`. (`IdeaAiError` is an `AssistError`: `to_assist` gives the one the API maps.)
#[derive(Debug, Clone, PartialEq, thiserror::Error)]
#[error("{message}")]
pub struct IdeaAiError {
    /// Why the AI cannot help.
    pub code: String,
    /// What the person reads.
    pub message: String,
}

impl IdeaAiError {
    /// `IdeaAiError(code, message)`.
    pub fn new(code: &str, message: impl Into<String>) -> Self {
        Self { code: code.to_string(), message: message.into() }
    }

    /// The same error as an `AssistError` (what `except AssistError` catches).
    pub fn to_assist(&self) -> AssistError {
        AssistError::new(&self.code, self.message.clone())
    }
}

/// What a function of the Idea Space's AI fails with.
#[derive(Debug, thiserror::Error)]
pub enum Error {
    /// `IdeaAiError`.
    #[error(transparent)]
    Idea(#[from] IdeaAiError),
    /// `AssistError` from the engine (Claude Code is not there, the project is gone).
    #[error(transparent)]
    Assist(#[from] AssistError),
    /// `ValueError` (the API answers 400 with the text).
    #[error("{0}")]
    Value(String),
    /// The database call failed.
    #[error(transparent)]
    Db(#[from] DbErr),
    /// Any other exception: a 500.
    #[error("{0}")]
    Other(String),
}

impl From<AssistFailure> for Error {
    fn from(err: AssistFailure) -> Self {
        match err {
            AssistFailure::Assist(err) => Error::Assist(err),
            AssistFailure::Db(err) => Error::Db(err),
            AssistFailure::Value(message) => Error::Value(message),
            AssistFailure::Other(message) => Error::Other(message),
        }
    }
}

/// The AI switches of a project's ideas (created with defaults on first use).
pub async fn get_settings(session: &Session, project_id: Option<&str>) -> Result<idea_ai_settings::Model, DbErr> {
    let key = project_id.unwrap_or("");
    if let Some(row) = idea_ai_settings::Entity::find_by_id(key).one(session).await? {
        return Ok(row);
    }
    let mut row = idea_ai_settings::new();
    row.project_id = Set(key.to_string());
    let row = row.insert(session).await?;
    session.commit().await?;
    Ok(row)
}

/// The switches as the API shows them.
pub fn settings_out(row: &idea_ai_settings::Model) -> Map<String, Value> {
    let mut out = Map::new();
    out.insert("enabled".into(), json!(row.enabled));
    out.insert("triage_advice".into(), json!(row.triage_advice));
    out.insert("weekly_grooming".into(), json!(row.weekly_grooming));
    out.insert("ask".into(), json!(row.ask));
    out.insert("read_docs".into(), json!(row.read_docs));
    out.insert("read_repo".into(), json!(row.read_repo));
    out.insert("daily_cap".into(), json!(row.daily_cap));
    out
}

/// Change the AI switches; values left out stay as they are.
pub async fn update_settings(
    session: &Session,
    project_id: Option<&str>,
    values: &Map<String, Value>,
) -> Result<idea_ai_settings::Model, DbErr> {
    let row = get_settings(session, project_id).await?;
    let mut changed = kb_db::edit(row);
    for (k, v) in values {
        if !SETTING_KEYS.contains(&k.as_str()) || v.is_null() {
            continue;
        }
        let on = pyjson::truthy(v);
        match k.as_str() {
            "enabled" => changed.enabled = Set(on),
            "triage_advice" => changed.triage_advice = Set(on),
            "weekly_grooming" => changed.weekly_grooming = Set(on),
            "ask" => changed.ask = Set(on),
            "read_docs" => changed.read_docs = Set(on),
            "read_repo" => changed.read_repo = Set(on),
            _ => {
                if let Some(cap) = v.as_f64() {
                    changed.daily_cap = Set(cap);
                }
            }
        }
    }
    changed.updated_at = Set(time::now_iso());
    let row = changed.update(session).await?;
    session.commit().await?;
    Ok(row)
}

/// What the Idea Space's AI helpers cost today.
pub async fn spent_today(session: &Session) -> Result<f64, DbErr> {
    let midnight = Utc::now().date_naive().and_hms_opt(0, 0, 0).map(|t| t.and_utc());
    let start = midnight.map_or_else(time::now_iso, |m| time::iso(&m));
    let sum: Expr = Func::sum(Expr::col(ai_usage::Column::Cost)).into();
    let total: SimpleExpr = Func::coalesce([sum, Expr::val(0.0)]).into();
    let value: Option<f64> = ai_usage::Entity::find()
        .filter(ai_usage::Column::Feature.eq(FEATURE))
        .filter(ai_usage::Column::CreatedAt.gte(start))
        .select_only()
        .expr_as(total, "total")
        .into_tuple::<Option<f64>>()
        .one(session)
        .await?
        .flatten();
    Ok(round_to(value.unwrap_or(0.0), 4))
}

/// The project a turn is booked on: the idea's own, else the first project of the board.
async fn booking_project(session: &Session, project_id: Option<&str>) -> Result<Option<String>, DbErr> {
    if let Some(id) = project_id.filter(|id| !id.is_empty()) {
        return Ok(Some(id.to_string()));
    }
    let first = project::Entity::find().order_by_asc(project::Column::Name).limit(1).one(session).await?;
    Ok(first.map(|p| p.id))
}

/// Whether AI help is available for the project (or for ideas with no project), and why not.
pub async fn status(session: &Session, project_id: Option<&str>) -> Result<Map<String, Value>, Error> {
    let row = get_settings(session, project_id).await?;
    let spent = spent_today(session).await?;
    let booking = booking_project(session, project_id).await?;
    let info = match &booking {
        Some(booking) => engine::ready(booking, "chat").await?,
        None => {
            let mut map = Map::new();
            map.insert("state".into(), json!("not_configured"));
            map.insert("message".into(), json!("Create a project first."));
            map.insert("member".into(), Value::Null);
            map
        }
    };
    let (state, message) = if !row.enabled {
        ("off", "AI help is off for these ideas.".to_string())
    } else if info.get("state").and_then(Value::as_str) != Some("ready") {
        (
            "unavailable",
            info.get("message")
                .map(|m| m.as_str().map_or_else(|| pyjson::py_str(m), str::to_string))
                .unwrap_or_default(),
        )
    } else if spent >= row.daily_cap {
        ("cap", "Today's AI budget for ideas is used up. It resets tomorrow.".to_string())
    } else {
        ("on", String::new())
    };
    let mut out = Map::new();
    out.insert("state".into(), json!(state));
    out.insert("message".into(), json!(message));
    out.insert("settings".into(), Value::Object(settings_out(&row)));
    out.insert("member".into(), json!("Idea AI"));
    out.insert("spent_today".into(), json!(spent));
    out.insert("cap".into(), json!(row.daily_cap));
    out.insert("limited".into(), json!(project_id.is_none()));
    out.insert(
        "hints".into(),
        json!({"advice": 0.02, "shape": 0.03, "exists": 0.05, "grooming": 0.05, "ask": 0.03, "ticket": 0.04}),
    );
    Ok(out)
}

/// `_require`: the project to book on, or the reason AI cannot help now.
async fn require(session: &Session, project_id: Option<&str>, switch: Option<&str>) -> Result<String, Error> {
    let st = status(session, project_id).await?;
    let state = st.get("state").and_then(Value::as_str).unwrap_or("");
    if state != "on" {
        let code = match state {
            "off" => "off",
            "cap" => "cap",
            _ => "unavailable",
        };
        let message = st.get("message").and_then(Value::as_str).unwrap_or("");
        return Err(IdeaAiError::new(code, message).into());
    }
    if let Some(switch) = switch {
        let on = st.get("settings").and_then(|s| s.get(switch)).is_none_or(pyjson::truthy);
        if !on {
            return Err(IdeaAiError::new("off", "This helper is off for these ideas.").into());
        }
    }
    Ok(booking_project(session, project_id).await?.unwrap_or_default())
}

/// `text[:n]`.
fn clip(text: &str, n: usize) -> String {
    text.chars().take(n).collect()
}

/// `a or b or c or ""` of texts.
fn first_text(values: &[&str]) -> String {
    values.iter().find(|v| !v.is_empty()).map_or_else(String::new, |v| (*v).to_string())
}

/// An idea as a skill is given it: a short line, or everything with `assumptions` (the idea's assumption rows, in
/// position order: Python's `brief(i, full=True)`).
pub fn brief(i: &idea_ticket::Model, assumptions: Option<&[idea_assumption::Model]>) -> Value {
    let mut out = Map::new();
    out.insert("id".into(), json!(i.id));
    out.insert("title".into(), json!(i.title));
    out.insert("stage".into(), json!(i.stage));
    let summary = first_text(&[&i.description, i.problem_statement.as_deref().unwrap_or(""), &i.body]);
    out.insert("summary".into(), json!(clip(&summary, 300)));
    out.insert(
        "last_touched_at".into(),
        json!(i.last_touched_at.clone().filter(|t| !t.is_empty()).unwrap_or_else(|| i.updated_at.clone())),
    );
    if let Some(assumptions) = assumptions {
        out.insert("body".into(), json!(clip(&i.body, 12000)));
        out.insert("description".into(), json!(clip(&i.description, 4000)));
        out.insert("problem_statement".into(), json!(i.problem_statement));
        let tags = if i.tags.is_empty() { "[]" } else { i.tags.as_str() };
        out.insert("tags".into(), loads(Some(tags), json!([])));
        out.insert("effort_guess".into(), json!(i.effort_guess));
        out.insert(
            "assumptions".into(),
            Value::Array(
                assumptions
                    .iter()
                    .map(|a| json!({"id": a.id, "text": a.text, "impact": a.impact, "status": a.status}))
                    .collect(),
            ),
        );
    }
    Value::Object(out)
}

/// `brief(idea, full=True)`.
async fn brief_full(session: &Session, i: &idea_ticket::Model) -> Result<Value, DbErr> {
    let rows = idea_assumption::Entity::find()
        .filter(idea_assumption::Column::IdeaId.eq(i.id.as_str()))
        .order_by_asc(idea_assumption::Column::Position)
        .all(session)
        .await?;
    Ok(brief(i, Some(&rows)))
}

/// `_ideas`: the ideas still open, newest change first.
async fn ideas(
    session: &Session,
    project_id: Option<&str>,
    scope: &str,
    limit: u64,
) -> Result<Vec<idea_ticket::Model>, DbErr> {
    let mut stmt = idea_ticket::Entity::find().filter(idea_ticket::Column::Stage.is_not_in(OPEN_STAGES_OFF));
    match project_id.filter(|id| !id.is_empty()) {
        Some(id) if scope == "project" => stmt = stmt.filter(idea_ticket::Column::ProjectId.eq(id)),
        _ if scope == "none" => stmt = stmt.filter(idea_ticket::Column::ProjectId.is_null()),
        _ => {}
    }
    stmt.order_by_desc(idea_ticket::Column::UpdatedAt).limit(limit).all(session).await
}

/// `_turn`: one turn of the Idea AI, or why it failed.
async fn turn(
    project_id: &str,
    name: &str,
    skill: &str,
    inputs: Map<String, Value>,
    person: &str,
) -> Result<Turn, Error> {
    let mut opts = TurnOpts::new(name, skill, inputs, person);
    opts.feature = FEATURE;
    opts.timeout_s = 300.0;
    let out = engine::turn(project_id, opts).await?;
    if out.state == "cancelled" {
        return Err(IdeaAiError::new("stopped", "Stopped.").into());
    }
    if out.state != "finished" {
        let message = out
            .error
            .clone()
            .filter(|e| !e.is_empty())
            .unwrap_or_else(|| "The AI could not answer. Try again.".to_string());
        return Err(IdeaAiError::new("failed", message).into());
    }
    Ok(out)
}

/// `str(value)`.
fn py_text(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        other => pyjson::py_str(other),
    }
}

/// `str(value or "")`.
fn text_or_empty(value: Option<&Value>) -> String {
    value.filter(|v| pyjson::truthy(v)).map(py_text).unwrap_or_default()
}

// --------------------------------------------------------------------------- triage advice

/// Read an idea and suggest Keep, Park, Merge or Archive. Returns None when the AI is not sure.
pub async fn advise(session: &Session, idea_id: &str, person: &str) -> Result<Option<idea_advice::Model>, Error> {
    let Some(idea) = idea_ticket::Entity::find_by_id(idea_id).one(session).await? else {
        return Err(IdeaAiError::new("not_found", "Idea not found.").into());
    };
    let project_id = require(session, idea.project_id.as_deref(), Some("triage_advice")).await?;
    let others: Vec<Value> = ideas(session, idea.project_id.as_deref(), "project", 80)
        .await?
        .into_iter()
        .filter(|o| o.id != idea.id)
        .map(|o| json!({"id": o.id, "title": o.title}))
        .take(60)
        .collect();
    let stamp = idea.updated_at.clone();
    let mut inputs = Map::new();
    inputs.insert("idea".into(), brief_full(session, &idea).await?);
    inputs.insert("others".into(), Value::Array(others.clone()));
    let out = turn(&project_id, &sessions::idea_name(&idea.id), "idea-triage", inputs, person).await?;
    let data = out.data();
    let mut action = data.get("action").and_then(Value::as_str).unwrap_or("").to_string();
    if !matches!(action.as_str(), "keep" | "park" | "merge" | "archive" | "none") {
        return Err(IdeaAiError::new("bad_answer", "The AI gave an answer that could not be used.").into());
    }
    let known: HashSet<&str> = others.iter().filter_map(|o| o["id"].as_str()).collect();
    if action == "merge" && !data.get("target_id").and_then(Value::as_str).is_some_and(|t| known.contains(t)) {
        action = "none".to_string();
    }
    let open = idea_advice::Entity::find()
        .filter(idea_advice::Column::IdeaId.eq(idea.id.as_str()))
        .filter(idea_advice::Column::State.eq("open"))
        .all(session)
        .await?;
    for old in open {
        old.delete(session).await?;
    }
    let mut row = idea_advice::new();
    row.idea_id = Set(idea.id.clone());
    row.action = Set(action.clone());
    row.reason = Set(clip(&text_or_empty(data.get("reason")), 500));
    let confidence = data.get("confidence").and_then(Value::as_str).filter(|c| matches!(*c, "high" | "medium" | "low"));
    row.confidence = Set(confidence.unwrap_or("medium").to_string());
    row.target_id =
        Set(if action == "merge" { data.get("target_id").filter(|v| !v.is_null()).map(py_text) } else { None });
    row.archive_reason =
        Set(if action == "archive" { data.get("archive_reason").filter(|v| !v.is_null()).map(py_text) } else { None });
    let digits = text_or_empty(data.get("park_days"));
    row.park_days = Set(if action == "park" && !digits.is_empty() && digits.chars().all(|c| c.is_ascii_digit()) {
        digits.parse::<i32>().ok()
    } else {
        None
    });
    row.idea_stamp = Set(stamp);
    row.cost = Set(out.cost);
    let row = row.insert(session).await?;
    session.commit().await?;
    Ok(if action == "none" { None } else { Some(row) })
}

/// Open advice for the ideas, each marked `stale` when the idea changed after the AI read it.
pub async fn advice_for(session: &Session, idea_ids: &[String], include_none: bool) -> Result<Vec<Value>, DbErr> {
    if idea_ids.is_empty() {
        return Ok(Vec::new());
    }
    let rows = idea_advice::Entity::find()
        .filter(idea_advice::Column::IdeaId.is_in(idea_ids.to_vec()))
        .filter(idea_advice::Column::State.eq("open"))
        .order_by_asc(idea_advice::Column::CreatedAt)
        .all(session)
        .await?;
    let mut out = Vec::new();
    for a in rows {
        if a.action == "none" && !include_none {
            continue;
        }
        let idea = idea_ticket::Entity::find_by_id(a.idea_id.as_str()).one(session).await?;
        let target = match a.target_id.as_deref().filter(|t| !t.is_empty()) {
            Some(id) => idea_ticket::Entity::find_by_id(id).one(session).await?,
            None => None,
        };
        let stale = idea.as_ref().is_some_and(|i| !a.idea_stamp.is_empty() && i.updated_at != a.idea_stamp);
        out.push(json!({
            "id": a.id,
            "idea_id": a.idea_id,
            "action": a.action,
            "reason": a.reason,
            "confidence": a.confidence,
            "target_id": a.target_id,
            "target_title": target.map(|t| t.title),
            "archive_reason": a.archive_reason,
            "park_days": a.park_days,
            "cost": a.cost,
            "created_at": a.created_at,
            "stale": stale,
        }));
    }
    Ok(out)
}

/// Mark a piece of advice accepted or ignored.
pub async fn set_advice_state(session: &Session, advice_id: &str, state: &str) -> Result<idea_advice::Model, Error> {
    let Some(a) = idea_advice::Entity::find_by_id(advice_id).one(session).await? else {
        return Err(Error::Value("Advice not found".to_string()));
    };
    let mut row = kb_db::edit(a);
    row.state = Set(state.to_string());
    let row = row.update(session).await?;
    session.commit().await?;
    Ok(row)
}

// --------------------------------------------------------------------------- ask, shape, prepare a ticket

/// `data.get(key) or []` as a list.
fn list_of(data: &Map<String, Value>, key: &str) -> Vec<Value> {
    match data.get(key) {
        Some(Value::Array(items)) => items.clone(),
        _ => Vec::new(),
    }
}

/// Answer a question about the ideas in view, naming the ideas it used.
pub async fn ask(
    session: &Session,
    question: &str,
    project_id: Option<&str>,
    scope: &str,
    person: &str,
) -> Result<Map<String, Value>, Error> {
    let booking = require(session, project_id, Some("ask")).await?;
    let found = ideas(session, project_id, scope, 80).await?;
    let mut inputs = Map::new();
    inputs.insert("question".into(), json!(question));
    inputs.insert("scope".into(), json!(scope));
    inputs.insert("ideas".into(), Value::Array(found.iter().map(|i| brief(i, None)).collect()));
    let name = format!("idea-ask:{}", project_id.filter(|p| !p.is_empty()).unwrap_or("all"));
    let out = turn(&booking, &name, "idea-ask", inputs, person).await?;
    let data = out.data();
    let known: HashMap<&str, &str> = found.iter().map(|i| (i.id.as_str(), i.title.as_str())).collect();
    let mut actions = Vec::new();
    for a in list_of(&data, "actions") {
        let ids: Vec<&str> = match a.as_object() {
            Some(map) => match map.get("idea_ids") {
                Some(Value::Array(items)) => {
                    items.iter().filter_map(Value::as_str).filter(|x| known.contains_key(x)).collect()
                }
                _ => Vec::new(),
            },
            None => Vec::new(),
        };
        if let Some(first) = ids.first() {
            actions.push(json!({
                "kind": "open_idea",
                "idea_id": first,
                "idea_title": known[first],
                "title": a.get("label").cloned().unwrap_or(Value::Null),
            }));
        }
    }
    let mut sources = Vec::new();
    for s in list_of(&data, "sources") {
        let Some(id) = s.get("id").and_then(Value::as_str).filter(|id| known.contains_key(id)) else { continue };
        let title = s.get("title").filter(|t| pyjson::truthy(t)).cloned().unwrap_or_else(|| json!(known[id]));
        sources.push(json!({"id": id, "title": title}));
    }
    actions.truncate(3);
    let mut result = Map::new();
    result.insert(
        "answer".into(),
        data.get("answer").filter(|v| pyjson::truthy(v)).cloned().unwrap_or_else(|| json!(out.text)),
    );
    result.insert("sources".into(), Value::Array(sources));
    result.insert("actions".into(), Value::Array(actions));
    result.insert("ideas_read".into(), json!(found.len()));
    result.insert("member".into(), json!(out.member));
    result.insert("cost".into(), json!(out.cost));
    Ok(result)
}

/// The keys of what a kind of help keeps.
fn kept_keys(kind: &str) -> &'static [&'static str] {
    match kind {
        "problem" => &["problem", "idea"],
        "assumptions" => &["assumptions"],
        "tests" => &["tests"],
        "effort" => &["effort", "why", "files"],
        "exists" => &["summary", "items", "found"],
        _ => &["answer"],
    }
}

/// Draft the problem, assumptions, cheapest tests, an effort guess, what already exists, or an answer.
pub async fn shape(
    session: &Session,
    idea_id: &str,
    kind: &str,
    question: Option<&str>,
    person: &str,
) -> Result<Map<String, Value>, Error> {
    if !SHAPE_KINDS.contains(&kind) {
        return Err(Error::Value("Unknown kind of help".to_string()));
    }
    if kind == "ask" && pytext::strip(question.unwrap_or("")).is_empty() {
        return Err(Error::Value("Write a question first".to_string()));
    }
    let Some(idea) = idea_ticket::Entity::find_by_id(idea_id).one(session).await? else {
        return Err(IdeaAiError::new("not_found", "Idea not found.").into());
    };
    let project_id = require(session, idea.project_id.as_deref(), None).await?;
    let mut inputs = Map::new();
    inputs.insert("kind".into(), json!(kind));
    inputs.insert("question".into(), json!(question));
    inputs.insert("idea".into(), brief_full(session, &idea).await?);
    let out = turn(&project_id, &sessions::idea_name(&idea.id), "idea-shape", inputs, person).await?;
    let mut data = out.data();
    if data.is_empty() {
        if kind != "ask" || out.text.is_empty() {
            return Err(IdeaAiError::new("bad_answer", "The AI gave an answer that could not be used.").into());
        }
        data.insert("answer".into(), json!(out.text));
    }
    let mut result = Map::new();
    for key in kept_keys(kind) {
        if let Some(value) = data.get(*key) {
            result.insert((*key).to_string(), value.clone());
        }
    }
    if kind == "exists" {
        let found = result.shift_remove("found").filter(pyjson::truthy);
        let source = match found {
            Some(Value::Array(items)) => items,
            Some(_) => Vec::new(),
            None => match result.get("items") {
                Some(Value::Array(items)) => items.clone(),
                _ => Vec::new(),
            },
        };
        let kept: Vec<Value> = source.into_iter().filter(Value::is_object).collect();
        result.insert("items".into(), Value::Array(kept));
    }
    let mut out_map = Map::new();
    out_map.insert("kind".into(), json!(kind));
    out_map.insert("ai".into(), json!(true));
    out_map.insert("member".into(), json!(out.member));
    out_map.insert("member_id".into(), json!(""));
    out_map.insert("cost".into(), json!(out.cost));
    out_map.insert("model".into(), json!(out.model));
    out_map.extend(result);
    Ok(out_map)
}

/// Run a shape request so `stop_shape(request_id)` can end it.
pub async fn run_stoppable<T, F>(request_id: Option<&str>, fut: F) -> Result<T, Error>
where
    T: Send + 'static,
    F: Future<Output = Result<T, Error>> + Send + 'static,
{
    let Some(request_id) = request_id.filter(|r| !r.is_empty()) else { return fut.await };
    let task = ctx::spawn(fut);
    shapes().insert(request_id.to_string(), task.abort_handle());
    let joined = task.await;
    shapes().remove(request_id);
    match joined {
        Ok(result) => result,
        Err(err) if err.is_cancelled() => Err(IdeaAiError::new("stopped", "Stopped.").into()),
        Err(err) => Err(Error::Other(format!("RuntimeError: {err}"))),
    }
}

/// Stop a running shape request. False when it had already ended.
pub fn stop_shape(request_id: &str) -> bool {
    let handle = shapes().get(request_id).cloned();
    match handle {
        Some(handle) if !handle.is_finished() => {
            handle.abort();
            true
        }
        _ => false,
    }
}

/// Draft the ticket text, acceptance criteria and a split for the Promote dialog.
pub async fn prepare_ticket(session: &Session, idea_id: &str, person: &str) -> Result<Map<String, Value>, Error> {
    let Some(idea) = idea_ticket::Entity::find_by_id(idea_id).one(session).await? else {
        return Err(IdeaAiError::new("not_found", "Idea not found.").into());
    };
    let project_id = require(session, idea.project_id.as_deref(), None).await?;
    let mut inputs = Map::new();
    inputs.insert("idea".into(), brief_full(session, &idea).await?);
    let out = turn(&project_id, &sessions::idea_name(&idea.id), "idea-prepare-ticket", inputs, person).await?;
    let data = out.data();
    if !data.get("title").is_some_and(pyjson::truthy) {
        return Err(IdeaAiError::new("bad_answer", "The AI gave an answer that could not be used.").into());
    }
    let texts = |key: &str| -> Value { Value::Array(list_of(&data, key).iter().map(|x| json!(py_text(x))).collect()) };
    let mut result = Map::new();
    result.insert("title".into(), json!(clip(&py_text(&data["title"]), 200)));
    result.insert(
        "description".into(),
        data.get("description").filter(|v| pyjson::truthy(v)).cloned().unwrap_or_else(|| json!("")),
    );
    result.insert("acceptance_criteria".into(), texts("acceptance_criteria"));
    result.insert("sub_tickets".into(), texts("sub_tickets"));
    result.insert("member".into(), json!(out.member));
    result.insert("cost".into(), json!(out.cost));
    Ok(result)
}

// --------------------------------------------------------------------------- the grooming digest

/// A digest as the API shows it.
pub fn digest_out(d: &idea_digest::Model) -> Map<String, Value> {
    let mut out = Map::new();
    out.insert("id".into(), json!(d.id));
    out.insert("project_id".into(), if d.project_id.is_empty() { Value::Null } else { json!(d.project_id) });
    out.insert("text".into(), json!(d.text));
    out.insert("items".into(), loads(Some(if d.items.is_empty() { "[]" } else { d.items.as_str() }), json!([])));
    out.insert("ai".into(), json!(d.ai));
    out.insert("cost".into(), json!(d.cost));
    out.insert("ideas_read".into(), json!(d.ideas_read));
    out.insert("created_at".into(), json!(d.created_at));
    out
}

/// The newest grooming digest of a project (or of the ideas with no project).
pub async fn latest_digest(session: &Session, project_id: Option<&str>) -> Result<Option<idea_digest::Model>, DbErr> {
    idea_digest::Entity::find()
        .filter(idea_digest::Column::ProjectId.eq(project_id.unwrap_or("")))
        .order_by_desc(idea_digest::Column::CreatedAt)
        .limit(1)
        .one(session)
        .await
}

/// Write the digest now.
pub async fn groom(session: &Session, project_id: Option<&str>, person: &str) -> Result<idea_digest::Model, Error> {
    let booking = require(session, project_id, Some("weekly_grooming")).await?;
    let project = project_id.filter(|p| !p.is_empty());
    let found = ideas(session, project_id, if project.is_some() { "project" } else { "none" }, 80).await?;
    let mut inputs = Map::new();
    inputs.insert("project_id".into(), json!(project_id));
    inputs.insert("ideas".into(), Value::Array(found.iter().map(|i| brief(i, None)).collect()));
    let name = format!("idea-digest:{}", project.unwrap_or("all"));
    let out = turn(&booking, &name, "idea-digest", inputs, person).await?;
    let data = out.data();
    let known: HashSet<&str> = found.iter().map(|i| i.id.as_str()).collect();
    let mut digest_items = Vec::new();
    for x in list_of(&data, "items") {
        let Some(x) = x.as_object() else { continue };
        let kind = x.get("kind").filter(|v| pyjson::truthy(v)).map_or_else(|| "note".to_string(), py_text);
        let idea_ids: Vec<Value> = match x.get("idea_ids") {
            Some(Value::Array(ids)) => {
                ids.iter().filter(|i| i.as_str().is_some_and(|i| known.contains(i))).cloned().collect()
            }
            _ => Vec::new(),
        };
        digest_items.push(json!({"kind": kind, "idea_ids": idea_ids, "text": text_or_empty(x.get("text"))}));
    }
    let mut row = idea_digest::new();
    row.project_id = Set(project_id.unwrap_or("").to_string());
    row.text = Set(data.get("text").filter(|v| pyjson::truthy(v)).map_or_else(|| out.text.clone(), py_text));
    row.items = Set(pyjson::dumps(&digest_items));
    row.ai = Set(true);
    row.cost = Set(out.cost);
    row.ideas_read = Set(i32::try_from(found.len()).unwrap_or(i32::MAX));
    let row = row.insert(session).await?;
    session.commit().await?;
    Ok(row)
}
