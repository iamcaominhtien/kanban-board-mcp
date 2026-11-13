//! `services/tickets.py`, lines 1647-1697: the activity feed of a project (the event timeline), read from the
//! activity logs and comments of its tickets.

use kb_base::pyjson::truthy;
use kb_db::Session;
use serde::Serialize;
use serde_json::Value;

use super::core::list_tickets;
use super::{Error, field, loads, py_str};

/// One activity entry as returned by the activity feed (`ActivityEventRead` of `models.py`).
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ActivityEventRead {
    #[serde(rename = "ticketId")]
    pub ticket_id: String,
    #[serde(rename = "ticketTitle")]
    pub ticket_title: String,
    pub event_type: String,
    pub at: String,
    pub detail: Option<String>,
}

/// `at=item.get("at", ticket.created_at)` of a field that is `str`: anything else is the model's validation error.
fn at_of(item: &Value, created_at: &str) -> Result<String, Error> {
    match item.get("at") {
        None => Ok(created_at.to_string()),
        Some(Value::String(at)) => Ok(at.clone()),
        Some(other) => Err(Error::Other(format!("ActivityEventRead.at: Input should be a valid string, got {other}"))),
    }
}

/// Return the project's most recent activity across tickets, newest first.
///
/// `limit` is the maximum number of entries (200 in Python when not given). Returns activity entries with their
/// ticket id and title.
pub async fn get_project_activities(
    session: &Session,
    project_id: &str,
    limit: usize,
) -> Result<Vec<ActivityEventRead>, Error> {
    let tickets = list_tickets(session, project_id, None, None, None, true, None, None).await?;
    let mut events: Vec<ActivityEventRead> = Vec::new();
    for ticket in tickets {
        events.push(ActivityEventRead {
            ticket_id: ticket.id.clone(),
            ticket_title: ticket.title.clone(),
            event_type: "created".to_string(),
            at: ticket.created_at.clone(),
            detail: None,
        });
        for entry in loads(&ticket.activity_log)? {
            if matches!(field(&entry, "field").as_str(), Some("created" | "comment")) {
                continue; // already reported as their own timeline events
            }
            events.push(ActivityEventRead {
                ticket_id: ticket.id.clone(),
                ticket_title: ticket.title.clone(),
                event_type: format!("changed:{}", entry.get("field").map(py_str).unwrap_or_default()),
                at: at_of(&entry, &ticket.created_at)?,
                detail: Some(format!("{} \u{2192} {}", py_str(field(&entry, "from")), py_str(field(&entry, "to")))),
            });
        }
        for comment in loads(&ticket.comments)? {
            if truthy(field(&comment, "deleted_at")) {
                continue;
            }
            let detail = match comment.get("text") {
                None => Some(String::new()),
                Some(Value::Null) => None,
                Some(Value::String(text)) => Some(text.clone()),
                Some(other) => {
                    let message = format!("ActivityEventRead.detail: Input should be a valid string, got {other}");
                    return Err(Error::Other(message));
                }
            };
            events.push(ActivityEventRead {
                ticket_id: ticket.id.clone(),
                ticket_title: ticket.title.clone(),
                event_type: "commented".to_string(),
                at: at_of(&comment, &ticket.created_at)?,
                detail,
            });
        }
    }
    // `sort(key=..., reverse=True)` keeps the order of entries with the same time
    events.sort_by(|a, b| b.at.cmp(&a.at));
    events.truncate(limit);
    Ok(events)
}
