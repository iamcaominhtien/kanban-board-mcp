//! What the board's tools and the ticket flow call (`services/ai/runs.py` lines 1827-2140): `question_options`,
//! `record_question`, `record_report`, `before_ticket_change`, `note_person_edit`, `wake_new_assignee`,
//! `start_on_ticket`, `deliver_to_ticket`.

use kb_ai::audit;
use kb_ai::context::RunContext;
use kb_ai::store::{active_runs, now_iso};
use kb_base::{pyjson, pytext};
use kb_board::hooks::NewAssignee;
use kb_board::tickets as svc_tickets;
use kb_db::Session;
use kb_db::database;
use kb_db::entities::{ai_run, ai_team, member, ticket};
use kb_db::sea_orm::{
    ActiveModelTrait, ActiveValue::Set, ColumnTrait, EntityTrait, IntoActiveModel, QueryFilter, QueryOrder, QuerySelect,
};
use serde_json::{Map, Value, json};

use super::{NewRun, RT, RunError, cancel, cancel_for_ticket, clip, create_run, refuse, send_message};
use crate::seams;

/// `str(value or "")`.
fn text_or_empty(value: Option<&Value>) -> String {
    match value.filter(|v| pyjson::truthy(v)) {
        Some(Value::String(s)) => s.clone(),
        Some(other) => pyjson::py_str(other),
        None => String::new(),
    }
}

/// The labels and details of a question's options.
pub fn question_options(options: Option<&[Value]>) -> (Vec<String>, Vec<Value>) {
    let mut labels: Vec<String> = Vec::new();
    let mut details: Vec<Value> = Vec::new();
    for o in options.unwrap_or(&[]) {
        let (label, description, recommended) = match o {
            Value::Object(map) => {
                let named = map.get("label").filter(|v| pyjson::truthy(v)).or_else(|| map.get("text"));
                (
                    clip(pytext::strip(&text_or_empty(named)), 200),
                    clip(pytext::strip(&text_or_empty(map.get("description"))), 300),
                    map.get("recommended").is_some_and(pyjson::truthy),
                )
            }
            Value::String(s) => (clip(pytext::strip(s), 200), String::new(), false),
            other => (clip(pytext::strip(&pyjson::py_str(other)), 200), String::new(), false),
        };
        if !label.is_empty() {
            details.push(json!({"label": label, "description": description, "recommended": recommended}));
            labels.push(label);
        }
    }
    labels.truncate(6);
    details.truncate(6);
    (labels, details)
}

/// The lead asks a person (ai_run ask): the run parks in Needs input when its process stops.
pub async fn record_question(
    ctx: &RunContext,
    text: &str,
    options: Option<&[Value]>,
) -> Result<Map<String, Value>, RunError> {
    let text = pytext::strip(text);
    if text.is_empty() {
        return Err(RunError::Value("ai_run(action='ask') needs `question`.".to_string()));
    }
    let (labels, details) = question_options(options);
    let mut q = Map::new();
    q.insert("text".into(), json!(clip(text, 1000)));
    q.insert("options".into(), json!(labels));
    q.insert("option_details".into(), json!(details));
    q.insert("to".into(), json!(ctx.on_behalf_of));
    q.insert("asked_at".into(), json!(now_iso()));
    {
        let session = database::session();
        let Some(run) = ai_run::Entity::find_by_id(ctx.run_id.as_str()).one(&session).await? else {
            return Err(RunError::Value("Run not found.".to_string()));
        };
        q.insert("previous".into(), json!(seams::carry_answer(run.question.as_deref(), run.answer.as_deref())));
        let mut row = run.into_active_model();
        row.question = Set(Some(pyjson::dumps(&Value::Object(q.clone()))));
        row.update(&session).await?;
        session.commit().await?;
    }
    let mut detail = Map::new();
    detail.insert("question".into(), q.get("text").cloned().unwrap_or(Value::Null));
    audit::record(
        &ctx.project_id,
        "ask_person",
        "info",
        audit::Entry {
            member_id: Some(ctx.member_id.clone()),
            member_name: ctx.member_name.clone(),
            on_behalf_of: Some(ctx.on_behalf_of.clone()),
            run_id: Some(ctx.run_id.clone()),
            target: ctx.ticket_id.clone(),
            detail,
        },
    )
    .await?;
    let mut out = Map::new();
    out.insert("posted".into(), json!(true));
    out.insert("to".into(), json!(ctx.on_behalf_of));
    out.insert("next".into(), json!("Stop now and end your turn. The board resumes this run with the answer."));
    Ok(out)
}

/// An explicit report through the tool (the final JSON report is the usual way).
pub async fn record_report(ctx: &RunContext, report: &Map<String, Value>) -> Result<Map<String, Value>, RunError> {
    let session = database::session();
    let Some(run) = ai_run::Entity::find_by_id(ctx.run_id.as_str()).one(&session).await? else {
        return Err(RunError::Value("Run not found.".to_string()));
    };
    let mut row = run.into_active_model();
    row.report = Set(pyjson::dumps(&Value::Object(report.clone())));
    if let Some(summary) = report.get("summary").filter(|v| pyjson::truthy(v)) {
        let summary = match summary {
            Value::String(s) => s.clone(),
            other => pyjson::py_str(other),
        };
        row.summary = Set(Some(clip(&summary, 8000)));
    }
    row.update(&session).await?;
    session.commit().await?;
    let mut out = Map::new();
    out.insert("recorded".into(), json!(true));
    Ok(out)
}

/// A person changes a ticket an AI may be working on: a deletion ends its runs; a reassignment away from the team
/// ends them too. (`status` is taken and not looked at, as in Python.)
pub async fn before_ticket_change(
    ticket_id: &str,
    _status: Option<&str>,
    assignee: NewAssignee<'_>,
    deleting: bool,
    by: Option<&str>,
) -> Result<(), RunError> {
    let by = by.filter(|b| !b.is_empty()).unwrap_or("board");
    if deleting {
        cancel_for_ticket(ticket_id, by, "The ticket was deleted.", Some("deleted")).await?;
        return Ok(());
    }
    if let NewAssignee::To(assignee) = assignee {
        let rows: Vec<ai_run::Model> = {
            let session = database::session();
            active_runs(&session, None, Some(ticket_id))
                .await?
                .into_iter()
                .filter(|r| Some(r.member_id.as_str()) != assignee)
                .collect()
        };
        for r in rows {
            match cancel(&r.id, by, Some("The ticket was reassigned."), Some("reassigned"), false).await {
                Ok(_) => {}
                Err(err) if err.is_run_error() => {}
                Err(err) => return Err(err),
            }
        }
    }
    Ok(())
}

/// A person edited the ticket while a lead works on it: the lead hears it on its live input, and the edit is
/// recorded as a touch (tab "You stepped in").
pub async fn note_person_edit(ticket_id: &str, by: Option<&str>, what: &str, tell_lead: bool) -> Result<(), RunError> {
    let by = by.filter(|b| !b.is_empty());
    if let Some(touches) = seams::touches() {
        let session = database::session();
        // a note about the edit must never fail the edit
        if let Err(err) = touches.record_edit(&session, ticket_id, by, what).await {
            tracing::error!(target: "kanban.ai.runs", "Could not record the edit of {ticket_id} as a touch: {err}");
        }
    }
    if !tell_lead {
        return Ok(());
    }
    let rows: Vec<ai_run::Model> = {
        let session = database::session();
        active_runs(&session, None, Some(ticket_id))
            .await?
            .into_iter()
            .filter(|r| matches!(r.state.as_str(), "starting" | "running"))
            .collect()
    };
    for r in rows {
        if let Some(proc) = RT.proc(&r.id).filter(|p| p.live && p.input_open()) {
            let what = if what.is_empty() { "the ticket" } else { what };
            proc.send(&format!("{} edited {what}: read it again before you go on.", by.unwrap_or("A person"))).await;
        }
    }
    Ok(())
}

/// A ticket was given to a team: its lead starts (or hears about it when already on the ticket).
pub async fn wake_new_assignee(
    ticket_id: &str,
    assignee_id: Option<&str>,
    by: Option<&str>,
    instruction: &str,
) -> Result<Option<ai_run::Model>, RunError> {
    let Some(assignee_id) = assignee_id.filter(|a| !a.is_empty()) else { return Ok(None) };
    let by = by.filter(|b| !b.is_empty());
    let session = database::session();
    let member = member::Entity::find_by_id(assignee_id).one(&session).await?;
    let profile = ai_team::Entity::find_by_id(assignee_id).one(&session).await?;
    let ticket = ticket::Entity::find_by_id(ticket_id).one(&session).await?;
    let (Some(member), Some(_profile), Some(ticket)) = (member, profile, ticket) else { return Ok(None) };
    if member.kind != "ai" || matches!(ticket.status.as_str(), "done" | "wont_do") {
        return Ok(None);
    }
    let active = active_runs(&session, Some(assignee_id), Some(ticket_id)).await?;
    if !active.is_empty() {
        let live = active.iter().find(|r| matches!(r.state.as_str(), "starting" | "running"));
        if let (Some(live), false) = (live, instruction.is_empty()) {
            send_message(&live.id, instruction, by.unwrap_or("board"), None, true).await?;
        }
        return Ok(active.into_iter().next());
    }
    let new = NewRun {
        ticket_id: Some(ticket_id),
        member_id: assignee_id,
        trigger: "assign",
        started_by: by.unwrap_or("user"),
        instruction,
        ..NewRun::default()
    };
    match create_run(&session, new).await {
        Ok(run) => Ok(Some(run)),
        Err(err) if err.is_run_error() => {
            session.rollback().await?;
            tracing::info!(target: "kanban.ai.runs", "Assigning {ticket_id} to {} started nothing: {err}", member.name);
            Ok(None)
        }
        Err(err) => Err(err),
    }
}

/// Run on a ticket from the board: the assigned team, else the one given, else the project's only team.
pub async fn start_on_ticket(
    session: &Session,
    ticket_id: &str,
    member_id: Option<&str>,
    by: &str,
    instruction: &str,
    mode: &str,
) -> Result<ai_run::Model, RunError> {
    let Some(ticket) = ticket::Entity::find_by_id(ticket_id).one(session).await? else {
        return refuse("Ticket not found.");
    };
    let mut team_id = member_id.filter(|m| !m.is_empty()).map(str::to_string);
    if let (None, Some(assignee)) = (&team_id, ticket.assignee.as_deref().filter(|a| !a.is_empty())) {
        let m = member::Entity::find_by_id(assignee).one(session).await?;
        if let Some(m) = m.filter(|m| m.kind == "ai") {
            team_id = Some(m.id);
        }
    }
    let team_id = match team_id {
        Some(team_id) => team_id,
        None => {
            let rows = member::Entity::find()
                .filter(member::Column::ProjectId.eq(ticket.project_id.as_str()))
                .filter(member::Column::Kind.eq("ai"))
                .all(session)
                .await?;
            if rows.len() != 1 {
                return refuse(format!(
                    "Pick a team: the ticket has no AI assignee{}",
                    if rows.is_empty() {
                        " and the project has no team yet."
                    } else {
                        " and the project has several teams."
                    }
                ));
            }
            rows[0].id.clone()
        }
    };
    if ticket.assignee.as_deref() != Some(team_id.as_str()) && mode == "work" {
        svc_tickets::update_ticket(session, ticket_id, &svc_tickets::TicketUpdate::of("assignee", json!(team_id)))
            .await?;
    }
    let active: Vec<ai_run::Model> = active_runs(session, None, Some(ticket_id))
        .await?
        .into_iter()
        .filter(|r| matches!(r.state.as_str(), "starting" | "running" | "needs_input"))
        .collect();
    if let Some(first) = active.into_iter().next().filter(|r| r.member_id == team_id) {
        // the team is already on it: a note reaches its lead; nothing to say means nothing to start
        if !instruction.is_empty() {
            let out = send_message(&first.id, instruction, by, None, true).await?;
            let run_id = out.get("run_id").and_then(Value::as_str).unwrap_or("").to_string();
            let s2 = database::session();
            return match ai_run::Entity::find_by_id(run_id).one(&s2).await? {
                Some(run) => Ok(run),
                None => refuse("Run not found."),
            };
        }
        return Ok(first);
    }
    create_run(
        session,
        NewRun {
            ticket_id: Some(ticket_id),
            member_id: &team_id,
            mode,
            trigger: "run_button",
            started_by: by,
            instruction,
            ..NewRun::default()
        },
    )
    .await
}

/// The one primitive of AI-to-AI and person-to-AI contact: a note to the ticket's team. Live when its lead runs,
/// else a new turn on its conversation; a ticket with no team gets the note as a comment.
///
/// `trigger` says where the note came from, and the run it starts carries it (the lead is told how to answer):
/// `message` the ticket chat (the default), `ai_message` another AI, `docs_threads` comment threads from Docs,
/// `ci_red` and `review_comments` GitHub. Only the chat's text can answer a question the team asked
/// (`needs_input`): the others are refused while it waits. `depth` is the hand-off depth of the run it starts.
///
/// Errors: `RunError::Run`: the ticket is not there, the team asks a person something (non-chat), or its run cannot
/// start.
pub async fn deliver_to_ticket(
    ticket_id: &str,
    text: &str,
    by: &str,
    trigger: &str,
    depth: i64,
) -> Result<Map<String, Value>, RunError> {
    let depth = i32::try_from(depth).unwrap_or(i32::MAX);
    let session = database::session();
    let Some(ticket) = ticket::Entity::find_by_id(ticket_id).one(&session).await? else {
        return refuse("Ticket not found.");
    };
    let active = active_runs(&session, None, Some(ticket_id)).await?;
    if let Some(first) = active.into_iter().next() {
        let run_id = first.id.clone();
        if depth != 0 && first.depth < depth {
            // a note that reaches a run already going counts as a hand-off too: its next note starts one deeper
            let mut row = first.into_active_model();
            row.depth = Set(depth);
            row.update(&session).await?;
            session.commit().await?;
        }
        return send_message(&run_id, text, by, None, trigger == "message").await;
    }
    let last = ai_run::Entity::find()
        .filter(ai_run::Column::TicketId.eq(ticket_id))
        .order_by_desc(ai_run::Column::QueuedAt)
        .limit(1)
        .one(&session)
        .await?;
    let mut team_id: Option<String> = None;
    if let Some(assignee) = ticket.assignee.as_deref().filter(|a| !a.is_empty()) {
        let m = member::Entity::find_by_id(assignee).one(&session).await?;
        team_id = m.filter(|m| m.kind == "ai").map(|m| m.id);
    }
    let team_id = team_id.filter(|t| !t.is_empty()).or_else(|| last.as_ref().map(|l| l.member_id.clone()));
    let Some(team_id) = team_id else {
        let mut meta = Map::new();
        meta.insert("kind".into(), json!("message"));
        svc_tickets::add_comment(&session, ticket_id, text, by, Some(&meta)).await?;
        let mut out = Map::new();
        out.insert("delivered".into(), json!("comment"));
        out.insert("run_id".into(), Value::Null);
        return Ok(out);
    };
    let resume = last.as_ref().filter(|l| l.member_id == team_id).and_then(|l| l.session_id.clone());
    let run = create_run(
        &session,
        NewRun {
            ticket_id: Some(ticket_id),
            member_id: &team_id,
            trigger,
            depth,
            started_by: by,
            instruction: &format!("{by} says:\n{text}"),
            resume_session: resume.as_deref(),
            ..NewRun::default()
        },
    )
    .await?;
    let mut out = Map::new();
    out.insert("delivered".into(), json!("new_run"));
    out.insert("run_id".into(), json!(run.id));
    Ok(out)
}
