//! Docs AI jobs: one row per Docs AI call, the Docs counterpart of an AI run (`services/docs_ai/jobs.py`, lines 1 to
//! 318).
//!
//! A feature module registers a handler for its job kind (`register("check", handler)`; `crate::register()` does it
//! for the kinds of `assistant::docs`). `start()` creates the row and runs the handler in the background; the handler
//! returns a result dict and calls the engine, whose cost `account()` adds to the row. Jobs are what the Activity
//! view and the "Read" chips report.
//!
//! Stopping. Python cancels the task that runs the job (`TASKS[job_id].cancel()`); the task catches the
//! `CancelledError`, finishes the job as `cancelled` and lets it go on. Here the task waits for its handler beside a
//! stop signal (`TASKS` holds the signal); on the signal the handler's future is dropped (what it holds stops the
//! CLI, `engine::Running`) and the job is finished as `cancelled`.

use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{LazyLock, Mutex, MutexGuard, RwLock};

use kb_ai::store::{loads, now_iso};
use kb_base::{ctx, events, pyjson};
use kb_db::Session;
use kb_db::database;
use kb_db::entities::docs_ai_job;
use kb_db::sea_orm::ActiveValue::Set;
use kb_db::sea_orm::{ActiveModelTrait, ColumnTrait, DbErr, EntityTrait, QueryFilter, QueryOrder, QuerySelect};
use serde_json::{Map, Value, json};
use std::sync::Arc;
use tokio::sync::Notify;

use super::errors::{DocsAiError, Error};
use crate::assistant::engine::Turn;
use crate::assistant::settings::round_to;

/// What a handler gives back: the result dict to merge into the job, or `None`.
pub type HandlerFuture = Pin<Box<dyn Future<Output = Result<Option<Map<String, Value>>, Error>> + Send>>;
/// `Handler = Callable[[DocsAiJob], Awaitable[dict | None]]`.
pub type Handler = fn(docs_ai_job::Model) -> HandlerFuture;

/// `HANDLERS`: the function that does each kind of job.
static HANDLERS: LazyLock<RwLock<HashMap<String, Handler>>> = LazyLock::new(|| RwLock::new(HashMap::new()));
/// `TASKS`: the stop signal of the task running each job (a serial number tells one task of a job from another).
static TASKS: LazyLock<Mutex<HashMap<String, (u64, Arc<Notify>)>>> = LazyLock::new(|| Mutex::new(HashMap::new()));
static SERIAL: AtomicU64 = AtomicU64::new(0);
/// The states of a job that is not over.
pub const ACTIVE: [&str; 2] = ["queued", "running"];
/// The steps a job keeps (the latest ones).
pub const MAX_STEPS: usize = 40;

fn tasks() -> MutexGuard<'static, HashMap<String, (u64, Arc<Notify>)>> {
    TASKS.lock().unwrap_or_else(|e| e.into_inner())
}

/// `@jobs.handler(kind)`: register the function that does a kind of job (a later call replaces the earlier one).
pub fn register(kind: &str, handler: Handler) {
    HANDLERS.write().unwrap_or_else(|e| e.into_inner()).insert(kind.to_string(), handler);
}

/// `HANDLERS.get(kind)`.
pub fn handler_of(kind: &str) -> Option<Handler> {
    HANDLERS.read().unwrap_or_else(|e| e.into_inner()).get(kind).copied()
}

/// `job_id in TASKS`: a task is running this job.
pub fn is_running(job_id: &str) -> bool {
    tasks().contains_key(job_id)
}

async fn publish() {
    events::publish(events::INVALIDATE, &[]).await;
}

/// The job as the API and MCP show it.
pub fn to_dict(j: &docs_ai_job::Model) -> Map<String, Value> {
    let result: Map<String, Value> = match loads(Some(&j.result), json!({})) {
        Value::Object(map) => map.into_iter().filter(|(k, _)| k != "undo").collect(),
        _ => Map::new(),
    };
    let mut out = Map::new();
    out.insert("id".into(), json!(j.id));
    out.insert("project_id".into(), json!(j.project_id));
    out.insert("page_id".into(), json!(j.page_id));
    out.insert("thread_id".into(), json!(j.thread_id));
    out.insert("comment_id".into(), json!(j.comment_id));
    out.insert("member_id".into(), json!(j.member_id));
    out.insert("kind".into(), json!(j.kind));
    out.insert("state".into(), json!(j.state));
    out.insert("started_by".into(), json!(j.started_by));
    out.insert("instruction".into(), json!(j.instruction));
    out.insert("reads".into(), loads(Some(&j.reads), json!([])));
    out.insert("steps".into(), loads(Some(&j.steps), json!([])));
    out.insert("result".into(), Value::Object(result));
    out.insert("error".into(), loads(Some(&j.error), json!({})));
    out.insert("tokens_in".into(), json!(j.tokens_in));
    out.insert("tokens_out".into(), json!(j.tokens_out));
    out.insert("cost".into(), json!(round_to(j.cost_usd.get(), 6)));
    out.insert("metered".into(), json!(j.metered));
    out.insert("reply_comment_id".into(), json!(j.reply_comment_id));
    out.insert("queued_at".into(), json!(j.queued_at));
    out.insert("started_at".into(), json!(j.started_at));
    out.insert("ended_at".into(), json!(j.ended_at));
    out
}

/// The keyword arguments of `create` and `start`.
#[derive(Debug, Clone, Default)]
pub struct NewJob {
    /// The project the job is in.
    pub project_id: String,
    /// What the job does (a key of the handlers).
    pub kind: String,
    /// The person who started it.
    pub started_by: String,
    /// The page it is about.
    pub page_id: Option<String>,
    /// The comment thread it is about.
    pub thread_id: Option<String>,
    /// The comment that started it.
    pub comment_id: Option<String>,
    /// The AI team asked.
    pub member_id: Option<String>,
    /// What was asked (kept to 8000 characters).
    pub instruction: String,
    /// What is stored as the job's result before it runs (`{"input": ...}` for the handler).
    pub result: Option<Value>,
}

/// Record a job (queued). `start` runs it.
pub async fn create(session: &Session, new: NewJob) -> Result<docs_ai_job::Model, DbErr> {
    let mut job = docs_ai_job::new();
    job.project_id = Set(new.project_id);
    job.kind = Set(new.kind);
    job.started_by = Set(new.started_by);
    job.page_id = Set(new.page_id);
    job.thread_id = Set(new.thread_id);
    job.comment_id = Set(new.comment_id);
    job.member_id = Set(new.member_id);
    job.instruction = Set(new.instruction.chars().take(8000).collect());
    let result = new.result.filter(pyjson::truthy).unwrap_or_else(|| json!({}));
    job.result = Set(pyjson::dumps(&result));
    let job = job.insert(session).await?;
    session.commit().await?;
    Ok(job)
}

/// Run a job in the background.
pub fn spawn(job_id: &str) {
    let stop = Arc::new(Notify::new());
    let serial = SERIAL.fetch_add(1, Ordering::SeqCst);
    tasks().insert(job_id.to_string(), (serial, stop.clone()));
    let job_id = job_id.to_string();
    ctx::spawn(async move {
        if let Err(err) = run_stoppable(&job_id, &stop).await {
            tracing::error!(target: "kanban.docs_ai.jobs", "Docs AI job {job_id} was not recorded: {err}");
        }
        let mut tasks = tasks();
        if tasks.get(&job_id).is_some_and(|(held, _)| *held == serial) {
            tasks.remove(&job_id);
        }
    });
}

/// Create a job and run it in the background.
pub async fn start(session: &Session, new: NewJob) -> Result<docs_ai_job::Model, DbErr> {
    let job = create(session, new).await?;
    spawn(&job.id);
    publish().await;
    Ok(job)
}

/// `run` and, beside it, the stop signal (`CancelledError`): the job is finished as cancelled. A job stopped before
/// its task began never ran in Python (the task is cancelled before its first step): the row stays as `cancel` wrote
/// it. The stop signal is looked at first, so one that came before the task began wins.
async fn run_stoppable(job_id: &str, stop: &Notify) -> Result<(), DbErr> {
    tokio::select! {
        biased;
        () = stop.notified() => {
            let started = {
                let session = database::session();
                docs_ai_job::Entity::find_by_id(job_id).one(&session).await?.is_some_and(|j| j.started_at.is_some())
            };
            if !started {
                return Ok(());
            }
            finish(job_id, "cancelled", None, Some(json!({"code": "cancelled", "message": "Stopped."}))).await
        }
        result = run(job_id) => result,
    }
}

/// Do the job: mark it running, call its handler, record the result or the error.
pub async fn run(job_id: &str) -> Result<(), DbErr> {
    let job = {
        let session = database::session();
        let Some(job) = docs_ai_job::Entity::find_by_id(job_id).one(&session).await? else { return Ok(()) };
        if job.state != "queued" {
            return Ok(());
        }
        let mut row = kb_db::edit(job);
        row.state = Set("running".to_string());
        row.started_at = Set(Some(now_iso()));
        let job = row.update(&session).await?;
        session.commit().await?;
        job
    };
    let kind = job.kind.clone();
    let outcome = match handler_of(&kind) {
        None => Err(DocsAiError::new("unavailable", format!("No handler for {kind} jobs.")).into()),
        Some(handler) => handler(job).await,
    };
    match outcome {
        Ok(result) => finish(job_id, "finished", result.map(Value::Object), None).await,
        Err(Error::DocsAi(exc)) => {
            let mut error = Map::new();
            error.insert("code".into(), json!(exc.code));
            error.insert("message".into(), json!(exc.message));
            error.extend(exc.extra);
            finish(job_id, "failed", None, Some(Value::Object(error))).await
        }
        Err(other) => {
            // a job that fails must say so
            tracing::error!(target: "kanban.docs_ai.jobs", "Docs AI job {job_id} ({kind}) failed: {other}");
            let error = json!({"code": "error", "message": format!("Couldn't finish ({}).", other.kind())});
            finish(job_id, "failed", None, Some(error)).await
        }
    }
}

/// Close a job. `result` merges into what the handler already stored.
pub async fn finish(job_id: &str, state: &str, result: Option<Value>, error: Option<Value>) -> Result<(), DbErr> {
    {
        let session = database::session();
        let Some(job) = docs_ai_job::Entity::find_by_id(job_id).one(&session).await? else { return Ok(()) };
        let stored = job.result.clone();
        let mut row = kb_db::edit(job);
        row.state = Set(state.to_string());
        row.ended_at = Set(Some(now_iso()));
        if let Some(Value::Object(result)) = result {
            let mut merged = match loads(Some(&stored), json!({})) {
                Value::Object(map) => map,
                _ => Map::new(),
            };
            merged.extend(result);
            row.result = Set(pyjson::dumps(&merged));
        }
        if let Some(error) = error {
            row.error = Set(pyjson::dumps(&error));
        }
        row.update(&session).await?;
        session.commit().await?;
    }
    publish().await;
    Ok(())
}

/// Set columns of a job (JSON columns take Python values): `reads`, `steps`, `result`, `error` are written as JSON;
/// `page_id`, `thread_id`, `comment_id`, `member_id`, `session_id`, `reply_comment_id` and `instruction` as text
/// (`null` clears the ones that may be empty).
pub async fn update(job_id: &str, fields: &[(&str, Value)]) -> Result<(), DbErr> {
    let session = database::session();
    let Some(job) = docs_ai_job::Entity::find_by_id(job_id).one(&session).await? else { return Ok(()) };
    let mut row = kb_db::edit(job);
    for (key, value) in fields {
        let text = || value.as_str().map(str::to_string);
        match *key {
            "reads" => row.reads = Set(pyjson::dumps(value)),
            "steps" => row.steps = Set(pyjson::dumps(value)),
            "result" => row.result = Set(pyjson::dumps(value)),
            "error" => row.error = Set(pyjson::dumps(value)),
            "page_id" => row.page_id = Set(text()),
            "thread_id" => row.thread_id = Set(text()),
            "comment_id" => row.comment_id = Set(text()),
            "member_id" => row.member_id = Set(text()),
            "session_id" => row.session_id = Set(text()),
            "reply_comment_id" => row.reply_comment_id = Set(text()),
            "instruction" => row.instruction = Set(text().unwrap_or_default()),
            other => {
                return Err(DbErr::Custom(format!("docs_ai_job has no column {other} to set")));
            }
        }
    }
    row.update(&session).await?;
    session.commit().await
}

/// Append a visible step ("Reading Architecture › API").
pub async fn add_step(job_id: &str, text: &str) -> Result<(), DbErr> {
    {
        let session = database::session();
        let Some(job) = docs_ai_job::Entity::find_by_id(job_id).one(&session).await? else { return Ok(()) };
        let mut steps = match loads(Some(&job.steps), json!([])) {
            Value::Array(items) => items,
            _ => Vec::new(),
        };
        steps.push(json!({"at": now_iso(), "text": text}));
        let skip = steps.len().saturating_sub(MAX_STEPS);
        let kept: Vec<Value> = steps.into_iter().skip(skip).collect();
        let mut row = kb_db::edit(job);
        row.steps = Set(pyjson::dumps(&kept));
        row.update(&session).await?;
        session.commit().await?;
    }
    publish().await;
    Ok(())
}

/// Pages the job read (shown as "Read" chips).
pub async fn set_reads(job_id: &str, reads: &[Value]) -> Result<(), DbErr> {
    update(job_id, &[("reads", Value::Array(reads.to_vec()))]).await
}

/// Copy a turn's tokens and cost onto the job, for the job list and the page's "AI · $0.004" label.
///
/// One Docs AI call leaves three rows, each with one job: this `docs_ai_job` (the Docs UI's queue, state and
/// result), the `ai_run` of kind `assistant` (steps, session and the cost the budget and the AI Team page count) and
/// an `ai_usage` line (Settings › AI: this month's spend per feature, unmetered here). `ai_run` is the source of the
/// cost; the job's figure is a copy that nothing sums, and `ai_usage` is not metered, so a call is counted once.
pub async fn account(job_id: &str, out: &Turn, member_id: Option<&str>) -> Result<(), DbErr> {
    let session = database::session();
    let Some(job) = docs_ai_job::Entity::find_by_id(job_id).one(&session).await? else { return Ok(()) };
    let tokens_in = job.tokens_in.saturating_add(i32::try_from(out.tokens_in).unwrap_or(i32::MAX));
    let tokens_out = job.tokens_out.saturating_add(i32::try_from(out.tokens_out).unwrap_or(i32::MAX));
    let cost = round_to(job.cost_usd + out.cost, 6);
    let metered = job.metered || out.metered;
    let mut row = kb_db::edit(job);
    row.tokens_in = Set(tokens_in);
    row.tokens_out = Set(tokens_out);
    row.cost_usd = Set(cost.into());
    row.metered = Set(metered);
    if let Some(member_id) = member_id.filter(|id| !id.is_empty()) {
        row.member_id = Set(Some(member_id.to_string()));
    }
    row.update(&session).await?;
    session.commit().await
}

/// A job, or `not_found`.
pub async fn get(session: &Session, job_id: &str) -> Result<docs_ai_job::Model, Error> {
    match docs_ai_job::Entity::find_by_id(job_id).one(session).await? {
        Some(job) => Ok(job),
        None => Err(DocsAiError::new("not_found", "That Docs AI job does not exist.").into()),
    }
}

/// The filters of `list_jobs` (an empty one is not applied).
#[derive(Debug, Clone, Default)]
pub struct JobFilter<'a> {
    /// Jobs about this page.
    pub page_id: Option<&'a str>,
    /// Jobs about this thread.
    pub thread_id: Option<&'a str>,
    /// Jobs of this kind.
    pub kind: Option<&'a str>,
    /// Jobs in this state.
    pub state: Option<&'a str>,
    /// Jobs of this AI team.
    pub member_id: Option<&'a str>,
}

/// Newest first.
pub async fn list_jobs(
    session: &Session,
    project_id: &str,
    filter: JobFilter<'_>,
    limit: i64,
) -> Result<Vec<docs_ai_job::Model>, DbErr> {
    let mut stmt = docs_ai_job::Entity::find().filter(docs_ai_job::Column::ProjectId.eq(project_id));
    for (column, value) in [
        (docs_ai_job::Column::PageId, filter.page_id),
        (docs_ai_job::Column::ThreadId, filter.thread_id),
        (docs_ai_job::Column::Kind, filter.kind),
        (docs_ai_job::Column::State, filter.state),
        (docs_ai_job::Column::MemberId, filter.member_id),
    ] {
        if let Some(value) = value.filter(|v| !v.is_empty()) {
            stmt = stmt.filter(column.eq(value));
        }
    }
    let limit = u64::try_from(limit.clamp(1, 200)).unwrap_or(50);
    stmt.order_by_desc(docs_ai_job::Column::QueuedAt).limit(limit).all(session).await
}

/// Stop a queued or running job.
pub async fn cancel(session: &Session, job_id: &str, by: &str) -> Result<docs_ai_job::Model, Error> {
    let job = get(session, job_id).await?;
    if !ACTIVE.contains(&job.state.as_str()) {
        return Ok(job);
    }
    let stop = tasks().get(job_id).map(|(_, stop)| stop.clone());
    if let Some(stop) = stop {
        stop.notify_one();
    }
    let mut row = kb_db::edit(job);
    row.state = Set("cancelled".to_string());
    row.ended_at = Set(Some(now_iso()));
    row.error = Set(pyjson::dumps(&json!({"code": "cancelled", "message": format!("Stopped by {by}.")})));
    let job = row.update(session).await?;
    session.commit().await?;
    publish().await;
    Ok(job)
}

/// After a restart, jobs that were still going are marked failed so nothing spins forever.
pub async fn recover() -> Result<(), DbErr> {
    let session = database::session();
    let rows = docs_ai_job::Entity::find().filter(docs_ai_job::Column::State.is_in(ACTIVE)).all(&session).await?;
    let any = !rows.is_empty();
    for j in rows {
        let mut row = kb_db::edit(j);
        row.state = Set("failed".to_string());
        row.ended_at = Set(Some(now_iso()));
        row.error = Set(pyjson::dumps(&json!({
            "code": "restart",
            "message": "The board restarted before this finished. Try again.",
        })));
        row.update(&session).await?;
    }
    if any {
        session.commit().await?;
    }
    Ok(())
}
