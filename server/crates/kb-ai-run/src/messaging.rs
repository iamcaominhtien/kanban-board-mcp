//! The one primitive of contact between AIs and people (AI v2, spec 4.3): a note to a ticket's team, or to a Docs
//! page's assistant (`services/ai/messaging.py`). Live when the receiver's session runs (its stdin), else the
//! receiver's next turn on its conversation; a receiver with no session yet gets a new one.

use kb_base::{activity, ctx};
use kb_db::database;
use kb_db::entities::docs_page;
use kb_db::sea_orm::EntityTrait;
use serde_json::{Map, Value, json};

use crate::runs::{self, RunError};
use crate::seams;

/// A note to the ticket's team from another AI (see `runs::deliver_to_ticket`). Python's defaults: `trigger`
/// "ai_message", `depth` 1.
pub async fn deliver_to_ticket(
    ticket_id: &str,
    text: &str,
    by: &str,
    trigger: &str,
    depth: i64,
) -> Result<Map<String, Value>, RunError> {
    runs::deliver_to_ticket(ticket_id, text, by, trigger, depth).await
}

/// A note to a Docs page: it is kept as a page comment thread written by `by`, and the page's assistant answers in
/// that thread on the page's own conversation (a `thread_reply` job) when Docs AI is on for the project.
///
/// `depth` is how many AI hand-offs lie behind this note: the assistant's turn on the page carries it, so a note it
/// sends on (to a ticket) is counted from there.
///
/// Returns `{delivered: "page_assistant" | "page_comment", thread_id, job_id?}`.
///
/// Errors: `RunError::Value`: the note could not be left on the page. Until Docs comments and the assistant are
/// registered (`seams::PageNotes`) there is nothing to leave the note with: `RunError::Other`, as the import of a
/// module that is not there.
pub async fn deliver_to_page(page_id: &str, text: &str, by: &str, depth: i64) -> Result<Map<String, Value>, RunError> {
    let Some(notes) = seams::page_notes() else {
        return Err(RunError::Other("Docs comments and the assistant are not part of this server yet.".to_string()));
    };
    let token = activity::set_actor(Some(by));
    let out = async {
        let session = database::session();
        // the page may not take comments from this sender
        let thread = notes
            .create_thread(&session, page_id, text)
            .await
            .map_err(|exc| RunError::Value(format!("The note could not be left on the page: {exc}")))?;
        let mut project_id = match thread.get("project_id") {
            Some(Value::String(id)) => Some(id.clone()),
            _ => None,
        };
        if project_id.is_none() {
            project_id = docs_page::Entity::find_by_id(page_id).one(&session).await?.map(|p| p.project_id);
        }
        let mut out = Map::new();
        out.insert("delivered".into(), json!("page_comment"));
        out.insert("thread_id".into(), thread.get("id").cloned().unwrap_or(Value::Null));
        let Some(project_id) = project_id else { return Ok(out) };
        if !notes.docs_ai_on(&session, &project_id).await? {
            return Ok(out);
        }
        if notes.ready_state(&project_id).await.map_err(RunError::Other)? != "ready" {
            return Ok(out);
        }
        let thread_id = thread.get("id").and_then(Value::as_str).unwrap_or("");
        let instruction: String = text.chars().take(300).collect();
        let job_id = notes
            .start_thread_reply(&session, &project_id, by, page_id, thread_id, &instruction, depth)
            .await
            .map_err(RunError::Other)?;
        out.insert("delivered".into(), json!("page_assistant"));
        out.insert("job_id".into(), json!(job_id));
        Ok(out)
    }
    .await;
    ctx::reset(token);
    out
}
