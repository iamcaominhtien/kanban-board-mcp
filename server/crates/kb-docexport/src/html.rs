//! HTML export: one self-contained file (pictures as `data:` URIs) or a folder (`index.html` + `assets/`), with the
//! page theme or plain. The same HTML, with a print stylesheet, is what [`crate::render_pdf`] prints.
//!
//! Everything from the page is escaped; no script is ever written and an HTML embed is never copied (a note says
//! to open the page to run it). Links pass [`crate::inline::safe_href`], colours the palette, sizes are numbers.

use std::collections::HashMap;
use std::fmt::Write as _;

use serde_json::Value;

use crate::assets::{AssetSource, DrawingKind, data_uri, image_ext, image_mime};
use crate::inline::{Marks, Piece, block_highlights, pieces, safe_href, safe_src};
use crate::model::{
    Book, ColorUse, ExportPage, HeaderFooter, Highlight, HighlightMode, OutFile, PageSetup, PageSize, Settings,
    TableOfContents, UniqueNames, attr_bool, attr_f64, attr_int, attr_str, callout_palette, children, doc_ref_label,
    file_name_of, font_generic, font_name, headings, inline_text, page_colors, placeholder_line, resolve_any_color,
    resolve_color, slug, table_grid, ty,
};

/// One file or a folder.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum HtmlLayout {
    /// One `.html` file; pictures and drawings are embedded as `data:` URIs (easy to send, larger).
    #[default]
    SingleFile,
    /// `index.html` and an `assets/` folder with the pictures, drawings and video files (the caller zips it).
    Folder,
}

/// The look of the page.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum HtmlLook {
    /// The page's fonts, colours, background and width.
    #[default]
    PageTheme,
    /// The browser's own style, with only a few rules for tables, callouts and code.
    Plain,
}

/// Options of [`render_html`].
#[derive(Debug, Clone, Default)]
pub struct HtmlOptions {
    /// One file or a folder.
    pub layout: HtmlLayout,
    /// Page theme or plain.
    pub look: HtmlLook,
    /// Whether reader highlights are drawn.
    pub highlights: HighlightMode,
    /// Book mode: cover, title page, contents and chapters; `None` for pages one after another.
    pub book: Option<Book>,
    /// Page setup for printing (PDF): adds the print stylesheet (page size, margins, header and footer) and,
    /// outside book mode, the cover page and contents it asks for. `None` for a web page.
    pub print: Option<PageSetup>,
    /// The app's address (`https://board.example`), put before links that start with `/` (uploads that could not
    /// be embedded, videos, files); `None` keeps them relative.
    pub base_url: Option<String>,
}

/// The result of [`render_html`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HtmlOutput {
    /// The whole page in one HTML document.
    SingleFile(String),
    /// `index.html` first, then the files under `assets/`.
    Folder(Vec<OutFile>),
}

impl HtmlOutput {
    /// Returns the HTML of the page (the single file, or `index.html` of the folder).
    pub fn index_html(&self) -> &str {
        match self {
            HtmlOutput::SingleFile(html) => html,
            HtmlOutput::Folder(files) => files
                .iter()
                .find(|f| f.path == "index.html")
                .and_then(|f| std::str::from_utf8(&f.bytes).ok())
                .unwrap_or(""),
        }
    }
}

/// Renders pages (in the given order) to HTML.
///
/// `assets` gives the bytes of pictures and drawings; a picture it cannot give stays a link to its source, a
/// drawing becomes a placeholder line.
pub fn render_html(pages: &[ExportPage], assets: &dyn AssetSource, opts: &HtmlOptions) -> HtmlOutput {
    let mut r = HtmlRenderer::new(pages, assets, opts);
    let html = r.document();
    match opts.layout {
        HtmlLayout::SingleFile => HtmlOutput::SingleFile(html),
        HtmlLayout::Folder => {
            let mut files = vec![OutFile { path: "index.html".into(), bytes: html.into_bytes() }];
            files.append(&mut r.files);
            HtmlOutput::Folder(files)
        }
    }
}

/// Escapes text for HTML content and attribute values.
pub(crate) fn esc(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#39;"),
            c if c.is_control() && c != '\n' && c != '\t' => {}
            c => out.push(c),
        }
    }
    out
}

/// Escapes text for a CSS string in double quotes inside a `<style>` element.
fn css_string(s: &str) -> String {
    let mut out = String::from("\"");
    for c in s.chars() {
        match c {
            '\\' => out.push_str("\\\\"),
            '"' => out.push_str("\\\""),
            '<' => out.push_str("\\3C "),
            '>' => out.push_str("\\3E "),
            c if c.is_control() => out.push(' '),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

/// The CSS `font-family` of a font key.
fn font_stack(key: &str) -> String {
    match font_name(key) {
        Some(name) => format!("'{name}', {}", font_generic(key)),
        None => font_generic(key).to_string(),
    }
}

/// Prefixes the base URL to a root-relative link.
pub(crate) fn absolute(url: &str, base: Option<&str>) -> String {
    match base {
        Some(b) if url.starts_with('/') && !url.starts_with("//") => format!("{}{url}", b.trim_end_matches('/')),
        _ => url.to_string(),
    }
}

struct HtmlRenderer<'a> {
    pages: &'a [ExportPage],
    /// The language of the export's own words and of its `lang`.
    lang: crate::lang::Lang,
    assets: &'a dyn AssetSource,
    opts: &'a HtmlOptions,
    files: Vec<OutFile>,
    names: UniqueNames,
    /// src → URL to write (data URI or assets path); `None` when it could not be fetched.
    cache: HashMap<String, Option<String>>,
    /// Lower-cased page title → anchor of that page in this document.
    page_anchors: HashMap<String, String>,
    /// Background of the page being rendered (palette lookups).
    bg: String,
    /// How many levels headings move down (1 in a book: the chapter title is the level-1 heading).
    heading_shift: u8,
    highlights: &'a [Highlight],
    /// Whether a block used a rich attribute whose rules live in [`EXTRA_CSS`] (emitted only then).
    extra_css: bool,
    /// Whether an equation was written: the math font then goes into the file.
    has_math: bool,
}

impl<'a> HtmlRenderer<'a> {
    fn new(pages: &'a [ExportPage], assets: &'a dyn AssetSource, opts: &'a HtmlOptions) -> Self {
        let mut page_anchors = HashMap::new();
        let mut used = UniqueNames::default();
        for p in pages {
            page_anchors
                .entry(p.title.trim().to_lowercase())
                .or_insert_with(|| format!("p-{}", used.take(&slug(&p.title))));
        }
        HtmlRenderer {
            pages,
            lang: crate::lang::Lang::of(pages),
            assets,
            opts,
            files: Vec::new(),
            names: UniqueNames::default(),
            cache: HashMap::new(),
            page_anchors,
            bg: "white".into(),
            heading_shift: if opts.book.is_some() { 1 } else { 0 },
            highlights: &[],
            extra_css: false,
            has_math: false,
        }
    }

    fn base(&self) -> Option<&str> {
        self.opts.base_url.as_deref()
    }

    fn theme(&self) -> bool {
        self.opts.look == HtmlLook::PageTheme
    }

    fn page_anchor(&self, page: &ExportPage) -> String {
        self.page_anchors.get(&page.title.trim().to_lowercase()).cloned().unwrap_or_else(|| "p-page".into())
    }

    // -----------------------------------------------------------------------------------------------------------
    // Document
    // -----------------------------------------------------------------------------------------------------------

    fn document(&mut self) -> String {
        let first = self.pages.first();
        let settings = first.map(|p| Settings::read(&p.settings)).unwrap_or_else(|| Settings::read(&Value::Null));
        let title = match (&self.opts.book, first) {
            (Some(b), _) if !b.title.trim().is_empty() => b.title.clone(),
            (_, Some(p)) => p.title.clone(),
            _ => "Export".into(),
        };
        let mut body = String::new();
        if let Some(book) = self.opts.book.clone() {
            self.book_front(&book, &mut body);
        } else if let Some(setup) = self.opts.print {
            if setup.cover_page {
                if let Some(p) = first {
                    self.cover_page(p, &mut body);
                }
            }
            if setup.contents == TableOfContents::Include {
                self.contents(&mut body);
            }
        }
        for (i, page) in self.pages.iter().enumerate() {
            self.page(i, page, &mut body);
        }
        let mut out = String::new();
        let _ =
            write!(out, "<!DOCTYPE html>\n<html lang=\"{}\">\n<head>\n<meta charset=\"utf-8\">\n", self.lang.code());
        out.push_str("<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n");
        out.push_str("<meta name=\"generator\" content=\"Kanban Board Docs export\">\n");
        let _ = writeln!(out, "<title>{}</title>", esc(&title));
        out.push_str("<style>\n");
        out.push_str(BASE_CSS);
        if self.extra_css {
            out.push_str(EXTRA_CSS);
        }
        if self.has_math {
            out.push_str(&crate::math::font_css());
        }
        if self.theme() {
            out.push_str(&theme_css(&settings));
        } else {
            out.push_str(PLAIN_CSS);
        }
        if let Some(setup) = self.opts.print {
            let header = match &self.opts.book {
                Some(b) => b.title.clone(),
                None => title.clone(),
            };
            // a coloured page (paper, sepia…) colours the whole sheet, margins included, as printed paper is
            let sheet = (self.theme() && settings.background != "white").then(|| page_colors(&settings.background).0);
            out.push_str(&print_css(&setup, &header, estimate_height(self.pages), sheet.as_deref()));
        }
        out.push_str("</style>\n</head>\n");
        let class = if self.theme() { "theme" } else { "plain" };
        let _ = writeln!(out, "<body class=\"{class}\">");
        out.push_str(&body);
        out.push_str("</body>\n</html>\n");
        out
    }

    fn book_front(&mut self, book: &Book, out: &mut String) {
        if book.cover {
            out.push_str("<section class=\"book-cover\">\n");
            if let Some(src) = book.cover_image.as_deref() {
                if let Some(url) = self.image_url(src) {
                    let _ = writeln!(out, "<img class=\"cover-img\" src=\"{}\" alt=\"\">", esc(&url));
                }
            }
            let _ = writeln!(out, "<h1 class=\"book-title\">{}</h1>", esc(&book.title));
            if let Some(a) = &book.author {
                let _ = writeln!(out, "<p class=\"book-author\">{}</p>", esc(a));
            }
            out.push_str("</section>\n");
        }
        if book.title_page {
            out.push_str("<section class=\"title-page\">\n");
            if let Some(s) = &book.subtitle {
                let _ = writeln!(out, "<p class=\"eyebrow\">{}</p>", esc(s));
            }
            let _ = writeln!(out, "<h1 class=\"book-title\">{}</h1>", esc(&book.title));
            if let Some(a) = &book.author {
                let _ = writeln!(out, "<p class=\"book-author\">{}</p>", esc(a));
            }
            if let Some(d) = &book.date {
                let _ = writeln!(out, "<p class=\"book-date\">{}</p>", esc(d));
            }
            out.push_str("</section>\n");
        }
        if book.contents {
            let c = self.lang.contents();
            let _ = write!(out, "<nav class=\"toc\" aria-label=\"{c}\">\n<h2>{c}</h2>\n<ul class=\"chapters\">\n");
            for (i, page) in self.pages.iter().enumerate() {
                let label = chapter_label(book, i, &page.title);
                let _ = writeln!(out, "<li><a href=\"#{}\">{}</a></li>", self.page_anchor(page), esc(&label));
            }
            out.push_str("</ul>\n</nav>\n");
        }
    }

    fn cover_page(&mut self, page: &ExportPage, out: &mut String) {
        let s = Settings::read(&page.settings);
        out.push_str("<section class=\"book-cover\">\n");
        if let Some(cover) = &s.cover {
            if let Some(url) = self.image_url(&cover.src) {
                let _ = writeln!(out, "<img class=\"cover-img\" src=\"{}\" alt=\"\">", esc(&url));
            }
        }
        if let Some(e) = &s.eyebrow {
            let _ = writeln!(out, "<p class=\"eyebrow\">{}</p>", esc(e));
        }
        let _ = writeln!(out, "<h1 class=\"book-title\">{}</h1>", esc(&page.title));
        if let Some(a) = &page.author {
            let _ = writeln!(out, "<p class=\"book-author\">{}</p>", esc(a));
        }
        out.push_str("</section>\n");
    }

    fn contents(&mut self, out: &mut String) {
        let c = self.lang.contents();
        let _ = write!(out, "<nav class=\"toc\" aria-label=\"{c}\">\n<h2>{c}</h2>\n<ul>\n");
        let several = self.pages.len() > 1;
        for page in self.pages {
            let anchor = self.page_anchor(page);
            if several {
                let _ = writeln!(out, "<li class=\"toc-page\"><a href=\"#{anchor}\">{}</a></li>", esc(&page.title));
            }
            for h in headings(&page.doc, 3) {
                let id = heading_id(h.block_id.as_deref(), &h.text);
                let _ =
                    writeln!(out, "<li class=\"toc-l{}\"><a href=\"#{}\">{}</a></li>", h.level, esc(&id), esc(&h.text));
            }
        }
        out.push_str("</ul>\n</nav>\n");
    }

    fn page(&mut self, index: usize, page: &'a ExportPage, out: &mut String) {
        let s = Settings::read(&page.settings);
        self.bg = s.background.clone();
        self.highlights = if self.opts.highlights == HighlightMode::Show { &page.highlights } else { &[] };
        let mut style = String::new();
        if self.theme() {
            let (bg, ink) = page_colors(&s.background);
            let _ = write!(
                style,
                "--page-bg:{bg};--ink:{ink};--body-font:{};--heading-font:{};--text-size:{}px;--line-height:{};",
                font_stack(&s.body_font),
                font_stack(&s.heading_font),
                s.text_px,
                s.line_height
            );
            match s.width_px {
                Some(w) => {
                    let _ = write!(style, "--page-width:{w}px;");
                }
                None => style.push_str("--page-width:100%;"),
            }
        }
        let mut class = String::from("page");
        if self.theme() {
            if let Some(align) = s.text_align {
                let _ = write!(class, " ta-{align}");
            }
            if s.indent_paragraphs {
                class.push_str(" para-indent");
            }
            if s.drop_cap {
                class.push_str(" page-dropcap");
            }
        }
        if let Some(book) = &self.opts.book {
            class.push_str(" chapter");
            if book.chapter_breaks && (index > 0 || book.cover || book.title_page || book.contents) {
                class.push_str(" break");
            }
        } else if index > 0 {
            class.push_str(" break");
        }
        let _ =
            writeln!(out, "<article class=\"{class}\" id=\"{}\" style=\"{}\">", self.page_anchor(page), esc(&style));
        self.page_header(index, page, &s, out);
        out.push_str("<div class=\"body\">\n");
        self.blocks(children(&page.doc), out);
        out.push_str("</div>\n</article>\n");
    }

    fn page_header(&mut self, index: usize, page: &ExportPage, s: &Settings, out: &mut String) {
        let mut class = format!("page-head title-{}", slug(&s.title_style));
        if s.title_center {
            class.push_str(" center");
        }
        let _ = writeln!(out, "<header class=\"{class}\">");
        if let Some(book) = self.opts.book.clone() {
            // the chapter's own line above its title ("Chương một"), else its number in the book's language
            if let Some(e) = &s.eyebrow {
                let _ = writeln!(out, "<p class=\"chapter-no\">{}</p>", esc(e));
            } else if book.number_chapters {
                let _ = writeln!(out, "<p class=\"chapter-no\">{}</p>", esc(&self.lang.chapter(index + 1)));
            }
            let _ = writeln!(out, "<h1 class=\"page-title\">{}</h1>", esc(&page.title));
            out.push_str("</header>\n");
            return;
        }
        let mut title_done = false;
        if let Some(cover) = &s.cover {
            if let Some(url) = self.image_url(&cover.src) {
                let _ = write!(
                    out,
                    "<div class=\"page-cover\" style=\"height:{}px\"><img src=\"{}\" alt=\"\" style=\"object-position:50% {}%\">",
                    cover.height_px,
                    esc(&url),
                    cover.position_y
                );
                if cover.title_on_cover {
                    let _ = write!(out, "<h1 class=\"page-title cover-title\">{}</h1>", esc(&page.title));
                    title_done = true;
                }
                out.push_str("</div>\n");
            }
        }
        if let Some(e) = &s.eyebrow {
            let _ = writeln!(out, "<p class=\"eyebrow\">{}</p>", esc(e));
        }
        if !title_done && s.show_title {
            let _ = writeln!(out, "<h1 class=\"page-title\">{}</h1>", esc(&page.title));
        }
        if s.show_byline {
            let parts: Vec<&str> = [page.author.as_deref(), page.updated_at.as_deref()].into_iter().flatten().collect();
            if !parts.is_empty() {
                let _ = writeln!(out, "<p class=\"byline\">{}</p>", esc(&parts.join(" · ")));
            }
        }
        out.push_str("</header>\n");
    }

    // -----------------------------------------------------------------------------------------------------------
    // Assets
    // -----------------------------------------------------------------------------------------------------------

    /// The URL to write for a picture: embedded or copied when the source gives it, else the checked link.
    fn image_url(&mut self, src: &str) -> Option<String> {
        if let Some(hit) = self.cache.get(src) {
            return hit.clone();
        }
        let url = match self.assets.fetch(src) {
            Some(asset) => match image_mime(&asset) {
                Some(mime) => Some(self.store(&file_name_of(src, image_ext(mime)), mime, asset.bytes)),
                None => safe_src(src).map(|s| absolute(&s, self.base())),
            },
            None => safe_src(src).map(|s| absolute(&s, self.base())),
        };
        self.cache.insert(src.to_string(), url.clone());
        url
    }

    /// Writes bytes as a data URI (one file) or into `assets/` (folder) and returns the URL.
    fn store(&mut self, name: &str, mime: &str, bytes: Vec<u8>) -> String {
        match self.opts.layout {
            HtmlLayout::SingleFile => data_uri(mime, &bytes),
            HtmlLayout::Folder => {
                let path = format!("assets/{}", self.names.take(name));
                self.files.push(OutFile { path: path.clone(), bytes });
                path
            }
        }
    }

    /// An HTML embed: running in a sandboxed frame in an HTML file (scripts only when the block allows them, never
    /// with access to the file around it), a picture of it on paper, else a line that says to open the page.
    fn html_embed(&mut self, node: &Value, out: &mut String) {
        let title = attr_str(node, "title");
        let html = attr_str(node, "html").unwrap_or("");
        if self.opts.print.is_none() && !html.is_empty() {
            let sandbox = if attr_bool(node, "runScripts") { "allow-scripts" } else { "" };
            let height = attr_f64(node, "height").filter(|h| *h > 0.0).unwrap_or(400.0).clamp(80.0, 4000.0).round();
            let _ = write!(
                out,
                "<figure class=\"html-embed\"><iframe sandbox=\"{sandbox}\" srcdoc=\"{}\" title=\"{}\" loading=\"lazy\" \
                 style=\"width:100%;height:{height}px;border:0;border-radius:8px\"></iframe>",
                esc(html),
                esc(title.unwrap_or("HTML embed"))
            );
            if let Some(t) = title {
                let _ = write!(out, "<figcaption>{}</figcaption>", esc(t));
            }
            out.push_str("</figure>\n");
            return;
        }
        let id = node.get("attrs").and_then(|a| a.get("blockId")).and_then(Value::as_str).unwrap_or("");
        if let Some(url) = Some(id).filter(|i| !i.is_empty()).and_then(|i| self.drawing_url(DrawingKind::Embed, i)) {
            let _ = write!(
                out,
                "<figure class=\"drawing\"><img src=\"{}\" alt=\"{}\">",
                esc(&url),
                esc(title.unwrap_or(""))
            );
            if let Some(t) = title {
                let _ = write!(out, "<figcaption>{}</figcaption>", esc(t));
            }
            out.push_str("</figure>\n");
            return;
        }
        let note = match title {
            Some(t) => format!("HTML embed: {t} (open the page to run it)"),
            None => "HTML embed (open the page to run it)".to_string(),
        };
        let _ = writeln!(out, "<p class=\"embed-note\">{}</p>", esc(&note));
    }

    fn drawing_url(&mut self, kind: DrawingKind, id: &str) -> Option<String> {
        let key = format!("drawing:{kind:?}:{id}");
        if let Some(hit) = self.cache.get(&key) {
            return hit.clone();
        }
        let url =
            self.assets.drawing_png(kind, id).filter(|b| !b.is_empty()).map(|png| {
                self.store(&format!("{}.png", file_name_of(id, "x").trim_end_matches(".x")), "image/png", png)
            });
        self.cache.insert(key, url.clone());
        url
    }

    /// The link for an uploaded video or file: carried inside the export (a data URI in one file, a copy under
    /// `assets/` in a folder) so it plays or downloads where the file is opened, else the checked source. A PDF
    /// keeps the link (paper cannot play it), and so does a file over [`MEDIA_EMBED_LIMIT`].
    fn media_link(&mut self, src: &str) -> Option<String> {
        if self.opts.print.is_none() && src.starts_with("/uploads/") {
            let key = format!("media:{src}");
            if let Some(hit) = self.cache.get(&key) {
                return hit.clone();
            }
            let small = self.assets.size_of(src).is_none_or(|n| n <= MEDIA_EMBED_LIMIT);
            if let Some(asset) = small.then(|| self.assets.fetch(src)).flatten() {
                if asset.bytes.len() as u64 <= MEDIA_EMBED_LIMIT {
                    let name = file_name_of(src, "bin");
                    // the extension names a type a browser plays or opens better than a stored octet-stream
                    let mime = match media_mime(&name) {
                        "application/octet-stream" if !asset.mime.is_empty() => asset.mime.clone(),
                        known => known.to_string(),
                    };
                    let url = self.store(&name, &mime, asset.bytes);
                    self.cache.insert(key, Some(url.clone()));
                    return Some(url);
                }
            }
        }
        safe_href(src).map(|s| absolute(&s, self.base()))
    }

    // -----------------------------------------------------------------------------------------------------------
    // Blocks
    // -----------------------------------------------------------------------------------------------------------

    fn blocks(&mut self, nodes: &[Value], out: &mut String) {
        let mut i = 0;
        while i < nodes.len() {
            // on paper a heading travels with the block under it, so it never ends a page alone
            if self.opts.print.is_some() && ty(&nodes[i]) == "heading" && i + 1 < nodes.len() {
                let mut end = i + 1;
                while end < nodes.len() && ty(&nodes[end]) == "heading" {
                    end += 1;
                }
                out.push_str("<div class=\"keep-next\">\n");
                for n in &nodes[i..(end + 1).min(nodes.len())] {
                    self.block(n, out);
                }
                out.push_str("</div>\n");
                i = end + 1;
                continue;
            }
            self.block(&nodes[i], out);
            i += 1;
        }
    }

    fn block(&mut self, node: &Value, out: &mut String) {
        match ty(node) {
            "paragraph" => self.paragraph(node, out),
            "heading" => {
                let level = (attr_int(node, "level", 1, 1, 6) as u8 + self.heading_shift).min(6);
                let text = inline_text(node);
                let id = heading_id(attr_str(node, "blockId"), &text);
                let style = text_block_style(node);
                let _ = write!(out, "<h{level} id=\"{}\"{}>", esc(&id), style_attr(&style));
                self.inline(node, out);
                let _ = writeln!(out, "</h{level}>");
            }
            "blockquote" => {
                let variant = match attr_str(node, "variant") {
                    Some("serif") => "serif",
                    Some("card") => "card",
                    _ => "plain",
                };
                let _ = writeln!(out, "<blockquote class=\"quote quote-{variant}\">");
                self.blocks(children(node), out);
                if let Some(src) = attr_str(node, "source") {
                    let _ = writeln!(out, "<cite>{}</cite>", esc(src));
                }
                out.push_str("</blockquote>\n");
            }
            "pullQuote" => {
                let align = match attr_str(node, "textAlign") {
                    Some("left") => "left",
                    Some("right") => "right",
                    _ => "center",
                };
                let _ = write!(out, "<figure class=\"pull-quote\" style=\"text-align:{align}\"><blockquote>");
                self.inline(node, out);
                out.push_str("</blockquote>");
                if let Some(src) = attr_str(node, "source") {
                    let _ = write!(out, "<figcaption>{}</figcaption>", esc(src));
                }
                out.push_str("</figure>\n");
            }
            "bulletList" => {
                let style = match attr_str(node, "listStyle") {
                    Some("circle") => " class=\"ls-circle\"",
                    Some("square") => " class=\"ls-square\"",
                    Some("dash") => " class=\"ls-dash\"",
                    _ => "",
                };
                let _ = writeln!(out, "<ul{style}>");
                self.list_items(node, out);
                out.push_str("</ul>\n");
            }
            "orderedList" => {
                let start = attr_int(node, "start", 1, -1_000_000, 1_000_000);
                let style = match attr_str(node, "listStyle") {
                    Some("lower-alpha") => "lower-alpha",
                    Some("upper-alpha") => "upper-alpha",
                    Some("lower-roman") => "lower-roman",
                    Some("upper-roman") => "upper-roman",
                    Some("decimal-paren") => "decimal-paren",
                    _ => "decimal",
                };
                let start_attr = if start != 1 { format!(" start=\"{start}\"") } else { String::new() };
                let _ = writeln!(out, "<ol class=\"ls-{style}\"{start_attr}>");
                self.list_items(node, out);
                out.push_str("</ol>\n");
            }
            "taskList" => {
                out.push_str("<ul class=\"tasks\">\n");
                for item in children(node) {
                    let done = attr_bool(item, "checked");
                    let (class, mark) = if done { ("task done", "☑") } else { ("task", "☐") };
                    let _ = write!(
                        out,
                        "<li class=\"{class}\"><span class=\"box\" aria-hidden=\"true\">{mark}</span><div>"
                    );
                    self.blocks(children(item), out);
                    out.push_str("</div></li>\n");
                }
                out.push_str("</ul>\n");
            }
            "listItem" | "taskItem" | "column" => self.blocks(children(node), out),
            "codeBlock" => self.code(node, out),
            "horizontalRule" => {
                let style = attr_str(node, "style").unwrap_or("line");
                let glyph = match style {
                    "dots" => Some("· · ·"),
                    "stars" => Some("✻ ✻ ✻"),
                    "fleuron" => Some("❧"),
                    "wave" => Some("～～～"),
                    _ => None,
                };
                match glyph {
                    Some(g) => {
                        let _ = writeln!(out, "<div class=\"rule rule-{style}\" role=\"separator\">{g}</div>");
                    }
                    None => {
                        let class = match style {
                            "short" | "thick" | "double" => style,
                            _ => "line",
                        };
                        let _ = writeln!(out, "<hr class=\"rule-{class}\">");
                    }
                }
            }
            "table" => self.table(node, out),
            "image" => self.image(node, out),
            "columns" => {
                let cols = children(node);
                let ratio: Vec<f64> = attr_str(node, "ratio")
                    .map(|r| {
                        r.split(':')
                            .filter_map(|p| p.trim().parse::<f64>().ok())
                            .filter(|n| *n > 0.0 && *n < 100.0)
                            .collect()
                    })
                    .unwrap_or_default();
                let template: Vec<String> = (0..cols.len())
                    .map(|i| {
                        format!("{}fr", ratio.get(i).copied().filter(|_| ratio.len() == cols.len()).unwrap_or(1.0))
                    })
                    .collect();
                let gap = attr_int(node, "gap", 24, 0, 200);
                let mut line = if attr_bool(node, "line") { " lined".to_string() } else { String::new() };
                if attr_str(node, "valign") == Some("middle") {
                    line.push_str(" valign-middle");
                    self.extra_css = true;
                }
                let _ = writeln!(
                    out,
                    "<div class=\"columns{line}\" style=\"grid-template-columns:{};gap:{gap}px\">",
                    template.join(" ")
                );
                for col in cols {
                    out.push_str("<div class=\"column\">\n");
                    self.blocks(children(col), out);
                    out.push_str("</div>\n");
                }
                out.push_str("</div>\n");
            }
            "callout" => {
                let kind = attr_str(node, "kind")
                    .filter(|k| matches!(*k, "warning" | "success" | "danger" | "note" | "custom"))
                    .unwrap_or("info");
                let style = attr_str(node, "style").filter(|s| matches!(*s, "bar" | "outline")).unwrap_or("soft");
                let (soft, accent) = callout_palette(kind);
                let custom = attr_str(node, "color");
                let fill = custom
                    .and_then(|c| resolve_color(c, ColorUse::Highlight, &self.bg))
                    .or_else(|| resolve_color(soft, ColorUse::Highlight, &self.bg))
                    .unwrap_or_else(|| "#CFE3F5".into());
                let line = custom
                    .and_then(|c| resolve_color(c, ColorUse::Text, &self.bg))
                    .or_else(|| resolve_color(accent, ColorUse::Text, &self.bg))
                    .unwrap_or_else(|| "#1F5A8E".into());
                let _ = writeln!(
                    out,
                    "<aside class=\"callout callout-{kind} callout-{style}\" style=\"--callout-bg:{fill};--callout-line:{line}\">"
                );
                if let Some(t) = attr_str(node, "title") {
                    let _ = writeln!(out, "<p class=\"callout-title\">{}</p>", esc(t));
                }
                self.blocks(children(node), out);
                out.push_str("</aside>\n");
            }
            "mathBlock" => {
                let latex = attr_str(node, "latex").unwrap_or("");
                match crate::math::mathml(latex, crate::math::MathLayout::Block) {
                    Some(math) => {
                        self.has_math = true;
                        match crate::math::split_tag(latex).1 {
                            Some(tag) => {
                                let _ = writeln!(
                                    out,
                                    "<div class=\"math-block tagged\">{math}<span class=\"math-tag\">({})</span></div>",
                                    esc(&tag)
                                );
                            }
                            None => {
                                let _ = writeln!(out, "<div class=\"math-block\">{math}</div>");
                            }
                        }
                    }
                    None => {
                        let _ =
                            writeln!(out, "<pre class=\"math-block\"><code class=\"math\">{}</code></pre>", esc(latex));
                    }
                }
            }
            "diagram" | "sketch" | "canvas" => self.drawing(node, out),
            "video" => self.video(node, out),
            "htmlEmbed" => self.html_embed(node, out),
            "fileCard" => {
                let src = attr_str(node, "src").unwrap_or("");
                let name = attr_str(node, "name").unwrap_or(src);
                let size = attr_f64(node, "size")
                    .map(human_size)
                    .map(|s| format!(" <span class=\"size\">{s}</span>"))
                    .unwrap_or_default();
                match self.media_link(src) {
                    Some(href) => {
                        let _ = writeln!(
                            out,
                            "<p class=\"file-card\"><a href=\"{}\" download>{}</a>{size}</p>",
                            esc(&href),
                            esc(name)
                        );
                    }
                    None => {
                        let _ = writeln!(out, "<p class=\"file-card\">{}{size}</p>", esc(name));
                    }
                }
            }
            "linkEmbed" => {
                let url = attr_str(node, "url").unwrap_or("");
                let title = attr_str(node, "title").unwrap_or(url);
                out.push_str("<div class=\"link-card\">");
                match safe_href(url) {
                    Some(href) => {
                        let _ =
                            write!(out, "<a href=\"{}\" rel=\"noopener noreferrer\">{}</a>", esc(&href), esc(title));
                    }
                    None => {
                        let _ = write!(out, "<strong>{}</strong>", esc(title));
                    }
                }
                if let Some(site) = attr_str(node, "site") {
                    let _ = write!(out, "<span class=\"site\">{}</span>", esc(site));
                }
                if let Some(d) = attr_str(node, "description") {
                    let _ = write!(out, "<p>{}</p>", esc(d));
                }
                out.push_str("</div>\n");
            }
            "pageCard" => {
                let page = attr_str(node, "page").unwrap_or("");
                if page.is_empty() {
                    return;
                }
                match self.page_anchors.get(&page.trim().to_lowercase()) {
                    Some(anchor) => {
                        let _ = writeln!(out, "<p class=\"page-card\"><a href=\"#{anchor}\">{}</a></p>", esc(page));
                    }
                    None => {
                        let _ = writeln!(out, "<p class=\"page-card\">{}</p>", esc(page));
                    }
                }
            }
            "ticketCard" => {
                let _ = writeln!(out, "<p class=\"ticket-card\">{}</p>", esc(attr_str(node, "key").unwrap_or("")));
            }
            _ => {
                // A node this version does not know: keep its text.
                if node.get("content").is_some() {
                    let kids = children(node);
                    if kids
                        .iter()
                        .all(|k| matches!(ty(k), "text" | "hardBreak" | "docRef" | "ticketRef" | "mathInline"))
                    {
                        out.push_str("<p>");
                        self.inline(node, out);
                        out.push_str("</p>\n");
                    } else {
                        self.blocks(kids, out);
                    }
                }
            }
        }
    }

    fn list_items(&mut self, list: &Value, out: &mut String) {
        for item in children(list) {
            out.push_str("<li>");
            self.blocks(children(item), out);
            out.push_str("</li>\n");
        }
    }

    fn paragraph(&mut self, node: &Value, out: &mut String) {
        let mut classes = Vec::new();
        match attr_str(node, "variant") {
            Some("lead") => classes.push("lead".to_string()),
            Some("small") => classes.push("small".to_string()),
            _ => {}
        }
        let drop = attr_int(node, "dropCap", 0, 0, 5);
        let mut style = text_block_style(node);
        if drop >= 2 {
            let raised = attr_str(node, "dropCapStyle") == Some("raised");
            let body_font = attr_str(node, "dropCapFont") == Some("body");
            let color = attr_str(node, "dropCapColor").and_then(|c| resolve_any_color(c, &self.bg));
            if drop == 2 || drop == 4 || raised || body_font || color.is_some() {
                // the sizes 2 and 4, the raised look, a colour or the body font: the rules of `EXTRA_CSS`
                self.extra_css = true;
                let mut c = format!("dropcap dropcap-x dropcap-{drop}");
                if raised {
                    c.push_str(" dropcap-raised");
                }
                if body_font {
                    c.push_str(" dropcap-body");
                }
                classes.push(c);
                if let Some(color) = color {
                    let _ = write!(style, "--dc:{color};");
                }
            } else {
                classes.push(format!("dropcap dropcap-{}", if drop >= 5 { 5 } else { 3 }));
            }
        }
        let class = if classes.is_empty() { String::new() } else { format!(" class=\"{}\"", classes.join(" ")) };
        let _ = write!(out, "<p{class}{}>", style_attr(&style));
        self.inline(node, out);
        out.push_str("</p>\n");
    }

    fn code(&mut self, node: &Value, out: &mut String) {
        let code: String = children(node).iter().filter_map(|t| t.get("text").and_then(Value::as_str)).collect();
        let lang = attr_str(node, "language");
        let numbers = attr_bool(node, "lineNumbers");
        let diff = attr_bool(node, "diff");
        let wrap = attr_bool(node, "wrap");
        let dark = attr_str(node, "theme") == Some("dark");
        let marked = parse_line_ranges(attr_str(node, "highlightLines").unwrap_or(""));
        let mut class = String::from("code");
        if dark {
            class.push_str(" dark");
        }
        if wrap {
            class.push_str(" wrap");
        }
        let _ = writeln!(out, "<figure class=\"{class}\">");
        let caption: Vec<&str> = [attr_str(node, "filename"), lang].into_iter().flatten().collect();
        if !caption.is_empty() {
            let _ = writeln!(out, "<figcaption>{}</figcaption>", esc(&caption.join(" · ")));
        }
        let lang_class = lang.map(|l| format!(" class=\"language-{}\"", slug(l))).unwrap_or_default();
        let _ = write!(out, "<pre><code{lang_class}>");
        let lines: Vec<&str> = code.split('\n').collect();
        for (i, line) in lines.iter().enumerate() {
            let n = i + 1;
            let mut lc = String::from("line");
            if marked.iter().any(|(a, b)| *a <= n && n <= *b) {
                lc.push_str(" hl");
            }
            if diff {
                if line.starts_with('+') {
                    lc.push_str(" add");
                } else if line.starts_with('-') {
                    lc.push_str(" del");
                }
            }
            let _ = write!(out, "<span class=\"{lc}\">");
            if numbers {
                let _ = write!(out, "<span class=\"ln\" aria-hidden=\"true\">{n}</span>");
            }
            out.push_str(&esc(line));
            out.push_str("</span>");
            if i + 1 < lines.len() {
                out.push('\n');
            }
        }
        out.push_str("</code></pre>\n</figure>\n");
    }

    fn table(&mut self, node: &Value, out: &mut String) {
        let style = attr_str(node, "style")
            .filter(|s| matches!(*s, "plain" | "lined" | "striped" | "boxed" | "minimal"))
            .unwrap_or("lined");
        let align = attr_str(node, "align").filter(|a| matches!(*a, "left" | "center" | "right"));
        // a table with a position is as wide as its content, as in the editor
        let mut width = match (attr_str(node, "width"), align) {
            (Some("fit"), _) | (_, Some(_)) => " fit".to_string(),
            _ => " full".to_string(),
        };
        let banded = attr_bool(node, "banded");
        let borders = attr_str(node, "borders").filter(|b| matches!(*b, "rows" | "outer" | "none"));
        let spacing = attr_str(node, "spacing").filter(|b| matches!(*b, "tight" | "roomy"));
        let caption = attr_str(node, "caption").filter(|c| !c.trim().is_empty());
        if banded {
            width.push_str(" banded");
        }
        if let Some(b) = borders {
            let _ = write!(width, " b-{b}");
        }
        if let Some(s) = spacing {
            let _ = write!(width, " sp-{s}");
        }
        if let Some(a) = align {
            let _ = write!(width, " al-{a}");
        }
        if banded || borders.is_some() || spacing.is_some() || align.is_some() {
            self.extra_css = true;
        }
        let (rows, _) = table_grid(node);
        // the rows after a header row alternate; without a header row the second, fourth... row is shaded
        let has_header = rows.first().is_some_and(|r| !r.is_empty() && r.iter().all(|c| ty(c.node) == "tableHeader"));
        let _ = writeln!(out, "<div class=\"table-wrap\"><table class=\"t-{style}{width}\">");
        for (ri, row) in rows.into_iter().enumerate() {
            let body_index = if has_header { ri.checked_sub(1) } else { Some(ri) };
            // the header row repeats at the top of each printed page the table runs onto
            if has_header && ri == 0 {
                out.push_str("<thead>");
            }
            if banded && body_index.is_some_and(|b| b % 2 == 1) {
                out.push_str("<tr class=\"band\">");
            } else {
                out.push_str("<tr>");
            }
            for cell in row {
                let tag = if ty(cell.node) == "tableHeader" { "th" } else { "td" };
                let mut attrs = String::new();
                if cell.colspan > 1 {
                    let _ = write!(attrs, " colspan=\"{}\"", cell.colspan);
                }
                if cell.rowspan > 1 {
                    let _ = write!(attrs, " rowspan=\"{}\"", cell.rowspan);
                }
                let mut css = String::new();
                if let Some(a @ ("left" | "center" | "right")) = attr_str(cell.node, "align") {
                    let _ = write!(css, "text-align:{a};");
                }
                if let Some(v @ ("top" | "middle" | "bottom")) = attr_str(cell.node, "verticalAlign") {
                    let _ = write!(css, "vertical-align:{v};");
                }
                if let Some(bg) =
                    attr_str(cell.node, "background").and_then(|c| resolve_color(c, ColorUse::Highlight, &self.bg))
                {
                    let _ = write!(css, "background:{bg};");
                }
                self.cell_look(cell.node, &mut css);
                // a code or a number alone in its cell ("FR-01", "12.500") stays on one line
                let words = inline_text(cell.node);
                let words = words.trim();
                if !words.is_empty() && words.chars().count() <= 14 && !words.contains(char::is_whitespace) {
                    css.push_str("white-space:nowrap;");
                }
                if let Some(w) = cell.node.get("attrs").and_then(|a| a.get("colwidth")).and_then(Value::as_array) {
                    let total: f64 = w.iter().filter_map(Value::as_f64).filter(|n| *n > 0.0 && *n < 5000.0).sum();
                    if total > 0.0 {
                        let _ = write!(css, "width:{}px;", total.round());
                    }
                }
                let _ = write!(out, "<{tag}{attrs}{}>", style_attr(&css));
                self.blocks(children(cell.node), out);
                let _ = write!(out, "</{tag}>");
            }
            out.push_str("</tr>\n");
            if has_header && ri == 0 {
                out.push_str("</thead>\n");
            }
        }
        out.push_str("</table>");
        if let Some(c) = caption {
            let _ = write!(out, "<div class=\"table-caption\">{}</div>", esc(c));
            self.extra_css = true;
        }
        out.push_str("</div>\n");
    }

    /// Adds the sides, line style, line colour and padding of a table cell to its inline CSS.
    fn cell_look(&mut self, cell: &Value, css: &mut String) {
        if let Some(sides) = attr_str(cell, "border") {
            self.extra_css = true;
            let width = match attr_str(cell, "borderStyle") {
                Some("thick") => "2px",
                _ => "1px",
            };
            let style = if attr_str(cell, "borderStyle") == Some("dashed") { "dashed" } else { "solid" };
            let color = attr_str(cell, "borderColor")
                .and_then(|c| resolve_any_color(c, &self.bg))
                .unwrap_or_else(|| "#D5DDD8".to_string());
            // as the editor: every side starts transparent, the listed ones get the line
            css.push_str("border-color:transparent;");
            for side in ["top", "right", "bottom", "left"] {
                if sides.split_whitespace().any(|s| s == side) {
                    let _ = write!(css, "border-{side}:{width} {style} {color};");
                }
            }
        }
        match attr_str(cell, "padding") {
            Some("tight") => css.push_str("padding:2px 8px;"),
            Some("roomy") => css.push_str("padding:10px 14px;"),
            _ => {}
        }
    }

    fn image(&mut self, node: &Value, out: &mut String) {
        let src = attr_str(node, "src").unwrap_or("");
        let alt = attr_str(node, "alt").unwrap_or("");
        let placement = match attr_str(node, "placement") {
            Some(p @ ("left" | "center" | "right")) => p,
            Some("floatLeft") => "float-left",
            Some("floatRight") => "float-right",
            _ => "block",
        };
        let mut fig_css = String::new();
        if let Some(pct) = attr_f64(node, "widthPct") {
            let _ = write!(fig_css, "width:{}%;", pct.clamp(10.0, 100.0).round());
        } else if let Some(w) = attr_f64(node, "width") {
            let _ = write!(fig_css, "width:{}px;max-width:100%;", w.clamp(16.0, 4000.0).round());
        }
        if placement.starts_with("float") {
            let gap = attr_int(node, "wrapGap", 16, 0, 96);
            let _ = write!(fig_css, "--wrap-gap:{gap}px;");
        }
        let mut img_css = String::new();
        // the line's own colour when it has one (#rrggbb), else the text colour
        let line = attr_str(node, "borderColor")
            .and_then(|c| resolve_any_color(c, &self.bg))
            .unwrap_or_else(|| "currentColor".to_string());
        match attr_str(node, "border") {
            Some("thin") => {
                let _ = write!(img_css, "border:1px solid {line};");
            }
            Some("medium") => {
                let _ = write!(img_css, "border:2px solid {line};");
            }
            Some("thick") => {
                let _ = write!(img_css, "border:4px solid {line};");
            }
            _ => {}
        }
        let radius = attr_int(node, "radius", 0, 0, 200);
        if radius > 0 {
            let _ = write!(img_css, "border-radius:{radius}px;");
        }
        if attr_bool(node, "shadow") {
            img_css.push_str(if attr_str(node, "shadowStyle") == Some("soft") {
                "box-shadow:0 2px 8px rgba(0,0,0,.12);"
            } else {
                "box-shadow:0 4px 16px rgba(0,0,0,.18);"
            });
        }
        let _ = write!(out, "<figure class=\"image place-{placement}\"{}>", style_attr(&fig_css));
        let url = if src.is_empty() { None } else { self.image_url(src) };
        let title = attr_str(node, "title").map(|t| format!(" title=\"{}\"", esc(t))).unwrap_or_default();
        let link = attr_str(node, "href").and_then(safe_href);
        if let Some(href) = &link {
            let _ = write!(out, "<a href=\"{}\" rel=\"noopener noreferrer\">", esc(href));
        }
        match url {
            Some(u) => {
                let _ = write!(out, "<img src=\"{}\" alt=\"{}\"{title}{}>", esc(&u), esc(alt), style_attr(&img_css));
            }
            None => {
                let _ = write!(
                    out,
                    "<span class=\"missing-image\">{}</span>",
                    esc(if alt.is_empty() { "Picture" } else { alt })
                );
            }
        }
        if link.is_some() {
            out.push_str("</a>");
        }
        if let Some(c) = attr_str(node, "caption") {
            let _ = write!(out, "<figcaption>{}</figcaption>", esc(c));
        }
        out.push_str("</figure>\n");
    }

    fn drawing(&mut self, node: &Value, out: &mut String) {
        let Some(kind) = DrawingKind::of_node_type(ty(node)) else {
            return;
        };
        let id = attr_str(node, "id").unwrap_or("");
        let label = attr_str(node, "label").unwrap_or(kind.label());
        let url = if id.is_empty() { None } else { self.drawing_url(kind, id) };
        match url {
            Some(u) => {
                let width = attr_f64(node, "widthPct")
                    .map(|p| format!(" style=\"width:{}%\"", p.clamp(10.0, 100.0).round()))
                    .unwrap_or_default();
                let _ = writeln!(
                    out,
                    "<figure class=\"drawing\"{width}><img src=\"{}\" alt=\"{}\"><figcaption>{}</figcaption></figure>",
                    esc(&u),
                    esc(label),
                    esc(label)
                );
            }
            None => {
                let line = placeholder_line(kind.label(), &crate::model::placeholder_title(label));
                let _ = writeln!(out, "<p class=\"placeholder\">{}</p>", esc(&line));
            }
        }
    }

    fn video(&mut self, node: &Value, out: &mut String) {
        let src = attr_str(node, "src").unwrap_or("");
        let title = attr_str(node, "title").or_else(|| attr_str(node, "caption")).unwrap_or("Video");
        let width = attr_f64(node, "widthPct").unwrap_or(100.0).clamp(10.0, 100.0).round();
        let _ = write!(out, "<figure class=\"video\" style=\"width:{width}%\">");
        let link = self.media_link(src);
        // a web page plays the video in place; the PDF keeps the poster and the link
        if let Some(href) = link.as_ref().filter(|h| self.opts.print.is_none() && is_playable(src, h)) {
            let poster = attr_str(node, "poster")
                .and_then(|p| self.image_url(p))
                .map(|u| format!(" poster=\"{}\"", esc(&u)))
                .unwrap_or_default();
            let _ = write!(
                out,
                "<video controls playsinline preload=\"metadata\"{poster} src=\"{}\" title=\"{}\" \
                 style=\"width:100%;border-radius:8px;background:#000\"></video>",
                esc(href),
                esc(title)
            );
            let caption: Vec<&str> =
                [attr_str(node, "caption"), attr_str(node, "description")].into_iter().flatten().collect();
            if !caption.is_empty() {
                let _ = write!(out, "<figcaption>{}</figcaption>", esc(&caption.join(" — ")));
            }
            out.push_str("</figure>\n");
            return;
        }
        if let Some(poster) = attr_str(node, "poster") {
            if let Some(url) = self.image_url(poster) {
                match &link {
                    Some(href) => {
                        let _ = write!(
                            out,
                            "<a href=\"{}\" rel=\"noopener noreferrer\"><img src=\"{}\" alt=\"{}\"></a>",
                            esc(href),
                            esc(&url),
                            esc(title)
                        );
                    }
                    None => {
                        let _ = write!(out, "<img src=\"{}\" alt=\"{}\">", esc(&url), esc(title));
                    }
                }
            }
        }
        match &link {
            Some(href) => {
                let _ = write!(
                    out,
                    "<p class=\"video-link\">▶ <a href=\"{}\" rel=\"noopener noreferrer\">{}</a></p>",
                    esc(href),
                    esc(title)
                );
            }
            None => {
                let _ = write!(out, "<p class=\"video-link\">▶ {}</p>", esc(title));
            }
        }
        let caption: Vec<&str> = [attr_str(node, "caption").filter(|c| *c != title), attr_str(node, "description")]
            .into_iter()
            .flatten()
            .collect();
        if !caption.is_empty() {
            let _ = write!(out, "<figcaption>{}</figcaption>", esc(&caption.join(" — ")));
        }
        out.push_str("</figure>\n");
    }

    // -----------------------------------------------------------------------------------------------------------
    // Inline
    // -----------------------------------------------------------------------------------------------------------

    fn inline(&mut self, block: &Value, out: &mut String) {
        let hls = block_highlights(block, self.highlights);
        for piece in pieces(block, &hls) {
            match piece {
                Piece::Break => out.push_str("<br>"),
                Piece::Text { text, marks } => {
                    let inner = esc(&text);
                    out.push_str(&self.wrap_marks(inner, &marks));
                }
                Piece::Atom { node, marks } => {
                    let inner = match ty(node) {
                        "docRef" => {
                            let label = esc(doc_ref_label(node));
                            match attr_str(node, "page").and_then(|p| self.page_anchors.get(&p.trim().to_lowercase())) {
                                Some(anchor) => format!("<a class=\"doc-ref\" href=\"#{anchor}\">{label}</a>"),
                                None => format!("<span class=\"doc-ref\">{label}</span>"),
                            }
                        }
                        "ticketRef" => {
                            format!("<span class=\"ticket-ref\">{}</span>", esc(attr_str(node, "key").unwrap_or("")))
                        }
                        "mathInline" => {
                            let latex = attr_str(node, "latex").unwrap_or("");
                            match crate::math::mathml(latex, crate::math::MathLayout::Inline) {
                                Some(math) => {
                                    self.has_math = true;
                                    format!("<span class=\"math\">{math}</span>")
                                }
                                None => format!("<code class=\"math\">{}</code>", esc(latex)),
                            }
                        }
                        _ => esc(&inline_text(node)),
                    };
                    out.push_str(&self.wrap_marks(inner, &marks));
                }
            }
        }
    }

    fn wrap_marks(&mut self, mut s: String, m: &Marks) -> String {
        if m.code {
            s = format!("<code>{s}</code>");
        }
        if m.sup {
            s = format!("<sup>{s}</sup>");
        }
        if m.sub {
            s = format!("<sub>{s}</sub>");
        }
        if m.strike {
            s = format!("<s>{s}</s>");
        }
        if m.underline {
            s = format!("<u>{s}</u>");
        }
        if m.italic {
            s = format!("<em>{s}</em>");
        }
        if m.bold {
            s = format!("<strong>{s}</strong>");
        }
        let mut css = String::new();
        if let Some(c) = m.color.as_deref().and_then(|c| resolve_color(c, ColorUse::Text, &self.bg)) {
            let _ = write!(css, "color:{c};");
        }
        if let Some(f) = m.font.as_deref().filter(|f| font_name(f).is_some()) {
            let _ = write!(css, "font-family:{};", font_stack(f));
        }
        if let Some(px) = m.size {
            let _ = write!(css, "font-size:{}px;", px.round());
        }
        if !css.is_empty() {
            s = format!("<span style=\"{}\">{s}</span>", esc(&css));
        }
        if let Some(h) = &m.highlight {
            let c = resolve_color(h.as_deref().unwrap_or("yellow"), ColorUse::Highlight, &self.bg)
                .unwrap_or_else(|| "#FFE9A8".into());
            s = format!("<mark style=\"background:{c}\">{s}</mark>");
        }
        if let Some(r) = &m.reader {
            let c = resolve_color(r.color.as_deref().unwrap_or("yellow"), ColorUse::Highlight, &self.bg)
                .unwrap_or_else(|| "#FFE9A8".into());
            let title = r.author.as_deref().map(|a| format!(" title=\"{}\"", esc(a))).unwrap_or_default();
            s = format!("<mark class=\"reader\" style=\"background:{c}\"{title}>{s}</mark>");
        }
        if let Some(link) = &m.link {
            let title = link.title.as_deref().map(|t| format!(" title=\"{}\"", esc(t))).unwrap_or_default();
            // a link to an uploaded file (slides, a spreadsheet) travels with the page and downloads from it
            let carried = link.href.starts_with("/uploads/").then(|| self.media_link(&link.href)).flatten();
            match carried.filter(|u| !u.starts_with('/') && !u.contains("://")) {
                Some(url) => {
                    let name = download_name(&file_name_of(&link.href, "bin"));
                    s = format!("<a href=\"{}\"{title} download=\"{}\">{s}</a>", esc(&url), esc(&name));
                }
                None => {
                    if let Some(href) = safe_href(&link.href) {
                        s = format!(
                            "<a href=\"{}\"{title} rel=\"noopener noreferrer\">{s}</a>",
                            esc(&absolute(&href, self.base()))
                        );
                    }
                }
            }
        }
        s
    }
}

/// The label of a chapter in a contents list (`3. The Long Tide` when chapters are numbered).
pub(crate) fn chapter_label(book: &Book, index: usize, title: &str) -> String {
    if book.number_chapters { format!("{}. {title}", index + 1) } else { title.to_string() }
}

/// The id of a heading: its block id, else a slug of its text.
fn heading_id(block_id: Option<&str>, text: &str) -> String {
    match block_id {
        Some(id) => format!("h-{}", slug(id)),
        None => format!("h-{}", slug(text)),
    }
}

/// The inline CSS of a paragraph or heading (alignment, indent, line height, spacing).
fn text_block_style(node: &Value) -> String {
    let mut css = String::new();
    if let Some(a @ ("left" | "center" | "right" | "justify")) = attr_str(node, "textAlign") {
        let _ = write!(css, "text-align:{a};");
    }
    let indent = attr_int(node, "indent", 0, 0, 8);
    if indent > 0 {
        let _ = write!(css, "padding-left:{}px;", indent * 24);
    }
    if let Some(lh) = attr_f64(node, "lineHeight").filter(|n| (0.5..=4.0).contains(n)) {
        let _ = write!(css, "line-height:{lh};");
    }
    if let Some(px) = attr_f64(node, "spaceBefore").filter(|n| (0.0..=400.0).contains(n)) {
        let _ = write!(css, "margin-top:{}px;", px.round());
    }
    if let Some(px) = attr_f64(node, "spaceAfter").filter(|n| (0.0..=400.0).contains(n)) {
        let _ = write!(css, "margin-bottom:{}px;", px.round());
    }
    css
}

fn style_attr(css: &str) -> String {
    if css.is_empty() { String::new() } else { format!(" style=\"{}\"", esc(css)) }
}

/// Reads `"5-6,9"` into inclusive line ranges.
pub(crate) fn parse_line_ranges(s: &str) -> Vec<(usize, usize)> {
    s.split(',')
        .filter_map(|part| {
            let part = part.trim();
            match part.split_once('-') {
                Some((a, b)) => Some((a.trim().parse().ok()?, b.trim().parse().ok()?)),
                None => part.parse().ok().map(|n| (n, n)),
            }
        })
        .collect()
}

/// A size for people (`117.6 KB`).
pub(crate) fn human_size(bytes: f64) -> String {
    if bytes < 1024.0 {
        format!("{} B", bytes.max(0.0).round())
    } else if bytes < 1024.0 * 1024.0 {
        format!("{:.1} KB", bytes / 1024.0)
    } else {
        format!("{:.1} MB", bytes / 1024.0 / 1024.0)
    }
}

/// A rough height of the pages in CSS px, for "fit to content" (one long page).
fn estimate_height(pages: &[ExportPage]) -> f64 {
    fn walk(node: &Value) -> f64 {
        match ty(node) {
            "paragraph" | "pullQuote" => 28.0 + (inline_text(node).chars().count() as f64 / 80.0).ceil() * 27.0,
            "heading" => 64.0,
            "codeBlock" => {
                let text: String =
                    children(node).iter().filter_map(|t| t.get("text").and_then(Value::as_str)).collect();
                48.0 + text.lines().count() as f64 * 22.0
            }
            "image" | "diagram" | "sketch" | "canvas" | "video" => 460.0,
            "horizontalRule" | "mathBlock" | "fileCard" | "pageCard" | "ticketCard" | "htmlEmbed" => 60.0,
            "linkEmbed" => 120.0,
            "columns" => children(node).iter().map(walk).fold(0.0, f64::max) + 24.0,
            "tableRow" => children(node).iter().map(walk).fold(0.0, f64::max).max(36.0),
            _ => children(node).iter().map(walk).sum::<f64>() + 16.0,
        }
    }
    pages.iter().map(|p| 260.0 + walk(&p.doc)).sum::<f64>() + 200.0
}

/// The print rules of a paged export: the paper, its margins, the running header and page numbers, and where pages
/// break. `sheet` is the colour of the whole sheet (the page's background), margins included; `None` leaves the
/// paper white.
fn print_css(setup: &PageSetup, header: &str, content_height: f64, sheet: Option<&str>) -> String {
    let mut css = String::from("@media print {\n");
    let margin = setup.margins.mm();
    let fill = sheet.map(|c| format!(" background: {c};")).unwrap_or_default();
    match setup.size {
        PageSize::FitToContent => {
            // 794 px is the width of A4 at 96 dpi; Chromium allows pages up to 200 inches (19 200 px).
            let height = content_height.clamp(1123.0, 19_200.0).round();
            let _ = writeln!(css, "@page {{ size: 794px {height}px; margin: {margin}mm;{fill} }}");
        }
        size => {
            let paper = match size {
                PageSize::Letter => "letter",
                PageSize::A3 => "A3",
                _ => "A4",
            };
            let turn = if setup.orientation == crate::model::Orientation::Landscape { "landscape" } else { "portrait" };
            let _ = write!(css, "@page {{ size: {paper} {turn}; margin: {margin}mm;{fill}");
            if setup.header_footer == HeaderFooter::On {
                let _ = write!(
                    css,
                    " @top-right {{ content: {}; font: 9pt system-ui, sans-serif; color: #5B6B60; }} @bottom-center {{ content: counter(page); font: 9pt system-ui, sans-serif; color: #5B6B60; }}",
                    css_string(header)
                );
            }
            css.push_str(" }\n");
            css.push_str(".book-cover, .title-page { break-after: page; min-height: 0; }\n");
        }
    }
    css.push_str(
        "body { background: none !important; }\n.page { max-width: none !important; padding: 0 !important; box-shadow: none !important; }\n\
         .page.break { break-before: page; }\n.toc { break-after: page; }\nfigure, pre, .callout, img, tr { break-inside: avoid; }\n.keep-next { break-inside: avoid; }\n.table-wrap { overflow: visible; }\n\
         h1, h2, h3, h4, h5, h6 { break-after: avoid; }\na { color: inherit; }\n",
    );
    if setup.size == PageSize::FitToContent {
        css.push_str(".page.break, .toc, .book-cover, .title-page { break-before: auto; break-after: auto; }\n");
    }
    css.push_str("}\n");
    css
}

fn theme_css(s: &Settings) -> String {
    let (bg, ink) = page_colors(&s.background);
    format!(
        "body.theme {{ background: {bg}; color: {ink}; font-family: {}; }}\n{THEME_CSS}{PARAGRAPH_CSS}",
        font_stack(&s.body_font)
    )
}

/// The page settings for paragraphs (as the reader draws them, pageLook.css): their alignment, a first-line indent
/// instead of a space, a drop cap on the first one. A paragraph's own alignment still wins (it is inline).
/// The largest uploaded video or file an HTML export carries inside itself (50 MB); a larger one stays a link.
const MEDIA_EMBED_LIMIT: u64 = 50 * 1024 * 1024;

/// Returns the media type of an uploaded file by its extension, for the data URI it is carried in.
fn media_mime(name: &str) -> &'static str {
    let ext = name.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
    match ext.as_str() {
        "mp4" | "m4v" => "video/mp4",
        "webm" => "video/webm",
        "ogv" | "ogg" => "video/ogg",
        "mov" => "video/quicktime",
        "mp3" => "audio/mpeg",
        "pdf" => "application/pdf",
        "pptx" => "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        "docx" => "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "xlsx" => "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "csv" => "text/csv",
        "zip" => "application/zip",
        _ => "application/octet-stream",
    }
}

/// Returns the name a carried file saves under: the stored name without the `-1a2b3c4d5e6f` the upload store adds
/// to keep names apart (`deck-68edbba08866.pptx` saves as `deck.pptx`).
fn download_name(stored: &str) -> String {
    let (stem, ext) = stored.rsplit_once('.').unwrap_or((stored, ""));
    let stem = match stem.rsplit_once('-') {
        Some((base, tag)) if !base.is_empty() && tag.len() == 12 && tag.bytes().all(|b| b.is_ascii_hexdigit()) => base,
        _ => stem,
    };
    if ext.is_empty() { stem.to_string() } else { format!("{stem}.{ext}") }
}

/// Whether a browser can play the video at `src` in place (`url` is where the export points to it).
fn is_playable(src: &str, url: &str) -> bool {
    url.starts_with("data:video/") || media_mime(src).starts_with("video/") && !media_mime(src).ends_with("quicktime")
}

const PARAGRAPH_CSS: &str = ".page.ta-center .body p { text-align: center; }\n\
.page.ta-right .body p { text-align: right; }\n\
.page.ta-justify .body p { text-align: justify; hyphens: auto; }\n\
.page.para-indent .body p { margin-top: 0; margin-bottom: 0; }\n\
.page.para-indent .body p + p { text-indent: 1.6em; }\n\
.page.page-dropcap .body > p:first-of-type::first-letter, \
.page.page-dropcap .body > .keep-next:first-child > p:first-of-type::first-letter { float: left; font-size: 3.3em; line-height: .85; \
padding: 4px 8px 0 0; font-family: var(--heading-font, inherit); }\n";

const BASE_CSS: &str = r#"*, *::before, *::after { box-sizing: border-box; }
body { margin: 0; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
img { max-width: 100%; height: auto; }
.page { margin: 0 auto; padding: 32px 24px 48px; }
.page-head { margin-bottom: 24px; }
.page-head.center { text-align: center; }
.page-cover { position: relative; overflow: hidden; border-radius: 8px; margin-bottom: 24px; }
.cover-title { position: absolute; left: 24px; right: 24px; bottom: 16px; margin: 0; color: #FFFFFF; text-shadow: 0 1px 8px rgba(0,0,0,.5); }
.page-cover img { width: 100%; height: 100%; object-fit: cover; }
.eyebrow { text-transform: uppercase; letter-spacing: .08em; font-size: .8em; opacity: .75; margin: 0 0 8px; }
.byline { opacity: .7; font-size: .9em; }
.chapter-no { text-transform: uppercase; letter-spacing: .1em; font-size: .85em; opacity: .7; margin: 0 0 4px; }
.book-cover, .title-page { text-align: center; padding: 64px 24px; min-height: 60vh; display: flex; flex-direction: column; justify-content: center; align-items: center; }
.book-cover .cover-img { max-height: 70vh; margin-bottom: 24px; }
.book-title { font-size: 2.6em; margin: 8px 0; }
.toc { max-width: 680px; margin: 0 auto; padding: 32px 24px; }
.toc ul, .toc ol { padding-left: 1.2em; }
.toc .toc-l2 { margin-left: 1em; } .toc .toc-l3 { margin-left: 2em; }
.toc .toc-page { font-weight: 600; list-style: none; margin-left: -1.2em; }
.toc ul.chapters { list-style: none; padding-left: 0; }
.lead { font-size: 1.2em; } .small { font-size: .85em; }
.dropcap::first-letter { float: left; font-size: 3.2em; line-height: .9; padding: 4px 8px 0 0; }
.dropcap-5::first-letter { font-size: 5em; }
blockquote { margin: 16px 0; padding: 4px 16px; border-left: 3px solid currentColor; }
blockquote cite { display: block; font-size: .9em; opacity: .75; margin-top: 4px; }
blockquote.quote-serif { font-family: Georgia, serif; font-style: italic; }
blockquote.quote-card { border: 1px solid rgba(0,0,0,.15); border-radius: 8px; padding: 12px 16px; }
.pull-quote { margin: 24px 0; } .pull-quote blockquote { border: 0; font-size: 1.5em; font-style: italic; padding: 0; margin: 0; }
.pull-quote figcaption { opacity: .75; margin-top: 8px; }
ul.ls-circle { list-style-type: circle; } ul.ls-square { list-style-type: square; } ul.ls-dash { list-style-type: "– "; }
ol.ls-lower-alpha { list-style-type: lower-alpha; } ol.ls-upper-alpha { list-style-type: upper-alpha; }
ol.ls-lower-roman { list-style-type: lower-roman; } ol.ls-upper-roman { list-style-type: upper-roman; }
ul.tasks { list-style: none; padding-left: 4px; } .task { display: flex; gap: 8px; } .task .box { flex: none; }
.task > div > p:first-child { margin-top: 0; } .task.done > div { text-decoration: line-through; opacity: .7; }
figure { margin: 16px 0; } figcaption { font-size: .85em; opacity: .75; margin-top: 6px; }
figure.code pre { margin: 0; padding: 12px 16px; overflow-x: auto; border-radius: 6px; background: #F3F5F4; color: #1E2A22; font: .9em/1.5 ui-monospace, Menlo, Consolas, monospace; }
figure.code.dark pre { background: #1E2A22; color: #E6EEE8; }
figure.code.wrap pre { white-space: pre-wrap; word-break: break-word; }
figure.code .line { display: inline; } figure.code .hl { background: rgba(255, 214, 102, .35); }
figure.code .add { background: rgba(46, 160, 67, .18); } figure.code .del { background: rgba(248, 81, 73, .18); }
figure.code .ln { display: inline-block; width: 3ch; margin-right: 12px; text-align: right; opacity: .5; user-select: none; }
code { font-family: ui-monospace, Menlo, Consolas, monospace; font-size: .92em; }
code.math { font-style: italic; } .math-block { text-align: center; padding: 8px; overflow-x: auto; }
math { font-family: "STIX Two Math", "Cambria Math", "Latin Modern Math", math; }
.math-block.tagged { position: relative; padding-right: 3em; } .math-tag { position: absolute; right: 0; top: 50%; transform: translateY(-50%); } math[display="block"] { font-size: 1.1em; }
hr { border: 0; border-top: 1px solid currentColor; opacity: .3; margin: 24px 0; }
hr.rule-short { width: 80px; margin: 24px auto; } hr.rule-thick { border-top-width: 4px; } hr.rule-double { border-top: 4px double currentColor; }
.rule { text-align: center; margin: 24px 0; opacity: .6; letter-spacing: .3em; }
.table-wrap { overflow-x: auto; margin: 16px 0; }
table { border-collapse: collapse; } table.full { width: 100%; }
th, td { padding: 6px 10px; vertical-align: top; text-align: left; }
th > p, td > p { margin: 0; }
table.t-lined th, table.t-lined td, table.t-boxed th, table.t-boxed td { border: 1px solid rgba(0,0,0,.18); }
table.t-striped tr:nth-child(even) td { background: rgba(0,0,0,.04); }
table.t-minimal th { border-bottom: 2px solid rgba(0,0,0,.25); } table.t-minimal td { border-bottom: 1px solid rgba(0,0,0,.1); }
figure.image.place-center, figure.image.place-block { margin-left: auto; margin-right: auto; }
figure.image.place-left { margin-right: auto; } figure.image.place-right { margin-left: auto; }
figure.image.place-float-left { float: left; margin: 4px var(--wrap-gap, 16px) 8px 0; max-width: 50%; }
figure.image.place-float-right { float: right; margin: 4px 0 8px var(--wrap-gap, 16px); max-width: 50%; }
figure.image img { display: block; width: 100%; }
.missing-image { display: block; padding: 24px; border: 1px dashed currentColor; opacity: .6; text-align: center; }
.body::after { content: ""; display: block; clear: both; }
.columns { display: grid; margin: 16px 0; } .columns.lined .column + .column { border-left: 1px solid rgba(0,0,0,.15); padding-left: 12px; }
.column > :first-child { margin-top: 0; }
.callout { margin: 16px 0; padding: 12px 16px; border-radius: 8px; background: var(--callout-bg); }
.callout-bar { border-radius: 0; border-left: 4px solid var(--callout-line); }
.callout-outline { background: none; border: 1.5px solid var(--callout-line); }
.callout-title { font-weight: 700; margin: 0 0 4px; } .callout > p:last-child { margin-bottom: 0; }
.placeholder, .embed-note { padding: 10px 14px; border: 1px dashed rgba(0,0,0,.3); border-radius: 6px; font-size: .9em; opacity: .85; }
.drawing img { display: block; margin: 0 auto; border: 1px solid rgba(0,0,0,.08); border-radius: 6px; }
.video img { display: block; width: 100%; border-radius: 6px; } .video-link { margin: 6px 0 0; }
.file-card, .page-card, .ticket-card { padding: 10px 14px; border: 1px solid rgba(0,0,0,.15); border-radius: 6px; }
.file-card .size { opacity: .6; margin-left: 8px; font-size: .85em; }
.link-card { padding: 10px 14px; border: 1px solid rgba(0,0,0,.15); border-radius: 6px; margin: 16px 0; }
.link-card .site { opacity: .6; margin-left: 8px; font-size: .85em; } .link-card p { margin: 4px 0 0; opacity: .8; }
.ticket-ref, .ticket-card { font-family: ui-monospace, Menlo, Consolas, monospace; }
.doc-ref { text-decoration: underline dotted; }
mark { color: inherit; padding: 0 1px; }
"#;

/// Rules for the rich attributes (banded rows, borders, spacing, position and caption of a table, cell padding, drop
/// cap sizes and looks, middle-aligned columns); written only when a page uses one, so other pages keep their bytes.
const EXTRA_CSS: &str = r#"table.banded tr.band td { background: #F6FAF7; }
table.b-rows th, table.b-rows td { border-left-color: transparent; border-right-color: transparent; }
table.b-outer { outline: 1px solid #D5DDD8; outline-offset: -1px; }
table.b-outer th, table.b-outer td, table.b-none th, table.b-none td { border-color: transparent; }
table.sp-tight th, table.sp-tight td { padding: 2px 8px; } table.sp-roomy th, table.sp-roomy td { padding: 10px 14px; }
table.al-center { margin-left: auto; margin-right: auto; } table.al-right { margin-left: auto; }
.table-caption { margin-top: 6px; font-size: .75em; opacity: .75; text-align: center; }
.dropcap-x::first-letter { float: left; font-weight: 700; line-height: .82; padding: 3px 7px 0 0; color: var(--dc, inherit); font-family: var(--heading-font, inherit); }
.dropcap-2::first-letter { font-size: 2.4em; } .dropcap-3.dropcap-x::first-letter { font-size: 3.54em; }
.dropcap-4::first-letter { font-size: 4.7em; } .dropcap-5.dropcap-x::first-letter { font-size: 5.8em; }
.dropcap-x.dropcap-body::first-letter { font-family: inherit; }
.dropcap-x.dropcap-raised::first-letter { float: none; line-height: 1; padding: 0 2px 0 0; }
.columns.valign-middle { align-items: center; }
"#;

const THEME_CSS: &str = r#"body.theme .page { max-width: var(--page-width, 680px); background: var(--page-bg); color: var(--ink); font-family: var(--body-font); font-size: var(--text-size, 17px); line-height: var(--line-height, 1.6); }
body.theme h1, body.theme h2, body.theme h3, body.theme h4, body.theme h5, body.theme h6, body.theme .book-title { font-family: var(--heading-font, inherit); line-height: 1.25; }
body.theme .page-title { font-size: 2.2em; margin: 0 0 8px; }
body.theme .title-serif .page-title { font-family: Georgia, 'Lora', serif; font-weight: 500; }
body.theme .title-display .page-title { font-size: 3em; letter-spacing: -.02em; }
body.theme a { color: inherit; text-decoration-thickness: 1px; text-underline-offset: 2px; }
"#;

const PLAIN_CSS: &str = r#"body.plain .page { max-width: 760px; font-family: system-ui, sans-serif; line-height: 1.5; }
"#;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn line_ranges_parse() {
        assert_eq!(parse_line_ranges("5-6,9"), vec![(5, 6), (9, 9)]);
        assert!(parse_line_ranges("x").is_empty());
    }

    #[test]
    fn css_strings_cannot_close_the_style() {
        let s = css_string("a\"</style><script>");
        assert!(!s.contains("</style"));
        assert!(!s.contains("<script"));
    }
}
