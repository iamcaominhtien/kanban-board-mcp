//! `api/docs_ai/page.py`: what the assistant does with one page for people who read or edit it. Every endpoint starts
//! a job (`docs_ai_job`) and returns it; the UI polls `GET /docs/ai/jobs/{id}`.

use axum::Json;
use axum::http::{HeaderMap, StatusCode};
use kb_base::error::{Body, OptionalBody, Path};
use kb_base::{Routes, pytext};
use kb_db::Session;
use kb_db::entities::docs_page;
use serde::Deserialize;
use serde_json::{Map, Value, json};

use super::settings::docs;
use crate::api::{Res, by, docs_ai_error, docs_ai_failure, squash};
use crate::assistant::docs as svc;
use crate::docs_ai::errors::DocsAiError;
use crate::docs_ai::jobs::{self, NewJob};
use crate::docs_ai::settings as svc_settings;

/// The routes of this file.
pub fn routes() -> Routes {
    Routes::new()
        .post("/docs/pages/{page_id}/ai/summary", post_summary)
        .post("/docs/pages/{page_id}/ai/explain", post_explain)
        .post("/docs/pages/{page_id}/ai/translate", post_translate)
        .post("/docs/pages/{page_id}/ai/check", post_check)
        .post("/docs/pages/{page_id}/ai/check/{finding_id}/fix", post_fix)
        .post("/docs/pages/{page_id}/ai/check/ignore", post_ignore)
        .post("/docs/pages/{page_id}/ai/diagram", post_diagram)
}

/// The person may read (or edit) the page, Docs AI is on for the project, and an assistant can answer.
pub(crate) async fn gate(headers: &HeaderMap, session: &Session, page_id: &str, edit: bool) -> Res<docs_page::Model> {
    let page = kb_docs::docs::get_page(session, page_id, false, edit).await.map_err(|e| docs(headers, e))?;
    svc_settings::require_enabled(session, &page.project_id).await.map_err(|e| docs_ai_failure(headers, e))?;
    svc::ready_or_raise(&page.project_id).await.map_err(|e| docs_ai_failure(headers, e))?;
    Ok(page)
}

/// Create the job for a page and run it in the background.
async fn launch(
    session: &Session,
    page: &docs_page::Model,
    kind: &str,
    instruction: &str,
    inputs: Map<String, Value>,
) -> Res<(StatusCode, Json<Value>)> {
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
    Ok((StatusCode::ACCEPTED, Json(Value::Object(jobs::to_dict(&job)))))
}

fn clip(text: &str, n: usize) -> String {
    text.chars().take(n).collect()
}

fn inputs(pairs: Vec<(&str, Value)>) -> Map<String, Value> {
    pairs.into_iter().map(|(k, v)| (k.to_string(), v)).collect()
}

/// The draft text to summarise instead of the published page (optional).
#[derive(Debug, Deserialize)]
struct SummaryBody {
    #[serde(default)]
    markdown: Option<String>,
}

/// A short summary of the page, not saved anywhere. Result: `{text, title, cost, metered}`.
async fn post_summary(
    headers: HeaderMap,
    Path(page_id): Path<String>,
    OptionalBody(body): OptionalBody<SummaryBody>,
) -> Res<(StatusCode, Json<Value>)> {
    let session = kb_db::session();
    let page = gate(&headers, &session, &page_id, false).await?;
    let markdown = body.and_then(|b| b.markdown);
    launch(&session, &page, "summary", "Summarise this page", inputs(vec![("markdown", json!(markdown))])).await
}

/// The selected passage to explain, and its section.
#[derive(Debug, Deserialize)]
struct ExplainBody {
    selection: String,
    #[serde(default)]
    section: Option<String>,
}

/// Explain a selection. Result: `{text, from, section, cost, metered}`.
async fn post_explain(
    headers: HeaderMap,
    Path(page_id): Path<String>,
    Body(body): Body<ExplainBody>,
) -> Res<(StatusCode, Json<Value>)> {
    let session = kb_db::session();
    let page = gate(&headers, &session, &page_id, false).await?;
    let selection = pytext::strip(&body.selection).to_string();
    if selection.is_empty() || selection.chars().count() > 4000 {
        return Err(docs_ai_error(&DocsAiError::new("invalid", "Select a passage (up to 4,000 characters) first.")));
    }
    let instruction = format!("Explain: {}", clip(&selection, 200));
    launch(
        &session,
        &page,
        "explain",
        &instruction,
        inputs(vec![("selection", json!(selection)), ("section", json!(body.section))]),
    )
    .await
}

/// The language to translate the page (or one section) into.
#[derive(Debug, Deserialize)]
struct TranslateBody {
    language: String,
    #[serde(default)]
    section: Option<String>,
}

/// The page translated as a view. Result: `{markdown, language, kept_original_blocks, cost, metered}`.
async fn post_translate(
    headers: HeaderMap,
    Path(page_id): Path<String>,
    Body(body): Body<TranslateBody>,
) -> Res<(StatusCode, Json<Value>)> {
    let session = kb_db::session();
    let page = gate(&headers, &session, &page_id, false).await?;
    let language = clip(&squash(&body.language), 40);
    if language.is_empty() {
        return Err(docs_ai_error(&DocsAiError::new("invalid", "Pick a language.")));
    }
    launch(
        &session,
        &page,
        "translate",
        &format!("Translate into {language}"),
        inputs(vec![("language", json!(language)), ("section", json!(body.section))]),
    )
    .await
}

/// The draft text to check instead of the published page (optional).
#[derive(Debug, Deserialize)]
struct CheckBody {
    #[serde(default)]
    markdown: Option<String>,
}

/// Read the page and the style guide page. Result: `{findings: [{id, kind, quote, section, message, suggestion?}],
/// style_page, ignored, cost, metered}`.
async fn post_check(
    headers: HeaderMap,
    Path(page_id): Path<String>,
    OptionalBody(body): OptionalBody<CheckBody>,
) -> Res<(StatusCode, Json<Value>)> {
    let session = kb_db::session();
    let page = gate(&headers, &session, &page_id, false).await?;
    let markdown = body.and_then(|b| b.markdown);
    launch(&session, &page, "check", "Check this page", inputs(vec![("markdown", json!(markdown))])).await
}

/// The draft text the fix applies to, and the check job the finding came from.
#[derive(Debug, Deserialize)]
struct FixBody {
    #[serde(default)]
    markdown: Option<String>,
    #[serde(default)]
    job_id: Option<String>,
}

/// `{old, new}` for one finding (people who can edit the page). The editor applies it as a draft change.
async fn post_fix(
    headers: HeaderMap,
    Path((page_id, finding_id)): Path<(String, String)>,
    OptionalBody(body): OptionalBody<FixBody>,
) -> Res<(StatusCode, Json<Value>)> {
    let session = kb_db::session();
    let page = gate(&headers, &session, &page_id, true).await?;
    let (markdown, job_id) = match body {
        Some(b) => (b.markdown, b.job_id),
        None => (None, None),
    };
    let finding = svc::find_finding(&session, &page.project_id, &page.id, &finding_id, job_id.as_deref())
        .await
        .map_err(|e| docs_ai_failure(&headers, e))?;
    let message = match finding.get("message") {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Null) | None => String::new(),
        Some(other) => kb_base::pyjson::py_str(other),
    };
    let instruction = clip(&format!("Fix: {message}"), 300);
    launch(
        &session,
        &page,
        "check_fix",
        &instruction,
        inputs(vec![("finding", finding), ("markdown", json!(markdown))]),
    )
    .await
}

/// The finding to hide on this page.
#[derive(Debug, Deserialize)]
struct IgnoreBody {
    key: String,
}

/// Hide a finding for this page (people who can edit it); later checks skip it.
async fn post_ignore(
    headers: HeaderMap,
    Path(page_id): Path<String>,
    Body(body): Body<IgnoreBody>,
) -> Res<Json<Value>> {
    let session = kb_db::session();
    let page = kb_docs::docs::get_page(&session, &page_id, false, true).await.map_err(|e| docs(&headers, e))?;
    svc_settings::require_enabled(&session, &page.project_id).await.map_err(|e| docs_ai_failure(&headers, e))?;
    svc::ignore(&session, &page.id, &body.key, &by()).await.map_err(|e| docs_ai_failure(&headers, e))?;
    Ok(Json(json!({"ok": true, "key": pytext::strip(&body.key)})))
}

/// What to draw: a selection or an instruction, or the diagram to change.
#[derive(Debug, Deserialize)]
struct DiagramBody {
    #[serde(default)]
    selection: Option<String>,
    #[serde(default)]
    instruction: Option<String>,
    #[serde(default)]
    diagram_id: Option<String>,
    #[serde(default)]
    label: Option<String>,
    #[serde(default)]
    markdown: Option<String>,
}

/// Draw the selection (or the page) as an editable draw.io diagram, or change one. Result `{diagram_id, label,
/// markdown, changed, cost, metered}`; put `markdown` in the draft.
async fn post_diagram(
    headers: HeaderMap,
    Path(page_id): Path<String>,
    Body(body): Body<DiagramBody>,
) -> Res<(StatusCode, Json<Value>)> {
    let session = kb_db::session();
    let page = gate(&headers, &session, &page_id, true).await?;
    let wanted = body.instruction.clone().filter(|i| !i.is_empty()).unwrap_or_else(|| "Draw a diagram".to_string());
    launch(
        &session,
        &page,
        "diagram",
        &clip(&wanted, 200),
        inputs(vec![
            ("selection", json!(body.selection)),
            ("request", json!(body.instruction)),
            ("diagram_id", json!(body.diagram_id)),
            ("label", json!(body.label)),
            ("markdown", json!(body.markdown)),
        ]),
    )
    .await
}

/// `_page_job` of `write.py`: the page may be read (not edited), Docs AI is on and an assistant can answer. (Same as
/// `gate` for a reader; the Python order of the three checks is the same.)
pub(crate) async fn gate_job(headers: &HeaderMap, session: &Session, page_id: &str) -> Res<docs_page::Model> {
    gate(headers, session, page_id, false).await
}
