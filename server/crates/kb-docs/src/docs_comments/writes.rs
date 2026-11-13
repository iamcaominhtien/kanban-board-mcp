//! The writes of Docs comments (`services/docs_comments.py` lines 459-747): start a thread, reply, edit, delete,
//! resolve and reopen, re-attach, read marks.

use kb_base::{activity, pyjson, time};
use kb_db::Session;
use kb_db::entities::{docs_comment, docs_comment_read, docs_comment_thread};
use kb_db::sea_orm::ActiveValue::Set;
use kb_db::sea_orm::{ActiveModelTrait, ColumnTrait, EntityTrait, QueryFilter};
use kb_doctext::docs_anchors as anchors;
use serde::Deserialize;
use serde_json::{Map, Value};

use super::{
    announce, clean_body, comments_of, delete_threads, members_of, mentions_in, need_member, one, page_blocks,
    record_event, role_in, thread, thread_page,
};
use crate::docs::get_page;
use crate::{Result, docs_err};

/// The selected text a comment is attached to (`AnchorBody` of `api/docs.py`).
#[derive(Debug, Clone, Deserialize)]
pub struct Anchor {
    /// The selected text.
    pub quote: String,
    /// What comes before it.
    #[serde(default)]
    pub prefix: String,
    /// What comes after it.
    #[serde(default)]
    pub suffix: String,
    /// The slug of the section it is in.
    #[serde(default)]
    pub section: Option<String>,
}

/// Start a thread: an inline comment on selected text, or a page comment.
///
/// `kind` is `inline` or `page`; `body` the comment text (Markdown; `@Name` mentions project members); `anchor`
/// the selection of an inline thread; `ai` is set when an AI member writes the comment (Docs AI): `{member_id,
/// job_id, cost, sources, can_suggest}`. Fails with 403 for a viewer; 422 on empty text or a missing or oversized
/// selection. Returns the new thread.
pub async fn create_thread(
    session: &Session,
    page_id: &str,
    kind: &str,
    body: &str,
    anchor: Option<&Anchor>,
    ai: Option<&Value>,
) -> Result<Map<String, Value>> {
    if kind != "inline" && kind != "page" {
        return docs_err(422, "bad_kind", "kind must be inline or page");
    }
    let page = get_page(session, page_id, false, false).await?;
    let actor = activity::current_actor();
    let members = members_of(session, &page.project_id).await?;
    need_member(&role_in(&members, &actor))?;
    let text = clean_body(Some(body))?;
    let mut row = docs_comment_thread::new();
    row.page_id = Set(page.id.clone());
    row.kind = Set(kind.to_string());
    row.created_by = Set(actor.clone());
    if kind == "inline" {
        let quote = anchors::normalize(anchor.map(|a| a.quote.as_str()).unwrap_or(""));
        if quote.is_empty() {
            return docs_err(422, "no_selection", "Select some text before adding a comment");
        }
        if quote.chars().count() > anchors::MAX_QUOTE {
            return docs_err(422, "selection_too_long", format!("Select at most {} characters", anchors::MAX_QUOTE));
        }
        let prefix = anchor.map(|a| a.prefix.clone()).unwrap_or_default();
        let suffix = anchor.map(|a| a.suffix.clone()).unwrap_or_default();
        let section = anchor.and_then(|a| a.section.clone()).filter(|s| !s.is_empty());
        // Text typed in a draft may not be published yet: it stays attached, without a position, until the next
        // publish re-matches it.
        let hit =
            anchors::find_anchor(&page_blocks(session, &page).await?, &quote, &prefix, &suffix, section.as_deref());
        row.anchor_quote = Set(Some(quote));
        row.anchor_prefix = Set(prefix);
        row.anchor_suffix = Set(suffix);
        row.anchor_section = Set(section);
        row.anchor_pos = Set(hit.map(|h| h.pos as i32));
    }
    let created = row.insert(session).await?;
    let comment = insert_comment(session, &created.id, &actor, &text, &members, ai).await?;
    let event = record_event(session, &page, &created, Some(&comment), "comment", &actor, &members, false).await?;
    mark_read_of(session, &created.id, &actor).await?;
    session.commit().await?;
    announce(&event);
    one(session, &created).await
}

/// A new comment row (`DocsComment(...)` and `flush`).
async fn insert_comment(
    session: &Session,
    thread_id: &str,
    actor: &str,
    text: &str,
    members: &[kb_db::entities::member::Model],
    ai: Option<&Value>,
) -> Result<docs_comment::Model> {
    let mut comment = docs_comment::new();
    comment.thread_id = Set(thread_id.to_string());
    comment.author = Set(actor.to_string());
    comment.body = Set(text.to_string());
    let ids: Vec<&str> = mentions_in(text, members).iter().map(|m| m.id.as_str()).collect();
    comment.mentions = Set(pyjson::dumps(&ids));
    comment.ai = Set(ai.filter(|a| pyjson::truthy(a)).map(pyjson::dumps));
    Ok(comment.insert(session).await?)
}

/// Reply in a thread and notify the people mentioned, the thread starter and earlier repliers.
///
/// `ai` is set when an AI member writes the reply (Docs AI): it is shown with an AI badge and never starts another
/// AI run.
pub async fn add_reply(
    session: &Session,
    thread_id: &str,
    body: &str,
    ai: Option<&Value>,
) -> Result<Map<String, Value>> {
    let row = thread(session, thread_id).await?;
    let page = thread_page(session, &row).await?;
    let actor = activity::current_actor();
    let members = members_of(session, &page.project_id).await?;
    need_member(&role_in(&members, &actor))?;
    let text = clean_body(Some(body))?;
    let comment = insert_comment(session, &row.id, &actor, &text, &members, ai).await?;
    let event = record_event(session, &page, &row, Some(&comment), "reply", &actor, &members, true).await?;
    mark_read_of(session, &row.id, &actor).await?;
    session.commit().await?;
    announce(&event);
    one(session, &row).await
}

/// A line the board writes in a thread for the person who acted ("Sent to PM on RES-1"): shown as a small note, not
/// a comment of theirs, and it notifies nobody. `meta` carries its `kind` (for example `sent`).
pub async fn add_board_note(session: &Session, thread_id: &str, body: &str, meta: &Value) -> Result<()> {
    let row = thread(session, thread_id).await?;
    let mut comment = docs_comment::new();
    comment.thread_id = Set(row.id.clone());
    comment.author = Set(activity::current_actor());
    comment.body = Set(clean_body(Some(body))?);
    comment.ai = Set(Some(pyjson::dumps(meta)));
    comment.insert(session).await?;
    session.commit().await?;
    Ok(())
}

/// Edit your own comment; it is then shown as edited.
pub async fn edit_comment(session: &Session, comment_id: &str, body: &str) -> Result<Map<String, Value>> {
    let Some(comment) = docs_comment::Entity::find_by_id(comment_id).one(session).await? else {
        return docs_err(404, "comment_not_found", "Comment not found");
    };
    let row = thread(session, &comment.thread_id).await?;
    let page = thread_page(session, &row).await?;
    let actor = activity::current_actor();
    let members = members_of(session, &page.project_id).await?;
    need_member(&role_in(&members, &actor))?;
    if comment.author != actor {
        return docs_err(403, "not_author", "You can only edit your own comments");
    }
    let text = clean_body(Some(body))?;
    if text != comment.body {
        let ids: Vec<&str> = mentions_in(&text, &members).iter().map(|m| m.id.as_str()).collect();
        let mut update = kb_db::edit(comment);
        update.mentions = Set(pyjson::dumps(&ids));
        update.body = Set(text);
        update.edited_at = Set(Some(time::now_iso()));
        update.update(session).await?;
    }
    session.commit().await?;
    one(session, &row).await
}

/// Delete a comment.
///
/// The author may delete their own comments and an admin any comment. Deleting the first comment of a thread
/// removes the whole thread (and its highlight); deleting a reply removes only that reply. Returns `{deleted:
/// "comment" | "thread", thread_id}`.
pub async fn delete_comment(session: &Session, comment_id: &str) -> Result<Map<String, Value>> {
    let Some(comment) = docs_comment::Entity::find_by_id(comment_id).one(session).await? else {
        return docs_err(404, "comment_not_found", "Comment not found");
    };
    let row = thread(session, &comment.thread_id).await?;
    let page = thread_page(session, &row).await?;
    let actor = activity::current_actor();
    let members = members_of(session, &page.project_id).await?;
    let role = role_in(&members, &actor);
    need_member(&role)?;
    if comment.author != actor && role != "admin" {
        return docs_err(403, "not_author", "Only the author or an admin can delete a comment");
    }
    let comments = comments_of(session, &row.id).await?;
    let mut out = Map::new();
    if comments.first().is_some_and(|c| c.id == comment.id) {
        delete_threads(session, std::slice::from_ref(&row.id)).await?;
        session.commit().await?;
        out.insert("deleted".into(), "thread".into());
    } else {
        docs_comment::Entity::delete_by_id(comment.id.as_str()).exec(session).await?;
        session.commit().await?;
        out.insert("deleted".into(), "comment".into());
    }
    out.insert("thread_id".into(), row.id.clone().into());
    Ok(out)
}

/// Resolve or reopen a thread; the resolver and time are recorded.
///
/// Fails with 403 for a viewer; 422 if a page comment thread is asked to resolve (page comments are not
/// resolvable).
pub async fn set_status(session: &Session, thread_id: &str, status: &str) -> Result<Map<String, Value>> {
    let row = thread(session, thread_id).await?;
    let page = thread_page(session, &row).await?;
    let actor = activity::current_actor();
    let members = members_of(session, &page.project_id).await?;
    need_member(&role_in(&members, &actor))?;
    if row.kind != "inline" {
        return docs_err(422, "not_resolvable", "Only inline threads can be resolved");
    }
    if row.status == status {
        return one(session, &row).await;
    }
    if status == "resolved" && activity::current_ai().is_some_and(|ai| pyjson::truthy(&ai)) {
        // An AI that resolves a thread says what it did first: the person who opened it should not have to guess
        let replied = docs_comment::Entity::find()
            .filter(docs_comment::Column::ThreadId.eq(row.id.as_str()))
            .filter(docs_comment::Column::Author.eq(actor.as_str()))
            .one(session)
            .await?;
        if replied.is_none() {
            return docs_err(
                422,
                "reply_first",
                "Reply in this thread first (what you changed, or why not), then resolve it.",
            );
        }
    }
    let mut update = kb_db::edit(row);
    update.status = Set(status.to_string());
    update.resolved_by = Set(if status == "resolved" { Some(actor.clone()) } else { None });
    update.resolved_at = Set(if status == "resolved" { Some(time::now_iso()) } else { None });
    let row = update.update(session).await?;
    let event = record_event(
        session,
        &page,
        &row,
        None,
        if status == "resolved" { "resolved" } else { "reopened" },
        &actor,
        &members,
        true,
    )
    .await?;
    session.commit().await?;
    announce(&event);
    one(session, &row).await
}

/// Attach an orphaned (or any inline) thread to a new selection.
pub async fn reattach(session: &Session, thread_id: &str, anchor: &Anchor) -> Result<Map<String, Value>> {
    let row = thread(session, thread_id).await?;
    let page = thread_page(session, &row).await?;
    let actor = activity::current_actor();
    let members = members_of(session, &page.project_id).await?;
    need_member(&role_in(&members, &actor))?;
    if row.kind != "inline" {
        return docs_err(422, "not_inline", "Only inline threads have an anchor");
    }
    let quote = anchors::normalize(&anchor.quote);
    if quote.is_empty() || quote.chars().count() > anchors::MAX_QUOTE {
        return docs_err(422, "no_selection", "Select some text to attach the thread to");
    }
    let section = anchor.section.clone().filter(|s| !s.is_empty());
    let hit = anchors::find_anchor(
        &page_blocks(session, &page).await?,
        &quote,
        &anchor.prefix,
        &anchor.suffix,
        section.as_deref(),
    );
    let mut update = kb_db::edit(row);
    update.anchor_quote = Set(Some(quote));
    update.anchor_prefix = Set(anchor.prefix.clone());
    update.anchor_suffix = Set(anchor.suffix.clone());
    update.anchor_section = Set(section);
    update.anchor_state = Set("attached".to_string());
    update.anchor_pos = Set(hit.map(|h| h.pos as i32));
    let row = update.update(session).await?;
    session.commit().await?;
    one(session, &row).await
}

/// `_mark_read`: remember that `reader` has seen the thread now (the caller commits).
async fn mark_read_of(session: &Session, thread_id: &str, reader: &str) -> Result<()> {
    let mark = docs_comment_read::Entity::find()
        .filter(docs_comment_read::Column::ThreadId.eq(thread_id))
        .filter(docs_comment_read::Column::Reader.eq(reader))
        .one(session)
        .await?;
    match mark {
        None => {
            let mut row = docs_comment_read::new();
            row.thread_id = Set(thread_id.to_string());
            row.reader = Set(reader.to_string());
            row.insert(session).await?;
        }
        Some(mark) => {
            let mut update = kb_db::edit(mark);
            update.read_at = Set(time::now_iso());
            update.update(session).await?;
        }
    }
    Ok(())
}

/// Mark a thread as read by the caller (clears its unread dot).
pub async fn mark_read(session: &Session, thread_id: &str) -> Result<Map<String, Value>> {
    let row = thread(session, thread_id).await?;
    mark_read_of(session, &row.id, &activity::current_actor()).await?;
    session.commit().await?;
    one(session, &row).await
}
