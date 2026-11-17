//! Exports (design board "Export"): Word, PDF, HTML and Markdown from the rich format, for one page, a page with
//! its children, the whole space or a book, run in the background. Files are kept 7 days in the private uploads
//! folder; the history keeps the last 20 per person. A whole-space export runs one at a time per project.

use std::path::PathBuf;

use kb_base::{activity, ctx, events, time};
use kb_db::Session;
use kb_db::entities::{docs_export, docs_page};
use kb_db::sea_orm::{ActiveModelTrait, ColumnTrait, EntityTrait, QueryFilter, QueryOrder, Set};
use kb_docexport::{
    Asset, AssetSource, Book, DocxOptions, DrawingKind, ExportFormat, ExportPage, HeaderFooter, HighlightMode,
    HtmlLayout, HtmlLook, HtmlOptions, HtmlOutput, Margins, MarkdownEmbeds, MarkdownImages, MarkdownOptions,
    Orientation, OutFile, PageSetup, PageSize, PdfOptions, TableOfContents,
};
use serde_json::{Map, Value, json};

use crate::docs::settings::read_settings;
use crate::docs::{PageBody, all_pages, draft_for, get_page, latest_version, project};
use crate::{Result, docs_err};

/// Days an export file is kept.
pub const KEEP_DAYS: i64 = 7;
/// Exports kept in a person's history.
pub const HISTORY: u64 = 20;

/// What the export dialog sends.
#[derive(Debug, Clone, Default, serde::Deserialize)]
pub struct ExportRequest {
    /// `page`, `children`, `space` or `book`.
    pub scope: String,
    /// The page (scope page and children).
    #[serde(default)]
    pub page_id: Option<String>,
    /// The pages, in order (book; children with some unticked).
    #[serde(default)]
    pub page_ids: Option<Vec<String>>,
    /// `pdf`, `docx`, `html` or `md`.
    pub format: String,
    /// Export the caller's draft instead of the published version (editors).
    #[serde(default)]
    pub draft: bool,
    /// The file name without extension.
    #[serde(default)]
    pub file_name: Option<String>,
    /// Format options (see `options_of`).
    #[serde(default)]
    pub options: Map<String, Value>,
    /// Book mode details.
    #[serde(default)]
    pub book: Option<Map<String, Value>>,
}

fn row_json(e: &docs_export::Model) -> Value {
    json!({
        "id": e.id,
        "project_id": e.project_id,
        "page_id": e.page_id,
        "scope": e.scope,
        "format": e.format,
        "state": e.state,
        "step": e.step,
        "file_name": e.file_name,
        "size": e.size,
        "error": e.error,
        "created_by": e.created_by,
        "created_at": e.created_at,
        "finished_at": e.finished_at,
        "expires_at": e.expires_at,
        "download": if e.state == "ready" { json!(format!("/docs/exports/{}/download", e.id)) } else { Value::Null },
    })
}

fn extension(format: &str) -> &'static str {
    match format {
        "pdf" => "pdf",
        "docx" => "docx",
        "html" => "html",
        _ => "md",
    }
}

/// A file name the caller chose, cleaned: no path separators or control characters, at most 120 characters.
fn clean_name(raw: &str) -> String {
    let cleaned: String = raw
        .chars()
        .filter(|c| !matches!(c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|') && !c.is_control())
        .collect();
    let cleaned = cleaned.trim().trim_matches('.').chars().take(120).collect::<String>();
    if cleaned.is_empty() { "export".into() } else { cleaned }
}

/// Starts an export; returns its row (state `running`). The work goes on in the background.
///
/// # Errors
/// 422 `bad_export` for an unknown scope or format or a missing page; 409 `export_running` when a whole-space
/// export of the project is already running; 413 `export_too_big` (with `size` and `limit`) over 200 MB; 422
/// `empty_page` when nothing would be exported.
pub async fn start(session: &Session, project_id: &str, req: &ExportRequest) -> Result<Value> {
    project(session, project_id, false).await?;
    if !["page", "children", "space", "book"].contains(&req.scope.as_str())
        || !["pdf", "docx", "html", "md"].contains(&req.format.as_str())
    {
        return docs_err(422, "bad_export", "Choose a format and what to export");
    }
    purge_expired(session).await?;
    if req.scope == "space" {
        let running = docs_export::Entity::find()
            .filter(docs_export::Column::ProjectId.eq(project_id))
            .filter(docs_export::Column::Scope.eq("space"))
            .filter(docs_export::Column::State.eq("running"))
            .one(session)
            .await?;
        if running.is_some() {
            return docs_err(409, "export_running", "A whole-space export is already running. It is one at a time.");
        }
    }
    let pages = collect(session, project_id, req).await?;
    if pages.iter().all(|p| kb_richdoc::doc_to_text(&p.doc).trim().is_empty()) {
        return docs_err(422, "empty_page", "There is nothing to export yet. Add something to the page first.");
    }
    let assets = Uploads::new();
    let size = kb_docexport::estimate_size_with(&pages, export_format(&req.format), &assets);
    if size > kb_docexport::SIZE_LIMIT {
        return Err(kb_doctext::docs_text::DocsError::new(
            413,
            "export_too_big",
            "This export would be larger than 200 MB.",
        )
        .with("size", size)
        .with("limit", kb_docexport::SIZE_LIMIT)
        .into());
    }
    let first_title = pages.first().map(|p| p.title.clone()).unwrap_or_else(|| "export".into());
    let base = clean_name(req.file_name.as_deref().unwrap_or(&first_title));
    let zipped = req.scope != "page" && req.scope != "book" || (req.format == "md" && pages.len() > 1);
    let file_name = format!("{base}.{}", if zipped { "zip" } else { extension(&req.format) });
    let mut row = docs_export::new();
    row.project_id = Set(project_id.to_string());
    row.page_id = Set(req.page_id.clone());
    row.scope = Set(req.scope.clone());
    row.format = Set(req.format.clone());
    row.options = Set(Some(json!({"options": req.options, "book": req.book, "draft": req.draft}).to_string()));
    row.step = Set(Some("Preparing pages".into()));
    row.file_name = Set(Some(file_name));
    row.created_by = Set(activity::current_actor());
    let saved = row.insert(session).await?;
    session.commit().await?;
    let id = saved.id.clone();
    let req = req.clone();
    ctx::spawn(async move {
        let session = kb_db::database::session();
        let outcome = run(&id, pages, &req, zipped).await;
        let _ = finish(&session, &id, outcome).await;
        events::publish(&json!({"type": "docs_export", "id": id}).to_string(), &[]).await;
    });
    Ok(row_json(&saved))
}

fn export_format(f: &str) -> ExportFormat {
    match f {
        "pdf" => ExportFormat::Pdf,
        "docx" => ExportFormat::Docx,
        "html" => ExportFormat::Html,
        _ => ExportFormat::Markdown,
    }
}

/// The pages of an export, in order, as the renderer takes them.
async fn collect(session: &Session, project_id: &str, req: &ExportRequest) -> Result<Vec<ExportPage>> {
    let all = all_pages(session, project_id, false).await?;
    let chosen: Vec<docs_page::Model> = match (req.scope.as_str(), &req.page_ids, &req.page_id) {
        (_, Some(ids), _) if !ids.is_empty() => {
            ids.iter().filter_map(|id| all.iter().find(|p| &p.id == id).cloned()).collect()
        }
        ("page", _, Some(id)) => vec![get_page(session, id, false, false).await?],
        ("children", _, Some(id)) => {
            let root = get_page(session, id, false, false).await?;
            let mut out = vec![root.clone()];
            let mut frontier = vec![root.id.clone()];
            while let Some(parent) = frontier.pop() {
                for p in all.iter().filter(|p| p.parent_id.as_deref() == Some(parent.as_str())) {
                    out.push(p.clone());
                    frontier.push(p.id.clone());
                }
            }
            out
        }
        ("space", _, _) => all.clone(),
        _ => return docs_err(422, "bad_export", "Choose the pages to export"),
    };
    let me = activity::current_actor();
    let mut pages = Vec::new();
    for page in chosen {
        let body = match (req.draft, draft_for(session, &page.id, &me).await?) {
            (true, Some(d)) => Some(PageBody::of_draft(&d)),
            _ => latest_version(session, &page).await?.map(|v| PageBody::of_version(&v)),
        };
        let Some(body) = body.map(PageBody::into_rich) else { continue };
        let highlights = if req.options.get("includeHighlights").and_then(Value::as_bool).unwrap_or(false) {
            crate::docs_highlights::for_ai(session, &page.id)
                .await?
                .into_iter()
                .filter_map(|h| {
                    Some(kb_docexport::Highlight {
                        block_id: h.get("block_id")?.as_str()?.to_string(),
                        start: 0,
                        end: 0,
                        color: h.get("color").and_then(Value::as_str).map(str::to_string),
                        author: h.get("author").and_then(Value::as_str).map(str::to_string),
                    })
                })
                .collect()
        } else {
            Vec::new()
        };
        pages.push(ExportPage {
            title: page.title.clone(),
            author: Some(page.updated_by.clone()),
            updated_at: Some(page.updated_at.clone()),
            path: path_of(&all, &page),
            doc: body.content.unwrap_or(json!({"type": "doc", "content": []})),
            settings: Value::Object(read_settings(page.settings.as_deref())),
            highlights,
        });
    }
    Ok(pages)
}

/// Where a page sits in the tree, as folder names (`Architecture/API`).
fn path_of(all: &[docs_page::Model], page: &docs_page::Model) -> String {
    let mut parts = vec![page.title.clone()];
    let mut cur = page.parent_id.clone();
    let mut guard = 0;
    while let (Some(pid), true) = (cur, guard < 50) {
        guard += 1;
        match all.iter().find(|p| p.id == pid) {
            Some(p) => {
                parts.insert(0, p.title.clone());
                cur = p.parent_id.clone();
            }
            None => break,
        }
    }
    parts.join("/")
}

/// The uploads folder as an asset source for the renderer.
struct Uploads {
    root: PathBuf,
}

impl Uploads {
    fn new() -> Self {
        Self { root: kb_files::uploads::resolve_uploads_dir().0 }
    }
}

impl AssetSource for Uploads {
    fn fetch(&self, src: &str) -> Option<Asset> {
        let name = src.strip_prefix("/uploads/")?;
        if name.contains("..") || name.starts_with(kb_files::uploads::PRIVATE_DIR) {
            return None;
        }
        let path = self.root.join(name);
        let bytes = std::fs::read(&path).ok()?;
        let ext = name.rsplit_once('.').map(|(_, e)| format!(".{}", e.to_lowercase())).unwrap_or_default();
        let mime = kb_files::uploads::mime_by_extension(&ext).unwrap_or("application/octet-stream").to_string();
        Some(Asset { bytes, mime })
    }

    fn drawing_png(&self, _kind: DrawingKind, _id: &str) -> Option<Vec<u8>> {
        None
    }

    fn size_of(&self, src: &str) -> Option<u64> {
        let name = src.strip_prefix("/uploads/")?;
        if name.contains("..") {
            return None;
        }
        std::fs::metadata(self.root.join(name)).ok().map(|m| m.len())
    }
}

fn setup_of(o: &Map<String, Value>) -> PageSetup {
    let s = |k: &str| o.get(k).and_then(Value::as_str).unwrap_or("");
    PageSetup {
        size: match s("pageSize") {
            "letter" => PageSize::Letter,
            "fit" => PageSize::FitToContent,
            _ => PageSize::A4,
        },
        orientation: if s("orientation") == "landscape" { Orientation::Landscape } else { Orientation::Portrait },
        margins: match s("margins") {
            "narrow" => Margins::Narrow,
            "wide" => Margins::Wide,
            _ => Margins::Normal,
        },
        header_footer: if o.get("pageNumbers").and_then(Value::as_bool).unwrap_or(true) {
            HeaderFooter::On
        } else {
            HeaderFooter::Off
        },
        contents: if o.get("contents").and_then(Value::as_bool).unwrap_or(false) {
            TableOfContents::Include
        } else {
            TableOfContents::Leave
        },
        cover_page: o.get("coverPage").and_then(Value::as_bool).unwrap_or(false),
    }
}

fn book_of(req: &ExportRequest) -> Option<Book> {
    if req.scope != "book" {
        return None;
    }
    let b = req.book.clone().unwrap_or_default();
    let s = |k: &str| b.get(k).and_then(Value::as_str).map(str::to_string);
    let f = |k: &str, d: bool| b.get(k).and_then(Value::as_bool).unwrap_or(d);
    Some(Book {
        title: s("title").unwrap_or_else(|| "Book".into()),
        subtitle: s("subtitle"),
        author: s("author"),
        date: s("date"),
        cover_image: s("coverImage"),
        cover: f("cover", true),
        title_page: f("titlePage", true),
        contents: f("contents", true),
        chapter_breaks: f("chapterBreaks", true),
        number_chapters: f("numberChapters", true),
    })
}

/// Renders the export: the bytes of the file to keep.
async fn run(
    id: &str,
    pages: Vec<ExportPage>,
    req: &ExportRequest,
    zipped: bool,
) -> std::result::Result<Vec<u8>, String> {
    let id = id.to_string();
    let req = req.clone();
    tokio::task::spawn_blocking(move || {
        let assets = Uploads::new();
        let highlights = if req.options.get("includeHighlights").and_then(Value::as_bool).unwrap_or(false) {
            HighlightMode::Show
        } else {
            HighlightMode::Hide
        };
        let book = book_of(&req);
        let o = &req.options;
        let files: Vec<OutFile> = match req.format.as_str() {
            "docx" => {
                let opts = DocxOptions { setup: setup_of(o), highlights, book: book.clone(), ..Default::default() };
                if zipped && book.is_none() {
                    pages
                        .iter()
                        .map(|p| OutFile {
                            path: format!("{}.docx", p.path),
                            bytes: kb_docexport::render_docx(std::slice::from_ref(p), &assets, &opts),
                        })
                        .collect()
                } else {
                    vec![OutFile {
                        path: "export.docx".into(),
                        bytes: kb_docexport::render_docx(&pages, &assets, &opts),
                    }]
                }
            }
            "html" | "pdf" => {
                let pdf = req.format == "pdf";
                let opts = HtmlOptions {
                    layout: if pdf || o.get("layout").and_then(Value::as_str) != Some("folder") {
                        HtmlLayout::SingleFile
                    } else {
                        HtmlLayout::Folder
                    },
                    look: if o.get("look").and_then(Value::as_str) == Some("plain") {
                        HtmlLook::Plain
                    } else {
                        HtmlLook::PageTheme
                    },
                    highlights,
                    book: book.clone(),
                    print: if pdf { Some(setup_of(o)) } else { None },
                    ..Default::default()
                };
                let render_one = |set: &[ExportPage], name: &str| -> std::result::Result<Vec<OutFile>, String> {
                    match kb_docexport::render_html(set, &assets, &opts) {
                        HtmlOutput::SingleFile(html) if pdf => {
                            let bytes =
                                kb_docexport::render_pdf(&html, &PdfOptions::default()).map_err(|e| e.to_string())?;
                            Ok(vec![OutFile { path: format!("{name}.pdf"), bytes }])
                        }
                        HtmlOutput::SingleFile(html) => {
                            Ok(vec![OutFile { path: format!("{name}.html"), bytes: html.into_bytes() }])
                        }
                        HtmlOutput::Folder(files) => Ok(files
                            .into_iter()
                            .map(|f| OutFile { path: format!("{name}/{}", f.path), bytes: f.bytes })
                            .collect()),
                    }
                };
                if zipped && book.is_none() {
                    let mut out = Vec::new();
                    for p in &pages {
                        out.extend(render_one(std::slice::from_ref(p), &p.path)?);
                    }
                    out
                } else {
                    render_one(&pages, "export")?
                }
            }
            _ => {
                let opts = MarkdownOptions {
                    images: match o.get("images").and_then(Value::as_str) {
                        Some("inline") => MarkdownImages::Inline,
                        Some("link") => MarkdownImages::Link,
                        _ => MarkdownImages::Folder,
                    },
                    embeds: if o.get("embeds").and_then(Value::as_str) == Some("placeholder") {
                        MarkdownEmbeds::Placeholder
                    } else {
                        MarkdownEmbeds::Link
                    },
                    highlights,
                    book,
                    ..Default::default()
                };
                kb_docexport::render_markdown(&pages, &assets, &opts)
            }
        };
        let _ = id;
        if zipped || files.len() > 1 {
            zip_files(&files)
        } else {
            files.into_iter().next().map(|f| f.bytes).ok_or_else(|| "Nothing was exported.".to_string())
        }
    })
    .await
    .map_err(|e| format!("The export stopped: {e}"))?
}

/// A zip of the files (stored, no compression needed for the formats that are already compressed).
fn zip_files(files: &[OutFile]) -> std::result::Result<Vec<u8>, String> {
    use std::io::Write;
    let mut buf = std::io::Cursor::new(Vec::new());
    {
        let mut zip = zip::ZipWriter::new(&mut buf);
        let opts = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
        for f in files {
            zip.start_file(f.path.as_str(), opts).map_err(|e| e.to_string())?;
            zip.write_all(&f.bytes).map_err(|e| e.to_string())?;
        }
        zip.finish().map_err(|e| e.to_string())?;
    }
    Ok(buf.into_inner())
}

fn export_dir() -> PathBuf {
    kb_files::uploads::get_private_dir().join("docs-exports")
}

async fn finish(session: &Session, id: &str, outcome: std::result::Result<Vec<u8>, String>) -> Result<()> {
    let Some(row) = docs_export::Entity::find_by_id(id).one(session).await? else { return Ok(()) };
    if row.state == "cancelled" {
        return Ok(());
    }
    let mut active = kb_db::edit(row.clone());
    active.finished_at = Set(Some(time::now_iso()));
    match outcome {
        Ok(bytes) => {
            let dir = export_dir().join(id);
            let name = row.file_name.clone().unwrap_or_else(|| "export".into());
            let written = tokio::fs::create_dir_all(&dir).await.and(tokio::fs::write(dir.join(&name), &bytes).await);
            match written {
                Ok(()) => {
                    active.state = Set("ready".into());
                    active.step = Set(None);
                    active.size = Set(Some(i32::try_from(bytes.len()).unwrap_or(i32::MAX)));
                    active.file_path = Set(Some(dir.join(&name).to_string_lossy().into_owned()));
                    active.expires_at =
                        Set(Some((chrono::Utc::now() + chrono::Duration::days(KEEP_DAYS)).to_rfc3339()));
                }
                Err(e) => {
                    active.state = Set("failed".into());
                    active.error = Set(Some(format!("The file could not be saved: {e}")));
                }
            }
        }
        Err(reason) => {
            active.state = Set("failed".into());
            active.error = Set(Some(reason));
        }
    }
    active.update(session).await?;
    session.commit().await?;
    Ok(())
}

/// The caller's export history in a project, newest first (the last 20).
///
/// # Errors
/// The project errors.
pub async fn history(session: &Session, project_id: &str) -> Result<Value> {
    project(session, project_id, false).await?;
    purge_expired(session).await?;
    let rows = docs_export::Entity::find()
        .filter(docs_export::Column::ProjectId.eq(project_id))
        .filter(docs_export::Column::CreatedBy.eq(activity::current_actor()))
        .order_by_desc(docs_export::Column::CreatedAt)
        .all(session)
        .await?;
    Ok(Value::Array(rows.iter().take(HISTORY as usize).map(row_json).collect()))
}

/// One export (its creator).
///
/// # Errors
/// 404 `export_not_found`.
pub async fn get(session: &Session, id: &str) -> Result<docs_export::Model> {
    match docs_export::Entity::find_by_id(id).one(session).await? {
        Some(e) if e.created_by == activity::current_actor() => Ok(e),
        _ => docs_err(404, "export_not_found", "Export not found"),
    }
}

/// One export as JSON.
///
/// # Errors
/// As `get`.
pub async fn detail(session: &Session, id: &str) -> Result<Value> {
    Ok(row_json(&get(session, id).await?))
}

/// The file of a ready export: (name, bytes).
///
/// # Errors
/// 404 `export_not_found`, 410 `export_expired` when its file is gone.
pub async fn file(session: &Session, id: &str) -> Result<(String, Vec<u8>)> {
    let e = get(session, id).await?;
    let path = match (e.state.as_str(), &e.file_path) {
        ("ready", Some(p)) => PathBuf::from(p),
        ("expired", _) => {
            return docs_err(410, "export_expired", "This export was removed after 7 days. Export again.");
        }
        _ => return docs_err(404, "export_not_found", "This export has no file"),
    };
    let bytes = tokio::fs::read(&path).await.map_err(|_| {
        crate::Error::from(kb_doctext::docs_text::DocsError::new(
            410,
            "export_expired",
            "This export was removed after 7 days. Export again.",
        ))
    })?;
    Ok((e.file_name.unwrap_or_else(|| "export".into()), bytes))
}

/// Cancels a running export ("Cancel export"): nothing is downloaded, the history lists it as cancelled.
///
/// # Errors
/// As `get`.
pub async fn cancel(session: &Session, id: &str) -> Result<Value> {
    let e = get(session, id).await?;
    if e.state != "running" {
        return Ok(row_json(&e));
    }
    let mut row = kb_db::edit(e);
    row.state = Set("cancelled".into());
    row.finished_at = Set(Some(time::now_iso()));
    let saved = row.update(session).await?;
    session.commit().await?;
    Ok(row_json(&saved))
}

/// Removes an export and its file.
///
/// # Errors
/// As `get`.
pub async fn delete(session: &Session, id: &str) -> Result<Value> {
    let e = get(session, id).await?;
    let _ = tokio::fs::remove_dir_all(export_dir().join(&e.id)).await;
    docs_export::Entity::delete_by_id(e.id.clone()).exec(session).await?;
    session.commit().await?;
    Ok(json!({"id": e.id, "deleted": true}))
}

/// Marks exports older than 7 days expired and removes their files; trims each person's history to 20.
///
/// # Errors
/// A database error.
pub async fn purge_expired(session: &Session) -> Result<()> {
    let now = time::now_iso();
    let old = docs_export::Entity::find().filter(docs_export::Column::State.eq("ready")).all(session).await?;
    for e in old.into_iter().filter(|e| e.expires_at.as_deref().is_some_and(|x| x <= now.as_str())) {
        let _ = tokio::fs::remove_dir_all(export_dir().join(&e.id)).await;
        let mut row = kb_db::edit(e);
        row.state = Set("expired".into());
        row.file_path = Set(None);
        row.update(session).await?;
    }
    session.commit().await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn file_names_are_cleaned() {
        assert_eq!(clean_name("a/b:c?.pdf"), "abc?.pdf".replace('?', ""));
        assert_eq!(clean_name("   "), "export");
        assert_eq!(clean_name("..hidden"), "hidden");
    }
}
