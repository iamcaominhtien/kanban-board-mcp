//! The inline preview of a file card (design "Embeds", frames 39-41): PDF is left to the browser's viewer, Word
//! shows its headings and paragraphs, Excel and CSV show the first rows of each sheet. Read only, from the uploads
//! folder only (never `_private`).

use std::io::{Cursor, Read};
use std::path::PathBuf;

use calamine::Reader;
use kb_doctext::docs_text::DocsError;
use kb_files::{pathlib, uploads};
use quick_xml::events::Event;
use serde_json::{Value, json};

use crate::Result;

/// How many paragraphs of a Word file are shown.
pub const MAX_PARAGRAPHS: usize = 200;
/// How many rows of a sheet are shown.
pub const MAX_ROWS: usize = 100;
/// How many columns of a sheet are shown.
pub const MAX_COLUMNS: usize = 30;
/// Files over this size are not opened for a preview.
const MAX_FILE_BYTES: u64 = 50 * 1024 * 1024;
/// The most of `word/document.xml` that is read (a zip can claim any size).
const MAX_XML_BYTES: u64 = 64 * 1024 * 1024;

/// The file a `/uploads/...` address names, if it is a served upload.
///
/// # Errors
/// 400 `invalid_path` for an address outside `/uploads/`, with `..`, or in the private folder; 404
/// `file_not_found` when no such file exists.
pub fn upload_file(src: &str) -> Result<PathBuf> {
    let invalid = || -> crate::Error { DocsError::new(400, "invalid_path", "Not a file of this board").into() };
    let rel = src.trim().strip_prefix("/uploads/").ok_or_else(invalid)?;
    let rel = rel.split(['?', '#']).next().unwrap_or("");
    let parts: Vec<&str> = rel.split('/').collect();
    if rel.is_empty()
        || rel.contains('\\')
        || rel.contains('\0')
        || parts.iter().any(|p| p.is_empty() || *p == "." || *p == "..")
        || parts[0].eq_ignore_ascii_case(uploads::PRIVATE_DIR)
    {
        return Err(invalid());
    }
    let path = uploads::resolve_upload_path(rel).ok_or_else(invalid)?;
    let private = uploads::get_uploads_dir(false).join(uploads::PRIVATE_DIR);
    if path.starts_with(&private) {
        return Err(invalid());
    }
    if !path.is_file() {
        return Err(DocsError::new(404, "file_not_found", "File not found").into());
    }
    Ok(path)
}

/// Answers `GET /docs/file-preview`: `{kind: "pdf"}`, `{kind: "word", blocks}`, `{kind: "sheet", sheets}` or
/// `{kind: "none"}` (with `reason` when the file could not be read or is too large).
///
/// # Errors
/// The errors of [`upload_file`].
pub async fn file_preview(src: &str) -> Result<Value> {
    let path = upload_file(src)?;
    tokio::task::spawn_blocking(move || preview_path(&path))
        .await
        .map_err(|e| crate::Error::Other(format!("the preview stopped: {e}")))
}

/// The preview of a file on disk (blocking).
pub fn preview_path(path: &std::path::Path) -> Value {
    let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let ext = pathlib::suffix(&name).to_ascii_lowercase();
    if ext == ".pdf" {
        return json!({"kind": "pdf"});
    }
    if !matches!(ext.as_str(), ".docx" | ".xlsx" | ".xlsm" | ".xls" | ".ods" | ".csv" | ".tsv") {
        return json!({"kind": "none"});
    }
    if std::fs::metadata(path).map(|m| m.len()).unwrap_or(u64::MAX) > MAX_FILE_BYTES {
        return json!({"kind": "none", "reason": "too_large"});
    }
    let Ok(bytes) = std::fs::read(path) else {
        return json!({"kind": "none", "reason": "could_not_read"});
    };
    let result = match ext.as_str() {
        ".docx" => docx_blocks(&bytes).map(|blocks| json!({"kind": "word", "blocks": blocks})),
        ".csv" | ".tsv" => {
            let delimiter = if ext == ".tsv" { '\t' } else { ',' };
            let (rows, total) = csv_rows(&String::from_utf8_lossy(&bytes), delimiter);
            Some(json!({"kind": "sheet", "sheets": [{"name": name, "rows": rows, "total_rows": total}]}))
        }
        _ => workbook_sheets(bytes).map(|sheets| json!({"kind": "sheet", "sheets": sheets})),
    };
    result.unwrap_or_else(|| json!({"kind": "none", "reason": "could_not_read"}))
}

/// The headings and paragraphs of a `.docx` (`[{type: heading, level, text} | {type: paragraph, text}]`), the
/// first [`MAX_PARAGRAPHS`] that have text; `None` when it is not a Word file.
pub fn docx_blocks(bytes: &[u8]) -> Option<Vec<Value>> {
    let mut archive = zip::ZipArchive::new(Cursor::new(bytes)).ok()?;
    let entry = archive.by_name("word/document.xml").ok()?;
    let mut xml = String::new();
    entry.take(MAX_XML_BYTES).read_to_string(&mut xml).ok()?;
    let mut reader = quick_xml::Reader::from_str(&xml);
    let mut blocks = Vec::new();
    let mut in_paragraph = false;
    let mut in_text = false;
    let mut text = String::new();
    let mut level: Option<u64> = None;
    loop {
        let event = reader.read_event().ok()?;
        match event {
            Event::Start(e) if e.name().as_ref() == "w:p" => {
                in_paragraph = true;
                text.clear();
                level = None;
            }
            Event::Start(e) if e.name().as_ref() == "w:t" => in_text = in_paragraph,
            Event::End(e) if e.name().as_ref() == "w:t" => in_text = false,
            Event::Empty(e) | Event::Start(e) if in_paragraph => match e.name().as_ref() {
                "w:pStyle" => {
                    let style = e
                        .try_get_attribute("w:val")
                        .ok()
                        .flatten()
                        .map(|a| a.value.to_ascii_lowercase())
                        .unwrap_or_default();
                    level = heading_level(&style);
                }
                "w:tab" => text.push('\t'),
                "w:br" | "w:cr" => text.push('\n'),
                _ => {}
            },
            Event::Text(t) if in_text => {
                text.push_str(&t.xml10_content());
            }
            Event::GeneralRef(r) if in_text => {
                if let Ok(Some(c)) = r.resolve_char_ref() {
                    text.push(c);
                } else {
                    let c = match r.into_inner().as_ref() {
                        "amp" => "&",
                        "lt" => "<",
                        "gt" => ">",
                        "quot" => "\"",
                        "apos" => "'",
                        _ => "",
                    };
                    text.push_str(c);
                }
            }
            Event::End(e) if e.name().as_ref() == "w:p" => {
                in_paragraph = false;
                let t = text.trim();
                if !t.is_empty() {
                    blocks.push(match level {
                        Some(l) => json!({"type": "heading", "level": l, "text": t}),
                        None => json!({"type": "paragraph", "text": t}),
                    });
                    if blocks.len() >= MAX_PARAGRAPHS {
                        break;
                    }
                }
            }
            Event::Eof => break,
            _ => {}
        }
    }
    Some(blocks)
}

/// The heading level of a paragraph style (`Heading1`…`Heading9`, `Title` is 1); `None` for body text.
fn heading_level(style: &str) -> Option<u64> {
    if style == "title" {
        return Some(1);
    }
    let rest = style.strip_prefix("heading")?.trim_start_matches([' ', '-', '_']);
    rest.parse::<u64>().ok().filter(|l| (1..=9).contains(l))
}

/// The first rows of a CSV text ([`MAX_ROWS`] × [`MAX_COLUMNS`]) and how many rows it has. Quoted fields may hold
/// the delimiter, doubled quotes and line breaks.
pub fn csv_rows(text: &str, delimiter: char) -> (Vec<Vec<String>>, usize) {
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    let mut rows: Vec<Vec<String>> = Vec::new();
    let mut total = 0usize;
    let mut row: Vec<String> = Vec::new();
    let mut field = String::new();
    let mut quoted = false;
    let mut chars = text.chars().peekable();
    let end_row = |row: &mut Vec<String>, rows: &mut Vec<Vec<String>>, total: &mut usize| {
        if !(row.len() == 1 && row[0].is_empty()) {
            *total += 1;
            if rows.len() < MAX_ROWS {
                rows.push(row.iter().take(MAX_COLUMNS).cloned().collect());
            }
        }
        row.clear();
    };
    while let Some(c) = chars.next() {
        if quoted {
            if c == '"' {
                if chars.peek() == Some(&'"') {
                    field.push('"');
                    chars.next();
                } else {
                    quoted = false;
                }
            } else {
                field.push(c);
            }
        } else if c == '"' && field.is_empty() {
            quoted = true;
        } else if c == delimiter {
            row.push(std::mem::take(&mut field));
        } else if c == '\n' || c == '\r' {
            if c == '\r' && chars.peek() == Some(&'\n') {
                chars.next();
            }
            row.push(std::mem::take(&mut field));
            end_row(&mut row, &mut rows, &mut total);
        } else {
            field.push(c);
        }
    }
    if !field.is_empty() || !row.is_empty() {
        row.push(field);
        end_row(&mut row, &mut rows, &mut total);
    }
    (rows, total)
}

/// The sheets of an Excel or OpenDocument workbook (`[{name, rows, total_rows}]`), the first rows and columns of
/// each; `None` when it cannot be read.
pub fn workbook_sheets(bytes: Vec<u8>) -> Option<Vec<Value>> {
    let mut book = calamine::open_workbook_auto_from_rs(Cursor::new(bytes)).ok()?;
    let mut sheets = Vec::new();
    for name in book.sheet_names().into_iter().take(50) {
        let Ok(range) = book.worksheet_range(&name) else { continue };
        let rows: Vec<Vec<String>> =
            range.rows().take(MAX_ROWS).map(|r| r.iter().take(MAX_COLUMNS).map(|c| c.to_string()).collect()).collect();
        sheets.push(json!({"name": name, "rows": rows, "total_rows": range.height()}));
    }
    Some(sheets)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn zip_of(files: &[(&str, &str)]) -> Vec<u8> {
        let mut buf = Cursor::new(Vec::new());
        {
            let mut zip = zip::ZipWriter::new(&mut buf);
            let opts = zip::write::SimpleFileOptions::default();
            for (name, body) in files {
                zip.start_file(*name, opts).unwrap();
                zip.write_all(body.as_bytes()).unwrap();
            }
            zip.finish().unwrap();
        }
        buf.into_inner()
    }

    /// A small Word file: a title, a heading, two paragraphs and an empty one.
    pub(crate) fn sample_docx() -> Vec<u8> {
        let doc = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>
<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Release notes: v15</w:t></w:r></w:p>
<w:p><w:r><w:t xml:space="preserve">Export to Word &amp; PDF </w:t></w:r><w:r><w:t>is here.</w:t></w:r></w:p>
<w:p/>
<w:p><w:pPr><w:pStyle w:val="Heading2"/></w:pPr><w:r><w:t>Fixed</w:t></w:r></w:p>
<w:p><w:r><w:t>Cards</w:t><w:tab/><w:t>no longer jump</w:t></w:r></w:p>
</w:body></w:document>"#;
        zip_of(&[
            (
                "[Content_Types].xml",
                r#"<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>"#,
            ),
            ("word/document.xml", doc),
        ])
    }

    /// A small Excel file with two sheets.
    pub(crate) fn sample_xlsx() -> Vec<u8> {
        let sheet = |rows: &str| {
            format!(
                r#"<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>{rows}</sheetData></worksheet>"#
            )
        };
        let s1 = sheet(
            r#"<row r="1"><c r="A1" t="inlineStr"><is><t>Date</t></is></c><c r="B1" t="inlineStr"><is><t>Count</t></is></c></row><row r="2"><c r="A2" t="inlineStr"><is><t>Oct 01</t></is></c><c r="B2"><v>42</v></c></row>"#,
        );
        let s2 = sheet(r#"<row r="1"><c r="A1"><v>1.5</v></c></row>"#);
        zip_of(&[
            (
                "[Content_Types].xml",
                r#"<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>"#,
            ),
            (
                "_rels/.rels",
                r#"<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>"#,
            ),
            (
                "xl/workbook.xml",
                r#"<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Events" sheetId="1" r:id="rId1"/><sheet name="Totals" sheetId="2" r:id="rId2"/></sheets></workbook>"#,
            ),
            (
                "xl/_rels/workbook.xml.rels",
                r#"<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/></Relationships>"#,
            ),
            ("xl/worksheets/sheet1.xml", &s1),
            ("xl/worksheets/sheet2.xml", &s2),
        ])
    }

    #[test]
    fn word_headings_and_paragraphs_are_read() {
        let blocks = docx_blocks(&sample_docx()).unwrap();
        assert_eq!(
            Value::Array(blocks),
            json!([
                {"type": "heading", "level": 1, "text": "Release notes: v15"},
                {"type": "paragraph", "text": "Export to Word & PDF is here."},
                {"type": "heading", "level": 2, "text": "Fixed"},
                {"type": "paragraph", "text": "Cards\tno longer jump"},
            ])
        );
        assert!(docx_blocks(b"not a zip").is_none());
    }

    #[test]
    fn excel_sheets_are_read() {
        let sheets = workbook_sheets(sample_xlsx()).unwrap();
        assert_eq!(sheets.len(), 2);
        assert_eq!(sheets[0]["name"], json!("Events"));
        assert_eq!(sheets[0]["rows"], json!([["Date", "Count"], ["Oct 01", "42"]]));
        assert_eq!(sheets[0]["total_rows"], json!(2));
        assert_eq!(sheets[1]["rows"], json!([["1.5"]]));
    }

    #[test]
    fn csv_is_read_with_quotes_and_limits() {
        let (rows, total) = csv_rows(
            "\u{feff}Date,Event,Note\r\nOct 01,ticket.created,\"a, b\"\nOct 02,doc.edited,\"say \"\"hi\"\"\nthere\"\n\n",
            ',',
        );
        assert_eq!(total, 3);
        assert_eq!(rows[1], vec!["Oct 01", "ticket.created", "a, b"]);
        assert_eq!(rows[2], vec!["Oct 02", "doc.edited", "say \"hi\"\nthere"]);

        let wide: String = (0..40).map(|i| i.to_string()).collect::<Vec<_>>().join(",");
        let long: String = (0..150).map(|_| format!("{wide}\n")).collect();
        let (rows, total) = csv_rows(&long, ',');
        assert_eq!((rows.len(), total, rows[0].len()), (MAX_ROWS, 150, MAX_COLUMNS));

        let (rows, _) = csv_rows("a\tb\n", '\t');
        assert_eq!(rows, vec![vec!["a", "b"]]);
    }

    #[test]
    fn heading_styles() {
        assert_eq!(heading_level("heading1"), Some(1));
        assert_eq!(heading_level("heading 3"), Some(3));
        assert_eq!(heading_level("title"), Some(1));
        assert_eq!(heading_level("normal"), None);
    }

    #[test]
    fn preview_by_extension() {
        let dir = tempfile::tempdir().unwrap();
        let write = |name: &str, bytes: &[u8]| {
            let p = dir.path().join(name);
            std::fs::write(&p, bytes).unwrap();
            p
        };
        assert_eq!(preview_path(&write("a.pdf", b"%PDF-1.7")), json!({"kind": "pdf"}));
        assert_eq!(preview_path(&write("a.zip", b"PK")), json!({"kind": "none"}));
        assert_eq!(preview_path(&write("a.docx", &sample_docx()))["kind"], json!("word"));
        assert_eq!(preview_path(&write("a.xlsx", &sample_xlsx()))["sheets"][0]["name"], json!("Events"));
        let csv = preview_path(&write("events.csv", b"a,b\n1,2\n"));
        assert_eq!(csv["sheets"][0], json!({"name": "events.csv", "rows": [["a", "b"], ["1", "2"]], "total_rows": 2}));
        assert_eq!(preview_path(&write("bad.docx", b"nope")), json!({"kind": "none", "reason": "could_not_read"}));
    }
}
