//! `api/docs_ai/ask.py`: Ask the docs. `POST …/docs/ai/ask` starts a job (kind `ask`); the UI polls
//! `GET /docs/ai/jobs/{id}`. The answer is written by the Docs assistant with the `docs-ask` skill.

use axum::Json;
use axum::http::{HeaderMap, StatusCode};
use kb_base::Routes;
use kb_base::error::{Body, Path};
use kb_db::entities::project;
use kb_db::sea_orm::EntityTrait;
use kb_doctext::docs_access;
use serde::Deserialize;
use serde_json::{Value, json};

use super::settings::docs;
use crate::api::{Res, by, docs_ai_error, docs_ai_failure, squash};
use crate::assistant::docs as svc;
use crate::docs_ai::errors::DocsAiError;
use crate::docs_ai::jobs::{self, NewJob};
use crate::docs_ai::settings as svc_settings;

/// The routes of this file.
pub fn routes() -> Routes {
    Routes::new()
        .post("/projects/{project_id}/docs/ai/ask", post_ask)
        .post("/docs/ai/ask/{job_id}/chat", post_open_as_chat)
        .post("/docs/ai/ask/{job_id}/feedback", post_feedback)
        .post("/docs/pages/{page_id}/ai/report-stale", post_report_stale)
}

/// A question for the docs.
#[derive(Debug, Deserialize)]
struct AskBody {
    question: String,
    #[serde(default = "space")]
    scope: String,
    #[serde(default)]
    page_id: Option<String>,
}

fn space() -> String {
    "space".to_string()
}

/// Ask the docs. Result (when the job is finished): `{answer, verdict, citations, pages_read, pages_cited}`.
async fn post_ask(
    headers: HeaderMap,
    Path(project_id): Path<String>,
    Body(body): Body<AskBody>,
) -> Res<(StatusCode, Json<Value>)> {
    let session = kb_db::session();
    let fail = |e| docs_ai_failure(&headers, e);
    let Some(project) = project::Entity::find_by_id(project_id.as_str()).one(&session).await? else {
        return Err(docs_ai_error(&DocsAiError::new("not_found", "Project not found.")));
    };
    docs_access::require_reader(&session, &project).await.map_err(|e| docs(&headers, e))?;
    svc_settings::require_enabled(&session, &project_id).await.map_err(fail)?;
    let question = squash(&body.question);
    if question.is_empty() {
        return Err(docs_ai_error(&DocsAiError::new("invalid", "Write a question first.")));
    }
    if question.chars().count() > svc::MAX_QUESTION {
        return Err(docs_ai_error(&DocsAiError::new(
            "invalid",
            format!("Keep the question under {} characters.", svc::MAX_QUESTION),
        )));
    }
    if !svc::SCOPES.contains(&body.scope.as_str()) {
        return Err(docs_ai_error(&DocsAiError::new("invalid", "Scope: this space, this page or all my projects.")));
    }
    let mut page_id: Option<String> = None;
    if body.scope == "page" {
        let page = kb_docs::docs::get_page(&session, body.page_id.as_deref().unwrap_or(""), false, false)
            .await
            .map_err(|e| docs(&headers, e))?;
        if page.project_id != project_id {
            return Err(docs_ai_error(&DocsAiError::new("invalid", "That page is not in this space.")));
        }
        page_id = Some(page.id);
    }
    svc::ready_or_raise(&project_id).await.map_err(fail)?;
    let job = jobs::start(
        &session,
        NewJob {
            project_id: project_id.clone(),
            kind: "ask".to_string(),
            started_by: by(),
            page_id: page_id.clone(),
            instruction: question.clone(),
            result: Some(json!({"question": question, "scope": body.scope, "page_id": page_id})),
            ..Default::default()
        },
    )
    .await?;
    Ok((StatusCode::ACCEPTED, Json(Value::Object(jobs::to_dict(&job)))))
}

/// "Open as chat": a Board AI chat holding the question and the finished answer.
async fn post_open_as_chat(headers: HeaderMap, Path(job_id): Path<String>) -> Res<(StatusCode, Json<Value>)> {
    let session = kb_db::session();
    let chat_id = svc::open_as_chat(&session, &job_id, &by()).await.map_err(|e| docs_ai_failure(&headers, e))?;
    Ok((StatusCode::CREATED, Json(json!({"chat_id": chat_id}))))
}

/// "Was this right?".
#[derive(Debug, Deserialize)]
struct FeedbackBody {
    rating: String,
    #[serde(default)]
    reason: Option<String>,
}

/// Thumbs up or down on an answer, stored on the job result.
async fn post_feedback(
    headers: HeaderMap,
    Path(job_id): Path<String>,
    Body(body): Body<FeedbackBody>,
) -> Res<Json<Value>> {
    let session = kb_db::session();
    let reason = body.reason.as_deref().unwrap_or("");
    let out = svc::feedback(&session, &job_id, &by(), &body.rating, reason)
        .await
        .map_err(|e| docs_ai_failure(&headers, e))?;
    Ok(Json(Value::Object(out)))
}

/// "Report as out of date".
#[derive(Debug, Deserialize)]
struct StaleBody {
    reason: String,
    #[serde(default)]
    #[allow(dead_code)]
    job_id: Option<String>,
}

/// Flag a page as possibly out of date: a freshness check of the page starts.
async fn post_report_stale(
    headers: HeaderMap,
    Path(page_id): Path<String>,
    Body(body): Body<StaleBody>,
) -> Res<Json<Value>> {
    let session = kb_db::session();
    let page = kb_docs::docs::get_page(&session, &page_id, false, false).await.map_err(|e| docs(&headers, e))?;
    svc_settings::require_enabled(&session, &page.project_id).await.map_err(|e| docs_ai_failure(&headers, e))?;
    let instruction: String = format!("Reported: {}", body.reason).chars().take(300).collect();
    let job = jobs::start(
        &session,
        NewJob {
            project_id: page.project_id.clone(),
            kind: "freshness".to_string(),
            started_by: by(),
            page_id: Some(page.id.clone()),
            instruction,
            ..Default::default()
        },
    )
    .await?;
    Ok(Json(json!({"ok": true, "job_id": job.id})))
}
