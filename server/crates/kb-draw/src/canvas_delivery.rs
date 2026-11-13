//! `services/canvas_delivery.py`: a mention of an AI team in a Canvas comment, delivered with what already exists (no
//! new job).
//!
//! A canvas of a **ticket** sends the note to that ticket's team (`messaging.deliver_to_ticket`: live when its lead
//! runs, else on its next turn). A canvas that is, or sits in, a **Docs page** sends it to the page
//! (`messaging.deliver_to_page`: the page's assistant answers when Docs AI is on). Any other canvas (an idea, a
//! comment) cannot deliver. The answer to the POST says what happened to each team, so the comment panel can show one
//! quiet line; nothing is toasted that did not run. A comment an AI wrote is never delivered (no loops), and the note
//! carries the hand-off depth the runs count.
//!
//! The calls into the AI team and the assistant go through `hooks::CanvasDelivery`; while it is not registered a note
//! is "not delivered" (`SEND_FAILED`) and the Docs assistant counts as off.

use kb_base::pyjson;
use kb_db::Session;
use kb_db::entities::{ai_run, ai_team, canvas, member, ticket};
use kb_db::sea_orm::{ColumnTrait, EntityTrait, QueryFilter, QueryOrder, QuerySelect};
use serde_json::{Map, Value, json};

use crate::Result;
use crate::canvas_comments::{is_word, plain_mentions};
use crate::hooks::{self, DeliverError};

/// A team that is not the ticket's.
pub const NOT_ON_TICKET: &str = "This team is not on this ticket.";
/// A canvas of an idea or a comment.
pub const ONLY_TICKET_OR_PAGE: &str =
    "A team answers a canvas comment only on a ticket's canvas or a Docs page's canvas.";
/// The generic reason.
pub const SEND_FAILED: &str = "The note could not be sent.";
/// Docs AI is off.
pub const DOCS_AI_OFF: &str =
    "The page's assistant is not available now (Docs AI is off or not ready): the note is only a comment on the page.";

/// The Docs page a canvas lives in or on, if any.
pub fn page_of(canvas: &canvas::Model) -> Option<String> {
    if let Some(page) = canvas.page_id.as_deref().filter(|p| !p.is_empty()) {
        return Some(page.to_string());
    }
    if matches!(canvas.owner_kind.as_str(), "doc" | "page") {
        return Some(canvas.owner_id.clone()).filter(|p| !p.is_empty());
    }
    None
}

/// The team a ticket's notes go to: its assignee when that is an AI team, else the team of its latest run (the same
/// choice `runs.deliver_to_ticket` makes).
pub async fn ticket_team(session: &Session, ticket_id: &str) -> Result<Option<String>> {
    let Some(t) = ticket::Entity::find_by_id(ticket_id).one(session).await? else { return Ok(None) };
    if let Some(assignee) = t.assignee.as_deref().filter(|a| !a.is_empty()) {
        if let Some(m) = member::Entity::find_by_id(assignee).one(session).await? {
            if m.kind == "ai" {
                return Ok(Some(m.id));
            }
        }
    }
    let last = ai_run::Entity::find()
        .filter(ai_run::Column::TicketId.eq(ticket_id))
        .order_by_desc(ai_run::Column::QueuedAt)
        .limit(1)
        .one(session)
        .await?;
    Ok(last.map(|r| r.member_id))
}

/// (status, note) of an AI team: `ready`, `paused` or `unavailable` (no team behind the member).
pub async fn status(session: &Session, m: &member::Model) -> Result<(&'static str, &'static str)> {
    Ok(match ai_team::Entity::find_by_id(&m.id).one(session).await? {
        None => ("unavailable", "Not set up"),
        Some(team) if team.paused => ("paused", "Paused"),
        Some(_) => ("ready", ""),
    })
}

/// The members the `@` picker of this canvas offers: the project's people, and its AI teams with whether each can be
/// asked here and now (a paused team, a team that is not on the ticket, a canvas that cannot deliver).
pub async fn mentionable(session: &Session, canvas: &canvas::Model) -> Result<Vec<Map<String, Value>>> {
    let Some(project_id) = canvas.project_id.as_deref().filter(|p| !p.is_empty()) else { return Ok(Vec::new()) };
    let rows = member::Entity::find()
        .filter(member::Column::ProjectId.eq(project_id))
        .order_by_asc(member::Column::CreatedAt)
        .all(session)
        .await?;
    let team_of_ticket =
        if canvas.owner_kind == "ticket" { ticket_team(session, &canvas.owner_id).await? } else { None };
    let page = page_of(canvas);
    let docs_ai = match (&page, hooks::canvas_delivery()) {
        (Some(_), Some(hook)) => hook.docs_ai_on(session, project_id).await?,
        _ => false,
    };
    let mut out = Vec::new();
    for m in rows {
        if m.kind == "ai_removed" {
            continue;
        }
        let mut row = Map::new();
        row.insert("id".into(), json!(m.id));
        row.insert("name".into(), json!(m.name));
        row.insert("color".into(), json!(m.color));
        row.insert("role".into(), json!(m.role));
        row.insert("kind".into(), json!(if m.kind == "ai" { "ai" } else { "human" }));
        if m.kind == "ai" {
            let (status, note) = status(session, &m).await?;
            let mut usable = status == "ready";
            let mut note = note;
            if usable && canvas.owner_kind == "ticket" && Some(&m.id) != team_of_ticket.as_ref() {
                (usable, note) = (false, "Not on this ticket");
            } else if usable && canvas.owner_kind != "ticket" && page.is_none() {
                (usable, note) = (false, "Ticket or page canvases only");
            } else if usable && page.is_some() && canvas.owner_kind != "ticket" && !docs_ai {
                (usable, note) = (false, "Docs AI is off");
            }
            row.insert(
                "ai".into(),
                json!({"status": status, "usable": usable, "note": note, "provider": "claude-code"}),
            );
        }
        out.push(row);
    }
    Ok(out)
}

/// `re.sub(r"(?<!\w)@(?=\w)", "", text)`: an `@` that starts a word is dropped.
fn drop_word_at(text: &str) -> String {
    let chars: Vec<char> = text.chars().collect();
    let mut out = String::with_capacity(text.len());
    for (i, &c) in chars.iter().enumerate() {
        let starts_word =
            c == '@' && (i == 0 || !is_word(chars[i - 1])) && chars.get(i + 1).is_some_and(|&n| is_word(n));
        if !starts_word {
            out.push(c);
        }
    }
    out
}

/// What the team is told: who mentioned it, where, the comment, and how to answer on the same thread.
pub fn note(canvas: &canvas::Model, thread: &Map<String, Value>, comment: &Map<String, Value>, by: &str) -> String {
    let mut place = format!("canvas \u{201c}{}\u{201d} (canvas_id {}", canvas.title, canvas.id);
    if let Some(board) = thread.get("board_id").filter(|b| pyjson::truthy(b)) {
        place.push_str(&format!(", board_id {}", board.as_str().unwrap_or_default()));
    }
    place.push_str(&format!(", thread_id {})", thread.get("id").and_then(Value::as_str).unwrap_or_default()));
    let folded = by.to_lowercase();
    let who = if matches!(folded.as_str(), "user" | "you" | "me") { "A person on the board" } else { by };
    // no `@` before a name: a page comment with `@Name` would notify that person a second time
    let unmentioned = drop_word_at(&plain_mentions(comment.get("body").and_then(Value::as_str).unwrap_or("")));
    format!(
        "{who} mentioned you in a comment on the {place}:\n\n{unmentioned}\n\nRead the canvas with docs_read(canvas, canvas_id=\u{2026}) and answer in that thread with docs_write(canvas_comment, canvas_id=\u{2026}, thread_id=\u{2026}). Change a board only if the comment asks for it."
    )
}

fn fail(m: &member::Model, reason: &str) -> Map<String, Value> {
    let mut out = Map::new();
    out.insert("member_id".into(), json!(m.id));
    out.insert("name".into(), json!(m.name));
    out.insert("result".into(), json!("not_delivered"));
    out.insert("reason".into(), json!(reason));
    out
}

fn delivered(m: &member::Model) -> Map<String, Value> {
    let mut out = Map::new();
    out.insert("member_id".into(), json!(m.id));
    out.insert("name".into(), json!(m.name));
    out.insert("result".into(), json!("delivered"));
    out
}

/// Deliver the AI teams the newest comment of a thread mentions.
///
/// Returns `[{member_id, name, result: "delivered" | "not_delivered", reason?}]`; empty when no team is mentioned or
/// the comment was written by an AI.
pub async fn deliver(
    session: &Session,
    canvas: &canvas::Model,
    thread: &Map<String, Value>,
    by: &str,
) -> Result<Vec<Map<String, Value>>> {
    let empty = Map::new();
    let comment = thread
        .get("comments")
        .and_then(Value::as_array)
        .and_then(|c| c.last())
        .and_then(Value::as_object)
        .unwrap_or(&empty);
    if comment.is_empty()
        || comment.get("is_ai").is_some_and(pyjson::truthy)
        || comment.get("ai").is_some_and(pyjson::truthy)
    {
        return Ok(Vec::new());
    }
    let mention_ids: Vec<&str> = comment
        .get("mentions")
        .and_then(Value::as_array)
        .map(|a| a.iter().filter_map(Value::as_str).collect())
        .unwrap_or_default();
    let Some(project_id) = canvas.project_id.as_deref().filter(|p| !p.is_empty()) else { return Ok(Vec::new()) };
    if mention_ids.is_empty() {
        return Ok(Vec::new());
    }
    let members = member::Entity::find().filter(member::Column::ProjectId.eq(project_id)).all(session).await?;
    let teams: Vec<&member::Model> = members.iter().filter(|m| m.kind == "ai").collect();
    let author = caseless::default_case_fold_str(comment.get("author").and_then(Value::as_str).unwrap_or(""));
    if teams.iter().any(|m| caseless::default_case_fold_str(&m.name) == author) {
        return Ok(Vec::new());
    }
    let mentioned: Vec<&member::Model> =
        mention_ids.iter().filter_map(|id| teams.iter().find(|m| m.id == *id).copied()).collect();
    if mentioned.is_empty() {
        return Ok(Vec::new());
    }
    let note = note(canvas, thread, comment, by);
    let page = page_of(canvas);
    let mut results: Vec<Map<String, Value>> = Vec::new();
    if canvas.owner_kind == "ticket" {
        let team_id = ticket_team(session, &canvas.owner_id).await?;
        // one note reaches the ticket's team, however many times it is named
        let mut sent: Option<Option<String>> = None;
        for m in mentioned {
            if Some(&m.id) != team_id.as_ref() {
                results.push(fail(m, NOT_ON_TICKET));
                continue;
            }
            let (state, why) = status(session, m).await?;
            if state != "ready" {
                results.push(fail(m, &format!("{} is {}.", m.name, why.to_lowercase())));
                continue;
            }
            if sent.is_none() {
                sent = Some(match hooks::canvas_delivery() {
                    // a person's note: depth 0, and the run is told it came from comment threads, not from another AI
                    Some(hook) => match hook.deliver_to_ticket(&canvas.owner_id, &note, by, "docs_threads", 0).await {
                        Ok(()) => None,
                        Err(DeliverError::Run(text)) => {
                            Some(if text.is_empty() { SEND_FAILED.to_string() } else { text })
                        }
                        Err(DeliverError::Value(e) | DeliverError::Other(e)) => {
                            tracing::error!("Could not deliver a canvas note to a ticket's team: {e}");
                            Some(SEND_FAILED.to_string())
                        }
                    },
                    None => Some(SEND_FAILED.to_string()),
                });
            }
            match sent.as_ref().and_then(Option::as_ref) {
                Some(reason) => results.push(fail(m, reason)),
                None => results.push(delivered(m)),
            }
        }
    } else if let Some(page) = page {
        let mut ready: Vec<&member::Model> = Vec::new();
        for m in mentioned {
            let (state, why) = status(session, m).await?;
            if state == "ready" {
                ready.push(m);
            } else {
                results.push(fail(m, &format!("{} is {}.", m.name, why.to_lowercase())));
            }
        }
        if !ready.is_empty() {
            let mut answered = false;
            let mut reason = DOCS_AI_OFF.to_string();
            match hooks::canvas_delivery() {
                Some(hook) => match hook.deliver_to_page(&page, &note, by, 0).await {
                    Ok(delivered) => answered = delivered.as_deref() == Some("page_assistant"),
                    // the note could not be left on the page
                    Err(DeliverError::Value(text)) => {
                        reason = if text.is_empty() { SEND_FAILED.to_string() } else { text };
                    }
                    Err(DeliverError::Run(e) | DeliverError::Other(e)) => {
                        tracing::error!("Could not deliver a canvas note to a Docs page: {e}");
                        reason = SEND_FAILED.to_string();
                    }
                },
                None => reason = SEND_FAILED.to_string(),
            }
            for m in ready {
                results.push(if answered { delivered(m) } else { fail(m, &reason) });
            }
        }
    } else {
        results = mentioned.into_iter().map(|m| fail(m, ONLY_TICKET_OR_PAGE)).collect();
    }
    Ok(results)
}
