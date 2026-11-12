//! Work around a Docs page (#268): the tickets tied to it, what the AIs on them are doing, and giving a page to an AI
//! (`services/docs_work.py`).
//!
//! A page is tied to a ticket in three ways: the page names it (KAN-12), a person linked them by hand, or the ticket
//! mentions the page ([[Page]]). `work_on_page` lists those tickets with their state and, for each, the AI run that is
//! working on it now (or the last one) with what it is doing in one sentence, so a person reading the page sees
//! "Reviewer is reviewing this page: Read the ticket" without opening the ticket.
//!
//! Giving a page to an AI member to write or review is a ticket, as every piece of AI work on the board is: the ticket
//! names the page, is linked to it, is assigned to the member and starts its work run. The run reads the page through
//! MCP (the guide says how to edit a part of it safely) and reports on the ticket; its progress shows on the page.

use std::collections::HashMap;

use kb_db::Session;
use kb_db::entities::{ai_run, ai_run_step, docs_link, member, ticket};
use kb_db::sea_orm::{ColumnTrait, EntityTrait, QueryFilter, QueryOrder, QuerySelect};
use serde_json::{Map, Value, json};

use crate::docs::{get_page, link_ticket_doc, ticket_backlinks};
use crate::{Error, Result, hooks};

/// The states of a run that is still going.
pub const LIVE: [&str; 4] = ["queued", "starting", "running", "needs_input"];

/// `KINDS`: the title template and the verb of each kind of assignment.
fn kind_words(kind: &str) -> Option<(&'static str, &'static str)> {
    match kind {
        "write" => Some(("Write the page “{title}”", "Write")),
        "review" => Some(("Review the page “{title}”", "Review")),
        _ => None,
    }
}

/// The run's latest step, as its title ("Edited api/export.py", "Asked reviewer: ...").
async fn doing(session: &Session, run: &ai_run::Model) -> Result<Option<String>> {
    let step = ai_run_step::Entity::find()
        .filter(ai_run_step::Column::RunId.eq(run.id.as_str()))
        .filter(ai_run_step::Column::Kind.ne("hook"))
        .order_by_desc(ai_run_step::Column::Seq)
        .limit(1)
        .one(session)
        .await?;
    Ok(step.map(|s| s.title).filter(|t| !t.is_empty()))
}

async fn ticket_ids(session: &Session, page_id: &str) -> Result<Vec<String>> {
    let page = get_page(session, page_id, false, false).await?;
    // only the tickets: the pages half of the backlinks reads and parses every page that links here
    let mut ids: Vec<String> = ticket_backlinks(session, &page)
        .await?
        .iter()
        .filter_map(|t| t["ticket_id"].as_str().map(str::to_string))
        .collect();
    let out = docs_link::Entity::find()
        .filter(docs_link::Column::SourcePageId.eq(page.id.as_str()))
        .filter(docs_link::Column::TargetTicketId.is_not_null())
        .all(session)
        .await?;
    ids.extend(out.into_iter().filter_map(|l| l.target_ticket_id).filter(|k| !k.is_empty()));
    let mut unique: Vec<String> = Vec::new();
    for id in ids {
        if !unique.contains(&id) {
            unique.push(id);
        }
    }
    Ok(unique)
}

async fn member_name(session: &Session, names: &mut HashMap<String, String>, id: &str) -> Result<String> {
    if !names.contains_key(id) {
        let m = member::Entity::find_by_id(id).one(session).await?;
        names.insert(id.to_string(), m.map(|m| m.name).unwrap_or_default());
    }
    Ok(names[id].clone())
}

/// The tickets tied to a page and the AI work on them: `{tickets: [{id, title, status, assignee, run}], active}`.
///
/// `run` is the live run on the ticket (or the latest one): `{id, member, mode, state, doing, started_at, ended_at}`.
/// `active` counts the live runs.
pub async fn work_on_page(session: &Session, page_id: &str) -> Result<Map<String, Value>> {
    let ids = ticket_ids(session, page_id).await?;
    let mut tickets: Vec<Value> = Vec::new();
    let mut active = 0;
    let mut names: HashMap<String, String> = HashMap::new();
    for key in ids.iter().take(40) {
        let Some(t) = ticket::Entity::find_by_id(key.as_str()).one(session).await? else { continue };
        let runs = ai_run::Entity::find()
            .filter(ai_run::Column::TicketId.eq(t.id.as_str()))
            .order_by_desc(ai_run::Column::QueuedAt)
            .limit(5)
            .all(session)
            .await?;
        let live = runs.iter().find(|r| LIVE.contains(&r.state.as_str()));
        let run = live.or(runs.first());
        let mut row = Map::new();
        row.insert("id".into(), json!(t.id));
        row.insert("title".into(), json!(t.title));
        row.insert("status".into(), json!(t.status));
        row.insert("assignee".into(), Value::Null);
        row.insert("run".into(), Value::Null);
        if let Some(assignee) = t.assignee.as_deref().filter(|a| !a.is_empty()) {
            let name = member_name(session, &mut names, assignee).await?;
            row.insert("assignee".into(), if name.is_empty() { Value::Null } else { json!(name) });
        }
        if let Some(run) = run {
            let member = member_name(session, &mut names, &run.member_id).await?;
            row.insert(
                "run".into(),
                json!({
                    "id": run.id,
                    "member_id": run.member_id,
                    "member": member,
                    "mode": run.mode,
                    "state": run.state,
                    "doing": doing(session, run).await?,
                    "started_at": run.started_at.clone().filter(|s| !s.is_empty()).unwrap_or_else(|| run.queued_at.clone()),
                    "ended_at": run.ended_at,
                }),
            );
            if live.is_some() {
                active += 1;
            }
        }
        tickets.push(Value::Object(row));
    }
    // live work first, then the rest as they were found
    let is_live = |r: &Value| r["run"]["state"].as_str().is_some_and(|s| LIVE.contains(&s));
    tickets.sort_by_key(|r| if is_live(r) { 0 } else { 1 });
    let mut out = Map::new();
    out.insert("tickets".into(), Value::Array(tickets));
    out.insert("active".into(), json!(active));
    Ok(out)
}

/// Title and description of the ticket that gives a page to an AI member. Fails with a `ValueError` text for a kind
/// that is neither `write` nor `review`.
pub fn assignment_ticket(
    kind: &str,
    title: &str,
    instruction: Option<&str>,
) -> std::result::Result<(String, String), String> {
    let Some((name, verb)) = kind_words(kind) else { return Err("kind: write or review.".to_string()) };
    let ask = kb_base::pytext::strip(instruction.unwrap_or(""));
    let steps = if kind == "write" {
        "Write the page on Docs (docs_read(action='docs_guide') says how): read what it links first, keep what a \
         person already wrote, change it part by part with docs_write(action='edit'), link the tickets and pages \
         it is about, and say on this ticket what you wrote and what is still open."
    } else {
        "Review the page on Docs (docs_read(action='docs_guide') says how): read it and what it links, comment on \
         the passages that are wrong, unclear or missing with docs_write(action='comment', quote=...), one point \
         per comment, and sum up on this ticket: what must change and what is fine. Do not rewrite the page."
    };
    let mut body = format!("{verb} [[{title}]].\n\n");
    if !ask.is_empty() {
        body.push_str("What is asked:\n\n> ");
        body.push_str(&kb_base::pytext::splitlines(ask).join("\n> "));
        body.push_str("\n\n");
    }
    body.push_str(steps);
    let heading: String = name.replace("{title}", title).chars().take(200).collect();
    Ok((heading, body))
}

/// A person (or an agent, through docs_write(assign)) gives a page to an AI team: a ticket linked to the page,
/// assigned to the team, whose lead starts on it (AI v2).
///
/// Fails with a `ValueError` (`Error::Value`) when the member is not an AI team of the project or the kind is wrong.
pub async fn assign_page(
    session: &Session,
    page_id: &str,
    member_id: &str,
    kind: &str,
    instruction: Option<&str>,
    created_by: Option<&str>,
) -> Result<Map<String, Value>> {
    let page = get_page(session, page_id, false, false).await?;
    let m = member::Entity::find_by_id(member_id).one(session).await?;
    let Some(m) = m.filter(|m| m.kind == "ai" && m.project_id == page.project_id) else {
        return Err(Error::Value("Pick an AI team of this project.".to_string()));
    };
    let (title, description) = assignment_ticket(kind, &page.title, instruction).map_err(Error::Value)?;
    let Some(hook) = hooks::assign() else {
        return Err(Error::Other("tickets are not available".to_string()));
    };
    let ticket =
        hook.create_ticket(session, &page.project_id, &title, &description, created_by).await.map_err(Error::Value)?;
    link_ticket_doc(session, &ticket.id, &page.id).await?;
    hook.assign(session, &ticket.id, member_id).await.map_err(Error::Value)?;
    let run = hook
        .wake_new_assignee(&ticket.id, member_id, created_by, kb_base::pytext::strip(instruction.unwrap_or("")))
        .await;
    let mut out = Map::new();
    out.insert("ticket".into(), json!({"id": ticket.id, "title": ticket.title}));
    out.insert("run".into(), run.as_ref().map(|r| json!({"id": r.id, "state": r.state})).unwrap_or(Value::Null));
    if run.is_none() {
        out.insert(
            "note".into(),
            json!(format!(
                "{} is assigned to {}, but nothing started: the team is paused or at its limits.",
                ticket.id, m.name
            )),
        );
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_assignment_ticket_names_the_page_and_quotes_the_ask() {
        let (title, body) = assignment_ticket("review", "API", Some("  check\nthe limits ")).expect("kind");
        assert_eq!(title, "Review the page “API”");
        assert!(
            body.starts_with("Review [[API]].\n\nWhat is asked:\n\n> check\n> the limits\n\nReview the page on Docs")
        );
        assert_eq!(assignment_ticket("x", "API", None).unwrap_err(), "kind: write or review.");
        let long = "t".repeat(300);
        assert_eq!(assignment_ticket("write", &long, None).expect("kind").0.chars().count(), 200);
    }
}
