//! The `ai_run` tool (AI v2): what a run started by the board does with the board beyond the ticket tools: ask a
//! person, send a note to another ticket's team or a Docs page, read its own team, record a report.

use kb_ai::store::{active_runs, get_profile};
use kb_ai_run::runs::{self, RunError};
use kb_ai_run::session_history;
use kb_ai_run::{messaging, teams};
use kb_assist::assistant::chat as ticket_chat;
use kb_base::pytext;
use serde_json::{Map, Value, json};

use crate::common::{self, ToolError, ToolResult, arg_str};
use crate::hooks::RunContext;

/// The run context of the AI crates (the same fields as the hook's).
fn ai_context(ctx: &RunContext) -> kb_ai::context::RunContext {
    kb_ai::context::RunContext {
        run_id: ctx.run_id.clone(),
        member_id: ctx.member_id.clone(),
        member_name: ctx.member_name.clone(),
        project_id: ctx.project_id.clone(),
        ticket_id: ctx.ticket_id.clone(),
        on_behalf_of: ctx.on_behalf_of.clone(),
        mode: ctx.mode.clone(),
        trigger: ctx.trigger.clone(),
        depth: ctx.depth,
        acts_by_tier: ctx.acts_by_tier,
    }
}

/// A failure of the runs as the tool raises it: a `ValueError` (the `RunError`s are) is a refused call.
fn run_error(err: RunError) -> ToolError {
    if err.is_value_error() { ToolError::Value(err.to_string()) } else { ToolError::Other(err.to_string()) }
}

/// A failure of the team's own code.
fn team_error(err: teams::Error) -> ToolError {
    if err.is_value_error() { ToolError::Value(err.to_string()) } else { ToolError::Other(err.to_string()) }
}

/// A failure of the ticket chat (`AssistError` is a `ValueError`).
fn chat_error(err: kb_assist::assistant::errors::Error) -> ToolError {
    use kb_assist::assistant::errors::Error;
    match err {
        Error::Assist(err) => ToolError::Value(err.to_string()),
        Error::Value(text) => ToolError::Value(text),
        Error::Db(err) => err.into(),
        Error::Other(text) => ToolError::Other(text),
    }
}

/// Only inside an AI run the board started (its bearer token says which). ask parks the run until a person
/// answers: say what you need and stop. message reaches a ticket's team live when its lead is running, else as its
/// next turn; a Docs page's assistant answers in the page's thread. A note an AI sends counts as one hand-off between
/// AIs: after a few the board refuses another (finish the work yourself), and a team that waits for a person's
/// answer is not sent notes.
pub async fn ai_run(args: Map<String, Value>) -> ToolResult {
    let action = arg_str(&args, "action").unwrap_or_default();
    let Some(ctx) = common::resolve().await? else {
        return Err(ToolError::Value(
            "ai_run is for a run the board started; you are not in one. Use the ticket tools directly.".to_string(),
        ));
    };
    let ai = ai_context(&ctx);
    match action.as_str() {
        "ask" => {
            let question = arg_str(&args, "question").unwrap_or_default();
            let options = args.get("options").and_then(Value::as_array);
            let out = runs::record_question(&ai, &question, options.map(Vec::as_slice)).await.map_err(run_error)?;
            Ok(Value::Object(out))
        }
        "message" => {
            let target = pytext::strip(&arg_str(&args, "to").unwrap_or_default()).to_string();
            let body = pytext::strip(&arg_str(&args, "text").unwrap_or_default()).to_string();
            if target.is_empty() || body.is_empty() {
                return Err(ToolError::Value(
                    "ai_run(action='message') needs `to` (a ticket key or docs:<page id>) and `text`.".to_string(),
                ));
            }
            // an assistant's calls act as a team of the project (so Docs lets them in), but the note is from the
            // assistant
            let sender = if ctx.trigger == "assistant" { "Board AI" } else { ctx.member_name.as_str() };
            if ctx.depth >= runs::MAX_DEPTH {
                return Err(ToolError::Value(format!(
                    "Too many hand-offs between AIs ({0}): this note came through {0} of them already. Do not pass \
                     it on; finish it yourself, or say what is missing in your answer for a person.",
                    ctx.depth
                )));
            }
            if let Some(page) = target.strip_prefix("docs:") {
                // the note is posted as a member of the project (Docs lets in only those): the team, or the
                // board's agent
                let out = messaging::deliver_to_page(page, &body, &ctx.member_name, ctx.depth + 1)
                    .await
                    .map_err(run_error)?;
                return Ok(Value::Object(out));
            }
            if ctx.ticket_id.as_deref() == Some(target.as_str()) {
                return Err(ToolError::Value(
                    "That is your own ticket: write a comment with ticket_items instead.".to_string(),
                ));
            }
            let out = messaging::deliver_to_ticket(&target, &body, sender, "ai_message", ctx.depth + 1)
                .await
                .map_err(run_error)?;
            Ok(Value::Object(out))
        }
        "history" => {
            let given = arg_str(&args, "to").filter(|t| !t.is_empty());
            let key = given.or_else(|| ctx.ticket_id.clone().filter(|t| !t.is_empty())).unwrap_or_default();
            let key = pytext::strip(&key).to_string();
            if key.is_empty() {
                return Err(ToolError::Value(
                    "ai_run(action='history') needs `to`: a ticket key such as IAM-12.".to_string(),
                ));
            }
            let rows = session_history::list_for_ticket(&key, 10).await?;
            let rows: Vec<Value> = rows.into_iter().map(Value::Object).collect();
            Ok(json!({"ticket_id": key, "conversations": rows}))
        }
        "reply" => {
            let Some(ticket_id) = ctx.ticket_id.as_deref().filter(|t| !t.is_empty()) else {
                return Err(ToolError::Value("ai_run(action='reply') is for a run on a ticket.".to_string()));
            };
            let text = arg_str(&args, "text").unwrap_or_default();
            let message_id = arg_str(&args, "message_id");
            ticket_chat::reply_from_team(ticket_id, &text, &ctx.member_id, message_id.as_deref())
                .await
                .map_err(chat_error)
        }
        "team" => {
            let session = common::async_session();
            let (member, profile) = get_profile(&session, &ctx.member_id).await?;
            let (Some(member), Some(profile)) = (member, profile) else {
                return Err(ToolError::Value("Your team was not found.".to_string()));
            };
            let desc = teams::describe(&session, &member, &profile, None).await.map_err(team_error)?;
            let mut out = Map::new();
            for key in ["id", "name", "pack_key", "roles", "model", "effort", "status"] {
                let Some(value) = desc.get(key) else {
                    return Err(ToolError::Other(kb_base::pytext::repr(key)));
                };
                out.insert(key.to_string(), value.clone());
            }
            Ok(Value::Object(out))
        }
        "runs" => {
            let session = common::async_session();
            let rows = active_runs(&session, Some(&ctx.member_id), None).await?;
            let rows: Vec<Value> = rows
                .iter()
                .map(|r| json!({"id": r.id, "ticket_id": r.ticket_id, "state": r.state, "number": r.number}))
                .collect();
            Ok(json!({"runs": rows}))
        }
        "report" => {
            let Some(report) = args.get("report").and_then(Value::as_object) else {
                return Err(ToolError::Value("ai_run(action='report') needs `report`.".to_string()));
            };
            let out = runs::record_report(&ai, report).await.map_err(run_error)?;
            Ok(Value::Object(out))
        }
        other => Err(ToolError::Value(format!("Unknown action {}.", kb_base::pytext::repr(other)))),
    }
}
