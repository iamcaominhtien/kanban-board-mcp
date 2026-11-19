//! The input of an export (pages, book, page setup) and the helpers every renderer shares: reading node
//! attributes, page settings, the named palette and plain text.

use std::collections::HashMap;
use std::sync::OnceLock;

use serde_json::Value;

/// One page to export, as the caller read it from the database.
#[derive(Debug, Clone, Default)]
pub struct ExportPage {
    /// The page title (shown as the title, or as the chapter heading in a book).
    pub title: String,
    /// Who wrote or last edited the page, for the byline; `None` leaves the name out.
    pub author: Option<String>,
    /// When the page was last changed, already formatted for people ("Oct 5, 2026"); `None` leaves it out.
    pub updated_at: Option<String>,
    /// Where the page goes in a multi-file export, relative, without extension, with `/` between folders like
    /// the page tree (`"Architecture/API"`). Empty means "made from the title".
    pub path: String,
    /// The page body: TipTap JSON (`{"type":"doc","content":[…]}`).
    pub doc: Value,
    /// The page settings (`page-settings.json`); `null` or `{}` is all defaults.
    pub settings: Value,
    /// Reader highlights; drawn only when the options say [`HighlightMode::Show`].
    pub highlights: Vec<Highlight>,
}

/// A reader highlight on a block of a page.
#[derive(Debug, Clone, Default)]
pub struct Highlight {
    /// The `blockId` of the text block it is on (`b-3f2a9c`).
    pub block_id: String,
    /// Start of the range in the block's text, in UTF-16 code units like the editor counts (0 = first character).
    pub start: usize,
    /// End of the range (exclusive), in the same units.
    pub end: usize,
    /// A highlight colour name from the palette or `#rrggbb`; `None` is yellow.
    pub color: Option<String>,
    /// Who made it, shown as a tooltip in HTML; `None` for nobody named.
    pub author: Option<String>,
}

/// Whether reader highlights are drawn.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum HighlightMode {
    /// Leave them out (the default: an export shows the page, not the readers).
    #[default]
    Hide,
    /// Draw them as marks in the colour each one has.
    Show,
}

/// Book mode: many pages made into one document, chapters in the order of the pages given.
#[derive(Debug, Clone, Default)]
pub struct Book {
    /// The book title (cover, title page, running header).
    pub title: String,
    /// A line under the title ("Book one"); `None` for none.
    pub subtitle: Option<String>,
    /// The author on the cover and title page; `None` for none.
    pub author: Option<String>,
    /// The date on the title page ("November 2026"); `None` for none.
    pub date: Option<String>,
    /// The cover picture (`/uploads/...` or a URL); `None` makes a cover of the title alone.
    pub cover_image: Option<String>,
    /// Whether there is a cover page at all.
    pub cover: bool,
    /// Whether a title page (title, subtitle, author, date) follows the cover.
    pub title_page: bool,
    /// Whether a table of contents lists the chapters with their numbers.
    pub contents: bool,
    /// Whether each chapter starts on a new page (paged formats).
    pub chapter_breaks: bool,
    /// Whether chapter headings carry their number ("3. The Long Tide").
    pub number_chapters: bool,
}

/// A paper size for the paged formats.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum PageSize {
    /// 210 × 297 mm.
    #[default]
    A4,
    /// 8.5 × 11 in.
    Letter,
    /// 297 × 420 mm: twice A4, the size of a tabloid newspaper page.
    A3,
    /// One long page as tall as the content (PDF); Word has no such page and uses A4.
    FitToContent,
}

/// Which way the paper is turned.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum Orientation {
    /// Taller than wide.
    #[default]
    Portrait,
    /// Wider than tall.
    Landscape,
}

/// Page margins.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum Margins {
    /// 12.7 mm (0.5 in).
    Narrow,
    /// 25.4 mm (1 in).
    #[default]
    Normal,
    /// 38.1 mm (1.5 in).
    Wide,
}

impl Margins {
    /// Returns the margin in millimetres.
    pub fn mm(self) -> f64 {
        match self {
            Margins::Narrow => 12.7,
            Margins::Normal => 25.4,
            Margins::Wide => 38.1,
        }
    }

    /// Returns the margin in twentieths of a point (Word's unit).
    pub fn twips(self) -> i32 {
        match self {
            Margins::Narrow => 720,
            Margins::Normal => 1440,
            Margins::Wide => 2160,
        }
    }
}

/// Whether paged output carries a header (title) and a footer (page numbers).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum HeaderFooter {
    /// The page or book title on top, page numbers at the bottom.
    #[default]
    On,
    /// Neither.
    Off,
}

/// Whether a table of contents (headings 1 to 3) is put before the pages.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum TableOfContents {
    /// No contents list.
    #[default]
    Leave,
    /// A contents list: links in HTML/PDF, a Word field you can update in Word.
    Include,
}

/// Page setup of the paged formats (PDF, Word), and of the print stylesheet of HTML.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct PageSetup {
    /// Paper size.
    pub size: PageSize,
    /// Portrait or landscape; ignored for [`PageSize::FitToContent`].
    pub orientation: Orientation,
    /// Margins on all four sides.
    pub margins: Margins,
    /// Header and footer; switched off for [`PageSize::FitToContent`].
    pub header_footer: HeaderFooter,
    /// A contents list before the pages (outside book mode; a book has its own switch).
    pub contents: TableOfContents,
    /// A first page with the page cover and title (outside book mode).
    pub cover_page: bool,
}

/// One file of a multi-file export.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OutFile {
    /// The path inside the zip, relative, with `/` between folders (`images/team.png`).
    pub path: String,
    /// The file content.
    pub bytes: Vec<u8>,
}

/// The four export formats.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExportFormat {
    /// Word `.docx`.
    Docx,
    /// PDF.
    Pdf,
    /// HTML (one file with pictures inside, or a folder).
    Html,
    /// Markdown with pictures in a folder.
    Markdown,
}

// ---------------------------------------------------------------------------------------------------------------
// Node helpers
// ---------------------------------------------------------------------------------------------------------------

/// The `type` of a node (`""` when missing).
pub(crate) fn ty(node: &Value) -> &str {
    node.get("type").and_then(Value::as_str).unwrap_or("")
}

/// The children of a node (empty when missing).
pub(crate) fn children(node: &Value) -> &[Value] {
    node.get("content").and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&[])
}

/// A string attribute, `None` when missing, not a string or empty.
pub(crate) fn attr_str<'a>(node: &'a Value, key: &str) -> Option<&'a str> {
    node.get("attrs")?.get(key)?.as_str().filter(|s| !s.is_empty())
}

/// A number attribute, `None` when missing or not a number.
pub(crate) fn attr_f64(node: &Value, key: &str) -> Option<f64> {
    node.get("attrs")?.get(key)?.as_f64().filter(|n| n.is_finite())
}

/// A boolean attribute, `false` when missing.
pub(crate) fn attr_bool(node: &Value, key: &str) -> bool {
    node.get("attrs").and_then(|a| a.get(key)).and_then(Value::as_bool).unwrap_or(false)
}

/// A whole-number attribute clamped to `min..=max`, `default` when missing.
pub(crate) fn attr_int(node: &Value, key: &str, default: i64, min: i64, max: i64) -> i64 {
    attr_f64(node, key).map(|n| n.round() as i64).unwrap_or(default).clamp(min, max)
}

/// The plain text of a node's inline content (text, references and inline math), for titles and contents lists.
pub(crate) fn inline_text(node: &Value) -> String {
    let mut out = String::new();
    push_text(node, &mut out);
    out
}

fn push_text(node: &Value, out: &mut String) {
    match ty(node) {
        "text" => out.push_str(node.get("text").and_then(Value::as_str).unwrap_or("")),
        "hardBreak" => out.push(' '),
        "docRef" => out.push_str(doc_ref_label(node)),
        "ticketRef" => out.push_str(attr_str(node, "key").unwrap_or("")),
        "mathInline" => out.push_str(attr_str(node, "latex").unwrap_or("")),
        _ => {
            for child in children(node) {
                push_text(child, out);
            }
        }
    }
}

/// The text a `docRef` shows: its label, else `Page#Section` or the page.
pub(crate) fn doc_ref_label(node: &Value) -> &str {
    attr_str(node, "label").or_else(|| attr_str(node, "section")).or_else(|| attr_str(node, "page")).unwrap_or("")
}

/// One heading of a page, for a contents list.
#[derive(Debug, Clone)]
pub(crate) struct HeadingEntry {
    /// 1..6 as in the page.
    pub level: u8,
    /// Its plain text.
    pub text: String,
    /// Its `blockId`, when it has one.
    pub block_id: Option<String>,
}

/// Lists the headings of a page up to `max_level`, in reading order (columns included).
pub(crate) fn headings(doc: &Value, max_level: u8) -> Vec<HeadingEntry> {
    let mut out = Vec::new();
    collect_headings(doc, max_level, &mut out);
    out
}

fn collect_headings(node: &Value, max_level: u8, out: &mut Vec<HeadingEntry>) {
    for child in children(node) {
        match ty(child) {
            "heading" => {
                let level = attr_int(child, "level", 1, 1, 6) as u8;
                if level <= max_level {
                    out.push(HeadingEntry {
                        level,
                        text: inline_text(child),
                        block_id: attr_str(child, "blockId").map(str::to_string),
                    });
                }
            }
            "columns" | "column" => collect_headings(child, max_level, out),
            _ => {}
        }
    }
}

/// Turns a text into an anchor-safe id: lower-case ASCII letters, digits and `-`.
pub(crate) fn slug(s: &str) -> String {
    let mut out = String::new();
    for c in s.chars() {
        if c.is_ascii_alphanumeric() {
            out.push(c.to_ascii_lowercase());
        } else if !out.ends_with('-') && !out.is_empty() {
            out.push('-');
        }
    }
    while out.ends_with('-') {
        out.pop();
    }
    if out.is_empty() { "section".to_string() } else { out }
}

/// Cleans a title for a placeholder line: brackets and line breaks become spaces, runs of white space one space.
pub(crate) fn placeholder_title(s: &str) -> String {
    let replaced: String = s.chars().map(|c| if matches!(c, '[' | ']' | '\n' | '\r') { ' ' } else { c }).collect();
    replaced.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// The kind and title of an embed that cannot travel as it is, as the plain Markdown placeholder names them.
pub(crate) fn embed_kind_title(node: &Value) -> Option<(&'static str, String)> {
    let (kind, title) = match ty(node) {
        "video" => {
            ("video", attr_str(node, "title").or_else(|| attr_str(node, "caption")).or_else(|| attr_str(node, "src")))
        }
        "htmlEmbed" => ("HTML embed", attr_str(node, "title")),
        "linkEmbed" => ("link", attr_str(node, "title").or_else(|| attr_str(node, "url"))),
        "diagram" => ("draw.io diagram", attr_str(node, "label")),
        "sketch" => ("sketch", attr_str(node, "label")),
        "canvas" => ("canvas", attr_str(node, "label")),
        _ => return None,
    };
    Some((kind, title.map(placeholder_title).unwrap_or_default()))
}

/// Formats an embed placeholder line: `[embed: kind · title]`, or `[embed: kind]` without a title.
pub(crate) fn placeholder_line(kind: &str, title: &str) -> String {
    if title.is_empty() { format!("[embed: {kind}]") } else { format!("[embed: {kind} · {title}]") }
}

/// Whether a table has a merged cell (a `colspan` or `rowspan` above 1).
pub(crate) fn table_has_merges(table: &Value) -> bool {
    children(table)
        .iter()
        .flat_map(children)
        .any(|cell| attr_int(cell, "colspan", 1, 1, 1000) > 1 || attr_int(cell, "rowspan", 1, 1, 1000) > 1)
}

/// A cell placed on the grid of a table.
#[derive(Debug, Clone)]
pub(crate) struct GridCell<'a> {
    /// The cell node.
    pub node: &'a Value,
    /// First grid column (0-based).
    pub col: usize,
    /// Columns it spans (1 or more).
    pub colspan: usize,
    /// Rows it spans (1 or more).
    pub rowspan: usize,
}

/// Places the cells of a table on a grid: rows of cells with their first column, as HTML lays out
/// `colspan`/`rowspan`. Returns the rows and the number of grid columns.
pub(crate) fn table_grid(table: &Value) -> (Vec<Vec<GridCell<'_>>>, usize) {
    let rows = children(table);
    let mut taken: Vec<Vec<bool>> = vec![Vec::new(); rows.len()];
    let mut out = Vec::with_capacity(rows.len());
    let mut width = 0;
    for (r, row) in rows.iter().enumerate() {
        let mut cells = Vec::new();
        let mut col = 0;
        for cell in children(row) {
            while taken[r].get(col).copied().unwrap_or(false) {
                col += 1;
            }
            let colspan = attr_int(cell, "colspan", 1, 1, 64) as usize;
            let rowspan = (attr_int(cell, "rowspan", 1, 1, 1000) as usize).min(rows.len() - r);
            for line in taken.iter_mut().skip(r).take(rowspan) {
                if line.len() < col + colspan {
                    line.resize(col + colspan, false);
                }
                for slot in line.iter_mut().skip(col).take(colspan) {
                    *slot = true;
                }
            }
            cells.push(GridCell { node: cell, col, colspan, rowspan });
            col += colspan;
            width = width.max(col);
        }
        out.push(cells);
    }
    for line in &taken {
        width = width.max(line.len());
    }
    (out, width)
}

// ---------------------------------------------------------------------------------------------------------------
// Page settings
// ---------------------------------------------------------------------------------------------------------------

/// The page cover from the settings.
#[derive(Debug, Clone)]
pub(crate) struct Cover {
    /// The picture (`/uploads/...`).
    pub src: String,
    /// Vertical focus, 0..100 (%).
    pub position_y: f64,
    /// Height in px (s/m/l).
    pub height_px: u32,
    /// Whether the title is drawn on the cover.
    pub title_on_cover: bool,
}

/// The page settings a renderer needs, read leniently (an unknown value is its default).
#[derive(Debug, Clone)]
pub(crate) struct Settings {
    /// Content width in px; `None` = full width.
    pub width_px: Option<u32>,
    /// Background name (`white`, `paper`, `mist`, `sepia`, `night`).
    pub background: String,
    /// Body font key.
    pub body_font: String,
    /// Heading font key (the body font when unset).
    pub heading_font: String,
    /// Body text size in px.
    pub text_px: u32,
    /// Line height.
    pub line_height: f64,
    /// The cover.
    pub cover: Option<Cover>,
    /// `plain`, `serif`, `display` or `eyebrow`.
    pub title_style: String,
    /// Whether the title is centred.
    pub title_center: bool,
    /// The small line above the title.
    pub eyebrow: Option<String>,
    /// Whether the byline (author · date) is shown.
    pub show_byline: bool,
    /// Whether the title is shown (`showTitle`: a page that sets its own title in its text, like a newspaper's
    /// nameplate, hides it).
    pub show_title: bool,
}

impl Settings {
    /// Reads the settings of a page.
    pub fn read(v: &Value) -> Settings {
        let s = |k: &str| v.get(k).and_then(Value::as_str).filter(|s| !s.is_empty());
        let width_px = match s("width") {
            Some("narrow") => Some(560),
            Some("wide") => Some(880),
            Some("full") => None,
            _ => Some(680),
        };
        let background = s("background")
            .filter(|b| palette().get("backgrounds").and_then(|bg| bg.get(*b)).is_some())
            .unwrap_or("white")
            .to_string();
        let body_font = s("bodyFont").filter(|f| font_name(f).is_some()).unwrap_or("jakarta").to_string();
        let heading_font = s("headingFont").filter(|f| font_name(f).is_some()).unwrap_or(&body_font).to_string();
        let text_px = match s("textSize") {
            Some("s") => 15,
            Some("l") => 19,
            _ => 17,
        };
        let line_height =
            v.get("lineHeight").and_then(Value::as_f64).filter(|n| (1.0..=3.0).contains(n)).unwrap_or(1.6);
        let cover = v.get("cover").and_then(|c| {
            let src = c.get("src").and_then(Value::as_str).filter(|s| !s.is_empty())?;
            Some(Cover {
                src: src.to_string(),
                position_y: c.get("positionY").and_then(Value::as_f64).unwrap_or(50.0).clamp(0.0, 100.0),
                height_px: match c.get("height").and_then(Value::as_str) {
                    Some("s") => 180,
                    Some("l") => 360,
                    Some("full") => 480,
                    _ => 260,
                },
                title_on_cover: c.get("titleOnCover").and_then(Value::as_bool).unwrap_or(false),
            })
        });
        Settings {
            width_px,
            background,
            body_font,
            heading_font,
            text_px,
            line_height,
            cover,
            title_style: s("titleStyle").unwrap_or("plain").to_string(),
            title_center: s("titleAlign") == Some("center"),
            eyebrow: s("eyebrow").map(str::to_string),
            show_byline: v.get("showByline").and_then(Value::as_bool).unwrap_or(true),
            show_title: v.get("showTitle").and_then(Value::as_bool).unwrap_or(true),
        }
    }
}

/// The family name of a font key of the schema (`lora` → `Lora`), `None` for an unknown key.
pub(crate) fn font_name(key: &str) -> Option<&'static str> {
    Some(match key {
        "jakarta" => "Plus Jakarta Sans",
        "lora" => "Lora",
        "source-serif" => "Source Serif 4",
        "merriweather" => "Merriweather",
        "playfair" => "Playfair Display",
        "inter" => "Inter",
        "jetbrains-mono" => "JetBrains Mono",
        "caveat" => "Caveat",
        _ => return None,
    })
}

/// The generic family a font key falls back to.
pub(crate) fn font_generic(key: &str) -> &'static str {
    match key {
        "lora" | "source-serif" | "merriweather" | "playfair" => "Georgia, serif",
        "jetbrains-mono" => "ui-monospace, Menlo, Consolas, monospace",
        "caveat" => "cursive",
        _ => "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
    }
}

// ---------------------------------------------------------------------------------------------------------------
// Palette
// ---------------------------------------------------------------------------------------------------------------

fn palette() -> &'static Value {
    static PALETTE: OnceLock<Value> = OnceLock::new();
    PALETTE.get_or_init(|| {
        serde_json::from_str(include_str!("../../../contract/richdoc/palette.json"))
            .expect("contract/richdoc/palette.json is valid JSON, checked by the tests")
    })
}

/// Which list of the palette a colour name is looked up in.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ColorUse {
    /// Text colours (`textStyle.color`, callout colour).
    Text,
    /// Highlight colours (highlight mark, table cell shading).
    Highlight,
}

/// Resolves a stored colour (a palette name or `#rrggbb`) to `#RRGGBB` for a page background; `None` for
/// anything else, so an unknown value can never reach CSS or XML.
pub(crate) fn resolve_color(value: &str, used: ColorUse, background: &str) -> Option<String> {
    if let Some(hex) = value.strip_prefix('#') {
        if hex.len() == 6 && hex.chars().all(|c| c.is_ascii_hexdigit()) {
            return Some(format!("#{}", hex.to_ascii_uppercase()));
        }
        return None;
    }
    let list = match used {
        ColorUse::Text => "text",
        ColorUse::Highlight => "highlight",
    };
    let backgrounds = palette().get("backgrounds")?;
    let bg = backgrounds.get(background).or_else(|| backgrounds.get("white"))?;
    bg.get(list)?.get(value)?.as_str().map(str::to_string)
}

/// Resolves a colour that may be a text-list name, a highlight-list name or `#rrggbb` (borders, drop caps).
pub(crate) fn resolve_any_color(value: &str, background: &str) -> Option<String> {
    resolve_color(value, ColorUse::Text, background).or_else(|| resolve_color(value, ColorUse::Highlight, background))
}

/// The page and ink colours of a background.
pub(crate) fn page_colors(background: &str) -> (String, String) {
    let bg = palette().get("backgrounds").and_then(|b| b.get(background).or_else(|| b.get("white")));
    let get = |k: &str, d: &str| bg.and_then(|b| b.get(k)).and_then(Value::as_str).unwrap_or(d).to_string();
    (get("page", "#FFFFFF"), get("ink", "#1E2A22"))
}

/// The callout colours (name in the highlight list, accent in the text list) of a callout kind.
pub(crate) fn callout_palette(kind: &str) -> (&'static str, &'static str) {
    match kind {
        "warning" => ("orange", "orange"),
        "success" => ("green", "green"),
        "danger" => ("red", "red"),
        "note" => ("violet", "violet"),
        _ => ("blue", "blue"),
    }
}

/// Picks a file name for an asset from its source (`/uploads/team.png` → `team.png`), safe for any file system.
pub(crate) fn file_name_of(src: &str, fallback_ext: &str) -> String {
    let path = src.split(['?', '#']).next().unwrap_or("");
    let last = path.rsplit('/').next().unwrap_or("");
    let clean: String =
        last.chars().map(|c| if c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_') { c } else { '_' }).collect();
    let clean = clean.trim_matches('.').to_string();
    if clean.is_empty() || !clean.contains('.') {
        let stem = if clean.is_empty() { "file".to_string() } else { clean };
        format!("{stem}.{fallback_ext}")
    } else {
        clean
    }
}

/// Makes names unique by adding `-2`, `-3`… before the extension.
#[derive(Debug, Default)]
pub(crate) struct UniqueNames {
    used: HashMap<String, usize>,
}

impl UniqueNames {
    /// Returns `name`, or `name` with a number added when it was already handed out (case-insensitive).
    pub fn take(&mut self, name: &str) -> String {
        let key = name.to_lowercase();
        let n = self.used.entry(key).or_insert(0);
        *n += 1;
        if *n == 1 {
            return name.to_string();
        }
        let count = *n;
        let candidate = match name.rfind('.') {
            Some(dot) if dot > 0 => format!("{}-{count}{}", &name[..dot], &name[dot..]),
            _ => format!("{name}-{count}"),
        };
        self.take(&candidate)
    }
}

/// The path (without extension) a page is written at: its `path`, or its title made safe.
pub(crate) fn page_path(page: &ExportPage) -> String {
    let raw = if page.path.trim().is_empty() { page.title.as_str() } else { page.path.as_str() };
    let parts: Vec<String> = raw.split('/').map(safe_file_part).filter(|p| !p.is_empty()).collect();
    if parts.is_empty() { "page".to_string() } else { parts.join("/") }
}

/// Removes the characters a file system rejects (`/ \ : * ? " < > |` and controls), trims dots and spaces and
/// keeps at most 120 characters.
pub(crate) fn safe_file_part(s: &str) -> String {
    let cleaned: String = s
        .chars()
        .filter(|c| !matches!(c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|') && !c.is_control())
        .take(120)
        .collect();
    let trimmed = cleaned.trim_matches(|c: char| c == '.' || c.is_whitespace());
    if trimmed == ".." { String::new() } else { trimmed.to_string() }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn palette_names_resolve_per_background() {
        assert_eq!(resolve_color("teal", ColorUse::Text, "white").as_deref(), Some("#0F766E"));
        assert_eq!(resolve_color("yellow", ColorUse::Highlight, "night").as_deref(), Some("#5C4A12"));
        assert_eq!(resolve_color("#abcdef", ColorUse::Text, "white").as_deref(), Some("#ABCDEF"));
        assert_eq!(resolve_color("red;background:url(x)", ColorUse::Text, "white"), None);
        assert_eq!(resolve_color("#12345", ColorUse::Text, "white"), None);
    }

    #[test]
    fn grid_places_merged_cells() {
        let table = serde_json::json!({"type":"table","content":[
            {"type":"tableRow","content":[
                {"type":"tableCell","attrs":{"rowspan":2}},
                {"type":"tableCell","attrs":{"colspan":2}}]},
            {"type":"tableRow","content":[{"type":"tableCell"},{"type":"tableCell"}]}]});
        let (rows, width) = table_grid(&table);
        assert_eq!(width, 3);
        assert_eq!(rows[1][0].col, 1);
        assert_eq!(rows[1][1].col, 2);
    }

    #[test]
    fn unique_names_count_up() {
        let mut names = UniqueNames::default();
        assert_eq!(names.take("a.png"), "a.png");
        assert_eq!(names.take("a.png"), "a-2.png");
        assert_eq!(names.take("A.png"), "A-3.png");
    }

    #[test]
    fn file_parts_drop_rejected_characters() {
        assert_eq!(safe_file_part("Architecture / draft?"), "Architecture  draft");
        assert_eq!(safe_file_part(".."), "");
    }
}
