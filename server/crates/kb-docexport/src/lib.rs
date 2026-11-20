//! Rich Docs export: renders TipTap pages (`server/contract/richdoc/schema.json`) to HTML, Markdown, Word and PDF.
//!
//! The crate is the rendering core only: it never reads the database or the disk. The caller collects the pages
//! ([`ExportPage`]), implements [`AssetSource`] to hand over the bytes of uploads and drawings, and stores or zips
//! the files it gets back. Every renderer is synchronous and may be slow on big pages, so call it from
//! `spawn_blocking`.
//!
//! - [`render_html`]: one self-contained file or a folder (`index.html` + `assets/`), page theme or plain.
//! - [`render_markdown`]: one `.md` file per page (or one for a book), pictures in `images/`, inline or as links.
//! - [`render_docx`]: a Word file with real styles (Title, Heading 1-6, Quote, Code, Caption…).
//! - [`render_pdf`]: prints the HTML of [`render_html`] with a headless Chromium.
//! - [`estimate_size`]: a rough size, so the caller can refuse an export that is too big before rendering it.

mod assets;
mod docx;
mod html;
mod inline;
mod lang;
mod markdown;
mod math;
pub use math::equation_page;
mod model;
mod pdf;
mod site;
mod size;

pub use assets::{Asset, AssetSource, DrawingKind, NoAssets};
pub use docx::{DocxLook, DocxOptions, render_docx};
pub use html::{HtmlLayout, HtmlLook, HtmlOptions, HtmlOutput, render_html};
pub use markdown::{MarkdownEmbeds, MarkdownImages, MarkdownOptions, render_markdown};
pub use model::{
    Book, ExportFormat, ExportPage, HeaderFooter, Highlight, HighlightMode, Margins, Orientation, OutFile, PageSetup,
    PageSize, TableOfContents,
};
pub use pdf::{PdfOptions, find_browser, render_pdf};
pub use site::SiteFile;
pub use size::{SIZE_LIMIT, estimate_size, estimate_size_with};

/// An export that could not be produced.
#[derive(Debug, thiserror::Error)]
pub enum ExportError {
    /// No Chromium, Chrome or Edge was found to print the PDF.
    #[error(
        "No browser to print the PDF: install Chromium, Google Chrome or Microsoft Edge, or set KANBAN_CHROME to its path"
    )]
    NoBrowser,
    /// The browser did not finish printing in time and was stopped.
    #[error("The browser did not finish the PDF within {0} seconds")]
    Timeout(u64),
    /// The browser ran but gave no PDF; holds the end of what it printed on stderr.
    #[error("The browser could not print the PDF: {0}")]
    Browser(String),
    /// Writing the temporary files or starting the browser failed.
    #[error("Export I/O error: {0}")]
    Io(#[from] std::io::Error),
}
