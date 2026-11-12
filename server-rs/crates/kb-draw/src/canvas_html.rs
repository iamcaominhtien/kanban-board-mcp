//! `services/canvas_html.py`: reading a board's HTML: a plain-text outline (for AI and the thumbnail) and a title.
//!
//! Board files are kept exactly as they were given (a board is an open web page: scripts, handlers, CDN links and
//! fonts all run, as when the file is opened in a browser). Nothing is stripped on the way in.

use kb_base::pytext;

use crate::html::{self, Handler};

/// Elements with no closing tag.
pub const VOID: [&str; 14] =
    ["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"];

const HEAD: [&str; 7] = ["h1", "h2", "h3", "h4", "h5", "h6", "title"];
const BLOCK: [&str; 12] =
    ["p", "li", "label", "td", "th", "figcaption", "blockquote", "span", "div", "a", "small", "legend"];
const FIELD: [&str; 3] = ["input", "textarea", "select"];
const PIC: [&str; 5] = ["img", "svg", "canvas", "video", "picture"];
const HIDDEN: [&str; 4] = ["style", "head", "title", "noscript"];

/// `_Outline`: headings, text blocks, buttons, fields and pictures of a page in reading order.
#[derive(Default)]
struct Outline {
    items: Vec<(String, String)>,
    stack: Vec<String>,
    buf: String,
    hidden: usize,
}

impl Outline {
    fn flush(&mut self) {
        let text = pytext::squash(&self.buf);
        self.buf.clear();
        if text.is_empty() || self.hidden > 0 {
            return;
        }
        let mut kind = "text";
        for t in self.stack.iter().rev() {
            if HEAD.contains(&t.as_str()) {
                kind = "head";
                break;
            }
            if t == "button" || t == "a" {
                kind = if t == "button" { "button" } else { "text" };
                break;
            }
        }
        self.items.push((kind.to_string(), text));
    }
}

/// `dict(attrs).get(name)`: the last of repeated names wins.
fn attr<'a>(attrs: &'a [(String, Option<String>)], name: &str) -> Option<&'a str> {
    attrs.iter().rev().find(|(n, _)| n == name).and_then(|(_, v)| v.as_deref())
}

/// `dict(attrs).get(name) or default`.
fn attr_or<'a>(attrs: &'a [(String, Option<String>)], name: &str, default: &'a str) -> &'a str {
    attr(attrs, name).filter(|v| !v.is_empty()).unwrap_or(default)
}

impl Handler for Outline {
    fn handle_starttag(&mut self, tag: &str, attrs: &[(String, Option<String>)]) {
        if HIDDEN.contains(&tag) {
            self.hidden += 1;
        }
        let is_block = HEAD.contains(&tag) || BLOCK.contains(&tag) || tag == "button";
        if FIELD.contains(&tag) {
            self.flush();
            let kind = attr_or(attrs, "type", "");
            if kind == "submit" || kind == "button" {
                self.items.push(("button".into(), attr_or(attrs, "value", "Submit").to_string()));
            } else if kind != "hidden" {
                self.items.push(("field".into(), attr_or(attrs, "placeholder", "").to_string()));
            }
        } else if PIC.contains(&tag) {
            self.flush();
            self.items.push(("pic".into(), attr_or(attrs, "alt", "").to_string()));
        } else if is_block {
            self.flush();
        }
        if !VOID.contains(&tag) {
            self.stack.push(tag.to_string());
        }
    }

    fn handle_endtag(&mut self, tag: &str) {
        if HEAD.contains(&tag) || BLOCK.contains(&tag) || tag == "button" {
            self.flush();
        }
        if HIDDEN.contains(&tag) && self.hidden > 0 {
            self.hidden -= 1;
        }
        if self.stack.iter().any(|t| t == tag) {
            while let Some(top) = self.stack.pop() {
                if top == tag {
                    break;
                }
            }
        }
    }

    fn handle_data(&mut self, data: &str) {
        self.buf.push_str(data);
    }
}

/// `[(kind, text)]` in reading order: `head`, `text`, `button`, `field` or `pic`.
pub fn outline(source: &str) -> Vec<(String, String)> {
    let mut p = Outline::default();
    html::parse(source, &mut p);
    p.flush();
    p.items
}

/// A character of `title` as the case-insensitive match of Python's `re` sees it (`i` also matches `İ` and `ı`).
fn ci_eq(c: char, lower: char) -> bool {
    c == lower || c.to_ascii_lowercase() == lower || (lower == 'i' && matches!(c, '\u{130}' | '\u{131}'))
}

fn ci_word(chars: &[char], at: usize, word: &str) -> bool {
    word.chars().enumerate().all(|(k, w)| chars.get(at + k).is_some_and(|&c| ci_eq(c, w)))
}

/// `re.search(r"<title[^>]*>(.*?)</title>", source, re.I | re.S)`: the text between the tags.
fn title_tag(source: &str) -> Option<String> {
    let chars: Vec<char> = source.chars().collect();
    let n = chars.len();
    for start in 0..n {
        if chars[start] != '<' || !ci_word(&chars, start + 1, "title") {
            continue;
        }
        let Some(gt) = chars[start + 6..].iter().position(|&c| c == '>').map(|p| start + 6 + p) else {
            continue;
        };
        let from = gt + 1;
        for at in from..n {
            if chars[at] == '<' && chars.get(at + 1) == Some(&'/') && ci_word(&chars, at + 2, "title") {
                if chars.get(at + 7) == Some(&'>') {
                    return Some(chars[from..at].iter().collect());
                }
            }
        }
    }
    None
}

/// The `<title>` or the first heading of a page.
pub fn title_of(source: &str, fallback: &str) -> String {
    if let Some(found) = title_tag(source) {
        if !pytext::strip(&found).is_empty() {
            let text = html::unescape(&pytext::squash(&found));
            return text.chars().take(120).collect();
        }
    }
    for (kind, text) in outline(source) {
        if kind == "head" {
            return text.chars().take(120).collect();
        }
    }
    fallback.to_string()
}
