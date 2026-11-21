//! Anchors across publishes and cleanup (`services/docs_comments.py` lines 749-868).

use kb_base::{activity, pyjson};
use kb_db::Session;
use kb_db::entities::{docs_comment, docs_comment_event, docs_comment_read, docs_comment_thread, docs_page};
use kb_db::sea_orm::ActiveModelTrait;
use kb_db::sea_orm::ActiveValue::Set;
use kb_db::sea_orm::{ColumnTrait, EntityTrait, QueryFilter};
use kb_doctext::docs_anchors::{self as anchors, Block, Carried, Change, Match};
use serde_json::{Map, Value, json};

use crate::Result;
use crate::docs::get_page;

/// Thread ids by outcome of [`rematch_page`].
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct Rematched {
    /// Their text is unchanged.
    pub attached: Vec<String>,
    /// Their text was edited or rewritten; they follow it.
    pub moved: Vec<String>,
    /// Their text was removed.
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

/// What a publish does to one inline thread's anchor.
enum Outcome {
    /// Attached at this text, after this change (`back` when an orphaned thread's text came back).
    Attached { change: Change, at: Match, back: bool },
    /// Its text is gone: where it was (`pos` in the new page text, `section`), and the new block after that spot.
    Removed { pos: Option<usize>, section: Option<String>, next_block: Option<usize> },
    /// An orphaned thread that stays orphaned.
    StillOrphaned,
    /// A comment on a whole block (an image, an embed) whose block is still there: left as it is.
    StillAttached,
}

/// Where a thread's anchor goes in the new page text.
///
/// An attached thread with a position is carried through the diff of the old and new text ([`anchors::carry_anchor`]);
/// one without (or whose position is stale) is looked for ([`anchors::relocate`]). An orphaned thread is attached
/// again only when its exact text is back (for example after restoring an older version).
fn place(t: &docs_comment_thread::Model, old: Option<&[Block]>, new: &[Block]) -> Outcome {
    let quote = t.anchor_quote.as_deref().unwrap_or("");
    let section = t.anchor_section.as_deref();
    if t.anchor_state == "orphaned" {
        return match anchors::relocate(new, quote, &t.anchor_prefix, &t.anchor_suffix, section, None) {
            Some(at) if at.exact => Outcome::Attached { change: Change::Kept, at, back: true },
            _ => Outcome::StillOrphaned,
        };
    }
    let pos = t.anchor_pos.and_then(|p| usize::try_from(p).ok());
    if let (Some(old), Some(pos)) = (old, pos) {
        match anchors::carry_anchor(old, new, pos, quote) {
            Some(Carried::Attached(change, at)) => return Outcome::Attached { change, at, back: false },
            Some(Carried::Removed { pos, section, next_block }) => {
                return Outcome::Removed { pos: Some(pos), section, next_block };
            }
            None => {}
        }
    }
    match anchors::relocate(new, quote, &t.anchor_prefix, &t.anchor_suffix, section, pos) {
        Some(at) => {
            let change = if at.exact { Change::Kept } else { Change::Edited };
            Outcome::Attached { change, at, back: false }
        }
        None => Outcome::Removed { pos: None, section: t.anchor_section.clone(), next_block: None },
    }
}

/// The top-level blocks of a rich page that can carry a comment: `(block id, plain text)`.
fn rich_blocks(content: &Value) -> Vec<(String, String)> {
    kb_richdoc::top_level_blocks(content)
        .into_iter()
        .filter(|b| b.get("type").and_then(Value::as_str) != Some("columns"))
        .filter_map(|b| {
            let id = b.get("attrs")?.get("blockId")?.as_str()?.to_string();
            let text = anchors::normalize(&kb_richdoc::doc_to_text(&json!({"type": "doc", "content": [b]})));
            Some((id, text))
        })
        .collect()
}

/// The rich block that holds `needle`: `current` when it still does, else the holder nearest `hint` (a share of the
/// way down the page, 0 to 1). `None` when no block holds it.
fn rich_block_for(blocks: &[(String, String)], needle: &str, current: Option<&str>, hint: f64) -> Option<String> {
    let needle = anchors::normalize(needle);
    if needle.is_empty() {
        return None;
    }
    if let Some(cur) = current {
        if blocks.iter().any(|(id, text)| id == cur && text.contains(&needle)) {
            return Some(cur.to_string());
        }
    }
    let n = blocks.len().max(1) as f64;
    blocks
        .iter()
        .enumerate()
        .filter(|(_, (_, text))| text.contains(&needle))
        .min_by(|(a, _), (b, _)| {
            let da = (*a as f64 / n - hint).abs();
            let db = (*b as f64 / n - hint).abs();
            da.total_cmp(&db)
        })
        .map(|(_, (id, _))| id.clone())
}

/// Where in the page text (an offset) the rich block `block_id` is: the start of the text block holding `quote` that
/// sits nearest the same share of the way down the page. `None` when the block or the quote is not there.
pub(crate) fn near_block(content: &Value, blocks: &[Block], block_id: &str, quote: &str) -> Option<usize> {
    let rich = rich_blocks(content);
    let at = rich.iter().position(|(id, _)| id == block_id)?;
    let share = at as f64 / rich.len().max(1) as f64;
    let quote = anchors::normalize(quote);
    let n = blocks.len().max(1) as f64;
    blocks
        .iter()
        .enumerate()
        .filter(|(_, b)| b.text.contains(&quote))
        .min_by(|(a, _), (b, _)| (*a as f64 / n - share).abs().total_cmp(&(*b as f64 / n - share).abs()))
        .map(|(_, b)| b.start)
}

/// The share of the way down the page of the new block holding offset `pos`.
fn share_of(new: &[Block], pos: usize) -> (f64, Option<usize>) {
    let n = new.iter().rposition(|b| b.start <= pos);
    (n.map(|n| n as f64 / new.len().max(1) as f64).unwrap_or(1.0), n)
}

/// The line written in a thread when a publish changed its text: `(body, change word)`.
fn note_for(outcome: &Outcome, version: i32) -> Option<(String, &'static str)> {
    match outcome {
        Outcome::Attached { back: true, .. } => Some((format!("Text back in v{version}"), "back")),
        Outcome::Attached { change: Change::Edited, .. } => Some((format!("Text edited in v{version}"), "edited")),
        Outcome::Attached { change: Change::Rewritten, .. } => {
            Some((format!("Text rewritten in v{version}"), "rewritten"))
        }
        Outcome::Removed { .. } => Some((format!("Text removed in v{version}"), "removed")),
        _ => None,
    }
}

/// Carry every inline thread's anchor from the previous published text to the new one (the caller commits).
///
/// `previous` is the Markdown of the version before (`None` for a first publish), `markdown` the new one and
/// `content` the new rich document (`None` for a Markdown page). Each anchor moves with the edit that touched its
/// text: unchanged text keeps it (of two identical paragraphs, the one it was on), edited text keeps it on the
/// edited words, rewritten text hands it to the text that replaced it, and removed text orphans it while keeping
/// where it was (`anchor_pos`, `anchor_section` and, on a rich page, the id of the block that now follows that spot).
/// On a rich page an attached thread's block id follows its text. Each change of a thread's text is recorded in the
/// thread as a line by the publisher (`ai.kind` `anchor`), which does not count as unread.
pub async fn rematch_page(
    session: &Session,
    page: &docs_page::Model,
    previous: Option<&str>,
    markdown: &str,
    content: Option<&Value>,
) -> Result<Rematched> {
    let old = previous.map(anchors::blocks_of);
    let new = anchors::blocks_of(markdown);
    let rich = content.map(rich_blocks);
    let actor = activity::current_actor();
    let mut result = Rematched::default();
    for t in inline_threads(session, &page.id).await? {
        let mut outcome = place(&t, old.as_deref(), &new);
        // a comment on a whole block (an image, an embed) stays on it while the block is there
        if let (Outcome::Removed { .. }, Some(rich), Some(id)) = (&outcome, &rich, &t.anchor_block_id) {
            if rich.iter().any(|(b, _)| b == id) {
                outcome = Outcome::StillAttached;
            }
        }
        let note = note_for(&outcome, page.version);
        let id = t.id.clone();
        let old_quote = t.anchor_quote.clone().unwrap_or_default();
        let current_block = t.anchor_block_id.clone();
        let mut update = kb_db::edit(t);
        match outcome {
            Outcome::StillOrphaned => continue,
            Outcome::StillAttached => {
                result.attached.push(id);
                continue;
            }
            Outcome::Removed { pos, section, next_block } => {
                update.anchor_state = Set("orphaned".to_string());
                update.anchor_pos = Set(pos.and_then(|p| i32::try_from(p).ok()));
                update.anchor_section = Set(section);
                if let Some(rich) = &rich {
                    // the block now at the spot, so the thread can show where its text was
                    let spot = next_block.or_else(|| new.len().checked_sub(1));
                    let found =
                        spot.and_then(|n| rich_block_for(rich, &new[n].text, None, n as f64 / new.len().max(1) as f64));
                    update.anchor_block_id = Set(found);
                }
                result.orphaned.push(id.clone());
            }
            Outcome::Attached { change, at, .. } => {
                if change == Change::Kept {
                    result.attached.push(id.clone());
                } else {
                    result.moved.push(id.clone());
                }
                if let Some(rich) = &rich {
                    let (hint, n) = share_of(&new, at.pos);
                    let found = rich_block_for(rich, &at.quote, current_block.as_deref(), hint)
                        .or_else(|| n.and_then(|n| rich_block_for(rich, &new[n].text, None, hint)));
                    if found.is_some() {
                        update.anchor_block_id = Set(found);
                    }
                }
                update.anchor_state = Set("attached".to_string());
                update.anchor_quote = Set(Some(at.quote));
                update.anchor_prefix = Set(at.prefix);
                update.anchor_suffix = Set(at.suffix);
                update.anchor_section = Set(at.section);
                update.anchor_pos = Set(Some(at.pos as i32));
            }
        }
        update.update(session).await?;
        if let Some((body, change)) = note {
            let mut line = docs_comment::new();
            line.thread_id = Set(id);
            line.author = Set(actor.clone());
            line.body = Set(body);
            line.ai = Set(Some(pyjson::dumps(
                &json!({"kind": "anchor", "change": change, "version": page.version, "quote": old_quote}),
            )));
            line.insert(session).await?;
        }
    }
    Ok(result)
}

/// Say which open threads would be orphaned if `markdown` were published, without changing anything.
///
/// The same carrying as [`rematch_page`], from the latest published text: text that was rewritten is not counted,
/// since its thread follows the new text.
pub async fn anchor_preview(session: &Session, page_id: &str, markdown: &str) -> Result<Map<String, Value>> {
    let page = get_page(session, page_id, false, false).await?;
    let latest = crate::docs::latest_version(session, &page).await?;
    let old = latest.as_ref().map(|v| anchors::blocks_of(&v.markdown));
    let new = anchors::blocks_of(markdown);
    let mut orphaned = Vec::new();
    for t in inline_threads(session, &page.id).await? {
        if t.status != "open" || t.anchor_state == "orphaned" {
            continue;
        }
        if matches!(place(&t, old.as_deref(), &new), Outcome::Removed { .. }) {
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
