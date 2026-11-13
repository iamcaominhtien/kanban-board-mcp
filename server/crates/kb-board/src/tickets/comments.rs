//! `services/tickets.py`, lines 804-988: the comments of a ticket. A comment records who it mentions and who it
//! notifies; deleting one hides it and keeps its data, so that Undo can bring it back.

use kb_base::{activity as act, time};
use kb_db::Session;
use kb_db::entities::{member, ticket};
use kb_db::sea_orm::{ColumnTrait, EntityTrait, QueryFilter};
use serde_json::{Map, Value, json};

use super::validate::{MAX_COMMENT, clean_text, mention_ids, record_doc_refs};
use super::{Error, commit, dumps, field, for_edit, loads, put};
use kb_base::pyjson::truthy;

/// Who a new comment notifies: reporter, assignee, earlier commenters and anyone @mentioned (not the author).
async fn comment_recipients(
    session: &Session,
    ticket: &ticket::Model,
    comments: &[Value],
    author: &str,
    mentions: &[String],
) -> Result<Vec<Value>, Error> {
    let members =
        member::Entity::find().filter(member::Column::ProjectId.eq(ticket.project_id.as_str())).all(session).await?;

    let find = |reference: Option<&str>| -> Option<&member::Model> {
        let reference = reference.filter(|r| !r.is_empty())?;
        let low = reference.to_lowercase();
        members.iter().find(|m| m.id == reference || m.name.to_lowercase() == low)
    };

    let author_member = find(Some(author));
    let mut refs: Vec<Option<&str>> = vec![ticket.created_by.as_deref(), ticket.assignee.as_deref()];
    refs.extend(comments.iter().filter(|c| !truthy(field(c, "deleted_at"))).map(|c| field(c, "author").as_str()));
    refs.extend(mentions.iter().map(|m| Some(m.as_str())));
    let mut ids: Vec<(&str, &str)> = Vec::new();
    for reference in refs {
        if let Some(m) = find(reference) {
            if !ids.iter().any(|(id, _)| *id == m.id) {
                ids.push((&m.id, &m.name));
            }
        }
    }
    if let Some(author_member) = author_member {
        ids.retain(|(id, _)| *id != author_member.id);
    }
    Ok(ids.into_iter().map(|(i, n)| json!({"id": i, "name": n})).collect())
}

/// Add a comment, record its mentions and notify the people involved.
///
/// `text` is Markdown; `@[Name](member:id)` mentions are recorded. `author` is the actor name stored with the
/// comment (`"user"` by default in Python). `meta` holds extra keys stored on the comment, e.g. `{"ai": {...}}`
/// for an AI member's reply.
///
/// Returns the updated ticket, or None if it does not exist.
pub async fn add_comment(
    session: &Session,
    ticket_id: &str,
    text: &str,
    author: &str,
    meta: Option<&Map<String, Value>>,
) -> Result<Option<ticket::Model>, Error> {
    let Some(stored) = for_edit(session, ticket_id).await? else {
        return Ok(None);
    };
    let mut ticket = stored.clone();
    let text = clean_text(Some(text), "Comment", MAX_COMMENT)?;
    let mut comments = loads(&ticket.comments)?;
    let comment_id = time::uuid4();
    let mentions = mention_ids(&text);
    let notified = comment_recipients(session, &ticket, &comments, author, &mentions).await?;
    let mut comment = Map::new();
    comment.insert("id".into(), json!(comment_id));
    comment.insert("text".into(), json!(text));
    comment.insert("author".into(), json!(author));
    comment.insert("at".into(), json!(time::now_iso()));
    comment.insert("edited_at".into(), Value::Null);
    comment.insert("deleted_at".into(), Value::Null);
    comment.insert("mentions".into(), json!(mentions));
    comment.insert("notified".into(), Value::Array(notified));
    for (key, value) in meta.into_iter().flatten() {
        comment.insert(key.clone(), value.clone());
    }
    comments.push(Value::Object(comment));
    act::record(
        &mut ticket.activity_log,
        "comment",
        Value::Null,
        json!(text),
        Some(&comment_id),
        act::author_actor(Some(author)),
    );
    record_doc_refs(&mut ticket, None, Some(&text), "a comment")?;
    ticket.comments = dumps(&comments);
    ticket.updated_at = time::now_iso();
    Ok(Some(commit(session, &stored, ticket).await?))
}

/// Soft-delete a comment: it is hidden everywhere but keeps its data, so Undo can restore it.
///
/// Returns the updated ticket (also when no comment has this id), or None if the ticket does not exist.
pub async fn delete_comment(
    session: &Session,
    ticket_id: &str,
    comment_id: &str,
) -> Result<Option<ticket::Model>, Error> {
    let Some(stored) = for_edit(session, ticket_id).await? else {
        return Ok(None);
    };
    let mut ticket = stored.clone();
    let mut comments = loads(&ticket.comments)?;
    let now = time::now_iso();
    for c in &mut comments {
        if field(c, "id").as_str() == Some(comment_id) && !truthy(field(c, "deleted_at")) {
            put(c, "deleted_at", json!(now));
            record_doc_refs(&mut ticket, field(c, "text").as_str(), None, "a comment")?;
            break;
        }
    }
    ticket.comments = dumps(&comments);
    ticket.updated_at = now;
    Ok(Some(commit(session, &stored, ticket).await?))
}

/// Undo a comment deletion.
///
/// Returns the updated ticket, or None if the ticket or a deleted comment with this id does not exist.
pub async fn restore_comment(
    session: &Session,
    ticket_id: &str,
    comment_id: &str,
) -> Result<Option<ticket::Model>, Error> {
    let Some(stored) = for_edit(session, ticket_id).await? else {
        return Ok(None);
    };
    let mut ticket = stored.clone();
    let mut comments = loads(&ticket.comments)?;
    let mut found = false;
    for c in &mut comments {
        if field(c, "id").as_str() == Some(comment_id) && truthy(field(c, "deleted_at")) {
            put(c, "deleted_at", Value::Null);
            record_doc_refs(&mut ticket, None, field(c, "text").as_str(), "a comment")?;
            found = true;
        }
    }
    if !found {
        return Ok(None);
    }
    ticket.comments = dumps(&comments);
    ticket.updated_at = time::now_iso();
    Ok(Some(commit(session, &stored, ticket).await?))
}

/// Edit a comment's text and mark it edited.
///
/// Returns the updated ticket, or None if the ticket or comment does not exist.
pub async fn update_comment(
    session: &Session,
    ticket_id: &str,
    comment_id: &str,
    text: &str,
) -> Result<Option<ticket::Model>, Error> {
    let Some(stored) = for_edit(session, ticket_id).await? else {
        return Ok(None);
    };
    let mut ticket = stored.clone();
    let text = clean_text(Some(text), "Comment", MAX_COMMENT)?;
    let mut comments = loads(&ticket.comments)?;
    let mut found = false;
    for c in &mut comments {
        if field(c, "id").as_str() == Some(comment_id) && !truthy(field(c, "deleted_at")) {
            if field(c, "text").as_str() != Some(text.as_str()) {
                record_doc_refs(&mut ticket, field(c, "text").as_str(), Some(&text), "a comment")?;
                put(c, "text", json!(text));
                put(c, "edited_at", json!(time::now_iso()));
                put(c, "mentions", json!(mention_ids(&text)));
            }
            found = true;
            break;
        }
    }
    if !found {
        return Ok(None);
    }
    ticket.comments = dumps(&comments);
    ticket.updated_at = time::now_iso();
    Ok(Some(commit(session, &stored, ticket).await?))
}
