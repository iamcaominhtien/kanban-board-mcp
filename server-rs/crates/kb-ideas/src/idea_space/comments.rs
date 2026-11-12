//! `services/idea_space.py`, lines 956-1031: comments on an idea's page.

use kb_base::pytext;
use kb_db::Session;
use kb_db::entities::idea_comment;
use kb_db::sea_orm::{
    ActiveModelTrait, ActiveValue::Set, ColumnTrait, EntityTrait, ModelTrait, QueryFilter, QueryOrder,
};

use super::{get_or_raise, now};
use crate::error::{Error, value_error};
use kb_db::save_model;

/// `session.get(IdeaComment, comment_id)` of a comment of this idea, or `ValueError`.
async fn find(session: &Session, idea_id: &str, comment_id: &str) -> Result<idea_comment::Model, Error> {
    match idea_comment::Entity::find_by_id(comment_id).one(session).await? {
        Some(comment) if comment.idea_id == idea_id => Ok(comment),
        _ => value_error(format!("Comment '{comment_id}' not found")),
    }
}

/// Write a comment on the idea page.
pub async fn add_comment(
    session: &Session,
    idea_id: &str,
    body: &str,
    author: Option<&str>,
    ai: bool,
    run_id: Option<&str>,
) -> Result<idea_comment::Model, Error> {
    let body = pytext::strip(body);
    if body.is_empty() {
        return value_error("body cannot be empty");
    }
    let idea = get_or_raise(session, idea_id).await?;
    let mut row = idea_comment::new();
    row.idea_id = Set(idea.row.id.clone());
    row.author = Set(author.map(str::to_string));
    row.body = Set(body.to_string());
    row.ai = Set(ai);
    row.run_id = Set(run_id.map(str::to_string));
    let created_at = now();
    row.created_at = Set(created_at.clone());
    let comment = row.insert(session).await?;
    let mut touched = idea.row.clone();
    touched.updated_at = created_at;
    save_model(session, &idea.loaded, touched).await?;
    session.commit().await?;
    Ok(comment)
}

/// Change the text of a comment; an AI comment stops being marked AI once a person edits it.
pub async fn edit_comment(
    session: &Session,
    idea_id: &str,
    comment_id: &str,
    body: &str,
) -> Result<idea_comment::Model, Error> {
    let comment = find(session, idea_id, comment_id).await?;
    if pytext::strip(body).is_empty() {
        return value_error("body cannot be empty");
    }
    let mut changed = comment.clone();
    changed.body = pytext::strip(body).to_string();
    changed.edited_at = Some(now());
    changed.ai = false;
    let saved = save_model(session, &comment, changed).await?;
    session.commit().await?;
    Ok(saved)
}

/// Delete a comment.
pub async fn delete_comment(session: &Session, idea_id: &str, comment_id: &str) -> Result<(), Error> {
    let comment = find(session, idea_id, comment_id).await?;
    comment.delete(session).await?;
    session.commit().await?;
    Ok(())
}

/// The idea's comments, oldest first.
pub async fn list_comments(session: &Session, idea_id: &str) -> Result<Vec<idea_comment::Model>, Error> {
    Ok(idea_comment::Entity::find()
        .filter(idea_comment::Column::IdeaId.eq(idea_id))
        .order_by_asc(idea_comment::Column::CreatedAt)
        .all(session)
        .await?)
}
