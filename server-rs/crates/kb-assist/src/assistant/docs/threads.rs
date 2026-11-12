//! Comment threads, the @mentions of an AI member in a thread, and what the comments list shows of the assistant
//! (`services/assistant/docs.py`, lines 730 to 1106).

use std::collections::HashSet;

use kb_ai::store::loads;
use kb_base::{activity, ctx, pyjson, pytext};
use kb_db::Session;
use kb_db::database;
use kb_db::entities::{ai_team, docs_ai_job, docs_comment_thread, docs_page, member};
use kb_db::sea_orm::{ColumnTrait, EntityTrait, QueryFilter, QueryOrder};
use serde_json::{Map, Value, json};

use super::super::engine::{self, Schema};
use super::super::sessions;
use super::super::settings as svc_assist;
use super::{TurnExtra, boxed, clip, cost, get, get_or, input, items, merge, ready_or_raise, text_of, turn};
use crate::docs_ai::errors::Error;
use crate::docs_ai::handoff;
use crate::docs_ai::jobs::{self, HandlerFuture, NewJob};
use crate::docs_ai::settings as svc_settings;

/// `_thread_inputs`: the page of a thread and what a turn about it is given.
async fn thread_inputs(thread_id: &str) -> Result<(docs_page::Model, Map<String, Value>), Error> {
    let (thread, page) = {
        let session = database::session();
        let thread = kb_docs::docs_comments::get_thread(&session, thread_id).await?;
        let page_id = text_of(&get(&thread, "page_id"));
        let page = docs_page::Entity::find_by_id(page_id.as_str()).one(&session).await?;
        (thread, page)
    };
    let Some(page) = page else {
        return Err(Error::Other("AttributeError: 'NoneType' object has no attribute 'id'".to_string()));
    };
    let comments: Vec<Value> = items(thread.get("comments"))
        .iter()
        .map(|c| json!({"author": c.get("author").cloned().unwrap_or(Value::Null), "body": c.get("body").cloned().unwrap_or(Value::Null)}))
        .collect();
    let anchor_quote = thread
        .get("anchor_quote")
        .filter(|v| pyjson::truthy(v))
        .cloned()
        .unwrap_or_else(|| thread.get("anchor").and_then(|a| a.get("quote")).cloned().unwrap_or(Value::Null));
    let mut inputs = Map::new();
    inputs.insert("page_id".into(), json!(page.id));
    inputs.insert("thread_id".into(), json!(thread_id));
    inputs.insert("quote".into(), anchor_quote);
    inputs.insert("comments".into(), Value::Array(comments));
    Ok((page, inputs))
}

/// The summary of a long comment thread.
pub fn thread_summary_job(job: docs_ai_job::Model) -> HandlerFuture {
    boxed(async move {
        let (_page_row, inputs) = thread_inputs(job.thread_id.as_deref().unwrap_or("")).await?;
        let mut given = Map::new();
        given.insert("task".into(), json!("summary"));
        given.extend(inputs);
        let schema = Schema::Given(json!({
            "type": "object",
            "properties": {"summary": {"type": "string"}},
            "required": ["summary"],
        }));
        let extra = TurnExtra { schema: Some(schema), depth: 0 };
        let out = turn(&job, "docs-thread", given, None, extra).await?;
        let data = out.data();
        let text = get_or(&data, "summary", get_or(&data, "reply", json!(out.text)));
        let mut result = Map::new();
        result.insert("summary".into(), text);
        Ok(merge(result, cost(&out)))
    })
}

/// Whether `author` (or the board's agent) commented in the job's thread after the job started.
async fn posted_since(session: &Session, job: &docs_ai_job::Model, author: Option<&str>) -> Result<bool, Error> {
    let thread = kb_docs::docs_comments::get_thread(session, job.thread_id.as_deref().unwrap_or("")).await?;
    let since = job.started_at.clone().filter(|s| !s.is_empty()).unwrap_or_else(|| job.queued_at.clone());
    let mut names: Vec<&str> = Vec::new();
    if let Some(author) = author.filter(|a| !a.is_empty()) {
        names.push(author);
    }
    names.push("agent");
    Ok(items(thread.get("comments")).iter().any(|c| {
        let author_of = c.get("author").and_then(Value::as_str).unwrap_or("");
        let at = c.get("created_at").filter(|v| pyjson::truthy(v)).and_then(Value::as_str).unwrap_or("");
        let kind = c.get("ai").filter(|v| pyjson::truthy(v)).and_then(|ai| ai.get("kind")).and_then(Value::as_str);
        c.get("author").and_then(Value::as_str).is_some()
            && names.contains(&author_of)
            && at >= since.as_str()
            && kind != Some("sent")
    }))
}

/// An @mention of the AI in a thread: the assistant answers in the thread.
pub fn thread_reply_job(job: docs_ai_job::Model) -> HandlerFuture {
    boxed(async move {
        let (_page_row, inputs) = thread_inputs(job.thread_id.as_deref().unwrap_or("")).await?;
        let mut given = Map::new();
        given.insert("task".into(), json!("reply"));
        given.extend(inputs);
        let depth = match get(&input(&job), "depth") {
            Value::Number(n) => n.as_i64().unwrap_or(0),
            _ => 0,
        };
        let out = turn(&job, "docs-thread", given, None, TurnExtra { schema: None, depth }).await?;
        let data = out.data();
        let reply = pytext::strip(&text_of(&or_default_text(data.get("reply"), &out.text))).to_string();
        let mut comment_id = Value::Null;
        let (team, already) = {
            let session = database::session();
            let team = svc_assist::answering_team(&session, &job.project_id, "docs").await?;
            let name = team.as_ref().map(|(m, _)| m.name.clone());
            // the assistant often posts its answer itself (docs_write reply) and then forgets `posted: true` in its
            // JSON: a comment of the answering team since the job began means it is already in the thread
            let already = posted_since(&session, &job, name.as_deref()).await?;
            (name, already)
        };
        if !reply.is_empty() && !data.get("posted").is_some_and(pyjson::truthy) && !already {
            let token = activity::set_actor(Some(team.as_deref().unwrap_or(activity::AGENT_ACTOR)));
            let posted = async {
                let session = database::session();
                let ai = json!({"job_id": job.id, "member": "Docs AI"});
                kb_docs::docs_comments::add_reply(&session, job.thread_id.as_deref().unwrap_or(""), &reply, Some(&ai))
                    .await
            }
            .await;
            ctx::reset(token);
            let thread = posted?;
            let last = items(thread.get("comments")).last().cloned().unwrap_or_else(|| json!({}));
            comment_id = last.get("id").cloned().unwrap_or(Value::Null);
        }
        if pyjson::truthy(&comment_id) {
            jobs::update(&job.id, &[("reply_comment_id", comment_id)]).await?;
        }
        let mut result = Map::new();
        result.insert("reply".into(), json!(reply));
        result.insert("posted".into(), json!(true));
        Ok(merge(result, cost(&out)))
    })
}

/// `data.get(key) or fallback` for a text.
fn or_default_text(value: Option<&Value>, fallback: &str) -> Value {
    super::or_default(value, json!(fallback))
}

/// Comment threads sent to the Board AI: it finds the ticket whose team should work them and hands over the note
/// (`ai_run message`), or answers them itself. Each thread gets a line saying what it did.
pub fn docs_route_job(job: docs_ai_job::Model) -> HandlerFuture {
    boxed(async move {
        let inp = input(&job);
        let mut inputs = Map::new();
        inputs.insert("page_id".into(), json!(job.page_id));
        for key in ["thread_ids", "tickets", "teams", "note"] {
            inputs.insert(key.into(), get(&inp, key));
        }
        let name = sessions::board_name(&job.project_id);
        let out = turn(&job, "docs-route", inputs, Some(name), TurnExtra { schema: None, depth: 0 }).await?;
        let data = out.data();
        let text = |key: &str| pytext::strip(&text_of(&get_or(&data, key, json!("")))).to_string();
        let decision = text("decision").to_lowercase();
        let mut ticket = text("ticket_id");
        if matches!(ticket.to_lowercase().as_str(), "null" | "none" | "-") {
            ticket = String::new();
        }
        let reason = text("reason");
        let line = match decision.as_str() {
            "sent" => format!(
                "The Board AI sent this to {}'s team.",
                if ticket.is_empty() { "a ticket" } else { ticket.as_str() }
            ),
            "answered" => "The Board AI worked on this itself.".to_string(),
            _ => "The Board AI left this for a person.".to_string(),
        };
        let token = activity::set_actor(Some("Board AI"));
        let body = format!("{line}{}", if reason.is_empty() { String::new() } else { format!(" {reason}") });
        let meta = json!({"kind": "sent", "ticket_id": if ticket.is_empty() { Value::Null } else { json!(ticket) }, "via": "board_ai"});
        for tid in items(inp.get("thread_ids")) {
            let session = database::session();
            if let Err(err) = kb_docs::docs_comments::add_board_note(&session, &text_of(&tid), &body, &meta).await {
                // the thread may be gone; the job's result still says it
                tracing::debug!(target: "kanban.assistant", "no note on thread {}: {err}", text_of(&tid));
            }
        }
        ctx::reset(token);
        let mut result = Map::new();
        result.insert("decision".into(), json!(decision));
        result.insert("ticket_id".into(), if ticket.is_empty() { Value::Null } else { json!(ticket) });
        result.insert("reason".into(), json!(reason));
        Ok(merge(result, cost(&out)))
    })
}

/// Start an assistant job on a comment thread.
pub async fn start_thread_job(
    session: &Session,
    thread_id: &str,
    kind: &str,
    by: &str,
    instruction: &str,
) -> Result<docs_ai_job::Model, Error> {
    let thread = kb_docs::docs_comments::get_thread(session, thread_id).await?;
    let page = kb_docs::docs::get_page(session, &text_of(&get(&thread, "page_id")), false, false).await?;
    svc_settings::require_enabled(session, &page.project_id).await?;
    ready_or_raise(&page.project_id).await?;
    Ok(jobs::start(
        session,
        NewJob {
            project_id: page.project_id.clone(),
            kind: kind.to_string(),
            started_by: by.to_string(),
            page_id: Some(page.id.clone()),
            thread_id: Some(thread_id.to_string()),
            instruction: clip(instruction, 300),
            ..Default::default()
        },
    )
    .await?)
}

// ---------------------------------------------------------------------------
// @mentions of an AI member in a thread, and what the comments list shows of the assistant
// ---------------------------------------------------------------------------

/// The kinds of job that belong to a thread.
pub const THREAD_KINDS: [&str; 2] = ["thread_reply", "thread_summary"];

/// Whether Docs AI is on for the project.
pub async fn docs_ai_on(session: &Session, project_id: &str) -> Result<bool, Error> {
    match svc_settings::require_enabled(session, project_id).await {
        Ok(_) => Ok(true),
        Err(Error::DocsAi(_)) => Ok(false),
        Err(other) => Err(other),
    }
}

/// Members for the comments payload; AI members carry `ai` (their status for the @ picker) while Docs AI is on.
pub async fn member_rows(
    session: &Session,
    _project_id: &str,
    members: &[member::Model],
    docs_ai: bool,
) -> Result<Vec<Value>, Error> {
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
pub async fn annotate(
    session: &Session,
    page: &docs_page::Model,
    threads: &mut [Map<String, Value>],
) -> Result<bool, Error> {
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
    let ids: Vec<String> = threads.iter().map(|t| text_of(&get(t, "id"))).collect();
    let rows = docs_ai_job::Entity::find()
        .filter(docs_ai_job::Column::ThreadId.is_in(ids))
        .filter(docs_ai_job::Column::Kind.is_in(THREAD_KINDS))
        .order_by_asc(docs_ai_job::Column::QueuedAt)
        .all(session)
        .await?;
    for j in rows {
        let Some(t) = threads.iter_mut().find(|t| t.get("id").and_then(Value::as_str) == j.thread_id.as_deref()) else {
            continue;
        };
        if jobs::ACTIVE.contains(&j.state.as_str()) {
            let steps = items(Some(&loads(Some(&j.steps), json!([]))));
            let step = steps.last().and_then(|s| s.get("text")).cloned().unwrap_or(Value::Null);
            if let Some(Value::Array(list)) = t.get_mut("ai_jobs") {
                list.push(json!({
                    "id": j.id,
                    "kind": j.kind,
                    "state": j.state,
                    "member_id": j.member_id,
                    "member_name": "Docs AI",
                    "step": step,
                }));
            }
        } else if j.kind == "thread_summary" && j.state == "finished" {
            let res = match loads(Some(&j.result), json!({})) {
                Value::Object(map) => map,
                _ => Map::new(),
            };
            if res.get("summary").is_some_and(pyjson::truthy) {
                t.insert(
                    "ai_summary".into(),
                    json!({
                        "text": res["summary"],
                        "count": res.get("count").cloned().unwrap_or(json!(0)),
                        "cost": super::super::settings::round_to(j.cost_usd.get(), 6),
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
pub async fn deliver(
    session: &Session,
    thread: &Map<String, Value>,
    by: &str,
    intent: &str,
) -> Result<Vec<Value>, Error> {
    let comment = items(thread.get("comments")).last().cloned();
    let Some(comment) = comment.filter(|c| c.as_object().is_some_and(|o| !o.is_empty())) else { return Ok(Vec::new()) };
    if comment.get("ai").is_some_and(pyjson::truthy) {
        return Ok(Vec::new());
    }
    let page_id = text_of(&get(thread, "page_id"));
    let Some(page) = docs_page::Entity::find_by_id(page_id.as_str()).one(session).await? else { return Ok(Vec::new()) };
    let members = kb_doctext::docs_access::members_of(session, &page.project_id).await?;
    let ai_ids: HashSet<&str> = members.iter().filter(|m| m.kind == "ai").map(|m| m.id.as_str()).collect();
    let author = kb_docs::util::casefold(
        comment.get("author").filter(|v| pyjson::truthy(v)).and_then(Value::as_str).unwrap_or(""),
    );
    if members.iter().any(|m| m.kind == "ai" && kb_docs::util::casefold(&m.name) == author) {
        return Ok(Vec::new());
    }
    let mentioned: Vec<String> = items(comment.get("mentions"))
        .iter()
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
    let info = engine::ready(&page.project_id, "docs").await?;
    if info.get("state").and_then(Value::as_str) != Some("ready") {
        return Ok(not_delivered(&text_of(&get(&info, "message"))));
    }
    let job = jobs::start(
        session,
        NewJob {
            project_id: page.project_id.clone(),
            kind: "thread_reply".to_string(),
            started_by: by.to_string(),
            page_id: Some(page.id.clone()),
            thread_id: Some(text_of(&get(thread, "id"))),
            comment_id: comment.get("id").and_then(Value::as_str).map(str::to_string),
            member_id: Some(mentioned[0].clone()),
            instruction: clip(&text_of(&get_or(comment.as_object().unwrap_or(&Map::new()), "body", json!(""))), 300),
            ..Default::default()
        },
    )
    .await?;
    let mut out = vec![json!({"member_id": mentioned[0], "result": "job", "job_id": job.id})];
    out.extend(mentioned[1..].iter().map(|m| json!({"member_id": m, "result": "notified"})));
    Ok(out)
}

/// Start the Board AI on threads a person sent to it (`groups`: [(page, [thread])]; `note`: the fenced note).
pub async fn start_route_job(
    session: &Session,
    groups: &[(docs_page::Model, Vec<docs_comment_thread::Model>)],
    by: &str,
    note: &str,
) -> Result<docs_ai_job::Model, Error> {
    let page = &groups[0].0;
    svc_settings::require_enabled(session, &page.project_id).await?;
    ready_or_raise(&page.project_id).await?;
    let info = handoff::targets(session, &page.id).await?;
    let pick = |v: &Value, key: &str| v.get(key).cloned().unwrap_or(Value::Null);
    let tickets: Vec<Value> = items(info.get("tickets"))
        .iter()
        .map(|t| {
            let team = t.get("team").filter(|v| pyjson::truthy(v)).cloned().unwrap_or_else(|| json!({}));
            let relations: Vec<Value> = items(t.get("relations")).iter().map(|r| pick(r, "label")).collect();
            json!({
                "id": pick(t, "id"),
                "title": pick(t, "title"),
                "status": pick(t, "status"),
                "team": team.get("name").cloned().unwrap_or(Value::Null),
                "state": team.get("state").cloned().unwrap_or(json!("none")),
                "relations": relations,
            })
        })
        .collect();
    let thread_ids: Vec<Value> = groups.iter().flat_map(|(_, ts)| ts.iter().map(|th| json!(th.id))).collect();
    Ok(jobs::start(
        session,
        NewJob {
            project_id: page.project_id.clone(),
            kind: "docs_route".to_string(),
            started_by: by.to_string(),
            page_id: Some(page.id.clone()),
            instruction: clip("Route the threads sent from the page", 300),
            result: Some(json!({"input": {
                "note": note,
                "thread_ids": thread_ids,
                "tickets": tickets,
                "teams": get(&info, "teams"),
            }})),
            ..Default::default()
        },
    )
    .await?)
}
