//! `api/docs_ai/health.py`: keeping pages true (the banner, still correct, suggested edits) and Docs health.

use axum::Json;
use axum::http::{HeaderMap, StatusCode};
use kb_base::error::{Body, Path};
use kb_base::{Routes, events};
use kb_db::Session;
use kb_db::entities::docs_page;
use serde::Deserialize;
use serde_json::{Value, json};

use super::settings::docs;
use crate::api::{Res, by, docs_ai_failure};
use crate::assistant::docs as assistant_docs;
use crate::docs_ai::health as svc;
use crate::docs_ai::jobs::{self, NewJob};
use crate::docs_ai::settings as svc_settings;

/// The routes of this file.
pub fn routes() -> Routes {
    Routes::new()
        .get("/docs/pages/{page_id}/ai/freshness", get_freshness)
        .post("/docs/pages/{page_id}/ai/freshness", check_freshness)
        .post("/docs/pages/{page_id}/ai/freshness/still-correct", still_correct)
        .post("/docs/pages/{page_id}/ai/freshness/dismiss", dismiss_reason)
        .get("/projects/{project_id}/docs/ai/health", get_health)
        .get("/projects/{project_id}/docs/ai/health/count", get_health_count)
        .post("/projects/{project_id}/docs/ai/health/run", run_health)
        .post("/projects/{project_id}/docs/ai/health/dismiss", dismiss_health)
}

/// The page, for someone who can edit it, with Docs AI on.
async fn editable_page(headers: &HeaderMap, session: &Session, page_id: &str) -> Res<docs_page::Model> {
    let page = kb_docs::docs::get_page(session, page_id, false, true).await.map_err(|e| docs(headers, e))?;
    svc_settings::require_enabled(session, &page.project_id).await.map_err(|e| docs_ai_failure(headers, e))?;
    Ok(page)
}

/// Dismiss a reason: this time, 30 days, or never for this kind of reason.
#[derive(Debug, Deserialize)]
struct DismissBody {
    key: String,
    #[allow(dead_code)]
    level: String,
}

/// The page's banner: the latest freshness check (people who can edit the page).
async fn get_freshness(headers: HeaderMap, Path(page_id): Path<String>) -> Res<Json<Value>> {
    let session = kb_db::session();
    let page = editable_page(&headers, &session, &page_id).await?;
    let out = assistant_docs::freshness_of(&session, &page).await.map_err(|e| docs_ai_failure(&headers, e))?;
    Ok(Json(Value::Object(out)))
}

/// "Check if up to date": a `freshness` job; its result is `{state, reasons}`.
async fn check_freshness(headers: HeaderMap, Path(page_id): Path<String>) -> Res<(StatusCode, Json<Value>)> {
    let session = kb_db::session();
    let page = editable_page(&headers, &session, &page_id).await?;
    assistant_docs::ready_or_raise(&page.project_id).await.map_err(|e| docs_ai_failure(&headers, e))?;
    let job = jobs::start(
        &session,
        NewJob {
            project_id: page.project_id.clone(),
            kind: "freshness".to_string(),
            started_by: by(),
            page_id: Some(page.id.clone()),
            instruction: "Check if up to date".to_string(),
            ..Default::default()
        },
    )
    .await?;
    Ok((StatusCode::ACCEPTED, Json(Value::Object(jobs::to_dict(&job)))))
}

/// "Still correct": hides the banner until the next check.
async fn still_correct(headers: HeaderMap, Path(page_id): Path<String>) -> Res<Json<Value>> {
    let session = kb_db::session();
    let page = editable_page(&headers, &session, &page_id).await?;
    let out =
        assistant_docs::freshness_mark(&session, &page, true, None).await.map_err(|e| docs_ai_failure(&headers, e))?;
    Ok(Json(Value::Object(out)))
}

/// Hide one reason of the banner.
async fn dismiss_reason(
    headers: HeaderMap,
    Path(page_id): Path<String>,
    Body(body): Body<DismissBody>,
) -> Res<Json<Value>> {
    let session = kb_db::session();
    let page = editable_page(&headers, &session, &page_id).await?;
    let out = assistant_docs::freshness_mark(&session, &page, false, Some(&body.key))
        .await
        .map_err(|e| docs_ai_failure(&headers, e))?;
    Ok(Json(Value::Object(out)))
}

/// `_reader`: Docs is on for the project and Docs AI is on.
async fn reader(headers: &HeaderMap, session: &Session, project_id: &str) -> Res<()> {
    kb_docs::docs::project(session, project_id, false).await.map_err(|e| docs(headers, e))?;
    svc_settings::require_enabled(session, project_id).await.map_err(|e| docs_ai_failure(headers, e))?;
    Ok(())
}

/// Docs health: out of date, missing docs, broken links and overlaps, with the counts.
async fn get_health(headers: HeaderMap, Path(project_id): Path<String>) -> Res<Json<Value>> {
    let session = kb_db::session();
    reader(&headers, &session, &project_id).await?;
    let out = svc::get(&session, &project_id, true).await.map_err(|e| docs_ai_failure(&headers, e))?;
    Ok(Json(Value::Object(out)))
}

/// The number beside "Docs health" in the tree.
async fn get_health_count(headers: HeaderMap, Path(project_id): Path<String>) -> Res<Json<Value>> {
    let session = kb_db::session();
    reader(&headers, &session, &project_id).await?;
    let count = svc::count(&session, &project_id).await.map_err(|e| docs_ai_failure(&headers, e))?;
    Ok(Json(json!({"count": count})))
}

/// Run now: recompute the lists and check the pages whose dependencies changed (people who can edit).
async fn run_health(headers: HeaderMap, Path(project_id): Path<String>) -> Res<Json<Value>> {
    let session = kb_db::session();
    kb_docs::docs::project(&session, &project_id, true).await.map_err(|e| docs(&headers, e))?;
    let out = svc::run(&session, &project_id, &by(), true, None, 50).await.map_err(|e| docs_ai_failure(&headers, e))?;
    events::publish(events::INVALIDATE, &[]).await;
    Ok(Json(Value::Object(out)))
}

/// Dismiss one row of Docs health.
#[derive(Debug, Deserialize)]
struct HealthDismissBody {
    kind: String,
    id: String,
    level: String,
}

/// Dismiss an item (`level`: once = until the next run, 30d or never).
async fn dismiss_health(
    headers: HeaderMap,
    Path(project_id): Path<String>,
    Body(body): Body<HealthDismissBody>,
) -> Res<Json<Value>> {
    let session = kb_db::session();
    kb_docs::docs::project(&session, &project_id, true).await.map_err(|e| docs(&headers, e))?;
    let out = svc::dismiss(&session, &project_id, &body.kind, &body.id, &body.level, &by())
        .await
        .map_err(|e| docs_ai_failure(&headers, e))?;
    events::publish(events::INVALIDATE, &[]).await;
    Ok(Json(Value::Object(out)))
}
