//! `services/tickets.py`, lines 1814-1966: the other relations between two tickets of a project (relates to,
//! causes, duplicates). A link is stored on both tickets, the inverse relation on the target.

use kb_base::{activity as act, pytext, time};
use kb_db::Session;
use kb_db::entities::ticket;
use kb_db::sea_orm::EntityTrait;
use serde_json::{Value, json};

use super::{Error, dumps, field, loads, save, value_error};

/// The relation types, in the order `sorted(VALID_RELATION_TYPES)` gives (Python keeps a frozenset and sorts it
/// for the message).
pub const VALID_RELATION_TYPES: [&str; 5] = ["caused_by", "causes", "duplicated_by", "duplicates", "relates_to"];

/// `_INVERSE_RELATION.get(relation_type)`.
fn inverse_relation(relation_type: &str) -> Option<&'static str> {
    match relation_type {
        "relates_to" => Some("relates_to"),
        "causes" => Some("caused_by"),
        "caused_by" => Some("causes"),
        "duplicates" => Some("duplicated_by"),
        "duplicated_by" => Some("duplicates"),
        _ => None,
    }
}

fn link_label(relation_type: Option<&str>, ticket_id: Option<&str>) -> String {
    let label = format!("{} {}", relation_type.unwrap_or("").replace('_', " "), ticket_id.unwrap_or(""));
    pytext::strip(&label).to_string()
}

fn update_ticket_links(ticket: &mut ticket::Model, links: &[Value]) {
    ticket.links = dumps(links);
    ticket.updated_at = time::now_iso();
}

/// Link two tickets in the same project and add the inverse link on the target.
///
/// `relation_type` is one of `relates_to`, `causes`, `caused_by`, `duplicates`, `duplicated_by`. Returns the link
/// created, or the existing one if it is a duplicate. Fails with `ValueError` if the tickets are the same, either
/// is missing, they are in different projects, or the relation type is invalid.
pub async fn add_ticket_link(
    session: &Session,
    ticket_id: &str,
    target_id: &str,
    relation_type: &str,
) -> Result<Value, Error> {
    if ticket_id == target_id {
        return value_error("A ticket cannot link to itself");
    }
    let Some(inverse_type) = inverse_relation(relation_type) else {
        let valid: Vec<String> = VALID_RELATION_TYPES.iter().map(|name| pytext::repr(name)).collect();
        return value_error(format!("Invalid relation type '{relation_type}'. Valid types: [{}]", valid.join(", ")));
    };

    let ticket_stored = ticket::Entity::find_by_id(ticket_id).one(session).await?;
    let target_stored = ticket::Entity::find_by_id(target_id).one(session).await?;
    let (Some(ticket_stored), Some(target_stored)) = (ticket_stored, target_stored) else {
        return value_error("One or both tickets not found");
    };

    if ticket_stored.project_id != target_stored.project_id {
        return value_error("Cannot link tickets across different projects.");
    }
    let (mut ticket, mut target) = (ticket_stored.clone(), target_stored.clone());

    let mut ticket_links = loads(&ticket.links)?;
    // Dedup check
    for link in &ticket_links {
        if field(link, "target_id").as_str() == Some(target_id)
            && field(link, "relation_type").as_str() == Some(relation_type)
        {
            return Ok(link.clone());
        }
    }

    let new_link = json!({
        "id": time::uuid4(),
        "target_id": target_id,
        "relation_type": relation_type,
    });
    ticket_links.push(new_link.clone());
    let label = link_label(Some(relation_type), Some(target_id));
    act::record(&mut ticket.activity_log, "link", Value::Null, json!(label), None, None);
    update_ticket_links(&mut ticket, &ticket_links);

    // Inverse link on target ticket
    let mut target_links = loads(&target.links)?;
    let already_has_inverse = target_links.iter().any(|lk| {
        field(lk, "target_id").as_str() == Some(ticket_id) && field(lk, "relation_type").as_str() == Some(inverse_type)
    });
    if !already_has_inverse {
        let label = link_label(Some(inverse_type), Some(ticket_id));
        act::record(&mut target.activity_log, "link", Value::Null, json!(label), None, None);
        target_links.push(json!({
            "id": time::uuid4(),
            "target_id": ticket_id,
            "relation_type": inverse_type,
        }));
        update_ticket_links(&mut target, &target_links);
    }

    save(session, &ticket_stored, ticket).await?;
    save(session, &target_stored, target).await?;
    session.commit().await?;
    Ok(new_link)
}

/// Remove a link from both tickets.
///
/// Returns True if removed, False if the ticket or link was not found.
pub async fn remove_ticket_link(session: &Session, ticket_id: &str, link_id: &str) -> Result<bool, Error> {
    let Some(ticket_stored) = ticket::Entity::find_by_id(ticket_id).one(session).await? else {
        return Ok(false);
    };
    let mut ticket = ticket_stored.clone();

    let ticket_links = loads(&ticket.links)?;
    let Some(link_to_remove) = ticket_links.iter().find(|lk| field(lk, "id").as_str() == Some(link_id)) else {
        return Ok(false);
    };

    let target_id = field(link_to_remove, "target_id").as_str().map(str::to_string);
    let relation_type = field(link_to_remove, "relation_type").as_str().map(str::to_string);

    let links_after: Vec<Value> =
        ticket_links.iter().filter(|lk| field(lk, "id").as_str() != Some(link_id)).cloned().collect();
    let label = link_label(relation_type.as_deref(), target_id.as_deref());
    act::record(&mut ticket.activity_log, "link", json!(label), Value::Null, None, None);
    update_ticket_links(&mut ticket, &links_after);
    // stored before the target is read: a link that points at its own ticket is then read as it now is
    save(session, &ticket_stored, ticket).await?;

    // Remove inverse link from target
    if let Some(target_id) = target_id.as_deref().filter(|id| !id.is_empty()) {
        if let Some(target_stored) = ticket::Entity::find_by_id(target_id).one(session).await? {
            let mut target = target_stored.clone();
            let inverse_type = relation_type.as_deref().and_then(inverse_relation).unwrap_or("");
            let target_links = loads(&target.links)?;
            let target_after: Vec<Value> = target_links
                .iter()
                .filter(|lk| {
                    !(field(lk, "target_id").as_str() == Some(ticket_id)
                        && field(lk, "relation_type").as_str() == Some(inverse_type))
                })
                .cloned()
                .collect();
            if target_after.len() != target_links.len() {
                let label = link_label(Some(inverse_type), Some(ticket_id));
                act::record(&mut target.activity_log, "link", json!(label), Value::Null, None, None);
            }
            update_ticket_links(&mut target, &target_after);
            save(session, &target_stored, target).await?;
        }
    }

    session.commit().await?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_link_reads_as_its_relation_and_the_other_ticket() {
        assert_eq!(link_label(Some("caused_by"), Some("KAN-2")), "caused by KAN-2");
        assert_eq!(link_label(None, Some("KAN-2")), "KAN-2");
        assert_eq!(link_label(Some("relates_to"), None), "relates to");
        for name in VALID_RELATION_TYPES {
            let inverse = inverse_relation(name).expect("a relation has an inverse");
            assert_eq!(inverse_relation(inverse), Some(name));
        }
        let mut sorted = VALID_RELATION_TYPES;
        sorted.sort_unstable();
        assert_eq!(sorted, VALID_RELATION_TYPES);
    }
}
