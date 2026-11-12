//! `services/tickets.py`, lines 995-1082: the acceptance criteria of a ticket.

use kb_base::{activity as act, time};
use kb_db::Session;
use kb_db::entities::ticket;
use kb_db::sea_orm::EntityTrait;
use serde_json::{Value, json};

use super::validate::{MAX_AC_TEXT, clean_text};
use super::{Error, commit, dumps, field, loads, put};
use kb_base::pyjson::truthy;

/// Append a acceptance criterion.
///
/// Returns the updated ticket, or None if it does not exist.
pub async fn add_acceptance_criterion(
    session: &Session,
    ticket_id: &str,
    text: &str,
) -> Result<Option<ticket::Model>, Error> {
    let Some(stored) = ticket::Entity::find_by_id(ticket_id).one(session).await? else {
        return Ok(None);
    };
    let mut ticket = stored.clone();
    let text = clean_text(Some(text), "Acceptance criterion", MAX_AC_TEXT)?;
    let mut acs = loads(&ticket.acceptance_criteria)?;
    acs.push(json!({"id": time::uuid4(), "text": text, "done": false}));
    act::record(&mut ticket.activity_log, "acceptance_criterion", Value::Null, json!(text), None, None);
    ticket.acceptance_criteria = dumps(&acs);
    ticket.updated_at = time::now_iso();
    Ok(Some(commit(session, &stored, ticket).await?))
}

/// Flip an acceptance criterion's done state.
///
/// Returns the updated ticket (also when no criterion has this id), or None if the ticket does not exist.
pub async fn toggle_acceptance_criterion(
    session: &Session,
    ticket_id: &str,
    criterion_id: &str,
) -> Result<Option<ticket::Model>, Error> {
    let Some(stored) = ticket::Entity::find_by_id(ticket_id).one(session).await? else {
        return Ok(None);
    };
    let mut ticket = stored.clone();
    let mut acs = loads(&ticket.acceptance_criteria)?;
    for ac in &mut acs {
        if field(ac, "id").as_str() == Some(criterion_id) {
            let done = !truthy(field(ac, "done"));
            put(ac, "done", json!(done));
            let (from, to) = if done { ("open", "done") } else { ("done", "open") };
            act::record(
                &mut ticket.activity_log,
                "acceptance_criterion",
                json!(from),
                json!(to),
                field(ac, "text").as_str(),
                None,
            );
            break;
        }
    }
    ticket.acceptance_criteria = dumps(&acs);
    ticket.updated_at = time::now_iso();
    Ok(Some(commit(session, &stored, ticket).await?))
}

/// Remove an acceptance criterion.
///
/// Returns the updated ticket (also when no criterion has this id), or None if the ticket does not exist.
pub async fn delete_acceptance_criterion(
    session: &Session,
    ticket_id: &str,
    criterion_id: &str,
) -> Result<Option<ticket::Model>, Error> {
    let Some(stored) = ticket::Entity::find_by_id(ticket_id).one(session).await? else {
        return Ok(None);
    };
    let mut ticket = stored.clone();
    let mut acs = loads(&ticket.acceptance_criteria)?;
    if let Some(removed) = acs.iter().find(|a| field(a, "id").as_str() == Some(criterion_id)) {
        let text = field(removed, "text").clone();
        act::record(&mut ticket.activity_log, "acceptance_criterion", text, Value::Null, None, None);
    }
    acs.retain(|a| field(a, "id").as_str() != Some(criterion_id));
    ticket.acceptance_criteria = dumps(&acs);
    ticket.updated_at = time::now_iso();
    Ok(Some(commit(session, &stored, ticket).await?))
}
