//! Sending (`services/docs_ai/handoff.py`, lines 628 to 848): the open threads of a ticket's pages, and `send`.

use std::collections::HashSet;

use kb_base::activity;
use kb_board::tickets::{self, TicketUpdate};
use kb_db::Session;
use kb_db::entities::{ai_run, docs_comment_thread, docs_page, ticket};
use kb_db::sea_orm::{ColumnTrait, EntityTrait, QueryFilter, QueryOrder, QuerySelect};
use serde_json::{Map, Value, json};

use super::{MAX_THREADS, TRIGGER, active_by_ticket, build_note, docs_err, members_by_id, page_of, team_of};
use crate::assistant::docs as assistant_docs;
use crate::docs_ai::errors::Error;
use crate::seams::{self, DeliverError};

/// Where a note of threads can go.
pub const DESTINATIONS: [&str; 3] = ["team", "board_ai", "page_assistant"];

/// `_open_threads`: the open threads of the page among `ids`, in the order of `ids`.
async fn open_threads(
    session: &Session,
    page: &docs_page::Model,
    ids: &[String],
) -> Result<Vec<docs_comment_thread::Model>, Error> {
    let rows = docs_comment_thread::Entity::find()
        .filter(docs_comment_thread::Column::Id.is_in(ids.to_vec()))
        .filter(docs_comment_thread::Column::PageId.eq(page.id.as_str()))
        .filter(docs_comment_thread::Column::Status.eq("open"))
        .all(session)
        .await?;
    Ok(ids.iter().filter_map(|id| rows.iter().find(|t| t.id == *id).cloned()).collect())
}

/// The open threads of the pages linked to a ticket (by a mention or by hand), oldest first, at most MAX_THREADS.
pub async fn threads_of_ticket(
    session: &Session,
    ticket_id: &str,
) -> Result<Vec<(docs_page::Model, Vec<docs_comment_thread::Model>)>, Error> {
    let mut out = Vec::new();
    let mut left = MAX_THREADS;
    let mut seen: HashSet<String> = HashSet::new();
    for row in kb_docs::docs::docs_for_ticket(session, ticket_id).await? {
        let pid = row.get("page_id").and_then(Value::as_str).unwrap_or("").to_string();
        if seen.contains(&pid) || left == 0 {
            continue;
        }
        seen.insert(pid.clone());
        let Some(page) = docs_page::Entity::find_by_id(pid.as_str()).one(session).await? else { continue };
        if page.deleted_at.as_deref().is_some_and(|d| !d.is_empty()) {
            continue;
        }
        let rows = docs_comment_thread::Entity::find()
            .filter(docs_comment_thread::Column::PageId.eq(pid.as_str()))
            .filter(docs_comment_thread::Column::Status.eq("open"))
            .order_by_asc(docs_comment_thread::Column::CreatedAt)
            .limit(left as u64)
            .all(session)
            .await?;
        if !rows.is_empty() {
            left -= rows.len();
            out.push((page, rows));
        }
    }
    Ok(out)
}

/// How many open threads the ticket's linked pages have (the Docs tab shows it on the button).
pub async fn open_count_for_ticket(session: &Session, ticket_id: &str) -> Result<usize, Error> {
    Ok(threads_of_ticket(session, ticket_id).await?.iter().map(|(_, ts)| ts.len()).sum())
}

/// The arguments of `send`.
#[derive(Debug, Clone, Default)]
pub struct SendOpts {
    /// The page the threads are on (with `thread_ids`).
    pub page_id: Option<String>,
    /// The threads to send (open ones; at most MAX_THREADS).
    pub thread_ids: Vec<String>,
    /// Instead of a page: the open threads of the pages linked to this ticket, sent to its own team.
    pub from_ticket: Option<String>,
    /// `team` (the team of `ticket_id`), `board_ai` (it routes) or `page_assistant`.
    pub to: String,
    /// For `team`: the ticket whose team gets them.
    pub ticket_id: Option<String>,
    /// For `team` on a ticket with no team: the team to give the ticket to first.
    pub give_team_id: Option<String>,
}

impl SendOpts {
    /// Sending to the team of a ticket (the default of `to`).
    pub fn new() -> Self {
        Self { to: "team".to_string(), ..Default::default() }
    }
}

/// `docs_comments._need_member(role)`: a viewer cannot comment.
fn need_member(role: &str) -> Result<(), Error> {
    if role == "viewer" {
        return Err(docs_err(
            403,
            "read_only",
            "Viewers can read comments but cannot add them. Ask a project member for access.",
        ));
    }
    Ok(())
}

/// Send open threads to an AI.
///
/// Fails with `DocsError`: 422 `no_threads` / `too_many` / `no_ticket` / `no_team` / `bad_destination`; 409
/// `team_asking` (the team waits for an answer: answer it first) and `not_started` (the run could not start).
pub async fn send(session: &Session, opts: SendOpts) -> Result<Map<String, Value>, Error> {
    let SendOpts { page_id, thread_ids, from_ticket, mut to, mut ticket_id, give_team_id } = opts;
    if !DESTINATIONS.contains(&to.as_str()) {
        return Err(docs_err(422, "bad_destination", format!("Send to one of: {}.", DESTINATIONS.join(", "))));
    }
    let by = activity::current_actor();
    let mut ticket: Option<ticket::Model>;
    let mut groups: Vec<(docs_page::Model, Vec<docs_comment_thread::Model>)>;
    if let Some(from) = from_ticket.as_deref().filter(|t| !t.is_empty()) {
        ticket = ticket::Entity::find_by_id(from).one(session).await?;
        if ticket.is_none() {
            return Err(docs_err(404, "not_found", format!("No ticket {from}.")));
        }
        groups = threads_of_ticket(session, from).await?;
        to = "team".to_string();
        ticket_id = Some(from.to_string());
    } else {
        let page = page_of(session, page_id.as_deref().unwrap_or("")).await?;
        // `list(dict.fromkeys(thread_ids or []))`
        let mut ids: Vec<String> = Vec::new();
        for id in thread_ids {
            if !ids.contains(&id) {
                ids.push(id);
            }
        }
        if ids.is_empty() {
            return Err(docs_err(422, "no_threads", "Choose the comments to send."));
        }
        if ids.len() > MAX_THREADS {
            return Err(docs_err(422, "too_many", format!("Send at most {MAX_THREADS} comments at a time.")));
        }
        let open = open_threads(session, &page, &ids).await?;
        groups = vec![(page, open)];
        ticket = None;
    }
    groups.retain(|(_, ts)| !ts.is_empty());
    if groups.is_empty() {
        return Err(docs_err(422, "no_threads", "No open comments to send: they are resolved or not on this page."));
    }
    let project_id = groups[0].0.project_id.clone();
    let members = members_by_id(session, &project_id).await?;
    need_member(&kb_doctext::docs_access::role_in(&members.0, &by))?;
    let chosen: Vec<&docs_comment_thread::Model> = groups.iter().flat_map(|(_, ts)| ts.iter()).collect();

    let mut meta = Map::new();
    meta.insert("kind".into(), json!("sent"));
    let where_;
    let mut result = Map::new();
    result.insert("to".into(), json!(to));
    result.insert("threads".into(), json!(chosen.len()));
    if to == "team" {
        if ticket.is_none() {
            ticket = ticket::Entity::find_by_id(ticket_id.as_deref().unwrap_or("")).one(session).await?;
        }
        let mut ticket = match ticket {
            Some(t) if t.project_id == project_id => t,
            _ => {
                return Err(docs_err(
                    422,
                    "no_ticket",
                    format!(
                        "Choose a ticket of this project ({}).",
                        ticket_id.as_deref().filter(|t| !t.is_empty()).unwrap_or("none")
                    ),
                ));
            }
        };
        let active = active_by_ticket(session, &project_id).await?;
        let mut team = team_of(session, &ticket, &members, &active, true).await?;
        if team.is_none() {
            let Some(give) = give_team_id.as_deref().filter(|g| !g.is_empty()) else {
                return Err(docs_err(
                    422,
                    "no_team",
                    format!("{} has no AI team. Give it one, or pick another ticket.", ticket.id),
                ));
            };
            let Some(given) = members.get(give).filter(|m| m.kind == "ai") else {
                return Err(docs_err(422, "no_team", "Choose an AI team of this project."));
            };
            if let Some(holder_id) = ticket.assignee.as_deref().filter(|a| !a.is_empty()) {
                // a person holds the ticket: giving it a team would take it from them
                let holder = members.get(holder_id);
                return Err(docs_err(
                    422,
                    "assigned_to_person",
                    format!(
                        "{} is assigned to {}, not to an AI team. Pick a ticket with a team, or change its assignee first.",
                        ticket.id,
                        holder.map_or("a person", |h| h.name.as_str())
                    ),
                ));
            }
            tickets::update_ticket(session, &ticket.id, &TicketUpdate::of("assignee", json!(given.id))).await?;
            if let Some(fresh) = ticket::Entity::find_by_id(ticket.id.as_str()).one(session).await? {
                ticket = fresh;
            }
            team = team_of(session, &ticket, &members, &active, true).await?;
            result.insert("gave_team".into(), json!(given.name));
        }
        let Some(team) = team else {
            return Err(docs_err(422, "no_team", format!("{} has no AI team.", ticket.id)));
        };
        if team["state"].as_str() == Some("asking") {
            return Err(docs_err(
                409,
                "team_asking",
                format!(
                    "{} is asking you a question on {}: answer it first, then send the comments.",
                    team["name"].as_str().unwrap_or(""),
                    ticket.id
                ),
            ));
        }
        let note = build_note(session, &groups, &by, Some(&ticket)).await?;
        let delivered = match seams::runs() {
            Some(runs) => runs.deliver_to_ticket_with(&ticket.id, &note, &by, TRIGGER, 0).await,
            None => Err(DeliverError::Other("the runs are not connected".to_string())),
        };
        let out = match delivered {
            Ok(out) => out,
            Err(DeliverError::Run(message)) => {
                if result.get("gave_team").is_some_and(kb_base::pyjson::truthy) {
                    // do not leave the ticket given away when nothing was sent
                    tickets::update_ticket(session, &ticket.id, &TicketUpdate::of("assignee", Value::Null)).await?;
                }
                return Err(docs_err(409, "not_started", message));
            }
            Err(DeliverError::Other(message)) => return Err(Error::Other(message)),
        };
        let run_id =
            out.get("run_id").filter(|r| kb_base::pyjson::truthy(r)).and_then(Value::as_str).map(str::to_string);
        let run = match &run_id {
            Some(id) => ai_run::Entity::find_by_id(id.as_str()).one(session).await?,
            None => None,
        };
        let number = run.map(|r| r.number).filter(|n| *n != 0);
        let how = out.get("delivered").cloned().unwrap_or(Value::Null);
        let how_text = how.as_str().unwrap_or("");
        where_ = format!(
            "Sent to {} · {}{}{}{}",
            ticket.id,
            team["name"].as_str().unwrap_or(""),
            number.map_or(String::new(), |n| format!(" · run #{n}")),
            if how_text == "live" { " (it hears this now)" } else { "" },
            if how_text == "queued" { " (it waits in the queue)" } else { "" },
        );
        meta.insert("ticket_id".into(), json!(ticket.id));
        meta.insert("member_id".into(), team["id"].clone());
        meta.insert("run_id".into(), out.get("run_id").cloned().unwrap_or(Value::Null));
        result.insert("ticket_id".into(), json!(ticket.id));
        result.insert("team".into(), team["name"].clone());
        result.insert("delivered".into(), how);
        result.insert("run_id".into(), out.get("run_id").cloned().unwrap_or(Value::Null));
        result.insert("run_number".into(), json!(number));
    } else if to == "board_ai" {
        let note = build_note(session, &groups, &by, None).await?;
        let job = assistant_docs::start_route_job(session, &groups, &by, &note).await?;
        where_ = "Sent to the Board AI (it finds the ticket's team, or answers)".to_string();
        result.insert("job_id".into(), json!(job.id));
    } else {
        let note = format!("{by} sent this thread to you from the page.");
        let mut started = Vec::new();
        for th in &chosen {
            let job = assistant_docs::start_thread_job(session, &th.id, "thread_reply", &by, &note).await?;
            started.push(json!(job.id));
        }
        where_ = "Sent to the page’s assistant".to_string();
        result.insert("job_ids".into(), Value::Array(started));
    }
    let meta = Value::Object(meta);
    for th in &chosen {
        kb_docs::docs_comments::add_board_note(session, &th.id, &where_, &meta).await?;
    }
    result.insert("note".into(), json!(where_));
    Ok(result)
}
