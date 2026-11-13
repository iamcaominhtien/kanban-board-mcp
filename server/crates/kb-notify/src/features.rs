//! Part of `services/notifications.py`: lines 1559 to 1977, "What the features write (the six notifiers of the app
//! moved here, to the server)": what a run's question, end, trouble and urgent wait, a published page and a Docs
//! comment tell.

use std::sync::{LazyLock, Mutex};

use chrono::Duration;
use kb_db::Session;
use kb_db::entities::{ai_chat, ai_run, docs_comment_event, member, notification, ticket};
use kb_db::sea_orm::{ColumnTrait, EntityTrait, QueryFilter};
use serde_json::{Map, Value, json};
use tokio::task::JoinHandle;

use crate::error::Result;
use crate::helpers::{
    as_str, first_line, head_chars, loads, loads_list, loads_map, local_of_iso, opt_str, parse, person_key, truthy,
    utcnow,
};
use crate::kinds::AN_AI_TEAM;
use crate::recipients::{followers, owners_and_admins, recipient_keys};
use crate::resolving::resolve_rows;
use crate::writing::{EmitFields, emit, group_key};

fn data_of(value: Value) -> Option<Map<String, Value>> {
    match value {
        Value::Object(m) => Some(m),
        _ => None,
    }
}

fn dedup(keys: Vec<String>) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for k in keys {
        if !out.contains(&k) {
            out.push(k);
        }
    }
    out
}

/// Who hears about a run: the person it acts for, the ticket's followers and its assignee; when it was started by
/// an AI (a chain), the owners and admins too, so a person always hears of it.
pub async fn run_people(session: &Session, run: &ai_run::Model) -> Result<Vec<String>> {
    let mut keys = recipient_keys(session, Some(&run.project_id), &[Some(run.started_by.as_str())]).await?;
    if let Some(ticket_id) = run.ticket_id.as_deref() {
        if let Some(t) = ticket::Entity::find_by_id(ticket_id).one(session).await? {
            if let Some(assignee) = t.assignee.as_deref().filter(|a| !a.is_empty()) {
                if let Some(m) = member::Entity::find_by_id(assignee).one(session).await? {
                    if m.kind == "human" {
                        keys.push(person_key(Some(&m.name)));
                    }
                }
            }
        }
    }
    keys.extend(followers(session, "ticket", run.ticket_id.as_deref()).await?);
    if !keys.iter().any(|k| !k.starts_with("ai:")) {
        keys.extend(owners_and_admins(session, Some(&run.project_id)).await?);
    }
    Ok(dedup(keys))
}

async fn member_name(session: &Session, member_id: &str) -> Result<String> {
    let m = member::Entity::find_by_id(member_id).one(session).await?;
    Ok(m.map(|m| m.name).unwrap_or_else(|| AN_AI_TEAM.to_string()))
}

/// An AI asked and its run paused: a question for the person it asked (Needs you). A `reminder` (15 min, then
/// every 2 h unanswered) brings the same row back to the top and toasts again, without counting as a new item.
/// `passed_to`: the question was passed to this person ("Ask someone else", by `by`); whoever is no longer one of
/// its recipients sees their row close ("Passed to Hoa Mai").
pub async fn on_run_question(run_id: &str, reminder: bool, passed_to: Option<&str>, by: Option<&str>) {
    // a notification never breaks a run
    if let Err(e) = run_question(run_id, reminder, passed_to, by).await {
        // the run id can come from a request: it is not written to the log (log injection)
        tracing::error!("Could not write a question notification: {e}");
    }
}

async fn run_question(run_id: &str, reminder: bool, passed_to: Option<&str>, by: Option<&str>) -> Result<()> {
    let session = kb_db::session();
    let Some(run) = ai_run::Entity::find_by_id(run_id).one(&session).await? else {
        return Ok(());
    };
    let q = loads_map(run.question.as_deref());
    let name = member_name(&session, &run.member_id).await?;
    let to = as_str(q.get("to"));
    let mut keys = recipient_keys(&session, Some(&run.project_id), &[to, Some(run.started_by.as_str())]).await?;
    if !keys.iter().any(|k| !k.starts_with("ai:")) {
        keys.extend(owners_and_admins(&session, Some(&run.project_id)).await?);
    }
    let text = as_str(q.get("text").filter(|v| truthy(Some(v)))).unwrap_or("").trim().to_string();
    let mut data = Map::new();
    data.insert("to".into(), q.get("to").cloned().unwrap_or(Value::Null));
    let options = q.get("options").filter(|v| truthy(Some(v))).cloned().unwrap_or_else(|| json!([]));
    data.insert("options".into(), options);
    data.insert("run_number".into(), json!(run.number));
    if reminder {
        data.insert("reminder".into(), json!(true));
    }
    emit(
        "question",
        Some(&session),
        EmitFields {
            project_id: Some(run.project_id.clone()),
            recipients: keys.clone(),
            title: format!("{name} asks a question"),
            body: Some(format!("“{}”", head_chars(&text, 400))),
            target_kind: Some("run".into()),
            target_id: Some(run.id.clone()),
            ticket_id: run.ticket_id.clone(),
            member_id: Some(run.member_id.clone()),
            actor: Some(name.clone()),
            since: as_str(q.get("asked_at")).map(str::to_string),
            data: Some(data),
            ..Default::default()
        },
    )
    .await?;
    if let Some(passed_to) = passed_to.filter(|p| !p.is_empty()) {
        close_passed_question(&session, &run, &keys, passed_to, by).await?;
    }
    Ok(())
}

/// A question passed to someone else: the open rows of the people it is no longer addressed to close.
pub async fn close_passed_question(
    session: &Session,
    run: &ai_run::Model,
    keys: &[String],
    passed_to: &str,
    by: Option<&str>,
) -> Result<()> {
    let gk = group_key("question", Some(&run.project_id), Some("run"), Some(&run.id), run.ticket_id.as_deref());
    let stale = notification::Entity::find()
        .filter(notification::Column::GroupKey.eq(gk))
        .filter(notification::Column::DoneAt.is_null())
        .filter(notification::Column::Recipient.is_not_in(keys.iter().cloned()))
        .all(session)
        .await?;
    resolve_rows(session, stale, &format!("Passed to {passed_to}"), by, false).await?;
    Ok(())
}

/// The chat page tells the board every ~15 s while it is open and in front of the person (api
/// `/ai/assist/chats/{id}/seen`); a missed beat or two still counts as open.
pub const CHAT_OPEN_FOR_SECONDS: i64 = 45;

/// A run that a message in the ticket chat started ended while its person had that chat open and in front of them
/// (Chat open: the answer is on their screen, so "AI finished" would tell them what they are reading). The notice
/// stays for a chat that is closed, or in a window nobody looks at: the answer waits there.
pub async fn chat_in_front(session: &Session, run: &ai_run::Model) -> Result<bool> {
    let Some(ticket_id) = run.ticket_id.as_deref().filter(|t| !t.is_empty()) else {
        return Ok(false);
    };
    // a failure or a timeout is a Needs you: the open chat does not make it less so
    if run.state != "finished" || run.trigger != "message" || run.started_by.is_empty() {
        return Ok(false);
    }
    let chat = ai_chat::Entity::find()
        .filter(ai_chat::Column::Scope.eq("ticket"))
        .filter(ai_chat::Column::ScopeId.eq(ticket_id))
        .filter(ai_chat::Column::Owner.eq(run.started_by.clone()))
        .one(session)
        .await?;
    let seen = chat.and_then(|c| parse(c.seen_at.as_deref()));
    Ok(seen.is_some_and(|s| utcnow().signed_duration_since(s) <= Duration::seconds(CHAT_OPEN_FOR_SECONDS)))
}

/// A run ended: finished work (for information, grouped), failed or timed out (Needs you), or cancelled because
/// its ticket was archived (for information). A scheduled run is told by its schedule instead.
pub async fn on_run_ended(run_id: &str) {
    if let Err(e) = run_ended(run_id).await {
        tracing::error!("Could not write a run end notification: {e}");
    }
}

async fn run_ended(run_id: &str) -> Result<()> {
    let session = kb_db::session();
    let Some(run) = ai_run::Entity::find_by_id(run_id).one(&session).await? else {
        return Ok(());
    };
    let name = member_name(&session, &run.member_id).await?;
    let mut keys = run_people(&session, &run).await?;
    if chat_in_front(&session, &run).await? {
        // the answer is on the screen of the person who asked: no notice for them; the others still hear
        let asker = recipient_keys(&session, Some(&run.project_id), &[Some(run.started_by.as_str())]).await?;
        keys.retain(|k| !asker.contains(k));
        if keys.is_empty() {
            return Ok(());
        }
    }
    let Some((kind, title, body)) = run_end_notice(&run, &name) else {
        return Ok(());
    };
    let mut data = Map::new();
    data.insert("run_number".into(), json!(run.number));
    data.insert("state".into(), json!(run.state));
    data.insert("cost_usd".into(), json!(run.cost_usd));
    if run.diagnosis.as_deref().is_some_and(|d| !d.is_empty()) && kind != "ai_finished" {
        data.insert("diagnosis".into(), loads(run.diagnosis.as_deref(), Value::Null));
    }
    emit(
        kind,
        Some(&session),
        EmitFields {
            project_id: Some(run.project_id.clone()),
            recipients: keys,
            title,
            body: Some(body),
            target_kind: Some("run".into()),
            target_id: Some(run.id.clone()),
            ticket_id: run.ticket_id.clone(),
            member_id: Some(run.member_id.clone()),
            actor: Some(name),
            data: Some(data),
            ..Default::default()
        },
    )
    .await?;
    Ok(())
}

/// A running AI stopped moving and the board diagnosed it (design C, D): one Needs you row per run and cause,
/// carrying the diagnosis and the actions it allows. A board fault comes straight to people.
pub async fn on_run_trouble(run_id: &str) {
    if let Err(e) = run_trouble(run_id).await {
        tracing::error!("Could not write a run trouble notification: {e}");
    }
}

async fn run_trouble(run_id: &str) -> Result<()> {
    let session = kb_db::session();
    let Some(run) = ai_run::Entity::find_by_id(run_id).one(&session).await? else {
        return Ok(());
    };
    let diag = loads_map(run.diagnosis.as_deref());
    let name = member_name(&session, &run.member_id).await?;
    let mut keys = run_people(&session, &run).await?;
    let admins: Vec<String> =
        owners_and_admins(&session, Some(&run.project_id)).await?.into_iter().filter(|k| !keys.contains(k)).collect();
    keys.extend(admins);
    // a board fault while running is the same card, marked board fault in its data
    let quiet_s = match diag.get("quiet_s") {
        Some(v) => crate::helpers::py_int(v)?,
        None => 0,
    };
    let mut title = format!(
        "{name} has produced nothing for {} min on {}",
        std::cmp::max(1, quiet_s.div_euclid(60)),
        opt_str(&run.ticket_id)
    );
    if as_str(diag.get("cause")) == Some("busy") {
        title = format!("{name} is still working on {}: one command has run a long time", opt_str(&run.ticket_id));
    }
    let what = diag.get("what").map(kb_base::pyjson::py_str).unwrap_or_default();
    let means = diag.get("means").map(kb_base::pyjson::py_str).unwrap_or_default();
    let mut data = Map::new();
    data.insert("run_number".into(), json!(run.number));
    data.insert("diagnosis".into(), Value::Object(diag));
    emit(
        "run_stuck",
        Some(&session),
        EmitFields {
            project_id: Some(run.project_id.clone()),
            recipients: keys,
            title,
            body: Some(head_chars(format!("{what} {means}").trim(), 600)),
            target_kind: Some("run".into()),
            target_id: Some(run.id.clone()),
            ticket_id: run.ticket_id.clone(),
            member_id: Some(run.member_id.clone()),
            actor: Some(name),
            data: Some(data),
            ..Default::default()
        },
    )
    .await?;
    Ok(())
}

/// Urgent work waits for a usage window and no other account has room (or moving is off): Needs you.
pub async fn on_window_urgent(run_id: &str, until: &str, room: &[Value]) {
    if let Err(e) = window_urgent(run_id, until, room).await {
        tracing::error!("Could not write a usage window notification: {e}");
    }
}

async fn window_urgent(run_id: &str, until: &str, room: &[Value]) -> Result<()> {
    let session = kb_db::session();
    let Some(run) = ai_run::Entity::find_by_id(run_id).one(&session).await? else {
        return Ok(());
    };
    let mut keys = run_people(&session, &run).await?;
    let admins: Vec<String> =
        owners_and_admins(&session, Some(&run.project_id)).await?.into_iter().filter(|k| !keys.contains(k)).collect();
    keys.extend(admins);
    let when = local_of_iso(until).map(|d| d.format("%H:%M").to_string()).unwrap_or_default();
    let body = if room.is_empty() {
        "No other Claude account has room right now.".to_string()
    } else {
        format!("{} other account{} room: move it there.", room.len(), if room.len() != 1 { "s have" } else { " has" })
    };
    let mut data = Map::new();
    data.insert("until".into(), json!(until));
    data.insert("room".into(), Value::Array(room.to_vec()));
    emit(
        "window_urgent",
        Some(&session),
        EmitFields {
            project_id: Some(run.project_id.clone()),
            recipients: keys,
            title: format!("Urgent {} waits for the usage window (reopens {when})", opt_str(&run.ticket_id)),
            body: Some(body),
            target_kind: Some("run".into()),
            target_id: Some(run.id.clone()),
            ticket_id: run.ticket_id.clone(),
            member_id: Some(run.member_id.clone()),
            data: Some(data),
            ..Default::default()
        },
    )
    .await?;
    Ok(())
}

/// (kind, title, body) of what a run's end tells, or `None` when it tells nothing here.
pub fn run_end_notice(run: &ai_run::Model, name: &str) -> Option<(&'static str, String, String)> {
    if run.state == "finished" && run.mode == "work" {
        return finished_notice(run, name);
    }
    if (run.state == "failed" || run.state == "timed_out") && run.mode == "work" {
        return failed_notice(run);
    }
    if run.state == "cancelled" && run.stop_code.as_deref() == Some("archive") {
        let by = match run.ended_by.as_deref().filter(|b| !b.is_empty()) {
            Some(b) => format!(" by {b}"),
            None => String::new(),
        };
        return Some((
            "run_cancelled",
            format!("{} was archived{by}", opt_str(&run.ticket_id)),
            format!("Run #{} was cancelled. Files stay on the branch.", run.number),
        ));
    }
    None
}

/// A finished work run: "AI finished", with the first line of its summary.
pub fn finished_notice(run: &ai_run::Model, name: &str) -> Option<(&'static str, String, String)> {
    if run.trigger == "schedule" {
        return None;
    }
    let report = loads_map(Some(&run.report));
    let summary = report
        .get("summary")
        .filter(|v| truthy(Some(v)))
        .map(kb_base::pyjson::py_str)
        .or_else(|| run.summary.clone().filter(|s| !s.is_empty()))
        .unwrap_or_default();
    let body = match first_line(summary.trim()) {
        Some(line) => head_chars(line, 200),
        None => "AI summary ready for review.".to_string(),
    };
    Some(("ai_finished", format!("{name} finished {}", opt_str(&run.ticket_id)), body))
}

/// A failed or timed out work run: a board fault, or "run failed".
pub fn failed_notice(run: &ai_run::Model) -> Option<(&'static str, String, String)> {
    if run.stop_code.as_deref() == Some("memory") {
        return None; // "stopped for memory" was written by the safety event
    }
    if run.trigger == "schedule" {
        return None; // its schedule tells the slot's failure, once
    }
    let verb = if run.state == "failed" { "failed" } else { "timed out" };
    let diag = loads_map(run.diagnosis.as_deref());
    let reason = run.ended_reason.clone().unwrap_or_default();
    if diag.get("board_fault").is_some_and(|v| truthy(Some(v))) {
        let what =
            diag.get("what").filter(|v| truthy(Some(v))).map(kb_base::pyjson::py_str).unwrap_or_else(|| reason.clone());
        return Some((
            "board_fault",
            format!("The board failed run #{} on {}", run.number, opt_str(&run.ticket_id)),
            head_chars(&what, 400),
        ));
    }
    Some(("run_failed", format!("Run #{} on {} {verb}", run.number, opt_str(&run.ticket_id)), head_chars(&reason, 400)))
}

/// A page was published: for the people who follow its space or the page (not the author).
pub async fn on_page_published(page: &Value, note: Option<&str>) {
    if let Err(e) = page_published(page, note).await {
        tracing::error!("Could not write the publish notification: {e}");
    }
}

async fn page_published(page: &Value, note: Option<&str>) -> Result<()> {
    let session = kb_db::session();
    let get = |key: &str| page.get(key).cloned().unwrap_or(Value::Null);
    let project_id = as_str(page.get("project_id")).map(str::to_string);
    let page_id = as_str(page.get("id")).map(str::to_string);
    let mut keys = followers(&session, "space", project_id.as_deref()).await?;
    keys.extend(followers(&session, "page", page_id.as_deref()).await?);
    let author = match page.get("updated_by").filter(|v| truthy(Some(v))) {
        Some(v) => kb_base::pyjson::py_str(v),
        None => "user".to_string(),
    };
    let mut data = Map::new();
    data.insert("version".into(), get("version"));
    data.insert("path".into(), get("path"));
    emit(
        "page_published",
        Some(&session),
        EmitFields {
            project_id,
            recipients: keys,
            title: format!(
                "{author} published v{} of {}",
                kb_base::pyjson::py_str(&get("version")),
                kb_base::pyjson::py_str(&get("title"))
            ),
            body: Some(head_chars(note.unwrap_or("").trim(), 300)),
            target_kind: Some("page".into()),
            target_id: page_id.clone(),
            page_id,
            actor: Some(author),
            data: Some(data),
            ..Default::default()
        },
    )
    .await?;
    Ok(())
}

/// The tasks `comment_event` started for a process without the loop; tests wait for them.
static BACKGROUND: LazyLock<Mutex<Vec<JoinHandle<()>>>> = LazyLock::new(|| Mutex::new(Vec::new()));

/// Wait for the tasks `comment_event` started (the Python tests do this between tests).
pub async fn drain_background() {
    loop {
        let handles: Vec<JoinHandle<()>> = std::mem::take(&mut *BACKGROUND.lock().unwrap_or_else(|e| e.into_inner()));
        if handles.is_empty() {
            return;
        }
        for h in handles {
            let _ = h.await;
        }
    }
}

/// What a Docs comment event says (the columns of `DocsCommentEvent` that `on_comment_event` reads).
#[derive(Debug, Clone)]
pub struct CommentFields {
    /// The project.
    pub project_id: String,
    /// The page.
    pub page_id: Option<String>,
    /// The thread.
    pub thread_id: Option<String>,
    /// The comment.
    pub comment_id: Option<String>,
    /// created, reply, resolved, reopened, access_request...
    pub kind: String,
    /// Who did it.
    pub actor: String,
    /// JSON list of the names mentioned.
    pub mentioned: String,
    /// JSON list of the names to tell.
    pub recipients: String,
    /// The page's title.
    pub page_title: String,
    /// The comment's first words.
    pub snippet: String,
}

/// Called where a Docs comment event is added. In the board's server the loop writes it within a second; in a
/// process without the loop (the stdio MCP server) it is written by a task started now. Python waits for
/// `session` to commit first (`after_commit`); a Rust caller commits its session before calling this.
pub fn comment_event(e: &docs_comment_event::Model) {
    let fields = CommentFields {
        project_id: e.project_id.clone(),
        page_id: e.page_id.clone(),
        thread_id: e.thread_id.clone(),
        comment_id: e.comment_id.clone(),
        kind: e.kind.clone(),
        actor: e.actor.clone(),
        mentioned: e.mentioned.clone(),
        recipients: e.recipients.clone(),
        page_title: e.page_title.clone(),
        snippet: e.snippet.clone(),
    };
    if crate::lifecycle::loop_running() {
        crate::delivery::LATER.lock().unwrap_or_else(|e| e.into_inner()).push_back(fields);
        crate::delivery::mark_dirty();
        return;
    }
    let Ok(handle) = tokio::runtime::Handle::try_current() else {
        return;
    };
    let task = handle.spawn(on_comment_event(fields));
    let mut background = BACKGROUND.lock().unwrap_or_else(|e| e.into_inner());
    background.retain(|t| !t.is_finished());
    background.push(task);
}

/// A Docs comment event: a mention is Needs you (replying or Dismiss closes it); a reply in a thread you follow and
/// an access request are for information.
pub async fn on_comment_event(fields: CommentFields) {
    if let Err(e) = comment_notices(&fields).await {
        tracing::error!("Could not write a comment notification: {e}");
    }
}

async fn comment_notices(e: &CommentFields) -> Result<()> {
    let session = kb_db::session();
    let names: Vec<Option<String>> =
        loads_list(Some(&e.recipients)).iter().map(|n| as_str(Some(n)).map(str::to_string)).collect();
    let mentioned: Vec<String> = loads_list(Some(&e.mentioned)).iter().map(|n| person_key(as_str(Some(n)))).collect();
    let who = if person_key(Some(&e.actor)) == "user" { "Someone".to_string() } else { e.actor.clone() };
    let refs: Vec<Option<&str>> = names.iter().map(|n| n.as_deref()).collect();
    let keys = recipient_keys(&session, Some(&e.project_id), &refs).await?;
    for key in keys {
        let (kind, title) = comment_notice(e, &who, mentioned.contains(&key));
        let data = data_of(json!({
            "page_title": e.page_title,
            "comment_id": e.comment_id,
            "event": e.kind,
        }));
        let has_thread = e.thread_id.as_deref().is_some_and(|t| !t.is_empty());
        emit(
            kind,
            Some(&session),
            EmitFields {
                project_id: Some(e.project_id.clone()),
                recipients: vec![key],
                title,
                body: Some(comment_body(e, kind)),
                target_kind: if has_thread { Some("thread".into()) } else { None },
                target_id: e.thread_id.clone(),
                page_id: e.page_id.clone(),
                actor: Some(e.actor.clone()),
                data,
                ..Default::default()
            },
        )
        .await?;
    }
    Ok(())
}

/// (kind, title) of a Docs comment event for one recipient.
pub fn comment_notice(e: &CommentFields, who: &str, mentioned: bool) -> (&'static str, String) {
    if e.kind == "access_request" {
        return ("access_request", format!("{who} asked for access to Docs"));
    }
    if mentioned {
        return ("mention", format!("{who} mentioned you"));
    }
    if e.kind == "resolved" || e.kind == "reopened" {
        return ("comment", format!("{who} {} a thread on {}", e.kind, e.page_title));
    }
    ("comment", "New reply in a thread you follow".to_string())
}

/// The comment's words; a reply in a followed thread says who wrote them.
pub fn comment_body(e: &CommentFields, kind: &str) -> String {
    if e.snippet.is_empty() {
        return String::new();
    }
    if kind == "comment" {
        return format!("{}: “{}”", e.actor, e.snippet);
    }
    format!("“{}”", e.snippet)
}
