//! `api/docs_ai/tickets.py`: from a page to tickets (draft with the assistant, create, undo).

use axum::Json;
use axum::http::HeaderMap;
use kb_base::error::{Body, OptionalBody, Path};
use kb_base::{Routes, events};
use serde::Deserialize;
use serde_json::{Value, json};

use super::settings::docs;
use crate::api::{Res, by, docs_ai_failure};
use crate::assistant::docs as svc;
use crate::docs_ai::jobs::{self, NewJob};
use crate::docs_ai::settings as svc_settings;

/// The routes of this file.
pub fn routes() -> Routes {
    Routes::new()
        .post("/docs/pages/{page_id}/ai/tickets/draft", draft_tickets)
        .post("/docs/pages/{page_id}/ai/tickets/create", create_tickets)
        .post("/docs/ai/tickets/undo", undo_tickets)
}

/// The selection to draft tickets from (the whole page when empty).
#[derive(Debug, Deserialize)]
struct DraftBody {
    #[serde(default)]
    selection: Option<String>,
}

/// Draft tickets from the open items of a page or a selection (a job: `result.drafts`, `result.skipped`). Nothing is
/// created.
async fn draft_tickets(
    headers: HeaderMap,
    Path(page_id): Path<String>,
    OptionalBody(body): OptionalBody<DraftBody>,
) -> Res<Json<Value>> {
    let session = kb_db::session();
    let page = kb_docs::docs::get_page(&session, &page_id, false, true).await.map_err(|e| docs(&headers, e))?;
    svc_settings::require_enabled(&session, &page.project_id).await.map_err(|e| docs_ai_failure(&headers, e))?;
    svc::ready_or_raise(&page.project_id).await.map_err(|e| docs_ai_failure(&headers, e))?;
    let selection = body.and_then(|b| b.selection);
    let job = jobs::start(
        &session,
        NewJob {
            project_id: page.project_id.clone(),
            kind: "tickets_draft".to_string(),
            started_by: by(),
            page_id: Some(page.id.clone()),
            instruction: "Draft tickets from this page".to_string(),
            result: Some(json!({"input": {"selection": selection}})),
            ..Default::default()
        },
    )
    .await?;
    Ok(Json(Value::Object(jobs::to_dict(&job))))
}

/// One reviewed ticket draft.
#[derive(Debug, Deserialize)]
struct TicketDraft {
    title: String,
    #[serde(default)]
    text: String,
    #[serde(default = "task")]
    r#type: String,
    #[serde(default = "backlog")]
    column: String,
    #[serde(default)]
    project_id: Option<String>,
    #[serde(default)]
    assignee_id: Option<String>,
    #[serde(default)]
    due_date: Option<String>,
}

fn task() -> String {
    "task".to_string()
}

fn backlog() -> String {
    "backlog".to_string()
}

/// The reviewed drafts to create as tickets.
#[derive(Debug, Deserialize)]
struct CreateBody {
    drafts: Vec<TicketDraft>,
    #[serde(default)]
    #[allow(dead_code)]
    replace_text: bool,
    #[serde(default = "yes")]
    link: bool,
}

fn yes() -> bool {
    true
}

/// Create the drafts as tickets and link them to the page. Returns `{tickets, undo_token, replaced, linked}`.
async fn create_tickets(
    headers: HeaderMap,
    Path(page_id): Path<String>,
    Body(body): Body<CreateBody>,
) -> Res<Json<Value>> {
    let session = kb_db::session();
    let drafts: Vec<Value> = body
        .drafts
        .iter()
        .map(|d| {
            json!({
                "title": d.title, "text": d.text, "type": d.r#type, "column": d.column,
                "project_id": d.project_id, "assignee_id": d.assignee_id, "due_date": d.due_date,
            })
        })
        .collect();
    let out = svc::create_tickets(&session, &page_id, &by(), &drafts, body.link)
        .await
        .map_err(|e| docs_ai_failure(&headers, e))?;
    events::publish(events::INVALIDATE, &[]).await;
    Ok(Json(Value::Object(out)))
}

/// The token a creation returned.
#[derive(Debug, Deserialize)]
struct UndoBody {
    undo_token: String,
}

/// Delete the tickets a creation made.
async fn undo_tickets(headers: HeaderMap, Body(body): Body<UndoBody>) -> Res<Json<Value>> {
    let session = kb_db::session();
    let out = svc::undo_tickets(&session, &body.undo_token, &by()).await.map_err(|e| docs_ai_failure(&headers, e))?;
    events::publish(events::INVALIDATE, &[]).await;
    Ok(Json(Value::Object(out)))
}
