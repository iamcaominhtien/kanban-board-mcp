//! `services/canvas_comments.py`: comments on a canvas, pinned to a frame (the pin moves with it) or to a point of the
//! plane, in threads that can be resolved. They behave like Docs comments and belong to the canvas, so they follow it
//! when it moves to Docs.
//!
//! An AI team comments under its own name; it never resolves a person's thread.

use std::sync::OnceLock;

use kb_base::{activity, pyjson, pytext};
use kb_db::Session;
use kb_db::entities::{ai_team, canvas, canvas_comment, canvas_thread, member};
use kb_db::sea_orm::ActiveValue::Set;
use kb_db::sea_orm::{
    ActiveModelTrait, ColumnTrait, EntityTrait, IntoActiveModel, PaginatorTrait, QueryFilter, QueryOrder,
};
use kb_doctext::docs_text::DocsError;
use regex::Regex;
use serde_json::{Map, Value, json};

use crate::canvases::rows::{get_row, member_role};
use crate::canvases::{self, board_of, list, read_doc};
use crate::{Error, Result};

/// The longest comment kept, in characters.
pub const MAX_BODY: usize = 4000;
/// `docs_comments.SNIPPET`: the longest preview of a comment in a notification.
const SNIPPET: usize = 140;

/// `_body(text)`: a comment's text, stripped and cut to `MAX_BODY` characters.
///
/// Raises (422 `empty_comment`) when nothing is left.
pub fn body(text: &str) -> std::result::Result<String, DocsError> {
    let text = pytext::strip(text);
    if text.is_empty() {
        return Err(DocsError::new(422, "empty_comment", "A comment needs some text."));
    }
    Ok(text.chars().take(MAX_BODY).collect())
}

fn member_link() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"@\[([^\]\[\n]{1,200})\]\(member:([\w.-]{1,64})\)").expect("static pattern"))
}

/// `\w` of a Python `str` pattern.
pub(crate) fn is_word(c: char) -> bool {
    c.is_alphanumeric() || c == '_'
}

// --- `docs_comments.snippet_of`, copied (that module belongs to the Docs area, above this crate) --------------------

fn docs_member_link() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"@\[([^\]\n]{1,200})\]\(member:([\w-]{1,64})\)").expect("static pattern"))
}

fn image_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"!\[([^\]\n]{0,200})\]\(([^()\s]{0,500})\)").expect("static pattern"))
}

fn link_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"\[([^\]\n]{1,200})\]\(([^()\s]{0,500})\)").expect("static pattern"))
}

/// `docs_comments.plain_mentions(body)`: show `@[Name](member:id)` mentions (what the mention picker inserts) as
/// `@Name`.
pub(crate) fn plain_mentions(text: &str) -> String {
    docs_member_link().replace_all(text, |c: &regex::Captures| format!("@{}", &c[1])).into_owned()
}

/// `docs_comments.snippet_of(body)`: one-line preview of a comment for notifications: mentions as `@Name`, images and
/// diagrams as words.
pub(crate) fn snippet_of(text: &str) -> String {
    let text = plain_mentions(text);
    let text =
        image_re()
            .replace_all(&text, |c: &regex::Captures| {
                if c[2].starts_with("diagram:") { "[diagram]".to_string() } else { "[image]".to_string() }
            })
            .into_owned();
    // `(?<!!)\[...\]\(...\)`: the regex crate has no look-behind, so a match that follows a `!` is skipped and the
    // search goes on one character later, as Python's does
    let re = link_re();
    let mut out = String::new();
    let (mut last, mut pos) = (0, 0);
    while pos <= text.len() {
        let Some(c) = re.captures_at(&text, pos) else { break };
        let m = c.get(0).expect("group 0");
        if text[..m.start()].ends_with('!') {
            pos = m.start() + 1;
            continue;
        }
        out.push_str(&text[last..m.start()]);
        if c[2].starts_with("diagram:") {
            out.push_str("[diagram]");
        } else {
            out.push_str(&c[1]);
        }
        last = m.end();
        pos = m.end();
    }
    out.push_str(&text[last..]);
    pytext::squash(&out).chars().take(SNIPPET).collect()
}

/// `(?<![\w@])@NAME(?!\w)` with `re.I`: the spans of the typed mentions of `name` in `text`.
fn typed_spans(text: &str, name: &str) -> Vec<(usize, usize)> {
    let Ok(re) = Regex::new(&format!("(?i)@{}", regex::escape(name))) else { return Vec::new() };
    let mut spans = Vec::new();
    let mut pos = 0;
    while pos <= text.len() {
        let Some(m) = re.find_at(text, pos) else { break };
        let before_ok = text[..m.start()].chars().next_back().is_none_or(|c| !(is_word(c) || c == '@'));
        let after_ok = text[m.end()..].chars().next().is_none_or(|c| !is_word(c));
        if before_ok && after_ok {
            spans.push((m.start(), m.end()));
            pos = m.end().max(m.start() + 1);
        } else {
            pos = m.start() + 1;
        }
    }
    spans
}

/// The members of the canvas's project that a comment mentions: the picker's `@[Name](member:id)` and a typed `@Name`
/// both count. A picked mention is settled first and its text is taken out, so "@[Ann Lee](member:x)" does not also
/// mention a member called "Ann"; a typed name is read longest first for the same reason. Other `@words` are ignored.
pub async fn mentioned(session: &Session, canvas: &canvas::Model, text: &str) -> Result<Vec<member::Model>> {
    let Some(project_id) = canvas.project_id.as_deref().filter(|p| !p.is_empty()) else { return Ok(Vec::new()) };
    if !text.contains('@') {
        return Ok(Vec::new());
    }
    let members = member::Entity::find().filter(member::Column::ProjectId.eq(project_id)).all(session).await?;
    Ok(pick_mentions(&members, text))
}

/// The pure part of `mentioned`: which of `members` a comment's `text` mentions (see there for the rules).
pub fn pick_mentions(members: &[member::Model], text: &str) -> Vec<member::Model> {
    let mut found: Vec<member::Model> = Vec::new();
    for hit in member_link().captures_iter(text) {
        if let Some(m) = members.iter().find(|m| m.id == hit[2]) {
            if !found.iter().any(|f| f.id == m.id) {
                found.push(m.clone());
            }
        }
    }
    let mut text = member_link().replace_all(text, " ").into_owned();
    // `sorted(members, key=lambda m: -len(m.name))`: longest first, a stable sort
    let mut by_length: Vec<&member::Model> = members.iter().collect();
    by_length.sort_by_key(|m| std::cmp::Reverse(m.name.chars().count()));
    for m in by_length {
        let spans = typed_spans(&text, &m.name);
        if spans.is_empty() {
            continue;
        }
        let mut out = String::new();
        let mut last = 0;
        for (start, end) in spans {
            out.push_str(&text[last..start]);
            out.push(' ');
            last = end;
        }
        out.push_str(&text[last..]);
        text = out;
        if !found.iter().any(|f| f.id == m.id) {
            found.push(m.clone());
        }
    }
    found
}

/// Tell each person a new comment mentions (a Needs you row of kind `mention` that opens the canvas). Not the author,
/// and never an AI member. A failure here must not lose the comment or fail the request, so it is only logged.
async fn notify_mentions(
    session: &Session,
    canvas: &canvas::Model,
    thread: &canvas_thread::Model,
    comment: &canvas_comment::Model,
    mentioned: &[member::Model],
) {
    if let Err(e) = try_notify_mentions(session, canvas, thread, comment, mentioned).await {
        let _ = session.rollback().await;
        tracing::error!("Could not write a canvas mention notification: {e}");
    }
}

async fn try_notify_mentions(
    session: &Session,
    canvas: &canvas::Model,
    thread: &canvas_thread::Model,
    comment: &canvas_comment::Model,
    mentioned: &[member::Model],
) -> kb_notify::Result<()> {
    let author = comment.author.as_str();
    let people: Vec<&member::Model> = mentioned
        .iter()
        .filter(|m| {
            !matches!(m.kind.as_str(), "ai" | "ai_removed")
                && kb_notify::person_key(Some(&m.name)) != kb_notify::person_key(Some(author))
        })
        .collect();
    if people.is_empty() {
        return Ok(());
    }
    let who = if kb_notify::person_key(Some(author)) == "user" { "Someone" } else { author };
    for m in people {
        let mut data = Map::new();
        data.insert("canvas_id".into(), json!(canvas.id));
        data.insert("canvas_title".into(), json!(canvas.title));
        data.insert("board_id".into(), json!(thread.board_id));
        data.insert("comment_id".into(), json!(comment.id));
        kb_notify::emit(
            "mention",
            Some(session),
            kb_notify::EmitFields {
                project_id: canvas.project_id.clone(),
                recipients: vec![kb_notify::person_key(Some(&m.name))],
                title: format!("{who} mentioned you on {}", canvas.title),
                body: Some(format!("\u{201c}{}\u{201d}", snippet_of(&comment.body))),
                target_kind: Some("canvas_thread".into()),
                target_id: Some(thread.id.clone()),
                actor: Some(author.to_string()),
                data: Some(data),
                ..Default::default()
            },
        )
        .await?;
    }
    Ok(())
}

/// Whether an author is one of the project's AI teams.
async fn is_ai(session: &Session, c: &canvas::Model, author: &str) -> Result<bool> {
    let Some(project_id) = c.project_id.as_deref().filter(|p| !p.is_empty()) else { return Ok(false) };
    let rows = member::Entity::find().filter(member::Column::ProjectId.eq(project_id)).all(session).await?;
    let wanted = caseless::default_case_fold_str(author);
    for m in rows {
        if caseless::default_case_fold_str(&m.name) == wanted
            && ai_team::Entity::find_by_id(&m.id).one(session).await?.is_some()
        {
            return Ok(true);
        }
    }
    Ok(false)
}

fn json_text(text: &str) -> Result<Value> {
    pyjson::loads(text).ok_or_else(|| Error::Value(format!("invalid JSON in a comment row: {text}")))
}

fn out_comment(m: &canvas_comment::Model) -> Result<Map<String, Value>> {
    let ai = match m.ai.as_deref().filter(|a| !a.is_empty()) {
        Some(text) => json_text(text)?,
        None => Value::Null,
    };
    let mentions = json_text(if m.mentions.is_empty() { "[]" } else { &m.mentions })?;
    let mut out = Map::new();
    out.insert("id".into(), json!(m.id));
    out.insert("thread_id".into(), json!(m.thread_id));
    out.insert("author".into(), json!(m.author));
    out.insert("body".into(), json!(m.body));
    out.insert("mentions".into(), mentions);
    let is_ai = !ai.is_null();
    out.insert("ai".into(), ai);
    out.insert("is_ai".into(), json!(is_ai));
    out.insert("created_at".into(), json!(m.created_at));
    out.insert("edited_at".into(), json!(m.edited_at));
    Ok(out)
}

async fn comments_of(session: &Session, thread_id: &str) -> Result<Vec<canvas_comment::Model>> {
    Ok(canvas_comment::Entity::find()
        .filter(canvas_comment::Column::ThreadId.eq(thread_id))
        .order_by_asc(canvas_comment::Column::CreatedAt)
        .all(session)
        .await?)
}

async fn thread_out(session: &Session, t: &canvas_thread::Model) -> Result<Map<String, Value>> {
    let rows = comments_of(session, &t.id).await?;
    let mut comments = Vec::new();
    for m in &rows {
        comments.push(out_comment(m)?);
    }
    let by_ai = comments.first().is_some_and(|c| c.get("is_ai") == Some(&Value::Bool(true)));
    let anchor = match t.anchor.as_deref().filter(|a| !a.is_empty()) {
        Some(text) => json_text(text)?,
        None => Value::Null,
    };
    let mut out = Map::new();
    out.insert("id".into(), json!(t.id));
    out.insert("canvas_id".into(), json!(t.canvas_id));
    out.insert("number".into(), json!(t.number));
    out.insert("board_id".into(), json!(t.board_id));
    out.insert("x".into(), json!(t.x));
    out.insert("y".into(), json!(t.y));
    out.insert("page".into(), json!(t.page));
    out.insert("anchor".into(), anchor);
    out.insert("status".into(), json!(t.status));
    out.insert("created_by".into(), json!(t.created_by));
    out.insert("created_at".into(), json!(t.created_at));
    out.insert("resolved_by".into(), json!(t.resolved_by));
    out.insert("resolved_at".into(), json!(t.resolved_at));
    out.insert("comments".into(), Value::Array(comments.into_iter().map(Value::Object).collect()));
    out.insert("by_ai".into(), json!(by_ai));
    Ok(out)
}

/// Open threads of a canvas.
pub async fn open_count(session: &Session, canvas_id: &str) -> Result<u64> {
    Ok(canvas_thread::Entity::find()
        .filter(canvas_thread::Column::CanvasId.eq(canvas_id))
        .filter(canvas_thread::Column::Status.eq("open"))
        .count(session)
        .await?)
}

/// The canvas's threads in pin order, with their comments. `state`: `open`, `resolved` or all.
pub async fn list_threads(session: &Session, canvas_id: &str, state: Option<&str>) -> Result<Vec<Map<String, Value>>> {
    let c = get_row(session, canvas_id, false).await?;
    let mut query = canvas_thread::Entity::find()
        .filter(canvas_thread::Column::CanvasId.eq(c.id.as_str()))
        .order_by_asc(canvas_thread::Column::Number);
    if let Some(state) = state.filter(|s| matches!(*s, "open" | "resolved")) {
        query = query.filter(canvas_thread::Column::Status.eq(state));
    }
    let mut out = Vec::new();
    for t in query.all(session).await? {
        out.push(thread_out(session, &t).await?);
    }
    Ok(out)
}

/// `float(v)` clamped to 0..1, 0.5 when it is not a number.
fn unit(v: Option<&Value>) -> f64 {
    match py_float(v) {
        Some(f) => 0.0f64.max(1.0f64.min(f)),
        None => 0.5,
    }
}

/// `float(value)` for a JSON value: numbers, booleans and numeric strings; `None` where Python raises.
fn py_float(v: Option<&Value>) -> Option<f64> {
    match v? {
        Value::Number(n) => n.as_f64(),
        Value::Bool(b) => Some(if *b { 1.0 } else { 0.0 }),
        Value::String(s) => pytext::strip(s).replace('_', "").parse::<f64>().ok(),
        _ => None,
    }
}

/// The element a pin sits on, as stored: `sel` (CSS selector) and/or `text` (visible text), where inside it (`ox`,
/// `oy`, 0..1) and the frame width it was made at (`w`). Nothing usable gives `None`.
pub fn clean_anchor(raw: Option<&Value>) -> Option<Map<String, Value>> {
    let raw = raw?.as_object()?;
    let sel = match raw.get("sel") {
        Some(Value::String(s)) if !pytext::strip(s).is_empty() => {
            Some(pytext::strip(s).chars().take(500).collect::<String>())
        }
        _ => None,
    };
    let text = match raw.get("text") {
        Some(Value::String(s)) => Some(pytext::squash(s).chars().take(120).collect::<String>()),
        _ => None,
    }
    .filter(|t| !t.is_empty());
    if sel.is_none() && text.is_none() {
        return None;
    }
    let mut out = Map::new();
    out.insert("ox".into(), json!(unit(raw.get("ox"))));
    out.insert("oy".into(), json!(unit(raw.get("oy"))));
    if let Some(sel) = sel {
        out.insert("sel".into(), json!(sel));
    }
    if let Some(text) = text {
        out.insert("text".into(), json!(text));
    }
    if let Some(w) = py_float(raw.get("w")) {
        if (1.0..=8000.0).contains(&w) {
            // `round(w)`: halves go to the even number
            out.insert("w".into(), json!(w.round_ties_even() as i64));
        }
    }
    Some(out)
}

/// What `add_thread` is given besides the canvas.
#[derive(Debug, Clone)]
pub struct NewThread<'a> {
    /// The first comment's text.
    pub body: &'a str,
    /// The frame the pin is on (0..1 inside it), or `None` for the plane.
    pub board_id: Option<&'a str>,
    /// Position.
    pub x: f64,
    /// Position.
    pub y: f64,
    /// The page tab of a plane pin.
    pub page: Option<&'a str>,
    /// The element a frame pin is on (see `clean_anchor`).
    pub anchor: Option<&'a Value>,
    /// `{member}` on an AI team's comment.
    pub ai: Option<&'a Value>,
}

impl<'a> NewThread<'a> {
    /// A pin in the middle of nothing in particular: `x = y = 0.5`.
    pub fn new(body: &'a str) -> Self {
        NewThread { body, board_id: None, x: 0.5, y: 0.5, page: None, anchor: None, ai: None }
    }
}

/// Start a thread on a frame (`x`/`y` are 0..1 inside it) or on the plane (plane units, with `page`).
///
/// `anchor` (frames only, see `clean_anchor`) names the element the pin is on: the editor finds it again whatever the
/// frame's width, and falls back to `x`/`y`.
///
/// Raises: 403 for viewers; 404 for a frame that is not on the canvas.
pub async fn add_thread(session: &Session, canvas_id: &str, new: NewThread<'_>) -> Result<Map<String, Value>> {
    let c = get_row(session, canvas_id, false).await?;
    member_role(session, &c).await?;
    let doc = read_doc(&c.id)?;
    let board_id = new.board_id.filter(|b| !b.is_empty());
    let (mut x, mut y, mut page) = (new.x, new.y, new.page.map(str::to_string));
    if let Some(board_id) = board_id {
        board_of(&doc, board_id)?;
        x = 0.0f64.max(1.0f64.min(x));
        y = 0.0f64.max(1.0f64.min(y));
    } else {
        let pages = list(&doc, "pages");
        let ids: Vec<&str> = pages.iter().filter_map(|p| p.get("id").and_then(Value::as_str)).collect();
        let first = pages.first().and_then(|p| p.get("id")).and_then(Value::as_str).unwrap_or_default();
        page = Some(match page.as_deref() {
            Some(p) if ids.contains(&p) => p.to_string(),
            _ => first.to_string(),
        });
    }
    let existing =
        canvas_thread::Entity::find().filter(canvas_thread::Column::CanvasId.eq(c.id.as_str())).all(session).await?;
    let number = existing.iter().map(|t| t.number).max().unwrap_or(0).max(0) + 1;
    let actor = activity::current_actor();
    let text = body(new.body)?;
    let anchor = if board_id.is_some() { clean_anchor(new.anchor) } else { None };
    let mut row = canvas_thread::new();
    row.canvas_id = Set(c.id.clone());
    row.number = Set(number);
    // stored as given: an empty id is kept (and the pin is on the plane)
    row.board_id = Set(new.board_id.map(str::to_string));
    row.x = Set(x);
    row.y = Set(y);
    row.page = Set(page);
    row.anchor = Set(anchor.map(|a| pyjson::dumps(&Value::Object(a))));
    row.created_by = Set(actor.clone());
    let t = row.insert(session).await?;
    let mentioned = mentioned(session, &c, &text).await?;
    let mut first = canvas_comment::new();
    first.thread_id = Set(t.id.clone());
    first.author = Set(actor);
    first.body = Set(text);
    first.mentions = Set(pyjson::dumps(&mentioned.iter().map(|m| m.id.clone()).collect::<Vec<_>>()));
    first.ai = Set(new.ai.map(pyjson::dumps));
    let first = first.insert(session).await?;
    session.commit().await?;
    let out = thread_out(session, &t).await?;
    // after the answer is built: a failed notification rolls the session back
    notify_mentions(session, &c, &t, &first, &mentioned).await;
    Ok(out)
}

async fn thread(session: &Session, thread_id: &str) -> Result<(canvas::Model, canvas_thread::Model)> {
    let Some(t) = canvas_thread::Entity::find_by_id(thread_id).one(session).await? else {
        return Err(DocsError::new(404, "thread_not_found", "That comment thread was not found.").into());
    };
    let c = get_row(session, &t.canvas_id, false).await?;
    Ok((c, t))
}

/// Reply in a thread.
pub async fn reply(session: &Session, thread_id: &str, text: &str, ai: Option<&Value>) -> Result<Map<String, Value>> {
    let (c, t) = thread(session, thread_id).await?;
    member_role(session, &c).await?;
    let text = body(text)?;
    let mentioned = mentioned(session, &c, &text).await?;
    let mut new = canvas_comment::new();
    new.thread_id = Set(t.id.clone());
    new.author = Set(activity::current_actor());
    new.body = Set(text);
    new.mentions = Set(pyjson::dumps(&mentioned.iter().map(|m| m.id.clone()).collect::<Vec<_>>()));
    new.ai = Set(ai.map(pyjson::dumps));
    let new = new.insert(session).await?;
    session.commit().await?;
    let out = thread_out(session, &t).await?;
    notify_mentions(session, &c, &t, &new, &mentioned).await;
    Ok(out)
}

/// Edit your own comment.
pub async fn edit_comment(session: &Session, comment_id: &str, text: &str) -> Result<Map<String, Value>> {
    let Some(m) = canvas_comment::Entity::find_by_id(comment_id).one(session).await? else {
        return Err(DocsError::new(404, "comment_not_found", "That comment was not found.").into());
    };
    let (c, t) = thread(session, &m.thread_id).await?;
    member_role(session, &c).await?;
    if m.author != activity::current_actor() {
        return Err(DocsError::new(403, "not_yours", "You can only edit your own comments.").into());
    }
    let text = body(text)?;
    let ids: Vec<String> = mentioned(session, &c, &text).await?.into_iter().map(|x| x.id).collect();
    let mut row = m.into_active_model();
    row.body = Set(text);
    row.mentions = Set(pyjson::dumps(&ids));
    row.edited_at = Set(Some(canvases::now()));
    row.update(session).await?;
    session.commit().await?;
    thread_out(session, &t).await
}

/// Delete your own comment; deleting a thread's first comment removes the thread.
pub async fn delete_comment(session: &Session, comment_id: &str) -> Result<Map<String, Value>> {
    let Some(m) = canvas_comment::Entity::find_by_id(comment_id).one(session).await? else {
        return Err(DocsError::new(404, "comment_not_found", "That comment was not found.").into());
    };
    let (c, t) = thread(session, &m.thread_id).await?;
    member_role(session, &c).await?;
    if m.author != activity::current_actor() {
        return Err(DocsError::new(403, "not_yours", "You can only delete your own comments.").into());
    }
    let first = comments_of(session, &t.id).await?.into_iter().next();
    let mut out = Map::new();
    if first.is_some_and(|f| f.id == m.id) {
        canvas_comment::Entity::delete_many()
            .filter(canvas_comment::Column::ThreadId.eq(t.id.as_str()))
            .exec(session)
            .await?;
        canvas_thread::Entity::delete_by_id(t.id.as_str()).exec(session).await?;
        session.commit().await?;
        out.insert("deleted".into(), json!("thread"));
        out.insert("thread_id".into(), json!(t.id));
        return Ok(out);
    }
    canvas_comment::Entity::delete_by_id(m.id.as_str()).exec(session).await?;
    session.commit().await?;
    out.insert("deleted".into(), json!("comment"));
    out.insert("thread".into(), Value::Object(thread_out(session, &t).await?));
    Ok(out)
}

/// Resolve or reopen a thread. An AI team never resolves a person's thread.
///
/// Raises: 403 when an AI team tries to resolve a thread a person started.
pub async fn set_status(session: &Session, thread_id: &str, status: &str) -> Result<Map<String, Value>> {
    let (c, t) = thread(session, thread_id).await?;
    member_role(session, &c).await?;
    let actor = activity::current_actor();
    if status == "resolved" && is_ai(session, &c, &actor).await? && !is_ai(session, &c, &t.created_by).await? {
        return Err(DocsError::new(403, "ai_cannot_resolve", "AI teams do not resolve a person's thread.").into());
    }
    let resolved = status == "resolved";
    let mut row = t.into_active_model();
    row.status = Set(status.to_string());
    row.resolved_by = Set(resolved.then_some(actor));
    row.resolved_at = Set(resolved.then(canvases::now));
    let t = row.update(session).await?;
    session.commit().await?;
    thread_out(session, &t).await
}

/// One thread.
pub async fn thread_by_id(session: &Session, thread_id: &str) -> Result<Map<String, Value>> {
    let (_, t) = thread(session, thread_id).await?;
    thread_out(session, &t).await
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `docs_comments.plain_mentions` and `snippet_of` (private copies) against what Python gives
    /// (`contract/golden/gen_canvas_part2.py`).
    #[test]
    fn a_comment_s_preview_and_plain_mentions_are_python_s() {
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../contract/golden/canvas_part2.json");
        let g: Value = serde_json::from_slice(&std::fs::read(path).expect("golden file")).expect("golden json");
        let mut bad = Vec::new();
        for case in g["plain_mentions"].as_array().expect("cases") {
            let text = case["text"].as_str().expect("text");
            if plain_mentions(text) != case["out"].as_str().expect("out") {
                bad.push(format!("plain_mentions {text:?}: got {:?}", plain_mentions(text)));
            }
        }
        for case in g["snippet_of"].as_array().expect("cases") {
            let text = case["text"].as_str().expect("text");
            if snippet_of(text) != case["out"].as_str().expect("out") {
                bad.push(format!("snippet_of {text:?}\n  got  {:?}\n  want {}", snippet_of(text), case["out"]));
            }
        }
        assert!(
            bad.is_empty(),
            "{} cases differ:\n{}",
            bad.len(),
            bad.iter().take(12).cloned().collect::<Vec<_>>().join("\n")
        );
    }
}
