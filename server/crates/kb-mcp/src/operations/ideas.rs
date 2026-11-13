//! Idea Space operations for AI agents: read ideas and their assumptions, and add to the Inbox.
//!
//! An AI member can only suggest: it cannot move, edit, merge, archive, delete or promote an idea. A person does
//! that in the app (design: "AI only suggests").

use kb_base::activity;
use kb_ideas::idea_space::{self as svc_space, ListFilter};
use kb_ideas::idea_tickets::{self as svc_idea_tickets, NewIdea};
use kb_ideas::model::{Idea, idea_readiness};
use kb_ideas::schemas::IdeaTicketRead;
use serde_json::{Map, Value, json};

use crate::common::{self, ToolError, ToolResult, missing_idea, notify_on_success};

/// What an Idea Space service fails with, as the tool reports it (`IdeaRuleError` is a `ValueError`).
fn idea_error(err: kb_ideas::Error) -> ToolError {
    match err {
        kb_ideas::Error::Value(message) => ToolError::Value(message),
        kb_ideas::Error::Rule(rule) => ToolError::Value(rule.message),
        kb_ideas::Error::Db(err) => err.into(),
        kb_ideas::Error::Other(message) => ToolError::Other(message),
    }
}

/// `_idea_ticket_to_dict`: an idea ticket (its activity trail has its own tool: get_idea_activity_trail).
pub fn idea_ticket_to_dict(idea: &Idea) -> Result<Map<String, Value>, ToolError> {
    let read = IdeaTicketRead::from_idea_ticket(idea).map_err(idea_error)?;
    let Value::Object(mut data) = serde_json::to_value(read)? else {
        return Err(ToolError::Other("an idea is an object".to_string()));
    };
    data.shift_remove("activity_trail");
    Ok(data)
}

/// List ideas (Idea Space), the ones closest to ready first. Ideas go through the stages inbox, exploring, ready,
/// building, parked, shipped and archived; only people move them.
pub async fn list_idea_tickets(project_id: Option<&str>, stage: Option<&str>, q: Option<&str>) -> ToolResult {
    let session = common::async_session();
    let stages: Vec<String> = stage.filter(|s| !s.is_empty()).map(str::to_string).into_iter().collect();
    let filter = ListFilter {
        project_id,
        scope: if project_id.is_some_and(|p| !p.is_empty()) { "project" } else { "all" },
        stages: &stages,
        q,
        ..ListFilter::default()
    };
    let ideas = svc_space::list_ideas(&session, &filter).await.map_err(idea_error)?;
    let listed: Vec<Value> =
        ideas.iter().map(|i| idea_ticket_to_dict(i).map(Value::Object)).collect::<Result<_, _>>()?;
    Ok(Value::Array(listed))
}

/// The idea an id names, or the refusal.
async fn find_idea(session: &kb_db::Session, ticket_id: &str) -> Result<Idea, ToolError> {
    svc_idea_tickets::get_idea_ticket(session, ticket_id)
        .await
        .map_err(idea_error)?
        .ok_or_else(|| missing_idea(ticket_id))
}

/// Get one idea in full: its page text, stage, votes, readiness and assumptions with their impact, status
/// and evidence. Its change history is separate: get_idea_activity_trail.
pub async fn get_idea_ticket(ticket_id: &str) -> ToolResult {
    let session = common::async_session();
    let idea = find_idea(&session, ticket_id).await?;
    Ok(Value::Object(idea_ticket_to_dict(&idea)?))
}

/// The assumptions of an idea ("what must be true") with impact if wrong (low/medium/high), status (untested,
/// testing, validated, disproved), evidence and test ticket, and the idea's readiness.
pub async fn list_idea_assumptions(ticket_id: &str) -> ToolResult {
    let session = common::async_session();
    let idea = find_idea(&session, ticket_id).await?;
    let data = idea_ticket_to_dict(&idea)?;
    Ok(json!({
        "idea": idea.id,
        "readiness": Value::Object(idea_readiness(idea.assumptions())),
        "assumptions": data.get("assumptions").cloned().unwrap_or(Value::Null),
    }))
}

/// Suggest an idea: it lands in the Inbox of the Idea Space for a person to sort (keep, park, merge or archive).
/// Use it instead of widening a ticket's scope. It is marked as suggested by AI with your reason; you cannot move,
/// edit or archive ideas afterwards. Returns the idea (id 'IDEA-<n>').
pub async fn create_idea_ticket(
    title: &str,
    description: &str,
    project_id: Option<&str>,
    why: Option<&str>,
    ticket_id: Option<&str>,
    tags: Option<Vec<Value>>,
) -> ToolResult {
    notify_on_success(async {
        let author = activity::current_actor();
        let mut source_ref = Map::new();
        source_ref.insert("kind".into(), json!("ai"));
        source_ref.insert("by".into(), json!(author));
        source_ref.insert("why".into(), json!(why.unwrap_or_default()));
        if let Some(ticket_id) = ticket_id.filter(|t| !t.is_empty()) {
            source_ref.insert("kind".into(), json!("ticket"));
            source_ref.insert("id".into(), json!(ticket_id));
            source_ref.insert("label".into(), json!(ticket_id));
        }
        let session = common::async_session();
        let tags = tags.unwrap_or_default();
        let new = NewIdea {
            description,
            tags: Some(&tags),
            source: "ai",
            author: Some(&author),
            source_ref: Some(&source_ref),
            ..NewIdea::new(title)
        };
        let idea = svc_idea_tickets::create_idea_ticket(&session, project_id, new).await.map_err(idea_error)?;
        Ok(Value::Object(idea_ticket_to_dict(&idea)?))
    })
    .await
}

/// The idea's change history (stage moves, assumptions, evidence, edits; who did it), newest first.
pub async fn get_idea_activity_trail(ticket_id: &str) -> ToolResult {
    let session = common::async_session();
    let idea = find_idea(&session, ticket_id).await?;
    Ok(Value::Array(svc_space::activity(&idea, None).map_err(idea_error)?))
}
