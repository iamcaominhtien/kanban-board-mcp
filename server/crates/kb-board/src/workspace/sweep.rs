//! Deleting the workspace folders of closed tickets that have been idle past their retention window, once an hour
//! and on request.

use std::time::Duration;

use kb_base::time;
use kb_db::Session;
use kb_db::entities::{idea_ticket, ticket};
use kb_db::sea_orm::{ColumnTrait, EntityTrait, QueryFilter};
use serde_json::{Value, json};

use super::{CLOSED_STATUSES, Error, Owner, get_workspace_settings, resolve_workspace_path, scan, to_thread};

/// How often `sweep_loop` sweeps.
pub const SWEEP_INTERVAL_SECONDS: u64 = 3600;

/// Delete workspace folders of closed tickets idle past their retention window.
///
/// Only `<root>/<ticket_id>` folders are ever touched. Open tickets and tickets whose effective retention is "forever"
/// are skipped. With `dry_run` nothing is deleted. Returns `{ticket_id, path, bytes}` of every folder removed.
pub async fn sweep_expired(session: &Session, dry_run: bool) -> Result<Vec<Value>, Error> {
    let settings = get_workspace_settings(session).await?;
    if !settings.enabled {
        return Ok(Vec::new());
    }
    let closed: Vec<&str> = CLOSED_STATUSES.to_vec();
    let tickets = ticket::Entity::find().filter(ticket::Column::Status.is_in(closed)).all(session).await?;
    let ideas = idea_ticket::Entity::find().all(session).await?;
    let mut owners: Vec<Owner> = tickets.into_iter().map(Owner::Ticket).collect();
    owners.extend(ideas.into_iter().map(Owner::Idea).filter(Owner::is_closed));
    let mut removed = Vec::new();
    let now = time::epoch();
    for owner in owners {
        let Some(days) = owner.retention_for(&settings) else {
            continue;
        };
        let Ok(folder) = resolve_workspace_path(&settings.root_path, owner.id()).await else {
            continue;
        };
        if !folder.is_dir() {
            continue;
        }
        let found = {
            let folder = folder.clone();
            to_thread(move || scan(&folder)).await
        };
        let Ok(found) = found else {
            continue;
        };
        if now - found.latest < days as f64 * 86400.0 {
            continue;
        }
        if !dry_run {
            let target = folder.clone();
            if let Err(err) = to_thread(move || std::fs::remove_dir_all(target)).await {
                tracing::warn!(target: "services.workspace", "Could not remove workspace {}: {err}", folder.display());
                continue;
            }
        }
        removed.push(json!({
            "ticket_id": owner.id(),
            "path": folder.to_string_lossy(),
            "bytes": found.total_bytes,
        }));
    }
    Ok(removed)
}

/// Periodically delete expired workspaces until the task is cancelled: one sweep now, then one every hour, each on a
/// new session. A sweep that fails is logged and the loop goes on.
pub async fn sweep_loop() {
    loop {
        let session = kb_db::session();
        match sweep_expired(&session, false).await {
            Ok(removed) if !removed.is_empty() => {
                tracing::info!(target: "services.workspace", "Workspace sweep removed {} folder(s)", removed.len());
            }
            Ok(_) => {}
            Err(err) => tracing::error!(target: "services.workspace", "Workspace sweep failed: {err}"),
        }
        drop(session);
        tokio::time::sleep(Duration::from_secs(SWEEP_INTERVAL_SECONDS)).await;
    }
}
