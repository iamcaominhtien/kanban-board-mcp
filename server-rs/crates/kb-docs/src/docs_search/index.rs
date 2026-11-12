//! Index maintenance (`services/docs_search.py` lines 40-235).

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};

use kb_db::Session;
use kb_db::entities::{canvas, docs_draft, docs_page};
use kb_db::sea_orm::sea_query::{Alias, Expr, ExprTrait, Query};
use kb_db::sea_orm::{ColumnTrait, ConnectionTrait, DbBackend, DbErr, EntityTrait, QueryFilter, QueryOrder, Value};
use kb_db::sql::statement;
use kb_doctext::docs_text::heading_anchors;

use crate::hooks;

/// The statement that makes the FTS table.
pub const CREATE_FTS: &str = "CREATE VIRTUAL TABLE IF NOT EXISTS docs_fts USING fts5(\
page_id UNINDEXED, project_id UNINDEXED, title, headings, body, tokenize = 'unicode61 remove_diacritics 2')";

/// `_fts_broken`: FTS5 is missing in this SQLite.
static FTS_BROKEN: AtomicBool = AtomicBool::new(false);

const INSERT_ROW: &str =
    "INSERT INTO docs_fts (page_id, project_id, title, headings, body) VALUES (?, ?, ?, ?, ?)";

/// Return the three columns indexed for a page: `(title, headings, body)`.
pub fn index_fields(title: &str, markdown: &str) -> (String, String, String) {
    let headings = heading_anchors(markdown).into_iter().map(|h| h.text).collect::<Vec<_>>().join("\n");
    (title.to_string(), headings, markdown.to_string())
}

/// Create the FTS table on a connection (migrations). False when FTS5 is unavailable.
pub async fn create_fts_sync<C: ConnectionTrait>(conn: &C) -> bool {
    conn.execute_unprepared(CREATE_FTS).await.is_ok()
}

async fn insert_row<C: ConnectionTrait>(
    conn: &C,
    page_id: &str,
    project_id: &str,
    fields: (String, String, String),
) -> Result<(), DbErr> {
    let values: Vec<Value> = vec![page_id.into(), project_id.into(), fields.0.into(), fields.1.into(), fields.2.into()];
    conn.execute_raw(statement(conn.get_database_backend(), INSERT_ROW, values)).await?;
    Ok(())
}

/// Index every live page from its latest version (or, if never published, its draft).
///
/// This is `backfill_sync`: what the database move calls after a copy into a SQLite file
/// (`kb_dbkit::hooks::DocsSearchHook::backfill`); works on a transaction or a session alike.
pub async fn backfill_sync<C: ConnectionTrait>(conn: &C) -> Result<(), DbErr> {
    let backend = conn.get_database_backend();
    let rows = conn
        .query_all_raw(statement(
            backend,
            "SELECT p.id, p.project_id, p.title, \
             COALESCE((SELECT v.markdown FROM docs_version v WHERE v.page_id = p.id \
             AND v.version = p.version), \
             (SELECT d.markdown FROM docs_draft d WHERE d.page_id = p.id LIMIT 1), '') \
             FROM docs_page p WHERE p.deleted_at IS NULL",
            Vec::<Value>::new(),
        ))
        .await?;
    conn.execute_unprepared("DELETE FROM docs_fts").await?;
    for row in rows {
        let pid: String = row.try_get_by_index(0)?;
        let project_id: String = row.try_get_by_index(1)?;
        let title: String = row.try_get_by_index(2)?;
        let markdown: Option<String> = row.try_get_by_index(3)?;
        insert_row(conn, &pid, &project_id, index_fields(&title, markdown.as_deref().unwrap_or(""))).await?;
    }
    Ok(())
}

/// Create `docs_fts` on first use (databases built without migrations) and report availability.
pub async fn ensure_fts(session: &Session) -> Result<bool, DbErr> {
    if FTS_BROKEN.load(Ordering::SeqCst) {
        return Ok(false);
    }
    if session.dialect() != "sqlite" {
        return Ok(false);
    }
    let exists = session
        .query_one_raw(statement(
            DbBackend::Sqlite,
            "SELECT 1 FROM sqlite_master WHERE name = 'docs_fts'",
            Vec::<Value>::new(),
        ))
        .await;
    match exists {
        Ok(Some(_)) => return Ok(true),
        Ok(None) => {}
        Err(_) => {
            FTS_BROKEN.store(true, Ordering::SeqCst);
            return Ok(false);
        }
    }
    if session.execute_unprepared(CREATE_FTS).await.is_err() {
        FTS_BROKEN.store(true, Ordering::SeqCst);
        return Ok(false);
    }
    rebuild_index(session).await?;
    Ok(true)
}

/// Markdown per page: the latest published version, else the oldest draft.
pub async fn contents(session: &Session, pages: &[docs_page::Model]) -> Result<HashMap<String, String>, DbErr> {
    let ids: Vec<String> = pages.iter().map(|p| p.id.clone()).collect();
    if ids.is_empty() {
        return Ok(HashMap::new());
    }
    let mut out: HashMap<String, String> = HashMap::new();
    // DocsVersion joined to DocsPage on (page_id == id and version == version)
    let select = Query::select()
        .column((Alias::new("docs_version"), Alias::new("page_id")))
        .column((Alias::new("docs_version"), Alias::new("markdown")))
        .from(Alias::new("docs_version"))
        .inner_join(
            Alias::new("docs_page"),
            Expr::col((Alias::new("docs_version"), Alias::new("page_id")))
                .equals((Alias::new("docs_page"), Alias::new("id")))
                .and(
                    Expr::col((Alias::new("docs_version"), Alias::new("version")))
                        .equals((Alias::new("docs_page"), Alias::new("version"))),
                ),
        )
        .and_where(Expr::col((Alias::new("docs_version"), Alias::new("page_id"))).is_in(ids.clone()))
        .to_owned();
    for row in session.query_all(&select).await? {
        let pid: String = row.try_get_by_index(0)?;
        let markdown: String = row.try_get_by_index(1)?;
        out.insert(pid, markdown);
    }
    let missing: Vec<String> = ids.iter().filter(|i| !out.contains_key(*i)).cloned().collect();
    if !missing.is_empty() {
        let drafts = docs_draft::Entity::find()
            .filter(docs_draft::Column::PageId.is_in(missing))
            .order_by_asc(docs_draft::Column::UpdatedAt)
            .all(session)
            .await?;
        for d in drafts {
            out.entry(d.page_id).or_insert(d.markdown);
        }
    }
    canvas_outline(session, pages, &mut out).await?;
    Ok(out)
}

/// A canvas page has the boards of its canvas as sections, so `[[Settings flow#Sign in]]` and the `[[` suggester
/// ("INSIDE A CANVAS: Login redesign > Sign in") find them like headings.
async fn canvas_outline(session: &Session, pages: &[docs_page::Model], out: &mut HashMap<String, String>) -> Result<(), DbErr> {
    let ids: Vec<String> = pages.iter().filter(|p| p.kind == "canvas").map(|p| p.id.clone()).collect();
    if ids.is_empty() {
        return Ok(());
    }
    let Some(hook) = hooks::canvases() else { return Ok(()) };
    let rows = canvas::Entity::find()
        .filter(canvas::Column::PageId.is_in(ids))
        .filter(canvas::Column::DeletedAt.is_null())
        .all(session)
        .await?;
    for c in rows {
        let Some(names) = hook.board_names(&c.id).await else { continue };
        let outline = names.iter().map(|n| format!("## {}", n.replace('\n', " "))).collect::<Vec<_>>().join("\n\n");
        let Some(page_id) = c.page_id else { continue };
        let existing = out.get(&page_id).cloned().unwrap_or_default();
        out.insert(page_id, kb_base::pytext::strip(&format!("{existing}\n\n{outline}")).to_string());
    }
    Ok(())
}

/// (Re)write the index rows of these pages; deleted or missing pages are removed.
pub async fn reindex(session: &Session, page_ids: &[String]) -> Result<(), DbErr> {
    if page_ids.is_empty() || !ensure_fts(session).await? {
        return Ok(());
    }
    let mut pages = Vec::new();
    for pid in page_ids {
        if let Some(page) = docs_page::Entity::find_by_id(pid.as_str()).one(session).await? {
            if page.deleted_at.is_none() {
                pages.push(page);
            }
        }
    }
    unindex(session, page_ids).await?;
    let contents = contents(session, &pages).await?;
    for page in &pages {
        let fields = index_fields(&page.title, contents.get(&page.id).map(String::as_str).unwrap_or(""));
        insert_row(session, &page.id, &page.project_id, fields).await?;
    }
    Ok(())
}

/// Remove pages from the search index.
pub async fn unindex(session: &Session, page_ids: &[String]) -> Result<(), DbErr> {
    if page_ids.is_empty() || !ensure_fts(session).await? {
        return Ok(());
    }
    let stmt = Query::delete()
        .from_table(Alias::new("docs_fts"))
        .and_where(Expr::col(Alias::new("page_id")).is_in(page_ids.to_vec()))
        .to_owned();
    session.execute(&stmt).await?;
    Ok(())
}

/// Re-create every index row from the pages table.
pub async fn rebuild_index(session: &Session) -> Result<(), DbErr> {
    session.execute_unprepared("DELETE FROM docs_fts").await?;
    let pages = docs_page::Entity::find().filter(docs_page::Column::DeletedAt.is_null()).all(session).await?;
    let contents = contents(session, &pages).await?;
    for page in &pages {
        let fields = index_fields(&page.title, contents.get(&page.id).map(String::as_str).unwrap_or(""));
        insert_row(session, &page.id, &page.project_id, fields).await?;
    }
    Ok(())
}
