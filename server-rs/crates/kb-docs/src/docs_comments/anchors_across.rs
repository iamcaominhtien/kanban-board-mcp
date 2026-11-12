//! Anchors across publishes and cleanup (`services/docs_comments.py` lines 749-868).

use kb_db::Session;
use kb_db::entities::{docs_comment, docs_comment_event, docs_comment_read, docs_comment_thread, docs_page};
use kb_db::sea_orm::ActiveValue::Set;
use kb_db::sea_orm::{ColumnTrait, EntityTrait, QueryFilter};
use kb_doctext::docs_anchors as anchors;
use serde_json::{Map, Value, json};

use crate::Result;
use crate::docs::get_page;

/// Thread ids by outcome of [`rematch_page`].
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct Rematched {
    /// Found where the text was (exact).
    pub attached: Vec<String>,
    /// Found with changed text.
    pub moved: Vec<String>,
    /// Not found.
    pub orphaned: Vec<String>,
}

/// `_inline_threads`.
async fn inline_threads(session: &Session, page_id: &str) -> Result<Vec<docs_comment_thread::Model>> {
    Ok(docs_comment_thread::Entity::find()
        .filter(docs_comment_thread::Column::PageId.eq(page_id))
        .filter(docs_comment_thread::Column::Kind.eq("inline"))
        .all(session)
        .await?)
}

/// Re-match every inline thread's anchor against new page text (the caller commits).
///
/// A match keeps the thread attached and refreshes its quote, context and position (so a thread follows moved or
/// slightly edited text). No match orphans it. An orphaned thread whose exact text is back (for example after
/// restoring an older version) is attached again.
pub async fn rematch_page(session: &Session, page: &docs_page::Model, markdown: &str) -> Result<Rematched> {
    let blocks = anchors::blocks_of(markdown);
    let mut result = Rematched::default();
    for t in inline_threads(session, &page.id).await? {
        let hit = anchors::find_anchor(
            &blocks,
            t.anchor_quote.as_deref().unwrap_or(""),
            &t.anchor_prefix,
            &t.anchor_suffix,
            t.anchor_section.as_deref(),
        );
        if t.anchor_state == "orphaned" && hit.as_ref().is_none_or(|h| !h.exact) {
            continue;
        }
        let id = t.id.clone();
        let mut update = kb_db::edit(t);
        match hit {
            None => {
                update.anchor_state = Set("orphaned".to_string());
                update.anchor_pos = Set(None);
                result.orphaned.push(id);
            }
            Some(hit) => {
                if hit.exact {
                    result.attached.push(id);
                } else {
                    result.moved.push(id);
                }
                update.anchor_state = Set("attached".to_string());
                update.anchor_quote = Set(Some(hit.quote));
                update.anchor_prefix = Set(hit.prefix);
                update.anchor_suffix = Set(hit.suffix);
                update.anchor_section = Set(hit.section);
                update.anchor_pos = Set(Some(hit.pos as i32));
            }
        }
        update.update(session).await?;
    }
    Ok(result)
}

/// Say which open threads would be orphaned if `markdown` were published, without changing anything.
pub async fn anchor_preview(session: &Session, page_id: &str, markdown: &str) -> Result<Map<String, Value>> {
    let page = get_page(session, page_id, false, false).await?;
    let blocks = anchors::blocks_of(markdown);
    let mut orphaned = Vec::new();
    for t in inline_threads(session, &page.id).await? {
        if t.status != "open" || t.anchor_state == "orphaned" {
            continue;
        }
        let hit = anchors::find_anchor(
            &blocks,
            t.anchor_quote.as_deref().unwrap_or(""),
            &t.anchor_prefix,
            &t.anchor_suffix,
            t.anchor_section.as_deref(),
        );
        if hit.is_none() {
            orphaned.push(json!({"id": t.id, "quote": t.anchor_quote}));
        }
    }
    let mut out = Map::new();
    let count = orphaned.len();
    out.insert("orphaned".into(), Value::Array(orphaned));
    out.insert("count".into(), json!(count));
    Ok(out)
}

/// Delete threads with their comments and read marks (the caller commits).
pub async fn delete_threads(session: &Session, thread_ids: &[String]) -> Result<()> {
    if thread_ids.is_empty() {
        return Ok(());
    }
    docs_comment::Entity::delete_many()
        .filter(docs_comment::Column::ThreadId.is_in(thread_ids.to_vec()))
        .exec(session)
        .await?;
    docs_comment_read::Entity::delete_many()
        .filter(docs_comment_read::Column::ThreadId.is_in(thread_ids.to_vec()))
        .exec(session)
        .await?;
    docs_comment_thread::Entity::delete_many()
        .filter(docs_comment_thread::Column::Id.is_in(thread_ids.to_vec()))
        .exec(session)
        .await?;
    Ok(())
}

/// Delete every thread, comment and event of pages that are being erased for good.
pub async fn delete_for_pages(session: &Session, page_ids: &[String]) -> Result<()> {
    if page_ids.is_empty() {
        return Ok(());
    }
    let threads: Vec<String> = docs_comment_thread::Entity::find()
        .filter(docs_comment_thread::Column::PageId.is_in(page_ids.to_vec()))
        .all(session)
        .await?
        .into_iter()
        .map(|t| t.id)
        .collect();
    delete_threads(session, &threads).await?;
    docs_comment_event::Entity::delete_many()
        .filter(docs_comment_event::Column::PageId.is_in(page_ids.to_vec()))
        .exec(session)
        .await?;
    Ok(())
}
