//! `services/idea_tickets.py`: creating, reading, updating and deleting ideas, the legacy status the Idea board still
//! drives, and assumptions and comments ("microthoughts") as the old routes use them.

use kb_base::{pyjson, pytext, time};
use kb_db::Session;
use kb_db::entities::{idea_assumption, idea_comment, idea_counter, idea_ticket, project, ticket};
use kb_db::sea_orm::sea_query::{Expr, ExprTrait};
use kb_db::sea_orm::{ActiveModelTrait, ColumnTrait, EntityTrait, ModelTrait, QueryFilter, QueryOrder, Select};
use kb_db::sql::bump_counter;
use serde_json::{Map, Value, json};

use crate::error::{Error, value_error};
use crate::model::{ASSUMPTION_IMPACTS, ASSUMPTION_STATUSES, IDEA_SOURCES, IDEA_STATUSES, Idea, load, load_many};
use kb_db::save_model;

/// Who an activity entry is credited to when the caller does not say.
pub const DEFAULT_AUTHOR: &str = "user";

/// `_safe_json(value)`: the list a JSON column holds; `[]` for an empty column or JSON that does not parse.
pub(crate) fn safe_json(value: &str) -> Vec<Value> {
    if value.is_empty() {
        return Vec::new();
    }
    match serde_json::from_str::<Value>(value) {
        Ok(Value::Array(items)) => items,
        _ => Vec::new(),
    }
}

/// `for t in json.loads(text)`: what iterating the value of a JSON column gives: the items of a list, the keys of an
/// object, the characters of a string. Anything else (`null`, a number) is Python's `TypeError`, a 500.
pub(crate) fn iterate_json(text: &str) -> Result<Vec<Value>, Error> {
    match serde_json::from_str::<Value>(text) {
        Ok(Value::Array(items)) => Ok(items),
        Ok(Value::Object(map)) => Ok(map.keys().map(|k| Value::String(k.clone())).collect()),
        Ok(Value::String(text)) => Ok(text.chars().map(|c| Value::String(c.to_string())).collect()),
        Ok(other) => Err(Error::Other(format!("TypeError: '{}' object is not iterable", py_type_name(&other)))),
        Err(err) => Err(Error::Value(err.to_string())),
    }
}

/// The Python type name of a JSON value.
fn py_type_name(value: &Value) -> &'static str {
    match value {
        Value::Null => "NoneType",
        Value::Bool(_) => "bool",
        Value::Number(n) if n.is_f64() => "float",
        Value::Number(_) => "int",
        Value::String(_) => "str",
        Value::Array(_) => "list",
        Value::Object(_) => "dict",
    }
}

/// `_dumps(value)`: `json.dumps(value)`, the bytes a JSON column stores.
pub(crate) fn dumps(value: &[Value]) -> String {
    pyjson::dumps(&value)
}

/// `_now_iso()`.
pub(crate) fn now_iso() -> String {
    time::now_iso()
}

/// `_clamp(value, lo, hi)` with the defaults 1 and 5.
fn clamp(value: i64) -> i64 {
    value.clamp(1, 5)
}

/// `select(IdeaTicket)`: without an order of its own the rows come in the order SQLite stores them (insertion); the
/// other engines have no such order, so they get the creation order.
pub(crate) fn select_ideas(session: &Session) -> Select<idea_ticket::Entity> {
    let stmt = idea_ticket::Entity::find();
    if session.dialect() == "sqlite" {
        stmt
    } else {
        stmt.order_by_asc(idea_ticket::Column::CreatedAt).order_by_asc(idea_ticket::Column::Id)
    }
}

/// `_get_idea_ticket_or_raise`: the idea with its records.
pub(crate) async fn get_idea_ticket_or_raise(session: &Session, ticket_id: &str) -> Result<Idea, Error> {
    match idea_ticket::Entity::find_by_id(ticket_id).one(session).await? {
        Some(row) => Ok(load(session, row).await?),
        None => value_error(format!("Idea ticket '{ticket_id}' not found")),
    }
}

/// `_reload`: read the idea again, with its assumptions, evidence and votes as they are now. Where the row is gone
/// Python raises `NoResultFound`, a 500.
pub async fn reload(session: &Session, ticket_id: &str) -> Result<Idea, Error> {
    match idea_ticket::Entity::find_by_id(ticket_id).one(session).await? {
        Some(row) => Ok(load(session, row).await?),
        None => Err(Error::Other("No row was found when one was required".to_string())),
    }
}

/// `session.add(idea)` and `await session.commit()` of an idea whose row was changed, then `_reload`.
pub(crate) async fn commit_and_reload(session: &Session, idea: &Idea) -> Result<Idea, Error> {
    save_model(session, &idea.loaded, idea.row.clone()).await?;
    session.commit().await?;
    reload(session, &idea.row.id).await
}

/// Append an activity entry: what happened, when, who did it, and what kind of change it was.
///
/// `label` is one line for the activity list. `author` is a person's name, or an AI member's name when `ai` is set.
/// `kind` is stage, assumption, evidence, page, project, link, merge, log, vote, ai or created (used to filter).
/// `meta` holds details for the entry (ids, from/to values, a short text diff). `ai`: the change was made by an AI
/// member.
pub fn add_trail(
    ticket: &mut idea_ticket::Model,
    label: &str,
    now: &str,
    author: Option<&str>,
    kind: Option<&str>,
    meta: Option<Map<String, Value>>,
    ai: bool,
) {
    let mut trail = safe_json(&ticket.activity_trail);
    let mut entry = Map::new();
    entry.insert("id".into(), json!(time::uuid4()));
    entry.insert("label".into(), json!(label));
    entry.insert("at".into(), json!(now));
    entry.insert("author".into(), json!(author));
    if let Some(kind) = kind.filter(|k| !k.is_empty()) {
        entry.insert("kind".into(), json!(kind));
    }
    if let Some(meta) = meta.filter(|m| !m.is_empty()) {
        entry.insert("meta".into(), Value::Object(meta));
    }
    if ai {
        entry.insert("ai".into(), json!(true));
    }
    trail.push(Value::Object(entry));
    ticket.activity_trail = dumps(&trail);
}

/// `_trail_entry_and_save`: an activity entry (credited to the default author) and the idea saved.
async fn trail_entry_and_save(session: &Session, mut idea: Idea, label: &str, now: &str) -> Result<Idea, Error> {
    add_trail(&mut idea.row, label, now, Some(DEFAULT_AUTHOR), None, None, false);
    idea.row.last_touched_at = Some(now.to_string());
    idea.row.updated_at = now.to_string();
    commit_and_reload(session, &idea).await
}

/// `_validate_idea_emoji(value)`.
fn validate_idea_emoji(value: &str) -> Result<String, Error> {
    if pytext::strip(value).is_empty() {
        return value_error("idea_emoji cannot be empty");
    }
    if value.chars().count() > 8 {
        return value_error("idea_emoji must be a single emoji character");
    }
    Ok(value.to_string())
}

/// `_page_body(problem, description)`: the idea page, the Problem heading, then the description.
pub(crate) fn page_body(problem: Option<&str>, description: &str) -> String {
    let mut parts: Vec<String> = Vec::new();
    if let Some(problem) = problem.filter(|p| !pytext::strip(p).is_empty()) {
        parts.push(format!("## Problem\n\n{}", pytext::strip(problem)));
    }
    if !pytext::strip(description).is_empty() {
        parts.push(pytext::strip(description).to_string());
    }
    parts.join("\n\n")
}

/// `_next_idea_id(session)`: `IDEA-n` from the one counter row.
async fn next_idea_id(session: &Session) -> Result<String, Error> {
    let mut row = bump_counter(session, "idea_counter", "counter", "id", 1i32.into(), &[]).await?;
    if row.is_none() {
        // The one counter row is made by a migration; a database made from the models (PostgreSQL, MySQL, a test)
        // starts without it
        let mut counter = idea_counter::new();
        counter.id = kb_db::sea_orm::ActiveValue::Set(1);
        counter.counter = kb_db::sea_orm::ActiveValue::Set(0);
        counter.insert(session).await?;
        row = bump_counter(session, "idea_counter", "counter", "id", 1i32.into(), &[]).await?;
    }
    let Some(row) = row else {
        return Err(Error::Other("the idea counter row is missing".to_string()));
    };
    let counter: i32 = row.try_get_by_index(0)?;
    Ok(format!("IDEA-{counter}"))
}

/// The arguments of `create_idea_ticket` after the session and the project, with the Python defaults.
#[derive(Debug, Clone)]
pub struct NewIdea<'a> {
    /// Idea title.
    pub title: &'a str,
    /// Markdown description.
    pub description: &'a str,
    /// Card color from the allowed palette.
    pub idea_color: &'a str,
    /// Emoji shown on the card.
    pub idea_emoji: &'a str,
    /// Optional effort/energy level.
    pub idea_energy: Option<&'a str>,
    /// Tag names.
    pub tags: Option<&'a [Value]>,
    /// The problem the idea solves; required before promotion.
    pub problem_statement: Option<&'a str>,
    /// Where the idea came from, one of `IDEA_SOURCES`.
    pub source: &'a str,
    /// Who is credited for creating it in the activity.
    pub author: Option<&'a str>,
    /// Details of the source: `{kind, id, label, quote, url, by, why}`.
    pub source_ref: Option<&'a Map<String, Value>>,
}

impl<'a> NewIdea<'a> {
    /// A manual idea of the default color and emoji, with nothing else set.
    pub fn new(title: &'a str) -> Self {
        Self {
            title,
            description: "",
            idea_color: "yellow",
            idea_emoji: "💡",
            idea_energy: None,
            tags: None,
            problem_statement: None,
            source: "manual",
            author: Some(DEFAULT_AUTHOR),
            source_ref: None,
        }
    }
}

/// Create an idea ticket with the next idea number.
///
/// The idea starts in the Inbox. `project_id` may be None: the idea then belongs to no project yet. Fails with
/// `ValueError` if the emoji, source or project is not valid.
pub async fn create_idea_ticket(session: &Session, project_id: Option<&str>, new: NewIdea<'_>) -> Result<Idea, Error> {
    let idea_emoji = validate_idea_emoji(new.idea_emoji)?;
    if !IDEA_SOURCES.contains(&new.source) {
        return value_error(format!("Invalid source '{}'. Must be one of: {}", new.source, IDEA_SOURCES.join(", ")));
    }
    if let Some(project_id) = project_id {
        if project::Entity::find_by_id(project_id).one(session).await?.is_none() {
            return value_error(format!("Project '{project_id}' not found"));
        }
    }

    let tags = new.tags.unwrap_or(&[]);
    let ticket_id = next_idea_id(session).await?;
    let now = now_iso();

    let mut created = Map::new();
    created.insert("id".into(), json!(time::uuid4()));
    created.insert("label".into(), json!(if new.source != "ai" { "Idea created" } else { "Idea suggested by AI" }));
    created.insert("at".into(), json!(now));
    created.insert("author".into(), json!(new.author));
    created.insert("kind".into(), json!("created"));
    if new.source == "ai" {
        created.insert("ai".into(), json!(true));
    }
    let activity_trail = vec![Value::Object(created)];

    use kb_db::sea_orm::ActiveValue::Set;
    let mut row = idea_ticket::new();
    row.id = Set(ticket_id.clone());
    row.project_id = Set(project_id.map(str::to_string));
    row.title = Set(new.title.to_string());
    row.description = Set(new.description.to_string());
    row.idea_color = Set(new.idea_color.to_string());
    row.idea_emoji = Set(idea_emoji);
    row.idea_energy = Set(new.idea_energy.map(str::to_string));
    row.tags = Set(dumps(tags));
    row.problem_statement = Set(new.problem_statement.map(str::to_string));
    row.stage = Set("inbox".to_string());
    row.source = Set(new.source.to_string());
    row.source_ref = Set(pyjson::dumps(&new.source_ref.cloned().unwrap_or_default()));
    row.created_by = Set(new.author.map(str::to_string));
    row.stage_changed_at = Set(Some(now.clone()));
    row.body = Set(page_body(new.problem_statement, new.description));
    row.last_touched_at = Set(Some(now.clone()));
    row.activity_trail = Set(dumps(&activity_trail));
    row.created_at = Set(now.clone());
    row.updated_at = Set(now);
    row.insert(session).await?;
    session.commit().await?;
    reload(session, &ticket_id).await
}

/// Return Parked ideas whose park-until date has come to the Inbox, once.
///
/// `project_id`: only look at this project's ideas; None looks at all of them. Returns how many ideas were woken.
pub async fn wake_parked_ideas(session: &Session, project_id: Option<&str>) -> Result<usize, Error> {
    let today = chrono::Utc::now().date_naive().format("%Y-%m-%d").to_string();
    let mut stmt = select_ideas(session)
        .filter(idea_ticket::Column::Stage.eq("parked"))
        .filter(idea_ticket::Column::ParkUntil.is_not_null())
        .filter(idea_ticket::Column::ParkUntil.lte(today));
    if let Some(project_id) = project_id {
        stmt = stmt.filter(idea_ticket::Column::ProjectId.eq(project_id));
    }
    let woken = stmt.all(session).await?;
    if woken.is_empty() {
        return Ok(0);
    }
    let now = now_iso();
    let count = woken.len();
    for idea in woken {
        let mut changed = idea.clone();
        changed.stage = "inbox".to_string();
        changed.park_until = None;
        changed.updated_at = now.clone();
        add_trail(
            &mut changed,
            "Back in the Inbox: the park-until date has come",
            &now,
            Some("system"),
            None,
            None,
            false,
        );
        save_model(session, &idea, changed).await?;
    }
    session.commit().await?;
    Ok(count)
}

/// Return an idea ticket by id, or None. A Parked idea whose date has come is woken first.
pub async fn get_idea_ticket(session: &Session, ticket_id: &str) -> Result<Option<Idea>, Error> {
    let Some(row) = idea_ticket::Entity::find_by_id(ticket_id).one(session).await? else {
        return Ok(None);
    };
    if row.stage == "parked" && wake_parked_ideas(session, row.project_id.as_deref()).await? > 0 {
        return Ok(Some(reload(session, ticket_id).await?));
    }
    Ok(Some(load(session, row).await?))
}

/// List a project's idea tickets. `idea_status`: only ideas in this status. `q`: case-insensitive text matched
/// against title and description.
pub async fn list_idea_tickets(
    session: &Session,
    project_id: &str,
    idea_status: Option<&str>,
    q: Option<&str>,
) -> Result<Vec<Idea>, Error> {
    wake_parked_ideas(session, Some(project_id)).await?;
    let mut stmt = idea_ticket::Entity::find().filter(idea_ticket::Column::ProjectId.eq(project_id));
    if let Some(idea_status) = idea_status {
        stmt = stmt.filter(idea_ticket::Column::IdeaStatus.eq(idea_status));
    }
    if let Some(q) = q {
        let escaped = q.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_");
        let pattern = format!("%{escaped}%");
        stmt = stmt.filter(
            Expr::cust_with_values("lower(idea_ticket.title) LIKE lower(?) ESCAPE '\\'", [pattern.clone()])
                .or(Expr::cust_with_values("lower(idea_ticket.description) LIKE lower(?) ESCAPE '\\'", [pattern])),
        );
    }
    let rows = stmt.order_by_desc(idea_ticket::Column::LastTouchedAt).all(session).await?;
    Ok(load_many(session, rows).await?)
}

/// The fields `update_idea_ticket` changes (`_UPDATABLE_FIELDS`), in the order of the request model.
pub const UPDATABLE_FIELDS: [&str; 11] = [
    "title",
    "description",
    "idea_color",
    "idea_emoji",
    "idea_energy",
    "tags",
    "problem_statement",
    "ice_impact",
    "ice_effort",
    "ice_confidence",
    "revisit_date",
];

/// A text value of an update: the text, or None for a null.
fn text_of(value: &Value) -> Option<String> {
    value.as_str().map(str::to_string)
}

/// Apply field updates and log them; return None if the ticket is missing.
///
/// `fields` holds the fields that were sent (`model_dump(exclude_unset=True)`), a null included.
pub async fn update_idea_ticket(
    session: &Session,
    ticket_id: &str,
    author: Option<&str>,
    fields: &Map<String, Value>,
) -> Result<Option<Idea>, Error> {
    let Some(row) = idea_ticket::Entity::find_by_id(ticket_id).one(session).await? else {
        return Ok(None);
    };
    let mut idea = load(session, row).await?;

    let now = now_iso();
    let mut changed_field_names: Vec<&str> = Vec::new();
    // a null in a column that cannot hold one is what the database refuses when Python commits (a 500)
    let mut not_null: Option<&str> = None;

    for (field, value) in fields {
        if !UPDATABLE_FIELDS.contains(&field.as_str()) {
            continue;
        }
        let row = &mut idea.row;
        let changed = match field.as_str() {
            "title" => match text_of(value) {
                Some(new) => replace(&mut row.title, new),
                None => {
                    not_null = Some("title");
                    true
                }
            },
            "description" => match text_of(value) {
                Some(new) => replace(&mut row.description, new),
                None => {
                    not_null = Some("description");
                    true
                }
            },
            "idea_color" => match text_of(value) {
                Some(new) => replace(&mut row.idea_color, new),
                None => {
                    not_null = Some("idea_color");
                    true
                }
            },
            "idea_emoji" => match value.as_str() {
                // `_SKIP`
                None => continue,
                Some(emoji) => replace(&mut row.idea_emoji, validate_idea_emoji(emoji)?),
            },
            "idea_energy" => replace_opt(&mut row.idea_energy, text_of(value)),
            "tags" => replace(&mut row.tags, pyjson::dumps(value)),
            "problem_statement" => replace_opt(&mut row.problem_statement, text_of(value)),
            "ice_impact" | "ice_effort" | "ice_confidence" => {
                // `_clamp(int(value))`: `int(None)` is a TypeError, a 500
                let Some(number) = value.as_i64() else {
                    return Err(Error::Other(
                        "int() argument must be a string, a bytes-like object or a real number, not 'NoneType'"
                            .to_string(),
                    ));
                };
                let new = clamp(number) as i32;
                match field.as_str() {
                    "ice_impact" => replace(&mut row.ice_impact, new),
                    "ice_effort" => replace(&mut row.ice_effort, new),
                    _ => replace(&mut row.ice_confidence, new),
                }
            }
            "revisit_date" => replace_opt(&mut row.revisit_date, text_of(value)),
            _ => continue,
        };
        if changed {
            changed_field_names.push(UPDATABLE_FIELDS.iter().find(|f| **f == field.as_str()).copied().unwrap_or(""));
        }
    }

    if changed_field_names.iter().any(|f| *f == "description" || *f == "problem_statement") {
        idea.row.body = page_body(idea.row.problem_statement.as_deref(), &idea.row.description);
    }
    if !changed_field_names.is_empty() {
        let label = format!("Fields updated: {}", changed_field_names.join(", "));
        add_trail(&mut idea.row, &label, &now, author, None, None, false);
        idea.row.updated_at = now.clone();
    }

    idea.row.last_touched_at = Some(now);
    if let Some(column) = not_null {
        return Err(Error::Other(format!("NOT NULL constraint failed: idea_ticket.{column}")));
    }
    Ok(Some(commit_and_reload(session, &idea).await?))
}

/// `if old_value == new_value: continue; setattr(...)`: true when the value changed.
fn replace<T: PartialEq>(slot: &mut T, new: T) -> bool {
    if *slot == new {
        return false;
    }
    *slot = new;
    true
}

/// `replace` for a nullable column.
fn replace_opt(slot: &mut Option<String>, new: Option<String>) -> bool {
    replace(slot, new)
}

/// Delete an idea ticket; return False if it does not exist.
pub async fn delete_idea_ticket(session: &Session, ticket_id: &str) -> Result<bool, Error> {
    if idea_ticket::Entity::find_by_id(ticket_id).one(session).await?.is_none() {
        return Ok(false);
    }
    // delete what is stored, not what was cached
    let idea = reload(session, ticket_id).await?;
    delete_with_records(session, &idea).await?;
    session.commit().await?;
    kb_board::workspace::remove_ticket_workspace(session, ticket_id).await;
    Ok(true)
}

/// `session.delete(idea)`: the idea owns its assumptions (and their evidence), votes, comments and log entries
/// (`cascade="all, delete-orphan"`), so they go with it, children first.
async fn delete_with_records(session: &Session, idea: &Idea) -> Result<(), Error> {
    for a in &idea.assumption_records {
        for e in &a.evidence {
            e.clone().delete(session).await?;
        }
        a.row.clone().delete(session).await?;
    }
    for v in &idea.vote_records {
        v.clone().delete(session).await?;
    }
    for c in &idea.comment_records {
        c.clone().delete(session).await?;
    }
    for entry in &idea.log_records {
        entry.clone().delete(session).await?;
    }
    idea.row.clone().delete(session).await?;
    Ok(())
}

/// The legacy status moves the Idea board may make (`ALLOWED_TRANSITIONS`).
fn allowed_transitions(status: &str) -> &'static [&'static str] {
    match status {
        "draft" => &["in_review", "dropped"],
        "in_review" => &["approved", "draft", "dropped"],
        "approved" => &["dropped"],
        "dropped" => &["draft"],
        _ => &[],
    }
}

/// The stage an idea moves to when the current Idea board changes its status (`_STAGE_FOR_STATUS`).
fn stage_for_status(status: &str) -> &'static str {
    match status {
        "draft" | "in_review" => "exploring",
        "approved" => "ready",
        _ => "archived",
    }
}

/// Move an idea to a new status, recording the reason.
///
/// Fails with `ValueError` if the idea does not exist, the status is invalid, the transition is not allowed, or the
/// idea is Building and so cannot be dropped.
pub async fn update_idea_status(
    session: &Session,
    ticket_id: &str,
    new_status: &str,
    reason: Option<&str>,
    author: Option<&str>,
) -> Result<Idea, Error> {
    let Some(row) = idea_ticket::Entity::find_by_id(ticket_id).one(session).await? else {
        return value_error(format!("Idea ticket '{ticket_id}' not found"));
    };
    let mut idea = load(session, row).await?;
    if !IDEA_STATUSES.contains(&new_status) {
        return value_error(format!("Invalid status '{new_status}'. Must be one of: {}", IDEA_STATUSES.join(", ")));
    }
    let old_status = idea.row.idea_status.clone();
    if !allowed_transitions(&old_status).contains(&new_status) {
        return value_error(format!("Cannot transition from {old_status} to {new_status}"));
    }

    if new_status == "dropped" && idea.row.stage == "building" {
        return value_error("Not allowed while the ticket is open. Close or remove the ticket first.");
    }

    let now = now_iso();
    let reason = reason.filter(|r| !r.is_empty());
    idea.row.idea_status = new_status.to_string();
    idea.row.stage = stage_for_status(new_status).to_string();
    idea.row.park_until = None;
    idea.row.archive_reason =
        if new_status == "dropped" { Some(reason.unwrap_or("Dropped").to_string()) } else { None };
    idea.row.updated_at = now.clone();
    idea.row.last_touched_at = Some(now.clone());

    let mut label = format!("Status changed: {old_status} → {new_status}");
    if let Some(reason) = reason {
        label.push_str(&format!(" ({reason})"));
    }
    add_trail(&mut idea.row, &label, &now, author, None, None, false);

    commit_and_reload(session, &idea).await
}

/// The statuses the current Idea board sends: "invalidated" is now called "disproved" (`_LEGACY_ASSUMPTION_STATUSES`).
fn legacy_assumption_status(status: &str) -> &str {
    if status == "invalidated" { "disproved" } else { status }
}

/// `_VALID_ASSUMPTION_STATUSES`, sorted as the error message lists them.
fn valid_assumption_statuses() -> Vec<&'static str> {
    let mut all: Vec<&'static str> = ASSUMPTION_STATUSES.to_vec();
    all.push("invalidated");
    all.sort_unstable();
    all
}

/// Which assumption an activity entry is about (IP-8, IW-4): its id and its text as it read then. Entries written
/// before this have no meta and stay as they are. `extra` goes after the two keys.
pub fn assumption_meta(assumption: &idea_assumption::Model, extra: &[(&str, &str)]) -> Map<String, Value> {
    let mut meta = Map::new();
    meta.insert("assumption".into(), json!(assumption.id));
    meta.insert("assumption_text".into(), json!(assumption.text.chars().take(200).collect::<String>()));
    for (key, value) in extra {
        meta.insert((*key).to_string(), json!(value));
    }
    meta
}

/// `_save_assumption_change`: the activity entry of an assumption change, and the idea saved.
async fn save_assumption_change(
    session: &Session,
    mut idea: Idea,
    label: &str,
    author: Option<&str>,
    meta: Option<Map<String, Value>>,
) -> Result<Idea, Error> {
    let now = now_iso();
    add_trail(&mut idea.row, label, &now, author, Some("assumption"), meta, false);
    idea.row.last_touched_at = Some(now.clone());
    idea.row.updated_at = now;
    commit_and_reload(session, &idea).await
}

/// `_find_assumption(ticket, assumption_id)`.
pub(crate) fn find_assumption<'a>(
    idea: &'a Idea,
    assumption_id: &str,
) -> Result<&'a crate::model::AssumptionRecord, Error> {
    match idea.assumption_records.iter().find(|a| a.row.id == assumption_id) {
        Some(found) => Ok(found),
        None => value_error(format!("Assumption '{assumption_id}' not found")),
    }
}

/// Append an assumption (max 500 characters).
///
/// `impact`: how much the idea depends on it: low, medium or high. `ai`: added from the AI chat, it keeps the purple
/// AI chip until a person edits it. Fails with `ValueError` if the text is empty or too long, or the impact is not
/// valid.
pub async fn add_assumption(
    session: &Session,
    ticket_id: &str,
    text: &str,
    impact: &str,
    author: Option<&str>,
    ai: bool,
) -> Result<Idea, Error> {
    let text = pytext::strip(text);
    if text.is_empty() {
        return value_error("text cannot be empty");
    }
    if text.chars().count() > 500 {
        return value_error("text must be 500 characters or fewer");
    }
    if !ASSUMPTION_IMPACTS.contains(&impact) {
        return value_error(format!("Invalid impact '{impact}'. Must be one of: {}", ASSUMPTION_IMPACTS.join(", ")));
    }
    let idea = get_idea_ticket_or_raise(session, ticket_id).await?;
    let now = now_iso();
    use kb_db::sea_orm::ActiveValue::Set;
    let mut added = idea_assumption::new();
    added.idea_id = Set(idea.row.id.clone());
    added.position = Set(idea.assumption_records.len() as i32);
    added.text = Set(text.to_string());
    added.impact = Set(impact.to_string());
    added.ai = Set(ai);
    added.created_at = Set(now.clone());
    added.updated_at = Set(now);
    let added = added.insert(session).await?;
    let label = format!("Assumption added{}", if ai { " from the AI chat" } else { "" });
    save_assumption_change(session, idea, &label, author, Some(assumption_meta(&added, &[]))).await
}

/// Set the status of an assumption.
///
/// `status`: untested, testing, validated or disproved ("invalidated" is accepted for disproved). Fails with
/// `ValueError` if the status is invalid or the assumption does not exist.
pub async fn update_assumption_status(
    session: &Session,
    ticket_id: &str,
    assumption_id: &str,
    status: &str,
    author: Option<&str>,
) -> Result<Idea, Error> {
    let valid = valid_assumption_statuses();
    if !valid.contains(&status) {
        return value_error(format!("Invalid status '{status}'. Must be one of: {}", valid.join(", ")));
    }
    let status = legacy_assumption_status(status);
    let idea = get_idea_ticket_or_raise(session, ticket_id).await?;
    let found = find_assumption(&idea, assumption_id)?;
    let before = found.row.status.clone();
    let mut assumption = found.row.clone();
    assumption.status = status.to_string();
    assumption.updated_at = now_iso();
    let assumption = save_model(session, &found.row, assumption).await?;
    let label = format!("Assumption marked as {status}");
    let meta = assumption_meta(&assumption, &[("from", before.as_str()), ("to", status)]);
    save_assumption_change(session, idea, &label, author, Some(meta)).await
}

/// What `update_assumption` does with the test ticket: `_SKIP` leaves it, `Set(None)` removes the link.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TestTicket<'a> {
    /// The argument was left out.
    Skip,
    /// A ticket that tests the assumption; None removes the link.
    Set(Option<&'a str>),
}

/// Change an assumption's text, impact or test ticket; omitted values stay as they are.
///
/// `text`: new text (max 500 characters). `impact`: new impact: low, medium or high. `test_ticket_id`: a ticket that
/// tests the assumption. Fails with `ValueError` if a value is invalid, or the assumption or test ticket does not
/// exist.
pub async fn update_assumption(
    session: &Session,
    ticket_id: &str,
    assumption_id: &str,
    text: Option<&str>,
    impact: Option<&str>,
    test_ticket_id: TestTicket<'_>,
    author: Option<&str>,
) -> Result<Idea, Error> {
    let idea = get_idea_ticket_or_raise(session, ticket_id).await?;
    let found = find_assumption(&idea, assumption_id)?;
    let mut assumption = found.row.clone();
    if let Some(text) = text {
        let text = pytext::strip(text);
        if text.is_empty() || text.chars().count() > 500 {
            return value_error("text must be 1 to 500 characters");
        }
        assumption.text = text.to_string();
        // a person edited it: it is theirs now
        assumption.ai = false;
    }
    if let Some(impact) = impact {
        if !ASSUMPTION_IMPACTS.contains(&impact) {
            return value_error(format!(
                "Invalid impact '{impact}'. Must be one of: {}",
                ASSUMPTION_IMPACTS.join(", ")
            ));
        }
        assumption.impact = impact.to_string();
    }
    if let TestTicket::Set(test_ticket_id) = test_ticket_id {
        if let Some(id) = test_ticket_id {
            if ticket::Entity::find_by_id(id).one(session).await?.is_none() {
                return value_error(format!("Ticket '{id}' not found"));
            }
        }
        assumption.test_ticket_id = test_ticket_id.map(str::to_string);
    }
    assumption.updated_at = now_iso();
    let assumption = save_model(session, &found.row, assumption).await?;
    save_assumption_change(session, idea, "Assumption edited", author, Some(assumption_meta(&assumption, &[]))).await
}

/// Remove an assumption. Fails with `ValueError` if it does not exist.
pub async fn delete_assumption(
    session: &Session,
    ticket_id: &str,
    assumption_id: &str,
    author: Option<&str>,
) -> Result<Idea, Error> {
    let idea = get_idea_ticket_or_raise(session, ticket_id).await?;
    let found = find_assumption(&idea, assumption_id)?;
    let gone = assumption_meta(&found.row, &[]);
    // the idea owns it: this deletes the row (and its evidence)
    for e in &found.evidence {
        e.clone().delete(session).await?;
    }
    found.row.clone().delete(session).await?;
    let remaining = idea.assumption_records.iter().filter(|a| a.row.id != assumption_id);
    for (position, record) in remaining.enumerate() {
        if record.row.position != position as i32 {
            let mut moved = record.row.clone();
            moved.position = position as i32;
            save_model(session, &record.row, moved).await?;
        }
    }
    save_assumption_change(session, idea, "Assumption deleted", author, Some(gone)).await
}

/// Add a comment to the idea (the old "microthought"; max 500 characters).
pub async fn add_microthought(
    session: &Session,
    ticket_id: &str,
    text: &str,
    author: Option<&str>,
) -> Result<Idea, Error> {
    let text = pytext::strip(text);
    if text.is_empty() {
        return value_error("text cannot be empty");
    }
    if text.chars().count() > 500 {
        return value_error("text must be 500 characters or fewer");
    }
    let idea = get_idea_ticket_or_raise(session, ticket_id).await?;
    let now = now_iso();
    use kb_db::sea_orm::ActiveValue::Set;
    let mut comment = idea_comment::new();
    comment.idea_id = Set(idea.row.id.clone());
    comment.author = Set(author.map(str::to_string));
    comment.body = Set(text.to_string());
    comment.created_at = Set(now.clone());
    comment.insert(session).await?;
    trail_entry_and_save(session, idea, "Microthought added", &now).await
}

/// Remove a comment of the idea (the old "microthought"). Fails with `ValueError` if it does not exist.
pub async fn delete_microthought(session: &Session, ticket_id: &str, microthought_id: &str) -> Result<Idea, Error> {
    let idea = get_idea_ticket_or_raise(session, ticket_id).await?;
    let Some(comment) = idea.comment_records.iter().find(|c| c.id == microthought_id) else {
        return value_error(format!("Microthought '{microthought_id}' not found"));
    };
    comment.clone().delete(session).await?;
    trail_entry_and_save(session, idea, "Microthought deleted", &now_iso()).await
}
