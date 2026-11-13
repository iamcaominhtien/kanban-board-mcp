//! `services/tickets.py`, lines 449-753: the partial update of a ticket, with the activity log of what changed and
//! the rules of a move between statuses (Won't Do needs a reason, Done waits for criteria, test cases and blockers,
//! a Story moves with its own state), and what follows a move (pending flags, the tickets that waited for this
//! one, the idea it was promoted from, the hand-over of the code).

use kb_base::{activity as act, pyjson, pytext, time};
use kb_db::Session;
use kb_db::entities::{member, story, ticket};
use kb_db::sea_orm::{ColumnTrait, EntityTrait, QueryFilter};
use serde_json::{Map, Value, json};

use super::schemas::TicketUpdate;
use super::validate::{
    check_date_order, clean_date, clean_estimate, clean_tags, clean_title, doc_ref_entries, validate_parent,
};
use super::{Error, clear_pending_flags, dumps, for_edit, loads, save, value_error};
use crate::ticket_waves::clean_pin;
use crate::{git_repo, hooks};

pub(crate) const AUDITABLE: [&str; 14] = [
    "title",
    "status",
    "priority",
    "type",
    "estimate",
    "due_date",
    "start_date",
    "description",
    "assignee",
    "tags",
    "parent_id",
    "wont_do_reason",
    "repo_path",
    "review_requested_from",
];

/// Log a system prompt on every ticket that is pending on `blocker` (never clears the flag).
pub(crate) async fn prompt_pending_dependents(
    session: &Session,
    blocker: &ticket::Model,
    cause: &str,
    now_iso: &str,
) -> Result<(), Error> {
    let rows = ticket::Entity::find()
        .filter(ticket::Column::Pending.eq(true))
        .filter(ticket::Column::PendingTicketId.eq(blocker.id.as_str()))
        .all(session)
        .await?;
    for dependent in rows {
        let mut activity = loads(&dependent.activity_log)?;
        activity.push(json!({
            "field": "pending_prompt",
            "actor": "system",
            "cause": cause,
            "blocker_id": blocker.id,
            "at": now_iso,
        }));
        let mut changed = dependent.clone();
        changed.activity_log = dumps(&activity);
        save(session, &dependent, changed).await?;
    }
    Ok(())
}

/// `getattr(ticket, field)` for the audited fields, as the JSON value a request carries for it.
fn get_field(ticket: &ticket::Model, field: &str) -> Value {
    match field {
        "title" => json!(ticket.title),
        "status" => json!(ticket.status),
        "priority" => json!(ticket.priority),
        "type" => json!(ticket.r#type),
        "estimate" => json!(ticket.estimate),
        "due_date" => json!(ticket.due_date),
        "start_date" => json!(ticket.start_date),
        "description" => json!(ticket.description),
        "assignee" => json!(ticket.assignee),
        "parent_id" => json!(ticket.parent_id),
        "wont_do_reason" => json!(ticket.wont_do_reason),
        "repo_path" => json!(ticket.repo_path),
        "review_requested_from" => json!(ticket.review_requested_from),
        _ => Value::Null,
    }
}

/// `setattr(ticket, field, value)`. A null in a column that cannot hold one is what the database refuses when
/// Python commits (an `IntegrityError`, a 500); a value of the wrong kind cannot come out of `TicketUpdate`.
fn set_field(ticket: &mut ticket::Model, field: &str, value: &Value) -> Result<(), Error> {
    let not_null = || Error::Other(format!("NOT NULL constraint failed: ticket.{field}"));
    let text = |value: &Value| value.as_str().map(str::to_string);
    let required = |value: &Value| text(value).ok_or_else(not_null);
    let flag = |value: &Value| value.as_bool().ok_or_else(not_null);
    match field {
        "title" => ticket.title = required(value)?,
        "description" => ticket.description = required(value)?,
        "type" => ticket.r#type = required(value)?,
        "status" => ticket.status = required(value)?,
        "priority" => ticket.priority = required(value)?,
        "estimate" => ticket.estimate = value.as_f64().map(Into::into),
        "due_date" => ticket.due_date = text(value),
        "start_date" => ticket.start_date = text(value),
        "parent_id" => ticket.parent_id = text(value),
        "wont_do_reason" => ticket.wont_do_reason = text(value),
        "assignee" => ticket.assignee = text(value),
        "block_done_if_acs_incomplete" => ticket.block_done_if_acs_incomplete = flag(value)?,
        "block_done_if_tcs_incomplete" => ticket.block_done_if_tcs_incomplete = flag(value)?,
        "repo_path" => ticket.repo_path = text(value),
        "wave_pin" => ticket.wave_pin = value.as_i64().and_then(|pin| i32::try_from(pin).ok()),
        "review_requested_from" => ticket.review_requested_from = text(value),
        "pending" => ticket.pending = flag(value)?,
        "pending_reason_type" => ticket.pending_reason_type = text(value),
        "pending_ticket_id" => ticket.pending_ticket_id = text(value),
        "pending_member_id" => ticket.pending_member_id = text(value),
        "pending_party" => ticket.pending_party = text(value),
        "pending_note" => ticket.pending_note = text(value),
        "pending_since" => ticket.pending_since = text(value),
        "pending_by" => ticket.pending_by = text(value),
        other => return Err(Error::Other(format!("ticket has no field {other}"))),
    }
    Ok(())
}

/// `update_data.get(key)` as text (None for a key that is absent, null or not text).
fn text_of<'a>(update_data: &'a Map<String, Value>, key: &str) -> Option<&'a str> {
    update_data.get(key).and_then(Value::as_str)
}

/// Apply a partial update and log the changes; return None if missing.
///
/// `data` holds the fields to change; unset fields are left alone. Fails with `ValueError` if "wont_do" lacks a
/// reason or is set on a child ticket, if Done is blocked by open acceptance criteria or test cases or by a ticket
/// that is not done yet, or if the assignee is not a project member.
pub async fn update_ticket(
    session: &Session,
    ticket_id: &str,
    data: &TicketUpdate,
) -> Result<Option<ticket::Model>, Error> {
    let Some(stored) = for_edit(session, ticket_id).await? else {
        return Ok(None);
    };
    let mut ticket = stored.clone();

    // `data.model_dump(exclude_unset=True)`
    let mut update_data: Map<String, Value> = data.fields.clone();
    let new_status = text_of(&update_data, "status").map(str::to_string);
    let new_status = new_status.as_deref();
    let new_type = text_of(&update_data, "type").map(str::to_string);
    let new_type = new_type.as_deref();

    if ticket.r#type == "story" && new_status.is_some_and(|status| status != ticket.status) {
        if story::Entity::find_by_id(ticket_id).one(session).await?.is_some() {
            return value_error(
                "A Story moves with its own state: hand it to the PM, approve its plan, or pause, drop or reopen it.",
            );
        }
    }
    if new_type == Some("story") && ticket.r#type != "story"
        || (ticket.r#type == "story" && new_type.is_some_and(|t| t != "story"))
    {
        return value_error(
            "Make a ticket a Story with Make this a Story, which hands it to the PM; a Story stays a Story.",
        );
    }

    if let Some(title) = update_data.get("title") {
        let title = clean_title(title.as_str())?;
        update_data.insert("title".into(), json!(title));
    }
    if let Some(estimate) = update_data.get("estimate") {
        let estimate = clean_estimate(estimate.as_f64())?;
        update_data.insert("estimate".into(), json!(estimate));
    }
    if let Some(tags) = update_data.get("tags") {
        let tags = clean_tags(tags.as_array().map(Vec::as_slice))?;
        update_data.insert("tags".into(), json!(tags));
    }
    if let Some(due_date) = update_data.get("due_date") {
        let due_date = clean_date(due_date.as_str(), "Due date")?;
        update_data.insert("due_date".into(), json!(due_date));
    }
    if let Some(start_date) = update_data.get("start_date") {
        let start_date = clean_date(start_date.as_str(), "Start date")?;
        update_data.insert("start_date".into(), json!(start_date));
    }
    if update_data.contains_key("due_date") || update_data.contains_key("start_date") {
        let start = match update_data.get("start_date") {
            Some(start) => start.as_str(),
            None => ticket.start_date.as_deref(),
        };
        let due = match update_data.get("due_date") {
            Some(due) => due.as_str(),
            None => ticket.due_date.as_deref(),
        };
        check_date_order(start, due)?;
    }
    if let Some(parent_id) = text_of(&update_data, "parent_id") {
        validate_parent(session, parent_id, &ticket.project_id, Some(&ticket.id)).await?;
    }
    if let Some(wave_pin) = update_data.get("wave_pin") {
        // TDP-1: a wave pinned by hand, null computes it from Blocked by again
        let pin = clean_pin(wave_pin).map_err(Error::Value)?;
        update_data.insert("wave_pin".into(), json!(pin));
    }

    if new_status == Some("wont_do") && pytext::strip(text_of(&update_data, "wont_do_reason").unwrap_or("")).is_empty()
    {
        return value_error("wont_do_reason is required when status is wont_do");
    }

    if new_status == Some("wont_do") {
        if let Some(parent_id) = &ticket.parent_id {
            let parent = ticket::Entity::find_by_id(parent_id).one(session).await?;
            if parent.is_none_or(|p| p.r#type != "story") {
                // a Story's plan drops a ticket it no longer needs
                return value_error("Child tickets cannot be set to wont_do");
            }
        }
    }

    // When transitioning to "done", enforce block guards
    if new_status == Some("done") {
        let effective = |key: &str, stored: bool| match update_data.get(key) {
            Some(value) => pyjson::truthy(value),
            None => stored,
        };
        let effective_block_acs = effective("block_done_if_acs_incomplete", ticket.block_done_if_acs_incomplete);
        let effective_block_tcs = effective("block_done_if_tcs_incomplete", ticket.block_done_if_tcs_incomplete);
        let mut violations: Vec<String> = Vec::new();
        if effective_block_acs {
            let acs = loads(&ticket.acceptance_criteria)?;
            if acs.is_empty() || acs.iter().any(|ac| !ac.get("done").is_some_and(pyjson::truthy)) {
                violations.push("not all Acceptance Criteria are passed".to_string());
            }
        }
        if effective_block_tcs {
            let tcs = loads(&ticket.test_cases)?;
            if tcs.is_empty() || tcs.iter().any(|tc| tc.get("status").and_then(Value::as_str) != Some("pass")) {
                violations.push("Test Cases are missing or not all passed".to_string());
            }
        }
        if ticket.status != "done" {
            // a ticket another one still blocks is not done: finish the blocker, or remove the block if it no longer holds
            let mut open_blockers: Vec<String> = Vec::new();
            for bid in loads(&ticket.blocked_by)? {
                let Some(bid) = bid.as_str() else { continue };
                let blocker = ticket::Entity::find_by_id(bid).one(session).await?;
                if let Some(b) = blocker.filter(|b| b.status != "done" && b.status != "wont_do") {
                    open_blockers.push(format!("{} ({})", b.id, b.status));
                }
            }
            if !open_blockers.is_empty() {
                let names = open_blockers.join(", ");
                violations.push(format!(
                    "it is blocked by {names}; finish that first, or remove the block if it no longer holds"
                ));
            }
        }
        if !violations.is_empty() {
            return value_error(format!("Cannot move to Done: {}.", violations.join(" and ")));
        }
    }

    // Validate assignee belongs to the ticket's project
    if let Some(assignee) = text_of(&update_data, "assignee") {
        let assignee_member = member::Entity::find_by_id(assignee).one(session).await?;
        if assignee_member.is_none_or(|m| m.project_id != ticket.project_id) {
            return value_error("Assignee must be a member of this project");
        }
    }

    // Whose review it waits for: a member of the ticket's project (a person or an AI member)
    if let Some(reviewer_id) = text_of(&update_data, "review_requested_from").filter(|r| !r.is_empty()) {
        let reviewer = member::Entity::find_by_id(reviewer_id).one(session).await?;
        if reviewer.is_none_or(|m| m.project_id != ticket.project_id) {
            return value_error("The reviewer must be a member of this project");
        }
    }
    // (a move to Review that names no reviewer: AI v2 stage 3 will ask the team's reviewer role; nothing yet)

    // Per-ticket git repo override; empty/null falls back to the project's repo
    if update_data.contains_key("repo_path") {
        let raw_repo = pytext::strip(text_of(&update_data, "repo_path").unwrap_or("")).to_string();
        let repo_path = if raw_repo.is_empty() { None } else { Some(git_repo::normalize_repo_path(&raw_repo).await?) };
        update_data.insert("repo_path".into(), json!(repo_path));
    }

    // Clear wont_do_reason when transitioning away from wont_do
    if update_data.contains_key("status") && new_status != Some("wont_do") {
        update_data.entry("wont_do_reason").or_insert(Value::Null);
    }

    // Clear pending flag when transitioning to done or wont_do
    if matches!(new_status, Some("done" | "wont_do")) && ticket.pending {
        update_data.insert("pending".into(), json!(false));
        for key in [
            "pending_reason_type",
            "pending_ticket_id",
            "pending_member_id",
            "pending_party",
            "pending_note",
            "pending_since",
            "pending_by",
        ] {
            update_data.insert(key.into(), Value::Null);
        }
    }

    let mut activity = loads(&ticket.activity_log)?;
    let previous_status = ticket.status.clone();

    for (field, new_val) in &update_data {
        if field == "tags" {
            let old_tags = loads(&ticket.tags)?;
            let new_tags = new_val.as_array().cloned().unwrap_or_default();
            if old_tags != new_tags {
                let shown = |tags: &[Value]| if tags.is_empty() { Value::Null } else { Value::Array(tags.to_vec()) };
                activity.push(act::entry("tags", shown(&old_tags), shown(&new_tags), None, None, None));
            }
            ticket.tags = dumps(&new_tags);
        } else if AUDITABLE.contains(&field.as_str()) {
            let old_val = get_field(&ticket, field);
            // Clearing the reason on the way out of Won't Do is noise next to the status entry
            let clearing_reason =
                field == "wont_do_reason" && !pyjson::truthy(new_val) && update_data.contains_key("status");
            if old_val != *new_val && !clearing_reason {
                if field == "description" {
                    activity.push(act::entry(field, old_val.clone(), new_val.clone(), None, None, None));
                    activity.extend(doc_ref_entries(old_val.as_str(), new_val.as_str(), field));
                } else {
                    let (from, to) = (act::clip(old_val), act::clip(new_val.clone()));
                    activity.push(act::entry(field, from, to, None, None, None));
                }
            }
            set_field(&mut ticket, field, new_val)?;
        } else {
            set_field(&mut ticket, field, new_val)?;
        }
    }

    ticket.activity_log = dumps(&activity);
    ticket.updated_at = time::now_iso();
    // the queries below see the ticket as it now is (SQLAlchemy flushes it before each of them)
    let ticket = save(session, &stored, ticket).await?;

    if matches!(new_status, Some("done" | "wont_do")) {
        // "Mark done anyway" also clears the flags of the ticket's pending sub-tasks
        let kids = ticket::Entity::find()
            .filter(ticket::Column::ParentId.eq(ticket.id.as_str()))
            .filter(ticket::Column::Pending.eq(true))
            .all(session)
            .await?;
        for kid in kids {
            let mut cleared = kid.clone();
            clear_pending_flags(&mut cleared);
            save(session, &kid, cleared).await?;
        }
    }

    if let Some(status @ ("done" | "wont_do")) = new_status {
        if previous_status != status {
            let cause = if status == "done" { "blocker_done" } else { "blocker_removed" };
            prompt_pending_dependents(session, &ticket, cause, &ticket.updated_at).await?;
        }
    }

    if new_status.is_some_and(|status| !status.is_empty()) {
        sync_idea(session, &ticket, &previous_status).await?;
    }

    session.commit().await?;
    if let Some(status) = new_status.filter(|status| !status.is_empty() && *status != previous_status) {
        // hand the code over: Review pushes and opens the draft PR, Done merges, only when a person moved it (D7)
        if let Some(ai) = hooks::ai_runs() {
            ai.on_status(&ticket.id, status, &previous_status, ai.in_run());
        }
    }
    Ok(Some(ticket))
}

/// Let the idea promoted to this ticket (and any assumption it tests) follow the status change.
pub(crate) async fn sync_idea(session: &Session, ticket: &ticket::Model, previous_status: &str) -> Result<(), Error> {
    if let Some(ideas) = hooks::idea_promote() {
        ideas.on_ticket_status_change(session, ticket, previous_status).await?;
    }
    Ok(())
}
