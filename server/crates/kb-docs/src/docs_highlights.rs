//! Shared highlights while reading (design board "Reader", section K): an annotation layer over a page, not page
//! text. A highlight creates no version, is shown to everyone who can read the page, and survives edits: it is
//! anchored by block id, character offsets in that block's text (`textContent`, text nodes only) and the quote.
//!
//! Who adds: people who may comment (not Viewers); never AI teams, which only read them. Who removes: the author
//! their own; editors and admins any; admins can clear all of a page. Removing is a soft delete, so Undo restores.
//! Limits: 200 per person and 500 per page. Switches: the project default (`highlights`) and the page's
//! (`settings.highlights`).

use chrono::Utc;
use kb_base::{activity, events, time};
use kb_db::Session;
use kb_db::entities::{docs_highlight, docs_page};
use kb_db::sea_orm::{ActiveModelTrait, ColumnTrait, EntityTrait, QueryFilter, QueryOrder, Set};
use kb_doctext::docs_access;
use serde_json::{Map, Value, json};

use crate::docs::settings::read_settings;
use crate::docs::{BodyInput, PageBody, draft_for, get_page, latest_version, project, save_draft};
use crate::{Result, docs_err};

/// Most highlights one person can have on a page.
pub const MAX_PER_PERSON: usize = 200;
/// Most highlights on a page, all people together.
pub const MAX_PER_PAGE: usize = 500;
/// Longest quote kept, in characters.
pub const MAX_QUOTE: usize = 2000;
/// The highlight colours (the palette's highlight names).
pub const COLORS: [&str; 12] =
    ["yellow", "lime", "green", "teal", "blue", "violet", "pink", "red", "orange", "sand", "grey", "slate"];

/// What a reader sends to highlight a passage.
#[derive(Debug, Clone, serde::Deserialize)]
pub struct HighlightNew {
    /// The block the passage starts in.
    pub block_id: String,
    /// The block it ends in, when it runs across blocks.
    #[serde(default)]
    pub end_block_id: Option<String>,
    /// Start offset in the first block's text.
    pub start: i32,
    /// End offset (in the last block's text).
    pub end: i32,
    /// The words highlighted.
    pub quote: String,
    /// A few words before (for re-anchoring).
    #[serde(default)]
    pub prefix: Option<String>,
    /// A few words after.
    #[serde(default)]
    pub suffix: Option<String>,
    /// A highlight colour name.
    pub color: String,
}

/// Who the caller is on the page: (`role`, may add, may remove others').
async fn caller(session: &Session, page: &docs_page::Model) -> Result<(String, bool, bool)> {
    let project = project(session, &page.project_id, false).await?;
    let members = docs_access::members_of(session, &project.id).await?;
    let me = activity::current_actor();
    let role = docs_access::role_in(&members, &me);
    let policy = if project.docs_edit_policy.is_empty() { "members" } else { project.docs_edit_policy.as_str() };
    let can_comment = role != "viewer";
    let can_edit = docs_access::can_edit(&role, policy);
    Ok((role, can_comment, can_edit))
}

/// Whether highlights are on for a page, and why not (`None` when on).
async fn switched_off(session: &Session, page: &docs_page::Model) -> Result<Option<&'static str>> {
    let project = project(session, &page.project_id, false).await?;
    if crate::docs::space::read(&project).get("highlights").and_then(Value::as_str) == Some("off") {
        return Ok(Some("Highlights are off for this project."));
    }
    if read_settings(page.settings.as_deref()).get("highlights").and_then(Value::as_str) == Some("off") {
        return Ok(Some("Highlights are off for this page."));
    }
    Ok(None)
}

fn highlight_json(h: &docs_highlight::Model, me: &str, can_remove_any: bool) -> Value {
    json!({
        "id": h.id,
        "block_id": h.block_id,
        "end_block_id": h.end_block_id,
        "start": h.start_offset,
        "end": h.end_offset,
        "quote": h.quote,
        "prefix": h.prefix,
        "suffix": h.suffix,
        "color": h.color,
        "author": h.author,
        "created_at": h.created_at,
        "thread_id": h.thread_id,
        "state": h.state,
        "mine": h.author == me,
        "can_remove": h.author == me || can_remove_any,
    })
}

async fn live(session: &Session, page_id: &str) -> Result<Vec<docs_highlight::Model>> {
    Ok(docs_highlight::Entity::find()
        .filter(docs_highlight::Column::PageId.eq(page_id))
        .filter(docs_highlight::Column::DeletedAt.is_null())
        .order_by_asc(docs_highlight::Column::CreatedAt)
        .all(session)
        .await?)
}

async fn announce(page_id: &str) {
    events::publish(&json!({"type": "docs_highlights", "page_id": page_id}).to_string(), &[]).await;
}

/// The highlights of a page: `{enabled, reason, can_add, highlights}`.
///
/// # Errors
/// The page errors (404, 410, 403).
pub async fn list(session: &Session, page_id: &str) -> Result<Map<String, Value>> {
    let page = get_page(session, page_id, false, false).await?;
    let (role, can_comment, can_edit) = caller(session, &page).await?;
    let off = switched_off(session, &page).await?;
    let me = activity::current_actor();
    let rows = live(session, page_id).await?;
    let mut out = Map::new();
    out.insert("enabled".into(), json!(off.is_none()));
    out.insert("reason".into(), json!(off));
    out.insert("can_add".into(), json!(off.is_none() && can_comment));
    // "Clear all highlights on this page" is for admins only (board K 119); editors remove any one by one
    out.insert("can_clear".into(), json!(role == "admin"));
    out.insert("limits".into(), json!({"per_person": MAX_PER_PERSON, "per_page": MAX_PER_PAGE}));
    out.insert("highlights".into(), Value::Array(rows.iter().map(|h| highlight_json(h, &me, can_edit)).collect()));
    out.insert("removed".into(), Value::Array(recently_removed(session, page_id).await?));
    Ok(out)
}

/// How long a removal is reported to readers who had the highlight open ("removed while you read", board K 126).
const REMOVED_WINDOW_MINUTES: i64 = 15;

/// The highlights of a page removed in the last minutes: `{id, author, by}` (who made it, who removed it), so a
/// reader who was looking at one can be told who removed it.
async fn recently_removed(session: &Session, page_id: &str) -> Result<Vec<Value>> {
    let now = Utc::now();
    let rows = docs_highlight::Entity::find()
        .filter(docs_highlight::Column::PageId.eq(page_id))
        .filter(docs_highlight::Column::DeletedAt.is_not_null())
        .all(session)
        .await?;
    Ok(rows
        .iter()
        .filter(|h| {
            h.deleted_at
                .as_deref()
                .and_then(time::parse_iso)
                .is_some_and(|at| (now - at.utc()).num_minutes() < REMOVED_WINDOW_MINUTES)
        })
        .map(|h| json!({"id": h.id, "author": h.author, "by": h.deleted_by}))
        .collect())
}

/// Highlights a passage.
///
/// # Errors
/// 403 `viewers_cannot_highlight`, 403 `ai_cannot_highlight`, 409 `highlights_off`, 409 `limit_person` /
/// `limit_page`, 422 `bad_highlight` (colour, offsets, empty quote).
pub async fn add(session: &Session, page_id: &str, req: &HighlightNew) -> Result<Value> {
    let page = get_page(session, page_id, false, false).await?;
    if crate::hooks::ai_acting() {
        return docs_err(403, "ai_cannot_highlight", "AI teams read highlights; they never make them.");
    }
    let (_, can_comment, can_edit) = caller(session, &page).await?;
    if !can_comment {
        return docs_err(403, "viewers_cannot_highlight", "Viewers can read comments but cannot add them.");
    }
    if let Some(reason) = switched_off(session, &page).await? {
        return docs_err(409, "highlights_off", reason);
    }
    let quote = req.quote.trim();
    if quote.is_empty() || req.start < 0 || req.end < 0 || (req.end_block_id.is_none() && req.end <= req.start) {
        return docs_err(422, "bad_highlight", "Select some words to highlight");
    }
    if !COLORS.contains(&req.color.as_str()) {
        return docs_err(422, "bad_highlight", format!("'{}' is not a highlight colour", req.color));
    }
    let me = activity::current_actor();
    let rows = live(session, page_id).await?;
    if rows.len() >= MAX_PER_PAGE {
        return docs_err(409, "limit_page", format!("This page has {MAX_PER_PAGE} highlights, the most it can hold."));
    }
    if rows.iter().filter(|h| h.author == me).count() >= MAX_PER_PERSON {
        return docs_err(
            409,
            "limit_person",
            format!("You have {MAX_PER_PERSON} highlights on this page. Remove some to add more."),
        );
    }
    let mut row = docs_highlight::new();
    row.page_id = Set(page.id.clone());
    row.block_id = Set(req.block_id.clone());
    row.end_block_id = Set(req.end_block_id.clone().filter(|b| *b != req.block_id));
    row.start_offset = Set(req.start);
    row.end_offset = Set(req.end);
    row.quote = Set(quote.chars().take(MAX_QUOTE).collect());
    row.prefix =
        Set(req.prefix.as_deref().map(|p| p.chars().rev().take(64).collect::<Vec<_>>().into_iter().rev().collect()));
    row.suffix = Set(req.suffix.as_deref().map(|s| s.chars().take(64).collect()));
    row.color = Set(req.color.clone());
    row.author = Set(me.clone());
    let saved = row.insert(session).await?;
    session.commit().await?;
    announce(page_id).await;
    Ok(highlight_json(&saved, &me, can_edit))
}

async fn one(session: &Session, id: &str) -> Result<(docs_highlight::Model, docs_page::Model)> {
    let Some(h) = docs_highlight::Entity::find_by_id(id).one(session).await? else {
        return docs_err(404, "highlight_not_found", "Highlight not found");
    };
    let page = get_page(session, &h.page_id, false, false).await?;
    Ok((h, page))
}

/// Changes a highlight's colour, links its comment thread, or re-attaches it (`block_id`, `start`, `end`, `quote`:
/// "Re-attach" / "Use the new quote"). Only its author; linking the first comment thread written on it (`thread_id`
/// alone, while it has none) is open to everyone who may comment, since anyone can comment on anyone's highlight.
///
/// # Errors
/// 404, 403 `not_yours`, 422 `bad_highlight`.
pub async fn update(session: &Session, id: &str, changes: &Map<String, Value>) -> Result<Value> {
    let (h, page) = one(session, id).await?;
    let me = activity::current_actor();
    let (_, can_comment, can_edit) = caller(session, &page).await?;
    let links_thread = changes.len() == 1
        && h.thread_id.is_none()
        && changes.get("thread_id").is_some_and(Value::is_string)
        && can_comment
        && !crate::hooks::ai_acting();
    if h.author != me && !links_thread {
        return docs_err(403, "not_yours", "Only the person who made a highlight can change it.");
    }
    let mut row = kb_db::edit(h);
    for (k, v) in changes {
        match (k.as_str(), v) {
            ("color", Value::String(c)) if COLORS.contains(&c.as_str()) => row.color = Set(c.clone()),
            ("thread_id", t) => row.thread_id = Set(t.as_str().map(str::to_string)),
            ("block_id", Value::String(b)) => {
                row.block_id = Set(b.clone());
                row.state = Set("ok".into());
            }
            ("end_block_id", b) => row.end_block_id = Set(b.as_str().map(str::to_string)),
            ("start", n) if n.as_i64().is_some_and(|n| n >= 0) => {
                row.start_offset = Set(n.as_i64().unwrap_or(0) as i32)
            }
            ("end", n) if n.as_i64().is_some_and(|n| n >= 0) => row.end_offset = Set(n.as_i64().unwrap_or(0) as i32),
            ("quote", Value::String(q)) if !q.trim().is_empty() => {
                row.quote = Set(q.trim().chars().take(MAX_QUOTE).collect());
                row.state = Set("ok".into());
            }
            _ => return docs_err(422, "bad_highlight", format!("Cannot set '{k}' to {v}")),
        }
    }
    let saved = row.update(session).await?;
    session.commit().await?;
    announce(&saved.page_id).await;
    Ok(highlight_json(&saved, &me, can_edit))
}

/// Removes a highlight (soft: `restore` brings it back): the author their own, editors and admins any.
///
/// # Errors
/// 404, 403 `not_yours`.
pub async fn remove(session: &Session, id: &str) -> Result<Value> {
    let (h, page) = one(session, id).await?;
    let me = activity::current_actor();
    let (_, _, can_edit) = caller(session, &page).await?;
    if h.author != me && !can_edit {
        return docs_err(403, "not_yours", "Only its author or an editor can remove a highlight.");
    }
    let mut row = kb_db::edit(h);
    row.deleted_at = Set(Some(time::now_iso()));
    row.deleted_by = Set(Some(me.clone()));
    let saved = row.update(session).await?;
    session.commit().await?;
    announce(&saved.page_id).await;
    Ok(json!({"id": saved.id, "removed": true}))
}

/// Brings removed highlights back (Undo): the ids of a page, removed by the caller.
///
/// # Errors
/// The page errors.
pub async fn restore(session: &Session, page_id: &str, ids: &[String]) -> Result<Map<String, Value>> {
    get_page(session, page_id, false, false).await?;
    let me = activity::current_actor();
    let rows = docs_highlight::Entity::find()
        .filter(docs_highlight::Column::PageId.eq(page_id))
        .filter(docs_highlight::Column::Id.is_in(ids.iter().map(String::as_str)))
        .filter(docs_highlight::Column::DeletedBy.eq(me.as_str()))
        .all(session)
        .await?;
    for h in rows {
        let mut row = kb_db::edit(h);
        row.deleted_at = Set(None);
        row.deleted_by = Set(None);
        row.update(session).await?;
    }
    session.commit().await?;
    announce(page_id).await;
    list(session, page_id).await
}

/// Removes highlights of a page in bulk: the caller's own (`Mine`) or everybody's (admins: "Clear all highlights on
/// this page"). Returns `{removed: n, by_person: {name: n}, ids}` for the confirm and Undo.
///
/// # Errors
/// 403 `admins_only` when someone who is not an admin clears everybody's.
pub async fn clear(session: &Session, page_id: &str, scope: ClearScope) -> Result<Value> {
    let page = get_page(session, page_id, false, false).await?;
    let me = activity::current_actor();
    let (role, _, _) = caller(session, &page).await?;
    if scope == ClearScope::Everyone && role != "admin" {
        return docs_err(403, "admins_only", "Only admins can clear all highlights on a page.");
    }
    let now = time::now_iso();
    let mut by_person: Map<String, Value> = Map::new();
    let mut ids = Vec::new();
    for h in live(session, page_id).await? {
        if scope == ClearScope::Mine && h.author != me {
            continue;
        }
        let n = by_person.get(&h.author).and_then(Value::as_u64).unwrap_or(0) + 1;
        by_person.insert(h.author.clone(), json!(n));
        ids.push(h.id.clone());
        let mut row = kb_db::edit(h);
        row.deleted_at = Set(Some(now.clone()));
        row.deleted_by = Set(Some(me.clone()));
        row.update(session).await?;
    }
    session.commit().await?;
    announce(page_id).await;
    Ok(json!({"removed": ids.len(), "by_person": by_person, "ids": ids}))
}

/// Which highlights `clear` removes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ClearScope {
    /// The caller's own ("Remove all mine").
    Mine,
    /// Everybody's ("Clear all highlights on this page", admins).
    Everyone,
}

/// The text of every block of a rich page by id (`textContent`: text nodes only).
fn block_texts(doc: &Value) -> std::collections::HashMap<String, String> {
    let mut out = std::collections::HashMap::new();
    fn text_of(node: &Value, buf: &mut String) {
        if let Some(t) = node.get("text").and_then(Value::as_str) {
            buf.push_str(t);
        }
        for child in node.get("content").and_then(Value::as_array).into_iter().flatten() {
            text_of(child, buf);
        }
    }
    fn walk(node: &Value, out: &mut std::collections::HashMap<String, String>) {
        if let Some(id) = node.get("attrs").and_then(|a| a.get("blockId")).and_then(Value::as_str) {
            let mut buf = String::new();
            text_of(node, &mut buf);
            out.insert(id.to_string(), buf);
        }
        for child in node.get("content").and_then(Value::as_array).into_iter().flatten() {
            walk(child, out);
        }
    }
    walk(doc, &mut out);
    out
}

/// Re-anchors a page's highlights after a publish: one whose words are still at its offsets stays; one whose words
/// moved inside its block follows them (`moved`); one whose words are gone is `changed` ("Passage changed").
///
/// # Errors
/// A database error.
pub async fn rematch(session: &Session, page: &docs_page::Model) -> Result<()> {
    let Some(latest) = latest_version(session, page).await? else { return Ok(()) };
    let Some(doc) = PageBody::of_version(&latest).content else { return Ok(()) };
    let texts = block_texts(&doc);
    let me = activity::current_actor();
    for h in live(session, &page.id).await? {
        if h.state == "becoming" {
            // "Add to the page": once the published text carries the words, the shared highlight goes
            if carried(&doc, &h) {
                let mut row = kb_db::edit(h);
                row.deleted_at = Set(Some(time::now_iso()));
                row.deleted_by = Set(Some(me.clone()));
                row.update(session).await?;
            }
            continue;
        }
        let text = texts.get(&h.block_id);
        let chars: Vec<char> = text.map(|t| t.chars().collect()).unwrap_or_default();
        let (s, e) = (h.start_offset.max(0) as usize, h.end_offset.max(0) as usize);
        let whole = h.end_block_id.is_none();
        let at_place = whole && e <= chars.len() && s < e && chars[s..e].iter().collect::<String>() == h.quote;
        let (state, start, end) = if text.is_none() {
            ("changed".to_string(), h.start_offset, h.end_offset)
        } else if at_place || !whole {
            (if h.state == "changed" { "ok".to_string() } else { h.state.clone() }, h.start_offset, h.end_offset)
        } else if let Some(byte) = text.and_then(|t| t.find(&h.quote)) {
            let start = text.map(|t| t[..byte].chars().count()).unwrap_or(0) as i32;
            ("moved".to_string(), start, start + h.quote.chars().count() as i32)
        } else {
            ("changed".to_string(), h.start_offset, h.end_offset)
        };
        if state != h.state || start != h.start_offset || end != h.end_offset {
            let mut row = kb_db::edit(h);
            row.state = Set(state);
            row.start_offset = Set(start);
            row.end_offset = Set(end);
            row.update(session).await?;
        }
    }
    Ok(())
}

/// Turns a shared highlight into page text ("Add to the page", board K 92): the words get a highlight mark of the
/// same colour in the caller's draft (an edit: readers see it when the page is published). The shared highlight
/// stays, marked `becoming` ("Becoming page text"), until a publish carries the words; its comments stay. Discarding
/// the draft makes it a plain shared highlight again.
///
/// # Errors
/// 403 `ai_cannot_highlight`, 403 `edit_needed` (people who cannot edit the page), 409 `highlights_off`, 409
/// `not_rich` (a Markdown page), 409 `passage_changed` (its words are not in the page any more), and the draft's own
/// errors (409 `page_converting`).
pub async fn to_page(session: &Session, id: &str) -> Result<Value> {
    let (h, page) = one(session, id).await?;
    if crate::hooks::ai_acting() {
        return docs_err(403, "ai_cannot_highlight", "AI teams read highlights; they never make them.");
    }
    let (_, _, can_edit) = caller(session, &page).await?;
    if !can_edit {
        return docs_err(403, "edit_needed", "Needs edit rights. People who can only read do not get this option.");
    }
    if let Some(reason) = switched_off(session, &page).await? {
        return docs_err(409, "highlights_off", reason);
    }
    let me = activity::current_actor();
    let base = match draft_for(session, &page.id, &me).await? {
        Some(d) => PageBody::of_draft(&d).content,
        None => latest_version(session, &page).await?.and_then(|v| PageBody::of_version(&v).content),
    };
    let Some(mut doc) = base else {
        return docs_err(409, "not_rich", "Only a rich page can carry a highlight in its text.");
    };
    if !mark_passage(&mut doc, &h) {
        return docs_err(409, "passage_changed", "The highlighted words are not in the page any more.");
    }
    save_draft(session, &page.id, BodyInput::Content(&doc), None, None).await?;
    let mut row = kb_db::edit(h);
    row.state = Set("becoming".into());
    let saved = row.update(session).await?;
    session.commit().await?;
    announce(&saved.page_id).await;
    Ok(highlight_json(&saved, &me, can_edit))
}

/// Makes the page's `becoming` highlights plain shared highlights again (the draft that carried them was discarded).
///
/// # Errors
/// A database error.
pub async fn cancel_becoming(session: &Session, page_id: &str) -> Result<()> {
    let mut changed = false;
    for h in live(session, page_id).await?.into_iter().filter(|h| h.state == "becoming") {
        let mut row = kb_db::edit(h);
        row.state = Set("ok".into());
        row.update(session).await?;
        changed = true;
    }
    if changed {
        session.commit().await?;
        announce(page_id).await;
    }
    Ok(())
}

/// Every text node of a document in reading order, as characters, and where each block's text starts in it.
fn text_index(doc: &Value) -> (Vec<char>, std::collections::HashMap<String, usize>) {
    fn walk(node: &Value, text: &mut Vec<char>, starts: &mut std::collections::HashMap<String, usize>) {
        if let Some(id) = node.get("attrs").and_then(|a| a.get("blockId")).and_then(Value::as_str) {
            starts.insert(id.to_string(), text.len());
        }
        if let Some(t) = node.get("text").and_then(Value::as_str) {
            text.extend(t.chars());
        }
        for child in node.get("content").and_then(Value::as_array).into_iter().flatten() {
            walk(child, text, starts);
        }
    }
    let mut text = Vec::new();
    let mut starts = std::collections::HashMap::new();
    walk(doc, &mut text, &mut starts);
    (text, starts)
}

/// Where a highlight's words are in the document's text (`[start, end)` in characters), trusting the quote first:
/// the words at its offsets, else the same words nearest to them in its block, else nothing.
fn passage_of(doc: &Value, h: &docs_highlight::Model) -> Option<(usize, usize)> {
    let (text, starts) = text_index(doc);
    let block_start = *starts.get(&h.block_id)?;
    let block_text = block_texts(doc).get(&h.block_id).map(|t| t.chars().count()).unwrap_or(0);
    let (s, e) = (h.start_offset.max(0) as usize, h.end_offset.max(0) as usize);
    if let Some(end_block) = h.end_block_id.as_deref() {
        let end_start = *starts.get(end_block)?;
        let (gs, ge) = (block_start + s, end_start + e);
        let head: String = h.quote.split_whitespace().next().unwrap_or("").to_string();
        let at: String = text.get(gs..ge.min(text.len()))?.iter().collect();
        return (ge > gs && at.trim_start().starts_with(&head)).then_some((gs, ge));
    }
    let quote: Vec<char> = h.quote.chars().collect();
    if quote.is_empty() {
        return None;
    }
    let block: &[char] = text.get(block_start..block_start + block_text)?;
    if block.get(s..e) == Some(quote.as_slice()) {
        return Some((block_start + s, block_start + e));
    }
    let best = (0..block.len().saturating_sub(quote.len()) + 1)
        .filter(|i| block[*i..].starts_with(&quote))
        .min_by_key(|i| i.abs_diff(s))?;
    Some((block_start + best, block_start + best + quote.len()))
}

/// Puts a highlight mark of the highlight's colour on its words (splitting text nodes at the edges). False when the
/// words are not in the document.
fn mark_passage(doc: &mut Value, h: &docs_highlight::Model) -> bool {
    fn apply(node: &mut Value, pos: &mut usize, gs: usize, ge: usize, color: &str) {
        let Some(children) = node.get_mut("content").and_then(Value::as_array_mut) else { return };
        let mut out = Vec::with_capacity(children.len());
        for mut child in std::mem::take(children) {
            let Some(text) = child.get("text").and_then(Value::as_str).map(str::to_string) else {
                apply(&mut child, pos, gs, ge, color);
                out.push(child);
                continue;
            };
            let chars: Vec<char> = text.chars().collect();
            let (a, b) = (*pos, *pos + chars.len());
            *pos = b;
            if b <= gs || a >= ge {
                out.push(child);
                continue;
            }
            let s = gs.saturating_sub(a).min(chars.len());
            let e = (ge - a).min(chars.len());
            for (i, j, marked) in [(0, s, false), (s, e, true), (e, chars.len(), false)] {
                if i >= j {
                    continue;
                }
                let mut piece = child.clone();
                piece["text"] = json!(chars[i..j].iter().collect::<String>());
                if marked {
                    let mut marks: Vec<Value> = piece
                        .get("marks")
                        .and_then(Value::as_array)
                        .map(|m| m.iter().filter(|x| x.get("type") != Some(&json!("highlight"))).cloned().collect())
                        .unwrap_or_default();
                    marks.push(json!({"type": "highlight", "attrs": {"color": color}}));
                    piece["marks"] = Value::Array(marks);
                }
                out.push(piece);
            }
        }
        *children = out;
    }
    let Some((gs, ge)) = passage_of(doc, h) else { return false };
    let mut pos = 0;
    apply(doc, &mut pos, gs, ge, &h.color);
    true
}

/// Whether a published document carries a highlight's words as page text (a highlight mark on all of them).
fn carried(doc: &Value, h: &docs_highlight::Model) -> bool {
    fn walk(node: &Value, pos: &mut usize, gs: usize, ge: usize, ok: &mut bool) {
        if let Some(t) = node.get("text").and_then(Value::as_str) {
            let n = t.chars().count();
            let marked = node
                .get("marks")
                .and_then(Value::as_array)
                .is_some_and(|m| m.iter().any(|x| x.get("type") == Some(&json!("highlight"))));
            if *pos < ge && *pos + n > gs && !marked {
                *ok = false;
            }
            *pos += n;
        }
        for child in node.get("content").and_then(Value::as_array).into_iter().flatten() {
            walk(child, pos, gs, ge, ok);
        }
    }
    let Some((gs, ge)) = passage_of(doc, h) else { return false };
    let (mut pos, mut ok) = (0, true);
    walk(doc, &mut pos, gs, ge, &mut ok);
    ok
}

/// The highlights an AI team reads with a page (author, colour, quote and block; nothing else).
///
/// # Errors
/// A database error.
pub async fn for_ai(session: &Session, page_id: &str) -> Result<Vec<Value>> {
    Ok(live(session, page_id)
        .await?
        .iter()
        .map(|h| json!({"author": h.author, "color": h.color, "quote": h.quote, "block_id": h.block_id, "state": h.state}))
        .collect())
}
