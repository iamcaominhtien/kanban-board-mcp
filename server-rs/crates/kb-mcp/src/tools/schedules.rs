//! The schedules tool: let an AI team work on a ticket at a set time, once or on repeat (issue #153).

use std::collections::BTreeSet;

use kb_ai_run::schedules as svc;
use kb_base::activity;
use serde_json::{Map, Value};

use crate::common::{self, ToolError, ToolResult, arg_str, arg_text};

/// A failure of the schedules service: a `ScheduleError` is a `ValueError`, the rest is a failure of the tool.
fn schedule_error(err: svc::Error) -> ToolError {
    match err {
        svc::Error::Schedule(err) => ToolError::Value(err.message),
        svc::Error::Db(err) => err.into(),
        svc::Error::Other(text) => ToolError::Other(text),
    }
}

/// `{**(fields or {}), "ticket_id": ticket_id or (fields or {}).get("ticket_id")}`.
fn with_ticket(fields: &Map<String, Value>, ticket_id: Option<&str>) -> Map<String, Value> {
    let mut data = fields.clone();
    let ticket = match ticket_id.filter(|t| !t.is_empty()) {
        Some(ticket_id) => Value::String(ticket_id.to_string()),
        None => fields.get("ticket_id").cloned().unwrap_or(Value::Null),
    };
    data.insert("ticket_id".to_string(), ticket);
    data
}

/// AI schedules: an AI team works on a ticket at a set time. At the time the board checks permission, budget
/// and desktop app and starts a normal AI run; the team's lead decides what to do and reports. Not available
/// inside an AI run.
pub async fn ai_schedules(args: Map<String, Value>) -> ToolResult {
    let action = arg_text(&args, "action");
    let (project_id, schedule_id, ticket_id) =
        (arg_str(&args, "project_id"), arg_str(&args, "schedule_id"), arg_str(&args, "ticket_id"));
    let fields = args.get("fields").and_then(Value::as_object).cloned().unwrap_or_default();
    if let Some(ctx) = common::resolve().await? {
        // the Board AI (a chat answer, not a run) reads schedules and changes them through its actions block
        let board_ai = ctx.run_id.starts_with("chat_");
        if !board_ai || !["list", "get", "preview"].contains(&action.as_str()) {
            return Err(ToolError::Value(
                if board_ai {
                    "As the Board AI, list the change in your answer's actions block (schedule_create, schedule_edit, \
                     schedule_pause, schedule_resume, schedule_run); the board makes it by risk tier, with an Undo, \
                     or asks the person first."
                } else {
                    "An AI run cannot make or change schedules; a person does."
                }
                .to_string(),
            ));
        }
    }
    let actor = activity::current_actor();
    let by = if actor.is_empty() { activity::HUMAN_ACTOR.to_string() } else { actor };
    let unknown: BTreeSet<&str> =
        fields.keys().map(String::as_str).filter(|key| !svc::FIELDS.contains(key)).collect();
    if !unknown.is_empty() {
        return Err(ToolError::Value(format!(
            "Unknown field{} in fields: {}. Use: {}.",
            if unknown.len() > 1 { "s" } else { "" },
            unknown.iter().copied().collect::<Vec<_>>().join(", "),
            svc::FIELDS.join(", ")
        )));
    }
    let session = common::async_session();
    let project_id = project_id.filter(|p| !p.is_empty());
    let schedule_id = schedule_id.filter(|s| !s.is_empty());
    match action.as_str() {
        "list" => {
            let Some(project_id) = project_id else {
                return Err(ToolError::Value("list needs project_id.".to_string()));
            };
            let page = svc::list_for(&session, &project_id, ticket_id.as_deref()).await.map_err(schedule_error)?;
            return Ok(page.get("items").cloned().unwrap_or(Value::Null));
        }
        "preview" => {
            let Some(project_id) = project_id else {
                return Err(ToolError::Value("preview needs project_id.".to_string()));
            };
            let data = with_ticket(&fields, ticket_id.as_deref());
            let out = svc::preview(&session, &project_id, &data, &by, schedule_id.as_deref())
                .await
                .map_err(schedule_error)?;
            return Ok(Value::Object(out));
        }
        "create" => {
            let Some(project_id) = project_id else {
                return Err(ToolError::Value("create needs project_id.".to_string()));
            };
            let data = with_ticket(&fields, ticket_id.as_deref());
            let s = svc::create(&session, &project_id, &data, &by).await.map_err(schedule_error)?;
            return Ok(Value::Object(svc::to_dict(&session, &s, None).await.map_err(schedule_error)?));
        }
        _ => {}
    }
    let Some(schedule_id) = schedule_id else {
        return Err(ToolError::Value(format!("{action} needs schedule_id.")));
    };
    let s = match action.as_str() {
        "get" => {
            return Ok(Value::Object(svc::detail(&session, &schedule_id).await.map_err(schedule_error)?));
        }
        "update" => svc::update(&session, &schedule_id, &fields, &by).await.map_err(schedule_error)?,
        "pause" | "resume" => {
            svc::set_paused(&session, &schedule_id, action == "pause", &by, None).await.map_err(schedule_error)?
        }
        "delete" => {
            svc::delete(&session, &schedule_id, &by).await.map_err(schedule_error)?;
            return Ok(serde_json::json!({"deleted": schedule_id}));
        }
        _ => {
            let run = svc::run_now(&session, &schedule_id, &by).await.map_err(schedule_error)?;
            return Ok(Value::Object(svc::run_to_dict(&run, None)));
        }
    };
    Ok(Value::Object(svc::to_dict(&session, &s, None).await.map_err(schedule_error)?))
}
