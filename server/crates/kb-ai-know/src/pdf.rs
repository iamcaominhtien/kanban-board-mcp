//! PDF text (`pypdf.PdfReader(path).pages[i].extract_text()` joined with a blank line, `kb.pdf_text`).

use std::path::Path;

/// The text of every page joined with a blank line (`"\n\n".join(page.extract_text() or "" ...)`), read with the
/// `pdf-extract` crate (its own content-stream interpreter with a text layout). It was chosen over `lopdf`'s plain
/// extraction, which returned a few characters for the repository's slide PDFs where `pypdf` finds thousands; the
/// measured differences from `pypdf` are in the report of the task that ported this module.
pub fn extract(path: &Path) -> Result<String, String> {
    let bytes = std::fs::read(path).map_err(|e| e.to_string())?;
    // the crate panics on some broken files: that is a PDF with no text here
    let pages = std::panic::catch_unwind(|| pages_of(&bytes)).map_err(|_| "the PDF reader panicked".to_string())??;
    let pages: Vec<String> = pages.iter().map(|page| tidy(page)).collect();
    Ok(pages.join("\n\n"))
}

/// The text of each page, in order. A page the reader cannot interpret has no text (`extract_text() or ""`); the crate's
/// own `extract_text_from_mem_by_pages` would stop at the first such page and drop the rest.
fn pages_of(bytes: &[u8]) -> Result<Vec<String>, String> {
    let mut doc = pdf_extract::Document::load_mem(bytes).map_err(|e| e.to_string())?;
    if doc.is_encrypted() {
        // pypdf cannot read an encrypted PDF without a password either: an empty password is its first try
        doc.decrypt("").map_err(|e| e.to_string())?;
    }
    let mut out = Vec::new();
    for (number, _id) in doc.get_pages() {
        let mut page = String::new();
        let mut output = pdf_extract::PlainTextOutput::new(&mut page);
        let ok = pdf_extract::output_doc_page(&doc, &mut output, number).is_ok();
        out.push(if ok { page } else { String::new() });
    }
    Ok(out)
}

/// pdf-extract lays a page out with a blank line after every line and two before the first; pypdf breaks a line with one
/// newline. The blank lines carry no text, so they are folded to the line break pypdf writes.
fn tidy(page: &str) -> String {
    let mut out = String::with_capacity(page.len());
    let mut lines_pending = false;
    for c in page.trim_start_matches('\n').chars() {
        if c == '\n' {
            lines_pending = true;
        } else {
            if lines_pending {
                out.push('\n');
                lines_pending = false;
            }
            out.push(c);
        }
    }
    if lines_pending || !out.is_empty() {
        // a page that has text ends with its last line break
        out.push('\n');
    }
    out
}
