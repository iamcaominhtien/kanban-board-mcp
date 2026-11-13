//! Docs AI on the assistant engine (AI v2): each feature is a job whose handler runs one turn with a skill
//! (`services/assistant/docs.py`, 1106 lines).
//!
//! The job kinds and their results keep the shapes the Docs UI reads (`docs_ai_job.result`). What needs no model
//! (ignoring a finding, creating the reviewed ticket drafts, markers in a draft) is plain code here.
//!
//! The Python module is one file; here it is this file (lines 1 to 641: the constants, the turn of a job, a page's
//! jobs, asking the docs, writing a page, the history jobs), `tickets` (644 to 723: from a page to tickets) and
//! `threads` (730 to 1106: comment threads, the @mentions of an AI member, what the comments list shows of the
//! assistant). Every name of the Python module is `docs::<name>` here too.

use std::collections::HashSet;

use kb_ai::store::{loads, now_iso};
use kb_base::{pyjson, pytext, time};
use kb_db::Session;
use kb_db::database;
use kb_db::entities::{ai_chat, ai_chat_message, docs_ai_ignore, docs_ai_job, docs_page};
use kb_db::sea_orm::ActiveValue::Set;
use kb_db::sea_orm::{ActiveModelTrait, ColumnTrait, EntityTrait, QueryFilter, QueryOrder, QuerySelect};
use regex::Regex;
use serde_json::{Map, Value, json};
use sha1::{Digest, Sha1};
use std::sync::LazyLock;

use super::engine::{self, Schema, Turn, TurnOpts};
use super::errors::Error as AssistFailure;
use super::sessions;
use crate::docs_ai::errors::{DocsAiError, Error};
use crate::docs_ai::jobs::{self, HandlerFuture};
use crate::docs_ai::settings as svc_settings;

mod preview;
mod since;
mod threads;
mod tickets;

pub use threads::{THREAD_KINDS, annotate, deliver, docs_ai_on, member_rows, start_route_job, start_thread_job};
pub use preview::write_preview;
pub use since::{Change, Changed, MAX_DIGEST_PAGES, NEW_PAGE_DAYS, changed_since_viewed};
pub use tickets::{LineKeys, create_tickets, undo_tickets};

/// The longest question the Docs UI sends.
pub const MAX_QUESTION: usize = 1000;
/// Where a question can look.
pub const SCOPES: [&str; 3] = ["space", "page", "all"];
/// `_MARKER`: a "Needs input" marker a written page leaves for a person.
static MARKER: LazyLock<Regex> = LazyLock::new(|| match Regex::new(r"\[Needs input[^\]]*\]") {
    Ok(re) => re,
    Err(err) => unreachable!("the marker pattern is a constant: {err}"),
});

/// Docs AI can answer now (with the team chosen in Settings), or `paused` / `no_member` (the UI's states).
pub async fn ready_or_raise(project_id: &str) -> Result<(), Error> {
    let info = engine::ready(project_id, "docs").await?;
    if info.get("state").and_then(Value::as_str) != Some("ready") {
        let code = info.get("code").filter(|c| pyjson::truthy(c)).and_then(Value::as_str).unwrap_or("no_member");
        let message = info.get("message").map(text_of).unwrap_or_default();
        return Err(DocsAiError::new(code, message).into());
    }
    Ok(())
}

/// `str(value)`.
pub(crate) fn text_of(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        other => pyjson::py_str(other),
    }
}

/// `value or default`.
pub(crate) fn or_default(value: Option<&Value>, default: Value) -> Value {
    match value {
        Some(value) if pyjson::truthy(value) => value.clone(),
        _ => default,
    }
}

/// `value.get(key)`, `None` when it is absent (as a `Value::Null`).
pub(crate) fn get(map: &Map<String, Value>, key: &str) -> Value {
    map.get(key).cloned().unwrap_or(Value::Null)
}

/// `map.get(key) or default`.
pub(crate) fn get_or(map: &Map<String, Value>, key: &str, default: Value) -> Value {
    or_default(map.get(key), default)
}

/// `(value or [])`, the items of a list.
pub(crate) fn items(value: Option<&Value>) -> Vec<Value> {
    match value {
        Some(Value::Array(items)) => items.clone(),
        _ => Vec::new(),
    }
}

/// What a turn of a job may be given besides its skill and inputs (`**kw` of `_turn`).
#[derive(Debug, Clone, Default)]
pub struct TurnExtra {
    /// `schema=`: the JSON schema the answer is asked in.
    pub schema: Option<Schema>,
    /// `depth=`: the AI-to-AI hand-offs behind this turn.
    pub depth: i64,
}

/// One turn for a job: its cost goes on the job; a failed turn fails the job with the reason.
pub(crate) async fn turn(
    job: &docs_ai_job::Model,
    skill: &str,
    inputs: Map<String, Value>,
    name: Option<String>,
    extra: TurnExtra,
) -> Result<Turn, Error> {
    let name = name.unwrap_or_else(|| match job.page_id.as_deref().filter(|id| !id.is_empty()) {
        Some(page_id) => sessions::page_name(page_id),
        None => sessions::board_name(&job.project_id),
    });
    let mut opts = TurnOpts::new(&name, skill, inputs, &job.started_by);
    opts.feature = "docs";
    if let Some(schema) = extra.schema {
        opts.schema = schema;
    }
    opts.depth = extra.depth;
    let out = match engine::turn(&job.project_id, opts).await {
        Ok(out) => out,
        Err(AssistFailure::Assist(exc)) => {
            let code = if exc.code == "not_configured" { "no_member" } else { exc.code.as_str() };
            return Err(DocsAiError::new(code, exc.message).into());
        }
        Err(other) => return Err(other.into()),
    };
    jobs::account(&job.id, &out, None).await?;
    jobs::update(&job.id, &[("session_id", json!(out.session_id))]).await?;
    if out.state == "cancelled" {
        return Err(DocsAiError::new("cancelled", "Stopped.").into());
    }
    if out.state != "finished" {
        let message = out
            .error
            .clone()
            .filter(|e| !e.is_empty())
            .unwrap_or_else(|| "The assistant could not finish.".to_string());
        return Err(DocsAiError::new("unavailable", message).into());
    }
    Ok(out)
}

/// `_input`: what the handler was given (`input`, else `params`, else nothing).
pub(crate) fn input(job: &docs_ai_job::Model) -> Map<String, Value> {
    let data = match loads(Some(&job.result), json!({})) {
        Value::Object(map) => map,
        _ => Map::new(),
    };
    match or_default(data.get("input"), or_default(data.get("params"), json!({}))) {
        Value::Object(map) => map,
        _ => Map::new(),
    }
}

/// `_cost`.
pub(crate) fn cost(out: &Turn) -> Map<String, Value> {
    let mut map = Map::new();
    map.insert("cost".into(), json!(super::settings::round_to(out.cost, 4)));
    map.insert("metered".into(), json!(false));
    map
}

/// `{**a, **b}`.
pub(crate) fn merge(mut a: Map<String, Value>, b: Map<String, Value>) -> Map<String, Value> {
    a.extend(b);
    a
}

/// `_page`: the page of a job, if it has one.
async fn page_of(page_id: Option<&str>) -> Result<Option<docs_page::Model>, Error> {
    let Some(page_id) = page_id.filter(|id| !id.is_empty()) else { return Ok(None) };
    let session = database::session();
    Ok(docs_page::Entity::find_by_id(page_id).one(&session).await?)
}

/// A finding's id (also the key "Ignore" stores): the same kind and quote on a page is the same finding.
pub fn finding_id(kind: &str, quote: &str) -> String {
    let mut hasher = Sha1::new();
    hasher.update(format!("{kind}\0{quote}").as_bytes());
    let hex: String = hasher.finalize().iter().map(|byte| format!("{byte:02x}")).collect();
    hex.chars().take(10).collect()
}

/// `[:n]` of a text, in characters.
pub(crate) fn clip(text: &str, n: usize) -> String {
    text.chars().take(n).collect()
}

/// Register the handler of each kind of job this module does (`@jobs.handler(kind)`).
pub fn register_handlers() {
    jobs::register("summary", summary_job);
    jobs::register("explain", explain_job);
    jobs::register("translate", translate_job);
    jobs::register("check", check_job);
    jobs::register("check_fix", check_fix_job);
    jobs::register("diagram", diagram_job);
    jobs::register("freshness", freshness_job);
    jobs::register("ask", ask_job);
    jobs::register("write", write_job);
    jobs::register("history_summary", history_summary_job);
    jobs::register("publish_note", publish_note_job);
    jobs::register("since_viewed", since::since_viewed_job);
    jobs::register("tickets_draft", tickets::tickets_draft_job);
    jobs::register("thread_summary", threads::thread_summary_job);
    jobs::register("thread_reply", threads::thread_reply_job);
    jobs::register("docs_route", threads::docs_route_job);
}

fn boxed<F>(fut: F) -> HandlerFuture
where
    F: std::future::Future<Output = Result<Map<String, Value>, Error>> + Send + 'static,
{
    Box::pin(async move { fut.await.map(Some) })
}

// ---------------------------------------------------------------------------
// A page: summary, explain, translate, check, fix, diagram, freshness
// ---------------------------------------------------------------------------

/// A short summary of the page.
pub fn summary_job(job: docs_ai_job::Model) -> HandlerFuture {
    boxed(async move {
        let mut inputs = Map::new();
        inputs.insert("page_id".into(), json!(job.page_id));
        inputs.insert("markdown".into(), get(&input(&job), "markdown"));
        let out = turn(&job, "docs-summarise", inputs, None, TurnExtra::default()).await?;
        let page = page_of(job.page_id.as_deref()).await?;
        let data = out.data();
        let mut result = Map::new();
        result.insert("text".into(), get_or(&data, "text", json!(out.text)));
        result.insert("title".into(), get_or(&data, "title", json!(page.map_or(String::new(), |p| p.title))));
        Ok(merge(result, cost(&out)))
    })
}

/// Explain a selection of the page.
pub fn explain_job(job: docs_ai_job::Model) -> HandlerFuture {
    boxed(async move {
        let inp = input(&job);
        let mut inputs = Map::new();
        inputs.insert("page_id".into(), json!(job.page_id));
        inputs.insert("selection".into(), get(&inp, "selection"));
        inputs.insert("section".into(), get(&inp, "section"));
        let out = turn(&job, "docs-explain", inputs, None, TurnExtra::default()).await?;
        let page = page_of(job.page_id.as_deref()).await?;
        let mut result = Map::new();
        result.insert("text".into(), get_or(&out.data(), "text", json!(out.text)));
        result.insert("from".into(), json!(page.map_or(String::new(), |p| p.title)));
        result.insert("section".into(), get(&inp, "section"));
        Ok(merge(result, cost(&out)))
    })
}

/// The page (or a section) translated, as a view.
pub fn translate_job(job: docs_ai_job::Model) -> HandlerFuture {
    boxed(async move {
        let inp = input(&job);
        let mut inputs = Map::new();
        inputs.insert("page_id".into(), json!(job.page_id));
        inputs.insert("language".into(), get(&inp, "language"));
        inputs.insert("section".into(), get(&inp, "section"));
        let out = turn(&job, "docs-translate", inputs, None, TurnExtra::default()).await?;
        let data = out.data();
        let mut result = Map::new();
        result.insert("markdown".into(), get_or(&data, "markdown", json!(out.text)));
        result.insert("language".into(), get_or(&data, "language", get(&inp, "language")));
        result.insert("kept_original_blocks".into(), json!(0));
        Ok(merge(result, cost(&out)))
    })
}

/// The findings people chose to hide on a page.
pub async fn ignored_keys(session: &Session, page_id: &str) -> Result<HashSet<String>, Error> {
    let rows = docs_ai_ignore::Entity::find().filter(docs_ai_ignore::Column::PageId.eq(page_id)).all(session).await?;
    Ok(rows.into_iter().map(|r| r.key).collect())
}

/// Hide a finding on a page: later checks skip it.
pub async fn ignore(session: &Session, page_id: &str, key: &str, by: &str) -> Result<(), Error> {
    let key = pytext::strip(key);
    if key.is_empty() {
        return Err(DocsAiError::new("invalid", "Which finding?").into());
    }
    let held = docs_ai_ignore::Entity::find_by_id((page_id.to_string(), key.to_string())).one(session).await?;
    if held.is_none() {
        let mut row = docs_ai_ignore::new();
        row.page_id = Set(page_id.to_string());
        row.key = Set(key.to_string());
        row.by = Set(by.to_string());
        row.at = Set(now_iso());
        row.insert(session).await?;
        session.commit().await?;
    }
    Ok(())
}

/// Check a page against the style guide page; hidden findings are left out.
pub fn check_job(job: docs_ai_job::Model) -> HandlerFuture {
    boxed(async move {
        let (settings, skip) = {
            let session = database::session();
            let settings = svc_settings::get(&session, &job.project_id).await?;
            let skip = ignored_keys(&session, job.page_id.as_deref().unwrap_or("")).await?;
            (settings, skip)
        };
        let mut inputs = Map::new();
        inputs.insert("page_id".into(), json!(job.page_id));
        inputs.insert("markdown".into(), get(&input(&job), "markdown"));
        inputs.insert("style_page_id".into(), json!(settings.style_page_id));
        let out = turn(&job, "docs-check", inputs, None, TurnExtra::default()).await?;
        let mut findings = Vec::new();
        let mut ignored = 0;
        for item in items(out.data().get("findings")) {
            let Some(item) = item.as_object() else { continue };
            if !item.get("quote").is_some_and(pyjson::truthy) || !item.get("message").is_some_and(pyjson::truthy) {
                continue;
            }
            let kind = text_of(&get_or(item, "kind", json!("unclear")));
            let quote = text_of(&get(item, "quote"));
            let fid = finding_id(&kind, &quote);
            if skip.contains(&fid) {
                ignored += 1;
                continue;
            }
            findings.push(json!({
                "id": fid,
                "kind": kind,
                "quote": clip(&quote, 400),
                "section": get(item, "section"),
                "message": clip(&text_of(&get(item, "message")), 600),
                "suggestion": get(item, "suggestion"),
            }));
        }
        let mut result = Map::new();
        result.insert("findings".into(), Value::Array(findings));
        result.insert("ignored".into(), json!(ignored));
        result.insert("style_page".into(), json!(settings.style_page_id));
        Ok(merge(result, cost(&out)))
    })
}

/// A finding of the latest check of the page (or of `job_id`).
pub async fn find_finding(
    session: &Session,
    _project_id: &str,
    page_id: &str,
    finding_id_: &str,
    job_id: Option<&str>,
) -> Result<Value, Error> {
    let mut stmt = docs_ai_job::Entity::find()
        .filter(docs_ai_job::Column::PageId.eq(page_id))
        .filter(docs_ai_job::Column::Kind.eq("check"))
        .filter(docs_ai_job::Column::State.eq("finished"));
    if let Some(job_id) = job_id.filter(|id| !id.is_empty()) {
        stmt = stmt.filter(docs_ai_job::Column::Id.eq(job_id));
    }
    let rows = stmt.order_by_desc(docs_ai_job::Column::QueuedAt).limit(5).all(session).await?;
    for row in rows {
        let result = loads(Some(&row.result), json!({}));
        for f in items(result.get("findings")) {
            if f.get("id").and_then(Value::as_str) == Some(finding_id_) {
                return Ok(f);
            }
        }
    }
    Err(DocsAiError::new("not_found", "That finding is gone. Check the page again.").into())
}

/// The replacement text for one finding.
pub fn check_fix_job(job: docs_ai_job::Model) -> HandlerFuture {
    boxed(async move {
        let inp = input(&job);
        let mut inputs = Map::new();
        inputs.insert("page_id".into(), json!(job.page_id));
        inputs.insert("finding".into(), get(&inp, "finding"));
        inputs.insert("markdown".into(), get(&inp, "markdown"));
        let out = turn(&job, "docs-fix", inputs, None, TurnExtra::default()).await?;
        let data = out.data();
        if !data.get("old").is_some_and(pyjson::truthy) || data.get("new").is_none_or(Value::is_null) {
            return Err(DocsAiError::new("invalid_output", "The assistant did not give a usable fix.").into());
        }
        let mut result = Map::new();
        result.insert("old".into(), get(&data, "old"));
        result.insert("new".into(), get(&data, "new"));
        Ok(merge(result, cost(&out)))
    })
}

/// Draw (or change) a draw.io diagram for the page.
pub fn diagram_job(job: docs_ai_job::Model) -> HandlerFuture {
    boxed(async move {
        let inp = input(&job);
        let mut inputs = Map::new();
        inputs.insert("page_id".into(), json!(job.page_id));
        for key in ["selection", "request", "diagram_id", "label", "markdown"] {
            inputs.insert(key.into(), get(&inp, key));
        }
        let out = turn(&job, "docs-diagram", inputs, None, TurnExtra::default()).await?;
        let data = out.data();
        if !data.get("diagram_id").is_some_and(pyjson::truthy) {
            return Err(DocsAiError::new("invalid_output", "The assistant did not make a diagram.").into());
        }
        let label = get_or(&data, "label", json!("Diagram"));
        let diagram_id = get(&data, "diagram_id");
        let mut result = Map::new();
        result.insert("diagram_id".into(), diagram_id.clone());
        result.insert("label".into(), get_or(&data, "label", get_or(&inp, "label", json!("Diagram"))));
        result.insert(
            "markdown".into(),
            get_or(&data, "markdown", json!(format!("[{}](diagram:{})", text_of(&label), text_of(&diagram_id)))),
        );
        result.insert("changed".into(), json!(data.get("changed").is_none_or(pyjson::truthy)));
        result.insert("version".into(), Value::Null);
        Ok(merge(result, cost(&out)))
    })
}

/// Whether the page still matches the tickets and the code it talks about.
pub fn freshness_job(job: docs_ai_job::Model) -> HandlerFuture {
    boxed(async move {
        let mut inputs = Map::new();
        inputs.insert("page_id".into(), json!(job.page_id));
        let out = turn(&job, "docs-freshness", inputs, None, TurnExtra::default()).await?;
        let data = out.data();
        let mut reasons = Vec::new();
        for (i, r) in items(data.get("reasons")).iter().enumerate() {
            let Some(r) = r.as_object() else { continue };
            let seed = match or_default(r.get("quote"), or_default(r.get("why"), json!(i))) {
                Value::String(text) => text,
                other => pyjson::py_str(&other),
            };
            reasons.push(json!({
                "key": finding_id("stale", &seed),
                "quote": get(r, "quote"),
                "source": get(r, "source"),
                "text": get_or(r, "why", json!("")),
            }));
        }
        let stale = data.get("state").and_then(Value::as_str) == Some("stale") && !reasons.is_empty();
        let mut result = Map::new();
        result.insert("state".into(), json!(if stale { "stale" } else { "ok" }));
        result.insert("reasons".into(), Value::Array(reasons));
        Ok(merge(result, cost(&out)))
    })
}

/// The latest finished freshness check of a page.
async fn latest_freshness(session: &Session, page_id: &str) -> Result<Option<docs_ai_job::Model>, Error> {
    Ok(docs_ai_job::Entity::find()
        .filter(docs_ai_job::Column::PageId.eq(page_id))
        .filter(docs_ai_job::Column::Kind.eq("freshness"))
        .filter(docs_ai_job::Column::State.eq("finished"))
        .order_by_desc(docs_ai_job::Column::QueuedAt)
        .limit(1)
        .one(session)
        .await?)
}

/// The page's freshness as its banner reads it: the latest finished check.
pub async fn freshness_of(session: &Session, page: &docs_page::Model) -> Result<Map<String, Value>, Error> {
    let row = latest_freshness(session, &page.id).await?;
    let result = match &row {
        Some(row) => loads(Some(&row.result), json!({})),
        None => json!({}),
    };
    let dismissed: HashSet<String> = items(result.get("dismissed")).iter().map(text_of).collect();
    let reasons: Vec<Value> = items(result.get("reasons"))
        .into_iter()
        .filter(|r| !r.get("key").is_some_and(|k| dismissed.contains(&text_of(k))))
        .collect();
    let still = result.get("still_correct").is_some_and(pyjson::truthy);
    let state = if row.is_none() {
        "unchecked"
    } else if !reasons.is_empty() && !still {
        "stale"
    } else {
        "ok"
    };
    let mut out = Map::new();
    out.insert("page_id".into(), json!(page.id));
    out.insert("state".into(), json!(state));
    out.insert("stale".into(), json!(state == "stale"));
    out.insert("reasons".into(), Value::Array(reasons));
    out.insert("hidden".into(), json!(dismissed.len()));
    out.insert("checked_at".into(), json!(row.as_ref().and_then(|r| r.ended_at.clone())));
    out.insert("based_on_version".into(), json!(page.version));
    out.insert("current_version".into(), json!(page.version));
    out.insert("ok_until".into(), Value::Null);
    Ok(out)
}

/// Mark the latest freshness check: still correct, or hide one reason.
pub async fn freshness_mark(
    session: &Session,
    page: &docs_page::Model,
    still_correct: bool,
    dismiss: Option<&str>,
) -> Result<Map<String, Value>, Error> {
    if let Some(row) = latest_freshness(session, &page.id).await? {
        let mut result = match loads(Some(&row.result), json!({})) {
            Value::Object(map) => map,
            _ => Map::new(),
        };
        if still_correct {
            result.insert("still_correct".into(), json!(true));
        }
        if let Some(dismiss) = dismiss.filter(|d| !d.is_empty()) {
            let mut held: Vec<String> = items(result.get("dismissed")).iter().map(text_of).collect();
            held.push(dismiss.to_string());
            held.sort();
            held.dedup();
            result.insert("dismissed".into(), json!(held));
        }
        let mut changed = kb_db::edit(row);
        changed.result = Set(pyjson::dumps(&result));
        changed.update(session).await?;
        session.commit().await?;
    }
    freshness_of(session, page).await
}

// ---------------------------------------------------------------------------
// Ask the docs
// ---------------------------------------------------------------------------

/// Answer a question from the docs, with the pages it used.
pub fn ask_job(job: docs_ai_job::Model) -> HandlerFuture {
    boxed(async move {
        let params = match loads(Some(&job.result), json!({})) {
            Value::Object(map) => map,
            _ => Map::new(),
        };
        let scope = get_or(&params, "scope", json!("space"));
        let mut inputs = Map::new();
        inputs.insert("project_id".into(), json!(job.project_id));
        inputs.insert("question".into(), get_or(&params, "question", json!(job.instruction)));
        inputs.insert("scope".into(), scope.clone());
        inputs.insert("page_id".into(), get(&params, "page_id"));
        let name = match job.page_id.as_deref().filter(|id| !id.is_empty()) {
            Some(page_id) if scope.as_str() == Some("page") => sessions::page_name(page_id),
            _ => format!("docs-ask:{}", job.project_id),
        };
        let out = turn(&job, "docs-ask", inputs, Some(name), TurnExtra::default()).await?;
        let data = out.data();
        let mut citations = Vec::new();
        for (i, c) in items(data.get("citations")).iter().enumerate() {
            let Some(c) = c.as_object() else { continue };
            citations.push(json!({
                "n": i + 1,
                "page_id": get(c, "page_id"),
                "title": get_or(c, "title", json!("")),
                "section": get(c, "section"),
            }));
        }
        let verdict = data
            .get("verdict")
            .and_then(Value::as_str)
            .filter(|v| matches!(*v, "answered" | "not_covered" | "conflict"))
            .unwrap_or("answered");
        let cited: HashSet<String> = citations
            .iter()
            .filter_map(|c| c.get("page_id").filter(|p| pyjson::truthy(p)))
            .map(pyjson::py_repr)
            .collect();
        let pages_read = match data.get("pages_read").filter(|v| pyjson::truthy(v)) {
            Some(Value::Number(n)) => n.as_i64().or_else(|| n.as_f64().map(|f| f as i64)).unwrap_or(0),
            Some(Value::String(text)) => pytext::strip(text).parse().map_err(|_| {
                Error::Other(format!(
                    "ValueError: invalid literal for int() with base 10: {}",
                    pyjson::py_repr(&json!(text))
                ))
            })?,
            Some(Value::Bool(_)) => 1,
            Some(other) => {
                return Err(Error::Other(format!(
                    "TypeError: int() argument must be a string, a bytes-like object or a real number, not '{}'",
                    if other.is_array() { "list" } else { "dict" }
                )));
            }
            None => i64::try_from(citations.len()).unwrap_or(0),
        };
        let mut result = Map::new();
        result.insert("answer".into(), get_or(&data, "answer", json!(out.text)));
        result.insert("verdict".into(), json!(verdict));
        result.insert("citations".into(), Value::Array(citations));
        result.insert("closest".into(), json!([]));
        result.insert("conflicts".into(), json!([]));
        result.insert("pages_read".into(), json!(pages_read));
        result.insert("pages_cited".into(), json!(cited.len()));
        result.insert("index_updated_at".into(), Value::Null);
        result.insert("too_long".into(), Value::Null);
        result.insert("asked_model".into(), json!(true));
        Ok(merge(result, cost(&out)))
    })
}

/// A Board AI chat holding a finished question and its answer.
pub async fn open_as_chat(session: &Session, job_id: &str, by: &str) -> Result<String, Error> {
    let job = jobs::get(session, job_id).await?;
    let result = match loads(Some(&job.result), json!({})) {
        Value::Object(map) => map,
        _ => Map::new(),
    };
    let question = or_default(result.get("question"), json!(job.instruction));
    let mut chat = ai_chat::new();
    chat.project_id = Set(job.project_id.clone());
    chat.owner = Set(by.to_string());
    chat.title = Set(clip(
        &text_of(&or_default(result.get("question"), or_default(Some(&json!(job.instruction)), json!("Ask the docs")))),
        80,
    ));
    chat.scope = Set(if job.page_id.as_deref().is_some_and(|p| !p.is_empty()) { "doc" } else { "project" }.to_string());
    chat.scope_id = Set(job.page_id.clone());
    chat.doc_id = Set(job.page_id.clone());
    chat.created_at = Set(now_iso());
    chat.updated_at = Set(now_iso());
    let chat = chat.insert(session).await?;
    let mut ask = ai_chat_message::new();
    ask.id = Set(time::uuid4());
    ask.chat_id = Set(chat.id.clone());
    ask.role = Set("user".to_string());
    ask.text = Set(text_of(&question));
    ask.state = Set("done".to_string());
    ask.created_at = Set(now_iso());
    ask.finished_at = Set(Some(now_iso()));
    ask.insert(session).await?;
    let mut answer = ai_chat_message::new();
    answer.id = Set(time::uuid4());
    answer.chat_id = Set(chat.id.clone());
    answer.role = Set("ai".to_string());
    answer.text = Set(text_of(&get_or(&result, "answer", json!(""))));
    answer.state = Set("done".to_string());
    answer.created_at = Set(now_iso());
    answer.finished_at = Set(Some(now_iso()));
    answer.insert(session).await?;
    session.commit().await?;
    Ok(chat.id)
}

/// Keep the asker's thumbs up or down on an answer.
pub async fn feedback(
    session: &Session,
    job_id: &str,
    by: &str,
    rating: &str,
    reason: &str,
) -> Result<Map<String, Value>, Error> {
    if rating != "up" && rating != "down" {
        return Err(DocsAiError::new("invalid", "Thumbs up or down.").into());
    }
    let job = jobs::get(session, job_id).await?;
    let mut result = match loads(Some(&job.result), json!({})) {
        Value::Object(map) => map,
        _ => Map::new(),
    };
    result.insert("feedback".into(), json!({"rating": rating, "reason": clip(reason, 500), "by": by, "at": now_iso()}));
    let mut changed = kb_db::edit(job);
    changed.result = Set(pyjson::dumps(&result));
    let job = changed.update(session).await?;
    session.commit().await?;
    Ok(jobs::to_dict(&job))
}

// ---------------------------------------------------------------------------
// Write a page, history helpers
// ---------------------------------------------------------------------------

/// Check the Write dialog's values; returns them with defaults filled in.
pub fn normalize_write(params: &Map<String, Value>) -> Result<Map<String, Value>, DocsAiError> {
    let source = match or_default(params.get("source"), json!({})) {
        Value::Object(map) => map,
        _ => Map::new(),
    };
    let kind = source.get("kind").and_then(Value::as_str);
    let Some(kind @ ("ticket" | "idea" | "notes" | "prompt")) = kind else {
        return Err(DocsAiError::new("invalid", "Write from a ticket, an idea, notes or a prompt."));
    };
    let text = or_default(source.get("text"), json!(""));
    if matches!(kind, "notes" | "prompt") && pytext::strip(text.as_str().unwrap_or("")).is_empty() {
        return Err(DocsAiError::new("invalid", "Paste the notes or write what the page is about."));
    }
    if kind == "ticket" && !source.get("ticket_id").is_some_and(pyjson::truthy) {
        return Err(DocsAiError::new("invalid", "Pick a ticket."));
    }
    if kind == "idea" && !source.get("idea_id").is_some_and(pyjson::truthy) {
        return Err(DocsAiError::new("invalid", "Pick an idea."));
    }
    let mut kept = Map::new();
    for key in ["kind", "ticket_id", "idea_id", "text"] {
        kept.insert(key.into(), get(&source, key));
    }
    let title = pytext::strip(params.get("title").filter(|v| pyjson::truthy(v)).and_then(Value::as_str).unwrap_or(""));
    let mut out = Map::new();
    out.insert("source".into(), Value::Object(kept));
    out.insert("page_kind".into(), get_or(params, "page_kind", json!("notes")));
    out.insert(
        "include".into(),
        get_or(params, "include", json!({"comments": true, "linked_pages": true, "code_changes": false})),
    );
    out.insert("title".into(), if title.is_empty() { Value::Null } else { json!(title) });
    out.insert("parent_id".into(), get(params, "parent_id"));
    Ok(out)
}

/// Start writing a page from the picked sources (a `write` job).
pub async fn start_write(
    session: &Session,
    project_id: &str,
    params: &Map<String, Value>,
    by: &str,
) -> Result<docs_ai_job::Model, Error> {
    svc_settings::require_enabled(session, project_id).await?;
    let p = normalize_write(params)?;
    ready_or_raise(project_id).await?;
    let source_kind = p.get("source").and_then(|s| s.get("kind")).map(text_of).unwrap_or_default();
    let instruction = format!("Write a {} from {source_kind}", text_of(&get(&p, "page_kind")));
    let job = jobs::start(
        session,
        jobs::NewJob {
            project_id: project_id.to_string(),
            kind: "write".to_string(),
            started_by: by.to_string(),
            instruction: clip(&instruction, 200),
            result: Some(json!({"params": p})),
            ..Default::default()
        },
    )
    .await?;
    Ok(job)
}

/// Write the page: the assistant creates it as a draft and names what is missing.
pub fn write_job(job: docs_ai_job::Model) -> HandlerFuture {
    boxed(async move {
        let p = input(&job);
        let mut inputs = Map::new();
        inputs.insert("project_id".into(), json!(job.project_id));
        inputs.extend(p.clone());
        let name = format!("docs-write:{}", job.id);
        let out = turn(&job, "docs-write", inputs, Some(name), TurnExtra::default()).await?;
        let data = out.data();
        if !data.get("page_id").is_some_and(pyjson::truthy) {
            return Err(DocsAiError::new("invalid_output", "The assistant did not create the page.").into());
        }
        jobs::update(&job.id, &[("page_id", get(&data, "page_id"))]).await?;
        let mut result = Map::new();
        result.insert("page_id".into(), get(&data, "page_id"));
        result.insert("title".into(), get(&data, "title"));
        result.insert("gaps".into(), get_or(&data, "gaps", json!([])));
        result.insert("sources".into(), json!([get(&p, "source")]));
        Ok(merge(result, cost(&out)))
    })
}

/// The Needs input markers still in the page's text.
pub async fn markers_of(session: &Session, page_id: &str) -> Result<Map<String, Value>, Error> {
    let detail = kb_docs::docs::page_detail(session, page_id).await?;
    let from_draft = match detail.get("draft") {
        Some(Value::Object(draft)) => draft.get("markdown").cloned(),
        _ => None,
    };
    let text = text_of(&or_default(from_draft.as_ref(), or_default(detail.get("markdown"), json!(""))));
    let found: Vec<Value> = MARKER.find_iter(&text).map(|m| json!(m.as_str())).collect();
    let mut out = Map::new();
    out.insert("count".into(), json!(found.len()));
    out.shift_insert(0, "markers".into(), Value::Array(found));
    Ok(out)
}

/// What changed between two versions of the page.
pub fn history_summary_job(job: docs_ai_job::Model) -> HandlerFuture {
    boxed(async move {
        let inp = input(&job);
        let mut inputs = Map::new();
        inputs.insert("task".into(), json!("history_summary"));
        inputs.insert("page_id".into(), json!(job.page_id));
        inputs.extend(inp.clone());
        let out = turn(&job, "docs-history", inputs, None, TurnExtra::default()).await?;
        let mut result = Map::new();
        result.insert("summary".into(), get_or(&out.data(), "summary", json!(out.text)));
        Ok(merge(merge(result, inp), cost(&out)))
    })
}

/// A change note for the draft about to be published.
pub fn publish_note_job(job: docs_ai_job::Model) -> HandlerFuture {
    boxed(async move {
        let mut inputs = Map::new();
        inputs.insert("task".into(), json!("publish_note"));
        inputs.insert("page_id".into(), json!(job.page_id));
        inputs.insert("markdown".into(), get(&input(&job), "markdown"));
        let out = turn(&job, "docs-history", inputs, None, TurnExtra::default()).await?;
        let note = text_of(&get_or(&out.data(), "note", json!(out.text)));
        let mut result = Map::new();
        result.insert("note".into(), json!(clip(pytext::strip(&note), 200)));
        Ok(merge(result, cost(&out)))
    })
}
