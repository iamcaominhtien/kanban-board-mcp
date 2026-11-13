//! `api/docs_ai/write.py`: write a page with the assistant, tidy on import, history and publishing helpers.

use axum::Json;
use axum::http::HeaderMap;
use kb_base::Routes;
use kb_base::error::{Body, Path};
use serde::Deserialize;
use serde_json::{Map, Value, json};

use super::page::gate_job;
use super::settings::docs;
use crate::api::{Res, by, docs_ai_error, docs_ai_failure};
use crate::assistant::docs as svc;
use crate::docs_ai::errors::DocsAiError;
use crate::docs_ai::jobs::{self, NewJob};
use crate::docs_ai::settings as svc_settings;
use crate::docs_ai::tidy;

/// The routes of this file.
pub fn routes() -> Routes {
    Routes::new()
        .post("/projects/{project_id}/docs/ai/write/preview", write_preview)
        .post("/projects/{project_id}/docs/ai/write", write_page)
        .get("/docs/pages/{page_id}/ai/markers", page_markers)
        .post("/docs/pages/{page_id}/ai/accepted", page_accepted)
        .post("/docs/pages/{page_id}/ai/history-summary", history_summary)
        .post("/docs/pages/{page_id}/ai/publish-note", publish_note)
        .post("/projects/{project_id}/docs/ai/since-viewed", since_viewed)
        .post("/projects/{project_id}/docs/ai/tidy", tidy_import)
}

/// Where a page is written from: a ticket, an idea, notes or a prompt.
#[derive(Debug, Deserialize)]
struct WriteSource {
    kind: String,
    #[serde(default)]
    ticket_id: Option<String>,
    #[serde(default)]
    idea_id: Option<String>,
    #[serde(default)]
    text: Option<String>,
}

/// What the assistant may read besides the source.
#[derive(Debug, Deserialize)]
struct WriteInclude {
    #[serde(default = "yes")]
    comments: bool,
    #[serde(default = "yes")]
    linked_pages: bool,
    #[serde(default)]
    code_changes: bool,
}

impl Default for WriteInclude {
    fn default() -> Self {
        Self { comments: true, linked_pages: true, code_changes: false }
    }
}

fn yes() -> bool {
    true
}

/// The sources picked in the Write dialog, and where the page goes (`parent_id`, only of `WriteBody`).
#[derive(Debug, Deserialize)]
struct WritePreviewBody {
    source: WriteSource,
    #[serde(default)]
    page_kind: Option<String>,
    #[serde(default)]
    include: WriteInclude,
    #[serde(default)]
    title: Option<String>,
}

#[derive(Debug, Deserialize)]
struct WriteBody {
    source: WriteSource,
    #[serde(default)]
    page_kind: Option<String>,
    #[serde(default)]
    include: WriteInclude,
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    parent_id: Option<String>,
}

/// `body.model_dump()` of a `WritePreviewBody` (and, with `parent_id`, of a `WriteBody`).
fn dump(
    source: &WriteSource,
    page_kind: &Option<String>,
    include: &WriteInclude,
    title: &Option<String>,
    parent_id: Option<&Option<String>>,
) -> Map<String, Value> {
    let mut out = Map::new();
    out.insert(
        "source".into(),
        json!({"kind": source.kind, "ticket_id": source.ticket_id, "idea_id": source.idea_id, "text": source.text}),
    );
    out.insert("page_kind".into(), json!(page_kind));
    out.insert(
        "include".into(),
        json!({"comments": include.comments, "linked_pages": include.linked_pages, "code_changes": include.code_changes}),
    );
    out.insert("title".into(), json!(title));
    if let Some(parent) = parent_id {
        out.insert("parent_id".into(), json!(parent));
    }
    out
}

/// "What will be sent": what the assistant starts reading from.
async fn write_preview(
    headers: HeaderMap,
    Path(project_id): Path<String>,
    Body(body): Body<WritePreviewBody>,
) -> Res<Json<Value>> {
    let session = kb_db::session();
    let params = dump(&body.source, &body.page_kind, &body.include, &body.title, None);
    let out = svc::write_preview(&session, &project_id, &params).await.map_err(|e| docs_ai_failure(&headers, e))?;
    Ok(Json(Value::Object(out)))
}

/// Write a page from the picked sources: a `write` job. Its result is `{page_id, title, gaps, sources, cost}`.
async fn write_page(
    headers: HeaderMap,
    Path(project_id): Path<String>,
    Body(body): Body<WriteBody>,
) -> Res<Json<Value>> {
    let session = kb_db::session();
    let params = dump(&body.source, &body.page_kind, &body.include, &body.title, Some(&body.parent_id));
    let job =
        svc::start_write(&session, &project_id, &params, &by()).await.map_err(|e| docs_ai_failure(&headers, e))?;
    Ok(Json(Value::Object(jobs::to_dict(&job))))
}

/// The Needs input markers still in the page (checked before publishing; publishing stays possible).
async fn page_markers(headers: HeaderMap, Path(page_id): Path<String>) -> Res<Json<Value>> {
    let session = kb_db::session();
    let out = svc::markers_of(&session, &page_id).await.map_err(|e| docs_ai_failure(&headers, e))?;
    Ok(Json(Value::Object(out)))
}

/// The editor accepted AI text.
async fn page_accepted(headers: HeaderMap, Path(page_id): Path<String>) -> Res<Json<Value>> {
    let session = kb_db::session();
    kb_docs::docs::get_page(&session, &page_id, false, true).await.map_err(|e| docs(&headers, e))?;
    Ok(Json(json!({"ok": true})))
}

/// `_page_job`: a job on a page (the page may be read; Docs AI on; an assistant ready).
async fn page_job(
    headers: &HeaderMap,
    session: &kb_db::Session,
    page_id: &str,
    kind: &str,
    instruction: &str,
    inputs: Map<String, Value>,
) -> Res<Json<Value>> {
    let page = gate_job(headers, session, page_id).await?;
    let job = jobs::start(
        session,
        NewJob {
            project_id: page.project_id.clone(),
            kind: kind.to_string(),
            started_by: by(),
            page_id: Some(page.id.clone()),
            instruction: instruction.to_string(),
            result: Some(json!({"input": inputs})),
            ..Default::default()
        },
    )
    .await?;
    Ok(Json(Value::Object(jobs::to_dict(&job))))
}

/// The two versions to compare.
#[derive(Debug, Deserialize)]
struct HistorySummaryBody {
    from_version: i64,
    to_version: i64,
}

/// "What changed since v12": a `history_summary` job.
async fn history_summary(
    headers: HeaderMap,
    Path(page_id): Path<String>,
    Body(body): Body<HistorySummaryBody>,
) -> Res<Json<Value>> {
    if body.to_version <= body.from_version {
        return Err(docs_ai_error(&DocsAiError::new("invalid", "Pick a later version to compare with.")));
    }
    let session = kb_db::session();
    let mut inputs = Map::new();
    inputs.insert("from_version".into(), json!(body.from_version));
    inputs.insert("to_version".into(), json!(body.to_version));
    page_job(
        &headers,
        &session,
        &page_id,
        "history_summary",
        &format!("What changed v{} \u{2192} v{}", body.from_version, body.to_version),
        inputs,
    )
    .await
}

/// The draft text about to be published (optional).
#[derive(Debug, Deserialize)]
struct PublishNoteBody {
    #[serde(default)]
    markdown: Option<String>,
}

/// A suggested change note for publishing: a `publish_note` job (`result.note`).
async fn publish_note(
    headers: HeaderMap,
    Path(page_id): Path<String>,
    Body(body): Body<PublishNoteBody>,
) -> Res<Json<Value>> {
    let session = kb_db::session();
    let mut inputs = Map::new();
    inputs.insert("markdown".into(), json!(body.markdown));
    page_job(&headers, &session, &page_id, "publish_note", "Suggest a change note", inputs).await
}

/// "Changes since you last viewed": a `since_viewed` job, one line per page.
async fn since_viewed(headers: HeaderMap, Path(project_id): Path<String>) -> Res<Json<Value>> {
    let session = kb_db::session();
    svc_settings::require_enabled(&session, &project_id).await.map_err(|e| docs_ai_failure(&headers, e))?;
    svc::ready_or_raise(&project_id).await.map_err(|e| docs_ai_failure(&headers, e))?;
    let job = jobs::start(
        &session,
        NewJob {
            project_id: project_id.clone(),
            kind: "since_viewed".to_string(),
            started_by: by(),
            instruction: "Changes since you last viewed".to_string(),
            ..Default::default()
        },
    )
    .await?;
    Ok(Json(Value::Object(jobs::to_dict(&job))))
}

/// What a tidy import may change.
#[derive(Debug, Default, Deserialize)]
struct TidyOptions {
    #[serde(default)]
    split_by_heading: bool,
    #[serde(default)]
    ticket_chips: bool,
    #[serde(default)]
    see_links: bool,
    #[serde(default)]
    heading_levels: bool,
}

/// The Markdown to import and what to tidy in it.
#[derive(Debug, Deserialize)]
struct TidyBody {
    markdown: String,
    #[serde(default = "import_md")]
    filename: String,
    #[serde(default)]
    options: TidyOptions,
    #[serde(default)]
    accept_see_links: Vec<String>,
}

fn import_md() -> String {
    "import.md".to_string()
}

/// Preview a tidy import (no model): the pages and what changed in each.
async fn tidy_import(
    headers: HeaderMap,
    Path(project_id): Path<String>,
    Body(body): Body<TidyBody>,
) -> Res<Json<Value>> {
    let session = kb_db::session();
    let options = json!({
        "split_by_heading": body.options.split_by_heading,
        "ticket_chips": body.options.ticket_chips,
        "see_links": body.options.see_links,
        "heading_levels": body.options.heading_levels,
    });
    let options = options.as_object().cloned().unwrap_or_default();
    let out = tidy::tidy(&session, &project_id, &body.markdown, &options, &body.filename, Some(&body.accept_see_links))
        .await
        .map_err(|e| docs_ai_failure(&headers, e))?;
    Ok(Json(Value::Object(out)))
}
