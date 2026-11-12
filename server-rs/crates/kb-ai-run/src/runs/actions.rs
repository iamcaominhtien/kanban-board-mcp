//! Actions (`services/ai/runs.py` lines 1387-1826): `cancel`, `cancel_for_ticket`, the restart notes,
//! `_memory_breach`, `restart_run`, `_tell_memory`, `_restart_inside_run`, `answer`, `retry`, `send_message`,
//! `pending_messages`.

use std::time::Duration;

use kb_ai::store::{active_runs, loads, now_iso};
use kb_ai::{audit, guard, runner_link, steps, transcripts};
use kb_board::tickets as svc_tickets;
use kb_db::database;
use kb_db::entities::{ai_run, ai_run_message, ticket};
use kb_db::sea_orm::{ActiveModelTrait, ActiveValue::Set, ColumnTrait, EntityTrait, IntoActiveModel, QueryFilter};
use serde_json::{Map, Value, json};

use super::describe::publish_run;
use super::execute::{Failure, execute_cli, in_task_of};
use super::{ENDED, EndOpts, NewRun, RT, RunError, clip, create_run, defers_to_runner, end, refuse, spawn_execute};
use crate::resources;

/// Stop a run from any active state; files stay as they are.
pub async fn cancel(
    run_id: &str,
    by: &str,
    reason: Option<&str>,
    stop_code: Option<&str>,
    quiet: bool,
) -> Result<Option<ai_run::Model>, RunError> {
    let (was, ticket_id) = {
        let session = database::session();
        let Some(run) = ai_run::Entity::find_by_id(run_id).one(&session).await? else {
            return refuse("Run not found.");
        };
        if ENDED.contains(&run.state.as_str()) {
            return refuse(format!("Run #{} already ended ({}).", run.number, run.state));
        }
        (run.state, run.ticket_id)
    };
    if defers_to_runner() && was != "queued" {
        let mut payload = Map::new();
        payload.insert("by".into(), json!(by));
        payload.insert("reason".into(), json!(reason));
        payload.insert("stop_code".into(), json!(stop_code));
        runner_link::command(run_id, "cancel", Some(&payload), true).await?;
        let session = database::session();
        return Ok(ai_run::Entity::find_by_id(run_id).one(&session).await?);
    }
    RT.inner().cancelled.insert(run_id.to_string());
    if let Some(proc) = RT.proc(run_id) {
        proc.kill();
    }
    let task = RT.inner().tasks.get(run_id).map(|t| t.done.clone());
    let default_reason = format!("Cancelled by {by}");
    let opts = EndOpts {
        by: Some(by.to_string()),
        quiet,
        stop_code: Some(stop_code.map(str::to_string)),
        reply_comment_id: None,
    };
    let ended =
        end(run_id, "cancelled", Some(reason.filter(|r| !r.is_empty()).unwrap_or(&default_reason)), opts).await?;
    if let Some(mut done) = task {
        let over = *done.borrow();
        if !over && !in_task_of(run_id) {
            let _ = tokio::time::timeout(Duration::from_secs(10), done.wait_for(|over| *over)).await;
        }
    }
    if let (true, Some(ticket_id)) = (was == "needs_input", ticket_id.filter(|t| !t.is_empty())) {
        let session = database::session();
        let t = ticket::Entity::find_by_id(ticket_id).one(&session).await?;
        // `(t.pending_note or "").find(" asks: ") > 0`
        if let Some(t) = t.filter(|t| t.pending && t.pending_note.as_deref().unwrap_or("").find(" asks: ") > Some(0)) {
            svc_tickets::reopen::clear_pending(&session, &t.id, Some("AI run cancelled"), false, None).await?;
        }
    }
    RT.inner().cancelled.remove(run_id);
    Ok(ended)
}

/// Stop every active run on a ticket; returns how many.
pub async fn cancel_for_ticket(
    ticket_id: &str,
    by: &str,
    reason: &str,
    stop_code: Option<&str>,
) -> Result<usize, RunError> {
    let mut n = 0;
    let rows = {
        let session = database::session();
        active_runs(&session, None, Some(ticket_id)).await?
    };
    for r in rows {
        match cancel(&r.id, by, Some(reason), stop_code, false).await {
            Ok(_) => n += 1,
            Err(err) if err.is_run_error() => {}
            Err(err) => return Err(err),
        }
    }
    Ok(n)
}

/// What a restarted CLI is told when its conversation goes on (`{why}` is why it was restarted).
pub const RESTART_NOTE: &str = "Your process was restarted ({why}). The conversation and every file are as you left them. Look at \
     `git status` and the last steps, then carry on with the task from where you stopped; do not start over.";
/// the CLI's conversation was not found on this computer: the files are there, the memory of the talk is not
pub const RESTART_FRESH_NOTE: &str = "Your process was restarted ({why}) and its earlier conversation could not be continued, so you start a new \
     one. Every file is as it was left. Read the ticket and its comments, look at `git status` and `git log`, then \
     carry on with the task from where the work stopped; do not start over.";

/// The monitor saw a run's CLI pass the memory limit: stop it; the run goes on in a new CLI (or ends).
pub async fn memory_breach(run_id: &str, rss_mb: f64, limit_mb: i64) {
    let Some(proc) = RT.proc(run_id).filter(|p| p.running()) else { return };
    {
        let mut inner = RT.inner();
        if inner.restart_requests.contains_key(run_id) {
            return;
        }
        let mut request = Map::new();
        request.insert("by".into(), json!("system"));
        request.insert("rss_mb".into(), json!(rss_mb));
        request.insert("limit_mb".into(), json!(limit_mb));
        inner.restart_requests.insert(run_id.to_string(), request);
    }
    proc.kill();
}

/// Start a running run's CLI again inside the same run (it resumes its conversation); memory is released.
///
/// Errors: `RunError::Run`: the run is not running a CLI.
pub async fn restart_run(run_id: &str, by: &str) -> Result<ai_run::Model, RunError> {
    let run = {
        let session = database::session();
        ai_run::Entity::find_by_id(run_id).one(&session).await?
    };
    let Some(run) = run else { return refuse("Run not found.") };
    if run.state != "running" {
        return refuse("Only a running run can be restarted.");
    }
    if defers_to_runner() {
        let mut payload = Map::new();
        payload.insert("by".into(), json!(by));
        let row = runner_link::command(run_id, "restart", Some(&payload), true).await?;
        if !row.taken_at.as_deref().is_some_and(|t| !t.is_empty()) {
            return refuse("The runner did not answer. Try again in a moment.");
        }
        return Ok(run);
    }
    let Some(proc) = RT.proc(run_id).filter(|p| p.running()) else {
        return refuse("This run has no Claude Code process to restart right now.");
    };
    if RT.inner().restart_requests.contains_key(run_id) {
        return refuse("This run is already being restarted.");
    }
    let reading = resources::MON.reading(run_id);
    let limit = resources::MON.limit_mb(&run.project_id).await?;
    let mut request = Map::new();
    request.insert("by".into(), json!(by));
    request.insert("rss_mb".into(), json!(reading.and_then(|r| r.cli_rss_mb)));
    request.insert("limit_mb".into(), json!(limit));
    RT.inner().restart_requests.insert(run_id.to_string(), request);
    proc.kill();
    Ok(run)
}

/// The board's notice of a stop for memory (Needs you, one row per ticket). A restart has none.
async fn tell_memory(kind: &str, run: &ai_run::Model, title: String, body: String, data: Map<String, Value>) {
    let told: Result<(), kb_notify::NotifyError> = async {
        let session = database::session();
        let recipients = kb_notify::owners_and_admins(&session, Some(&run.project_id)).await?;
        let fields = kb_notify::EmitFields {
            project_id: Some(run.project_id.clone()),
            recipients,
            title,
            body: Some(body),
            target_kind: Some("run".to_string()),
            target_id: Some(run.id.clone()),
            ticket_id: run.ticket_id.clone(),
            member_id: Some(run.member_id.clone()),
            data: Some(data),
            ..kb_notify::EmitFields::default()
        };
        kb_notify::emit(kind, Some(&session), fields).await?;
        Ok(())
    }
    .await;
    // the notice never stops the run
    if let Err(err) = told {
        tracing::error!(target: "kanban.ai.runs", "Could not tell anyone that run {} used too much memory: {err}", run.id);
    }
}

/// The CLI was stopped on purpose: log it and start a new CLI in the same run. After `AUTO_RESTARTS` restarts by the
/// system, the next breach ends the run instead (stop code `memory`).
pub(crate) async fn restart_inside_run(
    run_id: &str,
    token: &str,
    request: &Map<String, Value>,
    generation: u64,
) -> Result<(), Failure> {
    let by = request.get("by").and_then(Value::as_str).unwrap_or("").to_string();
    let rss = request.get("rss_mb").and_then(Value::as_f64);
    let limit = request.get("limit_mb").and_then(Value::as_f64);
    let (rss_value, limit_value) = (
        request.get("rss_mb").cloned().unwrap_or(Value::Null),
        request.get("limit_mb").cloned().unwrap_or(Value::Null),
    );
    let (run, log, by_system, entry) = {
        let session = database::session();
        let Some(run) = ai_run::Entity::find_by_id(run_id).one(&session).await? else { return Ok(()) };
        if ENDED.contains(&run.state.as_str()) {
            return Ok(());
        }
        let log = resources::restarts_of(&run);
        let by_system = log.iter().filter(|r| r.get("by").and_then(Value::as_str) == Some("system")).count() as i64;
        if by == "system" && by_system >= resources::AUTO_RESTARTS {
            (run, log, by_system, None)
        } else {
            let entry = json!({
                "at": now_iso(),
                "rss_mb": rss_value,
                "limit_mb": limit_value,
                "by": by,
                "n": log.len() + 1,
            });
            let mut all = log.clone();
            all.push(entry.clone());
            let mut row = kb_db::edit(run);
            row.restarts = Set(resources::dump(&Value::Array(all)));
            let run = row.update(&session).await?;
            session.commit().await?;
            (run, log, by_system, Some(entry))
        }
    };
    if RT.is_cancelled(run_id) {
        // stopped while the restart was being written: say nothing more about a run that ended
        return Ok(());
    }
    let ticket = run.ticket_id.clone().filter(|t| !t.is_empty()).unwrap_or_else(|| "A run".to_string());
    // `if rss` / `if limit`: zero counts as unknown
    let gb =
        rss.filter(|r| *r != 0.0).map_or_else(|| "too much memory".to_string(), |r| format!("{:.2} GB", r / 1024.0));
    let lim = limit.filter(|l| *l != 0.0).map_or_else(|| "the limit".to_string(), |l| format!("{:.1} GB", l / 1024.0));
    let auto = resources::AUTO_RESTARTS;
    let Some(entry) = entry else {
        let mut detail = Map::new();
        detail.insert("rss_mb".into(), rss_value.clone());
        detail.insert("limit_mb".into(), limit_value.clone());
        detail.insert("restarts".into(), json!(log.len()));
        audit::record(
            &run.project_id,
            "run_stopped_memory",
            "info",
            audit::Entry {
                member_name: "System".to_string(),
                member_id: Some(run.member_id.clone()),
                run_id: Some(run_id.to_string()),
                target: run.ticket_id.clone(),
                detail,
                ..audit::Entry::default()
            },
        )
        .await?;
        let mut data = Map::new();
        data.insert("rss_mb".into(), rss_value);
        data.insert("limit_mb".into(), limit_value);
        data.insert("ticket_id".into(), json!(run.ticket_id));
        tell_memory(
            "run_stopped_memory",
            &run,
            format!("{ticket}: stopped, out of memory"),
            format!(
                "The CLI went over {lim} again after {auto} restarts. Partial work is kept; retry it or raise the limit."
            ),
            data,
        )
        .await;
        let reason = format!(
            "Stopped automatically: the CLI went over the memory limit ({gb} of {lim}) again after {auto} restarts. \
             Partial work in the folder is kept."
        );
        let opts = EndOpts { stop_code: Some(Some("memory".to_string())), ..EndOpts::default() };
        end(run_id, "failed", Some(&reason), opts).await?;
        return Ok(());
    };
    audit::record(
        &run.project_id,
        "run_restarted",
        "info",
        audit::Entry {
            member_name: if by == "system" { "System".to_string() } else { by.clone() },
            member_id: Some(run.member_id.clone()),
            run_id: Some(run_id.to_string()),
            target: run.ticket_id.clone(),
            detail: entry.as_object().cloned().unwrap_or_default(),
            ..audit::Entry::default()
        },
    )
    .await?;
    let (text, why) = if by == "system" {
        // no notification for a restart (Notifications board, owner decision on PR #331): it is written on the run
        (
            format!(
                "Restarted automatically: the CLI reached {gb}, over the {lim} limit (restart {} of {auto})",
                by_system + 1
            ),
            format!("it used {gb} of memory, over the {lim} limit"),
        )
    } else {
        (format!("Restarted by {by}"), format!("{by} restarted it"))
    };
    super::append_steps(run_id, vec![json!({"kind": "start", "title": text})], steps::Extras::default()).await?;
    transcripts::note(run_id, "restart", &text, None);
    publish_run(run_id).await?;
    execute_cli(run_id, token, None, Some(&why), generation).await
}

/// Answer the lead's question: the answer is a comment on the ticket and the run resumes its conversation.
pub async fn answer(run_id: &str, by: &str, text: &str) -> Result<Option<ai_run::Model>, RunError> {
    let text = kb_base::pytext::strip(text);
    if text.is_empty() {
        return refuse("Write an answer first.");
    }
    if defers_to_runner() {
        {
            let session = database::session();
            let Some(run) = ai_run::Entity::find_by_id(run_id).one(&session).await? else {
                return refuse("Run not found.");
            };
            if run.state != "needs_input" {
                return refuse("This run is not waiting for an answer.");
            }
        }
        let mut payload = Map::new();
        payload.insert("by".into(), json!(by));
        payload.insert("text".into(), json!(text));
        runner_link::command(run_id, "answer", Some(&payload), true).await?;
        let session = database::session();
        return Ok(ai_run::Entity::find_by_id(run_id).one(&session).await?);
    }
    let (run, token, asked) = {
        let session = database::session();
        let Some(run) = ai_run::Entity::find_by_id(run_id).one(&session).await? else {
            return refuse("Run not found.");
        };
        if run.state != "needs_input" {
            return refuse("This run is not waiting for an answer.");
        }
        let mut q = match loads(run.question.as_deref(), json!({})) {
            Value::Object(map) => map,
            _ => Map::new(),
        };
        if let Some(ticket_id) = run.ticket_id.as_deref().filter(|t| !t.is_empty()) {
            let mut meta = Map::new();
            meta.insert("answer_to_run".into(), json!(run.id));
            svc_tickets::add_comment(&session, ticket_id, &format!("**Answer:** {text}"), by, Some(&meta)).await?;
            let ticket = ticket::Entity::find_by_id(ticket_id).one(&session).await?;
            if let Some(ticket) = ticket.filter(|t| t.pending) {
                svc_tickets::reopen::clear_pending(
                    &session,
                    &ticket.id,
                    Some("Answered the AI's question"),
                    false,
                    None,
                )
                .await?;
            }
        }
        let Some(run) = ai_run::Entity::find_by_id(run_id).one(&session).await? else {
            return refuse("Run not found.");
        };
        q.insert("answered_at".into(), json!(now_iso()));
        q.insert("answered_by".into(), json!(by));
        let asked = match q.get("text") {
            Some(Value::String(s)) => s.clone(),
            Some(other) => kb_base::pyjson::py_str(other),
            None => String::new(),
        };
        let token = guard::new_token();
        let mut row = kb_db::edit(run);
        row.question = Set(Some(kb_base::pyjson::dumps(&Value::Object(q))));
        row.answer = Set(Some(text.to_string()));
        row.state = Set("starting".to_string());
        row.token_hash = Set(Some(guard::token_hash(&token)));
        let run = row.update(&session).await?;
        session.commit().await?;
        (run, token, asked)
    };
    let note = format!(
        "{by} answered your question “{asked}”:\n{text}\n\nContinue the work with this answer and finish as instructed."
    );
    spawn_execute(run_id, token, Some(note));
    publish_run(run_id).await?;
    Ok(Some(run))
}

/// A new run on the same ticket and team, continuing the conversation.
pub async fn retry(run_id: &str, by: &str) -> Result<ai_run::Model, RunError> {
    let session = database::session();
    let Some(run) = ai_run::Entity::find_by_id(run_id).one(&session).await? else {
        return refuse("Run not found.");
    };
    if !ENDED.contains(&run.state.as_str()) {
        return refuse("The run is still going.");
    }
    let instruction = if run.instruction.is_empty() {
        "Continue the work: the earlier run ended before it was done."
    } else {
        run.instruction.as_str()
    };
    create_run(
        &session,
        NewRun {
            ticket_id: run.ticket_id.as_deref(),
            member_id: &run.member_id,
            mode: &run.mode,
            trigger: "retry",
            started_by: by,
            instruction,
            resume_session: run.session_id.as_deref(),
            kind: &run.kind,
            target: run.target.as_deref(),
            depth: 0,
        },
    )
    .await
}

/// What a note to a team that waits for an answer is refused with (`{number}` is the run's number).
pub const NEEDS_INPUT_BLOCK: &str = "The team is asking a person a question (run #{number} is waiting for an answer): answer it first, in the \
     ticket or from Needs you. A note sent now would be taken as that answer.";

fn delivered(how: &str, run_id: Option<&str>) -> Map<String, Value> {
    let mut out = Map::new();
    out.insert("delivered".into(), json!(how));
    out.insert("run_id".into(), json!(run_id));
    out
}

/// A note to a run: into the running lead's input when it is live; else kept for its next turn (a run that ended
/// gets a new run on the same conversation).
///
/// A run in `needs_input` takes the text as the answer to its question. That is right for the person answering it
/// (`answers` true: the ticket chat and the run's own message box); a note from anything else (another AI, a Docs
/// page, CI) must not be mistaken for it, so with `answers` false the send is refused.
///
/// Errors: `RunError::Run`: empty text, an unknown run, or `answers` false to a run that waits for an answer.
pub async fn send_message(
    run_id: &str,
    text: &str,
    by: &str,
    peer: Option<&str>,
    answers: bool,
) -> Result<Map<String, Value>, RunError> {
    let text = kb_base::pytext::strip(text);
    if text.is_empty() {
        return refuse("Write a message first.");
    }
    if !answers {
        let session = database::session();
        let waiting = ai_run::Entity::find_by_id(run_id).one(&session).await?;
        if let Some(waiting) = waiting.filter(|w| w.state == "needs_input") {
            return refuse(NEEDS_INPUT_BLOCK.replace("{number}", &waiting.number.to_string()));
        }
    }
    let peer = peer.filter(|p| !p.is_empty());
    if defers_to_runner() {
        let state = {
            let session = database::session();
            let Some(run) = ai_run::Entity::find_by_id(run_id).one(&session).await? else {
                return refuse("Run not found.");
            };
            run.state
        };
        if matches!(state.as_str(), "starting" | "running" | "needs_input") {
            let mut payload = Map::new();
            payload.insert("by".into(), json!(by));
            payload.insert("text".into(), json!(text));
            payload.insert("peer".into(), json!(peer));
            runner_link::command(run_id, "message", Some(&payload), true).await?;
            return Ok(delivered("runner", Some(run_id)));
        }
    }
    let from = peer.unwrap_or(by);
    let (row_id, state, ticket_id, member_id, session_id) = {
        let session = database::session();
        let Some(run) = ai_run::Entity::find_by_id(run_id).one(&session).await? else {
            return refuse("Run not found.");
        };
        let mut row = ai_run_message::new();
        row.run_id = Set(run_id.to_string());
        row.direction = Set("in".to_string());
        row.peer = Set(clip(from, 200));
        row.text = Set(clip(text, 8000));
        let row = row.insert(&session).await?;
        session.commit().await?;
        (row.id, run.state, run.ticket_id, run.member_id, run.session_id)
    };
    if let Some(proc) = RT.proc(run_id) {
        if proc.live
            && proc.input_open()
            && matches!(state.as_str(), "starting" | "running")
            && proc.send(&format!("{from} says:\n{text}")).await
        {
            {
                let session = database::session();
                if let Some(row) = ai_run_message::Entity::find_by_id(row_id).one(&session).await? {
                    let mut row = kb_db::edit(row);
                    row.delivered_at = Set(Some(now_iso()));
                    row.update(&session).await?;
                    session.commit().await?;
                }
            }
            let step = json!({
                "kind": "message",
                "title": format!("From {from}: {}", clip(text, 140)),
                "detail": {"direction": "in", "peer": from},
            });
            super::append_steps(run_id, vec![step], steps::Extras::default()).await?;
            return Ok(delivered("live", Some(run_id)));
        }
    }
    if ENDED.contains(&state.as_str()) {
        let session = database::session();
        let new = create_run(
            &session,
            NewRun {
                ticket_id: ticket_id.as_deref(),
                member_id: &member_id,
                trigger: "message",
                started_by: by,
                instruction: &format!("{from} says:\n{text}"),
                resume_session: session_id.as_deref(),
                ..NewRun::default()
            },
        )
        .await?;
        return Ok(delivered("new_run", Some(&new.id)));
    }
    if state == "needs_input" {
        answer(run_id, by, text).await?;
        return Ok(delivered("answer", Some(run_id)));
    }
    Ok(delivered("queued", Some(run_id)))
}

/// The messages a run has not been given yet.
pub async fn pending_messages(run_id: &str) -> Result<Vec<ai_run_message::Model>, RunError> {
    let session = database::session();
    Ok(ai_run_message::Entity::find()
        .filter(ai_run_message::Column::RunId.eq(run_id))
        .filter(ai_run_message::Column::Direction.eq("in"))
        .filter(ai_run_message::Column::DeliveredAt.is_null())
        .all(&session)
        .await?)
}
