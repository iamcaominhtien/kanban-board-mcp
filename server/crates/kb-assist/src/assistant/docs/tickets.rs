//! From a page to tickets (`services/assistant/docs.py`, lines 644 to 723): ticket drafts from the open items of a
//! page, and creating the reviewed drafts (no model).

use std::collections::HashMap;
use std::sync::{LazyLock, Mutex, MutexGuard};

use kb_base::{pyjson, pytext, time};
use kb_board::tickets::{self, NewTicket};
use kb_db::Session;
use kb_db::entities::{docs_ai_job, project};
use kb_db::sea_orm::EntityTrait;
use serde_json::{Map, Value, json};

use super::{TurnExtra, boxed, clip, cost, get, get_or, input, items, merge, text_of, turn};
use crate::docs_ai::errors::{DocsAiError, Error};
use crate::docs_ai::jobs::HandlerFuture;

/// `_UNDO`: what each creation made, to undo it (the ticket ids and who made them).
static UNDO: LazyLock<Mutex<HashMap<String, (Vec<String>, String)>>> = LazyLock::new(|| Mutex::new(HashMap::new()));

fn undo() -> MutexGuard<'static, HashMap<String, (Vec<String>, String)>> {
    UNDO.lock().unwrap_or_else(|e| e.into_inner())
}

/// Ticket drafts from the open items of a page; nothing is created.
pub fn tickets_draft_job(job: docs_ai_job::Model) -> HandlerFuture {
    boxed(async move {
        let mut inputs = Map::new();
        inputs.insert("page_id".into(), json!(job.page_id));
        inputs.insert("selection".into(), get(&input(&job), "selection"));
        let out = turn(&job, "docs-tickets", inputs, None, TurnExtra::default()).await?;
        let data = out.data();
        let mut drafts = Vec::new();
        for d in items(data.get("drafts")) {
            let Some(d) = d.as_object() else { continue };
            if !d.get("title").is_some_and(pyjson::truthy) {
                continue;
            }
            drafts.push(json!({
                "title": clip(&text_of(&get_or(d, "title", json!(""))), 200),
                "text": get_or(d, "text", json!("")),
                "type": get_or(d, "type", json!("task")),
                "line": get(d, "line"),
            }));
        }
        let mut result = Map::new();
        result.insert("drafts".into(), Value::Array(drafts));
        result.insert("skipped".into(), get_or(&data, "skipped", json!([])));
        Ok(merge(result, cost(&out)))
    })
}

/// `d.get(key)` as text, when it is true.
fn given<'a>(d: &'a Map<String, Value>, key: &str) -> Option<&'a str> {
    d.get(key).filter(|v| pyjson::truthy(v)).and_then(Value::as_str)
}

/// Create the reviewed drafts as tickets and link them to the page. No model.
pub async fn create_tickets(
    session: &Session,
    page_id: &str,
    by: &str,
    drafts: &[Value],
    link: bool,
) -> Result<Map<String, Value>, Error> {
    let page = kb_docs::docs::get_page(session, page_id, false, true).await?;
    let mut made: Vec<Value> = Vec::new();
    for d in drafts {
        let empty = Map::new();
        let d = d.as_object().unwrap_or(&empty);
        let title = pytext::strip(given(d, "title").unwrap_or("")).to_string();
        if title.is_empty() {
            continue;
        }
        let project_id = given(d, "project_id").unwrap_or(page.project_id.as_str()).to_string();
        if project::Entity::find_by_id(project_id.as_str()).one(session).await?.is_none() {
            return Err(DocsAiError::new("invalid", "That project does not exist.").into());
        }
        let mut new = NewTicket::new(&title);
        new.r#type = given(d, "type").unwrap_or("task");
        new.status = given(d, "column").unwrap_or("backlog");
        new.description = given(d, "text").unwrap_or("");
        new.due_date = given(d, "due_date");
        new.assignee = given(d, "assignee_id");
        new.created_by = Some(by);
        let ticket = tickets::create_ticket(session, &project_id, new).await?;
        made.push(json!({"id": ticket.id, "title": ticket.title, "project_id": project_id}));
        if link {
            // a link that fails does not undo the ticket
            let _ = kb_docs::docs::link_ticket_doc(session, &ticket.id, &page.id).await;
        }
    }
    let token = time::uuid4_hex();
    let ids: Vec<String> = made.iter().filter_map(|t| t["id"].as_str().map(str::to_string)).collect();
    undo().insert(token.clone(), (ids, by.to_string()));
    let mut out = Map::new();
    let linked = link && !made.is_empty();
    out.insert("tickets".into(), Value::Array(made));
    out.insert("undo_token".into(), json!(token));
    out.insert("replaced".into(), json!(false));
    out.insert("linked".into(), json!(linked));
    Ok(out)
}

/// Delete the tickets a creation made.
pub async fn undo_tickets(session: &Session, token: &str, _by: &str) -> Result<Map<String, Value>, Error> {
    let entry = undo().remove(token);
    let Some((ids, _by)) = entry else {
        return Err(DocsAiError::new("not_found", "Nothing to undo: that creation is too old.").into());
    };
    let mut removed = Vec::new();
    for tid in ids {
        if tickets::delete_ticket(session, &tid).await? {
            removed.push(json!(tid));
        }
    }
    let mut out = Map::new();
    out.insert("removed".into(), Value::Array(removed));
    out.insert("restored_text".into(), json!(false));
    Ok(out)
}
