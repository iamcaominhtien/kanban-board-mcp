//! Execution (`services/ai/runs.py` lines 563-951): `_ctx_for`, `_session_for`, `_execute`, `_execute_cli`,
//! `_attach_result`, `_record_messages`.

use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::time::Duration;

use kb_ai::context::RunContext;
use kb_ai::store::{get_profile, loads, now_iso, py_int};
use kb_ai::{guard, quota, steps, transcripts};
use kb_ai_work::worktrees;
use kb_base::secrets::redact;
use kb_base::{ctx, events, pyjson, time};
use kb_db::Session;
use kb_db::database;
use kb_db::entities::{ai_account, ai_run, ai_run_message, ticket};
use kb_db::sea_orm::{
    ActiveModelTrait, ActiveValue::Set, ColumnTrait, DbErr, EntityTrait, QueryFilter, QueryOrder, QuerySelect,
};
use serde_json::{Map, Value, json};
use tokio::sync::watch;

use super::{
    ENDED, EndOpts, RESTART_FRESH_NOTE, RESTART_NOTE, RT, RunLife, RunTask, StepWriter, cli_env, clip, end, finish,
    monotonic, needs_input, restart_inside_run, starting_timeout_s, url, watch_every_s,
};
use crate::cli::CliProcess;
use crate::stream::Parser;
use crate::{accounts, cli, launch, resources, seams};

/// What ends `_execute_cli` early (any exception of the Python function).
pub(crate) type Failure = Box<dyn std::error::Error + Send + Sync>;

tokio::task_local! {
    /// The run whose task this is (`asyncio.current_task()` compared with `RT.tasks[run_id]`).
    static RUN_TASK: String;
}

/// `RT.tasks.get(run_id) is asyncio.current_task()`: the caller runs inside the task of this run.
pub(crate) fn in_task_of(run_id: &str) -> bool {
    RUN_TASK.try_with(|id| id == run_id).unwrap_or(false)
}

/// The `finally` of `_execute`, also when the task is stopped from outside.
///
/// Python pops whatever is under the run's id. A run that asks a question can be answered before its first task
/// has come to this point; the answer's new task (and soon its CLI) is then under the same id, and Python's `pop`
/// takes them away (the new CLI can no longer be stopped or written to). Here a task only takes away what is its
/// own.
struct Cleanup {
    run_id: String,
    generation: u64,
    done: watch::Sender<bool>,
}

impl Drop for Cleanup {
    fn drop(&mut self) {
        let mut inner = RT.inner();
        if inner.tasks.get(&self.run_id).is_some_and(|t| t.generation == self.generation) {
            inner.tasks.remove(&self.run_id);
        }
        if inner.procs.get(&self.run_id).is_some_and(|(generation, _)| *generation == self.generation) {
            inner.procs.remove(&self.run_id);
        }
        inner.cancelled.remove(&self.run_id);
        inner.restart_requests.remove(&self.run_id);
        drop(inner);
        let _ = self.done.send(true);
    }
}

/// Wait (at most ten seconds) until the task of a run that is being cancelled has let go of its CLI.
///
/// A cancel stops the CLI and ends the run from the canceller's task while the run's own task is still on its way out:
/// it reaps the CLI, writes the steps it still holds and closes the roles that were open. In Python that task gets
/// there while `_end` is busy with the transcript, so the roles' last markers come before the "Cancelled" step, which
/// stays the run's last step; here the two tasks run at the same time, so the canceller waits for the other before it
/// writes that step. (Python waits for the task too, after `_end`, for the same ten seconds.)
pub(crate) async fn settled(run_id: &str) {
    if !RT.is_cancelled(run_id) || in_task_of(run_id) {
        return;
    }
    let task = RT.inner().tasks.get(run_id).map(|t| t.done.clone());
    if let Some(mut done) = task {
        let _ = tokio::time::timeout(Duration::from_secs(10), done.wait_for(|over| *over)).await;
    }
}

/// `RT.tasks[run_id] = asyncio.create_task(_execute(run_id, token, note))`.
pub(crate) fn spawn_execute(run_id: &str, token: String, note: Option<String>) {
    let generation = RT.next_generation();
    let (done_tx, done_rx) = watch::channel(false);
    let id = run_id.to_string();
    let cleanup = Cleanup { run_id: id.clone(), generation, done: done_tx };
    // the task is entered before it can end (the lock is held until it is in the table)
    let mut inner = RT.inner();
    let handle = ctx::spawn(RUN_TASK.scope(id.clone(), async move {
        let _cleanup = cleanup;
        execute(&id, &token, note.as_deref(), generation).await;
    }));
    inner.tasks.insert(run_id.to_string(), RunTask { generation, abort: handle.abort_handle(), done: done_rx });
}

pub(crate) async fn ctx_for(session: &Session, run: &ai_run::Model) -> Result<RunContext, DbErr> {
    let (member, _) = get_profile(session, &run.member_id).await?;
    Ok(RunContext {
        run_id: run.id.clone(),
        member_id: run.member_id.clone(),
        member_name: member.map_or_else(|| "AI".to_string(), |m| m.name),
        project_id: run.project_id.clone(),
        ticket_id: run.ticket_id.clone(),
        on_behalf_of: run.started_by.clone(),
        mode: run.mode.clone(),
        trigger: run.trigger.clone(),
        depth: i64::from(run.depth),
        acts_by_tier: false,
    })
}

/// The CLI session this run continues: its own, else the team's last one on this ticket. (session id, note).
async fn session_for(
    session: &Session,
    run: &ai_run::Model,
    config_dir: Option<&str>,
) -> Result<(Option<String>, Option<String>), DbErr> {
    let mut wanted = run.session_id.clone().filter(|s| !s.is_empty());
    let ticket_id = run.ticket_id.as_deref().filter(|t| !t.is_empty());
    let closed: HashSet<String> = match ticket_id {
        Some(ticket_id) => seams::closed_session_ids(session, ticket_id).await?,
        None => HashSet::new(),
    };
    if wanted.as_ref().is_some_and(|w| closed.contains(w)) {
        wanted = None;
    }
    if let (None, Some(ticket_id)) = (&wanted, ticket_id) {
        let prev = ai_run::Entity::find()
            .filter(ai_run::Column::TicketId.eq(ticket_id))
            .filter(ai_run::Column::MemberId.eq(run.member_id.as_str()))
            .filter(ai_run::Column::Id.ne(run.id.as_str()))
            .filter(ai_run::Column::SessionId.is_not_null())
            .filter(ai_run::Column::StartedAt.is_not_null())
            .order_by_desc(ai_run::Column::QueuedAt)
            .limit(1)
            .one(session)
            .await?;
        wanted = prev.and_then(|p| p.session_id).filter(|s| !s.is_empty() && !closed.contains(s));
    }
    match wanted {
        Some(wanted) if cli::session_exists(&wanted, config_dir, Some("claude-code")) => Ok((Some(wanted), None)),
        Some(_) => Ok((None, Some("Earlier conversation not found on this computer: starting a new one".to_string()))),
        None => Ok((None, None)),
    }
}

async fn execute(run_id: &str, token: &str, note: Option<&str>, generation: u64) {
    if let Err(err) = execute_cli(run_id, token, note, None, generation).await {
        tracing::error!(target: "kanban.ai.runs", "AI run {run_id} crashed: {err}");
        let reason = format!("The runner failed: {}", clip(&redact(&err.to_string()), 300));
        if let Err(err) = end(run_id, "failed", Some(&reason), EndOpts::default()).await {
            tracing::error!(target: "kanban.ai.runs", "AI run {run_id} could not be ended: {err}");
        }
    }
}

/// An `OSError` of `proc.start()` as Python words it (`[Errno 2] No such file or directory: '/path/claude'`).
fn os_error_text(err: &std::io::Error, program: &str) -> String {
    match err.raw_os_error() {
        Some(code) => {
            let text = err.to_string();
            let text = text.strip_suffix(&format!(" (os error {code})")).unwrap_or(&text);
            format!("[Errno {code}] {text}: '{program}'")
        }
        None => err.to_string(),
    }
}

/// What the first part of `_execute_cli` gives: everything the CLI is started with, or why the run ends here.
enum Setup {
    Go(Box<Ready>),
    /// `_end(run_id, "failed", reason, stop_code=...)`.
    Fail(String, Option<&'static str>),
    /// The run is gone or over: nothing to do.
    Nothing,
}

struct Ready {
    run: ai_run::Model,
    profile: kb_db::entities::ai_team::Model,
    prepared: launch::Launch,
    session_id: String,
    resume: bool,
    fresh_note: Option<String>,
}

async fn set_up(run_id: &str, token: &str, note: Option<&str>, restart_why: Option<&str>) -> Result<Setup, Failure> {
    let session = database::session();
    let Some(run) = ai_run::Entity::find_by_id(run_id).one(&session).await? else { return Ok(Setup::Nothing) };
    if ENDED.contains(&run.state.as_str()) {
        return Ok(Setup::Nothing);
    }
    let (member, profile) = get_profile(&session, &run.member_id).await?;
    let (Some(member), Some(profile)) = (member, profile) else {
        return Ok(Setup::Fail("The team no longer exists.".to_string(), None));
    };
    let ticket = match run.ticket_id.as_deref().filter(|t| !t.is_empty()) {
        Some(ticket_id) => ticket::Entity::find_by_id(ticket_id).one(&session).await?,
        None => None,
    };
    let mut cwd = profile.working_dir.clone();
    let mut port: Option<i32> = None;
    if let Some(ticket) = &ticket {
        match worktrees::ensure(&session, ticket, profile.working_dir.as_deref()).await {
            Ok(Some(row)) => {
                cwd = Some(row.path);
                port = row.port;
            }
            Ok(None) => {}
            Err(err) if err.is_worktree_error() => {
                return Ok(Setup::Fail(format!("The worktree could not be made: {err}"), Some("board_fault")));
            }
            Err(err) => return Err(err.into()),
        }
    }
    let Some(cwd) = cwd.filter(|c| !c.is_empty()) else {
        return Ok(Setup::Fail("The team has no working folder.".to_string(), None));
    };
    let account_id = run.account_id.clone().filter(|a| !a.is_empty()).or_else(|| profile.account_id.clone());
    let account = match account_id.filter(|a| !a.is_empty()) {
        Some(id) => ai_account::Entity::find_by_id(id).one(&session).await?,
        None => None,
    };
    let config_dir = account.as_ref().and_then(|a| accounts::claude_config_dir(Some(a)));
    let (session_id, fresh_note) = session_for(&session, &run, config_dir.as_deref()).await?;
    let resume = session_id.is_some();
    // what the AI is told depends on whether its conversation could be continued
    let restart_note =
        restart_why.map(|why| (if resume { RESTART_NOTE } else { RESTART_FRESH_NOTE }).replace("{why}", why));
    let note = restart_note.as_deref().or(note);
    let session_id = session_id.unwrap_or_else(time::uuid4);
    let session_name = run
        .session_name
        .clone()
        .filter(|s| !s.is_empty())
        .or_else(|| run.ticket_id.clone().filter(|t| !t.is_empty()))
        .or_else(|| run.target.clone());
    let mut row = kb_db::edit(run);
    row.session_id = Set(Some(session_id.clone()));
    row.session_name = Set(session_name);
    let run = row.update(&session).await?;
    session.commit().await?;
    let opts = launch::PrepareOpts {
        token,
        board_url: &url(),
        cwd: &cwd,
        session_id: &session_id,
        resume,
        note,
        workspace: None,
    };
    let mut prepared = match launch::prepare(&session, &run, &profile, &member, opts).await {
        Ok(prepared) => prepared,
        Err(launch::Error::Runtime(why)) => return Ok(Setup::Fail(why, Some("runner_missing"))),
        Err(err) => return Err(err.into()),
    };
    if let Some(port) = port.filter(|p| *p != 0) {
        // the ticket's worktree has a port of its own: the app the AI starts there listens on $PORT
        set_env(&mut prepared.env, "PORT", &port.to_string());
    }
    for (key, value) in cli_env() {
        set_env(&mut prepared.env, &key, &value);
    }
    Ok(Setup::Go(Box::new(Ready { run, profile, prepared, session_id, resume, fresh_note })))
}

fn set_env(env: &mut kb_ai::profiles::Env, key: &str, value: &str) {
    match env.iter_mut().find(|(k, _)| k == key) {
        Some(slot) => slot.1 = value.to_string(),
        None => env.push((key.to_string(), value.to_string())),
    }
}

/// What reading the CLI's stream gave.
#[derive(Default)]
struct Read {
    result: Option<Value>,
    lingered: bool,
    timed_out: Option<&'static str>,
    held_tokens: Option<i64>,
    window_tokens: Option<i64>,
}

/// `value or held`: the number when it is a true one.
fn tokens_of(value: Option<&Value>) -> Option<i64> {
    value.filter(|v| pyjson::truthy(v)).and_then(py_int).and_then(|n| i64::try_from(n).ok())
}

async fn read_stream(
    run_id: &str,
    proc: &CliProcess,
    writer: &StepWriter,
    parser: &mut Parser,
    quota_key: &str,
    session_id: &str,
) -> Result<Read, Failure> {
    let mut out = Read::default();
    let mut ready = false;
    let mut life = RunLife::new();
    let mut lines = proc.lines();
    loop {
        let wait_s = life.wait_s(monotonic(), if ready { watch_every_s() } else { starting_timeout_s() });
        let wait = Duration::try_from_secs_f64(wait_s.max(0.0)).unwrap_or(Duration::MAX);
        let line = match tokio::time::timeout(wait, lines.next()).await {
            Err(_) => {
                if RT.is_cancelled(run_id) {
                    proc.kill();
                    break;
                }
                if life.answered_at.is_some() && life.must_stop(monotonic()) {
                    // it answered but stays open (a dev server it started): stop it
                    out.lingered = true;
                    proc.kill();
                    break;
                }
                if ready {
                    continue;
                }
                out.timed_out = Some("Claude Code did not start in time.");
                proc.kill();
                break;
            }
            Ok(Ok(None)) => break,
            Ok(Ok(Some(line))) => line,
            Ok(Err(err)) => return Err(err.into()),
        };
        transcripts::feed(run_id, &line);
        let parsed = parser.parse(&line)?;
        if let Some(reading) = parsed.rate_limit.as_ref().filter(|r| !r.is_empty()) {
            if let Err(err) = quota::record(quota_key, reading).await {
                tracing::debug!(target: "kanban.ai.runs", "quota record failed: {err}");
            }
        }
        out.held_tokens = tokens_of(parsed.context_used.as_ref()).or(out.held_tokens);
        out.window_tokens = tokens_of(parsed.context_window.as_ref()).or(out.window_tokens);
        let mut fields = Map::new();
        if parsed.ready && !ready {
            ready = true;
            fields.insert("state".into(), json!("running"));
            if pyjson::truthy(&parsed.model) {
                fields.insert("model".into(), parsed.model.clone());
            }
        }
        if pyjson::truthy(&parsed.session_id) && parsed.session_id.as_str() != Some(session_id) {
            fields.insert("session_id".into(), parsed.session_id.clone());
        }
        for res in &parsed.results {
            attach_result(writer, run_id, res).await?;
        }
        if !parsed.messages_in.is_empty() || !parsed.messages_out.is_empty() {
            record_messages(run_id, &parsed.messages_in, &parsed.messages_out).await?;
        }
        if life.feed(&parsed, monotonic()) {
            out.result = parsed.result.clone();
            if proc.live {
                proc.end_input();
                fields.insert("live".into(), json!(false));
            }
        }
        if !parsed.rows.is_empty() || !parsed.agents.is_empty() || !parsed.files.is_empty() || !fields.is_empty() {
            if RT.is_cancelled(run_id) {
                proc.kill();
                break;
            }
            writer.add(parsed.rows, parsed.agents, parsed.files, fields);
        }
    }
    Ok(out)
}

/// `_execute_cli`: start the CLI of a run, read it to its end and act on how it ended.
pub(crate) fn execute_cli<'a>(
    run_id: &'a str,
    token: &'a str,
    note: Option<&'a str>,
    restart_why: Option<&'a str>,
    generation: u64,
) -> Pin<Box<dyn Future<Output = Result<(), Failure>> + Send + 'a>> {
    Box::pin(async move {
        let ready = match set_up(run_id, token, note, restart_why).await? {
            Setup::Go(ready) => *ready,
            Setup::Fail(reason, stop_code) => {
                let opts = EndOpts { stop_code: stop_code.map(|c| Some(c.to_string())), ..EndOpts::default() };
                end(run_id, "failed", Some(&reason), opts).await?;
                return Ok(());
            }
            Setup::Nothing => return Ok(()),
        };
        let Ready { run, profile, prepared, session_id, resume, fresh_note } = ready;
        transcripts::begin(
            run_id,
            transcripts::Begin {
                project_id: &run.project_id,
                member_id: &run.member_id,
                system: Some(&prepared.system),
                prompt: Some(&prepared.prompt),
                args: &prepared.record_args,
                resume,
                session_id: Some(&session_id),
                note: fresh_note.as_deref(),
                started_at: None,
            },
        )
        .await?;
        let writer = StepWriter::new(run_id);
        RT.inner().writers.insert(run_id.to_string(), writer.clone());
        let mut title = if resume { "Resumed the conversation" } else { "Started" }.to_string();
        if let Some(fresh) = fresh_note.as_deref().filter(|n| !n.is_empty()) {
            title += &format!(" · {fresh}");
        }
        writer.add(vec![json!({"kind": "start", "title": title})], Vec::new(), Vec::new(), Map::new());
        let first_message = prepared.live.then(|| prepared.prompt.clone());
        let proc = Arc::new(CliProcess::new(
            prepared.args.clone(),
            &prepared.cwd,
            Some(prepared.env.clone()),
            true,
            first_message,
        ));
        let pid = match proc.start().await {
            Ok(pid) => pid,
            Err(err) => {
                writer.close().await;
                let program = prepared.args.first().map(String::as_str).unwrap_or("");
                let reason = format!("Could not start Claude Code: {}", os_error_text(&err, program));
                end(run_id, "failed", Some(&reason), EndOpts::default()).await?;
                return Ok(());
            }
        };
        {
            let mut inner = RT.inner();
            inner.procs.insert(run_id.to_string(), (generation, proc.clone()));
            // one aimed at the CLI that just ended does not apply to this one
            inner.restart_requests.remove(run_id);
        }
        if resume {
            guard::mark_resumed(run_id);
        }
        resources::MON.track(run_id, proc.clone(), &run.project_id);
        // numbers for a screen never stop a run
        if let Err(e) = resources::MON.read_now(run_id).await {
            tracing::debug!(target: "kanban.ai.resources", "Could not read the CLI of {run_id}: {e}");
        }
        // From here the CLI runs. Python leaves it running when anything below raises (the run is ended as failed and
        // nothing holds the process any more); here it is stopped first: no CLI outlives its run.
        let driven =
            drive(run_id, token, generation, &proc, &writer, &run, &profile, &prepared, &session_id, pid).await;
        if driven.is_err() {
            proc.kill();
            let _ = resources::MON.untrack(run_id).await;
        }
        driven
    })
}

async fn drive(
    run_id: &str,
    token: &str,
    generation: u64,
    proc: &Arc<CliProcess>,
    writer: &StepWriter,
    run: &ai_run::Model,
    profile: &kb_db::entities::ai_team::Model,
    prepared: &launch::Launch,
    session_id: &str,
    pid: i32,
) -> Result<(), Failure> {
    {
        let session = database::session();
        if let Some(cur) = ai_run::Entity::find_by_id(run_id).one(&session).await? {
            let mut row = kb_db::edit(cur);
            row.pid = Set(Some(pid));
            row.live = Set(prepared.live);
            row.update(&session).await?;
            session.commit().await?;
        }
    }
    let known: HashMap<String, String> = {
        let session = database::session();
        steps::agents(&session, run_id)
            .await?
            .iter()
            .filter_map(|a| {
                let id = a.get("id").and_then(Value::as_str)?;
                Some((id.to_string(), a.get("agent_type").and_then(Value::as_str).unwrap_or("").to_string()))
            })
            .collect()
    };
    let mut parser = Parser::new(&prepared.cwd, Some(known));
    let quota_key = quota::key_for(Some(profile), Some(run));
    let read = read_stream(run_id, proc, writer, &mut parser, &quota_key, session_id).await?;
    let Read { result, lingered, timed_out, held_tokens, window_tokens } = read;
    if timed_out.is_some() {
        proc.kill();
    }
    let mut code = proc.wait().await?;
    if lingered {
        code = 0;
    }
    writer.close().await;
    super::close_roles(run_id).await?;
    RT.inner().writers.remove(run_id);
    resources::MON.untrack(run_id).await?;
    if RT.is_cancelled(run_id) {
        return Ok(());
    }
    let request = RT.inner().restart_requests.remove(run_id);
    let answered = result.as_ref().is_some_and(pyjson::truthy);
    if let (Some(request), false) = (request, answered) {
        // the CLI was stopped on purpose (over the memory limit, or a person pressed Restart): the run goes on in a
        // new CLI that resumes the conversation, or ends when the system already restarted it too often. (A CLI that
        // already gave its answer and only lingers is not restarted: the normal ending below takes it.)
        if let Some(held) = held_tokens {
            let session = database::session();
            if let Some(cur) = ai_run::Entity::find_by_id(run_id).one(&session).await? {
                let window = window_tokens.and_then(|w| i32::try_from(w).ok()).or(cur.context_window);
                let mut row = kb_db::edit(cur);
                row.context_used = Set(i32::try_from(held).ok());
                row.context_window = Set(window);
                row.update(&session).await?;
                session.commit().await?;
            }
        }
        restart_inside_run(run_id, token, &request, generation).await?;
        return Ok(());
    }
    let result = result.filter(pyjson::truthy);
    let question = {
        let session = database::session();
        let Some(run) = ai_run::Entity::find_by_id(run_id).one(&session).await? else { return Ok(()) };
        if ENDED.contains(&run.state.as_str()) {
            return Ok(());
        }
        let question = run.question.clone();
        let (tokens_in, tokens_out, tokens_cached, cost_usd, context_window) =
            (run.tokens_in, run.tokens_out, run.tokens_cached, run.cost_usd, run.context_window);
        let mut row = kb_db::edit(run);
        if let Some(held) = held_tokens {
            row.context_used = Set(i32::try_from(held).ok());
            row.context_window = Set(window_tokens.and_then(|w| i32::try_from(w).ok()).or(context_window));
        }
        if let Some(result) = &result {
            let number = |key: &str| result.get(key).and_then(py_int).and_then(|n| i32::try_from(n).ok()).unwrap_or(0);
            row.tokens_in = Set(tokens_in + number("tokens_in"));
            row.tokens_out = Set(tokens_out + number("tokens_out"));
            if result.get("tokens_cached").is_some_and(|v| !v.is_null()) {
                row.tokens_cached = Set(Some(tokens_cached.unwrap_or(0) + number("tokens_cached")));
            }
            row.cost_usd = Set((cost_usd + result.get("cost_usd").and_then(Value::as_f64).unwrap_or(0.0)).into());
            if let Some(structured) = result.get("structured").filter(|s| pyjson::truthy(s)) {
                row.report = Set(pyjson::dumps(structured));
            }
        }
        row.exit_code = Set(Some(code));
        row.update(&session).await?;
        session.commit().await?;
        match question.as_deref().filter(|q| !q.is_empty()) {
            Some(text) => loads(Some(text), Value::Null),
            None => Value::Null,
        }
    };
    if let Some(timed_out) = timed_out {
        end(run_id, "failed", Some(timed_out), EndOpts::default()).await?;
        return Ok(());
    }
    if pyjson::truthy(&question) && !question.get("answered_at").is_some_and(pyjson::truthy) {
        needs_input(run_id).await?;
        return Ok(());
    }
    if let Some(result) = &result {
        if !result.get("is_error").is_some_and(pyjson::truthy) {
            finish(run_id, result).await?;
            return Ok(());
        }
        let said = ["text", "api_error"].iter().find_map(|key| result.get(*key).filter(|v| pyjson::truthy(v))).map(
            |v| match v {
                Value::String(s) => s.clone(),
                other => pyjson::py_str(other),
            },
        );
        let reason = said.unwrap_or_else(|| "Claude Code reported an error.".to_string());
        let limit = result.get("api_error").and_then(Value::as_str) == Some("usage_limit_reached")
            || result.get("api_status").and_then(Value::as_f64) == Some(429.0);
        if limit {
            let reason = format!("The account's usage limit is reached: {}", clip(&redact(&reason), 300));
            let opts = EndOpts { stop_code: Some(Some("rate_limited".to_string())), ..EndOpts::default() };
            end(run_id, "failed", Some(&reason), opts).await?;
        } else {
            end(run_id, "failed", Some(&clip(&redact(&reason), 600)), EndOpts::default()).await?;
        }
        return Ok(());
    }
    let tail = proc.stderr_tail();
    let tail = tail[tail.len().saturating_sub(3)..].join(" · ");
    let mut reason = format!("Claude Code exited with code {code}");
    if !tail.is_empty() {
        reason += &format!(": {tail}");
    }
    end(run_id, "failed", Some(&reason), EndOpts::default()).await?;
    Ok(())
}

async fn attach_result(writer: &StepWriter, run_id: &str, res: &Value) -> Result<(), DbErr> {
    let mut detail = Map::new();
    detail.insert("exit_code".into(), res.get("exit_code").cloned().unwrap_or(Value::Null));
    detail.insert("is_error".into(), res.get("is_error").cloned().unwrap_or(Value::Null));
    if let Some(tests) = res.get("tests").filter(|t| pyjson::truthy(t)) {
        detail.insert("tests".into(), tests.clone());
    }
    let tool_id = res.get("tool_id").cloned().unwrap_or(Value::Null);
    let output = res.get("output").cloned().unwrap_or(Value::Null);
    if writer.attach_pending(&tool_id, &output, &detail) {
        return Ok(());
    }
    // (a result that names no tool call matches no step)
    if let Some(tool_id) = tool_id.as_str() {
        steps::attach_result(run_id, tool_id, output.as_str(), &detail).await?;
    }
    Ok(())
}

async fn record_messages(run_id: &str, incoming: &[Value], outgoing: &[Value]) -> Result<(), DbErr> {
    let text_of = |m: &Value, key: &str| m.get(key).and_then(Value::as_str).unwrap_or("").to_string();
    {
        let session = database::session();
        for (direction, list) in [("in", incoming), ("out", outgoing)] {
            for m in list {
                let mut row = ai_run_message::new();
                row.run_id = Set(run_id.to_string());
                row.direction = Set(direction.to_string());
                row.peer = Set(clip(&text_of(m, "peer"), 200));
                row.text = Set(clip(&text_of(m, "text"), 8000));
                row.delivered_at = Set(Some(now_iso()));
                row.insert(&session).await?;
            }
        }
        session.commit().await?;
    }
    for m in incoming.iter().chain(outgoing) {
        let mut payload = Map::new();
        payload.insert("run_id".into(), json!(run_id));
        payload.insert("peer".into(), m.get("peer").cloned().unwrap_or(Value::Null));
        payload.insert("text".into(), json!(clip(&text_of(m, "text"), 500)));
        events::publish_typed("ai.message", &payload).await;
    }
    Ok(())
}
