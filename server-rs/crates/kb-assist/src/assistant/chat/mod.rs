//! Board AI chat on the assistant engine (AI v2): a chat is one Claude Code conversation (`chat:<id>`), an answer
//! is one turn with the `board-ask` skill (`services/assistant/chat.py`). The assistant reads the board with its
//! tools and acts with the asker's own rights; there are no drafts to apply any more: it does what was asked, and
//! says what it did.
//!
//! The Python module is one file; here it is this file (lines 1 to 306: the constants, the API shapes, finding a
//! chat, making one, the ticket's team) and four more in the order of the Python text: `scope` (309 to 437:
//! `scope_state`), `chats` (440 to 515: `detail`, `update_chat`, `mark_seen`, `delete_chat`), `send` (518 to 824:
//! `send`, `spawn`, `_answer`) and `messages` (827 to 979: one message, undo, feedback, stop, retry, post as comment,
//! `recover`). Every name of the Python module is `chat::<name>` here too.
//!
//! Stopping an answer. Python cancels the task that writes it (`TASKS[message_id].cancel()`); the task catches the
//! cancellation, and still writes "stopped" onto the message. A Tokio task that is aborted runs nothing more, so here
//! `TASKS` holds a signal the answer's task waits on beside its turn: on the signal it drops the turn (which stops
//! the CLI and finishes the run as cancelled, see `engine`) and goes on to write the message.

use std::collections::{HashMap, HashSet};
use std::sync::atomic::AtomicU64;
use std::sync::{Arc, LazyLock, Mutex, MutexGuard};

use kb_ai::store::{active_runs, loads, now_iso};
use kb_base::{events, pyjson};
use kb_db::Session;
use kb_db::database;
use kb_db::entities::{ai_chat, ai_chat_message, ai_run, docs_page, idea_ticket, member, project, ticket};
use kb_db::sea_orm::ActiveValue::Set;
use kb_db::sea_orm::sea_query::{BinOper, Expr, ExprTrait, Func};
use kb_db::sea_orm::{
    ActiveModelTrait, ColumnTrait, DbErr, EntityTrait, IntoActiveModel, QueryFilter, QueryOrder, QuerySelect,
};
use serde_json::{Map, Value, json};
use tokio::sync::Notify;

use super::drafts;
use super::errors::{AssistError, Error};
use super::settings::{self as svc_settings, round_to};

mod chats;
mod messages;
mod scope;
mod send;

pub use chats::{delete_chat, detail, mark_seen, update_chat};
pub use messages::{get_message, post_as_comment, recover, retry, set_feedback, stop, undo_receipt};
pub use scope::scope_state;
pub use send::{SendOpts, send, spawn};

/// How long a chat is kept, in days.
pub const KEEP_DAYS: i64 = 30;
/// The longest message, in characters.
pub const MAX_TEXT: usize = 8000;
/// What a chat can be about.
pub const SCOPES: [&str; 6] = ["ticket", "doc", "idea", "project", "all", "sketch"];
/// The states of an answer that is still being written.
pub const ACTIVE: [&str; 3] = ["queued", "thinking", "streaming"];

/// `UNDOING`: the answers whose changes are being put back right now.
static UNDOING: LazyLock<Mutex<HashSet<String>>> = LazyLock::new(|| Mutex::new(HashSet::new()));
/// `TASKS`: the stop signal of the task writing each answer (a serial number tells one task of a message from the
/// next).
static TASKS: LazyLock<Mutex<HashMap<String, (u64, Arc<Notify>)>>> = LazyLock::new(|| Mutex::new(HashMap::new()));
/// `RUNS`: message id -> the run of its turn (for Stop).
static RUNS: LazyLock<Mutex<HashMap<String, String>>> = LazyLock::new(|| Mutex::new(HashMap::new()));
static SERIAL: AtomicU64 = AtomicU64::new(0);

fn undoing() -> MutexGuard<'static, HashSet<String>> {
    UNDOING.lock().unwrap_or_else(|e| e.into_inner())
}

fn tasks() -> MutexGuard<'static, HashMap<String, (u64, Arc<Notify>)>> {
    TASKS.lock().unwrap_or_else(|e| e.into_inner())
}

fn runs() -> MutexGuard<'static, HashMap<String, String>> {
    RUNS.lock().unwrap_or_else(|e| e.into_inner())
}

/// `message_id in TASKS`: a task is writing this answer.
pub fn is_answering(message_id: &str) -> bool {
    tasks().contains_key(message_id)
}

/// `RUNS.get(message_id)`: the run of the turn that writes this answer.
pub fn run_of(message_id: &str) -> Option<String> {
    runs().get(message_id).cloned()
}

/// `TASKS.get(message_id).cancel()`: tell the task writing this answer to stop.
fn cancel_task(message_id: &str) {
    if let Some((_, stop)) = tasks().get(message_id) {
        stop.notify_one();
    }
}

/// `loads(raw, {})` as a dict (a stored value that is not one counts as empty).
fn dict(raw: &str) -> Map<String, Value> {
    match loads(Some(raw), json!({})) {
        Value::Object(map) => map,
        _ => Map::new(),
    }
}

/// A chat message as the API shows it.
pub fn msg_out(m: &ai_chat_message::Model) -> Value {
    let feedback = loads(Some(&m.feedback), json!({}));
    json!({
        "id": m.id,
        "chat_id": m.chat_id,
        "role": m.role,
        "text": m.text,
        "state": m.state,
        "steps": loads(Some(&m.steps), json!([])),
        "context": loads(Some(&m.context), json!({})),
        "actions": loads(Some(&m.actions), json!([])),
        "draft_id": m.draft_id.as_deref().filter(|id| drafts::holds(id)),
        "draft": drafts::find(m.draft_id.as_deref().unwrap_or("")),
        "error": loads(Some(&m.error), json!({})),
        "retry_at": m.retry_at,
        "member_id": m.member_id,
        "model": m.model,
        "cost": round_to(m.cost, 6),
        "tokens_in": m.tokens_in,
        "tokens_out": m.tokens_out,
        "metered": false,
        "created_at": m.created_at,
        "finished_at": m.finished_at,
        "feedback": if pyjson::truthy(&feedback) { feedback } else { Value::Null },
    })
}

/// A chat as the API shows it.
pub fn chat_out(c: &ai_chat::Model) -> Map<String, Value> {
    let value = json!({
        "id": c.id,
        "project_id": c.project_id,
        "owner": c.owner,
        "title": c.title,
        "scope": c.scope,
        "scope_id": c.scope_id,
        "member_id": c.member_id,
        "ticket_id": c.ticket_id,
        "doc_id": c.doc_id,
        "include_docs": loads(Some(&c.include_docs), json!([])),
        "cost": round_to(c.cost, 6),
        "tokens": c.tokens,
        "applied": c.applied,
        "summary": c.summary,
        "summary_upto": c.summary_upto,
        "compactions": c.compactions,
        "created_at": c.created_at,
        "updated_at": c.updated_at,
    });
    match value {
        Value::Object(map) => map,
        _ => Map::new(),
    }
}

/// `_chat`: the person's own chat, or `not_found`.
async fn chat_of(session: &Session, chat_id: &str, by: &str) -> Result<ai_chat::Model, Error> {
    match ai_chat::Entity::find_by_id(chat_id).one(session).await? {
        Some(chat) if chat.owner == by => Ok(chat),
        _ => Err(AssistError::new("not_found", "Chat not found.").into()),
    }
}

/// `_message`: a message of the person's own chat, and that chat.
async fn message_of(
    session: &Session,
    message_id: &str,
    by: &str,
) -> Result<(ai_chat_message::Model, ai_chat::Model), Error> {
    let Some(m) = ai_chat_message::Entity::find_by_id(message_id).one(session).await? else {
        return Err(AssistError::new("not_found", "Message not found.").into());
    };
    let chat = chat_of(session, &m.chat_id, by).await?;
    Ok((m, chat))
}

/// The person's chats in a project, newest first, with this month's chat cost.
pub async fn list_chats(
    session: &Session,
    project_id: &str,
    by: &str,
    q: Option<&str>,
) -> Result<Map<String, Value>, DbErr> {
    let mut stmt =
        ai_chat::Entity::find().filter(ai_chat::Column::ProjectId.eq(project_id)).filter(ai_chat::Column::Owner.eq(by));
    if let Some(q) = q.map(kb_base::pytext::strip).filter(|q| !q.is_empty()) {
        // `ilike`: lower-cased on both sides, as SQLAlchemy writes it for an engine without ILIKE
        let like = format!("%{q}%");
        stmt = stmt.filter(
            Expr::expr(Func::lower(Expr::col(ai_chat::Column::Title)))
                .binary(BinOper::Like, Expr::cust_with_values("lower(?)", [like])),
        );
    }
    let rows = stmt.order_by_desc(ai_chat::Column::UpdatedAt).limit(200).all(session).await?;
    let mut out = Map::new();
    out.insert("chats".into(), Value::Array(rows.iter().map(|c| Value::Object(chat_out(c))).collect()));
    out.insert("count".into(), json!(rows.len()));
    out.insert("month_cost".into(), json!(svc_settings::month_spend(session, Some("chat")).await?));
    out.insert("keep_days".into(), json!(KEEP_DAYS));
    Ok(out)
}

/// `_target`: (project id, title) of the thing a chat is about.
async fn target(session: &Session, kind: &str, scope_id: Option<&str>) -> Result<(Option<String>, String), Error> {
    let id = scope_id.unwrap_or("");
    match kind {
        "ticket" => match ticket::Entity::find_by_id(id).one(session).await? {
            Some(t) => Ok((Some(t.project_id), format!("{} {}", t.id, t.title))),
            None => Err(AssistError::new("not_found", "Ticket not found.").into()),
        },
        "doc" => match docs_page::Entity::find_by_id(id).one(session).await? {
            Some(p) => Ok((Some(p.project_id), p.title)),
            None => Err(AssistError::new("not_found", "Page not found.").into()),
        },
        "idea" => match idea_ticket::Entity::find_by_id(id).one(session).await? {
            Some(i) => Ok((i.project_id, i.title)),
            None => Err(AssistError::new("not_found", "Idea not found.").into()),
        },
        _ => Ok((None, String::new())),
    }
}

/// The person's latest chat about one thing.
async fn latest_chat(
    session: &Session,
    by: &str,
    scope: &str,
    scope_id: Option<&str>,
) -> Result<Option<ai_chat::Model>, DbErr> {
    let about = match scope_id {
        Some(id) => ai_chat::Column::ScopeId.eq(id),
        None => ai_chat::Column::ScopeId.is_null(),
    };
    ai_chat::Entity::find()
        .filter(ai_chat::Column::Owner.eq(by))
        .filter(ai_chat::Column::Scope.eq(scope))
        .filter(about)
        .order_by_desc(ai_chat::Column::UpdatedAt)
        .one(session)
        .await
}

/// The keyword arguments of `create_chat`.
#[derive(Debug, Clone, Copy)]
pub struct NewChat<'a> {
    /// What the chat is about (one of `SCOPES`).
    pub scope: &'a str,
    /// The ticket it is about.
    pub ticket_id: Option<&'a str>,
    /// The page it is about.
    pub doc_id: Option<&'a str>,
    /// The thing it is about, for any scope.
    pub scope_id: Option<&'a str>,
    /// The AI member that answers; None: the project's Board AI.
    pub member_id: Option<&'a str>,
    /// A new chat even when the person already has one about the same thing.
    pub fresh: bool,
}

impl Default for NewChat<'_> {
    fn default() -> Self {
        Self { scope: "project", ticket_id: None, doc_id: None, scope_id: None, member_id: None, fresh: false }
    }
}

/// A new chat, or the person's latest chat about the same thing.
pub async fn create_chat(
    session: &Session,
    project_id: &str,
    by: &str,
    new: NewChat<'_>,
) -> Result<ai_chat::Model, Error> {
    let NewChat { scope, ticket_id, doc_id, scope_id, member_id, fresh } = new;
    if !SCOPES.contains(&scope) {
        return Err(AssistError::new("invalid", "Unknown scope.").into());
    }
    let filled = |id: &Option<&str>| id.is_some_and(|id| !id.is_empty());
    let scope_id = [scope_id, ticket_id, doc_id].into_iter().find(filled).flatten();
    let mut title = "New chat".to_string();
    if matches!(scope, "ticket" | "doc" | "idea") {
        title = target(session, scope, scope_id).await?.1;
        if !fresh {
            if let Some(old) = latest_chat(session, by, scope, scope_id).await? {
                return Ok(old);
            }
        }
    }
    let title: String = title.chars().take(80).collect();
    let mut chat = ai_chat::new();
    chat.project_id = Set(project_id.to_string());
    chat.owner = Set(by.to_string());
    chat.title = Set(if title.is_empty() { "New chat".to_string() } else { title });
    chat.scope = Set(scope.to_string());
    chat.scope_id = Set(scope_id.map(str::to_string));
    chat.ticket_id = Set(if scope == "ticket" { scope_id } else { ticket_id }.map(str::to_string));
    chat.doc_id = Set(if scope == "doc" { scope_id } else { doc_id }.map(str::to_string));
    chat.member_id = Set(member_id.map(str::to_string));
    let chat = chat.insert(session).await?;
    session.commit().await?;
    Ok(chat)
}

/// The person's chat about a ticket, a page or an idea (a new one with `fresh`).
pub async fn scope_chat(
    session: &Session,
    kind: &str,
    scope_id: &str,
    by: &str,
    fresh: bool,
) -> Result<ai_chat::Model, Error> {
    let (project_id, _title) = target(session, kind, Some(scope_id)).await?;
    let project_id = match project_id.filter(|p| !p.is_empty()) {
        Some(project_id) => project_id,
        None => match project::Entity::find().order_by_asc(project::Column::Name).one(session).await? {
            Some(project) => project.id,
            None => return Err(AssistError::new("not_found", "There is no project to book the chat on.").into()),
        },
    };
    create_chat(
        session,
        &project_id,
        by,
        NewChat { scope: kind, scope_id: Some(scope_id), fresh, ..Default::default() },
    )
    .await
}

/// What `ticket_team` gives: the team that works a ticket.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TicketTeam {
    /// The team's member id.
    pub id: String,
    /// The team's name.
    pub name: String,
    /// Whether a run of the ticket is going.
    pub working: bool,
}

/// The AI team that works a ticket: its AI assignee, else the team of its newest run. None: no team yet.
pub async fn ticket_team(session: &Session, ticket_id: &str) -> Result<Option<TicketTeam>, DbErr> {
    let Some(ticket) = ticket::Entity::find_by_id(ticket_id).one(session).await? else {
        return Ok(None);
    };
    let mut team: Option<member::Model> = None;
    if let Some(assignee) = ticket.assignee.as_deref().filter(|a| !a.is_empty()) {
        team = member::Entity::find_by_id(assignee).one(session).await?.filter(|m| m.kind == "ai");
    }
    if team.is_none() {
        let last = ai_run::Entity::find()
            .filter(ai_run::Column::TicketId.eq(ticket_id))
            .order_by_desc(ai_run::Column::QueuedAt)
            .one(session)
            .await?;
        if let Some(last) = last {
            team = member::Entity::find_by_id(last.member_id.as_str()).one(session).await?;
        }
    }
    let Some(team) = team else { return Ok(None) };
    let working = !active_runs(session, None, Some(ticket_id)).await?.is_empty();
    Ok(Some(TicketTeam { id: team.id, name: team.name, working }))
}

/// `TEAM_NOTE.format(by=by, mid=mid, text=text)`: what the ticket's team is told when a person writes in the
/// ticket chat.
pub fn team_note(by: &str, mid: &str, text: &str) -> String {
    format!(
        "{by} writes to you in the ticket chat (chat message {mid}):\n\n{text}\n\n\
         Do what they ask. Answer them in the chat with ai_run(action='reply', message_id='{mid}', text='…'): short, in \
         Markdown. Then carry on with what you were doing: this message is not a reason to stop, hand in or change course, \
         unless {by} tells you to stop. If you were not working on anything, this message is the whole task."
    )
}

/// The lead's answer to a person's message in the ticket chat (`ai_run(action='reply')`): it fills the chat
/// message that waits for it (the one named, else the newest on this ticket).
pub async fn reply_from_team(
    ticket_id: &str,
    text: &str,
    member_id: &str,
    message_id: Option<&str>,
) -> Result<Value, Error> {
    let text = kb_base::pytext::strip(text);
    if text.is_empty() {
        return Err(Error::Value("ai_run(action='reply') needs `text`.".to_string()));
    }
    let session = database::session();
    let chats: Vec<String> = ai_chat::Entity::find()
        .filter(ai_chat::Column::Scope.eq("ticket"))
        .filter(ai_chat::Column::ScopeId.eq(ticket_id))
        .all(&session)
        .await?
        .into_iter()
        .map(|c| c.id)
        .collect();
    let mut stmt = ai_chat_message::Entity::find()
        .filter(ai_chat_message::Column::ChatId.is_in(chats))
        .filter(ai_chat_message::Column::Role.eq("ai"))
        .filter(ai_chat_message::Column::MemberId.eq(member_id))
        .filter(ai_chat_message::Column::State.is_in(ACTIVE))
        .order_by_desc(ai_chat_message::Column::CreatedAt);
    if let Some(message_id) = message_id.filter(|id| !id.is_empty()) {
        stmt = stmt.filter(ai_chat_message::Column::Id.eq(message_id));
    }
    let Some(m) = stmt.one(&session).await? else {
        return Err(Error::Value(
            "No message in this ticket's chat waits for an answer: write a comment with ticket_items instead."
                .to_string(),
        ));
    };
    let mid = m.id.clone();
    let mut row = kb_db::edit(m);
    row.text = Set(text.chars().take(20000).collect());
    row.state = Set("done".to_string());
    row.finished_at = Set(Some(now_iso()));
    row.update(&session).await?;
    session.commit().await?;
    drop(session);
    events::publish(events::INVALIDATE, &[]).await;
    Ok(json!({"replied": true, "message_id": mid}))
}

/// A message to the team that nobody answered, and the team has stopped: say so, so the chat does not wait forever.
pub async fn settle_team_messages(session: &Session, chat: &ai_chat::Model) -> Result<(), DbErr> {
    let Some(scope_id) = chat.scope_id.as_deref().filter(|id| !id.is_empty() && chat.scope == "ticket") else {
        return Ok(());
    };
    let waiting = ai_chat_message::Entity::find()
        .filter(ai_chat_message::Column::ChatId.eq(chat.id.as_str()))
        .filter(ai_chat_message::Column::Role.eq("ai"))
        .filter(ai_chat_message::Column::State.is_in(ACTIVE))
        .filter(ai_chat_message::Column::MemberId.is_not_null())
        .all(session)
        .await?;
    if waiting.is_empty() || !active_runs(session, None, Some(scope_id)).await?.is_empty() {
        return Ok(());
    }
    for m in waiting {
        let mut row = kb_db::edit(m);
        row.text =
            Set("The team stopped before it answered here. What it did is in its report on the ticket.".to_string());
        row.state = Set("done".to_string());
        row.finished_at = Set(Some(now_iso()));
        row.update(session).await?;
    }
    session.commit().await
}
