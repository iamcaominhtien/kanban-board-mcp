//! `services/tickets.py`, lines 2494-2862: reopening a closed ticket and undoing it, and the Pending flag (a ticket
//! that waits for another ticket, a person or an outside party) with Resume.

use chrono::Utc;
use kb_base::time::{self, Parsed};
use kb_base::{pyjson::truthy, pytext};
use kb_db::Session;
use kb_db::entities::{member, ticket};
use kb_db::sea_orm::EntityTrait;
use serde_json::{Value, json};

use super::update::sync_idea;
use super::{Error, clear_pending_flags, commit, dumps, field, loads, put, save, value_error};

pub const MAX_REASON_LEN: usize = 240;

/// When the ticket last moved into its current closed status (from the activity log).
fn completed_at(ticket: &ticket::Model) -> Result<Value, Error> {
    for e in loads(&ticket.activity_log)?.iter().rev() {
        if e.is_object() && field(e, "field").as_str() == Some("status") && *field(e, "to") == json!(ticket.status) {
            return Ok(field(e, "at").clone());
        }
    }
    Ok(Value::Null)
}

/// Strip `value`; empty becomes None; refuse text longer than MAX_REASON_LEN.
fn clean_reason(value: Option<&str>, label: &str) -> Result<Option<String>, Error> {
    let text = value.map(pytext::strip).filter(|text| !text.is_empty());
    if text.is_some_and(|text| text.chars().count() > MAX_REASON_LEN) {
        return value_error(format!("{label} must be at most {MAX_REASON_LEN} characters"));
    }
    Ok(text.map(str::to_string))
}

/// `actor or "user"`.
fn actor_or_user(actor: Option<&str>) -> &str {
    actor.filter(|actor| !actor.is_empty()).unwrap_or("user")
}

/// The arguments of `reopen_ticket` after the session and the ticket, with the Python defaults.
#[derive(Debug, Clone, Default)]
pub struct ReopenOptions<'a> {
    /// Why it is reopened (at most `MAX_REASON_LEN` characters).
    pub reason: Option<&'a str>,
    /// Untick every acceptance criterion.
    pub reset_ac: bool,
    /// Set every test case back to pending.
    pub reset_tests: bool,
    /// Clear the assignee.
    pub unassign: bool,
    /// Also reopen the parent when it is closed.
    pub reopen_parent: bool,
    /// Who reopens it.
    pub actor: Option<&'a str>,
}

/// Reopen a ticket that was Done or Won't Do, moving it to To Do.
pub async fn reopen_ticket(
    session: &Session,
    ticket_id: &str,
    options: ReopenOptions<'_>,
) -> Result<Option<ticket::Model>, Error> {
    let Some(stored) = ticket::Entity::find_by_id(ticket_id).one(session).await? else {
        return Ok(None);
    };
    let mut ticket = stored.clone();
    let actor = options.actor;

    if !matches!(ticket.status.as_str(), "done" | "wont_do") {
        return value_error("Only tickets in Done or Won't Do can be reopened");
    }

    let clean_reason = clean_reason(options.reason, "reason")?;
    let now_iso = time::now_iso();
    let prev_status = ticket.status.clone();
    let prev_completed_at = completed_at(&ticket)?;

    ticket.status = "todo".to_string();
    ticket.wont_do_reason = None;
    // the idea's queries see the ticket as it now is (SQLAlchemy flushes it before each of them)
    let stored = save(session, &stored, ticket).await?;
    let mut ticket = stored.clone();
    sync_idea(session, &ticket, &prev_status).await?;

    let mut side_effects: Vec<&str> = Vec::new();
    let mut ac_reset_count = 0;
    let mut tests_reset_count = 0;
    if options.unassign {
        ticket.assignee = None;
        side_effects.push("unassigned");
    }

    if options.reset_ac {
        let mut acs = loads(&ticket.acceptance_criteria)?;
        if !acs.is_empty() {
            for ac in acs.iter_mut().filter(|ac| ac.is_object()) {
                ac_reset_count += i64::from(truthy(field(ac, "done")));
                put(ac, "done", json!(false));
            }
            ticket.acceptance_criteria = dumps(&acs);
            side_effects.push("ac_reset");
        }
    }

    if options.reset_tests {
        let mut tcs = loads(&ticket.test_cases)?;
        if !tcs.is_empty() {
            for tc in tcs.iter_mut().filter(|tc| tc.is_object()) {
                tests_reset_count += i64::from(field(tc, "status").as_str() != Some("pending"));
                put(tc, "status", json!("pending"));
            }
            ticket.test_cases = dumps(&tcs);
            side_effects.push("tests_reset");
        }
    }

    ticket.reopen_count += 1;
    ticket.last_reopened_at = Some(now_iso.clone());
    ticket.last_reopened_by = actor.map(str::to_string);
    ticket.last_reopen_reason = clean_reason;

    // History list (newest first)
    let mut history = loads(&ticket.reopen_history)?;
    let history_entry = json!({
        "id": time::uuid4(),
        "reopen_count": ticket.reopen_count,
        "actor": actor,
        "reason": ticket.last_reopen_reason,
        "from_status": prev_status,
        "previous_completed_at": prev_completed_at,
        "at": now_iso,
        "side_effects": side_effects,
    });
    history.insert(0, history_entry);
    ticket.reopen_history = dumps(&history);

    // Activity log entry
    let mut activity = loads(&ticket.activity_log)?;
    activity.push(json!({
        "field": "reopen",
        "from": prev_status,
        "to": "todo",
        "actor": actor_or_user(actor),
        "reason": ticket.last_reopen_reason,
        "reopen_count": ticket.reopen_count,
        "previous_completed_at": prev_completed_at,
        "side_effects": side_effects,
        "ac_reset_count": ac_reset_count,
        "tests_reset_count": tests_reset_count,
        "kept_assignee": if options.unassign { None } else { ticket.assignee.clone() },
        "at": now_iso,
    }));
    ticket.activity_log = dumps(&activity);
    ticket.updated_at = now_iso.clone();

    let ticket = save(session, &stored, ticket).await?;

    // Reopen parent if requested
    if let Some(parent_id) = ticket.parent_id.as_deref().filter(|id| options.reopen_parent && !id.is_empty()) {
        let parent_stored = ticket::Entity::find_by_id(parent_id).one(session).await?;
        if let Some(parent_stored) = parent_stored.filter(|p| matches!(p.status.as_str(), "done" | "wont_do")) {
            let mut parent = parent_stored.clone();
            let parent_prev = parent.status.clone();
            let parent_completed_at = completed_at(&parent)?;
            parent.status = "todo".to_string();
            parent.wont_do_reason = None;
            parent.reopen_count += 1;
            parent.last_reopened_at = Some(now_iso.clone());
            parent.last_reopened_by = actor.map(str::to_string);
            parent.last_reopen_reason = Some(format!("Reopened by child {}", ticket.id));
            let mut parent_hist = loads(&parent.reopen_history)?;
            parent_hist.insert(
                0,
                json!({
                    "id": time::uuid4(),
                    "reopen_count": parent.reopen_count,
                    "actor": actor,
                    "reason": parent.last_reopen_reason,
                    "from_status": parent_prev,
                    "previous_completed_at": parent_completed_at,
                    "at": now_iso,
                    "side_effects": ["child_reopened"],
                }),
            );
            parent.reopen_history = dumps(&parent_hist);
            let mut parent_act = loads(&parent.activity_log)?;
            parent_act.push(json!({
                "field": "reopen",
                "from": parent_prev,
                "to": "todo",
                "actor": actor_or_user(actor),
                "reason": parent.last_reopen_reason,
                "reopen_count": parent.reopen_count,
                "at": now_iso,
            }));
            parent.activity_log = dumps(&parent_act);
            parent.updated_at = now_iso.clone();
            save(session, &parent_stored, parent).await?;
        }
    }

    session.commit().await?;
    Ok(Some(ticket))
}

/// The arguments of `set_pending` after the session and the ticket, with the Python defaults.
#[derive(Debug, Clone)]
pub struct PendingReason<'a> {
    /// What the ticket waits for: "ticket", "person" or "party".
    pub reason_type: &'a str,
    /// The ticket it waits for (`ticket_target_id` in Python).
    pub ticket_target_id: Option<&'a str>,
    /// The member it waits for.
    pub member_id: Option<&'a str>,
    /// The outside party it waits for.
    pub party: Option<&'a str>,
    /// A note shown with the flag.
    pub note: Option<&'a str>,
    /// Also record the ticket it waits for as one that blocks it.
    pub add_blocked_by: bool,
    /// Who sets the flag.
    pub actor: Option<&'a str>,
}

impl<'a> PendingReason<'a> {
    /// A reason of this type with nothing else set.
    pub fn new(reason_type: &'a str) -> Self {
        Self {
            reason_type,
            ticket_target_id: None,
            member_id: None,
            party: None,
            note: None,
            add_blocked_by: false,
            actor: None,
        }
    }
}

/// Flag a ticket as Pending.
pub async fn set_pending(
    session: &Session,
    ticket_id: &str,
    reason: PendingReason<'_>,
) -> Result<Option<ticket::Model>, Error> {
    let Some(stored) = ticket::Entity::find_by_id(ticket_id).one(session).await? else {
        return Ok(None);
    };
    let mut ticket = stored.clone();
    let PendingReason { reason_type, ticket_target_id, member_id, party, note, add_blocked_by, actor } = reason;

    if matches!(ticket.status.as_str(), "done" | "wont_do") {
        return value_error("Done or Won't Do tickets cannot be marked as pending");
    }

    if !matches!(reason_type, "ticket" | "person" | "party") {
        return value_error(format!("Invalid reason_type '{reason_type}'"));
    }

    let clean_note = clean_reason(note, "note")?;
    let clean_party = clean_reason(party, "party")?;
    let mut target: Option<ticket::Model> = None;
    if reason_type == "ticket" {
        let Some(ticket_target_id) = ticket_target_id.filter(|id| !id.is_empty()) else {
            return value_error("ticket_id is required when reason_type is 'ticket'");
        };
        if ticket_target_id == ticket.id {
            return value_error("A ticket cannot be pending on itself");
        }
        let Some(found) = ticket::Entity::find_by_id(ticket_target_id).one(session).await? else {
            return value_error(format!("Ticket '{ticket_target_id}' not found"));
        };
        if add_blocked_by && found.project_id != ticket.project_id {
            return value_error("Blocked by relations need tickets of the same project");
        }
        target = Some(found);
    } else if reason_type == "person" {
        let Some(member_id) = member_id.filter(|id| !id.is_empty()) else {
            return value_error("member_id is required when reason_type is 'person'");
        };
        if member::Entity::find_by_id(member_id).one(session).await?.is_none() {
            return value_error(format!("Member '{member_id}' not found"));
        }
    } else if clean_party.is_none() {
        return value_error("party is required when reason_type is 'party'");
    }

    let now_iso = time::now_iso();
    let was_pending = ticket.pending;
    if !was_pending {
        ticket.pending_since = Some(now_iso.clone());
    }

    ticket.pending = true;
    ticket.pending_reason_type = Some(reason_type.to_string());
    ticket.pending_ticket_id = ticket_target_id.filter(|_| reason_type == "ticket").map(str::to_string);
    ticket.pending_member_id = member_id.filter(|_| reason_type == "person").map(str::to_string);
    ticket.pending_party = clean_party.filter(|_| reason_type == "party");
    ticket.pending_note = clean_note;
    ticket.pending_by = actor.map(str::to_string);

    // If waiting on a ticket and add_blocked_by is true:
    let added_blocked_by = target.is_some() && add_blocked_by;
    if let Some(target_stored) = target.as_ref().filter(|_| add_blocked_by) {
        let mut blocked_by = loads(&ticket.blocked_by)?;
        if !blocked_by.contains(&json!(ticket_target_id)) {
            blocked_by.push(json!(ticket_target_id));
            ticket.blocked_by = dumps(&blocked_by);
        }
        let mut blocks = loads(&target_stored.blocks)?;
        if !blocks.contains(&json!(ticket.id)) {
            blocks.push(json!(ticket.id));
            let mut target = target_stored.clone();
            target.blocks = dumps(&blocks);
            save(session, target_stored, target).await?;
        }
    }

    // Activity log
    let mut activity = loads(&ticket.activity_log)?;
    activity.push(json!({
        "field": "pending_set",
        "changed": was_pending,
        "added_blocked_by": added_blocked_by,
        "actor": actor_or_user(actor),
        "reason_type": reason_type,
        "target_id": ticket_target_id,
        "member_id": member_id,
        "party": ticket.pending_party,
        "note": ticket.pending_note,
        "at": now_iso,
    }));
    ticket.activity_log = dumps(&activity);
    ticket.updated_at = now_iso;

    Ok(Some(commit(session, &stored, ticket).await?))
}

/// Clear the Pending flag on a ticket (Resume).
pub async fn clear_pending(
    session: &Session,
    ticket_id: &str,
    reason: Option<&str>,
    add_comment: bool,
    actor: Option<&str>,
) -> Result<Option<ticket::Model>, Error> {
    let Some(stored) = ticket::Entity::find_by_id(ticket_id).one(session).await? else {
        return Ok(None);
    };
    let mut ticket = stored.clone();

    if !ticket.pending {
        return Ok(Some(ticket));
    }

    let now_iso = time::now_iso();
    let clean_reason = clean_reason(reason, "reason")?;

    // If add_comment is set:
    if let Some(clean_reason) = clean_reason.as_deref().filter(|_| add_comment) {
        let mut comments = loads(&ticket.comments)?;
        let comment_entry = json!({
            "id": time::uuid4(),
            "text": format!("Resumed from Pending: {clean_reason}"),
            "author": actor_or_user(actor),
            "at": now_iso,
        });
        comments.push(comment_entry);
        ticket.comments = dumps(&comments);
    }

    let waited_on = json!({
        "reason_type": ticket.pending_reason_type,
        "target_id": ticket.pending_ticket_id,
        "member_id": ticket.pending_member_id,
        "party": ticket.pending_party,
    });
    let mut duration_days = 0;
    if let Some(pending_since) = ticket.pending_since.as_deref().filter(|since| !since.is_empty()) {
        match time::parse_iso(pending_since) {
            Some(Parsed::Aware(since)) => duration_days = (Utc::now() - since.with_timezone(&Utc)).num_days().max(0),
            // `datetime.now(UTC) - since` with a time that has no offset is a `TypeError`, which nothing catches
            Some(Parsed::Naive(_)) => {
                let message = "can't subtract offset-naive and offset-aware datetimes";
                return Err(Error::Other(message.to_string()));
            }
            None => {}
        }
    }

    clear_pending_flags(&mut ticket);

    let mut activity = loads(&ticket.activity_log)?;
    activity.push(json!({
        "field": "pending_cleared",
        "actor": actor_or_user(actor),
        "reason": clean_reason,
        "duration_days": duration_days,
        "was_waiting_on": waited_on,
        "at": now_iso,
    }));
    ticket.activity_log = dumps(&activity);
    ticket.updated_at = now_iso;

    Ok(Some(commit(session, &stored, ticket).await?))
}

/// Revert the latest reopen: back to the status it came from, count and history rolled back.
pub async fn undo_reopen(session: &Session, ticket_id: &str) -> Result<Option<ticket::Model>, Error> {
    let Some(stored) = ticket::Entity::find_by_id(ticket_id).one(session).await? else {
        return Ok(None);
    };
    let mut ticket = stored.clone();
    let mut history = loads(&ticket.reopen_history)?;
    if history.is_empty() || ticket.status != "todo" {
        return value_error("There is no reopen to undo");
    }

    let latest = history.remove(0);
    ticket.status = match field(&latest, "from_status") {
        Value::String(status) if !status.is_empty() => status.clone(),
        _ => "done".to_string(),
    };
    // the idea's queries see the ticket as it now is (SQLAlchemy flushes it before each of them)
    let stored = save(session, &stored, ticket).await?;
    let mut ticket = stored.clone();
    sync_idea(session, &ticket, "todo").await?;
    // `max((ticket.reopen_count or 1) - 1, 0)`
    let count = if ticket.reopen_count == 0 { 1 } else { ticket.reopen_count };
    ticket.reopen_count = (count - 1).max(0);
    let previous = history.first();
    let text = |key: &str| previous.and_then(|p| field(p, key).as_str()).map(str::to_string);
    ticket.last_reopened_at = text("at");
    ticket.last_reopened_by = text("actor");
    ticket.last_reopen_reason = text("reason");
    ticket.reopen_history = dumps(&history);

    let mut activity = loads(&ticket.activity_log)?;
    let reopened = activity.iter().rposition(|e| {
        e.is_object() && field(e, "field").as_str() == Some("reopen") && field(e, "at") == field(&latest, "at")
    });
    if let Some(i) = reopened {
        activity.remove(i);
    }
    ticket.activity_log = dumps(&activity);
    ticket.updated_at = time::now_iso();

    Ok(Some(commit(session, &stored, ticket).await?))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tickets::blank_ticket;

    #[test]
    fn a_reason_is_stripped_and_limited() {
        assert_eq!(clean_reason(Some("  why  "), "reason").expect("clean"), Some("why".to_string()));
        assert_eq!(clean_reason(Some(" \n"), "note").expect("clean"), None);
        assert_eq!(clean_reason(None, "note").expect("clean"), None);
        assert!(clean_reason(Some(&"ă".repeat(240)), "party").is_ok());
        match clean_reason(Some(&"x".repeat(241)), "party") {
            Err(Error::Value(message)) => assert_eq!(message, "party must be at most 240 characters"),
            other => panic!("expected a ValueError, got {other:?}"),
        }
    }

    #[test]
    fn a_closed_ticket_was_completed_at_its_last_move_into_that_status() {
        let mut ticket = blank_ticket("T-1");
        ticket.status = "done".into();
        ticket.activity_log = json!([
            {"field": "status", "to": "done", "at": "first"},
            {"field": "status", "to": "todo", "at": "between"},
            {"field": "status", "to": "done", "at": "last"},
            {"field": "title", "to": "done", "at": "not a move"},
            "not an entry",
        ])
        .to_string();
        assert_eq!(completed_at(&ticket).expect("log"), json!("last"));
        ticket.status = "wont_do".into();
        assert_eq!(completed_at(&ticket).expect("log"), Value::Null);
    }
}
