//! What the comments take from the Docs AI (`services/assistant/docs.py` lines 949-1106): whether Docs AI is on for a
//! project, the member rows of the comments payload, the `ai_jobs` and `ai_summary` of a thread, and the delivery of
//! a mention of an AI member.
//!
//! The Docs AI is above this crate: each function asks the hook (`hooks::DocsAiHook`, `kb-assist` registers it) and,
//! while none is set, does what is in this file: the same reads over the same tables, and a [`deliver`] that answers
//! `not_delivered` where Python would start a job (the page's assistant).

use std::collections::HashSet;

use kb_db::Session;
use kb_db::database::insert_missing;
use kb_db::entities::{ai_team, docs_ai_job, docs_ai_settings, docs_page, member, project};
use kb_db::sea_orm::ActiveValue::Set;
use kb_db::sea_orm::{ColumnTrait, EntityTrait, QueryFilter, QueryOrder};
use serde_json::{Map, Value, json};

use super::json_list;
use crate::util::casefold;
use crate::{Result, hooks};

/// The kinds of job that belong to a thread.
const THREAD_KINDS: [&str; 2] = ["thread_reply", "thread_summary"];
/// `jobs.ACTIVE`.
const ACTIVE: [&str; 2] = ["queued", "running"];

/// Whether Docs AI is on for the project (`docs_ai_on`: `settings.require_enabled` without the error).
///
/// A project without a settings row predates AI-1: its row is made on first use with Docs AI on, as it always was.
pub async fn docs_ai_on(session: &Session, project_id: &str) -> Result<bool> {
    if let Some(hook) = hooks::docs_ai() {
        return hook.docs_ai_on(session, project_id).await;
    }
    if project::Entity::find_by_id(project_id).one(session).await?.is_none() {
        return Ok(false);
    }
    let mut row = docs_ai_settings::Entity::find_by_id(project_id).one(session).await?;
    if row.is_none() {
        let mut new = docs_ai_settings::new();
        new.project_id = Set(project_id.to_string());
        new.enabled = Set(true);
        insert_missing(session, new).await?;
        session.commit().await?;
        row = docs_ai_settings::Entity::find_by_id(project_id).one(session).await?;
    }
    // `master_on` (the board-wide switch) is always true
    Ok(row.is_some_and(|r| r.enabled))
}

/// Members for the comments payload; AI members carry `ai` (their status for the @ picker) while Docs AI is on.
pub async fn member_rows(
    session: &Session,
    project_id: &str,
    members: &[member::Model],
    docs_ai: bool,
) -> Result<Vec<Value>> {
    if let Some(hook) = hooks::docs_ai() {
        return hook.member_rows(session, project_id, members, docs_ai).await;
    }
    let mut rows = Vec::new();
    for m in members {
        let mut row = Map::new();
        row.insert("id".into(), json!(m.id));
        row.insert("name".into(), json!(m.name));
        row.insert("color".into(), json!(m.color));
        row.insert("role".into(), json!(m.role));
        row.insert("kind".into(), json!(if m.kind.is_empty() { "human" } else { m.kind.as_str() }));
        if m.kind == "ai" && docs_ai {
            let team = ai_team::Entity::find_by_id(m.id.as_str()).one(session).await?;
            let status = match team {
                None => "unavailable",
                Some(t) if t.paused => "paused",
                Some(_) => "ready",
            };
            let note = match status {
                "paused" => "Paused",
                "unavailable" => "Not set up",
                _ => "",
            };
            row.insert(
                "ai".into(),
                json!({"status": status, "usable": status == "ready", "note": note, "provider": "claude-code"}),
            );
        }
        rows.push(Value::Object(row));
    }
    Ok(rows)
}

/// Add `ai_jobs` (assistant work going on in the thread) and `ai_summary` (the latest summary) to serialized
/// threads. Returns whether Docs AI is on.
pub async fn annotate(session: &Session, page: &docs_page::Model, threads: &mut [Map<String, Value>]) -> Result<bool> {
    if let Some(hook) = hooks::docs_ai() {
        return hook.annotate(session, page, threads).await;
    }
    for t in threads.iter_mut() {
        t.insert("ai_jobs".into(), json!([]));
        t.insert("ai_summary".into(), Value::Null);
    }
    if !docs_ai_on(session, &page.project_id).await? {
        return Ok(false);
    }
    if threads.is_empty() {
        return Ok(true);
    }
    let ids: Vec<String> = threads.iter().filter_map(|t| t["id"].as_str().map(str::to_string)).collect();
    let rows = docs_ai_job::Entity::find()
        .filter(docs_ai_job::Column::ThreadId.is_in(ids))
        .filter(docs_ai_job::Column::Kind.is_in(THREAD_KINDS))
        .order_by_asc(docs_ai_job::Column::QueuedAt)
        .all(session)
        .await?;
    for j in rows {
        let Some(t) = threads.iter_mut().find(|t| t["id"].as_str() == j.thread_id.as_deref()) else { continue };
        if ACTIVE.contains(&j.state.as_str()) {
            let steps = json_list(&j.steps);
            let step = steps.last().and_then(|s| s.get("text")).cloned().unwrap_or(Value::Null);
            if let Some(Value::Array(jobs)) = t.get_mut("ai_jobs") {
                jobs.push(json!({
                    "id": j.id,
                    "kind": j.kind,
                    "state": j.state,
                    "member_id": j.member_id,
                    "member_name": "Docs AI",
                    "step": step,
                }));
            }
        } else if j.kind == "thread_summary" && j.state == "finished" {
            let res = match kb_base::pyjson::loads(&j.result) {
                Some(Value::Object(m)) => m,
                _ => Map::new(),
            };
            if res.get("summary").is_some_and(kb_base::pyjson::truthy) {
                t.insert(
                    "ai_summary".into(),
                    json!({
                        "text": res["summary"],
                        "count": res.get("count").cloned().unwrap_or(json!(0)),
                        "cost": (j.cost_usd * 1e6).round() / 1e6,
                        "job_id": j.id,
                        "member_name": "Docs AI",
                        "at": j.ended_at,
                    }),
                );
            }
        }
    }
    Ok(true)
}

/// The AI members mentioned in the comment just saved: the page's assistant answers in the thread (one
/// `thread_reply` job). A comment an AI wrote is never delivered (no loops).
///
/// Returns `[{member_id, result: "job"|"notified"|"not_delivered", job_id?, reason?}]`; empty without an AI mention.
pub async fn deliver(session: &Session, thread: &Map<String, Value>, by: &str, intent: &str) -> Result<Vec<Value>> {
    if let Some(hook) = hooks::docs_ai() {
        return hook.deliver(session, thread, by, intent).await;
    }
    let comment = thread.get("comments").and_then(Value::as_array).and_then(|c| c.last()).cloned();
    let Some(comment) = comment.filter(|c| c.as_object().is_some_and(|o| !o.is_empty())) else { return Ok(Vec::new()) };
    if comment.get("ai").is_some_and(kb_base::pyjson::truthy) {
        return Ok(Vec::new());
    }
    let page_id = thread.get("page_id").and_then(Value::as_str).unwrap_or("");
    let Some(page) = docs_page::Entity::find_by_id(page_id).one(session).await? else { return Ok(Vec::new()) };
    let members = kb_doctext::docs_access::members_of(session, &page.project_id).await?;
    let ai_ids: HashSet<&str> = members.iter().filter(|m| m.kind == "ai").map(|m| m.id.as_str()).collect();
    let author = casefold(comment.get("author").and_then(Value::as_str).unwrap_or(""));
    if members.iter().any(|m| m.kind == "ai" && casefold(&m.name) == author) {
        return Ok(Vec::new());
    }
    let mentioned: Vec<String> = comment
        .get("mentions")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|m| m.get("id").and_then(Value::as_str))
        .filter(|id| ai_ids.contains(id))
        .map(str::to_string)
        .collect();
    if mentioned.is_empty() {
        return Ok(Vec::new());
    }
    let not_delivered = |reason: &str| -> Vec<Value> {
        mentioned.iter().map(|m| json!({"member_id": m, "result": "not_delivered", "reason": reason})).collect()
    };
    if !docs_ai_on(session, &page.project_id).await? {
        return Ok(not_delivered("Docs AI is off: the mention only notifies."));
    }
    if intent == "notify" {
        return Ok(mentioned.iter().map(|m| json!({"member_id": m, "result": "notified"})).collect());
    }
    // `engine.ready(...)` and `jobs.start(...)` are the hook's: the Docs AI is not in this server
    Ok(not_delivered("Docs AI is not available in this server build yet."))
}
