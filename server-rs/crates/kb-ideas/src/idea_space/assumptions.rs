//! `services/idea_space.py`, lines 786-953: evidence for assumptions, tickets that test them, and what a test showed.

use kb_base::pytext;
use kb_board::tickets::{NewTicket, create_ticket};
use kb_db::Session;
use kb_db::entities::{idea_evidence, ticket};
use kb_db::sea_orm::{ActiveModelTrait, ActiveValue::Set, EntityTrait, IntoActiveModel, ModelTrait};
use serde_json::{Map, Value, json};

use super::{get_or_raise, now, save};
use crate::error::{Error, rule_error, value_error};
use crate::idea_tickets::{add_trail, assumption_meta, find_assumption, update_assumption_status};
use crate::model::{EVIDENCE_KINDS, Idea};
use kb_db::save_model;

/// `text[:n]` by characters.
fn head(text: &str, n: usize) -> String {
    text.chars().take(n).collect()
}

/// Attach a piece of evidence (comment, file, link, ticket, sketch, diagram or note) to assumptions.
///
/// One piece of evidence can support many assumptions: pass several ids.
pub async fn add_evidence(
    session: &Session,
    idea_id: &str,
    assumption_ids: &[String],
    kind: &str,
    reference: &str,
    title: &str,
    author: Option<&str>,
) -> Result<Idea, Error> {
    if !EVIDENCE_KINDS.contains(&kind) {
        return value_error(format!("kind must be one of: {}", EVIDENCE_KINDS.join(", ")));
    }
    if assumption_ids.is_empty() {
        return value_error("Choose at least one assumption");
    }
    if pytext::strip(reference).is_empty() {
        return value_error("ref cannot be empty");
    }
    let mut idea = get_or_raise(session, idea_id).await?;
    let now = now();
    for aid in assumption_ids {
        let a = find_assumption(&idea, aid)?;
        let mut row = idea_evidence::new();
        row.assumption_id = Set(a.row.id.clone());
        row.kind = Set(kind.to_string());
        row.title = Set(pytext::strip(title).to_string());
        row.r#ref = Set(pytext::strip(reference).to_string());
        row.created_by = Set(author.map(str::to_string));
        row.created_at = Set(now.clone());
        row.insert(session).await?;
    }
    let shown = if pytext::strip(title).is_empty() {
        head(pytext::strip(reference), 60)
    } else {
        pytext::strip(title).to_string()
    };
    let mut meta = Map::new();
    meta.insert("assumptions".into(), json!(assumption_ids));
    add_trail(
        &mut idea.row,
        &format!("Evidence added ({kind}): {shown}"),
        &now,
        author,
        Some("evidence"),
        Some(meta),
        false,
    );
    save(session, &mut idea).await
}

/// Remove one piece of evidence from its assumption.
pub async fn delete_evidence(
    session: &Session,
    idea_id: &str,
    evidence_id: &str,
    author: Option<&str>,
) -> Result<Idea, Error> {
    let mut idea = get_or_raise(session, idea_id).await?;
    for a in &idea.assumption_records {
        if let Some(found) = a.evidence.iter().find(|e| e.id == evidence_id) {
            found.clone().delete(session).await?;
            let now = now();
            add_trail(&mut idea.row, "Evidence removed", &now, author, Some("evidence"), None, false);
            return save(session, &mut idea).await;
        }
    }
    value_error(format!("Evidence '{evidence_id}' not found"))
}

/// The Evidence tab: each distinct piece once, with the assumptions it supports.
pub fn list_evidence(idea: &Idea) -> Vec<Map<String, Value>> {
    let mut grouped: Vec<((String, String), Map<String, Value>)> = Vec::new();
    for a in &idea.assumption_records {
        for e in &a.evidence {
            let key = (e.kind.clone(), e.r#ref.clone());
            let at = match grouped.iter().position(|(k, _)| *k == key) {
                Some(at) => at,
                None => {
                    let mut item = Map::new();
                    item.insert("kind".into(), json!(e.kind));
                    item.insert("ref".into(), json!(e.r#ref));
                    item.insert("title".into(), json!(e.title));
                    item.insert("created_by".into(), json!(e.created_by));
                    item.insert("created_at".into(), json!(e.created_at));
                    item.insert("ids".into(), json!([]));
                    item.insert("assumptions".into(), json!([]));
                    grouped.push((key, item));
                    grouped.len() - 1
                }
            };
            let item = &mut grouped[at].1;
            if let Some(Value::Array(ids)) = item.get_mut("ids") {
                ids.push(json!(e.id));
            }
            if let Some(Value::Array(assumptions)) = item.get_mut("assumptions") {
                assumptions.push(json!({"id": a.row.id, "text": a.row.text}));
            }
        }
    }
    let mut items: Vec<Map<String, Value>> = grouped.into_iter().map(|(_, item)| item).collect();
    // `sorted(..., key=created_at, reverse=True)`: newest first, equal times keep their order
    items.sort_by(|a, b| b["created_at"].as_str().unwrap_or("").cmp(a["created_at"].as_str().unwrap_or("")));
    items
}

/// Create an ordinary ticket that tests an assumption, linked both ways; the assumption becomes Testing.
///
/// Fails with `IdeaRuleError`: `needs_project` when the idea has no project, `already_has_test`.
pub async fn create_test_ticket(
    session: &Session,
    idea_id: &str,
    assumption_id: &str,
    title: Option<&str>,
    assignee: Option<&str>,
    author: Option<&str>,
) -> Result<(Idea, ticket::Model), Error> {
    let idea = get_or_raise(session, idea_id).await?;
    let a = find_assumption(&idea, assumption_id)?;
    let Some(project_id) = idea.row.project_id.clone() else {
        return rule_error("needs_project", "Choose a project for the idea to create a test ticket");
    };
    if let Some(existing) = a.row.test_ticket_id.as_deref().filter(|t| !t.is_empty()) {
        if ticket::Entity::find_by_id(existing).one(session).await?.is_some() {
            return rule_error("already_has_test", format!("{existing} already tests this assumption"));
        }
    }
    let title = match title.filter(|t| !t.is_empty()) {
        Some(title) => head(title, 200),
        None => head(&format!("Test: {}", a.row.text), 200),
    };
    let description = format!(
        "Tests an assumption of idea `{}` “{}”:\n\n> {}\n\nWhen this ticket is Done, say whether the assumption is validated or disproved.",
        idea.row.id, idea.row.title, a.row.text
    );
    let tags = [json!("idea-test")];
    let new = NewTicket { description: &description, tags: Some(&tags), assignee, ..NewTicket::new(&title) };
    let created = create_ticket(session, &project_id, new).await?;
    let Some(stored) = ticket::Entity::find_by_id(created.id.as_str()).one(session).await? else {
        return Err(Error::Other("the ticket just created is missing".to_string()));
    };
    let mut linked = kb_db::edit(stored.clone());
    linked.tests_assumption_id = Set(Some(assumption_id.to_string()));
    let ticket_row = linked.update(session).await?;
    let mut idea = get_or_raise(session, idea_id).await?;
    let found = find_assumption(&idea, assumption_id)?;
    let mut a = found.row.clone();
    a.test_ticket_id = Some(ticket_row.id.clone());
    let before = a.status.clone();
    if a.status == "untested" {
        a.status = "testing".to_string();
    }
    a.updated_at = now();
    let a = save_model(session, &found.row, a).await?;
    let label = format!("Test ticket {} created for “{}”", ticket_row.id, head(&a.text, 60));
    let mut meta = assumption_meta(&a, &[("ticket", ticket_row.id.as_str())]);
    if before != a.status {
        meta.insert("from".into(), json!(before));
        meta.insert("to".into(), json!(a.status));
    }
    add_trail(&mut idea.row, &label, &now(), author, Some("assumption"), Some(meta), false);
    let saved = save(session, &mut idea).await?;
    Ok((saved, ticket_row))
}

/// Answer "what did the test show?": validated, disproved, or unsure (nothing changes, it is noted).
pub async fn resolve_assumption(
    session: &Session,
    idea_id: &str,
    assumption_id: &str,
    outcome: &str,
    author: Option<&str>,
) -> Result<Idea, Error> {
    if !["validated", "disproved", "unsure"].contains(&outcome) {
        return value_error("outcome must be validated, disproved or unsure");
    }
    if outcome == "unsure" {
        let mut idea = get_or_raise(session, idea_id).await?;
        let a = find_assumption(&idea, assumption_id)?.row.clone();
        let label = format!("Not sure yet about “{}”", head(&a.text, 60));
        add_trail(&mut idea.row, &label, &now(), author, Some("assumption"), Some(assumption_meta(&a, &[])), false);
        return save(session, &mut idea).await;
    }
    update_assumption_status(session, idea_id, assumption_id, outcome, author).await
}
