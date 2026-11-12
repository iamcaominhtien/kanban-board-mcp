//! Who an MCP call acts for: the run behind a bearer token, and the duplicate-write suppression after a resume.
//!
//! AI v2: a run may do what its tools allow; there is no permission matrix and no approval here. The guard only
//! resolves the token to a `RunContext`, attributes activity to the AI, and skips a write the run already did right
//! before it was resumed.
//!
//! The current run is a `kb_base::ctx` value (Python's `ContextVar`); the run tokens and chat tokens live in statics
//! behind locks. The MCP layer tells the guard which `Authorization` header the current request carries with
//! `set_request_authorization` (Python reads it from the SDK's `request_ctx`).

use std::collections::HashMap;
use std::sync::{LazyLock, Mutex, MutexGuard};
use std::time::Instant;

use kb_base::{activity, ctx, pyjson, pytext, time};
use kb_db::database;
use kb_db::entities::ai_run;
use kb_db::sea_orm::{
    ActiveModelTrait, ActiveValue::Set, ColumnTrait, DbErr, EntityTrait, IntoActiveModel, QueryFilter,
};
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};

use crate::context::RunContext;
use crate::runner_link::token_urlsafe;
use crate::store::{get_profile, get_settings, now_iso};

/// The run the current task acts for (`_ctx`); `None` is "nobody", which `suspend` sets.
#[derive(Clone)]
struct Current(Option<RunContext>);

/// The `Authorization` header of the MCP request being handled (`request.headers.get("authorization")`).
#[derive(Clone)]
struct RequestAuthorization(Option<String>);

/// An AI action was refused; the message is what the agent reads (and it says why).
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{0}")]
pub struct AiActionError(pub String);

/// What `context_for_token` and friends fail with.
#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("{0}")]
    /// The AI action was refused (the message is what the agent reads).
    Action(#[from] AiActionError),
    #[error("{0}")]
    /// The database call failed.
    Db(#[from] DbErr),
}

/// How a run token is stored.
pub fn token_hash(token: &str) -> String {
    format!("{:x}", Sha256::digest(token.as_bytes()))
}

/// A fresh run token (the board keeps only its hash).
pub fn new_token() -> String {
    format!("kbr_{}", token_urlsafe(24))
}

/// Assistant answers have no AiRun: each holds a short-lived token that stands for the asking context (in memory only,
/// gone when the answer ends or the app restarts).
static CHAT_TOKENS: LazyLock<Mutex<HashMap<String, RunContext>>> = LazyLock::new(|| Mutex::new(HashMap::new()));

fn chat_tokens() -> MutexGuard<'static, HashMap<String, RunContext>> {
    CHAT_TOKENS.lock().unwrap_or_else(|e| e.into_inner())
}

/// A token for one assistant answer: its MCP calls act as `ctx`.
pub fn issue_chat_token(context: RunContext) -> String {
    let token = format!("kbr_chat_{}", token_urlsafe(24));
    chat_tokens().insert(token_hash(&token), context);
    token
}

/// The answer ended: its token stops working.
pub fn revoke_chat_token(token: &str) {
    chat_tokens().remove(&token_hash(token));
}

/// The run the current task acts for.
pub fn current() -> Option<RunContext> {
    ctx::get::<Current>().and_then(|c| c.0)
}

/// What `enter` and `suspend` return: give it to `leave`.
#[must_use = "pass the tokens to guard::leave"]
pub struct Entered(ctx::Token, ctx::Token, ctx::Token);

/// Act as `context` until `leave()`: AI attribution on activity entries and the AI's name as actor.
pub fn enter(context: &RunContext) -> Entered {
    let mut info = context.activity();
    info.insert("member_name".into(), json!(context.member_name));
    Entered(
        ctx::set(Current(Some(context.clone()))),
        activity::set_ai(Some(Value::Object(info))),
        activity::set_actor(Some(&context.member_name)),
    )
}

/// Undo `enter`.
pub fn leave(tokens: Entered) {
    ctx::reset(tokens.0);
    ctx::reset(tokens.1);
    ctx::reset(tokens.2);
}

/// Act as nobody until `leave()` with the returned tokens.
pub fn suspend() -> Entered {
    Entered(ctx::set(Current(None)), activity::set_ai(None), activity::set_actor(None))
}

/// The MCP layer says which `Authorization` header the request it is handling carries.
pub fn set_request_authorization(header: Option<&str>) -> ctx::Token {
    ctx::set(RequestAuthorization(header.map(str::to_string)))
}

/// The run token of the current MCP request: a `Bearer kbr_...` header's token.
fn request_token() -> Option<String> {
    let auth = ctx::get::<RequestAuthorization>().and_then(|a| a.0).filter(|a| !a.is_empty())?;
    request_token_of(&auth)
}

/// The token in an `Authorization` header value, when it is a board run token (`bearer kbr_...`, any case of the word).
pub fn request_token_of(auth: &str) -> Option<String> {
    if !auth.to_lowercase().starts_with("bearer kbr_") {
        return None;
    }
    // `auth.split(None, 1)[1].strip()`
    let trimmed = auth.trim_start_matches(pytext::is_space);
    let rest = trimmed.trim_start_matches(|c: char| !pytext::is_space(c)).trim_start_matches(pytext::is_space);
    Some(pytext::strip(rest).to_string())
}

/// The live run a token belongs to.
///
/// Fails with `AiActionError` when the run ended (finished, cancelled, stopped): its token is dead.
pub async fn context_for_token(token: &str) -> Result<RunContext, Error> {
    if let Some(chat) = chat_tokens().get(&token_hash(token)) {
        return Ok(chat.clone());
    }
    let session = database::session();
    let run = ai_run::Entity::find().filter(ai_run::Column::TokenHash.eq(token_hash(token))).one(&session).await?;
    let run = match run {
        Some(run) if matches!(run.state.as_str(), "starting" | "running") => run,
        _ => {
            return Err(AiActionError(
                "This AI run has ended (finished, cancelled or stopped by a person); the board no longer accepts its calls. Stop now."
                    .to_string(),
            )
            .into());
        }
    };
    let (member, profile) = get_profile(&session, &run.member_id).await?;
    if let Some(profile) = profile {
        let mut row = kb_db::edit(profile);
        row.mcp_last_used_at = Set(Some(now_iso()));
        row.update(&session).await?;
        session.commit().await?;
    }
    Ok(RunContext {
        run_id: run.id.clone(),
        member_id: run.member_id.clone(),
        member_name: member.map_or_else(|| "AI".to_string(), |m| m.name),
        project_id: run.project_id.clone(),
        ticket_id: run.ticket_id.clone(),
        on_behalf_of: run.started_by.clone(),
        mode: if run.mode.is_empty() { "work".to_string() } else { run.mode.clone() },
        trigger: run.trigger.clone(),
        depth: i64::from(run.depth),
        acts_by_tier: false,
    })
}

/// The run of the current MCP request (from its bearer token), or the one already entered.
pub async fn resolve() -> Result<Option<RunContext>, Error> {
    if let Some(context) = current() {
        return Ok(Some(context));
    }
    let Some(token) = request_token() else { return Ok(None) };
    Ok(Some(context_for_token(&token).await?))
}

/// Project AI settings as they apply to this run.
pub async fn settings_for(
    session: &kb_db::Session,
    context: &RunContext,
) -> Result<kb_db::entities::ai_project_settings::Model, DbErr> {
    get_settings(session, &context.project_id).await
}

/// A run resumed with its conversation (a retry, a restart) may repeat the write it made right before the cut: the
/// board answers with the earlier result instead of doing it twice.
pub const DUPLICATE_WINDOW_S: f64 = 180.0;
/// The tools whose writes are remembered for the duplicate suppression after a resume.
pub const WRITE_TOOLS: [&str; 6] =
    ["manage_ticket", "ticket_items", "docs_write", "ticket_branches", "manage_project", "ai_run"];

static START: LazyLock<Instant> = LazyLock::new(Instant::now);

/// `time.monotonic()`.
fn monotonic() -> f64 {
    START.elapsed().as_secs_f64()
}

type Write = (f64, String, Value);

#[derive(Default)]
struct Writes {
    recent: HashMap<String, Vec<Write>>,
    resumed_at: HashMap<String, f64>,
}

static WRITES: LazyLock<Mutex<Writes>> = LazyLock::new(|| Mutex::new(Writes::default()));

fn writes() -> MutexGuard<'static, Writes> {
    WRITES.lock().unwrap_or_else(|e| e.into_inner())
}

/// The run's CLI starts again with its conversation: repeats from before now are skipped.
pub fn mark_resumed(run_id: &str) {
    writes().resumed_at.insert(run_id.to_string(), monotonic());
}

/// `mark_resumed` at a given `monotonic` moment (the tests move time).
pub fn mark_resumed_at(run_id: &str, at: f64) {
    writes().resumed_at.insert(run_id.to_string(), at);
}

/// The run ended: nothing to suppress any more.
pub fn forget_run(run_id: &str) {
    let mut w = writes();
    w.recent.remove(run_id);
    w.resumed_at.remove(run_id);
}

/// `json.dumps([tool, action, given], sort_keys=True, default=str)`.
pub fn fingerprint(tool: &str, action: &str, given: &Map<String, Value>) -> String {
    pyjson::Dumps::new().sort_keys(true).dump(&json!([tool, action, given]))
}

fn repeat_of(run_id: &str, fp: &str, now: f64) -> Option<Value> {
    let w = writes();
    let resumed = *w.resumed_at.get(run_id)?;
    for (at, seen, result) in w.recent.get(run_id).map_or(&[][..], |v| v.as_slice()).iter().rev() {
        if now - at > DUPLICATE_WINDOW_S {
            break;
        }
        if seen == fp && *at < resumed {
            return Some(result.clone());
        }
    }
    None
}

fn remember_write(run_id: &str, fp: String, result: Value, now: f64) {
    let mut w = writes();
    let list = w.recent.entry(run_id.to_string()).or_default();
    let mut kept: Vec<Write> = list.iter().filter(|x| now - x.0 <= DUPLICATE_WINDOW_S).cloned().collect();
    kept.push((now, fp, result));
    let start = kept.len().saturating_sub(50);
    *list = kept.split_off(start);
}

/// `repeat_of` and `remember_write` for the tests: the earlier result of a write, and recording one, at a given time.
pub fn repeat_of_at(run_id: &str, fp: &str, now: f64) -> Option<Value> {
    repeat_of(run_id, fp, now)
}

/// `_remember_write` at a given time.
pub fn remember_write_at(run_id: &str, fp: &str, result: Value, now: f64) {
    remember_write(run_id, fp.to_string(), result, now);
}

/// The note added to an earlier result that is handed back instead of a repeated write.
pub const ALREADY_DONE: &str = "Not repeated: this run already did exactly this a moment ago, before it was resumed. Here is what it returned then; carry on from there.";

/// Run `call(given)` for an MCP tool, attributed to the AI run it comes from.
///
/// `call` is what the tool does with the arguments; it fails with whatever its own error type is (`E`), and a failure
/// of the guard itself (a dead token) is `GuardedError::Guard`.
pub async fn guarded<E, F, Fut>(
    tool: &str,
    action: &str,
    given: Map<String, Value>,
    call: F,
) -> Result<Value, GuardedError<E>>
where
    F: FnOnce(Map<String, Value>) -> Fut,
    Fut: std::future::Future<Output = Result<Value, E>>,
{
    let resolved = resolve().await.map_err(GuardedError::Guard)?;
    guarded_with(resolved, tool, action, given, call).await
}

/// `resolve()` for a request whose `Authorization` header is given (the MCP layer holds the header itself): the run
/// already entered, else the run behind a `Bearer kbr_...` token, else None.
pub async fn resolve_for(authorization: Option<&str>) -> Result<Option<RunContext>, Error> {
    if let Some(context) = current() {
        return Ok(Some(context));
    }
    let Some(token) = authorization.and_then(request_token_of) else { return Ok(None) };
    Ok(Some(context_for_token(&token).await?))
}

/// `guarded` for a request whose `Authorization` header is given.
pub async fn guarded_for<E, F, Fut>(
    authorization: Option<&str>,
    tool: &str,
    action: &str,
    given: Map<String, Value>,
    call: F,
) -> Result<Value, GuardedError<E>>
where
    F: FnOnce(Map<String, Value>) -> Fut,
    Fut: std::future::Future<Output = Result<Value, E>>,
{
    let resolved = resolve_for(authorization).await.map_err(GuardedError::Guard)?;
    guarded_with(resolved, tool, action, given, call).await
}

async fn guarded_with<E, F, Fut>(
    resolved: Option<RunContext>,
    tool: &str,
    action: &str,
    given: Map<String, Value>,
    call: F,
) -> Result<Value, GuardedError<E>>
where
    F: FnOnce(Map<String, Value>) -> Fut,
    Fut: std::future::Future<Output = Result<Value, E>>,
{
    let Some(context) = resolved else {
        return call(given).await.map_err(GuardedError::Call);
    };
    // Omitted optional arguments arrive as None and mean "unchanged": they never count as a change
    let mut given: Map<String, Value> = given.into_iter().filter(|(_, v)| !v.is_null()).collect();
    let fp = (!context.run_id.is_empty() && WRITE_TOOLS.contains(&tool)).then(|| fingerprint(tool, action, &given));
    if let Some(fp) = &fp {
        if let Some(earlier) = repeat_of(&context.run_id, fp, monotonic()).filter(|v| !v.is_null()) {
            return Ok(match earlier {
                Value::Object(mut map) => {
                    map.insert("already_done".into(), json!(ALREADY_DONE));
                    Value::Object(map)
                }
                _ => json!({"already_done": ALREADY_DONE}),
            });
        }
    }
    let tokens = current().is_none().then(|| enter(&context));
    if tool == "ticket_items" && matches!(action, "comment.add" | "attachment.add") {
        given.insert("author".into(), json!(context.member_name));
    }
    let result = call(given).await;
    if let (Some(fp), Ok(value)) = (fp, &result) {
        remember_write(&context.run_id, fp, value.clone(), monotonic());
    }
    if let Some(tokens) = tokens {
        leave(tokens);
    }
    result.map_err(GuardedError::Call)
}

/// What `guarded` fails with.
#[derive(Debug)]
pub enum GuardedError<E> {
    /// The token did not resolve (a dead run).
    Guard(Error),
    /// The tool's own failure.
    Call(E),
}

/// Now, ISO.
pub fn at_least_now() -> String {
    time::now_iso()
}
