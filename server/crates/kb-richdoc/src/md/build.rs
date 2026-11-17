//! Tokens to page JSON: the `parseMarkdown` handlers of the editor's extensions and `@tiptap/markdown`'s
//! `MarkdownManager` (implicit empty paragraphs, mark application, inline HTML), then what ProseMirror does when
//! the editor takes the JSON (adjacent text joined, marks in schema order, the trailing paragraph).

use std::collections::HashMap;

use serde_json::{Map, Value, json};

use super::block::Lexer;
use super::html;
use super::inline::InlineLexer;
use super::token::{Block, ITok, Inline, List, OrderedList, TaskItem};
use crate::chars::{leading_space_count, trim};

/// The marks in ProseMirror rank order (the editor's schema): the order they nest in when written.
pub const PM_MARK_RANK: &[&str] =
    &["link", "bold", "code", "italic", "strike", "highlight", "underline", "superscript", "subscript", "textStyle"];

/// Reads plain Markdown into the editor's JSON (not yet canonical, without block ids).
pub fn parse(md: &str) -> Value {
    let mut lexer = Lexer::new();
    let tokens = lexer.lex(md);
    let links = std::mem::take(&mut lexer.links);
    let mut b = Builder { links: &links, depth: 0, annotated: false, errors: Vec::new() };
    let mut content = b.parse_tokens(&tokens, true);
    normalize_children(&mut content);
    // StarterKit's trailing node: an empty paragraph after a last block that is not a paragraph
    let last_is_para = content.last().is_some_and(|n| n["type"] == "paragraph");
    if !last_is_para {
        content.push(json!({"type": "paragraph"}));
    }
    json!({"type": "doc", "content": content})
}

struct Builder<'a> {
    links: &'a HashMap<String, (String, Option<String>, usize)>,
    depth: usize,
    annotated: bool,
    errors: Vec<String>,
}

/// Reads Markdown into blocks without the trailing paragraph; with `annotated`, spans and page-reference
/// attributes are read too. Returns the blocks and the broken spans found.
pub fn parse_blocks(md: &str, annotated: bool) -> (Vec<Value>, Vec<String>) {
    let mut lexer = Lexer::new();
    let tokens = lexer.lex(md);
    let links = std::mem::take(&mut lexer.links);
    let mut b = Builder { links: &links, depth: 0, annotated, errors: Vec::new() };
    let mut content = b.parse_tokens(&tokens, true);
    normalize_children(&mut content);
    (content, b.errors)
}

/// A token or a blank-line run split off a token's end (`extractAbsorbedBlankLines`).
enum Item<'t> {
    Tok(&'t Block),
    Space(String),
}

/// `/\n[^\S\n]*(?:\n[^\S\n]*)+$/`: where the trailing blank lines of `raw` start.
fn trailing_blank_lines(raw: &str) -> Option<usize> {
    let ws_start = raw.len() - crate::chars::trim_end(raw).len();
    let ws_start = raw.len() - (raw.len() - ws_start).min(raw.len());
    let tail_start = crate::chars::trim_end(raw).len();
    let _ = ws_start;
    let tail = &raw[tail_start..];
    let first_nl = tail.find('\n')?;
    let from = &tail[first_nl..];
    (from.matches('\n').count() >= 2).then_some(tail_start + first_nl)
}

fn count_separators(raw: &str) -> usize {
    raw.replace("\r\n", "\n").matches("\n\n").count()
}

fn text_node(text: String) -> Value {
    json!({"type": "text", "text": text})
}

fn node(ty: &str, attrs: Option<Value>, content: Option<Vec<Value>>) -> Value {
    let mut m = Map::new();
    m.insert("type".into(), ty.into());
    if let Some(a) = attrs {
        if a.as_object().is_some_and(|o| !o.is_empty()) {
            m.insert("attrs".into(), a);
        }
    }
    if let Some(c) = content {
        m.insert("content".into(), Value::Array(c));
    }
    Value::Object(m)
}

fn paragraph(content: Vec<Value>) -> Value {
    node("paragraph", None, Some(content))
}

/// `@tiptap/core`'s `decodeHtmlEntities`: `&lt;`, `&gt;`, `&quot;`, `&amp;` and numeric references.
pub fn decode_entities(text: &str) -> String {
    if !text.contains('&') {
        return text.to_string();
    }
    let c: Vec<char> = text.chars().collect();
    let mut out = String::with_capacity(text.len());
    let mut i = 0;
    while i < c.len() {
        if c[i] == '&' {
            let rest = &c[i + 1..];
            let mut handled = false;
            if rest.first() == Some(&'#') {
                let hex = matches!(rest.get(1), Some('x') | Some('X'));
                let st = if hex { 2 } else { 1 };
                let digits = rest[st..]
                    .iter()
                    .take_while(|x| if hex { x.is_ascii_hexdigit() } else { x.is_ascii_digit() })
                    .count();
                let max = if hex { 6 } else { 7 };
                if digits >= 1 && digits <= max && rest.get(st + digits) == Some(&';') {
                    let s: String = rest[st..st + digits].iter().collect();
                    let v = u32::from_str_radix(&s, if hex { 16 } else { 10 }).unwrap_or(0);
                    out.push(decode_code_point(v));
                    i += 1 + st + digits + 1;
                    handled = true;
                }
            } else {
                for (name, rep) in [("lt", '<'), ("gt", '>'), ("quot", '"'), ("amp", '&')] {
                    let n: Vec<char> = name.chars().collect();
                    if rest.len() > n.len() && rest[..n.len()] == n[..] && rest[n.len()] == ';' {
                        out.push(rep);
                        i += 1 + n.len() + 1;
                        handled = true;
                        break;
                    }
                }
            }
            if handled {
                continue;
            }
        }
        out.push(c[i]);
        i += 1;
    }
    out
}

fn decode_code_point(v: u32) -> char {
    if v == 0 || v > 0x10ffff || (0xd800..=0xdfff).contains(&v) {
        return '\u{fffd}';
    }
    let mapped = match v {
        0x80 => 0x20ac,
        0x82 => 0x201a,
        0x83 => 0x0192,
        0x84 => 0x201e,
        0x85 => 0x2026,
        0x86 => 0x2020,
        0x87 => 0x2021,
        0x88 => 0x02c6,
        0x89 => 0x2030,
        0x8a => 0x0160,
        0x8b => 0x2039,
        0x8c => 0x0152,
        0x8e => 0x017d,
        0x91 => 0x2018,
        0x92 => 0x2019,
        0x93 => 0x201c,
        0x94 => 0x201d,
        0x95 => 0x2022,
        0x96 => 0x2013,
        0x97 => 0x2014,
        0x98 => 0x02dc,
        0x99 => 0x2122,
        0x9a => 0x0161,
        0x9b => 0x203a,
        0x9c => 0x0153,
        0x9e => 0x017e,
        0x9f => 0x0178,
        x => x,
    };
    char::from_u32(mapped).unwrap_or('\u{fffd}')
}

/// `isTaskItem` on a list item's source: (checked).
fn is_task_item(raw: &str) -> Option<bool> {
    let t = crate::chars::trim_start(raw);
    let mut cs = t.chars();
    if !cs.next().is_some_and(|c| matches!(c, '-' | '+' | '*')) {
        return None;
    }
    let r = cs.as_str();
    let ws = leading_space_count(r);
    if ws == 0 {
        return None;
    }
    let r: String = r.chars().skip(ws).collect();
    let b = r.as_bytes();
    if b.len() < 4 || b[0] != b'[' || !matches!(b[1], b' ' | b'x' | b'X') || b[2] != b']' {
        return None;
    }
    if !r[3..].chars().next().is_some_and(crate::chars::is_space) {
        return None;
    }
    Some(b[1] != b' ')
}

impl Builder<'_> {
    fn inline(&mut self, text: &str) -> Vec<ITok> {
        self.inline_with(text, usize::MAX)
    }

    /// Inline tokens knowing only the first `defs` link definitions.
    fn inline_with(&mut self, text: &str, defs: usize) -> Vec<ITok> {
        let mut lx = InlineLexer::new(self.links);
        lx.max_defs = defs;
        lx.annotated = self.annotated;
        let toks = lx.tokens(text);
        self.errors.append(&mut lx.errors);
        toks
    }

    /// `parseTokens` (with `implicit`, blank-line runs become empty paragraphs).
    fn parse_tokens(&mut self, tokens: &[Block], implicit: bool) -> Vec<Value> {
        if self.depth > super::block::MAX_DEPTH + 8 {
            return Vec::new();
        }
        self.depth += 1;
        let mut items: Vec<Item> = Vec::new();
        for (i, t) in tokens.iter().enumerate() {
            let next_is_space = matches!(tokens.get(i + 1), Some(Block::Space { .. }));
            if implicit && !matches!(t, Block::Space { .. }) && !next_is_space {
                if let Some(at) = trailing_blank_lines(t.raw()) {
                    items.push(Item::Tok(t));
                    items.push(Item::Space(t.raw()[at..].to_string()));
                    continue;
                }
            }
            match t {
                Block::Space { raw } => items.push(Item::Space(raw.clone())),
                _ => items.push(Item::Tok(t)),
            }
        }
        let non_space: Vec<usize> =
            items.iter().enumerate().filter(|(_, it)| matches!(it, Item::Tok(_))).map(|(i, _)| i).collect();
        let mut out = Vec::new();
        let mut ptr = 0;
        let mut prev: Option<usize> = None;
        for (i, it) in items.iter().enumerate() {
            while ptr < non_space.len() && non_space[ptr] < i {
                prev = Some(non_space[ptr]);
                ptr += 1;
            }
            match it {
                Item::Space(raw) => {
                    if !implicit {
                        continue;
                    }
                    let n = count_separators(raw);
                    if n == 0 {
                        continue;
                    }
                    let boundary = prev.is_none() || ptr >= non_space.len();
                    let count = if boundary { n } else { n - 1 };
                    for _ in 0..count {
                        out.push(paragraph(Vec::new()));
                    }
                }
                Item::Tok(t) => out.extend(self.parse_token(t)),
            }
        }
        self.depth -= 1;
        out
    }

    fn parse_token(&mut self, t: &Block) -> Vec<Value> {
        match t {
            Block::Space { .. } | Block::Def { .. } => Vec::new(),
            Block::Paragraph { text, .. } => vec_or(self.paragraph(text, usize::MAX)),
            Block::EarlyParagraph { text, defs, .. } => vec_or(self.paragraph(text, *defs)),
            Block::Text { text, .. } => vec![text_node(text.clone())],
            Block::Heading { depth, text, .. } => {
                let toks = self.inline(text);
                vec![node("heading", Some(json!({"level": depth})), Some(self.parse_inline(&toks)))]
            }
            Block::Code { text, lang, indented, fenced_at_col0, .. } => {
                if !*indented && !*fenced_at_col0 {
                    return Vec::new();
                }
                let lang = lang.clone().filter(|l| !l.is_empty());
                let content = if text.is_empty() { Vec::new() } else { vec![text_node(text.clone())] };
                vec![node("codeBlock", Some(json!({"language": lang})), Some(content))]
            }
            Block::Hr { .. } => vec![node("horizontalRule", None, None)],
            Block::Blockquote { tokens, .. } => {
                let c = self.parse_tokens(tokens, true);
                vec![node("blockquote", None, Some(c))]
            }
            Block::Callout { kind, tokens, .. } => {
                let mut c = self.parse_tokens(tokens, false);
                if c.is_empty() {
                    c.push(paragraph(Vec::new()));
                }
                vec![node("callout", Some(json!({"kind": kind})), Some(c))]
            }
            Block::Diagram { label, id, .. } => vec![node(
                "diagram",
                Some(json!({"id": id, "label": if label.is_empty() { "Diagram" } else { label }})),
                None,
            )],
            Block::Sketch { label, id, .. } => vec![node(
                "sketch",
                Some(json!({"id": id, "label": if label.is_empty() { "Sketch" } else { label }})),
                None,
            )],
            Block::Canvas { label, id, fragment, .. } => vec![node(
                "canvas",
                Some(json!({"id": id, "label": if label.is_empty() { "Canvas" } else { label }, "fragment": fragment})),
                None,
            )],
            Block::Math { latex, .. } => vec![node("mathBlock", Some(json!({"latex": latex})), None)],
            Block::Html { raw } => self.html_block(raw),
            Block::Table { align, header, rows, .. } => vec![self.table(align, header, rows)],
            Block::TaskList { items, .. } => vec![self.task_list(items)],
            Block::List(l) => self.list(l),
            Block::OrderedList(l) => vec![self.ordered_list(l)],
        }
    }

    /// The Paragraph extension's `parseMarkdown`.
    fn paragraph(&mut self, text: &str, defs: usize) -> Option<Value> {
        let toks = self.inline_with(text, defs);
        if toks.len() == 1 {
            if let Inline::Image { .. } = toks[0].kind {
                return Some(self.image(&toks[0].kind));
            }
        }
        let content = self.parse_inline(&toks);
        let marker = toks.len() == 1
            && matches!(&toks[0].kind, Inline::Text(t) if toks[0].raw == "&nbsp;" || t == "&nbsp;" || toks[0].raw == "\u{a0}" || t == "\u{a0}");
        if marker
            && content.len() == 1
            && content[0]["type"] == "text"
            && matches!(content[0]["text"].as_str(), Some("&nbsp;") | Some("\u{a0}"))
        {
            return Some(paragraph(Vec::new()));
        }
        Some(paragraph(content))
    }

    fn image(&mut self, tok: &Inline) -> Value {
        let Inline::Image { href, title, text } = tok else { return paragraph(Vec::new()) };
        let (alt, width) = image_alt_width(text);
        node("image", Some(json!({"src": href, "title": title, "alt": alt, "width": width})), None)
    }

    fn html_block(&mut self, raw: &str) -> Vec<Value> {
        if trim(raw).is_empty() {
            return Vec::new();
        }
        if html::is_unrecognized(raw) {
            return html::literal(raw).map(|t| vec![paragraph(vec![text_node(t)])]).unwrap_or_default();
        }
        vec![paragraph(html::parse_inline(raw))]
    }

    fn table(&mut self, align: &[Option<&'static str>], header: &[String], rows: &[Vec<String>]) -> Value {
        let mut out_rows = Vec::new();
        let cell = |b: &mut Self, ty: &str, i: usize, text: &str| {
            let toks = b.inline(text);
            let content = b.parse_inline(&toks);
            let attrs = align.get(i).copied().flatten().map(|a| json!({"align": a}));
            node(ty, attrs, Some(vec![paragraph(content)]))
        };
        let hcells: Vec<Value> = header.iter().enumerate().map(|(i, h)| cell(self, "tableHeader", i, h)).collect();
        out_rows.push(node("tableRow", None, Some(hcells)));
        for r in rows {
            let cells: Vec<Value> = r.iter().enumerate().map(|(i, c)| cell(self, "tableCell", i, c)).collect();
            out_rows.push(node("tableRow", None, Some(cells)));
        }
        node("table", None, Some(out_rows))
    }

    fn task_list(&mut self, items: &[TaskItem]) -> Value {
        let content = items.iter().map(|it| self.task_item(it)).collect();
        node("taskList", None, Some(content))
    }

    fn task_item(&mut self, it: &TaskItem) -> Value {
        let toks = self.inline_with(&it.text, it.defs);
        let mut content = vec![paragraph(self.parse_inline(&toks))];
        if !it.nested.is_empty() {
            content.extend(self.parse_tokens(&it.nested, false));
        }
        node("taskItem", Some(json!({"checked": it.checked})), Some(content))
    }

    /// `parseListToken`: a marked list, split into bullet and task lists when it mixes them.
    fn list(&mut self, l: &List) -> Vec<Value> {
        let tasks: Vec<Option<bool>> = l.items.iter().map(|i| is_task_item(&i.raw)).collect();
        let has_task = tasks.iter().any(Option::is_some);
        let has_plain = tasks.iter().any(Option::is_none);
        if !has_task || !has_plain {
            return vec![self.plain_list(l, &l.items.iter().collect::<Vec<_>>())];
        }
        let mut out = Vec::new();
        let mut i = 0;
        while i < l.items.len() {
            let task = tasks[i].is_some();
            let mut j = i;
            while j < l.items.len() && tasks[j].is_some() == task {
                j += 1;
            }
            if task {
                let items: Vec<TaskItem> = l.items[i..j]
                    .iter()
                    .zip(&tasks[i..j])
                    .map(|(it, checked)| task_from_raw(&it.raw, checked.unwrap_or(false)))
                    .collect();
                out.push(self.task_list(&items));
            } else {
                out.push(self.plain_list(l, &l.items[i..j].iter().collect::<Vec<_>>()));
            }
            i = j;
        }
        out
    }

    fn plain_list(&mut self, l: &List, items: &[&super::token::ListItem]) -> Value {
        if l.ordered {
            let content = items.iter().map(|it| self.ordered_item(&it.tokens)).collect();
            let mut attrs = Map::new();
            // `token.start || 1`: 0 reads as 1
            if l.start != 1.0 && l.start != 0.0 && !l.start.is_nan() {
                attrs.insert("start".into(), num(l.start));
            }
            return node("orderedList", Some(Value::Object(attrs)), Some(content));
        }
        let content = items.iter().map(|it| self.list_item(it)).collect();
        node("bulletList", None, Some(content))
    }

    /// The ListItem extension's `parseMarkdown`.
    fn list_item(&mut self, it: &super::token::ListItem) -> Value {
        let toks = &it.tokens;
        let mut content: Vec<Value> = Vec::new();
        if !toks.is_empty() {
            let same_line = !it.text.is_empty()
                && toks.len() == 1
                && match &toks[0] {
                    Block::OrderedList(o) => o.raw == it.text,
                    Block::List(l2) => l2.ordered && l2.raw == it.text,
                    _ => false,
                };
            if same_line {
                let t = self.inline(&it.text);
                return node("listItem", None, Some(vec![paragraph(self.parse_inline(&t))]));
            }
            if toks.iter().any(|t| matches!(t, Block::Paragraph { .. })) {
                content = self.parse_tokens(toks, true);
            } else if let Block::Text { text, .. } = &toks[0] {
                let t = self.inline(text);
                content.push(paragraph(self.parse_inline(&t)));
                if toks.len() > 1 {
                    content.extend(self.parse_tokens(&toks[1..], true));
                }
            } else {
                content = self.parse_tokens(toks, true);
            }
        }
        if content.is_empty() {
            content.push(paragraph(Vec::new()));
        }
        node("listItem", None, Some(content))
    }

    /// `parseListItems` of the OrderedList extension.
    fn ordered_item(&mut self, toks: &[Block]) -> Value {
        let mut content = Vec::new();
        for t in toks {
            match t {
                Block::Text { text, .. } => content.push(paragraph(vec![text_node(text.clone())])),
                _ => content.extend(self.parse_tokens(std::slice::from_ref(t), false)),
            }
        }
        node("listItem", None, Some(content))
    }

    fn ordered_list(&mut self, l: &OrderedList) -> Value {
        let content = l.items.iter().map(|toks| self.ordered_item(toks)).collect();
        let mut attrs = Map::new();
        // `token.start || 1`: 0 reads as 1
        if l.start != 1.0 && l.start != 0.0 && !l.start.is_nan() {
            attrs.insert("start".into(), num(l.start));
        }
        if let Some(t) = &l.type_marker {
            attrs.insert("type".into(), Value::String(t.clone()));
        }
        node("orderedList", Some(Value::Object(attrs)), Some(content))
    }

    /// `parseInlineTokens`.
    fn parse_inline(&mut self, tokens: &[ITok]) -> Vec<Value> {
        let mut out: Vec<Value> = Vec::new();
        let mut i = 0;
        while i < tokens.len() {
            let t = &tokens[i];
            match &t.kind {
                Inline::Text(text) => out.push(text_node(decode_entities(text))),
                Inline::Escape(text) => out.push(text_node(text.clone())),
                Inline::Html => {
                    let raw = &t.raw;
                    if let Some(tag) = open_tag_name(raw) {
                        let mut parts = vec![raw.clone()];
                        let mut found = None;
                        for (j, u) in tokens.iter().enumerate().skip(i + 1) {
                            parts.push(u.raw.clone());
                            if matches!(u.kind, Inline::Html) && closes(&u.raw, &tag) {
                                found = Some(j);
                                break;
                            }
                        }
                        if let Some(j) = found {
                            out.extend(self.html_inline(&parts.concat()));
                            i = j + 1;
                            continue;
                        }
                    }
                    out.extend(self.html_inline(raw));
                }
                Inline::Strong(c) => {
                    let inner = self.parse_inline(c);
                    out.extend(apply_mark(inner, &json!({"type": "bold"})));
                }
                Inline::Em(c) => {
                    let inner = self.parse_inline(c);
                    out.extend(apply_mark(inner, &json!({"type": "italic"})));
                }
                Inline::Del(c) => {
                    let inner = self.parse_inline(c);
                    out.extend(apply_mark(inner, &json!({"type": "strike"})));
                }
                Inline::Highlight(c) => {
                    let inner = self.parse_inline(c);
                    out.extend(apply_mark(inner, &json!({"type": "highlight"})));
                }
                Inline::Link { href, title, tokens: c } => {
                    let inner = self.parse_inline(c);
                    out.extend(apply_mark(inner, &json!({"type": "link", "attrs": {"href": href, "title": title}})));
                }
                Inline::Codespan(text) => {
                    out.extend(apply_mark(vec![text_node(text.clone())], &json!({"type": "code"})));
                }
                Inline::Br => out.push(json!({"type": "hardBreak"})),
                Inline::Image { .. } => out.push(self.image(&t.kind)),
                Inline::DocRef { page, section, label, page_id, target } => out.push(node(
                    "docRef",
                    Some(json!({"page": page, "section": section, "label": label, "pageId": page_id, "targetBlockId": target})),
                    None,
                )),
                Inline::Span { marks, tokens: c } => {
                    let mut inner = self.parse_inline(c);
                    for m in marks {
                        inner = apply_mark(inner, m);
                    }
                    out.extend(inner);
                }
                Inline::TicketRef(key) => out.push(node("ticketRef", Some(json!({"key": key})), None)),
                Inline::Math(latex) => out.push(node("mathInline", Some(json!({"latex": latex})), None)),
            }
            i += 1;
        }
        out
    }

    fn html_inline(&mut self, raw: &str) -> Vec<Value> {
        if trim(raw).is_empty() {
            return Vec::new();
        }
        if html::is_unrecognized(raw) {
            return html::literal(raw).map(|t| vec![text_node(t)]).unwrap_or_default();
        }
        html::parse_inline(raw)
    }
}

fn vec_or(v: Option<Value>) -> Vec<Value> {
    v.into_iter().collect()
}

/// A JSON number for a list start (an integer when it is one).
fn num(v: f64) -> Value {
    if v.fract() == 0.0 && v.abs() < 9.0e15 {
        Value::from(v as i64)
    } else {
        serde_json::Number::from_f64(v).map_or(Value::from(1), Value::Number)
    }
}

/// The opening tag name of an inline HTML token that is not closing or self-closing.
fn open_tag_name(raw: &str) -> Option<String> {
    let r = raw.strip_prefix('<')?;
    if r.trim_start().starts_with('/') || raw.ends_with("/>") {
        return None;
    }
    let r = r.trim_start_matches(crate::chars::is_space);
    let n = r.chars().take_while(|c| crate::chars::is_word(*c) || *c == '-').count();
    if n == 0 {
        return None;
    }
    let name: String = r.chars().take(n).collect();
    let after = r[name.len()..].chars().next();
    if after.is_none_or(|c| crate::chars::is_space(c) || c == '>' || c == '/') { Some(name) } else { None }
}

/// `^<\/\s*tag\b` (case-insensitive).
fn closes(raw: &str, tag: &str) -> bool {
    let Some(r) = raw.strip_prefix("</") else { return false };
    let r = r.trim_start_matches(crate::chars::is_space);
    if r.len() < tag.len() || !r.is_char_boundary(tag.len()) || !r[..tag.len()].eq_ignore_ascii_case(tag) {
        return false;
    }
    !r[tag.len()..].chars().next().is_some_and(crate::chars::is_word)
}

/// `applyMarkToContent`: the mark is added to every text node (inline atoms keep theirs).
fn apply_mark(content: Vec<Value>, mark: &Value) -> Vec<Value> {
    content
        .into_iter()
        .map(|mut n| {
            if n["type"] == "text" {
                if let Some(obj) = n.as_object_mut() {
                    let marks = obj.entry("marks").or_insert_with(|| Value::Array(Vec::new()));
                    if let Some(a) = marks.as_array_mut() {
                        a.push(mark.clone());
                    }
                }
            } else if let Some(c) = n.get_mut("content").and_then(Value::as_array_mut) {
                let inner = std::mem::take(c);
                *c = apply_mark(inner, mark);
            }
            n
        })
        .collect()
}

/// The DocImage extension's alt and width: `alt|640`, `alt | 640px`, `alt|width=640`.
fn image_alt_width(raw: &str) -> (String, Option<i64>) {
    // ^(.*?)\s*\|\s*(?:width=)?(\d+)(?:px)?(?:x\d+(?:px)?)?$  (case-insensitive)
    for (i, _) in raw.match_indices('|').rev() {
        let alt = crate::chars::trim_end(&raw[..i]);
        let rest = crate::chars::trim_start(&raw[i + 1..]);
        let lower = rest.to_ascii_lowercase();
        let rest_l = lower.strip_prefix("width=").unwrap_or(&lower);
        let d = rest_l.bytes().take_while(u8::is_ascii_digit).count();
        if d == 0 {
            continue;
        }
        let mut tail = &rest_l[d..];
        tail = tail.strip_prefix("px").unwrap_or(tail);
        if let Some(t) = tail.strip_prefix('x') {
            let d2 = t.bytes().take_while(u8::is_ascii_digit).count();
            if d2 > 0 {
                tail = &t[d2..];
                tail = tail.strip_prefix("px").unwrap_or(tail);
            }
        }
        if !tail.is_empty() {
            continue;
        }
        // the lazy alt takes the first `|` that works
        let first_ok = raw[..i].contains('|') && {
            let (a2, w2) = image_alt_width(&raw[..i].to_string().replace('|', "\u{0}"));
            let _ = (a2, w2);
            false
        };
        let _ = first_ok;
        let width = rest_l[..d].parse::<i64>().ok();
        return (alt.to_string(), width);
    }
    (raw.to_string(), None)
}

/// A task item rebuilt from a marked list item's source (`parseListToken`).
fn task_from_raw(raw: &str, checked: bool) -> TaskItem {
    let lines: Vec<&str> = raw.split('\n').collect();
    let first = lines[0];
    let main = task_main(first).unwrap_or_default();
    let mut nested = Vec::new();
    if lines.len() > 1 {
        let rest = &lines[1..];
        if !trim(&rest.join("\n")).is_empty() {
            let non_empty: Vec<&&str> = rest.iter().filter(|l| !trim(l).is_empty()).collect();
            if let Some(min) = non_empty
                .iter()
                .map(|l| crate::chars::js_len(l) - crate::chars::js_len(crate::chars::trim_start(l)))
                .min()
            {
                let lines2: Vec<String> = rest
                    .iter()
                    .map(|l| if trim(l).is_empty() { String::new() } else { l.chars().skip(min).collect() })
                    .collect();
                let content = trim(&lines2.join("\n")).to_string();
                if !content.is_empty() {
                    let mut lx = Lexer::new();
                    nested = lx.lex(&format!("{content}\n"));
                }
            }
        }
    }
    TaskItem { checked, text: main, nested, defs: usize::MAX }
}

/// `^\s*[-+*]\s+\[([ xX])\]\s+(.*)$`: the text after the checkbox.
fn task_main(line: &str) -> Option<String> {
    let t = crate::chars::trim_start(line);
    let mut cs = t.chars();
    cs.next().filter(|c| matches!(c, '-' | '+' | '*'))?;
    let r = cs.as_str();
    let ws = leading_space_count(r);
    if ws == 0 {
        return None;
    }
    let r: String = r.chars().skip(ws).collect();
    if r.len() < 3 || !r.starts_with('[') || !matches!(r.as_bytes()[1], b' ' | b'x' | b'X') || r.as_bytes()[2] != b']' {
        return None;
    }
    let after = &r[3..];
    let ws = leading_space_count(after);
    if ws == 0 {
        return None;
    }
    Some(after.chars().skip(ws).collect())
}

/// What ProseMirror does to the parsed JSON: marks in rank order (a stable sort), adjacent text with the same
/// marks joined, empty text dropped (recursively).
pub fn normalize_children(content: &mut Vec<Value>) {
    for n in content.iter_mut() {
        if let Some(obj) = n.as_object_mut() {
            if let Some(Value::Array(marks)) = obj.get_mut("marks") {
                // ProseMirror sorts marks by rank and keeps duplicates (`**a **b** c**` can give bold twice)
                marks.sort_by_key(|m| PM_MARK_RANK.iter().position(|r| m["type"] == *r).unwrap_or(usize::MAX));
                if marks.is_empty() {
                    obj.remove("marks");
                }
            }
            if let Some(Value::Array(c)) = obj.get_mut("content") {
                normalize_children(c);
            }
        }
    }
    content.retain(|n| n["type"] != "text" || n["text"].as_str().is_some_and(|t| !t.is_empty()));
    let mut out: Vec<Value> = Vec::with_capacity(content.len());
    for n in content.drain(..) {
        if n["type"] == "text" {
            if let Some(last) = out.last_mut() {
                if last["type"] == "text" && last.get("marks") == n.get("marks") {
                    let joined = format!("{}{}", last["text"].as_str().unwrap_or(""), n["text"].as_str().unwrap_or(""));
                    last["text"] = Value::String(joined);
                    continue;
                }
            }
        }
        out.push(n);
    }
    *content = out;
}
