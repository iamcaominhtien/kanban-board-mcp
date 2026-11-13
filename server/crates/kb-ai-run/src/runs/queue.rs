//! Queueing and the scheduler (`services/ai/runs.py` lines 237-562): `create_run`, `_blocking_reason`, `tick`, `_loop`,
//! `start_scheduler`, `stop_scheduler`, `recover_on_startup`, `_start`.

use std::time::{Duration, Instant};

use chrono::Utc;
use kb_ai::providers::merged_config;
use kb_ai::store::{active_runs, get_profile, get_settings, loads, now_iso, parse_iso};
use kb_ai::{audit, budget, guard, quota, runner_link};
use kb_base::ctx;
use kb_db::Session;
use kb_db::database;
use kb_db::entities::{ai_account, ai_project_settings, ai_run, ai_team, member, ticket};
use kb_db::sea_orm::{
    ActiveModelTrait, ActiveValue::Set, ColumnTrait, DbErr, EntityTrait, QueryFilter, QueryOrder, QuerySelect,
};
use serde_json::{Map, Value, json};

use super::describe::publish_dict;
use super::{BOARD_CLOSED, RT, RunError, cancel, defers_to_runner, join_notes, refuse, spawn_execute};
use crate::{cli, seams, teams};

/// The keyword arguments of `create_run`.
#[derive(Debug, Clone, Copy)]
pub struct NewRun<'a> {
    /// The ticket the run is on (None: a run on a target).
    pub ticket_id: Option<&'a str>,
    /// The team.
    pub member_id: &'a str,
    /// work | ask
    pub mode: &'a str,
    /// What started the run.
    pub trigger: &'a str,
    /// Who started it.
    pub started_by: &'a str,
    /// What the lead is asked.
    pub instruction: &'a str,
    /// The CLI session to continue.
    pub resume_session: Option<&'a str>,
    /// team | assistant | schedule
    pub kind: &'a str,
    /// An assistant's target.
    pub target: Option<&'a str>,
    /// How many AI-to-AI hand-offs lie behind the run.
    pub depth: i32,
}

impl Default for NewRun<'_> {
    fn default() -> Self {
        NewRun {
            ticket_id: None,
            member_id: "",
            mode: "work",
            trigger: "assign",
            started_by: "user",
            instruction: "",
            resume_session: None,
            kind: "team",
            target: None,
            depth: 0,
        }
    }
}

/// Queue a run of a team on a ticket; the scheduler starts it when it can.
///
/// Errors: `RunError::Conflict`: the ticket already has a run going (send it a message instead); `RunError::Run`:
/// the team cannot run.
pub async fn create_run(session: &Session, new: NewRun<'_>) -> Result<ai_run::Model, RunError> {
    let ticket_id = new.ticket_id.filter(|t| !t.is_empty());
    let member_id = new.member_id;
    let ticket = match ticket_id {
        Some(id) => ticket::Entity::find_by_id(id).one(session).await?,
        None => None,
    };
    if let (Some(id), None) = (ticket_id, &ticket) {
        return refuse(format!("Ticket {id} not found."));
    }
    let (member, profile) = get_profile(session, member_id).await?;
    let mut resume_session = new.resume_session.filter(|s| !s.is_empty()).map(str::to_string);
    if let (Some(wanted), Some(ticket_id)) = (&resume_session, ticket_id) {
        // a conversation a person started over is closed: the new run starts a new one
        if seams::closed_session_ids(session, ticket_id).await?.contains(wanted) {
            resume_session = None;
        }
    }
    let project_id = match (&ticket, &profile) {
        (Some(ticket), _) => Some(ticket.project_id.clone()),
        (None, Some(profile)) => Some(profile.project_id.clone()),
        (None, None) => None,
    };
    let (member, profile) = match (member, profile) {
        (Some(member), Some(profile))
            if member.kind == "ai" && ticket.as_ref().is_none_or(|t| member.project_id == t.project_id) =>
        {
            (member, profile)
        }
        _ => return refuse("Only an AI team of this project can run on this ticket."),
    };
    if !matches!(new.mode, "work" | "ask") {
        return refuse("mode must be work or ask");
    }
    if let Some(ticket_id) = ticket_id {
        for r in active_runs(session, None, Some(ticket_id)).await? {
            if r.state == "queued" && r.member_id == member_id {
                // one queue entry per team and ticket: the new request joins it
                let instruction = join_notes(&r.instruction, new.instruction);
                let mut row = kb_db::edit(r);
                row.instruction = Set(instruction);
                let r = row.update(session).await?;
                session.commit().await?;
                RT.wake.set();
                return Ok(r);
            }
            if matches!(r.state.as_str(), "starting" | "running" | "needs_input") {
                let who = if r.member_id != member_id {
                    member::Entity::find_by_id(r.member_id.as_str()).one(session).await?
                } else {
                    Some(member.clone())
                };
                return Err(RunError::Conflict(format!(
                    "{ticket_id} already has a run going ({}, run #{}, {}). Send it a message instead of starting another run.",
                    who.map_or_else(|| "a team".to_string(), |w| w.name),
                    r.number,
                    r.state
                )));
            }
        }
    }
    let last = match ticket_id {
        Some(ticket_id) => {
            ai_run::Entity::find()
                .filter(ai_run::Column::TicketId.eq(ticket_id))
                .order_by_desc(ai_run::Column::Number)
                .limit(1)
                .one(session)
                .await?
        }
        None => None,
    };
    let config = match loads(Some(&profile.config), json!({})) {
        Value::Object(map) => map,
        _ => Map::new(),
    };
    let effort = profile.effort.clone().filter(|e| !e.is_empty()).or_else(|| {
        merged_config(Some(&config)).get("effort").filter(|v| !v.is_null()).map(|v| match v {
            Value::String(s) => s.clone(),
            other => kb_base::pyjson::py_str(other),
        })
    });
    let mut run = ai_run::new();
    // (`project_id` is None only for a run with neither a ticket nor a team, which was refused above)
    run.project_id = Set(project_id.unwrap_or_default());
    run.kind = Set(new.kind.to_string());
    run.ticket_id = Set(new.ticket_id.map(str::to_string));
    run.target = Set(new.target.map(str::to_string));
    run.member_id = Set(member_id.to_string());
    run.number = Set(last.map_or(1, |l| l.number + 1));
    run.mode = Set(new.mode.to_string());
    run.trigger = Set(new.trigger.to_string());
    run.depth = Set(new.depth);
    run.started_by = Set(new.started_by.to_string());
    run.instruction = Set(new.instruction.to_string());
    run.session_id = Set(resume_session);
    run.session_name = Set(ticket_id.or(new.target.filter(|t| !t.is_empty())).map(str::to_string));
    run.model = Set(profile.model.clone());
    run.effort = Set(effort);
    run.account_id = Set(profile.account_id.clone());
    let run = run.insert(session).await?;
    session.commit().await?;
    let mut detail = Map::new();
    detail.insert("trigger".into(), json!(new.trigger));
    detail.insert("mode".into(), json!(new.mode));
    audit::record(
        &run.project_id,
        "run_queued",
        "info",
        audit::Entry {
            member_id: Some(member_id.to_string()),
            member_name: member.name.clone(),
            on_behalf_of: Some(new.started_by.to_string()),
            run_id: Some(run.id.clone()),
            target: new.ticket_id.map(str::to_string),
            detail,
        },
    )
    .await?;
    RT.wake.set();
    publish_dict(&run).await;
    Ok(run)
}

/// Why a queued run cannot start yet, or None.
async fn blocking_reason(
    session: &Session,
    run: &ai_run::Model,
    profile: &ai_team::Model,
    member: &member::Model,
    settings: &ai_project_settings::Model,
) -> Result<Option<String>, DbErr> {
    if settings.paused_all {
        return Ok(Some("AI is paused for this project".to_string()));
    }
    if profile.paused {
        return Ok(Some(format!("{} is paused", member.name)));
    }
    let account_id = run.account_id.as_deref().filter(|a| !a.is_empty()).or(profile.account_id.as_deref());
    if let Some(account_id) = account_id.filter(|a| !a.is_empty()) {
        let account = ai_account::Entity::find_by_id(account_id).one(session).await?;
        if let Some(account) = account.filter(|a| a.status == "needs_sign_in") {
            return Ok(Some(format!("Account {} needs sign-in", account.name)));
        }
    }
    match profile.health.as_str() {
        "not_logged_in" => return Ok(Some("Claude Code is not signed in".to_string())),
        "runner_missing" => return Ok(Some("Runner not detected".to_string())),
        _ => {}
    }
    if let Some(own_retry) = parse_iso(run.retry_at.as_deref()) {
        let now = Utc::now();
        if own_retry > now {
            let left = own_retry.with_timezone(&Utc) - now;
            let secs = (left.num_milliseconds() / 1000).max(1);
            return Ok(Some(if secs < 120 {
                format!("Retrying in about {secs} s")
            } else {
                // `round(secs / 60)`: halves go to the even number
                format!("Retrying in about {} min", (secs as f64 / 60.0).round_ties_even() as i64)
            }));
        }
    }
    // quota is advice, never a reason to stall forever
    let window = quota::blocking(session, run, profile).await.unwrap_or(None);
    if let Some(window) = window.filter(|w| !w.is_empty()) {
        return Ok(Some(window));
    }
    let running = ai_run::Entity::find()
        .filter(ai_run::Column::MemberId.eq(run.member_id.as_str()))
        .filter(ai_run::Column::State.is_in(["starting", "running"]))
        .all(session)
        .await?;
    if running.len() as i64 >= i64::from(profile.max_parallel.max(1)) {
        return Ok(Some(format!("Waiting for a free slot ({} of {} in use)", running.len(), profile.max_parallel)));
    }
    if running.iter().any(|r| r.ticket_id == run.ticket_id && r.id != run.id) {
        return Ok(Some("Waiting for this team's earlier run on the same ticket to finish".to_string()));
    }
    let board_running = ai_run::Entity::find()
        .filter(ai_run::Column::ProjectId.eq(run.project_id.as_str()))
        .filter(ai_run::Column::State.is_in(["starting", "running"]))
        .all(session)
        .await?;
    if board_running.len() as i64 >= i64::from(settings.board_max_parallel.max(1)) {
        return Ok(Some(format!(
            "Waiting for a free slot on the board ({} of {} in use)",
            board_running.len(),
            settings.board_max_parallel
        )));
    }
    let hit = budget::blocked_detail(session, profile, settings, Some("person")).await.unwrap_or(None);
    if let Some(hit) = hit.filter(|h| !h.is_empty()) {
        return Ok(Some(hit.get("reason").map(kb_base::pyjson::py_str).unwrap_or_default()));
    }
    Ok(None)
}

/// Start what can start.
pub async fn tick() -> Result<(), DbErr> {
    let session = database::session();
    if let Err(err) = quota::release_expired(&session).await {
        tracing::debug!(target: "kanban.ai.runs", "quota release failed: {err}");
    }
    let queued = ai_run::Entity::find()
        .filter(ai_run::Column::State.eq("queued"))
        .order_by_asc(ai_run::Column::QueuedAt)
        .all(&session)
        .await?;
    for run in queued {
        if RT.has_task(&run.id) {
            continue;
        }
        let (member, profile) = get_profile(&session, &run.member_id).await?;
        let (Some(member), Some(profile)) = (member, profile) else {
            let mut row = kb_db::edit(run);
            row.state = Set("failed".to_string());
            row.ended_at = Set(Some(now_iso()));
            row.ended_reason = Set(Some("The team no longer exists.".to_string()));
            row.update(&session).await?;
            session.commit().await?;
            continue;
        };
        let settings = get_settings(&session, &run.project_id).await?;
        let reason = blocking_reason(&session, &run, &profile, &member, &settings).await?;
        if let Some(reason) = reason.filter(|r| !r.is_empty()) {
            if run.waiting_reason.as_deref() != Some(reason.as_str()) {
                RT.inner().waiting.insert(run.id.clone(), reason.clone());
                let mut row = kb_db::edit(run);
                row.waiting_reason = Set(Some(reason));
                let run = row.update(&session).await?;
                session.commit().await?;
                publish_dict(&run).await;
            }
            continue;
        }
        RT.inner().waiting.remove(&run.id);
        start(&session, run).await?;
    }
    Ok(())
}

async fn run_loop() {
    loop {
        RT.wake.clear();
        match tick().await {
            Ok(()) => {
                let due =
                    RT.inner().last_health.is_none_or(|at| at.elapsed().as_secs_f64() >= teams::HEALTH_INTERVAL_S);
                if due {
                    RT.inner().last_health = Some(Instant::now());
                    if let Err(err) = teams::health_check().await {
                        tracing::error!(target: "kanban.ai.runs", "The team health check failed: {err}");
                    }
                }
            }
            Err(err) => tracing::error!(target: "kanban.ai.runs", "The run scheduler failed on one pass: {err}"),
        }
        let _ = tokio::time::timeout(Duration::from_secs(2), RT.wake.wait()).await;
    }
}

/// Recover what the last start left, then start what waits. The API process in `process` mode starts the runner
/// instead (it owns the CLIs).
pub async fn start_scheduler() -> Result<(), DbErr> {
    RT.set_db_ready(true);
    if defers_to_runner() {
        runner_link::ensure_started(RT.board_url().as_deref());
        return Ok(());
    }
    recover_on_startup().await?;
    let mut inner = RT.inner();
    if inner.scheduler.as_ref().is_none_or(|t| t.is_finished()) {
        inner.scheduler = Some(ctx::spawn(run_loop()));
    }
    Ok(())
}

/// The board is closing: stop the scheduler and the CLIs; their runs are ended as board_closed.
pub async fn stop_scheduler() {
    if defers_to_runner() {
        runner_link::stop().await;
        return;
    }
    let scheduler = RT.inner().scheduler.take();
    if let Some(scheduler) = scheduler {
        scheduler.abort();
        let _ = scheduler.await;
    }
    let running: Vec<String> = RT.inner().procs.keys().cloned().collect();
    for run_id in running {
        match cancel(&run_id, "board", Some("The board closed."), Some(BOARD_CLOSED), true).await {
            Ok(_) => {}
            Err(err) if err.is_run_error() => {}
            // Python lets any other exception end the shutdown; the CLIs must still be stopped
            Err(err) => tracing::error!(target: "kanban.ai.runs", "Could not end run {run_id} at closing: {err}"),
        }
    }
    let mut inner = RT.inner();
    for task in inner.tasks.values() {
        task.abort.abort();
    }
    inner.tasks.clear();
    // (a process object that is let go stops its CLI)
    inner.procs.clear();
}

/// Runs that were starting or running when the board stopped go back to the queue with their conversation; a CLI of
/// ours still alive is stopped.
pub async fn recover_on_startup() -> Result<(), DbErr> {
    let session = database::session();
    let rows =
        ai_run::Entity::find().filter(ai_run::Column::State.is_in(["starting", "running"])).all(&session).await?;
    for run in rows {
        if RT.has_task(&run.id) {
            continue;
        }
        if let Some(pid) = run.pid.filter(|pid| *pid != 0) {
            if cli::looks_like_cli(i64::from(pid), None) {
                cli::kill_tree(Some(pid));
            }
        }
        let instruction =
            join_notes(&run.instruction, "The board restarted while you were working: continue from where you were.");
        let mut row = kb_db::edit(run);
        row.state = Set("queued".to_string());
        row.token_hash = Set(None);
        row.pid = Set(None);
        row.paused = Set(false);
        row.instruction = Set(instruction);
        row.update(&session).await?;
    }
    session.commit().await
}

/// `_start`: give a queued run its token and its task.
pub(crate) async fn start(session: &Session, run: ai_run::Model) -> Result<(), DbErr> {
    let token = guard::new_token();
    let started_at = run.started_at.clone().filter(|s| !s.is_empty()).unwrap_or_else(now_iso);
    let mut row = kb_db::edit(run);
    row.waiting_reason = Set(None);
    row.state = Set("starting".to_string());
    row.started_at = Set(Some(started_at));
    row.last_output_at = Set(Some(now_iso()));
    row.token_hash = Set(Some(guard::token_hash(&token)));
    let run = row.update(session).await?;
    session.commit().await?;
    RT.inner().waiting.remove(&run.id);
    spawn_execute(&run.id, token, None);
    publish_dict(&run).await;
    Ok(())
}
