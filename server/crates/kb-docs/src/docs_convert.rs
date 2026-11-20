//! Converting pages written in Markdown to the Rich Docs format (format 1).
//!
//! Runs in the background, page by page, and can stop and start again at any point (each page is one transaction,
//! and its state is kept in `docs_page.convert_state`: `waiting`, `working`, `done` or `failed`). For each page:
//!
//! - the latest published version, when it is Markdown, is converted and published again as a new version with the
//!   note "Converted from Markdown" by "Kanban Board" (older versions stay Markdown and readable);
//! - every Markdown draft is converted in place (a draft started from the converted version follows it, so it does not
//!   meet a false conflict);
//! - the page links and headings are counted before and after; a page whose counts differ, or whose conversion fails,
//!   is marked `failed` with the reason and keeps its Markdown, read-only.
//!
//! Pages in the Recycle Bin are converted too, so that restoring one needs nothing. Canvas pages stay as they are.

use std::panic::{AssertUnwindSafe, catch_unwind};

use kb_db::Session;
use kb_db::entities::{docs_draft, docs_page, docs_version};
use kb_db::sea_orm::{ColumnTrait, EntityTrait, QueryFilter, QueryOrder, Set};
use kb_doctext::docs_text::{Reference, heading_anchors, parse_references};
use kb_richdoc::RandomIds;

use crate::Result;
use crate::docs::versions::{commit_version, set_draft_body};
use crate::docs::{PageBody, latest_version};

/// Who the conversion version is written by.
pub const CONVERTER: &str = "Kanban Board";
/// The note of the conversion version.
pub const CONVERTED_NOTE: &str = "Converted from Markdown";

/// What one run did.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct ConvertReport {
    /// Pages converted.
    pub done: usize,
    /// Pages that could not be converted (kept in Markdown, read-only).
    pub failed: usize,
}

/// The links and headings of a Markdown text that must survive the conversion.
fn counts(markdown: &str) -> (usize, usize) {
    let links = parse_references(markdown).into_iter().filter(|r| matches!(r, Reference::Page(_))).count();
    (links, heading_anchors(markdown).len())
}

/// Converts one Markdown text, checking that its page links and headings are all still there.
///
/// # Errors
/// The reason, in words, when the converter fails or a count differs.
pub fn convert_markdown(markdown: &str) -> std::result::Result<PageBody, String> {
    let body = catch_unwind(AssertUnwindSafe(|| PageBody::from_markdown(markdown, &mut RandomIds)))
        .map_err(|_| "The converter stopped on this page.".to_string())?;
    let (links_before, headings_before) = counts(markdown);
    let (links_after, headings_after) = counts(&body.markdown);
    if links_before != links_after {
        return Err(format!("Page links: {links_before} before, {links_after} after."));
    }
    if headings_before != headings_after {
        return Err(format!("Headings: {headings_before} before, {headings_after} after."));
    }
    Ok(body)
}

/// Marks every page that still has Markdown content as `waiting`; returns how many were marked.
///
/// # Errors
/// A database error.
pub async fn mark_waiting(session: &Session) -> Result<usize> {
    let pages = docs_page::Entity::find()
        .filter(docs_page::Column::ConvertState.is_null())
        .filter(docs_page::Column::Kind.ne("canvas"))
        .all(session)
        .await?;
    let mut marked = 0;
    for page in pages {
        if !needs_conversion(session, &page).await? {
            continue;
        }
        let mut row = kb_db::edit(page);
        row.convert_state = Set(Some("waiting".to_string()));
        row.update(session).await?;
        marked += 1;
    }
    session.commit().await?;
    Ok(marked)
}

async fn needs_conversion(session: &Session, page: &docs_page::Model) -> Result<bool> {
    if latest_version(session, page).await?.is_some_and(|v| v.format != "rich") {
        return Ok(true);
    }
    let md_drafts = docs_draft::Entity::find()
        .filter(docs_draft::Column::PageId.eq(page.id.as_str()))
        .filter(docs_draft::Column::Format.ne("rich"))
        .all(session)
        .await?;
    Ok(!md_drafts.is_empty())
}

/// Converts every `waiting` page (and any left `working` by a stop), one transaction per page.
///
/// # Errors
/// A database error (the page being converted stays `working` and is taken again next time).
pub async fn convert_waiting(session: &Session) -> Result<ConvertReport> {
    let mut report = ConvertReport::default();
    let pages = docs_page::Entity::find()
        .filter(docs_page::Column::ConvertState.is_in(["waiting", "working"]))
        .order_by_asc(docs_page::Column::CreatedAt)
        .all(session)
        .await?;
    for page in pages {
        let mut row = kb_db::edit(page.clone());
        row.convert_state = Set(Some("working".to_string()));
        let page = row.update(session).await?;
        session.commit().await?;
        match convert_page(session, page.clone()).await? {
            Ok(()) => report.done += 1,
            Err(reason) => {
                session.rollback().await?;
                let mut row = kb_db::edit(page);
                row.convert_state = Set(Some("failed".to_string()));
                row.convert_error = Set(Some(reason));
                row.update(session).await?;
                report.failed += 1;
            }
        }
        session.commit().await?;
    }
    Ok(report)
}

/// Converts one page inside the session's transaction. The outer `Err` is a database error; the inner one is why
/// the page cannot be converted (the caller rolls back and marks it failed).
async fn convert_page(session: &Session, mut page: docs_page::Model) -> Result<std::result::Result<(), String>> {
    let old_version = page.version;
    if let Some(latest) = latest_version(session, &page).await? {
        if latest.format != "rich" {
            let body = match convert_markdown(&latest.markdown) {
                Ok(body) => body,
                Err(reason) => return Ok(Err(reason)),
            };
            let title = latest.title.clone();
            commit_version(session, &mut page, &body, &title, CONVERTER, Some(CONVERTED_NOTE), None, false).await?;
        }
    }
    let drafts = docs_draft::Entity::find()
        .filter(docs_draft::Column::PageId.eq(page.id.as_str()))
        .filter(docs_draft::Column::Format.ne("rich"))
        .all(session)
        .await?;
    for draft in drafts {
        let body = match convert_markdown(&draft.markdown) {
            Ok(body) => body,
            Err(reason) => return Ok(Err(format!("A draft by {}: {reason}", draft.author))),
        };
        let base = draft.base_version;
        let mut row = kb_db::edit(draft);
        set_draft_body(&mut row, &body);
        if base == old_version && page.version != old_version {
            row.base_version = Set(page.version);
        }
        row.update(session).await?;
    }
    let mut row = kb_db::edit(page);
    row.convert_state = Set(Some("done".to_string()));
    row.convert_error = Set(None);
    row.update(session).await?;
    Ok(Ok(()))
}

/// Marks and converts every page that needs it; returns what was done.
///
/// # Errors
/// A database error.
pub async fn run(session: &Session) -> Result<ConvertReport> {
    mark_waiting(session).await?;
    convert_waiting(session).await
}

/// Whether a version is the one the conversion wrote.
pub fn is_conversion(v: &docs_version::Model) -> bool {
    v.author == CONVERTER && v.note.as_deref() == Some(CONVERTED_NOTE)
}

/// Tries a failed page again (an admin's "Try again"): back to `waiting`, then converted.
///
/// # Errors
/// A database error.
pub async fn retry(session: &Session, page_id: &str) -> Result<ConvertReport> {
    if let Some(page) = docs_page::Entity::find_by_id(page_id).one(session).await? {
        if page.convert_state.as_deref() == Some("failed") {
            let mut row = kb_db::edit(page);
            row.convert_state = Set(Some("waiting".to_string()));
            row.convert_error = Set(None);
            row.update(session).await?;
            session.commit().await?;
        }
    }
    convert_waiting(session).await
}
