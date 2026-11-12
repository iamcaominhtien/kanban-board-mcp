//! `services/tickets.py`, lines 756-796: deleting a ticket with its workspace, leaving nothing that points at it.

use kb_base::time;
use kb_db::Session;
use kb_db::entities::ticket;
use kb_db::sea_orm::{ColumnTrait, EntityTrait, ModelTrait, QueryFilter};
use serde_json::Value;

use super::update::prompt_pending_dependents;
use super::{Error, dumps, loads, save};
use crate::hooks;
use crate::workspace::remove_ticket_workspace;

/// Delete a ticket; return False if it does not exist.
pub async fn delete_ticket(session: &Session, ticket_id: &str) -> Result<bool, Error> {
    let Some(ticket) = ticket::Entity::find_by_id(ticket_id).one(session).await? else {
        return Ok(false);
    };
    if let Some(ideas) = hooks::idea_promote() {
        ideas.on_ticket_deleted(session, &ticket).await?;
    }

    // Don't leave dangling references behind: detach children, drop block/link entries
    let now = time::now_iso();
    let children = ticket::Entity::find().filter(ticket::Column::ParentId.eq(ticket_id)).all(session).await?;
    for child in children {
        let mut detached = child.clone();
        detached.parent_id = None;
        detached.updated_at = now.clone();
        save(session, &child, detached).await?;
    }
    prompt_pending_dependents(session, &ticket, "blocker_removed", &now).await?;
    // read after the two steps above, so that each row carries what they wrote (Python holds one object per row)
    let others = ticket::Entity::find()
        .filter(ticket::Column::ProjectId.eq(ticket.project_id.as_str()))
        .filter(ticket::Column::Id.ne(ticket_id))
        .all(session)
        .await?;
    let this = Value::String(ticket_id.to_string());
    for other in others {
        let blocks = loads(&other.blocks)?;
        let blocked_by = loads(&other.blocked_by)?;
        let links = loads(&other.links)?;
        let new_links: Vec<Value> = links.iter().filter(|lk| lk.get("target_id") != Some(&this)).cloned().collect();
        if blocks.contains(&this) || blocked_by.contains(&this) || new_links.len() != links.len() {
            let mut cleaned = other.clone();
            cleaned.blocks = dumps(&blocks.into_iter().filter(|b| *b != this).collect::<Vec<_>>());
            cleaned.blocked_by = dumps(&blocked_by.into_iter().filter(|b| *b != this).collect::<Vec<_>>());
            cleaned.links = dumps(&new_links);
            cleaned.updated_at = now.clone();
            save(session, &other, cleaned).await?;
        }
    }
    ticket.delete(session).await?;
    session.commit().await?;
    remove_ticket_workspace(session, ticket_id).await;
    Ok(true)
}
