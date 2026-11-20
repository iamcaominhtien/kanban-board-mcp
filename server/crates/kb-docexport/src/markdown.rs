//! Markdown export: GFM with the plain-Markdown conventions of the format (`==highlight==`, `> [!INFO]` callouts,
//! `$math$`), one `.md` file per page in folders like the page tree, or one file for a book.
//!
//! Pictures go into an `images/` folder at the root of the export, inline as `data:` URIs, or stay links.
//! Embeds that cannot travel (videos, drawings, HTML and link embeds) become a link or a placeholder line
//! `[embed: draw.io diagram · Name]`. A table with merged cells is written as an HTML table (GFM cannot merge).

use std::collections::HashMap;
use std::fmt::Write as _;

use serde_json::Value;

use crate::assets::{AssetSource, DrawingKind, data_uri, image_ext, image_mime};
use crate::html::{absolute, chapter_label, esc as html_esc};
use crate::inline::{Marks, Piece, block_highlights, pieces, safe_href, safe_src};
use crate::model::{
    Book, ExportPage, Highlight, HighlightMode, OutFile, UniqueNames, attr_bool, attr_int, attr_str, children,
    doc_ref_label, embed_kind_title, file_name_of, inline_text, page_path, placeholder_line, safe_file_part,
    table_grid, table_has_merges, ty,
};

/// Where pictures go.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum MarkdownImages {
    /// Into `images/` next to the files (the caller zips the export).
    #[default]
    Folder,
    /// Inside the file as base64 `data:` URIs.
    Inline,
    /// Left where they are: links to the app (`/uploads/…`, with the base URL when given).
    Link,
}

/// How embeds that cannot travel are written.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum MarkdownEmbeds {
    /// A link: `[draw.io diagram](https://…)`. A drawing is a picture instead when pictures travel and the
    /// [`AssetSource`] can draw it.
    #[default]
    Link,
    /// A placeholder line: `[embed: draw.io diagram]`.
    Placeholder,
}

/// Options of [`render_markdown`].
#[derive(Debug, Clone, Default)]
pub struct MarkdownOptions {
    /// Where pictures go.
    pub images: MarkdownImages,
    /// How embeds are written.
    pub embeds: MarkdownEmbeds,
    /// Whether reader highlights are written as `==text==`.
    pub highlights: HighlightMode,
    /// Book mode: one file with a cover, title page, contents and the chapters; `None` for a file per page.
    pub book: Option<Book>,
    /// The app's address (`https://board.example`), put before links that start with `/`; `None` keeps them
    /// relative.
    pub base_url: Option<String>,
}

/// Renders pages to Markdown files: one per page at its `path` (`Architecture/API.md`), or one for a book,
/// followed by the pictures under `images/`.
pub fn render_markdown(pages: &[ExportPage], assets: &dyn AssetSource, opts: &MarkdownOptions) -> Vec<OutFile> {
    let mut names = UniqueNames::default();
    let paths: Vec<String> = match &opts.book {
        Some(book) => {
            let name = safe_file_part(&book.title);
            vec![format!("{}.md", if name.is_empty() { "book" } else { name.as_str() })]
        }
        None => pages.iter().map(|p| names.take(&format!("{}.md", page_path(p)))).collect(),
    };
    let mut page_files = HashMap::new();
    for (i, p) in pages.iter().enumerate() {
        let file = if opts.book.is_some() { paths[0].clone() } else { paths[i].clone() };
        page_files.entry(p.title.trim().to_lowercase()).or_insert(file);
    }
    let mut r = MdRenderer {
        assets,
        opts,
        images: Vec::new(),
        image_names: UniqueNames::default(),
        cache: HashMap::new(),
        page_files,
        current: String::new(),
        heading_shift: 0,
        highlights: &[],
    };
    let mut files = Vec::new();
    match &opts.book {
        Some(book) => {
            r.current = paths[0].clone();
            // The book title is `#` and each chapter `##`: page headings move down two levels.
            r.heading_shift = 2;
            let text = r.book(book, pages);
            files.push(OutFile { path: paths[0].clone(), bytes: text.into_bytes() });
        }
        None => {
            for (page, path) in pages.iter().zip(&paths) {
                r.current = path.clone();
                let mut out = String::new();
                r.page_head(page, &mut out);
                r.page_body(page, &mut out);
                files.push(OutFile { path: path.clone(), bytes: finish(out).into_bytes() });
            }
        }
    }
    files.append(&mut r.images);
    files
}

/// Trims blank lines and ends the file with one newline.
fn finish(mut s: String) -> String {
    while s.ends_with('\n') {
        s.pop();
    }
    s.push('\n');
    s
}

struct MdRenderer<'a> {
    assets: &'a dyn AssetSource,
    opts: &'a MarkdownOptions,
    images: Vec<OutFile>,
    image_names: UniqueNames,
    cache: HashMap<String, Option<String>>,
    /// Lower-cased page title → its file in this export.
    page_files: HashMap<String, String>,
    /// The file being written (for relative links).
    current: String,
    heading_shift: u8,
    highlights: &'a [Highlight],
}

impl<'a> MdRenderer<'a> {
    fn book(&mut self, book: &Book, pages: &'a [ExportPage]) -> String {
        let mut out = String::new();
        if book.cover {
            if let Some(src) = &book.cover_image {
                if let Some(url) = self.image_url(src) {
                    let _ = writeln!(out, "![{}]({})\n", escape_text(&book.title), link_target(&url));
                }
            }
        }
        let _ = writeln!(out, "# {}\n", escape_text(&book.title));
        if book.title_page || book.cover {
            if let Some(s) = &book.subtitle {
                let _ = writeln!(out, "*{}*\n", escape_text(s));
            }
            let line: Vec<&str> = [book.author.as_deref(), book.date.as_deref()].into_iter().flatten().collect();
            if !line.is_empty() {
                let _ = writeln!(out, "{}\n", escape_text(&line.join(" · ")));
            }
        }
        if book.contents {
            let _ = writeln!(out, "## {}\n", crate::lang::Lang::of(pages).contents());
            for (i, p) in pages.iter().enumerate() {
                let _ = writeln!(out, "- {}", escape_text(&chapter_label(book, i, &p.title)));
            }
            out.push('\n');
        }
        for (i, page) in pages.iter().enumerate() {
            if book.chapter_breaks && (i > 0 || book.contents) {
                out.push_str("---\n\n");
            }
            let _ = writeln!(out, "## {}\n", escape_text(&chapter_label(book, i, &page.title)));
            self.page_body(page, &mut out);
        }
        finish(out)
    }

    fn page_head(&mut self, page: &ExportPage, out: &mut String) {
        let s = crate::model::Settings::read(&page.settings);
        if let Some(cover) = &s.cover {
            if let Some(url) = self.image_url(&cover.src) {
                let _ = writeln!(out, "![]({})\n", link_target(&url));
            }
        }
        let _ = writeln!(out, "# {}\n", escape_text(&page.title));
        let mut line: Vec<&str> = Vec::new();
        if let Some(e) = s.eyebrow.as_deref() {
            line.push(e);
        }
        if s.show_byline {
            line.extend([page.author.as_deref(), page.updated_at.as_deref()].into_iter().flatten());
        }
        if !line.is_empty() {
            let _ = writeln!(out, "{}\n", escape_text(&line.join(" · ")));
        }
    }

    fn page_body(&mut self, page: &'a ExportPage, out: &mut String) {
        self.highlights = if self.opts.highlights == HighlightMode::Show { &page.highlights } else { &[] };
        let body = self.blocks(children(&page.doc));
        out.push_str(&body);
        if !body.is_empty() {
            out.push('\n');
        }
    }

    /// Renders blocks separated by blank lines.
    fn blocks(&mut self, nodes: &[Value]) -> String {
        let parts: Vec<String> = nodes.iter().map(|n| self.block(n)).filter(|s| !s.is_empty()).collect();
        let mut out = parts.join("\n\n");
        if !out.is_empty() {
            out.push('\n');
        }
        out
    }

    fn block(&mut self, node: &Value) -> String {
        match ty(node) {
            "paragraph" => self.inline(node),
            "heading" => {
                let level = (attr_int(node, "level", 1, 1, 6) as u8 + self.heading_shift).min(6) as usize;
                format!("{} {}", "#".repeat(level), self.inline(node))
            }
            "blockquote" => {
                let mut inner = self.blocks(children(node));
                if let Some(src) = attr_str(node, "source") {
                    let _ = write!(inner, "\n— {}", escape_text(src));
                }
                prefix_lines(inner.trim_end(), "> ")
            }
            "pullQuote" => {
                let mut inner = self.inline(node);
                if let Some(src) = attr_str(node, "source") {
                    let _ = write!(inner, "\n\n— {}", escape_text(src));
                }
                prefix_lines(&inner, "> ")
            }
            "bulletList" => self.list(node, ListKind::Bullet),
            "orderedList" => self.list(node, ListKind::Ordered(attr_int(node, "start", 1, 0, 1_000_000_000))),
            "taskList" => self.list(node, ListKind::Task),
            "listItem" | "taskItem" | "column" => self.blocks(children(node)).trim_end().to_string(),
            "columns" => {
                let parts: Vec<String> =
                    children(node).iter().map(|c| self.blocks(children(c))).filter(|s| !s.is_empty()).collect();
                parts.iter().map(|s| s.trim_end()).collect::<Vec<_>>().join("\n\n")
            }
            "codeBlock" => {
                let code: String =
                    children(node).iter().filter_map(|t| t.get("text").and_then(Value::as_str)).collect();
                let fence = "`".repeat(longest_run(&code, '`').max(2) + 1);
                let lang: String = attr_str(node, "language")
                    .unwrap_or("")
                    .chars()
                    .filter(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '+' | '.' | '#' | '_'))
                    .collect();
                let mut out = String::new();
                if let Some(f) = attr_str(node, "filename") {
                    let _ = writeln!(out, "*{}*\n", escape_text(f));
                }
                let _ = write!(out, "{fence}{lang}\n{code}\n{fence}");
                out
            }
            "horizontalRule" => "---".to_string(),
            "table" => self.table(node),
            "image" => self.image(node),
            "callout" => {
                let kind = match attr_str(node, "kind") {
                    Some(k @ ("warning" | "success" | "danger" | "note")) => k.to_ascii_uppercase(),
                    _ => "INFO".to_string(),
                };
                let mut marker = format!("[!{kind}]");
                if let Some(t) = attr_str(node, "title") {
                    let _ = write!(marker, " {}", escape_text(&t.replace('\n', " ")));
                }
                let body = self.blocks(children(node));
                let body = body.trim_end();
                if body.is_empty() {
                    format!("> {marker}")
                } else {
                    format!("> {marker}\n{}", prefix_lines(body, "> "))
                }
            }
            "mathBlock" => format!("$$\n{}\n$$", attr_str(node, "latex").unwrap_or("")),
            "diagram" | "sketch" | "canvas" => self.drawing(node),
            "video" | "htmlEmbed" | "linkEmbed" => self.embed(node),
            "fileCard" => {
                let src = attr_str(node, "src").unwrap_or("");
                let name = attr_str(node, "name").unwrap_or(src);
                match safe_href(src) {
                    Some(href) => {
                        format!(
                            "[{}]({})",
                            escape_text(name),
                            link_target(&absolute(&href, self.opts.base_url.as_deref()))
                        )
                    }
                    None => escape_text(name),
                }
            }
            "pageCard" => {
                let page = attr_str(node, "page").unwrap_or("");
                if page.is_empty() {
                    return String::new();
                }
                match self.page_link(page) {
                    Some(target) => format!("[{}]({})", escape_text(page), link_target(&target)),
                    None => escape_text(page),
                }
            }
            "ticketCard" => escape_text(attr_str(node, "key").unwrap_or("")),
            _ => {
                if children(node).iter().any(|k| matches!(ty(k), "text" | "hardBreak")) {
                    self.inline(node)
                } else {
                    self.blocks(children(node)).trim_end().to_string()
                }
            }
        }
    }

    fn list(&mut self, node: &Value, kind: ListKind) -> String {
        let mut items = Vec::new();
        for (i, item) in children(node).iter().enumerate() {
            let marker = match kind {
                ListKind::Bullet => "- ".to_string(),
                ListKind::Ordered(start) => format!("{}. ", start + i as i64),
                ListKind::Task => {
                    if attr_bool(item, "checked") {
                        "- [x] ".to_string()
                    } else {
                        "- [ ] ".to_string()
                    }
                }
            };
            let body = self.blocks(children(item));
            let body = body.trim_end();
            let pad = " ".repeat(if kind == ListKind::Task { 2 } else { marker.len() });
            let mut text = String::new();
            for (n, line) in body.split('\n').enumerate() {
                if n == 0 {
                    text.push_str(&marker);
                    text.push_str(line);
                } else {
                    text.push('\n');
                    if !line.is_empty() {
                        text.push_str(&pad);
                        text.push_str(line);
                    }
                }
            }
            if body.is_empty() {
                text = marker.trim_end().to_string();
            }
            items.push(text);
        }
        items.join("\n")
    }

    fn table(&mut self, node: &Value) -> String {
        if table_has_merges(node) {
            return self.html_table(node);
        }
        let rows = children(node);
        let Some(first) = rows.first() else {
            return String::new();
        };
        let width = rows.iter().map(|r| children(r).len()).max().unwrap_or(0);
        if width == 0 {
            return String::new();
        }
        let mut lines = Vec::new();
        let cell_text = |r: &mut Self, row: &Value, i: usize| -> String {
            children(row).get(i).map(|c| r.cell_inline(c)).unwrap_or_default()
        };
        let header: Vec<String> = (0..width).map(|i| cell_text(self, first, i)).collect();
        lines.push(format!("| {} |", header.join(" | ")));
        let aligns: Vec<&str> = (0..width)
            .map(|i| match children(first).get(i).and_then(|c| attr_str(c, "align")) {
                Some("center") => ":---:",
                Some("right") => "---:",
                Some("left") => ":---",
                _ => "---",
            })
            .collect();
        lines.push(format!("| {} |", aligns.join(" | ")));
        for row in &rows[1..] {
            let cells: Vec<String> = (0..width).map(|i| cell_text(self, row, i)).collect();
            lines.push(format!("| {} |", cells.join(" | ")));
        }
        lines.join("\n")
    }

    /// The text of a cell on one line: its blocks joined with `<br>`, `|` escaped.
    fn cell_inline(&mut self, cell: &Value) -> String {
        let parts: Vec<String> = children(cell)
            .iter()
            .map(|b| match ty(b) {
                "paragraph" | "heading" => self.inline(b),
                _ => self.block(b).replace('\n', " "),
            })
            .collect();
        parts.join("<br>").replace('|', "\\|").replace('\n', " ")
    }

    fn html_table(&mut self, node: &Value) -> String {
        let (rows, _) = table_grid(node);
        let mut out = String::from("<table>\n");
        for row in rows {
            out.push_str("<tr>");
            for cell in row {
                let tag = if ty(cell.node) == "tableHeader" { "th" } else { "td" };
                let mut attrs = String::new();
                if cell.colspan > 1 {
                    let _ = write!(attrs, " colspan=\"{}\"", cell.colspan);
                }
                if cell.rowspan > 1 {
                    let _ = write!(attrs, " rowspan=\"{}\"", cell.rowspan);
                }
                let text: Vec<String> = children(cell.node).iter().map(inline_text).collect();
                let _ = write!(out, "<{tag}{attrs}>{}</{tag}>", html_esc(&text.join(" ")));
            }
            out.push_str("</tr>\n");
        }
        out.push_str("</table>");
        out
    }

    fn image(&mut self, node: &Value) -> String {
        let src = attr_str(node, "src").unwrap_or("");
        let alt = attr_str(node, "alt").unwrap_or("");
        let Some(url) = (if src.is_empty() { None } else { self.image_url(src) }) else {
            return if alt.is_empty() { String::new() } else { escape_text(alt) };
        };
        let title = attr_str(node, "title").map(|t| format!(" \"{}\"", t.replace('"', "\\\""))).unwrap_or_default();
        let mut out = format!("![{}]({}{title})", escape_text(alt), link_target(&url));
        if let Some(href) = attr_str(node, "href").and_then(safe_href) {
            out = format!("[{out}]({})", link_target(&absolute(&href, self.opts.base_url.as_deref())));
        }
        if let Some(c) = attr_str(node, "caption") {
            let _ = write!(out, "\n\n*{}*", escape_text(c));
        }
        out
    }

    fn drawing(&mut self, node: &Value) -> String {
        let Some(kind) = DrawingKind::of_node_type(ty(node)) else {
            return String::new();
        };
        let id = attr_str(node, "id").unwrap_or("");
        let label = attr_str(node, "label").unwrap_or(kind.label());
        if self.opts.images != MarkdownImages::Link && !id.is_empty() {
            if let Some(url) = self.drawing_url(kind, id) {
                return format!("![{}]({})", escape_text(label), link_target(&url));
            }
        }
        match self.opts.embeds {
            MarkdownEmbeds::Link if !id.is_empty() => {
                let target = absolute(&kind.app_path(id), self.opts.base_url.as_deref());
                format!("[{}]({})", escape_text(label), link_target(&target))
            }
            _ => {
                let (k, t) = embed_kind_title(node).unwrap_or((kind.label(), String::new()));
                escape_brackets_free(&placeholder_line(k, &t))
            }
        }
    }

    fn embed(&mut self, node: &Value) -> String {
        let (kind, title) = embed_kind_title(node).unwrap_or(("embed", String::new()));
        if self.opts.embeds == MarkdownEmbeds::Link {
            let target = match ty(node) {
                "video" => attr_str(node, "src"),
                "linkEmbed" => attr_str(node, "url"),
                _ => None,
            }
            .and_then(safe_href);
            if let Some(href) = target {
                let text = if title.is_empty() { kind.to_string() } else { title.clone() };
                return format!(
                    "[{}]({})",
                    escape_text(&text),
                    link_target(&absolute(&href, self.opts.base_url.as_deref()))
                );
            }
        }
        escape_brackets_free(&placeholder_line(kind, &title))
    }

    // -----------------------------------------------------------------------------------------------------------
    // Assets and links
    // -----------------------------------------------------------------------------------------------------------

    fn image_url(&mut self, src: &str) -> Option<String> {
        if let Some(hit) = self.cache.get(src) {
            return hit.clone().map(|p| self.relative(&p));
        }
        let fallback = safe_src(src).map(|s| absolute(&s, self.opts.base_url.as_deref()));
        let stored = match self.opts.images {
            MarkdownImages::Link => fallback,
            mode => match self.assets.fetch(src) {
                Some(asset) => match image_mime(&asset) {
                    Some(mime) => Some(self.store(mode, &file_name_of(src, image_ext(mime)), mime, asset.bytes)),
                    None => fallback,
                },
                None => fallback,
            },
        };
        self.cache.insert(src.to_string(), stored.clone());
        stored.map(|p| self.relative(&p))
    }

    fn drawing_url(&mut self, kind: DrawingKind, id: &str) -> Option<String> {
        let key = format!("drawing:{kind:?}:{id}");
        if let Some(hit) = self.cache.get(&key) {
            return hit.clone().map(|p| self.relative(&p));
        }
        let mode = self.opts.images;
        let stored =
            self.assets.drawing_png(kind, id).filter(|b| !b.is_empty()).map(|png| {
                self.store(mode, &format!("{}.png", safe_file_part(id).replace(' ', "_")), "image/png", png)
            });
        self.cache.insert(key, stored.clone());
        stored.map(|p| self.relative(&p))
    }

    /// Keeps the bytes: a data URI (inline) or a file under `images/` (the root-relative path is returned).
    fn store(&mut self, mode: MarkdownImages, name: &str, mime: &str, bytes: Vec<u8>) -> String {
        if mode == MarkdownImages::Inline {
            return data_uri(mime, &bytes);
        }
        let path = format!("images/{}", self.image_names.take(name));
        self.images.push(OutFile { path: path.clone(), bytes });
        format!("\u{0}{path}")
    }

    /// Turns a stored root path (marked with a leading NUL) into a path relative to the current file.
    fn relative(&self, stored: &str) -> String {
        match stored.strip_prefix('\u{0}') {
            Some(root_path) => relative_path(&self.current, root_path),
            None => stored.to_string(),
        }
    }

    /// The relative link to another page of this export.
    fn page_link(&self, title: &str) -> Option<String> {
        let file = self.page_files.get(&title.trim().to_lowercase())?;
        if *file == self.current {
            return Some("#".to_string());
        }
        Some(relative_path(&self.current, file))
    }

    // -----------------------------------------------------------------------------------------------------------
    // Inline
    // -----------------------------------------------------------------------------------------------------------

    fn inline(&mut self, block: &Value) -> String {
        let hls = block_highlights(block, self.highlights);
        let mut out = String::new();
        for piece in pieces(block, &hls) {
            match piece {
                Piece::Break => out.push_str("  \n"),
                Piece::Text { text, marks } => {
                    let inner = if marks.code { code_span(&text) } else { escape_text(&text) };
                    out.push_str(&self.wrap(inner, &marks));
                }
                Piece::Atom { node, marks } => {
                    let inner = match ty(node) {
                        "docRef" => {
                            let label = escape_text(doc_ref_label(node));
                            match attr_str(node, "page").and_then(|p| self.page_link(p)) {
                                Some(target) => format!("[{label}]({})", link_target(&target)),
                                None => label,
                            }
                        }
                        "ticketRef" => escape_text(attr_str(node, "key").unwrap_or("")),
                        "mathInline" => format!("${}$", attr_str(node, "latex").unwrap_or("")),
                        _ => escape_text(&inline_text(node)),
                    };
                    out.push_str(&self.wrap(inner, &marks));
                }
            }
        }
        escape_line_starts(&out)
    }

    fn wrap(&self, inner: String, m: &Marks) -> String {
        // Markdown marks cannot start or end with white space: keep it outside.
        let start = inner.len() - inner.trim_start().len();
        let end = inner.trim_end().len();
        if start >= end {
            return inner;
        }
        let (lead, core, trail) = (&inner[..start], &inner[start..end], &inner[end..]);
        let mut s = core.to_string();
        if m.highlight.is_some() || m.reader.is_some() {
            s = format!("=={s}==");
        }
        if m.strike {
            s = format!("~~{s}~~");
        }
        if m.italic {
            s = format!("*{s}*");
        }
        if m.bold {
            s = format!("**{s}**");
        }
        if let Some(link) = &m.link {
            if let Some(href) = safe_href(&link.href) {
                let title =
                    link.title.as_deref().map(|t| format!(" \"{}\"", t.replace('"', "\\\""))).unwrap_or_default();
                s = format!("[{s}]({}{title})", link_target(&absolute(&href, self.opts.base_url.as_deref())));
            }
        }
        format!("{lead}{s}{trail}")
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ListKind {
    Bullet,
    Ordered(i64),
    Task,
}

/// Escapes the characters Markdown would read as syntax.
fn escape_text(s: &str) -> String {
    let chars: Vec<char> = s.chars().collect();
    let mut out = String::with_capacity(s.len());
    for (i, &c) in chars.iter().enumerate() {
        let doubled_eq = c == '=' && (chars.get(i + 1) == Some(&'=') || (i > 0 && chars[i - 1] == '='));
        if doubled_eq || matches!(c, '\\' | '`' | '*' | '_' | '[' | ']' | '<' | '>' | '~' | '|' | '$') {
            out.push('\\');
        }
        out.push(c);
    }
    out
}

/// A placeholder line keeps its brackets (it is meant to be read as written).
fn escape_brackets_free(s: &str) -> String {
    s.chars()
        .map(|c| match c {
            '*' | '_' | '`' | '<' | '>' => format!("\\{c}"),
            c => c.to_string(),
        })
        .collect()
}

/// Escapes what would start a heading, list or quote at the start of a line.
fn escape_line_starts(s: &str) -> String {
    s.split('\n')
        .map(|line| {
            let trimmed = line.trim_start();
            let pad = &line[..line.len() - trimmed.len()];
            let digits = trimmed.chars().take_while(char::is_ascii_digit).count();
            if trimmed.starts_with('#')
                || trimmed.starts_with("- ")
                || trimmed.starts_with("+ ")
                || trimmed == "-"
                || trimmed.starts_with("---")
            {
                format!("{pad}\\{trimmed}")
            } else if digits > 0 && (trimmed[digits..].starts_with(". ") || trimmed[digits..].starts_with(") ")) {
                format!("{pad}{}\\{}", &trimmed[..digits], &trimmed[digits..])
            } else {
                line.to_string()
            }
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// A code span that holds any text: the fence is longer than the longest run of backticks inside.
fn code_span(text: &str) -> String {
    let fence = "`".repeat(longest_run(text, '`') + 1);
    let pad = if text.starts_with('`') || text.ends_with('`') { " " } else { "" };
    format!("{fence}{pad}{text}{pad}{fence}")
}

fn longest_run(s: &str, c: char) -> usize {
    let (mut best, mut run) = (0, 0);
    for ch in s.chars() {
        if ch == c {
            run += 1;
            best = best.max(run);
        } else {
            run = 0;
        }
    }
    best
}

/// Writes a link target; one with spaces or parentheses goes in angle brackets.
fn link_target(url: &str) -> String {
    let clean: String = url.chars().filter(|c| !matches!(c, '\n' | '\r' | '<' | '>')).collect();
    if clean.contains([' ', '(', ')']) { format!("<{clean}>") } else { clean }
}

fn prefix_lines(s: &str, prefix: &str) -> String {
    s.split('\n')
        .map(|l| if l.is_empty() { prefix.trim_end().to_string() } else { format!("{prefix}{l}") })
        .collect::<Vec<_>>()
        .join("\n")
}

/// The path of `to` seen from the folder of `from` (both relative to the export root).
fn relative_path(from: &str, to: &str) -> String {
    let from_dirs: Vec<&str> = from.split('/').collect();
    let from_dirs = &from_dirs[..from_dirs.len().saturating_sub(1)];
    let to_parts: Vec<&str> = to.split('/').collect();
    let common = from_dirs.iter().zip(&to_parts).take_while(|(a, b)| a == b).count();
    let mut out = vec![".."; from_dirs.len() - common];
    out.extend(&to_parts[common..]);
    out.join("/")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn relative_paths() {
        assert_eq!(relative_path("A.md", "images/x.png"), "images/x.png");
        assert_eq!(relative_path("Arch/API.md", "images/x.png"), "../images/x.png");
        assert_eq!(relative_path("Arch/API.md", "Arch/Data.md"), "Data.md");
    }

    #[test]
    fn line_starts_are_escaped() {
        assert_eq!(escape_line_starts("# not"), "\\# not");
        assert_eq!(escape_line_starts("1. not"), "1\\. not");
    }

    #[test]
    fn code_spans_hold_backticks() {
        assert_eq!(code_span("a`b"), "``a`b``");
    }
}
