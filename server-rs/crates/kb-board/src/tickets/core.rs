//! `services/tickets.py`, lines 245-446: listing a project's tickets, the lane counts, reading one ticket and
//! creating one.

use kb_base::{activity as act, pytext, time};
use kb_db::Session;
use kb_db::entities::{member, story, ticket};
use kb_db::sea_orm::ActiveValue::Set;
use kb_db::sea_orm::sea_query::{Condition, Expr, ExprTrait};
use kb_db::sea_orm::{ActiveModelTrait, ColumnTrait, DbErr, EntityTrait, QueryFilter, QueryOrder, QuerySelect};
use kb_db::sql::bump_counter;
use serde_json::{Value, json};

use super::search::rank;
use super::validate::{
    MAX_AC_TEXT, check_date_order, clean_date, clean_estimate, clean_tags, clean_text, clean_title, validate_parent,
};
use super::{Error, dumps, value_error};

/// List a project's tickets with optional status, priority and text filters.
///
/// `status`: only tickets in this status. `priority`: only tickets with this priority. `q`: case-insensitive text
/// matched against title and description. `include_wont_do`: also return "Won't do" tickets (hidden by default).
/// `pending`: true for only pending tickets, false to leave them out. `reopened`: true for only tickets that still
/// carry the Reopened badge (reopened and not Done / Won't Do again), false to leave them out.
pub async fn list_tickets(
    session: &Session,
    project_id: &str,
    status: Option<&str>,
    priority: Option<&str>,
    q: Option<&str>,
    include_wont_do: bool,
    pending: Option<bool>,
    reopened: Option<bool>,
) -> Result<Vec<ticket::Model>, Error> {
    let mut stmt = ticket::Entity::find().filter(ticket::Column::ProjectId.eq(project_id));
    if let Some(pending) = pending {
        stmt = stmt.filter(ticket::Column::Pending.eq(pending));
    }
    if let Some(reopened) = reopened {
        let carries = Condition::all()
            .add(ticket::Column::ReopenCount.gt(0))
            .add(ticket::Column::Status.is_not_in(["done", "wont_do"]));
        stmt = stmt.filter(if reopened { carries } else { carries.not() });
    }
    if let Some(status) = status {
        stmt = stmt.filter(ticket::Column::Status.eq(status));
    } else if !include_wont_do {
        stmt = stmt.filter(ticket::Column::Status.ne("wont_do"));
    }
    if let Some(priority) = priority {
        stmt = stmt.filter(ticket::Column::Priority.eq(priority));
    }
    // The order SQLite gave without asking (insertion), on every engine; MCP pages through it with offset/limit
    let tickets = stmt.order_by_asc(ticket::Column::CreatedAt).order_by_asc(ticket::Column::Id).all(session).await?;

    match q {
        Some(q) if !pytext::strip(q).is_empty() => rank(tickets, q),
        _ => Ok(tickets),
    }
}

/// How many tickets each lane counts, by status: the board's lane badge (not pending, not Won't do), read with one
/// grouped query so the lane headers can show it while the tickets themselves load (AL-1).
pub async fn lane_counts(session: &Session, project_id: &str) -> Result<Vec<(String, i64)>, DbErr> {
    ticket::Entity::find()
        .select_only()
        .column(ticket::Column::Status)
        .column_as(Expr::col(ticket::Column::Id).count(), "n")
        .filter(ticket::Column::ProjectId.eq(project_id))
        .filter(ticket::Column::Status.ne("wont_do"))
        .filter(Condition::any().add(ticket::Column::Pending.eq(false)).add(ticket::Column::Pending.is_null()))
        .group_by(ticket::Column::Status)
        .into_tuple()
        .all(session)
        .await
}

/// Return a ticket by id, or None.
pub async fn get_ticket(session: &Session, ticket_id: &str) -> Result<Option<ticket::Model>, DbErr> {
    ticket::Entity::find_by_id(ticket_id).one(session).await
}

pub const MAX_NEW_CRITERIA: usize = 50;

/// The arguments of `create_ticket` after the session and the project, with the Python defaults.
#[derive(Debug, Clone)]
pub struct NewTicket<'a> {
    /// Ticket title (trimmed, length-checked).
    pub title: &'a str,
    /// Ticket type, e.g. "task", "bug".
    pub r#type: &'a str,
    /// Priority level.
    pub priority: &'a str,
    /// Initial board status.
    pub status: &'a str,
    /// Markdown description.
    pub description: &'a str,
    /// Parent ticket id for a sub-ticket.
    pub parent_id: Option<&'a str>,
    /// Estimate in the project's unit.
    pub estimate: Option<f64>,
    /// ISO due date.
    pub due_date: Option<&'a str>,
    /// ISO start date.
    pub start_date: Option<&'a str>,
    /// Tag names.
    pub tags: Option<&'a [Value]>,
    /// Actor recorded as creator.
    pub created_by: Option<&'a str>,
    /// Member id; must belong to the project.
    pub assignee: Option<&'a str>,
    /// Criteria to start with, one checkable condition each. Written with the ticket, so the AI team's intake (which
    /// may take a new ticket at once) never sees it without them.
    pub acceptance_criteria: Option<&'a [String]>,
}

impl<'a> NewTicket<'a> {
    /// A task of medium priority in the backlog, with nothing else set.
    pub fn new(title: &'a str) -> Self {
        Self {
            title,
            r#type: "task",
            priority: "medium",
            status: "backlog",
            description: "",
            parent_id: None,
            estimate: None,
            due_date: None,
            start_date: None,
            tags: None,
            created_by: None,
            assignee: None,
            acceptance_criteria: None,
        }
    }
}

/// Validate and create a ticket with the next project number.
///
/// Returns the created ticket. Fails with `ValueError` if a field is invalid or the assignee is not a project
/// member, and with `NoResultFound` if the project does not exist.
pub async fn create_ticket(session: &Session, project_id: &str, new: NewTicket<'_>) -> Result<ticket::Model, Error> {
    let title = clean_title(Some(new.title))?;
    let tags = clean_tags(new.tags)?;
    let estimate = clean_estimate(new.estimate)?;
    let due_date = clean_date(new.due_date, "Due date")?;
    let start_date = clean_date(new.start_date, "Start date")?;
    check_date_order(start_date.as_deref(), due_date.as_deref())?;

    if let Some(parent_id) = new.parent_id {
        validate_parent(session, parent_id, project_id, None).await?;
    }
    let acceptance_criteria = new.acceptance_criteria.unwrap_or(&[]);
    if acceptance_criteria.len() > MAX_NEW_CRITERIA {
        return value_error(format!(
            "At most {MAX_NEW_CRITERIA} acceptance criteria at once: split the ticket, or add the rest one by one."
        ));
    }
    let mut criteria: Vec<Value> = Vec::with_capacity(acceptance_criteria.len());
    for c in acceptance_criteria {
        criteria.push(json!({
            "id": time::uuid4(),
            "text": clean_text(Some(c), "Acceptance criterion", MAX_AC_TEXT)?,
            "done": false,
        }));
    }

    // Validate assignee belongs to this project
    if let Some(assignee) = new.assignee {
        let assignee_member = member::Entity::find_by_id(assignee).one(session).await?;
        if !assignee_member.is_some_and(|m| m.project_id == project_id) {
            return value_error("Assignee must be a member of this project");
        }
    }

    // Auto-assign created_by to first available member if not provided
    let mut created_by = new.created_by.map(str::to_string);
    if created_by.is_none() {
        let first_member = member::Entity::find()
            .filter(member::Column::ProjectId.eq(project_id))
            .order_by_asc(member::Column::CreatedAt)
            .order_by_asc(member::Column::Id)
            .limit(1)
            .one(session)
            .await?;
        if let Some(m) = first_member {
            created_by = Some(m.id);
        }
    }

    let row = bump_counter(session, "project", "ticket_counter", "id", project_id.into(), &["prefix"]).await?;
    let Some(row) = row else {
        // what callers catch
        return Err(Error::NoResult(format!("Project {project_id} not found")));
    };
    let counter: i32 = row.try_get_by_index(0)?;
    let prefix: String = row.try_get_by_index(1)?;
    let ticket_id = format!("{prefix}-{counter}");

    let mut activity_log = dumps(&[act::entry("created", Value::Null, Value::Null, Some(&title), None, None)]);
    let mut ticket = ticket::new();
    ticket.id = Set(ticket_id.clone());
    ticket.project_id = Set(project_id.to_string());
    ticket.title = Set(title);
    ticket.r#type = Set(new.r#type.to_string());
    ticket.priority = Set(new.priority.to_string());
    ticket.status = Set(new.status.to_string());
    ticket.description = Set(new.description.to_string());
    ticket.parent_id = Set(new.parent_id.map(str::to_string));
    ticket.estimate = Set(estimate.map(Into::into));
    ticket.due_date = Set(due_date);
    ticket.start_date = Set(start_date);
    ticket.tags = Set(dumps(&tags.into_iter().map(Value::String).collect::<Vec<_>>()));
    ticket.created_by = Set(created_by.clone());
    ticket.assignee = Set(new.assignee.map(str::to_string));
    if !criteria.is_empty() {
        ticket.acceptance_criteria = Set(dumps(&criteria));
        for c in &criteria {
            act::record(&mut activity_log, "acceptance_criterion", Value::Null, c["text"].clone(), None, None);
        }
    }
    ticket.activity_log = Set(activity_log);
    if new.r#type == "story" && new.parent_id.is_some_and(|p| !p.is_empty()) {
        return value_error("A Story holds tickets, never Stories: it cannot have a parent.");
    }
    let ticket = ticket.insert(session).await?;
    if new.r#type == "story" {
        // every Story ticket has its Story, a Draft until it is handed to the PM
        let mut row = story::new();
        row.ticket_id = Set(ticket_id);
        row.project_id = Set(project_id.to_string());
        row.created_by = Set(created_by);
        row.insert(session).await?;
    }
    session.commit().await?;
    Ok(ticket)
}
