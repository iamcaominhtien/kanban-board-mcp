//! `services/idea_space.py`, lines 490-632: giving an idea a project, editing its page, and the outcome after it
//! shipped.

use kb_base::{pyjson, pytext};
use kb_db::Session;
use kb_db::entities::project;
use kb_db::sea_orm::EntityTrait;
use serde_json::{Map, Value, json};

use super::{get_or_raise, now, save};
use crate::error::{Error, value_error};
use crate::idea_tickets::{DEFAULT_AUTHOR, add_trail};
use crate::model::{Idea, WORKSPACE_RETENTIONS};

/// Give an idea a project, move it to another one, or remove it from its project (None).
///
/// The page, assumptions, evidence and history stay with the idea. Links to tickets keep working.
pub async fn assign_project(
    session: &Session,
    idea_id: &str,
    project_id: Option<&str>,
    author: Option<&str>,
) -> Result<Idea, Error> {
    let mut idea = get_or_raise(session, idea_id).await?;
    if let Some(project_id) = project_id {
        if project::Entity::find_by_id(project_id).one(session).await?.is_none() {
            return value_error(format!("Project '{project_id}' not found"));
        }
    }
    if idea.row.project_id.as_deref() == project_id {
        return Ok(idea);
    }
    let now = now();
    let old = idea.row.project_id.clone();
    idea.row.project_id = project_id.map(str::to_string);
    let label = format!("Project: {} → {}", old.as_deref().unwrap_or("no project"), project_id.unwrap_or("no project"));
    let mut meta = Map::new();
    meta.insert("from".into(), json!(old));
    meta.insert("to".into(), json!(project_id));
    add_trail(&mut idea.row, &label, &now, author, Some("project"), Some(meta), false);
    save(session, &mut idea).await
}

/// A value of `update_page` that may be left out (`_SKIP`) or given, None included.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Sent<'a> {
    /// The argument was left out.
    Skip,
    /// The value given (None clears the field).
    Set(Option<&'a str>),
}

/// The arguments of `update_page` after the session and the idea, with the Python defaults.
#[derive(Debug, Clone)]
pub struct PageChanges<'a> {
    /// The markdown body of the page.
    pub body: Option<&'a str>,
    /// The details.
    pub details: Option<&'a str>,
    /// The owner (None clears it).
    pub owner: Sent<'a>,
    /// The effort guess (None clears it).
    pub effort_guess: Sent<'a>,
    /// One of `WORKSPACE_RETENTIONS`.
    pub workspace_retention: Option<&'a str>,
    /// The tags (`json.dumps` of the list).
    pub tags: Option<&'a [Value]>,
    /// The title.
    pub title: Option<&'a str>,
    /// Who is credited.
    pub author: Option<&'a str>,
    /// The page was edited with the AI.
    pub ai: bool,
}

impl Default for PageChanges<'_> {
    fn default() -> Self {
        Self {
            body: None,
            details: None,
            owner: Sent::Skip,
            effort_guess: Sent::Skip,
            workspace_retention: None,
            tags: None,
            title: None,
            author: Some(DEFAULT_AUTHOR),
            ai: false,
        }
    }
}

/// `text[:n]` by characters.
fn head(text: &str, n: usize) -> String {
    text.chars().take(n).collect()
}

/// Edit the idea page (its markdown body and details), owner, effort guess, tags or title.
///
/// Text edits are recorded with a short before/after so Activity can show what changed.
pub async fn update_page(session: &Session, idea_id: &str, changes: &PageChanges<'_>) -> Result<Idea, Error> {
    let mut idea = get_or_raise(session, idea_id).await?;
    let now = now();
    let author = changes.author;
    let ai = changes.ai;
    if let Some(body) = changes.body.filter(|b| *b != idea.row.body) {
        let old = std::mem::replace(&mut idea.row.body, body.to_string());
        let label = format!("Page text edited{}", if ai { " with AI" } else { "" });
        let mut meta = Map::new();
        meta.insert("from".into(), json!(head(&old, 600)));
        meta.insert("to".into(), json!(head(body, 600)));
        add_trail(&mut idea.row, &label, &now, author, Some("page"), Some(meta), ai);
    }
    if let Some(details) = changes.details.filter(|d| *d != idea.row.details) {
        idea.row.details = details.to_string();
        add_trail(&mut idea.row, "Details edited", &now, author, Some("page"), None, false);
    }
    if let Sent::Set(owner) = changes.owner {
        if owner.map(str::to_string) != idea.row.owner {
            idea.row.owner = owner.map(str::to_string);
            let label = format!("Owner: {}", owner.filter(|o| !o.is_empty()).unwrap_or("nobody"));
            add_trail(&mut idea.row, &label, &now, author, Some("link"), None, false);
        }
    }
    if let Sent::Set(effort_guess) = changes.effort_guess {
        if effort_guess.map(str::to_string) != idea.row.effort_guess {
            idea.row.effort_guess = effort_guess.map(str::to_string);
            let label = format!("Effort guess: {}", effort_guess.filter(|e| !e.is_empty()).unwrap_or("none"));
            add_trail(&mut idea.row, &label, &now, author, Some("page"), None, ai);
        }
    }
    if let Some(retention) = changes.workspace_retention {
        if !WORKSPACE_RETENTIONS.contains(&retention) {
            return value_error(format!("workspace_retention must be one of: {}", WORKSPACE_RETENTIONS.join(", ")));
        }
        idea.row.workspace_retention = retention.to_string();
    }
    if let Some(tags) = changes.tags {
        idea.row.tags = pyjson::dumps(&tags);
    }
    if let Some(title) = changes.title {
        let title = pytext::strip(title);
        if !title.is_empty() && title != idea.row.title {
            idea.row.title = title.to_string();
            add_trail(&mut idea.row, "Title edited", &now, author, Some("page"), None, false);
        }
    }
    save(session, &mut idea).await
}

/// Save the answer to "Did it work as expected?" on a Shipped idea. `outcome`: worked, partly or no.
pub async fn record_outcome(
    session: &Session,
    idea_id: &str,
    outcome: &str,
    note: Option<&str>,
    author: Option<&str>,
) -> Result<Idea, Error> {
    if !["worked", "partly", "no"].contains(&outcome) {
        return value_error("outcome must be worked, partly or no");
    }
    let mut idea = get_or_raise(session, idea_id).await?;
    idea.row.outcome = Some(outcome.to_string());
    idea.row.outcome_note = note.map(str::to_string);
    let mut meta = Map::new();
    meta.insert("outcome".into(), json!(outcome));
    add_trail(
        &mut idea.row,
        &format!("Outcome after shipping: {outcome}"),
        &now(),
        author,
        Some("stage"),
        Some(meta),
        false,
    );
    save(session, &mut idea).await
}
