//! `services/idea_promote.py`: promote an idea to a ticket, and keep the idea and its ticket in step afterwards.
//!
//! Design: `design/screens/idea-promote-migration.md`. The idea stays where it is, links to the ticket and follows
//! its status; the ticket is an ordinary ticket with a small mark (`from_idea_id`).

use kb_base::{pyjson, pytext, time};
use kb_board::tickets::{NewTicket, create_ticket};
use kb_db::Session;
use kb_db::entities::{idea_assumption, idea_ticket, project, ticket};
use kb_db::sea_orm::{ActiveModelTrait, ActiveValue::Set, ColumnTrait, EntityTrait, IntoActiveModel, QueryFilter};
use kb_doctext::pystr::lstrip;
use serde_json::{Map, Value, json};

use crate::error::{Error, rule_error_with, value_error};
use crate::idea_space::{self as space, IdeaRuleError};
use crate::idea_tickets::{DEFAULT_AUTHOR, add_trail, dumps, safe_json, select_ideas};
use crate::model::{AssumptionRecord, Idea, idea_readiness, save_model};

/// The stages an idea can be promoted from (`PROMOTABLE_STAGES`).
pub const PROMOTABLE_STAGES: [&str; 3] = ["inbox", "exploring", "ready"];
/// How many sub-tickets a split makes at most (`MAX_SUB_TICKETS`).
pub const MAX_SUB_TICKETS: usize = 10;
/// The ticket types a promotion may make (`TICKET_TYPES`).
pub const TICKET_TYPES: [&str; 4] = ["bug", "feature", "task", "chore"];
/// The priorities a promotion may give (`PRIORITIES`).
pub const PRIORITIES: [&str; 4] = ["low", "medium", "high", "critical"];

/// `_tags(idea)`: the tags of an idea (`[]` for JSON that does not parse or is not a list).
fn tags_of(idea: &idea_ticket::Model) -> Vec<Value> {
    safe_json(&idea.tags)
}

/// `text[:n]` by characters.
fn head(text: &str, n: usize) -> String {
    text.chars().take(n).collect()
}

/// "4 people want this", or None when nobody voted.
pub fn demand_note(idea: &Idea) -> Option<String> {
    let n = idea.vote_records.len();
    if n == 0 { None } else { Some(format!("{n} {} this", if n == 1 { "person wants" } else { "people want" })) }
}

/// The assumptions of an idea, grouped by what they ask of the team (`_split_assumptions`).
struct Groups<'a> {
    open: Vec<&'a AssumptionRecord>,
    validated: Vec<&'a AssumptionRecord>,
    disproved: Vec<&'a AssumptionRecord>,
}

/// `_split_assumptions(idea)`: a status that is none of the four is Python's `KeyError`.
fn split_assumptions(idea: &Idea) -> Result<Groups<'_>, Error> {
    let mut groups = Groups { open: Vec::new(), validated: Vec::new(), disproved: Vec::new() };
    for a in &idea.assumption_records {
        match a.row.status.as_str() {
            "untested" | "testing" => groups.open.push(a),
            "validated" => groups.validated.push(a),
            "disproved" => groups.disproved.push(a),
            other => return Err(Error::Other(format!("KeyError: '{other}'"))),
        }
    }
    Ok(groups)
}

const IMAGE_EXTENSIONS: [&str; 6] = [".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg"];

/// One markdown list item for a piece of evidence: a picture shows, a file or link is a link, and a sketch or
/// diagram keeps its own markdown line so it stays editable.
fn attachment_line(e: &Map<String, Value>) -> String {
    let text = |key: &str| e.get(key).and_then(Value::as_str).unwrap_or("");
    let (reference, kind) = (text("ref"), text("kind"));
    let title = if text("title").is_empty() { reference } else { text("title") }.replace('\n', " ");
    if (kind == "sketch" || kind == "diagram")
        && (lstrip(reference).starts_with("![") || lstrip(reference).starts_with('['))
    {
        return format!("- {}", pytext::strip(reference));
    }
    let path = reference.to_lowercase();
    let path = path.split('?').next().unwrap_or("");
    if IMAGE_EXTENSIONS.iter().any(|ext| path.ends_with(ext)) {
        return format!("- ![{title}]({reference})");
    }
    format!("- [{title}]({reference})")
}

/// The ticket text built from the idea: its page, what was already confirmed, and where it came from.
pub fn build_description(idea: &Idea) -> Result<String, Error> {
    let groups = split_assumptions(idea)?;
    let first = [idea.row.body.as_str(), idea.row.description.as_str(), idea.row.title.as_str()]
        .into_iter()
        .find(|t| !t.is_empty())
        .unwrap_or("");
    let mut parts = vec![pytext::strip(first).to_string()];
    if !groups.validated.is_empty() {
        let lines: Vec<String> = groups.validated.iter().map(|a| format!("- ✓ {}", a.row.text)).collect();
        parts.push(format!("### Already confirmed\n\n{}", lines.join("\n")));
    }
    let attachments: Vec<Map<String, Value>> = space::list_evidence(idea)
        .into_iter()
        .filter(|e| matches!(e["kind"].as_str(), Some("file" | "sketch" | "diagram" | "link")))
        .collect();
    if !attachments.is_empty() {
        let lines: Vec<String> = attachments.iter().map(attachment_line).collect();
        parts.push(format!("### Attachments from the idea\n\n{}", lines.join("\n")));
    }
    let mut footer = format!("From idea `{}`", idea.row.id);
    if let Some(demand) = demand_note(idea) {
        footer.push_str(&format!(" · {demand}"));
    }
    parts.push(format!("_{footer}_"));
    Ok(parts.join("\n\n"))
}

/// What Promote would create, before anything is created (nothing is written).
///
/// `project_id`: the project to create the ticket in; defaults to the idea's project.
pub async fn preview(session: &Session, idea_id: &str, project_id: Option<&str>) -> Result<Map<String, Value>, Error> {
    let idea = space::get_or_raise(session, idea_id).await?;
    let target = project_id.filter(|p| !p.is_empty()).or(idea.row.project_id.as_deref());
    let groups = split_assumptions(&idea)?;
    let mut blockers: Vec<String> = Vec::new();
    let mut existing = Value::Null;
    if let Some(promoted) = idea.row.promoted_to_ticket_id.as_deref().filter(|t| !t.is_empty()) {
        if let Some(found) = ticket::Entity::find_by_id(promoted).one(session).await? {
            existing = json!({"id": found.id, "status": found.status});
            blockers.push("already_promoted".to_string());
        }
    }
    if !PROMOTABLE_STAGES.contains(&idea.row.stage.as_str()) && !blockers.iter().any(|b| b == "already_promoted") {
        blockers.push(format!("stage_{}", idea.row.stage));
    }
    match target {
        None => blockers.push("needs_project".to_string()),
        Some(target) => {
            if project::Entity::find_by_id(target).one(session).await?.is_none() {
                blockers.push("project_missing".to_string());
            }
        }
    }
    let readiness = idea_readiness(idea.assumptions());
    let evidence = space::list_evidence(&idea);
    let attachments: Vec<Value> = evidence
        .iter()
        .filter(|e| matches!(e["kind"].as_str(), Some("file" | "sketch" | "diagram")))
        .map(|e| Value::Object(e.clone()))
        .collect();
    let ready = readiness["state"] == "ready";

    let checklist: Vec<Value> = groups
        .open
        .iter()
        .map(|a| {
            json!({
                "assumption_id": a.row.id,
                "text": a.row.text,
                "test_ticket_id": a.row.test_ticket_id,
                "status": a.row.status,
            })
        })
        .collect();
    let mut draft = Map::new();
    draft.insert("title".into(), json!(idea.row.title));
    draft.insert("type".into(), json!("feature"));
    draft.insert("priority".into(), json!("medium"));
    draft.insert("status".into(), json!("backlog"));
    draft.insert("description".into(), json!(build_description(&idea)?));
    draft.insert("checklist".into(), Value::Array(checklist));
    draft.insert("confirmed".into(), json!(groups.validated.iter().map(|a| a.row.text.clone()).collect::<Vec<_>>()));
    draft.insert("attachments".into(), Value::Array(attachments));
    draft.insert("demand".into(), json!(demand_note(&idea)));
    draft.insert("split_suggestion".into(), json!([]));
    let carried = json!({
        "open_assumptions": groups.open.len(),
        "validated_assumptions": groups.validated.len(),
        "disproved_assumptions": groups.disproved.len(),
        "evidence": evidence.len(),
        "votes": idea.vote_records.len(),
        "log_entries": idea.log_records.len(),
    });
    let mut out = Map::new();
    out.insert("can_promote".into(), json!(blockers.is_empty()));
    out.insert("blockers".into(), json!(blockers));
    out.insert("already_promoted_ticket".into(), existing);
    out.insert("not_ready".into(), if ready { Value::Null } else { Value::Object(readiness.clone()) });
    out.insert("readiness".into(), Value::Object(readiness));
    out.insert("project_id".into(), json!(target));
    out.insert("draft".into(), Value::Object(draft));
    out.insert("carried".into(), carried);
    Ok(out)
}

/// The arguments of `promote` after the session and the idea, with the Python defaults.
#[derive(Debug, Clone)]
pub struct Promote<'a> {
    /// Where to create the ticket; defaults to the idea's project.
    pub project_id: Option<&'a str>,
    /// Ticket title; defaults to the idea's.
    pub title: Option<&'a str>,
    /// One of `TICKET_TYPES`.
    pub r#type: &'a str,
    /// One of `PRIORITIES`.
    pub priority: &'a str,
    /// The ticket's first status.
    pub status: &'a str,
    /// Ticket text; defaults to the one built from the idea.
    pub description: Option<&'a str>,
    /// Titles of sub-tickets for "Ticket with sub-tickets" (the ticket becomes their parent).
    pub sub_tickets: &'a [String],
    /// The person ticked "I understand, promote anyway".
    pub acknowledge_not_ready: bool,
    /// What happens to the idea's workspace folder: "move" it to the ticket, "copy" it or "leave" it.
    pub workspace: &'a str,
    /// A person; an AI member is never allowed to promote (the MCP tools do not offer it).
    pub author: Option<&'a str>,
}

impl Default for Promote<'_> {
    fn default() -> Self {
        Self {
            project_id: None,
            title: None,
            r#type: "feature",
            priority: "medium",
            status: "backlog",
            description: None,
            sub_tickets: &[],
            acknowledge_not_ready: false,
            workspace: "leave",
            author: Some(DEFAULT_AUTHOR),
        }
    }
}

/// Create the ticket (and, for a split, its sub-tickets) from an idea and make the idea Building.
///
/// Open assumptions become the ticket's checklist; validated ones an "Already confirmed" list. The idea is not
/// changed otherwise: it keeps its page, log and activity and links to the ticket. An idea with no project gets the
/// project the ticket is created in. Returns `(idea, ticket, sub_tickets)`.
///
/// Fails with `IdeaRuleError`: `already_promoted`, `bad_stage`, `needs_project`, `not_ready`, `too_many_sub_tickets`;
/// with `ValueError` if the project does not exist or a value is invalid.
pub async fn promote(
    session: &Session,
    idea_id: &str,
    args: &Promote<'_>,
) -> Result<(Idea, ticket::Model, Vec<ticket::Model>), Error> {
    if !TICKET_TYPES.contains(&args.r#type) {
        return value_error(format!("type must be one of: {}", TICKET_TYPES.join(", ")));
    }
    if !PRIORITIES.contains(&args.priority) {
        return value_error(format!("priority must be one of: {}", PRIORITIES.join(", ")));
    }
    let sub_tickets: Vec<&str> = args.sub_tickets.iter().map(|t| pytext::strip(t)).filter(|t| !t.is_empty()).collect();
    if sub_tickets.len() > MAX_SUB_TICKETS {
        return Err(Error::Rule(IdeaRuleError {
            code: "too_many_sub_tickets".to_string(),
            message: format!("At most {MAX_SUB_TICKETS} sub-tickets"),
            extra: Map::new(),
        }));
    }
    let idea = space::get_or_raise(session, idea_id).await?;
    if let Some(promoted) = idea.row.promoted_to_ticket_id.as_deref().filter(|t| !t.is_empty()) {
        if ticket::Entity::find_by_id(promoted).one(session).await?.is_some() {
            let mut extra = Map::new();
            extra.insert("ticket_id".into(), json!(promoted));
            return rule_error_with(
                "already_promoted",
                format!("This idea became {promoted}. Open it instead."),
                extra,
            );
        }
    }
    if !PROMOTABLE_STAGES.contains(&idea.row.stage.as_str()) {
        return crate::error::rule_error("bad_stage", format!("An idea that is {} cannot be promoted", idea.row.stage));
    }
    let Some(target) = args.project_id.filter(|p| !p.is_empty()).or(idea.row.project_id.as_deref()).map(str::to_string)
    else {
        return crate::error::rule_error("needs_project", "Choose a project to promote this idea");
    };
    if project::Entity::find_by_id(target.as_str()).one(session).await?.is_none() {
        return value_error(format!("Project '{target}' not found"));
    }
    let readiness = idea_readiness(idea.assumptions());
    if readiness["state"] != "ready" && !args.acknowledge_not_ready {
        let mut extra = Map::new();
        extra.insert("readiness".into(), Value::Object(readiness));
        return rule_error_with("not_ready", "Not every high-impact assumption is validated yet", extra);
    }

    let groups = split_assumptions(&idea)?;
    let description = match args.description {
        Some(description) => description.to_string(),
        None => build_description(&idea)?,
    };
    let title = args.title.filter(|t| !t.is_empty()).unwrap_or(&idea.row.title);
    let tags: Vec<Value> = tags_of(&idea.row).iter().map(|t| json!(pyjson::py_str(t))).collect();
    let new = NewTicket {
        description: &description,
        r#type: args.r#type,
        priority: args.priority,
        status: args.status,
        tags: Some(&tags),
        ..NewTicket::new(title)
    };
    let created = create_ticket(session, &target, new).await?;
    let mut checklist: Vec<Value> = Vec::new();
    for a in &groups.open {
        let text = match a.row.test_ticket_id.as_deref().filter(|t| !t.is_empty()) {
            Some(test) => format!("{} (test {test})", a.row.text),
            None => a.row.text.clone(),
        };
        checklist.push(json!({"id": time::uuid4(), "text": head(&text, 300), "done": false}));
    }
    let mut linked = created.clone().into_active_model();
    linked.from_idea_id = Set(Some(idea.row.id.clone()));
    linked.sub_tasks = Set(dumps(&checklist));
    let parent = linked.update(session).await?;
    let mut children: Vec<ticket::Model> = Vec::new();
    for child_title in sub_tickets {
        let new = NewTicket {
            r#type: args.r#type,
            priority: args.priority,
            status: args.status,
            parent_id: Some(&parent.id),
            ..NewTicket::new(child_title)
        };
        let child = create_ticket(session, &target, new).await?;
        let mut linked = child.into_active_model();
        linked.from_idea_id = Set(Some(idea.row.id.clone()));
        children.push(linked.update(session).await?);
    }

    let mut idea = space::get_or_raise(session, idea_id).await?;
    let now = time::now_iso();
    let before = idea.row.stage.clone();
    if idea.row.project_id.is_none() {
        idea.row.project_id = Some(target.clone());
        let mut meta = Map::new();
        meta.insert("from".into(), Value::Null);
        meta.insert("to".into(), json!(target));
        add_trail(
            &mut idea.row,
            &format!("Project: no project → {target}"),
            &now,
            args.author,
            Some("project"),
            Some(meta),
            false,
        );
    }
    idea.row.promoted_to_ticket_id = Some(parent.id.clone());
    idea.row.promoted_at = Some(now.clone());
    idea.row.former_ticket_id = None;
    idea.row.stage = "building".to_string();
    idea.row.idea_status = "approved".to_string();
    idea.row.stage_changed_at = Some(now.clone());
    idea.row.park_until = None;
    let mut meta = Map::new();
    meta.insert("from".into(), json!(before));
    meta.insert("to".into(), json!("building"));
    meta.insert("ticket".into(), json!(parent.id));
    add_trail(
        &mut idea.row,
        &format!("Promoted to ticket {}", parent.id),
        &now,
        args.author,
        Some("stage"),
        Some(meta),
        false,
    );
    let idea = space::save(session, &mut idea).await?;
    if args.workspace != "leave" {
        kb_board::workspace::transfer_workspace(session, &idea.row.id, &parent.id, args.workspace).await?;
    }
    Ok((idea, parent, children))
}

// ── keeping the idea and its ticket in step ────────────────────────────────

/// `_ideas_of_ticket`: the ideas promoted to this ticket.
async fn ideas_of_ticket(session: &Session, ticket_id: &str) -> Result<Vec<idea_ticket::Model>, Error> {
    Ok(select_ideas(session).filter(idea_ticket::Column::PromotedToTicketId.eq(ticket_id)).all(session).await?)
}

/// A `system` entry of the activity of an idea changed by its ticket.
fn system_trail(idea: &mut idea_ticket::Model, label: &str, now: &str, from: &str, to: &str, ticket_id: &str) {
    let mut meta = Map::new();
    meta.insert("from".into(), json!(from));
    meta.insert("to".into(), json!(to));
    meta.insert("ticket".into(), json!(ticket_id));
    add_trail(idea, label, now, Some("system"), Some("stage"), Some(meta), false);
}

/// Follow a ticket's status: Done ships the idea, Won't do returns it to Exploring, reopening restores it.
///
/// Called by the ticket service before it commits; this function does not commit.
pub async fn on_ticket_status_change(
    session: &Session,
    ticket: &ticket::Model,
    previous_status: &str,
) -> Result<(), Error> {
    let new = ticket.status.as_str();
    if new == previous_status {
        return Ok(());
    }
    let now = time::now_iso();
    for stored in ideas_of_ticket(session, &ticket.id).await? {
        let mut idea = stored.clone();
        if new == "done" && idea.stage == "building" {
            idea.stage = "shipped".to_string();
            idea.idea_status = "approved".to_string();
            idea.shipped_at = Some(now.clone());
            idea.stage_changed_at = Some(now.clone());
            let label = format!("{} is Done: shipped", ticket.id);
            system_trail(&mut idea, &label, &now, "building", "shipped", &ticket.id);
        } else if new == "wont_do" && (idea.stage == "building" || idea.stage == "shipped") {
            idea.stage = "exploring".to_string();
            idea.idea_status = "in_review".to_string();
            idea.stage_changed_at = Some(now.clone());
            idea.former_ticket_id = Some(ticket.id.clone());
            idea.promoted_to_ticket_id = None;
            idea.promoted_at = None;
            let label = format!("{} was dropped: back to Exploring. Try again, park or archive.", ticket.id);
            system_trail(&mut idea, &label, &now, "building", "exploring", &ticket.id);
        } else if previous_status == "done" && new != "done" && new != "wont_do" && idea.stage == "shipped" {
            idea.stage = "building".to_string();
            idea.idea_status = "approved".to_string();
            idea.stage_changed_at = Some(now.clone());
            idea.shipped_at = None;
            let label = format!("{} was reopened: building again", ticket.id);
            system_trail(&mut idea, &label, &now, "shipped", "building", &ticket.id);
        } else {
            continue;
        }
        idea.updated_at = now.clone();
        save_model(session, &stored, idea).await?;
    }
    note_test_ticket_closed(session, ticket, &now).await
}

/// Tell the idea that a ticket testing one of its assumptions was closed, so the UI can ask what it showed.
async fn note_test_ticket_closed(session: &Session, ticket: &ticket::Model, now: &str) -> Result<(), Error> {
    if ticket.status != "done" && ticket.status != "wont_do" {
        return Ok(());
    }
    let rows = idea_assumption::Entity::find()
        .filter(idea_assumption::Column::TestTicketId.eq(ticket.id.as_str()))
        .all(session)
        .await?;
    for a in rows {
        let Some(stored) = idea_ticket::Entity::find_by_id(a.idea_id.as_str()).one(session).await? else {
            continue;
        };
        let mut idea = stored.clone();
        let label =
            format!("Test ticket {} was closed: was “{}” validated or disproved?", ticket.id, head(&a.text, 60));
        let mut meta = Map::new();
        meta.insert("assumption".into(), json!(a.id));
        meta.insert("ticket".into(), json!(ticket.id));
        meta.insert("asks".into(), json!(true));
        add_trail(&mut idea, &label, now, Some("system"), Some("assumption"), Some(meta), false);
        save_model(session, &stored, idea).await?;
    }
    Ok(())
}

/// A ticket was deleted: its idea goes back to Ready with the link cleared (it can be promoted again); an assumption
/// that was tested by it loses the link. Does not commit.
pub async fn on_ticket_deleted(session: &Session, ticket: &ticket::Model) -> Result<(), Error> {
    let now = time::now_iso();
    for stored in ideas_of_ticket(session, &ticket.id).await? {
        let mut idea = stored.clone();
        idea.stage = "ready".to_string();
        idea.idea_status = "approved".to_string();
        idea.stage_changed_at = Some(now.clone());
        idea.former_ticket_id = Some(ticket.id.clone());
        idea.promoted_to_ticket_id = None;
        idea.promoted_at = None;
        idea.updated_at = now.clone();
        let label = format!("{} was deleted: back to Ready. Promote again if you want.", ticket.id);
        let mut meta = Map::new();
        meta.insert("to".into(), json!("ready"));
        meta.insert("ticket".into(), json!(ticket.id));
        add_trail(&mut idea, &label, &now, Some("system"), Some("stage"), Some(meta), false);
        save_model(session, &stored, idea).await?;
    }
    let rows = idea_assumption::Entity::find()
        .filter(idea_assumption::Column::TestTicketId.eq(ticket.id.as_str()))
        .all(session)
        .await?;
    for a in rows {
        let mut changed = a.clone();
        changed.test_ticket_id = None;
        if a.status == "testing" {
            changed.status = "untested".to_string();
        }
        save_model(session, &a, changed).await?;
    }
    Ok(())
}
