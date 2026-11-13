//! `api/docs_ai/settings.py`: Docs AI settings, per-page flags and the job list (Settings > Docs > AI; page info).

use axum::Json;
use axum::http::HeaderMap;
use kb_base::error::{Body, Path, Query};
use kb_base::{ApiError, Routes, events};
use kb_db::Session;
use kb_db::entities::project;
use kb_db::sea_orm::EntityTrait;
use kb_doctext::docs_access;
use serde::Deserialize;
use serde_json::{Map, Value};

use crate::api::{Failure, Res, by, docs_ai_error, docs_ai_failure, docs_failure, put, sent};
use crate::docs_ai::errors::DocsAiError;
use crate::docs_ai::jobs::{self, JobFilter};
use crate::docs_ai::settings as svc;

/// The routes of this file.
pub fn routes() -> Routes {
    Routes::new()
        .get("/projects/{project_id}/docs/ai", get_docs_ai)
        .patch("/projects/{project_id}/docs/ai", patch_docs_ai)
        .get("/projects/{project_id}/docs/ai/jobs", list_docs_ai_jobs)
        .get("/docs/ai/jobs/{job_id}", get_docs_ai_job)
        .post("/docs/ai/jobs/{job_id}/cancel", cancel_docs_ai_job)
}

/// Docs AI settings are for project admins (the board's own user counts as one).
pub async fn require_admin(session: &Session, project_id: &str) -> Res<()> {
    let Some(project) = project::Entity::find_by_id(project_id).one(session).await? else {
        return Err(docs_ai_error(&DocsAiError::new("not_found", "Project not found.")));
    };
    let info = docs_access::access_of(session, &project).await?;
    let is_admin = info.get("access").is_some_and(kb_base::pyjson::truthy)
        && info.get("role").and_then(Value::as_str) == Some("admin");
    if !is_admin {
        return Err(docs_ai_error(&DocsAiError::new("forbidden", "Only project admins can change Docs AI settings.")));
    }
    Ok(())
}

/// Settings > Docs > AI.
#[derive(Debug, Deserialize)]
struct DocsAiBody {
    #[serde(default, deserialize_with = "sent")]
    enabled: Option<Option<bool>>,
    #[serde(default, deserialize_with = "sent")]
    member_id: Option<Option<String>>,
    #[serde(default, deserialize_with = "sent")]
    style_page_id: Option<Option<String>>,
    #[serde(default, deserialize_with = "sent")]
    freshness_on: Option<Option<bool>>,
    #[serde(default, deserialize_with = "sent")]
    digest_on: Option<Option<bool>>,
}

/// The switches, who answers and the state the Docs UI should show (`off`, `no_member` or `ready`).
async fn get_docs_ai(headers: HeaderMap, Path(project_id): Path<String>) -> Res<Json<Value>> {
    let session = kb_db::session();
    let out = svc::describe(&session, &project_id).await.map_err(|e| docs_ai_failure(&headers, e))?;
    Ok(Json(Value::Object(out)))
}

/// Change the switches (project admins).
async fn patch_docs_ai(
    headers: HeaderMap,
    Path(project_id): Path<String>,
    Body(body): Body<DocsAiBody>,
) -> Res<Json<Value>> {
    let session = kb_db::session();
    require_admin(&session, &project_id).await?;
    let mut data = Map::new();
    put(&mut data, "enabled", &body.enabled);
    put(&mut data, "member_id", &body.member_id);
    put(&mut data, "style_page_id", &body.style_page_id);
    put(&mut data, "freshness_on", &body.freshness_on);
    put(&mut data, "digest_on", &body.digest_on);
    svc::update(&session, &project_id, &data, &by()).await.map_err(|e| docs_ai_failure(&headers, e))?;
    events::publish(events::INVALIDATE, &[]).await;
    let out = svc::describe(&session, &project_id).await.map_err(|e| docs_ai_failure(&headers, e))?;
    Ok(Json(Value::Object(out)))
}

#[derive(Debug, Deserialize)]
struct JobsQuery {
    page_id: Option<String>,
    thread_id: Option<String>,
    kind: Option<String>,
    state: Option<String>,
    limit: Option<i64>,
}

/// Docs AI calls of the project, newest first (progress, pages read, cost).
async fn list_docs_ai_jobs(Path(project_id): Path<String>, Query(q): Query<JobsQuery>) -> Res<Json<Value>> {
    let limit = q.limit.unwrap_or(50);
    if limit < 1 {
        return Err(ApiError::validation(
            &["query", "limit"],
            "Input should be greater than or equal to 1",
            "greater_than_equal",
        )
        .into());
    }
    if limit > 200 {
        return Err(ApiError::validation(
            &["query", "limit"],
            "Input should be less than or equal to 200",
            "less_than_equal",
        )
        .into());
    }
    let session = kb_db::session();
    let filter = JobFilter {
        page_id: q.page_id.as_deref(),
        thread_id: q.thread_id.as_deref(),
        kind: q.kind.as_deref(),
        state: q.state.as_deref(),
        member_id: None,
    };
    let rows = jobs::list_jobs(&session, &project_id, filter, limit).await?;
    Ok(Json(Value::Array(rows.iter().map(|j| Value::Object(jobs::to_dict(j))).collect())))
}

/// One Docs AI call.
async fn get_docs_ai_job(headers: HeaderMap, Path(job_id): Path<String>) -> Res<Json<Value>> {
    let session = kb_db::session();
    let job = jobs::get(&session, &job_id).await.map_err(|e| docs_ai_failure(&headers, e))?;
    Ok(Json(Value::Object(jobs::to_dict(&job))))
}

/// Stop a running Docs AI call.
async fn cancel_docs_ai_job(headers: HeaderMap, Path(job_id): Path<String>) -> Res<Json<Value>> {
    let session = kb_db::session();
    let job = jobs::cancel(&session, &job_id, &by()).await.map_err(|e| docs_ai_failure(&headers, e))?;
    Ok(Json(Value::Object(jobs::to_dict(&job))))
}

/// A Docs error as `Failure` (for the modules that call Docs directly).
pub(crate) fn docs(headers: &HeaderMap, err: impl Into<kb_docs::Error>) -> Failure {
    docs_failure(headers, err.into())
}
