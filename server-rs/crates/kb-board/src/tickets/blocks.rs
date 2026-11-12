//! `services/tickets.py`, lines 1704-1808: one ticket blocks another. Both rows carry the relation (`blocks` on the
//! blocker, `blocked_by` on the blocked ticket) and both logs record it.

use kb_base::{activity as act, time};
use kb_db::Session;
use kb_db::entities::ticket;
use kb_db::sea_orm::EntityTrait;
use serde_json::{Value, json};

use super::{Error, dumps, loads, save, value_error};

/// True if `start` blocks `target_id`, directly or through a chain of blocks.
async fn blocks_transitively(session: &Session, start: &ticket::Model, target_id: &str) -> Result<bool, Error> {
    let mut seen: Vec<Value> = vec![json!(start.id)];
    let mut stack = loads(&start.blocks)?;
    while let Some(current_id) = stack.pop() {
        if current_id.as_str() == Some(target_id) {
            return Ok(true);
        }
        if seen.contains(&current_id) {
            continue;
        }
        let current = match current_id.as_str() {
            Some(id) => ticket::Entity::find_by_id(id).one(session).await?,
            None => None,
        };
        seen.push(current_id);
        if let Some(current) = current {
            stack.extend(loads(&current.blocks)?);
        }
    }
    Ok(false)
}

/// Make `blocker_id` block `blocked_id` and update both tickets.
///
/// Returns `(blocker, blocked)`, or None if either ticket does not exist. Fails with `ValueError` if a ticket would
/// block itself, the tickets are in different projects, or the link would create a cycle.
pub async fn link_block(
    session: &Session,
    blocker_id: &str,
    blocked_id: &str,
) -> Result<Option<(ticket::Model, ticket::Model)>, Error> {
    if blocker_id == blocked_id {
        return value_error("A ticket cannot block itself");
    }
    let blocker_stored = ticket::Entity::find_by_id(blocker_id).one(session).await?;
    let blocked_stored = ticket::Entity::find_by_id(blocked_id).one(session).await?;
    let (Some(blocker_stored), Some(blocked_stored)) = (blocker_stored, blocked_stored) else {
        return Ok(None);
    };
    if blocker_stored.project_id != blocked_stored.project_id {
        return value_error("Tickets must belong to the same project");
    }
    if blocks_transitively(session, &blocked_stored, blocker_id).await? {
        return value_error(format!(
            "{blocked_id} already blocks {blocker_id}: this would create a circular dependency"
        ));
    }
    let (mut blocker, mut blocked) = (blocker_stored.clone(), blocked_stored.clone());

    let mut blocker_blocks = loads(&blocker.blocks)?;
    if !blocker_blocks.contains(&json!(blocked_id)) {
        blocker_blocks.push(json!(blocked_id));
        act::record(&mut blocker.activity_log, "blocks", Value::Null, json!(blocked_id), None, None);
        act::record(&mut blocked.activity_log, "blocked_by", Value::Null, json!(blocker_id), None, None);
    }
    blocker.blocks = dumps(&blocker_blocks);
    blocker.updated_at = time::now_iso();

    let mut blocked_by_list = loads(&blocked.blocked_by)?;
    if !blocked_by_list.contains(&json!(blocker_id)) {
        blocked_by_list.push(json!(blocker_id));
    }
    blocked.blocked_by = dumps(&blocked_by_list);
    blocked.updated_at = time::now_iso();

    let blocker = save(session, &blocker_stored, blocker).await?;
    let blocked = save(session, &blocked_stored, blocked).await?;
    session.commit().await?;
    Ok(Some((blocker, blocked)))
}

/// Remove the blocks relation between two tickets.
///
/// Returns `(blocker, blocked)`, or None if either ticket does not exist.
pub async fn unlink_block(
    session: &Session,
    blocker_id: &str,
    blocked_id: &str,
) -> Result<Option<(ticket::Model, ticket::Model)>, Error> {
    let blocker_stored = ticket::Entity::find_by_id(blocker_id).one(session).await?;
    let blocked_stored = ticket::Entity::find_by_id(blocked_id).one(session).await?;
    let (Some(blocker_stored), Some(blocked_stored)) = (blocker_stored, blocked_stored) else {
        return Ok(None);
    };
    // Nothing refuses the same id twice here: Python then holds one object for both, so one row plays both parts
    let same = blocker_id == blocked_id;
    let (mut blocker, mut blocked) = (blocker_stored.clone(), blocked_stored.clone());

    let blocker_blocks = loads(&blocker.blocks)?;
    if blocker_blocks.contains(&json!(blocked_id)) {
        act::record(&mut blocker.activity_log, "blocks", json!(blocked_id), Value::Null, None, None);
        let log = if same { &mut blocker.activity_log } else { &mut blocked.activity_log };
        act::record(log, "blocked_by", json!(blocker_id), Value::Null, None, None);
    }
    blocker.blocks = dumps(&blocker_blocks.into_iter().filter(|x| x.as_str() != Some(blocked_id)).collect::<Vec<_>>());
    blocker.updated_at = time::now_iso();
    if same {
        blocked = blocker.clone();
    }

    let blocked_by_list = loads(&blocked.blocked_by)?;
    blocked.blocked_by =
        dumps(&blocked_by_list.into_iter().filter(|x| x.as_str() != Some(blocker_id)).collect::<Vec<_>>());
    blocked.updated_at = time::now_iso();

    if same {
        let ticket = save(session, &blocked_stored, blocked).await?;
        session.commit().await?;
        return Ok(Some((ticket.clone(), ticket)));
    }
    let blocker = save(session, &blocker_stored, blocker).await?;
    let blocked = save(session, &blocked_stored, blocked).await?;
    session.commit().await?;
    Ok(Some((blocker, blocked)))
}
