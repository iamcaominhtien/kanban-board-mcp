//! Flattens the inline content of a text block into pieces with their marks, with reader highlights cut in, so
//! each renderer only has to draw a flat list.

use serde_json::Value;

use crate::model::{Highlight, attr_str, children, ty};

/// A link mark.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct Link {
    /// The stored `href` (not yet checked: renderers pass it through [`safe_href`]).
    pub href: String,
    /// The hover title, if any.
    pub title: Option<String>,
}

/// A reader highlight over a piece.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct ReaderMark {
    /// Palette name or `#rrggbb`; `None` = yellow.
    pub color: Option<String>,
    /// Who made it.
    pub author: Option<String>,
}

/// The marks on a piece of text.
#[derive(Debug, Clone, Default, PartialEq)]
pub(crate) struct Marks {
    pub bold: bool,
    pub italic: bool,
    pub strike: bool,
    pub code: bool,
    pub underline: bool,
    pub sup: bool,
    pub sub: bool,
    pub link: Option<Link>,
    /// `Some(None)` = highlight in the default colour.
    pub highlight: Option<Option<String>>,
    pub color: Option<String>,
    pub font: Option<String>,
    /// Font size in px.
    pub size: Option<f64>,
    pub reader: Option<ReaderMark>,
}

impl Marks {
    /// Reads the `marks` array of an inline node.
    pub fn of(node: &Value) -> Marks {
        let mut m = Marks::default();
        let Some(list) = node.get("marks").and_then(Value::as_array) else {
            return m;
        };
        for mark in list {
            let a = |k: &str| mark.get("attrs").and_then(|a| a.get(k));
            let s = |k: &str| a(k).and_then(Value::as_str).filter(|s| !s.is_empty()).map(str::to_string);
            match ty(mark) {
                "bold" => m.bold = true,
                "italic" => m.italic = true,
                "strike" => m.strike = true,
                "code" => m.code = true,
                "underline" => m.underline = true,
                "superscript" => m.sup = true,
                "subscript" => m.sub = true,
                "link" => {
                    if let Some(href) = s("href") {
                        m.link = Some(Link { href, title: s("title") });
                    }
                }
                "highlight" => m.highlight = Some(s("color")),
                "textStyle" => {
                    if let Some(c) = s("color") {
                        m.color = Some(c);
                    }
                    if let Some(f) = s("fontFamily") {
                        m.font = Some(f);
                    }
                    if let Some(n) = a("fontSize").and_then(Value::as_f64).filter(|n| (4.0..=200.0).contains(n)) {
                        m.size = Some(n);
                    }
                }
                _ => {}
            }
        }
        m
    }
}

/// One piece of a text block.
#[derive(Debug, Clone)]
pub(crate) enum Piece<'a> {
    /// A run of text with its marks.
    Text { text: String, marks: Marks },
    /// A line break inside the block.
    Break,
    /// An inline atom (`docRef`, `ticketRef`, `mathInline`, or a type the schema does not know) with its marks.
    Atom { node: &'a Value, marks: Marks },
}

/// Flattens the inline children of `block`, cutting text where the `highlights` of this block start and end.
/// Offsets count UTF-16 code units of text; an atom or a line break counts as one.
pub(crate) fn pieces<'a>(block: &'a Value, highlights: &[&Highlight]) -> Vec<Piece<'a>> {
    let mut out = Vec::new();
    let mut offset = 0usize;
    for node in children(block) {
        match ty(node) {
            "text" => {
                let text = node.get("text").and_then(Value::as_str).unwrap_or("");
                let marks = Marks::of(node);
                let len: usize = text.encode_utf16().count();
                if highlights.is_empty() {
                    out.push(Piece::Text { text: text.to_string(), marks });
                } else {
                    split_text(text, offset, &marks, highlights, &mut out);
                }
                offset += len;
            }
            "hardBreak" => {
                out.push(Piece::Break);
                offset += 1;
            }
            _ => {
                out.push(Piece::Atom { node, marks: Marks::of(node) });
                offset += 1;
            }
        }
    }
    out
}

fn split_text(text: &str, start: usize, marks: &Marks, highlights: &[&Highlight], out: &mut Vec<Piece<'_>>) {
    let mut current = String::new();
    let mut current_hl: Option<&Highlight> = covering(start, highlights);
    let mut pos = start;
    for c in text.chars() {
        let hl = covering(pos, highlights);
        if !same(hl, current_hl) && !current.is_empty() {
            out.push(text_piece(std::mem::take(&mut current), marks, current_hl));
        }
        current_hl = hl;
        current.push(c);
        pos += c.len_utf16();
    }
    if !current.is_empty() {
        out.push(text_piece(current, marks, current_hl));
    }
}

fn same(a: Option<&Highlight>, b: Option<&Highlight>) -> bool {
    match (a, b) {
        (Some(x), Some(y)) => std::ptr::eq(x, y),
        (None, None) => true,
        _ => false,
    }
}

fn covering<'h>(pos: usize, highlights: &[&'h Highlight]) -> Option<&'h Highlight> {
    highlights.iter().copied().find(|h| h.start <= pos && pos < h.end)
}

fn text_piece<'a>(text: String, marks: &Marks, hl: Option<&Highlight>) -> Piece<'a> {
    let mut marks = marks.clone();
    if let Some(h) = hl {
        marks.reader = Some(ReaderMark { color: h.color.clone(), author: h.author.clone() });
    }
    Piece::Text { text, marks }
}

/// The highlights of one block (by its `blockId`), or none.
pub(crate) fn block_highlights<'h>(block: &Value, all: &'h [Highlight]) -> Vec<&'h Highlight> {
    match attr_str(block, "blockId") {
        Some(id) if !all.is_empty() => all.iter().filter(|h| h.block_id == id && h.end > h.start).collect(),
        _ => Vec::new(),
    }
}

/// Checks a link target: `http(s)`, `mailto`, `tel`, a path or a fragment pass; anything else (`javascript:`,
/// `data:`, `vbscript:`…) becomes `None`.
pub(crate) fn safe_href(href: &str) -> Option<String> {
    let cleaned: String = href.chars().filter(|c| !c.is_control()).collect();
    let trimmed = cleaned.trim();
    if trimmed.is_empty() {
        return None;
    }
    let lower: String = trimmed.chars().filter(|c| !c.is_whitespace()).collect::<String>().to_ascii_lowercase();
    let scheme_end = lower.find(':');
    let first_sep = lower.find(['/', '?', '#']);
    let has_scheme = match (scheme_end, first_sep) {
        (Some(c), Some(s)) => c < s,
        (Some(_), None) => true,
        _ => false,
    };
    if !has_scheme {
        return Some(trimmed.to_string());
    }
    if ["http:", "https:", "mailto:", "tel:"].iter().any(|p| lower.starts_with(p)) {
        Some(trimmed.to_string())
    } else {
        None
    }
}

/// Checks a picture or media source: like [`safe_href`], plus `data:image/…` (pictures only).
pub(crate) fn safe_src(src: &str) -> Option<String> {
    let lower = src.trim().to_ascii_lowercase();
    if lower.starts_with("data:image/") {
        return Some(src.trim().to_string());
    }
    safe_href(src)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn hrefs_are_checked() {
        assert_eq!(safe_href("https://a.b/c").as_deref(), Some("https://a.b/c"));
        assert_eq!(safe_href("/uploads/x.png").as_deref(), Some("/uploads/x.png"));
        assert_eq!(safe_href("#top").as_deref(), Some("#top"));
        assert_eq!(safe_href("java\nscript:alert(1)"), None);
        assert_eq!(safe_href(" JAVASCRIPT:alert(1)"), None);
        assert_eq!(safe_href("data:text/html,<script>"), None);
        assert_eq!(safe_href("page?x=a:b").as_deref(), Some("page?x=a:b"));
    }

    #[test]
    fn highlights_cut_text() {
        let block = json!({"type":"paragraph","attrs":{"blockId":"b-000001"},
            "content":[{"type":"text","text":"Hello world"}]});
        let h = Highlight { block_id: "b-000001".into(), start: 6, end: 11, ..Default::default() };
        let all = [h];
        let hls = block_highlights(&block, &all);
        let p = pieces(&block, &hls);
        assert_eq!(p.len(), 2);
        match &p[1] {
            Piece::Text { text, marks } => {
                assert_eq!(text, "world");
                assert!(marks.reader.is_some());
            }
            other => panic!("unexpected {other:?}"),
        }
    }
}
