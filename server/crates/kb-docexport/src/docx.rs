//! Word export with `docx-rs`: real styles (Title, Subtitle, Heading 1-6, Quote, Intense Quote, Code, Caption,
//! List Paragraph, Hyperlink) so a Word user can restyle the whole file; pictures embedded as PNG; tables with
//! merged and shaded cells; text colour, highlight, font and size; alignment and indent; A4/Letter, orientation,
//! margins; a header with the title and a footer with page numbers; a Word contents field; book mode with a cover,
//! a title page and each chapter on a new page under a running header with the book title.
//!
//! Drop caps are a large first letter (docx-rs has no `w:dropCap` frame); picture shadows are left out.
//!
//! Left out: floats (pictures are placed inline, aligned), picture crops, rules other than a line or a
//! centred glyph, line numbers of code are written as text.

use std::io::Cursor;

use docx_rs::{
    AbstractNumbering, AlignmentType, BorderType, BreakType, Docx, Footer, Header, Hyperlink, HyperlinkType,
    IndentLevel, Level, LevelJc, LevelOverride, LevelText, LineSpacing, NumberFormat, Numbering, NumberingId,
    PageMargin, PageNum, PageOrientationType, Paragraph, ParagraphBorder, ParagraphBorderPosition, ParagraphChild, Pic,
    Run, RunChild, RunFonts, Shading, ShdType, SpecialIndentType, Start, Style, StyleType, Table, TableAlignmentType,
    TableBorderPosition, TableCell, TableCellBorder, TableCellBorderPosition, TableCellMargins, TableOfContents,
    TableRow, VAlignType, VMergeType, VertAlignType, WidthType,
};
use serde_json::Value;

use crate::assets::{AssetSource, DrawingKind, image_mime};
use crate::html::{absolute, chapter_label, human_size, parse_line_ranges};
use crate::inline::{Marks, Piece, block_highlights, pieces, safe_href};
use crate::model::{
    Book, ColorUse, ExportPage, HeaderFooter, Highlight, HighlightMode, Orientation, PageSetup, PageSize, Settings,
    TableOfContents as Contents, attr_bool, attr_f64, attr_int, attr_str, callout_palette, children, doc_ref_label,
    embed_kind_title, font_name, inline_text, page_colors, placeholder_line, resolve_any_color, resolve_color,
    table_grid, ty,
};

/// Which fonts the Word styles use.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum DocxLook {
    /// The page's body and heading fonts and colours ("Use the page's styles").
    #[default]
    PageStyles,
    /// Word's own fonts (Calibri, Cambria); the styles are still real styles.
    WordDefaults,
}

/// Options of [`render_docx`].
#[derive(Debug, Clone, Default)]
pub struct DocxOptions {
    /// Paper, margins, header and footer, contents (fit to content is A4 in Word).
    pub setup: PageSetup,
    /// Fonts of the styles.
    pub look: DocxLook,
    /// Whether reader highlights are drawn (as shading).
    pub highlights: HighlightMode,
    /// Book mode; `None` for pages one after another, each from a new page.
    pub book: Option<Book>,
    /// The app's address, put before links that start with `/`; `None` keeps them relative.
    pub base_url: Option<String>,
}

/// Renders pages (in the given order) to a `.docx` file.
///
/// A picture `assets` cannot give, or cannot be decoded, becomes a line with its alt text; a drawing without a
/// PNG becomes a placeholder line.
pub fn render_docx(pages: &[ExportPage], assets: &dyn AssetSource, opts: &DocxOptions) -> Vec<u8> {
    let first = pages.first().map(|p| Settings::read(&p.settings)).unwrap_or_else(|| Settings::read(&Value::Null));
    let (body_font, heading_font) = match opts.look {
        DocxLook::PageStyles => (
            font_name(&first.body_font).unwrap_or("Calibri").to_string(),
            font_name(&first.heading_font).unwrap_or("Calibri").to_string(),
        ),
        DocxLook::WordDefaults => ("Calibri".to_string(), "Cambria".to_string()),
    };
    let mut w = Writer {
        assets,
        opts,
        out: Vec::new(),
        next_num: 20,
        numberings: Vec::new(),
        bg: "white".into(),
        heading_shift: if opts.book.is_some() { 1 } else { 0 },
        highlights: &[],
        content_width_emu: content_width_emu(&opts.setup),
        body_font: body_font.clone(),
        heading_font: heading_font.clone(),
        lang: crate::lang::Lang::of(pages),
    };
    let contents_alias = w.lang.contents();
    w.document(pages);

    let (page_w, page_h) = page_twips(&opts.setup);
    let margin = opts.setup.margins.twips();
    let mut docx = Docx::new()
        .page_size(page_w, page_h)
        .page_margin(PageMargin::new().top(margin).bottom(margin).left(margin).right(margin).header(720).footer(720))
        .default_fonts(RunFonts::new().ascii(&body_font).hi_ansi(&body_font).cs(&body_font).east_asia(&body_font))
        .default_size(22);
    if opts.setup.orientation == Orientation::Landscape && opts.setup.size != PageSize::FitToContent {
        docx = docx.page_orient(PageOrientationType::Landscape);
    }
    for style in styles(&body_font, &heading_font) {
        docx = docx.add_style(style);
    }
    for abs in abstract_numberings() {
        docx = docx.add_abstract_numbering(abs);
    }
    for n in std::mem::take(&mut w.numberings) {
        docx = docx.add_numbering(n);
    }
    if opts.setup.header_footer == HeaderFooter::On && opts.setup.size != PageSize::FitToContent {
        let running = match &opts.book {
            Some(b) => b.title.clone(),
            None => pages.first().map(|p| p.title.clone()).unwrap_or_default(),
        };
        docx = docx
            .header(Header::new().add_paragraph(
                Paragraph::new().style("Header").align(AlignmentType::Right).add_run(Run::new().add_text(running)),
            ))
            .footer(Footer::new().add_paragraph(
                Paragraph::new().style("Footer").align(AlignmentType::Center).add_page_num(PageNum::new()),
            ));
    }
    for child in w.out {
        docx = match child {
            Child::P(p) => docx.add_paragraph(p),
            Child::T(t) => docx.add_table(t),
            Child::Toc => docx
                .add_table_of_contents(TableOfContents::new().heading_styles_range(1, 3).alias(contents_alias).auto()),
        };
    }
    let mut buf = Cursor::new(Vec::new());
    // Writing a zip into memory only fails on a bug of the zip writer; an empty file is the safe answer then.
    match docx.build().pack(&mut buf) {
        Ok(()) => buf.into_inner(),
        Err(_) => Vec::new(),
    }
}

/// One child of the document body.
// Paragraphs are by far the most common child and only live until the document is built, so boxing them would
// add an allocation per paragraph to save memory that is not held for long.
#[allow(clippy::large_enum_variant)]
enum Child {
    P(Paragraph),
    T(Table),
    /// The Word contents field (filled from the heading styles when the file is built).
    Toc,
}

/// Paper size in twips (portrait; Word turns it for landscape).
fn page_twips(setup: &PageSetup) -> (u32, u32) {
    let (w, h) = match setup.size {
        PageSize::Letter => (12240, 15840),
        PageSize::A3 => (16838, 23811),
        PageSize::A4 | PageSize::FitToContent => (11906, 16838),
    };
    if setup.orientation == Orientation::Landscape && setup.size != PageSize::FitToContent { (h, w) } else { (w, h) }
}

/// The width between the margins in EMU (1 twip = 635 EMU).
fn content_width_emu(setup: &PageSetup) -> u32 {
    let (w, _) = page_twips(setup);
    let usable = (w as i64 - 2 * setup.margins.twips() as i64).max(1440);
    (usable * 635) as u32
}

const SLATE: &str = "5B6B60";

fn styles(body: &str, heading: &str) -> Vec<Style> {
    let fonts = |f: &str| RunFonts::new().ascii(f).hi_ansi(f).cs(f).east_asia(f);
    let mut out = vec![
        Style::new("Normal", StyleType::Paragraph)
            .name("Normal")
            .fonts(fonts(body))
            .size(22)
            .line_spacing(LineSpacing::new().after(160).line(276)),
        Style::new("Title", StyleType::Paragraph)
            .name("Title")
            .based_on("Normal")
            .next("Normal")
            .q_format(true)
            .fonts(fonts(heading))
            .size(56)
            .line_spacing(LineSpacing::new().after(120)),
        Style::new("Subtitle", StyleType::Paragraph)
            .name("Subtitle")
            .based_on("Normal")
            .next("Normal")
            .q_format(true)
            .color(SLATE)
            .size(28),
    ];
    let sizes = [40, 32, 28, 24, 22, 22];
    for (i, size) in sizes.iter().enumerate() {
        let mut s = Style::new(format!("Heading{}", i + 1), StyleType::Paragraph)
            .name(format!("heading {}", i + 1))
            .based_on("Normal")
            .next("Normal")
            .q_format(true)
            .fonts(fonts(heading))
            .size(*size)
            .bold()
            .outline_lvl(i)
            .line_spacing(LineSpacing::new().before(if i < 2 { 360 } else { 240 }).after(120));
        if i >= 4 {
            s = s.italic();
        }
        out.push(s);
    }
    out.extend([
        Style::new("Quote", StyleType::Paragraph)
            .name("Quote")
            .based_on("Normal")
            .next("Normal")
            .q_format(true)
            .italic()
            .color(SLATE)
            .indent(Some(720), None, Some(720), None),
        Style::new("IntenseQuote", StyleType::Paragraph)
            .name("Intense Quote")
            .based_on("Normal")
            .next("Normal")
            .q_format(true)
            .italic()
            .size(32)
            .align(AlignmentType::Center)
            .line_spacing(LineSpacing::new().before(240).after(240)),
        Style::new("Code", StyleType::Paragraph)
            .name("Code")
            .based_on("Normal")
            .q_format(true)
            .fonts(fonts("Consolas"))
            .size(19)
            .line_spacing(LineSpacing::new().after(0).line(240)),
        Style::new("Caption", StyleType::Paragraph)
            .name("caption")
            .based_on("Normal")
            .next("Normal")
            .q_format(true)
            .italic()
            .size(18)
            .color(SLATE),
        Style::new("ListParagraph", StyleType::Paragraph)
            .name("List Paragraph")
            .based_on("Normal")
            .q_format(true)
            .line_spacing(LineSpacing::new().after(60)),
        Style::new("Header", StyleType::Paragraph).name("header").based_on("Normal").size(18).color(SLATE),
        Style::new("Footer", StyleType::Paragraph).name("footer").based_on("Normal").size(18).color(SLATE),
        Style::new("Hyperlink", StyleType::Character).name("Hyperlink").color("1F5A8E").underline("single"),
        Style::new("CodeChar", StyleType::Character).name("Code Char").fonts(fonts("Consolas")),
    ]);
    out
}

/// Abstract numbering ids: 10 bullets, 11 decimal, 12 lower-alpha, 13 upper-alpha, 14 lower-roman, 15 upper-roman.
fn abstract_numberings() -> Vec<AbstractNumbering> {
    let kinds: [(usize, &str, &str); 6] = [
        (10, "bullet", "•"),
        (11, "decimal", "%1."),
        (12, "lowerLetter", "%1."),
        (13, "upperLetter", "%1."),
        (14, "lowerRoman", "%1."),
        (15, "upperRoman", "%1."),
    ];
    kinds
        .iter()
        .map(|(id, format, text)| {
            let mut abs = AbstractNumbering::new(*id);
            for level in 0..9 {
                let (fmt, txt) = if *format == "bullet" {
                    ("bullet".to_string(), ["•", "◦", "▪"][level % 3].to_string())
                } else if level == 0 {
                    (format.to_string(), text.to_string())
                } else {
                    (["lowerLetter", "lowerRoman", "decimal"][level % 3].to_string(), format!("%{}.", level + 1))
                };
                abs = abs.add_level(
                    Level::new(level, Start::new(1), NumberFormat::new(fmt), LevelText::new(txt), LevelJc::new("left"))
                        .indent(Some(720 * (level as i32 + 1)), Some(SpecialIndentType::Hanging(360)), None, None),
                );
            }
            abs
        })
        .collect()
}

struct Writer<'a> {
    assets: &'a dyn AssetSource,
    opts: &'a DocxOptions,
    out: Vec<Child>,
    next_num: usize,
    numberings: Vec<Numbering>,
    bg: String,
    heading_shift: u8,
    highlights: &'a [Highlight],
    content_width_emu: u32,
    /// Font names of the body and the headings (the drop cap's two choices).
    body_font: String,
    heading_font: String,
    /// The language of the export's own words.
    lang: crate::lang::Lang,
}

/// Where a list paragraph sits: its numbering instance and level.
#[derive(Clone, Copy)]
struct ListCtx {
    num: usize,
    level: usize,
}

impl<'a> Writer<'a> {
    fn document(&mut self, pages: &'a [ExportPage]) {
        if let Some(book) = self.opts.book.clone() {
            self.book_front(&book, pages);
        } else {
            if self.opts.setup.cover_page {
                if let Some(p) = pages.first() {
                    self.cover(p);
                }
            }
            if self.opts.setup.contents == Contents::Include {
                self.out.push(Child::P(
                    Paragraph::new().style("Subtitle").add_run(Run::new().add_text(self.lang.contents())),
                ));
                self.out.push(Child::Toc);
                self.page_break();
            }
        }
        for (i, page) in pages.iter().enumerate() {
            self.page(i, page);
        }
    }

    fn page_break(&mut self) {
        self.out.push(Child::P(Paragraph::new().add_run(Run::new().add_break(BreakType::Page))));
    }

    fn book_front(&mut self, book: &Book, pages: &[ExportPage]) {
        if book.cover {
            if let Some(src) = &book.cover_image {
                if let Some(p) = self.picture(src, None, None, AlignmentType::Center) {
                    self.out.push(Child::P(p));
                }
            }
            self.out.push(Child::P(
                Paragraph::new().style("Title").align(AlignmentType::Center).add_run(Run::new().add_text(&book.title)),
            ));
            if let Some(a) = &book.author {
                self.out.push(Child::P(
                    Paragraph::new().style("Subtitle").align(AlignmentType::Center).add_run(Run::new().add_text(a)),
                ));
            }
            self.page_break();
        }
        if book.title_page {
            if let Some(s) = &book.subtitle {
                self.out.push(Child::P(
                    Paragraph::new().style("Subtitle").align(AlignmentType::Center).add_run(Run::new().add_text(s)),
                ));
            }
            self.out.push(Child::P(
                Paragraph::new().style("Title").align(AlignmentType::Center).add_run(Run::new().add_text(&book.title)),
            ));
            for line in [book.author.as_deref(), book.date.as_deref()].into_iter().flatten() {
                self.out
                    .push(Child::P(Paragraph::new().align(AlignmentType::Center).add_run(Run::new().add_text(line))));
            }
            self.page_break();
        }
        if book.contents {
            self.out
                .push(Child::P(Paragraph::new().style("Subtitle").add_run(Run::new().add_text(self.lang.contents()))));
            // Chapter list as written text, then the Word field (headings 1-3) that Word can update with page numbers.
            for (i, p) in pages.iter().enumerate() {
                self.out
                    .push(Child::P(Paragraph::new().add_run(Run::new().add_text(chapter_label(book, i, &p.title)))));
            }
            self.out.push(Child::Toc);
            self.page_break();
        }
    }

    fn cover(&mut self, page: &ExportPage) {
        let s = Settings::read(&page.settings);
        if let Some(c) = &s.cover {
            if let Some(p) = self.picture(&c.src, None, None, AlignmentType::Center) {
                self.out.push(Child::P(p));
            }
        }
        self.out.push(Child::P(
            Paragraph::new().style("Title").align(AlignmentType::Center).add_run(Run::new().add_text(&page.title)),
        ));
        if let Some(a) = &page.author {
            self.out.push(Child::P(
                Paragraph::new().style("Subtitle").align(AlignmentType::Center).add_run(Run::new().add_text(a)),
            ));
        }
        self.page_break();
    }

    fn page(&mut self, index: usize, page: &'a ExportPage) {
        let s = Settings::read(&page.settings);
        self.bg = s.background.clone();
        self.highlights = if self.opts.highlights == HighlightMode::Show { &page.highlights } else { &[] };
        let align = if s.title_center { AlignmentType::Center } else { AlignmentType::Left };
        match self.opts.book.clone() {
            Some(book) => {
                let mut title = Paragraph::new().style("Heading1").add_run(Run::new().add_text(chapter_label(
                    &book,
                    index,
                    &page.title,
                )));
                if book.chapter_breaks && index > 0 {
                    title = title.page_break_before(true);
                }
                self.out.push(Child::P(title));
            }
            None => {
                let mut eyebrow_or_title = true;
                if let Some(e) = &s.eyebrow {
                    let mut p =
                        Paragraph::new().style("Subtitle").align(align).add_run(Run::new().add_text(e.to_uppercase()));
                    if index > 0 {
                        p = p.page_break_before(true);
                    }
                    self.out.push(Child::P(p));
                    eyebrow_or_title = false;
                }
                let mut title = Paragraph::new().style("Title").align(align).add_run(Run::new().add_text(&page.title));
                if index > 0 && eyebrow_or_title {
                    title = title.page_break_before(true);
                }
                self.out.push(Child::P(title));
                if s.show_byline {
                    let line: Vec<&str> =
                        [page.author.as_deref(), page.updated_at.as_deref()].into_iter().flatten().collect();
                    if !line.is_empty() {
                        self.out.push(Child::P(
                            Paragraph::new()
                                .style("Caption")
                                .align(align)
                                .add_run(Run::new().add_text(line.join(" · "))),
                        ));
                    }
                }
            }
        }
        let blocks = self.blocks(children(&page.doc), None);
        self.out.extend(blocks);
    }

    fn blocks(&mut self, nodes: &[Value], list: Option<ListCtx>) -> Vec<Child> {
        let mut out = Vec::new();
        for n in nodes {
            self.block(n, list, &mut out);
        }
        out
    }

    fn block(&mut self, node: &Value, list: Option<ListCtx>, out: &mut Vec<Child>) {
        match ty(node) {
            "paragraph" => {
                let mut p = self.text_block(Paragraph::new(), node);
                match attr_str(node, "variant") {
                    Some("lead") => p = p.size(26),
                    Some("small") => p = p.size(18),
                    _ => {}
                }
                if let Some(ctx) = list {
                    p = p.style("ListParagraph").numbering(NumberingId::new(ctx.num), IndentLevel::new(ctx.level));
                } else {
                    p = self.drop_cap(p, node);
                }
                out.push(Child::P(p));
            }
            "heading" => {
                let level = (attr_int(node, "level", 1, 1, 6) as u8 + self.heading_shift).min(6);
                let p = self.text_block(Paragraph::new().style(&format!("Heading{level}")), node);
                out.push(Child::P(p));
            }
            "blockquote" => {
                let inner = self.blocks(children(node), None);
                for c in inner {
                    out.push(match c {
                        Child::P(p) if p.property.style.is_none() => Child::P(p.style("Quote")),
                        other => other,
                    });
                }
                if let Some(src) = attr_str(node, "source") {
                    out.push(Child::P(
                        Paragraph::new().style("Quote").add_run(Run::new().add_text(format!("— {src}"))),
                    ));
                }
            }
            "pullQuote" => {
                let align = match attr_str(node, "textAlign") {
                    Some("left") => AlignmentType::Left,
                    Some("right") => AlignmentType::Right,
                    _ => AlignmentType::Center,
                };
                let p = self.inline(Paragraph::new().style("IntenseQuote").align(align), node);
                out.push(Child::P(p));
                if let Some(src) = attr_str(node, "source") {
                    out.push(Child::P(
                        Paragraph::new().style("Caption").align(align).add_run(Run::new().add_text(src)),
                    ));
                }
            }
            "bulletList" | "orderedList" | "taskList" => self.list(node, list, out),
            "listItem" | "taskItem" | "column" => {
                let inner = self.blocks(children(node), list);
                out.extend(inner);
            }
            "codeBlock" => self.code(node, out),
            "horizontalRule" => {
                let glyph = match attr_str(node, "style") {
                    Some("dots") => Some("· · ·"),
                    Some("stars") => Some("✻ ✻ ✻"),
                    Some("fleuron") => Some("❧"),
                    Some("wave") => Some("～～～"),
                    _ => None,
                };
                let p = match glyph {
                    Some(g) => Paragraph::new().align(AlignmentType::Center).add_run(Run::new().add_text(g)),
                    None => {
                        let size = match attr_str(node, "style") {
                            Some("thick") => 24,
                            _ => 6,
                        };
                        let kind = if attr_str(node, "style") == Some("double") {
                            BorderType::Double
                        } else {
                            BorderType::Single
                        };
                        let mut p = Paragraph::new();
                        p.property = p.property.set_border(
                            ParagraphBorder::new(ParagraphBorderPosition::Bottom)
                                .val(kind)
                                .size(size)
                                .space(1)
                                .color("C9D3CC"),
                        );
                        p
                    }
                };
                out.push(Child::P(p));
            }
            "table" => {
                let t = self.table(node);
                out.push(Child::T(t));
                match attr_str(node, "caption").filter(|c| !c.trim().is_empty()) {
                    Some(c) => out.push(Child::P(
                        Paragraph::new().style("Caption").align(AlignmentType::Center).add_run(Run::new().add_text(c)),
                    )),
                    None => out.push(Child::P(Paragraph::new())),
                }
            }
            "image" => self.image(node, out),
            "columns" => {
                let cols = children(node);
                if cols.is_empty() {
                    return;
                }
                let n = cols.len();
                let middle = attr_str(node, "valign") == Some("middle");
                let cells: Vec<TableCell> = cols
                    .iter()
                    .map(|c| {
                        let kids = self.blocks(children(c), None);
                        let cell = fill_cell(TableCell::new().width(5000 / n, WidthType::Pct), kids);
                        if middle { cell.vertical_align(VAlignType::Center) } else { cell }
                    })
                    .collect();
                out.push(Child::T(Table::without_borders(vec![TableRow::new(cells)]).width(5000, WidthType::Pct)));
            }
            "callout" => {
                let kind = attr_str(node, "kind").unwrap_or("info");
                let (soft, _) = callout_palette(kind);
                let fill = attr_str(node, "color")
                    .and_then(|c| resolve_color(c, ColorUse::Highlight, &self.bg))
                    .or_else(|| resolve_color(soft, ColorUse::Highlight, &self.bg))
                    .unwrap_or_else(|| "#CFE3F5".into());
                let mut kids = Vec::new();
                if let Some(t) = attr_str(node, "title") {
                    kids.push(Child::P(Paragraph::new().add_run(Run::new().bold().add_text(t))));
                }
                kids.extend(self.blocks(children(node), None));
                let cell = fill_cell(
                    TableCell::new()
                        .shading(Shading::new().shd_type(ShdType::Clear).fill(fill.trim_start_matches('#'))),
                    kids,
                );
                out.push(Child::T(Table::without_borders(vec![TableRow::new(vec![cell])]).width(5000, WidthType::Pct)));
                out.push(Child::P(Paragraph::new()));
            }
            "mathBlock" => {
                out.push(Child::P(
                    Paragraph::new()
                        .style("Code")
                        .align(AlignmentType::Center)
                        .add_run(Run::new().italic().add_text(attr_str(node, "latex").unwrap_or(""))),
                ));
            }
            "diagram" | "sketch" | "canvas" => self.drawing(node, out),
            "video" => {
                let src = attr_str(node, "src").unwrap_or("");
                let title = attr_str(node, "title").or_else(|| attr_str(node, "caption")).unwrap_or("Video");
                if let Some(poster) = attr_str(node, "poster") {
                    if let Some(p) = self.picture(poster, attr_f64(node, "widthPct"), None, AlignmentType::Center) {
                        out.push(Child::P(p));
                    }
                }
                let mut p = Paragraph::new().add_run(Run::new().add_text("▶ "));
                p = self.link_or_text(p, src, title);
                out.push(Child::P(p));
                let caption: Vec<&str> =
                    [attr_str(node, "caption").filter(|c| *c != title), attr_str(node, "description")]
                        .into_iter()
                        .flatten()
                        .collect();
                if !caption.is_empty() {
                    out.push(Child::P(
                        Paragraph::new().style("Caption").add_run(Run::new().add_text(caption.join(" — "))),
                    ));
                }
            }
            "htmlEmbed" => {
                let note = match attr_str(node, "title") {
                    Some(t) => format!("HTML embed: {t} (open the page to run it)"),
                    None => "HTML embed (open the page to run it)".to_string(),
                };
                out.push(Child::P(Paragraph::new().style("Caption").add_run(Run::new().add_text(note))));
            }
            "fileCard" => {
                let src = attr_str(node, "src").unwrap_or("");
                let name = attr_str(node, "name").unwrap_or(src);
                let mut p = Paragraph::new().add_run(Run::new().add_text("📎 "));
                p = self.link_or_text(p, src, name);
                if let Some(size) = attr_f64(node, "size") {
                    p = p.add_run(Run::new().color(SLATE).add_text(format!("  {}", human_size(size))));
                }
                out.push(Child::P(p));
            }
            "linkEmbed" => {
                let url = attr_str(node, "url").unwrap_or("");
                let title = attr_str(node, "title").unwrap_or(url);
                let mut p = self.link_or_text(Paragraph::new(), url, title);
                if let Some(site) = attr_str(node, "site") {
                    p = p.add_run(Run::new().color(SLATE).add_text(format!("  {site}")));
                }
                out.push(Child::P(p));
                if let Some(d) = attr_str(node, "description") {
                    out.push(Child::P(Paragraph::new().style("Caption").add_run(Run::new().add_text(d))));
                }
            }
            "pageCard" => {
                if let Some(page) = attr_str(node, "page") {
                    out.push(Child::P(Paragraph::new().add_run(Run::new().add_text(format!("→ {page}")))));
                }
            }
            "ticketCard" => {
                if let Some(key) = attr_str(node, "key") {
                    out.push(Child::P(Paragraph::new().add_run(Run::new().style("CodeChar").add_text(key))));
                }
            }
            _ => {
                if children(node).iter().any(|k| matches!(ty(k), "text" | "hardBreak")) {
                    let p = self.inline(Paragraph::new(), node);
                    out.push(Child::P(p));
                } else {
                    let inner = self.blocks(children(node), list);
                    out.extend(inner);
                }
            }
        }
    }

    fn list(&mut self, node: &Value, parent: Option<ListCtx>, out: &mut Vec<Child>) {
        let level = parent.map(|c| c.level + 1).unwrap_or(0).min(8);
        let abstract_id = match ty(node) {
            "orderedList" => match attr_str(node, "listStyle") {
                Some("lower-alpha") => 12,
                Some("upper-alpha") => 13,
                Some("lower-roman") => 14,
                Some("upper-roman") => 15,
                _ => 11,
            },
            _ => 10,
        };
        let num = self.next_num;
        self.next_num += 1;
        let mut numbering = Numbering::new(num, abstract_id);
        if ty(node) == "orderedList" {
            let start = attr_int(node, "start", 1, 0, 1_000_000) as usize;
            numbering = numbering.overrides(vec![LevelOverride::new(level).start(start)]);
        }
        self.numberings.push(numbering);
        let task = ty(node) == "taskList";
        for item in children(node) {
            let ctx = ListCtx { num, level };
            for (i, child) in children(item).iter().enumerate() {
                if i == 0 && ty(child) == "paragraph" {
                    let mut p = Paragraph::new().style("ListParagraph");
                    if task {
                        let mark = if attr_bool(item, "checked") { "☑ " } else { "☐ " };
                        p = p.add_run(Run::new().add_text(mark)).indent(
                            Some(720 * (level as i32 + 1)),
                            None,
                            None,
                            None,
                        );
                    } else {
                        p = p.numbering(NumberingId::new(ctx.num), IndentLevel::new(ctx.level));
                    }
                    let p = self.text_block(p, child);
                    out.push(Child::P(p));
                } else if matches!(ty(child), "bulletList" | "orderedList" | "taskList") {
                    self.list(child, Some(ctx), out);
                } else {
                    let inner = self.blocks(std::slice::from_ref(child), None);
                    for c in inner {
                        out.push(match c {
                            Child::P(p) => Child::P(p.indent(Some(720 * (level as i32 + 1)), None, None, None)),
                            other => other,
                        });
                    }
                }
            }
        }
    }

    fn code(&mut self, node: &Value, out: &mut Vec<Child>) {
        let code: String = children(node).iter().filter_map(|t| t.get("text").and_then(Value::as_str)).collect();
        let caption: Vec<&str> =
            [attr_str(node, "filename"), attr_str(node, "language")].into_iter().flatten().collect();
        if !caption.is_empty() {
            out.push(Child::P(
                Paragraph::new().style("Caption").keep_next(true).add_run(Run::new().add_text(caption.join(" · "))),
            ));
        }
        let numbers = attr_bool(node, "lineNumbers");
        let marked = parse_line_ranges(attr_str(node, "highlightLines").unwrap_or(""));
        let diff = attr_bool(node, "diff");
        let lines: Vec<&str> = code.split('\n').collect();
        let width = lines.len().to_string().len();
        for (i, line) in lines.iter().enumerate() {
            let n = i + 1;
            let fill = if marked.iter().any(|(a, b)| *a <= n && n <= *b) {
                "FFF1C2"
            } else if diff && line.starts_with('+') {
                "DCF3E1"
            } else if diff && line.starts_with('-') {
                "FBE0DD"
            } else {
                "F3F5F4"
            };
            let mut p = Paragraph::new().style("Code").keep_lines(true);
            p.property = p.property.shading(Shading::new().shd_type(ShdType::Clear).fill(fill));
            if i + 1 < lines.len() {
                p = p.keep_next(true);
            }
            if numbers {
                p = p.add_run(Run::new().color("8A968E").add_text(format!("{n:>width$}  ")));
            }
            p = p.add_run(Run::new().add_text(*line));
            out.push(Child::P(p));
        }
        out.push(Child::P(Paragraph::new()));
    }

    fn table(&mut self, node: &Value) -> Table {
        let (rows, width) = table_grid(node);
        let width = width.max(1);
        // Rows of slots: each slot is a cell start, a vertical-merge continuation or empty.
        let mut continues: Vec<Vec<Option<(usize, usize, Option<String>)>>> = vec![vec![None; width]; rows.len()];
        let mut table_rows = Vec::new();
        let header_bold = |cell: &Value| ty(cell) == "tableHeader";
        let banded = attr_bool(node, "banded");
        let has_header = rows.first().is_some_and(|r| !r.is_empty() && r.iter().all(|c| header_bold(c.node)));
        for (r, row) in rows.iter().enumerate() {
            let mut cells: Vec<(usize, TableCell)> = Vec::new();
            let body_index = if has_header { r.checked_sub(1) } else { Some(r) };
            let band = banded && body_index.is_some_and(|b| b % 2 == 1);
            for cell in row {
                let mut fill =
                    attr_str(cell.node, "background").and_then(|c| resolve_color(c, ColorUse::Highlight, &self.bg));
                if fill.is_none() && band {
                    fill = Some("#F6FAF7".to_string());
                }
                let mut kids = self.blocks(children(cell.node), None);
                if header_bold(cell.node) {
                    kids = kids
                        .into_iter()
                        .map(|c| match c {
                            Child::P(mut p) => {
                                p.property.run_property = p.property.run_property.clone().bold();
                                Child::P(bold_runs(p))
                            }
                            other => other,
                        })
                        .collect();
                }
                let align = match attr_str(cell.node, "align") {
                    Some("center") => Some(AlignmentType::Center),
                    Some("right") => Some(AlignmentType::Right),
                    _ => None,
                };
                if let Some(a) = align {
                    kids =
                        kids.into_iter().map(|c| if let Child::P(p) = c { Child::P(p.align(a)) } else { c }).collect();
                }
                let mut tc = fill_cell(TableCell::new(), kids);
                if cell.colspan > 1 {
                    tc = tc.grid_span(cell.colspan);
                }
                if cell.rowspan > 1 {
                    tc = tc.vertical_merge(VMergeType::Restart);
                    for later in continues.iter_mut().skip(r + 1).take(cell.rowspan - 1) {
                        if let Some(slot) = later.get_mut(cell.col) {
                            *slot = Some((cell.colspan, cell.col, fill.clone()));
                        }
                    }
                }
                if let Some(f) = &fill {
                    tc = tc.shading(Shading::new().shd_type(ShdType::Clear).fill(f.trim_start_matches('#')));
                }
                match attr_str(cell.node, "verticalAlign") {
                    Some("middle") => tc = tc.vertical_align(VAlignType::Center),
                    Some("bottom") => tc = tc.vertical_align(VAlignType::Bottom),
                    _ => {}
                }
                tc = self.cell_look(tc, cell.node);
                cells.push((cell.col, tc));
            }
            for (col, slot) in continues[r].iter().enumerate() {
                if let Some((span, _, fill)) = slot {
                    let mut tc = TableCell::new().vertical_merge(VMergeType::Continue).add_paragraph(Paragraph::new());
                    if *span > 1 {
                        tc = tc.grid_span(*span);
                    }
                    if let Some(f) = fill {
                        tc = tc.shading(Shading::new().shd_type(ShdType::Clear).fill(f.trim_start_matches('#')));
                    }
                    cells.push((col, tc));
                }
            }
            cells.sort_by_key(|(c, _)| *c);
            table_rows.push(TableRow::new(cells.into_iter().map(|(_, c)| c).collect()));
        }
        let usable_twips = (self.content_width_emu / 635) as usize;
        let mut table = Table::new(table_rows).set_grid(vec![usable_twips / width; width]);
        let align = match attr_str(node, "align") {
            Some("left") => Some(TableAlignmentType::Left),
            Some("center") => Some(TableAlignmentType::Center),
            Some("right") => Some(TableAlignmentType::Right),
            _ => None,
        };
        table = match (align, attr_str(node, "width")) {
            // a positioned table is as wide as its content
            (Some(a), _) => table.width(0, WidthType::Auto).align(a),
            (None, Some("fit")) => table.width(0, WidthType::Auto),
            _ => table.width(5000, WidthType::Pct),
        };
        match attr_str(node, "borders") {
            Some("rows") => {
                table = table.clear_border(TableBorderPosition::Left).clear_border(TableBorderPosition::Right);
                table = table.clear_border(TableBorderPosition::InsideV);
            }
            Some("outer") => {
                table = table.clear_border(TableBorderPosition::InsideH).clear_border(TableBorderPosition::InsideV);
            }
            Some("none") => table = table.clear_all_border(),
            _ => {}
        }
        match attr_str(node, "spacing") {
            Some("tight") => table = table.margins(TableCellMargins::new().margin(30, 120, 30, 120)),
            Some("roomy") => table = table.margins(TableCellMargins::new().margin(150, 210, 150, 210)),
            _ => {}
        }
        table
    }

    /// The sides, line style and colour, and padding of one table cell.
    fn cell_look(&self, mut tc: TableCell, cell: &Value) -> TableCell {
        if let Some(sides) = attr_str(cell, "border") {
            let (size, kind) = match attr_str(cell, "borderStyle") {
                Some("thick") => (12, BorderType::Single),
                Some("dashed") => (6, BorderType::Dashed),
                _ => (6, BorderType::Single),
            };
            let color = attr_str(cell, "borderColor")
                .and_then(|c| resolve_any_color(c, &self.bg))
                .unwrap_or_else(|| "#D5DDD8".to_string());
            for (name, pos) in [
                ("top", TableCellBorderPosition::Top),
                ("right", TableCellBorderPosition::Right),
                ("bottom", TableCellBorderPosition::Bottom),
                ("left", TableCellBorderPosition::Left),
            ] {
                let border = TableCellBorder::new(pos);
                tc = tc.set_border(if sides.split_whitespace().any(|s| s == name) {
                    border.size(size).color(color.trim_start_matches('#')).border_type(kind)
                } else {
                    border.border_type(BorderType::Nil)
                });
            }
        }
        // padding in twips: top and bottom, left and right
        let (v, h) = match attr_str(cell, "padding") {
            Some("tight") => (30, 120),
            Some("roomy") => (150, 210),
            _ => return tc,
        };
        tc.property = tc
            .property
            .margin_top(v, WidthType::Dxa)
            .margin_bottom(v, WidthType::Dxa)
            .margin_left(h, WidthType::Dxa)
            .margin_right(h, WidthType::Dxa);
        tc
    }

    /// Turns the first letter of a paragraph with a drop cap into a large run (Word's own drop cap frame is not
    /// available in `docx-rs`): 2.4, 3.54, 4.7 or 5.8 times the text size for 2 to 5 lines, in the colour and font
    /// chosen (the heading font unless it says `body`).
    fn drop_cap(&self, mut p: Paragraph, node: &Value) -> Paragraph {
        let lines = attr_int(node, "dropCap", 0, 0, 5);
        if lines < 2 {
            return p;
        }
        let factor: f64 = match lines {
            2 => 2.4,
            3 => 3.54,
            4 => 4.7,
            _ => 5.8,
        };
        let pos = p.children.iter().position(|c| matches!(c, ParagraphChild::Run(r) if r.children.iter().any(|k| matches!(k, RunChild::Text(t) if !t.text.is_empty()))));
        let Some(pos) = pos else {
            return p;
        };
        let ParagraphChild::Run(run) = &mut p.children[pos] else {
            return p;
        };
        let Some(RunChild::Text(t)) =
            run.children.iter_mut().find(|k| matches!(k, RunChild::Text(t) if !t.text.is_empty()))
        else {
            return p;
        };
        let first: String = t.text.chars().take(1).collect();
        t.text = t.text.chars().skip(1).collect();
        let mut cap = Run::new().add_text(first).bold().size((22.0 * factor).round() as usize);
        let font = if attr_str(node, "dropCapFont") == Some("body") { &self.body_font } else { &self.heading_font };
        cap = cap.fonts(RunFonts::new().ascii(font).hi_ansi(font).cs(font));
        let color = attr_str(node, "dropCapColor").and_then(|c| resolve_any_color(c, &self.bg));
        if let Some(c) = color {
            cap = cap.color(c.trim_start_matches('#'));
        }
        p.children.insert(pos, ParagraphChild::Run(Box::new(cap)));
        p
    }

    fn image(&mut self, node: &Value, out: &mut Vec<Child>) {
        let src = attr_str(node, "src").unwrap_or("");
        let align = match attr_str(node, "placement") {
            Some("left" | "floatLeft") => AlignmentType::Left,
            Some("right" | "floatRight") => AlignmentType::Right,
            _ => AlignmentType::Center,
        };
        match self.picture(src, attr_f64(node, "widthPct"), attr_f64(node, "width"), align) {
            Some(p) => {
                let size = match attr_str(node, "border") {
                    Some("thin") => Some(6),
                    Some("medium") => Some(12),
                    Some("thick") => Some(24),
                    _ => None,
                };
                match size {
                    // a line around the picture: a one-cell table as wide as the picture, with the line on its cell
                    Some(size) => {
                        let color = attr_str(node, "borderColor")
                            .and_then(|c| resolve_any_color(c, &self.bg))
                            .unwrap_or_else(|| page_colors(&self.bg).1);
                        let color = color.trim_start_matches('#').to_string();
                        let mut cell = TableCell::new().add_paragraph(p);
                        for pos in [
                            TableCellBorderPosition::Top,
                            TableCellBorderPosition::Right,
                            TableCellBorderPosition::Bottom,
                            TableCellBorderPosition::Left,
                        ] {
                            cell = cell.set_border(TableCellBorder::new(pos).size(size).color(&color));
                        }
                        let table_align = match align {
                            AlignmentType::Left => TableAlignmentType::Left,
                            AlignmentType::Right => TableAlignmentType::Right,
                            _ => TableAlignmentType::Center,
                        };
                        let usable_twips = (self.content_width_emu / 635) as usize;
                        out.push(Child::T(
                            Table::new(vec![TableRow::new(vec![cell])])
                                .set_grid(vec![usable_twips])
                                .width(0, WidthType::Auto)
                                .align(table_align)
                                .clear_all_border(),
                        ));
                        out.push(Child::P(Paragraph::new()));
                    }
                    None => out.push(Child::P(p)),
                }
            }
            None => {
                let alt = attr_str(node, "alt").unwrap_or("Picture");
                out.push(Child::P(self.link_or_text(Paragraph::new().align(align), src, &format!("[{alt}]"))));
            }
        }
        if let Some(c) = attr_str(node, "caption") {
            out.push(Child::P(Paragraph::new().style("Caption").align(align).add_run(Run::new().add_text(c))));
        }
    }

    fn drawing(&mut self, node: &Value, out: &mut Vec<Child>) {
        let Some(kind) = DrawingKind::of_node_type(ty(node)) else {
            return;
        };
        let id = attr_str(node, "id").unwrap_or("");
        let label = attr_str(node, "label").unwrap_or(kind.label());
        let png = if id.is_empty() { None } else { self.assets.drawing_png(kind, id) };
        if let Some(p) =
            png.and_then(|b| self.picture_bytes(&b, attr_f64(node, "widthPct"), None, AlignmentType::Center))
        {
            out.push(Child::P(p));
            out.push(Child::P(
                Paragraph::new().style("Caption").align(AlignmentType::Center).add_run(Run::new().add_text(label)),
            ));
            return;
        }
        let (k, t) = embed_kind_title(node).unwrap_or((kind.label(), String::new()));
        out.push(Child::P(Paragraph::new().style("Caption").add_run(Run::new().add_text(placeholder_line(k, &t)))));
    }

    /// A paragraph holding a picture fetched from `src`; `None` when it cannot be fetched or decoded.
    fn picture(
        &mut self,
        src: &str,
        width_pct: Option<f64>,
        width_px: Option<f64>,
        align: AlignmentType,
    ) -> Option<Paragraph> {
        if src.is_empty() {
            return None;
        }
        let asset = self.assets.fetch(src)?;
        image_mime(&asset)?;
        self.picture_bytes(&asset.bytes, width_pct, width_px, align)
    }

    fn picture_bytes(
        &mut self,
        bytes: &[u8],
        width_pct: Option<f64>,
        width_px: Option<f64>,
        align: AlignmentType,
    ) -> Option<Paragraph> {
        let (png, w, h) = to_png(bytes)?;
        let max = self.content_width_emu as f64;
        let natural = w as f64 * 9525.0;
        let mut target = match (width_pct, width_px) {
            (Some(p), _) => max * p.clamp(10.0, 100.0) / 100.0,
            (None, Some(px)) => px.clamp(16.0, 4000.0) * 9525.0,
            _ => natural,
        };
        target = target.min(max);
        let height = target * h as f64 / w.max(1) as f64;
        let pic = Pic::new_with_dimensions(png, w, h).size(target as u32, height as u32);
        Some(Paragraph::new().align(align).add_run(Run::new().add_image(pic)))
    }

    /// Adds a hyperlink run for a checked `href`, else plain text.
    fn link_or_text(&self, p: Paragraph, href: &str, text: &str) -> Paragraph {
        match safe_href(href).filter(|h| !h.starts_with('#')) {
            Some(h) => {
                let url = absolute(&h, self.opts.base_url.as_deref());
                p.add_hyperlink(
                    Hyperlink::new(url, HyperlinkType::External).add_run(Run::new().style("Hyperlink").add_text(text)),
                )
            }
            None => p.add_run(Run::new().add_text(text)),
        }
    }

    /// Applies alignment, indent and spacing of a text block, then its inline content.
    fn text_block(&mut self, mut p: Paragraph, node: &Value) -> Paragraph {
        match attr_str(node, "textAlign") {
            Some("center") => p = p.align(AlignmentType::Center),
            Some("right") => p = p.align(AlignmentType::Right),
            Some("justify") => p = p.align(AlignmentType::Both),
            _ => {}
        }
        let indent = attr_int(node, "indent", 0, 0, 8) as i32;
        if indent > 0 {
            p = p.indent(Some(indent * 360), None, None, None);
        }
        let mut spacing = None;
        if let Some(lh) = attr_f64(node, "lineHeight").filter(|n| (0.5..=4.0).contains(n)) {
            spacing = Some(LineSpacing::new().line((lh * 240.0) as i32));
        }
        if let Some(b) = attr_f64(node, "spaceBefore").filter(|n| (0.0..=400.0).contains(n)) {
            spacing = Some(spacing.unwrap_or_default().before((b * 15.0) as u32));
        }
        if let Some(a) = attr_f64(node, "spaceAfter").filter(|n| (0.0..=400.0).contains(n)) {
            spacing = Some(spacing.unwrap_or_default().after((a * 15.0) as u32));
        }
        if let Some(s) = spacing {
            p = p.line_spacing(s);
        }
        self.inline(p, node)
    }

    fn inline(&mut self, mut p: Paragraph, block: &Value) -> Paragraph {
        let hls = block_highlights(block, self.highlights);
        for piece in pieces(block, &hls) {
            match piece {
                Piece::Break => p = p.add_run(Run::new().add_break(BreakType::TextWrapping)),
                Piece::Text { text, marks } => p = self.add_marked(p, &text, &marks),
                Piece::Atom { node, marks } => {
                    let (text, mono) = match ty(node) {
                        "docRef" => (doc_ref_label(node).to_string(), false),
                        "ticketRef" => (attr_str(node, "key").unwrap_or("").to_string(), true),
                        "mathInline" => (attr_str(node, "latex").unwrap_or("").to_string(), true),
                        _ => (inline_text(node), false),
                    };
                    let mut m = marks.clone();
                    m.code |= mono;
                    p = self.add_marked(p, &text, &m);
                }
            }
        }
        p
    }

    fn add_marked(&self, p: Paragraph, text: &str, m: &Marks) -> Paragraph {
        let mut run = Run::new().add_text(text);
        if m.bold {
            run = run.bold();
        }
        if m.italic {
            run = run.italic();
        }
        if m.strike {
            run = run.strike();
        }
        if m.underline {
            run = run.underline("single");
        }
        if m.sup {
            run.run_property = run.run_property.vert_align(VertAlignType::SuperScript);
        } else if m.sub {
            run.run_property = run.run_property.vert_align(VertAlignType::SubScript);
        }
        if m.code {
            run = run.style("CodeChar").shading(Shading::new().shd_type(ShdType::Clear).fill("F3F5F4"));
        }
        if let Some(c) = m.color.as_deref().and_then(|c| resolve_color(c, ColorUse::Text, &self.bg)) {
            run = run.color(c.trim_start_matches('#'));
        }
        if let Some(f) = m.font.as_deref().and_then(font_name) {
            run = run.fonts(RunFonts::new().ascii(f).hi_ansi(f).cs(f));
        }
        if let Some(px) = m.size {
            run = run.size((px * 1.5).round().clamp(2.0, 1000.0) as usize);
        }
        let fill = m
            .reader
            .as_ref()
            .map(|r| r.color.clone().unwrap_or_else(|| "yellow".into()))
            .or_else(|| m.highlight.as_ref().map(|h| h.clone().unwrap_or_else(|| "yellow".into())))
            .and_then(|c| resolve_color(&c, ColorUse::Highlight, &self.bg));
        if let Some(f) = fill {
            run = run.shading(Shading::new().shd_type(ShdType::Clear).fill(f.trim_start_matches('#')));
        }
        match m.link.as_ref().and_then(|l| safe_href(&l.href)).filter(|h| !h.starts_with('#')) {
            Some(href) => {
                let url = absolute(&href, self.opts.base_url.as_deref());
                p.add_hyperlink(Hyperlink::new(url, HyperlinkType::External).add_run(run.style("Hyperlink")))
            }
            None => p.add_run(run),
        }
    }
}

/// Puts children into a table cell (a cell needs at least one paragraph).
fn fill_cell(mut cell: TableCell, kids: Vec<Child>) -> TableCell {
    let mut any = false;
    let mut last_was_table = false;
    for k in kids {
        match k {
            Child::P(p) => {
                cell = cell.add_paragraph(p);
                last_was_table = false;
            }
            Child::T(t) => {
                cell = cell.add_table(t);
                last_was_table = true;
            }
            Child::Toc => continue,
        }
        any = true;
    }
    if !any || last_was_table {
        cell = cell.add_paragraph(Paragraph::new());
    }
    cell
}

/// Makes every run of a paragraph bold (header cells).
fn bold_runs(mut p: Paragraph) -> Paragraph {
    for child in p.children.iter_mut() {
        if let docx_rs::ParagraphChild::Run(run) = child {
            run.run_property = run.run_property.clone().bold();
        }
    }
    p
}

/// Decodes a picture and returns it as PNG with its size in px; `None` when it cannot be decoded.
fn to_png(bytes: &[u8]) -> Option<(Vec<u8>, u32, u32)> {
    let img = image::load_from_memory(bytes).ok()?;
    let (w, h) = (img.width(), img.height());
    if w == 0 || h == 0 {
        return None;
    }
    if bytes.starts_with(&[0x89, b'P', b'N', b'G']) {
        return Some((bytes.to_vec(), w, h));
    }
    let mut out = Cursor::new(Vec::new());
    img.write_to(&mut out, image::ImageFormat::Png).ok()?;
    Some((out.into_inner(), w, h))
}
