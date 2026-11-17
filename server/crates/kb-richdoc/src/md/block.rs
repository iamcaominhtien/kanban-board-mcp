//! The block lexer: a port of marked 17's block tokenizer (GFM, no `breaks`) with the block tokenizers the Docs
//! editor registers (callout, drawings, math, task list, ordered list, table pipes in code spans).
//!
//! marked is regex based; each rule here is the same regular expression written as a scanner, so it stays linear
//! on hostile input. Nesting deeper than [`MAX_DEPTH`] is read as plain text instead of recursing further.

use std::collections::HashMap;

use super::token::{Block, List, ListItem, OrderedList, TaskItem};
use crate::chars::{is_space, is_word, rtrim_char, trim, trim_end};

/// How deep quotes, lists and callouts may nest before the rest is read as text.
pub const MAX_DEPTH: usize = 40;

/// The longest line the table start of a paragraph is looked for in (see `start_block`).
const MAX_CLIP_LINE: usize = 1000;

/// The HTML block tag names of marked's rule 6.
const BLOCK_TAGS: &[&str] = &[
    "address",
    "article",
    "aside",
    "base",
    "basefont",
    "blockquote",
    "body",
    "caption",
    "center",
    "col",
    "colgroup",
    "dd",
    "details",
    "dialog",
    "dir",
    "div",
    "dl",
    "dt",
    "fieldset",
    "figcaption",
    "figure",
    "footer",
    "form",
    "frame",
    "frameset",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "head",
    "header",
    "hr",
    "html",
    "iframe",
    "legend",
    "li",
    "link",
    "main",
    "menu",
    "menuitem",
    "meta",
    "nav",
    "noframes",
    "ol",
    "optgroup",
    "option",
    "p",
    "param",
    "search",
    "section",
    "summary",
    "table",
    "tbody",
    "td",
    "tfoot",
    "th",
    "thead",
    "title",
    "tr",
    "track",
    "ul",
];

/// Callout markers accepted on input, mapped to a kind (`CALLOUT_ALIASES` in the UI).
pub fn callout_alias(marker: &str) -> Option<&'static str> {
    Some(match marker.to_ascii_uppercase().as_str() {
        "INFO" | "IMPORTANT" => "info",
        "NOTE" => "note",
        "WARNING" | "WARN" | "CAUTION" => "warning",
        "DANGER" => "danger",
        "SUCCESS" | "OK" | "TIP" => "success",
        _ => return None,
    })
}

// ---------------------------------------------------------------- small scanners

fn line_end(s: &str, i: usize) -> usize {
    s[i..].find('\n').map_or(s.len(), |k| i + k)
}

fn first_line(s: &str) -> &str {
    &s[..line_end(s, 0)]
}

/// Number of leading spaces (not tabs) of `s`, at most `max`.
fn spaces(s: &str, max: usize) -> usize {
    s.bytes().take(max).take_while(|b| *b == b' ').count()
}

/// `^ {0,max}` followed by `rest`: returns the position after the spaces when `rest(s, pos)` holds for some
/// number of spaces (more spaces are tried first, as a greedy quantifier would).
fn indent_then(s: &str, max: usize, rest: impl Fn(&str) -> bool) -> bool {
    let n = spaces(s, max);
    (0..=n).rev().any(|k| rest(&s[k..]))
}

/// `[ \t]*(?:\n|$)` at the start of `s`: the length matched.
fn blank_line(s: &str) -> Option<usize> {
    let b = s.as_bytes();
    let mut j = 0;
    while j < b.len() && (b[j] == b' ' || b[j] == b'\t') {
        j += 1;
    }
    if j == b.len() {
        Some(j)
    } else if b[j] == b'\n' {
        Some(j + 1)
    } else {
        None
    }
}

/// `\n+|$` at the start of `s`: the length matched.
fn newlines_or_end(s: &str) -> Option<usize> {
    let n = s.bytes().take_while(|b| *b == b'\n').count();
    if n > 0 || s.is_empty() { Some(n) } else { None }
}

/// marked's `hr` rule: the length matched (newlines included).
fn hr_rule(s: &str) -> Option<usize> {
    let ind = spaces(s, 3);
    let rest = &s[ind..];
    let c = rest.chars().next()?;
    if !matches!(c, '-' | '_' | '*') {
        return None;
    }
    let b = rest.as_bytes();
    let mut j = 0;
    let mut count = 0;
    while j < b.len() {
        if b[j] as char == c {
            count += 1;
            j += 1;
        } else if b[j] == b' ' || b[j] == b'\t' {
            j += 1;
        } else {
            break;
        }
    }
    if count < 3 {
        return None;
    }
    let tail = newlines_or_end(&rest[j..])?;
    Some(ind + j + tail)
}

/// The list item's own hr check (`hrRegex(indent)`): ` {0,n}((?:- *){3,}|(?:_ *){3,}|(?:\* *){3,})(?:\n+|$)`.
fn hr_in_item(s: &str, n: usize) -> bool {
    indent_then(s, n, |rest| {
        let Some(c) = rest.chars().next() else { return false };
        if !matches!(c, '-' | '_' | '*') {
            return false;
        }
        let b = rest.as_bytes();
        let mut j = 0;
        let mut count = 0;
        // (?:c *){3,}: a tab is not allowed here
        while j < b.len() && b[j] as char == c {
            count += 1;
            j += 1;
            while j < b.len() && b[j] == b' ' {
                j += 1;
            }
        }
        count >= 3 && newlines_or_end(&rest[j..]).is_some()
    })
}

/// ` {0,3}#{1,6}(?:\s|$)`.
fn heading_start(s: &str) -> bool {
    let ind = spaces(s, 3);
    let rest = &s[ind..];
    let n = rest.bytes().take_while(|b| *b == b'#').count();
    if n == 0 || n > 6 {
        return false;
    }
    rest[n..].chars().next().is_none_or(is_space)
}

/// ` {0,3}>`.
fn blockquote_start(s: &str) -> bool {
    s[spaces(s, 3)..].starts_with('>')
}

/// ` {0,3}(?:[*+-]|1[.)])[ \t]` (lists that may interrupt a paragraph).
fn list_interrupt(s: &str) -> bool {
    let rest = &s[spaces(s, 3)..];
    let rest = if let Some(r) = rest.strip_prefix(['*', '+', '-']) {
        r
    } else if let Some(r) = rest.strip_prefix("1.").or_else(|| rest.strip_prefix("1)")) {
        r
    } else {
        return false;
    };
    rest.starts_with([' ', '\t'])
}

/// ` {0,3}(?:`{3,}(?=[^`\n]*\n)|~{3,})[^\n]*\n` (fences that may interrupt a paragraph or table).
fn fence_interrupt(s: &str) -> bool {
    let rest = &s[spaces(s, 3)..];
    let le = line_end(rest, 0);
    if le == rest.len() {
        return false;
    }
    let line = &rest[..le];
    if line.starts_with("```") {
        let run = line.bytes().take_while(|b| *b == b'`').count();
        !line[run..].contains('`')
    } else {
        line.starts_with("~~~")
    }
}

/// `</?(?:tag)(?: +|\n|/?>)|<(?:script|pre|style|textarea|!--)` (case-sensitive).
fn html_interrupt(s: &str) -> bool {
    if ["<script", "<pre", "<style", "<textarea", "<!--"].iter().any(|p| s.starts_with(p)) {
        return true;
    }
    block_tag_at(s, false)
}

/// `</?(tag)(?: +|\n|/?>)` at the start of `s`.
fn block_tag_at(s: &str, case_insensitive: bool) -> bool {
    let Some(rest) = s.strip_prefix('<') else { return false };
    let rest = rest.strip_prefix('/').unwrap_or(rest);
    let n = rest.bytes().take_while(|b| b.is_ascii_alphanumeric()).count();
    let name = &rest[..n];
    let known = if case_insensitive {
        BLOCK_TAGS.iter().any(|t| t.eq_ignore_ascii_case(name))
    } else {
        BLOCK_TAGS.contains(&name)
    };
    // a shorter tag name can match when the next character ends it: only whole names reach `(?: +|\n|/?>)`
    known && {
        let after = &rest[n..];
        after.starts_with([' ', '\n', '>']) || after.starts_with("/>")
    }
}

/// The GFM table align row, `(?:\| *)?:?-+:? *(?:\| *:?-+:? *)*(?:\| *)?`, ending the line: its length.
fn align_row(s: &str) -> Option<usize> {
    let b = s.as_bytes();
    let mut j = 0;
    let skip_sp = |j: &mut usize| {
        while *j < b.len() && b[*j] == b' ' {
            *j += 1;
        }
    };
    let cell = |j: &mut usize| -> bool {
        let start = *j;
        if *j < b.len() && b[*j] == b':' {
            *j += 1;
        }
        let d = *j;
        while *j < b.len() && b[*j] == b'-' {
            *j += 1;
        }
        if *j == d {
            *j = start;
            return false;
        }
        if *j < b.len() && b[*j] == b':' {
            *j += 1;
        }
        while *j < b.len() && b[*j] == b' ' {
            *j += 1;
        }
        true
    };
    if j < b.len() && b[j] == b'|' {
        j += 1;
        skip_sp(&mut j);
    }
    if !cell(&mut j) {
        return None;
    }
    loop {
        if j < b.len() && b[j] == b'|' {
            let save = j;
            j += 1;
            skip_sp(&mut j);
            if cell(&mut j) {
                continue;
            }
            // the trailing pipe
            let _ = save;
            break;
        }
        break;
    }
    if j == b.len() || b[j] == b'\n' { Some(j) } else { None }
}

/// The start of marked's GFM table: header line and align row (the rows may be empty). Returns the header line
/// length and the align row's span.
fn table_head(s: &str) -> Option<(usize, usize, usize)> {
    let le = line_end(s, 0);
    let header = &s[..le];
    let lead = spaces(header, usize::MAX);
    let first = header[lead..].chars().next()?;
    if first == ' ' || le == s.len() {
        return None;
    }
    let next = &s[le + 1..];
    let ind = spaces(next, 3);
    let len = align_row(&next[ind..])?;
    Some((le, le + 1 + ind, le + 1 + ind + len))
}

/// `(?: {4}| {0,3}\t)[^\n]` (indented code).
fn code_line_start(s: &str) -> Option<usize> {
    if s.starts_with("    ") {
        return Some(4);
    }
    let n = spaces(s, 3);
    if s[n..].starts_with('\t') {
        return Some(n + 1);
    }
    None
}

/// Whether a table row line is excluded (a blank line or the start of another block).
fn table_row_stop(s: &str) -> bool {
    let n = spaces(s, usize::MAX);
    if s[n..].starts_with('\n') {
        return true;
    }
    hr_rule(s).is_some()
        || heading_start(s)
        || blockquote_start(s)
        || code_line_start(s).is_some_and(|k| s[k..].chars().next().is_some_and(|c| c != '\n'))
        || fence_interrupt(s)
        || list_interrupt(s)
        || html_interrupt(s)
}

/// A paragraph continuation line is interrupted (GFM paragraph rule).
fn paragraph_interrupt(s: &str) -> bool {
    hr_rule(s).is_some()
        || heading_start(s)
        || table_head(s).is_some()
        || blockquote_start(s)
        || fence_interrupt(s)
        || list_interrupt(s)
        || html_interrupt(s)
        || {
            let n = s.bytes().take_while(|b| *b == b' ').count();
            n > 0 && s[n..].starts_with('\n')
        }
}

/// The same without the table (the paragraph inside a blockquote line).
fn paragraph_interrupt_no_table(s: &str) -> bool {
    hr_rule(s).is_some()
        || heading_start(s)
        || blockquote_start(s)
        || fence_interrupt(s)
        || list_interrupt(s)
        || html_interrupt(s)
        || {
            let n = s.bytes().take_while(|b| *b == b' ').count();
            n > 0 && s[n..].starts_with('\n')
        }
}

/// `^([^\n]+(?:\n(?!interrupt)[^\n]+)*)`: the length of the paragraph text.
fn paragraph_len(s: &str, interrupt: fn(&str) -> bool) -> Option<usize> {
    let mut end = line_end(s, 0);
    if end == 0 {
        return None;
    }
    while end < s.len() {
        let next = &s[end + 1..];
        let le = line_end(next, 0);
        if le == 0 || interrupt(next) {
            break;
        }
        end += 1 + le;
    }
    Some(end)
}

fn expand_tabs(line: &str, indent: usize) -> String {
    let mut col = indent;
    let mut out = String::with_capacity(line.len());
    for c in line.chars() {
        if c == '\t' {
            let added = 4 - (col % 4);
            out.extend(std::iter::repeat_n(' ', added));
            col += added;
        } else {
            out.push(c);
            col += 1;
        }
    }
    out
}

/// `search(/[^ ]/)`: the index of the first character that is not a space, in UTF-16 units (-1 for none).
fn first_non_space(s: &str) -> isize {
    match s.char_indices().find(|(_, c)| *c != ' ') {
        Some((i, _)) => crate::chars::js_len(&s[..i]) as isize,
        None => -1,
    }
}

/// `str.slice(n)` with `n` in UTF-16 units (clamped).
fn js_slice_from(s: &str, n: usize) -> &str {
    let mut units = 0;
    for (i, c) in s.char_indices() {
        if units >= n {
            return &s[i..];
        }
        units += c.len_utf16();
    }
    ""
}

/// marked's `splitCells`.
pub fn split_cells(row: &str, count: Option<usize>) -> Vec<String> {
    // put a space before every unescaped pipe, then split on " |"
    let chars: Vec<char> = row.chars().collect();
    let mut spaced = String::with_capacity(row.len() + 8);
    for (i, c) in chars.iter().enumerate() {
        if *c == '|' {
            let mut escaped = false;
            let mut k = i;
            while k > 0 && chars[k - 1] == '\\' {
                escaped = !escaped;
                k -= 1;
            }
            if !escaped {
                spaced.push(' ');
            }
        }
        spaced.push(*c);
    }
    let mut cells: Vec<String> = spaced.split(" |").map(str::to_string).collect();
    if cells.first().is_some_and(|c| trim(c).is_empty()) {
        cells.remove(0);
    }
    if cells.last().is_some_and(|c| trim(c).is_empty()) {
        cells.pop();
    }
    if let Some(n) = count {
        if cells.len() > n {
            cells.truncate(n);
        } else {
            while cells.len() < n {
                cells.push(String::new());
            }
        }
    }
    cells.iter().map(|c| trim(c).replace("\\|", "|")).collect()
}

/// Removes a backslash before ASCII punctuation (`replace(anyPunctuation, '$1')`).
pub fn unescape_punct(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut it = s.chars().peekable();
    while let Some(c) = it.next() {
        if c == '\\' {
            if let Some(&n) = it.peek() {
                if crate::chars::is_punct(n) {
                    out.push(n);
                    it.next();
                    continue;
                }
            }
        }
        out.push(c);
    }
    out
}

/// The lines of a source, split as they are asked for (tokenizers that look a few lines ahead stay linear).
struct LazyLines<'a> {
    rest: &'a str,
    lines: Vec<&'a str>,
    done: bool,
    /// The last answer of `next_non_blank`: (asked from, found).
    cache: Option<(usize, Option<usize>)>,
}

impl<'a> LazyLines<'a> {
    fn new(src: &'a str) -> Self {
        LazyLines { rest: src, lines: Vec::new(), done: false, cache: None }
    }

    fn get(&mut self, i: usize) -> Option<&'a str> {
        while self.lines.len() <= i && !self.done {
            match self.rest.find('\n') {
                Some(k) => {
                    self.lines.push(&self.rest[..k]);
                    self.rest = &self.rest[k + 1..];
                }
                None => {
                    self.lines.push(self.rest);
                    self.done = true;
                }
            }
        }
        self.lines.get(i).copied()
    }

    /// The first line at or after `from` that is not blank.
    fn next_non_blank(&mut self, from: usize) -> Option<usize> {
        if let Some((f, found)) = self.cache {
            if f <= from && found.is_none_or(|x| x >= from) {
                return found;
            }
        }
        let mut k = from;
        let found = loop {
            match self.get(k) {
                None => break None,
                Some(l) if !trim(l).is_empty() => break Some(k),
                Some(_) => k += 1,
            }
        };
        self.cache = Some((from, found));
        found
    }
}

// ---------------------------------------------------------------- the lexer

/// marked's lexer state for one document.
pub struct Lexer {
    /// Paragraphs are only read at the top of a block context (marked's `state.top`).
    pub top: bool,
    /// Link reference definitions: label → (href, title).
    pub links: HashMap<String, (String, Option<String>, usize)>,
    depth: usize,
}

impl Default for Lexer {
    fn default() -> Self {
        Self::new()
    }
}

impl Lexer {
    /// A lexer for a new document.
    pub fn new() -> Self {
        Lexer { top: true, links: HashMap::new(), depth: 0 }
    }

    /// Reads a whole document.
    pub fn lex(&mut self, src: &str) -> Vec<Block> {
        let src = src.replace("\r\n", "\n").replace('\r', "\n");
        let mut tokens = Vec::new();
        self.block_tokens(&src, &mut tokens, false);
        tokens
    }

    /// marked's `blockTokens`.
    pub fn block_tokens(&mut self, src: &str, tokens: &mut Vec<Block>, mut last_paragraph_clipped: bool) {
        if self.depth >= MAX_DEPTH {
            if !src.is_empty() {
                tokens.push(Block::Paragraph { raw: src.to_string(), text: src.to_string() });
            }
            self.top = true;
            return;
        }
        self.depth += 1;
        let mut src = src;
        while !src.is_empty() {
            if let Some(tok) = self.extension_block(src) {
                let n = tok.raw().len().min(src.len());
                src = &src[n..];
                tokens.push(tok);
                continue;
            }
            // space
            if let Some(n) = space_rule(src) {
                let raw = &src[..n];
                src = &src[n..];
                if n == 1 && !tokens.is_empty() {
                    if let Some(last) = tokens.last_mut() {
                        last.raw_mut().push('\n');
                    }
                } else {
                    tokens.push(Block::Space { raw: raw.to_string() });
                }
                continue;
            }
            // indented code
            if let Some(n) = indented_code(src) {
                let raw = &src[..n];
                src = &src[n..];
                let text = strip_code_indent(raw);
                let text = rtrim_char(&text, '\n').to_string();
                match tokens.last_mut() {
                    Some(Block::Paragraph { raw: lraw, text: ltext } | Block::Text { raw: lraw, text: ltext }) => {
                        if !lraw.ends_with('\n') {
                            lraw.push('\n');
                        }
                        lraw.push_str(raw);
                        ltext.push('\n');
                        ltext.push_str(&text);
                    }
                    _ => tokens.push(Block::Code {
                        raw: raw.to_string(),
                        text,
                        lang: None,
                        indented: true,
                        fenced_at_col0: false,
                    }),
                }
                continue;
            }
            if let Some(tok) = fences(src) {
                src = &src[tok.raw().len()..];
                tokens.push(tok);
                continue;
            }
            if let Some(tok) = heading(src) {
                src = &src[tok.raw().len()..];
                tokens.push(tok);
                continue;
            }
            if let Some(n) = hr_rule(src) {
                let raw = rtrim_char(&src[..n], '\n').to_string();
                src = &src[n..];
                tokens.push(Block::Hr { raw });
                continue;
            }
            if let Some(tok) = self.blockquote(src) {
                src = &src[tok.raw().len().min(src.len())..];
                tokens.push(tok);
                continue;
            }
            if let Some(tok) = self.list(src) {
                src = &src[tok.raw().len().min(src.len())..];
                tokens.push(tok);
                continue;
            }
            if let Some(n) = html_block(src) {
                tokens.push(Block::Html { raw: src[..n].to_string() });
                src = &src[n..];
                continue;
            }
            if let Some((n, tag, href, title)) = def_rule(src) {
                let raw = src[..n].to_string();
                src = &src[n..];
                match tokens.last_mut() {
                    Some(Block::Paragraph { raw: lraw, text: ltext } | Block::Text { raw: lraw, text: ltext }) => {
                        if !lraw.ends_with('\n') {
                            lraw.push('\n');
                        }
                        lraw.push_str(&raw);
                        ltext.push('\n');
                        ltext.push_str(&raw);
                    }
                    _ => {
                        let order = self.links.len();
                        if let std::collections::hash_map::Entry::Vacant(e) = self.links.entry(tag) {
                            e.insert((href, title, order));
                            tokens.push(Block::Def { raw });
                        }
                    }
                }
                continue;
            }
            if let Some(tok) = gfm_table(src) {
                src = &src[tok.raw().len()..];
                tokens.push(tok);
                continue;
            }
            if let Some(tok) = lheading(src) {
                src = &src[tok.raw().len()..];
                tokens.push(tok);
                continue;
            }
            // paragraph, clipped where a block extension could start
            let cut = start_block(src).map_or(src, |i| &src[..i]);
            if self.top {
                if let Some(n) = paragraph_len(cut, paragraph_interrupt) {
                    let raw = &cut[..n];
                    let text = raw.strip_suffix('\n').unwrap_or(raw);
                    match tokens.last_mut() {
                        Some(Block::Paragraph { raw: lraw, text: ltext }) if last_paragraph_clipped => {
                            if !lraw.ends_with('\n') {
                                lraw.push('\n');
                            }
                            lraw.push_str(raw);
                            ltext.push('\n');
                            ltext.push_str(text);
                        }
                        _ => tokens.push(Block::Paragraph { raw: raw.to_string(), text: text.to_string() }),
                    }
                    last_paragraph_clipped = cut.len() != src.len();
                    src = &src[n..];
                    continue;
                }
            }
            // text
            let n = line_end(src, 0);
            if n > 0 {
                let raw = &src[..n];
                match tokens.last_mut() {
                    Some(Block::Text { raw: lraw, text: ltext }) => {
                        if !lraw.ends_with('\n') {
                            lraw.push('\n');
                        }
                        lraw.push_str(raw);
                        ltext.push('\n');
                        ltext.push_str(raw);
                    }
                    _ => tokens.push(Block::Text { raw: raw.to_string(), text: raw.to_string() }),
                }
                src = &src[n..];
                continue;
            }
            // cannot happen (a "\n" is a space token); stop rather than loop
            break;
        }
        self.depth -= 1;
        self.top = true;
    }

    /// The editor's block tokenizers, in the order marked tries them.
    fn extension_block(&mut self, src: &str) -> Option<Block> {
        if let Some(t) = math_block(src) {
            return Some(t);
        }
        if let Some(t) = self.callout(src) {
            return Some(t);
        }
        if let Some(t) = drawing(src) {
            return Some(t);
        }
        if let Some(t) = self.table_pipes(src) {
            return Some(t);
        }
        if let Some(t) = self.task_list(src) {
            return Some(t);
        }
        if let Some(t) = self.ordered_list(src) {
            return Some(t);
        }
        None
    }

    /// The Callout extension's tokenizer.
    fn callout(&mut self, src: &str) -> Option<Block> {
        if self.depth >= MAX_DEPTH {
            return None;
        }
        let ind = spaces(src, 3);
        let rest = src[ind..].strip_prefix('>')?;
        let rest = rest.strip_prefix([' ', '\t']).unwrap_or(rest);
        let rest = rest.strip_prefix("[!")?;
        let n = rest.bytes().take_while(|b| is_word(*b as char)).count();
        if n == 0 {
            return None;
        }
        let marker = &rest[..n];
        let rest = rest[n..].strip_prefix(']')?;
        let kind = callout_alias(marker)?;
        let ws = rest.bytes().take_while(|b| *b == b' ' || *b == b'\t').count();
        let rest = &rest[ws..];
        let le = line_end(rest, 0);
        let title = &rest[..le];
        let mut pos = src.len() - rest.len() + le;
        if pos < src.len() {
            pos += 1;
        }
        let body_start = pos;
        // (?: {0,3}>[^\n]*(?:\n|$))*
        loop {
            if pos >= src.len() {
                break;
            }
            let line = &src[pos..];
            if !blockquote_start(line) {
                break;
            }
            let le = line_end(line, 0);
            pos += le;
            if pos < src.len() {
                pos += 1;
            } else {
                break;
            }
        }
        let body = src[body_start..pos]
            .split('\n')
            .map(|l| {
                let k = spaces(l, 3);
                match l[k..].strip_prefix('>') {
                    Some(r) => r.strip_prefix(' ').unwrap_or(r),
                    None => l,
                }
            })
            .collect::<Vec<_>>()
            .join("\n");
        let body = trim_end(&body);
        let inner: Vec<&str> = [title, body].into_iter().filter(|x| !x.is_empty()).collect();
        let inner = inner.join("\n");
        let mut tokens = Vec::new();
        self.block_tokens(&inner, &mut tokens, false);
        Some(Block::Callout { raw: src[..pos].to_string(), kind, tokens })
    }

    /// The table extension: re-reads a table whose code spans hold pipes, with those pipes escaped.
    fn table_pipes(&mut self, src: &str) -> Option<Block> {
        // cheap checks first: a separator as second line (the editor's own check), then a backtick in the table
        let le0 = line_end(src, 0);
        if le0 >= src.len() {
            return None;
        }
        if !is_table_sep(&src[le0 + 1..line_end(src, le0 + 1)]) {
            return None;
        }
        let candidate = src.find("\n\n").map_or(src, |i| &src[..i]);
        if !candidate.contains('`') {
            return None;
        }
        let lines: Vec<&str> = candidate.split('\n').collect();
        if lines.len() < 2 || !is_table_sep(lines[1]) {
            return None;
        }
        let pre = preprocess_table_pipes(candidate);
        if pre == candidate {
            return None;
        }
        let mut sub = Lexer { top: self.top, links: HashMap::new(), depth: self.depth };
        let mut toks = Vec::new();
        sub.block_tokens(&pre, &mut toks, false);
        // the editor runs this on the same lexer, whose blockTokens leaves `top` set
        self.top = true;
        let Some(Block::Table { raw, align, header, rows }) = toks.into_iter().next() else {
            return None;
        };
        if raw.is_empty() {
            return None;
        }
        let count = raw.split('\n').count();
        let raw = src.split('\n').take(count).collect::<Vec<_>>().join("\n");
        Some(Block::Table { raw, align, header, rows })
    }

    /// The TaskList extension's tokenizer (`parseIndentedBlocks`).
    fn task_list(&mut self, src: &str) -> Option<Block> {
        if self.depth >= MAX_DEPTH {
            return None;
        }
        let (items, raw) = self.parse_task_blocks(src)?;
        Some(Block::TaskList { raw, items })
    }

    fn parse_task_blocks(&mut self, src: &str) -> Option<(Vec<TaskItem>, String)> {
        let mut lines = LazyLines::new(src);
        let mut items = Vec::new();
        let mut total_raw = String::new();
        let mut i = 0;
        while let Some(line) = lines.get(i) {
            let Some((indent, checked, main)) = task_item_line(line) else {
                if !items.is_empty() {
                    break;
                } else if trim(line).is_empty() {
                    i += 1;
                    total_raw.push_str(line);
                    total_raw.push('\n');
                    continue;
                } else {
                    return None;
                }
            };
            total_raw.push_str(line);
            total_raw.push('\n');
            let mut content: Vec<&str> = Vec::new();
            i += 1;
            while let Some(next) = lines.get(i) {
                if trim(next).is_empty() {
                    let Some(k) = lines.next_non_blank(i + 1) else { break };
                    let nn = lines.get(k).unwrap_or("");
                    if crate::chars::leading_space_count(nn) > indent {
                        content.push(next);
                        total_raw.push_str(next);
                        total_raw.push('\n');
                        i += 1;
                        continue;
                    }
                    break;
                }
                if crate::chars::leading_space_count(next) > indent {
                    content.push(next);
                    total_raw.push_str(next);
                    total_raw.push('\n');
                    i += 1;
                } else {
                    break;
                }
            }
            let mut nested = Vec::new();
            if !content.is_empty() {
                let dedented = content.iter().map(|l| js_slice_from(l, indent + 2)).collect::<Vec<_>>().join("\n");
                if !trim(&dedented).is_empty() {
                    nested = self.task_nested(&dedented);
                }
            }
            items.push(TaskItem { checked, text: main.to_string(), nested, defs: self.links.len() });
        }
        if items.is_empty() {
            return None;
        }
        Some((items, total_raw))
    }

    /// `parseTaskListContent`: a nested task list and what follows it, or plain blocks.
    fn task_nested(&mut self, content: &str) -> Vec<Block> {
        if self.depth < MAX_DEPTH {
            self.depth += 1;
            let parsed = self.parse_task_blocks(content);
            self.depth -= 1;
            if let Some((items, raw)) = parsed {
                let mut out = vec![Block::TaskList { raw: raw.clone(), items }];
                let remainder = js_slice_from(content, crate::chars::js_len(&raw));
                if !trim(remainder).is_empty() {
                    let mut more = Vec::new();
                    self.block_tokens(remainder, &mut more, false);
                    out.extend(more);
                }
                return out;
            }
        }
        let mut out = Vec::new();
        self.block_tokens(content, &mut out, false);
        out
    }

    /// The OrderedList extension's tokenizer.
    fn ordered_list(&mut self, src: &str) -> Option<Block> {
        if self.depth >= MAX_DEPTH {
            return None;
        }
        let first = first_line(src);
        ordered_item_line(first)?;
        let mut lines = LazyLines::new(src);
        let (items, consumed) = collect_ordered_items(&mut lines);
        if items.is_empty() {
            return None;
        }
        let base = items[0].indent;
        let built = self.build_nested(&items, base);
        if built.is_empty() {
            return None;
        }
        Some(Block::OrderedList(OrderedList {
            raw: lines.lines[..consumed.min(lines.lines.len())].join("\n"),
            start: items[0].number,
            type_marker: items[0].type_marker.clone(),
            items: built,
        }))
    }

    /// `buildNestedStructure`.
    fn build_nested(&mut self, items: &[OlItem], base: usize) -> Vec<Vec<Block>> {
        let mut result = Vec::new();
        let mut i = 0;
        while i < items.len() {
            let item = &items[i];
            if item.indent != base {
                i += 1;
                continue;
            }
            let (para, block) = split_item_content(&item.content_lines);
            let main = trim(&para.join("\n")).to_string();
            let mut tokens = Vec::new();
            if !main.is_empty() {
                tokens.push(Block::EarlyParagraph { raw: main.clone(), text: main, defs: self.links.len() });
            }
            let additional = block.join("\n");
            let additional = trim(&additional);
            if !additional.is_empty() {
                let mut more = Vec::new();
                self.block_tokens(additional, &mut more, false);
                tokens.extend(more);
            }
            let mut j = i + 1;
            while j < items.len() && items[j].indent > base {
                j += 1;
            }
            let nested = &items[i + 1..j];
            if !nested.is_empty() {
                let next = nested.iter().map(|n| n.indent).min().unwrap_or(base);
                let sub = if self.depth < MAX_DEPTH {
                    self.depth += 1;
                    let s = self.build_nested(nested, next);
                    self.depth -= 1;
                    s
                } else {
                    Vec::new()
                };
                tokens.push(Block::OrderedList(OrderedList {
                    raw: nested.iter().map(|n| n.raw.as_str()).collect::<Vec<_>>().join("\n"),
                    start: nested[0].number,
                    type_marker: nested[0].type_marker.clone(),
                    items: sub,
                }));
            }
            result.push(tokens);
            i = j;
        }
        result
    }

    /// marked's blockquote tokenizer.
    fn blockquote(&mut self, src: &str) -> Option<Block> {
        if self.depth >= MAX_DEPTH {
            return None;
        }
        let n = blockquote_rule(src)?;
        let cap = rtrim_char(&src[..n], '\n');
        let mut lines: Vec<&str> = cap.split('\n').collect();
        let mut raw = String::new();
        let mut tokens: Vec<Block> = Vec::new();
        while !lines.is_empty() {
            let mut in_quote = false;
            let mut current = Vec::new();
            let mut i = 0;
            while i < lines.len() {
                if blockquote_start(lines[i]) {
                    current.push(lines[i]);
                    in_quote = true;
                } else if !in_quote {
                    current.push(lines[i]);
                } else {
                    break;
                }
                i += 1;
            }
            lines.drain(..i);
            let current_raw = current.join("\n");
            let current_text = strip_quote_markers(&setext_guard(&current_raw));
            if raw.is_empty() {
                raw = current_raw;
            } else {
                raw.push('\n');
                raw.push_str(&current_raw);
            }
            let top = self.top;
            self.top = true;
            self.block_tokens(&current_text, &mut tokens, true);
            self.top = top;
            if lines.is_empty() {
                break;
            }
            match tokens.last() {
                Some(Block::Code { .. }) => break,
                Some(Block::Blockquote { raw: old, .. }) => {
                    let old_len = old.len();
                    let new_text = format!("{}\n{}", old, lines.join("\n"));
                    if let Some(new_tok) = self.blockquote(&new_text) {
                        raw.truncate(raw.len().saturating_sub(old_len));
                        raw.push_str(new_tok.raw());
                        let last = tokens.len() - 1;
                        tokens[last] = new_tok;
                    }
                    break;
                }
                Some(Block::List(old)) => {
                    let old_raw = old.raw.clone();
                    let new_text = format!("{}\n{}", old_raw, lines.join("\n"));
                    let Some(new_tok) = self.list(&new_text) else { break };
                    raw.truncate(raw.len().saturating_sub(old_raw.len()));
                    raw.push_str(new_tok.raw());
                    let rest = new_text[new_tok.raw().len().min(new_text.len())..].to_string();
                    let last = tokens.len() - 1;
                    tokens[last] = new_tok;
                    // the remaining lines are read again
                    let rest_lines: Vec<String> = rest.split('\n').map(str::to_string).collect();
                    return Some(self.blockquote_rest(raw, tokens, rest_lines));
                }
                _ => {}
            }
        }
        Some(Block::Blockquote { raw, tokens })
    }

    /// The rest of a blockquote after a list swallowed continuation lines (owned lines).
    fn blockquote_rest(&mut self, mut raw: String, mut tokens: Vec<Block>, mut lines: Vec<String>) -> Block {
        while !lines.is_empty() {
            let mut in_quote = false;
            let mut current: Vec<String> = Vec::new();
            let mut i = 0;
            while i < lines.len() {
                if blockquote_start(&lines[i]) {
                    current.push(lines[i].clone());
                    in_quote = true;
                } else if !in_quote {
                    current.push(lines[i].clone());
                } else {
                    break;
                }
                i += 1;
            }
            lines.drain(..i);
            let current_raw = current.join("\n");
            let current_text = strip_quote_markers(&setext_guard(&current_raw));
            if raw.is_empty() {
                raw = current_raw;
            } else {
                raw.push('\n');
                raw.push_str(&current_raw);
            }
            let top = self.top;
            self.top = true;
            self.block_tokens(&current_text, &mut tokens, true);
            self.top = top;
            if lines.is_empty() {
                break;
            }
            match tokens.last() {
                Some(Block::Code { .. }) => break,
                Some(Block::Blockquote { raw: old, .. }) => {
                    let old_len = old.len();
                    let new_text = format!("{}\n{}", old, lines.join("\n"));
                    if let Some(new_tok) = self.blockquote(&new_text) {
                        raw.truncate(raw.len().saturating_sub(old_len));
                        raw.push_str(new_tok.raw());
                        let last = tokens.len() - 1;
                        tokens[last] = new_tok;
                    }
                    break;
                }
                Some(Block::List(old)) => {
                    let old_raw = old.raw.clone();
                    let new_text = format!("{}\n{}", old_raw, lines.join("\n"));
                    let Some(new_tok) = self.list(&new_text) else { break };
                    raw.truncate(raw.len().saturating_sub(old_raw.len()));
                    raw.push_str(new_tok.raw());
                    let rest = new_text[new_tok.raw().len().min(new_text.len())..].to_string();
                    let last = tokens.len() - 1;
                    tokens[last] = new_tok;
                    lines = rest.split('\n').map(str::to_string).collect();
                }
                _ => {}
            }
        }
        Block::Blockquote { raw, tokens }
    }

    /// marked's list tokenizer.
    fn list(&mut self, src: &str) -> Option<Block> {
        if self.depth >= MAX_DEPTH {
            return None;
        }
        let (bull_len, bull) = list_start(src)?;
        let _ = bull_len;
        let ordered = bull.len() > 1;
        let start = if ordered { bull[..bull.len() - 1].parse::<f64>().unwrap_or(1.0) } else { 1.0 };
        let delim = bull.chars().last().unwrap_or('-');
        let mut items: Vec<ListItem> = Vec::new();
        let mut list_raw = String::new();
        let mut loose = false;
        let mut ends_with_blank = false;
        let mut src = src;
        while !src.is_empty() {
            let Some((cap1_len, cap0_len)) = list_item_start(src, ordered, delim) else { break };
            if hr_rule(src).is_some() {
                break;
            }
            let mut raw = src[..cap0_len].to_string();
            let cap2 = &src[cap1_len..cap0_len];
            src = &src[cap0_len..];
            let mut line = expand_tabs(first_line(cap2), cap1_len);
            let mut next_line = first_line(src).to_string();
            let mut blank = trim(&line).is_empty();
            let mut item_contents;
            let indent;
            if blank {
                indent = cap1_len + 1;
                item_contents = String::new();
            } else {
                let mut ind = first_non_space(&line).max(0) as usize;
                if ind > 4 {
                    ind = 1;
                }
                item_contents = js_slice_from(&line, ind).to_string();
                indent = ind + cap1_len;
            }
            let mut end_early = false;
            if blank && blank_line(&next_line).is_some_and(|n| n == next_line.len()) {
                raw.push_str(&next_line);
                raw.push('\n');
                src = &src[(next_line.len() + 1).min(src.len())..];
                end_early = true;
            }
            if !end_early {
                let n = 3.min(indent.saturating_sub(1));
                while !src.is_empty() {
                    let raw_line = first_line(src);
                    next_line = raw_line.to_string();
                    let without_tabs = raw_line.replace('\t', "    ");
                    if item_break(&next_line, n) {
                        break;
                    }
                    if first_non_space(&without_tabs) >= indent as isize || trim(&next_line).is_empty() {
                        item_contents.push('\n');
                        item_contents.push_str(js_slice_from(&without_tabs, indent));
                    } else {
                        if blank {
                            break;
                        }
                        if first_non_space(&line.replace('\t', "    ")) >= 4 {
                            break;
                        }
                        if fence_begin(&line, n) || heading_begin(&line, n) || hr_in_item(&line, n) {
                            break;
                        }
                        item_contents.push('\n');
                        item_contents.push_str(&next_line);
                    }
                    blank = trim(&next_line).is_empty();
                    raw.push_str(raw_line);
                    raw.push('\n');
                    src = &src[(raw_line.len() + 1).min(src.len())..];
                    line = js_slice_from(&without_tabs, indent).to_string();
                }
            }
            if !loose {
                if ends_with_blank {
                    loose = true;
                } else if double_blank_end(&raw) {
                    ends_with_blank = true;
                }
            }
            list_raw.push_str(&raw);
            items.push(ListItem { raw, text: item_contents, tokens: Vec::new() });
        }
        let last = items.last_mut()?;
        last.raw = trim_end(&last.raw).to_string();
        last.text = trim_end(&last.text).to_string();
        let list_raw = trim_end(&list_raw).to_string();
        for item in &mut items {
            self.top = false;
            let mut toks = Vec::new();
            self.block_tokens(&item.text, &mut toks, false);
            let task = is_marked_task(&item.text);
            if task {
                item.text = strip_task(&item.text).to_string();
                if let Some(Block::Text { raw, text } | Block::Paragraph { raw, text }) = toks.first_mut() {
                    *raw = strip_task(raw).to_string();
                    *text = strip_task(text).to_string();
                }
            }
            if !loose {
                loose = toks.iter().any(|t| match t {
                    Block::Space { raw } => any_line(raw),
                    _ => false,
                });
            }
            item.tokens = toks;
        }
        if loose {
            for item in &mut items {
                for t in &mut item.tokens {
                    if let Block::Text { raw, text } = t {
                        *t = Block::Paragraph { raw: std::mem::take(raw), text: std::mem::take(text) };
                    }
                }
            }
        }
        Some(Block::List(List { raw: list_raw, ordered, start, items }))
    }
}

// ---------------------------------------------------------------- block rules

fn space_rule(src: &str) -> Option<usize> {
    let mut i = 0;
    while let Some(n) = blank_line(&src[i..]) {
        if n == 0 {
            break;
        }
        let ended = !src[i..i + n].ends_with('\n');
        i += n;
        if ended {
            break;
        }
    }
    if i > 0 { Some(i) } else { None }
}

fn indented_code(src: &str) -> Option<usize> {
    let mut i = 0;
    loop {
        let rest = &src[i..];
        let Some(k) = code_line_start(rest) else { break };
        let le = line_end(rest, 0);
        if le <= k {
            break;
        }
        i += le;
        if i < src.len() {
            // \n then blank lines
            i += 1;
            while i <= src.len() {
                match blank_line(&src[i..]) {
                    Some(n) if n > 0 && src[i..i + n].ends_with('\n') => i += n,
                    Some(n) => {
                        i += n;
                        break;
                    }
                    None => break,
                }
            }
        }
        if i >= src.len() {
            break;
        }
    }
    if i > 0 { Some(i) } else { None }
}

fn strip_code_indent(raw: &str) -> String {
    raw.split('\n')
        .map(|l| {
            let n = spaces(l, 4);
            if n >= 1 {
                &l[n..]
            } else {
                let m = spaces(l, 3);
                if l[m..].starts_with('\t') { &l[m + 1..] } else { l }
            }
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// marked's `fences` rule.
fn fences(src: &str) -> Option<Block> {
    let ind = spaces(src, 3);
    let rest = &src[ind..];
    let ch = rest.chars().next()?;
    if ch != '`' && ch != '~' {
        return None;
    }
    let run = rest.bytes().take_while(|b| *b as char == ch).count();
    if run < 3 {
        return None;
    }
    let fence = &rest[..run];
    let le = line_end(rest, 0);
    let info = &rest[run..le];
    if ch == '`' && info.contains('`') {
        return None;
    }
    let mut body_start = ind + le;
    if body_start < src.len() {
        body_start += 1;
    }
    // closing fence at `pos` (a line start): ` {0,3}fence[~`]* *(?=\n|$)`, returns its end
    let closing = |pos: usize| -> Option<usize> {
        let line = &src[pos..];
        let k = spaces(line, 3);
        let l = &line[k..];
        let l2 = l.strip_prefix(fence)?;
        let extra = l2.bytes().take_while(|b| *b == b'~' || *b == b'`').count();
        let sp = l2[extra..].bytes().take_while(|b| *b == b' ').count();
        let after = &l2[extra + sp..];
        if after.is_empty() || after.starts_with('\n') { Some(pos + k + fence.len() + extra + sp) } else { None }
    };
    let (text, end) = if body_start >= src.len() {
        (String::new(), src.len())
    } else if let Some(e) = closing(body_start) {
        (String::new(), e)
    } else {
        let mut p = body_start;
        loop {
            match src[p..].find('\n') {
                Some(k) => {
                    let nl = p + k;
                    if nl + 1 >= src.len() {
                        // "\n" then end: `$` closes
                        break (src[body_start..nl].to_string(), src.len());
                    }
                    if let Some(e) = closing(nl + 1) {
                        break (src[body_start..nl].to_string(), e);
                    }
                    p = nl + 1;
                }
                None => break (src[body_start..].to_string(), src.len()),
            }
        }
    };
    let raw = &src[..end];
    let text = indent_compensation(raw, &text);
    let lang = trim(info);
    let lang = if info.is_empty() { None } else { Some(unescape_punct(lang)) };
    Some(Block::Code {
        raw: raw.to_string(),
        text,
        lang,
        indented: false,
        fenced_at_col0: raw.starts_with("```") || raw.starts_with("~~~"),
    })
}

fn indent_compensation(raw: &str, text: &str) -> String {
    let ws = crate::chars::leading_space_count(raw);
    if ws == 0 {
        return text.to_string();
    }
    let lead: String = raw.chars().take(ws).collect();
    if !raw[lead.len()..].starts_with("```") {
        return text.to_string();
    }
    let n = crate::chars::js_len(&lead);
    text.split('\n')
        .map(|node| {
            let k = crate::chars::leading_space_count(node);
            if k == 0 {
                return node;
            }
            let lead_in: String = node.chars().take(k).collect();
            if crate::chars::js_len(&lead_in) >= n { js_slice_from(node, n) } else { node }
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn heading(src: &str) -> Option<Block> {
    let ind = spaces(src, 3);
    let rest = &src[ind..];
    let n = rest.bytes().take_while(|b| *b == b'#').count();
    if n == 0 || n > 6 {
        return None;
    }
    let after = &rest[n..];
    if !after.chars().next().is_none_or(is_space) {
        return None;
    }
    let le = line_end(after, 0);
    let line = &after[..le];
    let tail = after[le..].bytes().take_while(|b| *b == b'\n').count();
    let raw_len = ind + n + le + tail;
    let mut text = trim(line).to_string();
    if text.ends_with('#') {
        let trimmed = rtrim_char(&text, '#');
        if trimmed.is_empty() || trimmed.ends_with(' ') {
            text = trim(trimmed).to_string();
        }
    }
    Some(Block::Heading { raw: src[..raw_len].to_string(), depth: n as u8, text })
}

/// `^( {0,3}> ?(paragraph|[^\n]*)(?:\n|$))+`: the length.
fn blockquote_rule(src: &str) -> Option<usize> {
    let mut i = 0;
    while i < src.len() {
        let line = &src[i..];
        let k = spaces(line, 3);
        let Some(after) = line[k..].strip_prefix('>') else { break };
        let after = after.strip_prefix(' ').unwrap_or(after);
        let off = line.len() - after.len();
        let len = paragraph_len(after, paragraph_interrupt_no_table).unwrap_or_else(|| line_end(after, 0));
        i += off + len;
        if i < src.len() {
            if src.as_bytes()[i] == b'\n' {
                i += 1;
            } else {
                break;
            }
        }
    }
    if i > 0 { Some(i) } else { None }
}

/// `\n {0,3}((?:=+|-+) *)(?=\n|$)` → `\n    $1`.
fn setext_guard(s: &str) -> String {
    let lines: Vec<&str> = s.split('\n').collect();
    let mut out = String::with_capacity(s.len());
    for (i, l) in lines.iter().enumerate() {
        if i > 0 {
            out.push('\n');
            let k = spaces(l, 3);
            let r = &l[k..];
            let c = r.chars().next();
            if matches!(c, Some('=') | Some('-')) {
                let ch = c.unwrap_or('=');
                let run = r.bytes().take_while(|b| *b as char == ch).count();
                if r[run..].bytes().all(|b| b == b' ') {
                    out.push_str("    ");
                    out.push_str(r);
                    continue;
                }
            }
        }
        out.push_str(l);
    }
    out
}

/// `^ {0,3}>[ \t]?` removed from every line.
fn strip_quote_markers(s: &str) -> String {
    s.split('\n')
        .map(|l| {
            let k = spaces(l, 3);
            match l[k..].strip_prefix('>') {
                Some(r) => r.strip_prefix([' ', '\t']).unwrap_or(r),
                None => l,
            }
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// The list rule `^( {0,3}(?:[*+-]|\d{1,9}[.)]))([ \t][^\n]+?)?(?:\n|$)`: bullet with indent, and the bullet.
fn list_start(src: &str) -> Option<(usize, String)> {
    let k = spaces(src, 3);
    let rest = &src[k..];
    let blen = bullet_len(rest)?;
    let after = &rest[blen..];
    let ok = after.is_empty() || after.starts_with('\n') || (after.starts_with([' ', '\t']) && line_end(after, 0) >= 2);
    if !ok {
        return None;
    }
    Some((k + blen, rest[..blen].to_string()))
}

/// `[*+-]|\d{1,9}[.)]` at the start: its length.
fn bullet_len(s: &str) -> Option<usize> {
    let b = s.as_bytes();
    if b.first().is_some_and(|c| matches!(c, b'*' | b'+' | b'-')) {
        return Some(1);
    }
    let d = b.iter().take_while(|c| c.is_ascii_digit()).count();
    if (1..=9).contains(&d) && b.get(d).is_some_and(|c| matches!(c, b'.' | b')')) {
        return Some(d + 1);
    }
    None
}

/// `itemRegex`: `^( {0,3}bull)((?:[\t ][^\n]*)?(?:\n|$))` → (cap1 length, cap0 length).
fn list_item_start(src: &str, ordered: bool, delim: char) -> Option<(usize, usize)> {
    let k = spaces(src, 3);
    let rest = &src[k..];
    let blen = if ordered {
        let d = rest.bytes().take_while(|c| c.is_ascii_digit()).count();
        if !(1..=9).contains(&d) || !rest[d..].starts_with(delim) {
            return None;
        }
        d + 1
    } else {
        if !rest.starts_with(delim) {
            return None;
        }
        1
    };
    let cap1 = k + blen;
    let after = &src[cap1..];
    let mut len = 0;
    if after.starts_with(['\t', ' ']) {
        len = line_end(after, 0);
    } else if !(after.is_empty() || after.starts_with('\n')) {
        return None;
    }
    if len < after.len() {
        len += 1; // the newline
    }
    Some((cap1, cap1 + len))
}

/// A line that ends the current list item (fence, heading, html, quote, bullet or hr at `n` spaces at most).
fn item_break(line: &str, n: usize) -> bool {
    fence_begin(line, n)
        || heading_begin(line, n)
        || indent_then(line, n, |r| {
            r.starts_with("<!--")
                || r.strip_prefix('<').is_some_and(|t| {
                    t.chars().next().is_some_and(|c| c.is_ascii_alphabetic()) && first_line(t).contains('>')
                })
        })
        || indent_then(line, n, |r| r.starts_with('>'))
        || indent_then(line, n, |r| {
            bullet_len(r).is_some_and(|b| {
                let after = &r[b..];
                after.is_empty() || after.starts_with(['\n', ' ', '\t'])
            })
        })
        || hr_in_item(line, n)
}

fn fence_begin(line: &str, n: usize) -> bool {
    indent_then(line, n, |r| r.starts_with("```") || r.starts_with("~~~"))
}

fn heading_begin(line: &str, n: usize) -> bool {
    indent_then(line, n, |r| r.starts_with('#'))
}

/// `\n[ \t]*\n[ \t]*$`.
fn double_blank_end(raw: &str) -> bool {
    let t = raw.trim_end_matches([' ', '\t']);
    let Some(t) = t.strip_suffix('\n') else { return false };
    let t = t.trim_end_matches([' ', '\t']);
    t.ends_with('\n')
}

/// `\n.*\n`.
fn any_line(raw: &str) -> bool {
    let Some(i) = raw.find('\n') else { return false };
    let rest = &raw[i + 1..];
    match rest.find(|c: char| crate::chars::is_line_term(c)) {
        Some(j) => rest.as_bytes()[j] == b'\n',
        None => false,
    }
}

/// `^\[[ xX]\] +\S`.
fn is_marked_task(text: &str) -> bool {
    let b = text.as_bytes();
    if b.len() < 4 || b[0] != b'[' || !matches!(b[1], b' ' | b'x' | b'X') || b[2] != b']' || b[3] != b' ' {
        return false;
    }
    let rest = text[3..].trim_start_matches(' ');
    rest.chars().next().is_some_and(|c| !is_space(c))
}

/// `replace(/^\[[ xX]\] +/, '')`.
fn strip_task(text: &str) -> &str {
    let b = text.as_bytes();
    if b.len() >= 4 && b[0] == b'[' && matches!(b[1], b' ' | b'x' | b'X') && b[2] == b']' && b[3] == b' ' {
        text[3..].trim_start_matches(' ')
    } else {
        text
    }
}

/// marked's block `html` rule: the length.
fn html_block(src: &str) -> Option<usize> {
    let ind = spaces(src, 3);
    let s = &src[ind..];
    if !s.starts_with('<') {
        return None;
    }
    let lower_starts =
        |p: &str| s.len() >= p.len() && s.is_char_boundary(p.len()) && s[..p.len()].eq_ignore_ascii_case(p);
    // (1) script, pre, style, textarea
    for name in ["script", "pre", "style", "textarea"] {
        if lower_starts(&format!("<{name}")) {
            let after = &s[1 + name.len()..];
            if after.chars().next().is_some_and(|c| is_space(c) || c == '>') {
                let close = format!("</{name}>");
                let lower = s.to_ascii_lowercase();
                let mut from = 0;
                while let Some(k) = lower[from..].find(&close) {
                    let at = from + k + close.len();
                    let le = line_end(s, at);
                    let nl = s[le..].bytes().take_while(|b| *b == b'\n').count();
                    if nl > 0 {
                        return Some(ind + le + nl);
                    }
                    from = at;
                }
                return Some(src.len());
            }
        }
    }
    // (2) comment
    if let Some(after) = s.strip_prefix("<!--") {
        let body_end = if after.starts_with("->") {
            4 + 2
        } else if after.starts_with('>') {
            4 + 1
        } else {
            match after.find("-->") {
                Some(k) => 4 + k + 3,
                None => s.len(),
            }
        };
        let le = line_end(s, body_end);
        let nl = s[le..].bytes().take_while(|b| *b == b'\n').count();
        return Some(ind + le + nl);
    }
    // (3) processing instruction
    if let Some(pi) = s.strip_prefix("<?") {
        return Some(match pi.find("?>") {
            Some(k) => {
                let e = 2 + k + 2;
                ind + e + s[e..].bytes().take_while(|b| *b == b'\n').count()
            }
            None => src.len(),
        });
    }
    // (4) declaration
    if s.starts_with("<!") && s[2..].chars().next().is_some_and(|c| c.is_ascii_alphabetic()) {
        return Some(match s.find('>') {
            Some(k) => ind + k + 1 + s[k + 1..].bytes().take_while(|b| *b == b'\n').count(),
            None => src.len(),
        });
    }
    // (5) CDATA
    if s.starts_with("<![CDATA[") {
        return Some(match s.find("]]>") {
            Some(k) => ind + k + 3 + s[k + 3..].bytes().take_while(|b| *b == b'\n').count(),
            None => src.len(),
        });
    }
    // (6) block tags
    if block_tag_at(s, true) {
        return Some(ind + until_blank_line(s));
    }
    // (7) any other complete open or closing tag alone on its line
    if let Some(end) = open_or_close_tag(s) {
        let rest = &s[end..];
        let ws = rest.bytes().take_while(|b| *b == b' ' || *b == b'\t').count();
        if rest[ws..].is_empty() || rest[ws..].starts_with('\n') {
            return Some(ind + until_blank_line(s));
        }
    }
    None
}

/// `[\s\S]*?(?:(?:\n[ \t]*)+\n|$)`: up to and including the first blank line(s), or the end.
fn until_blank_line(s: &str) -> usize {
    let b = s.as_bytes();
    let mut p = 0;
    while let Some(k) = s[p..].find('\n') {
        let nl = p + k;
        // chain of "\n[ \t]*"
        let mut last_nl = nl;
        let mut j = nl + 1;
        let mut count = 1;
        loop {
            while j < b.len() && (b[j] == b' ' || b[j] == b'\t') {
                j += 1;
            }
            if j < b.len() && b[j] == b'\n' {
                last_nl = j;
                count += 1;
                j += 1;
            } else {
                break;
            }
        }
        if count >= 2 {
            return last_nl + 1;
        }
        p = nl + 1;
    }
    s.len()
}

/// Rule 7's tag: `<(?!script|pre|style|textarea)([a-z][\w-]*)(?:attribute)*? */?>` or
/// `</(?!script|pre|style|textarea)[a-z][\w-]*\s*>` (case-insensitive): the end of the tag.
fn open_or_close_tag(s: &str) -> Option<usize> {
    let lower = s.to_ascii_lowercase();
    let closing = s.starts_with("</");
    let name_at = if closing { 2 } else { 1 };
    let l = &lower[name_at..];
    if ["script", "pre", "style", "textarea"].iter().any(|p| l.starts_with(p)) {
        return None;
    }
    let b = s.as_bytes();
    if !b.get(name_at).is_some_and(|c| c.is_ascii_alphabetic()) {
        return None;
    }
    let mut j = name_at + 1;
    while j < b.len() && (is_word(b[j] as char) || b[j] == b'-') {
        j += 1;
    }
    if closing {
        while j < b.len() && is_space(b[j] as char) {
            j += 1;
        }
        return (b.get(j) == Some(&b'>')).then_some(j + 1);
    }
    loop {
        // ` */?>`
        let mut k = j;
        while k < b.len() && b[k] == b' ' {
            k += 1;
        }
        if b.get(k) == Some(&b'/') && b.get(k + 1) == Some(&b'>') {
            return Some(k + 2);
        }
        if b.get(k) == Some(&b'>') {
            return Some(k + 1);
        }
        // one attribute: ` +[a-zA-Z:_][\w.:-]*(?: *= *"[^"\n]*"| *= *'[^'\n]*'| *= *[^\s"'=<>`]+)?`
        if k == j || !b.get(k).is_some_and(|c| c.is_ascii_alphabetic() || *c == b':' || *c == b'_') {
            return None;
        }
        k += 1;
        while k < b.len() && (is_word(b[k] as char) || matches!(b[k], b'.' | b':' | b'-')) {
            k += 1;
        }
        let mut v = k;
        while v < b.len() && b[v] == b' ' {
            v += 1;
        }
        if b.get(v) == Some(&b'=') {
            v += 1;
            while v < b.len() && b[v] == b' ' {
                v += 1;
            }
            match b.get(v) {
                Some(b'"') | Some(b'\'') => {
                    let q = b[v];
                    match s[v + 1..].find(|c: char| c as u32 == q as u32 || c == '\n') {
                        Some(e) if b[v + 1 + e] == q => k = v + 1 + e + 1,
                        _ => {}
                    }
                }
                Some(_) => {
                    let st = v;
                    while v < b.len()
                        && !is_space(b[v] as char)
                        && !matches!(b[v], b'"' | b'\'' | b'=' | b'<' | b'>' | b'`')
                    {
                        v += 1;
                    }
                    if v > st {
                        k = v;
                    }
                }
                None => {}
            }
        }
        j = k;
    }
}

/// marked's `def` rule: (length, tag, href, title).
fn def_rule(src: &str) -> Option<(usize, String, String, Option<String>)> {
    let ind = spaces(src, 3);
    let s = &src[ind..];
    let rest = s.strip_prefix('[')?;
    // label: (?!\s*\])(?:\\[\s\S]|[^\[\]\\])+
    let mut j = 0;
    let rb = rest.as_bytes();
    while j < rb.len() {
        match rb[j] {
            b'\\' if j + 1 < rb.len() => j += 2,
            b'\\' | b'[' => return None,
            b']' => break,
            _ => j += 1,
        }
    }
    if j == 0 || j >= rb.len() || trim(&rest[..j]).is_empty() {
        return None;
    }
    let label = &rest[..j];
    let mut p = ind + 1 + j + 1;
    let b = src.as_bytes();
    if b.get(p) != Some(&b':') {
        return None;
    }
    p += 1;
    while p < b.len() && b[p] == b' ' {
        p += 1;
    }
    if b.get(p) == Some(&b'\n') {
        p += 1;
        while p < b.len() && (b[p] == b' ' || b[p] == b'\t') {
            p += 1;
        }
    }
    // destination
    let dest_start = p;
    if b.get(p) == Some(&b'<') {
        let le = line_end(src, p);
        let k = src[p..le].find('>')?;
        p += k + 1;
    } else {
        if p >= b.len() || is_space(src[p..].chars().next()?) {
            return None;
        }
        while p < b.len() {
            let c = src[p..].chars().next()?;
            if is_space(c) {
                break;
            }
            p += c.len_utf8();
        }
    }
    let dest = &src[dest_start..p];
    let tail = |q: usize| -> Option<usize> {
        let mut q = q;
        while q < b.len() && b[q] == b' ' {
            q += 1;
        }
        newlines_or_end(&src[q..]).map(|n| q + n)
    };
    // optional title
    let mut title = None;
    let mut end = None;
    {
        let mut q = p;
        let sp = src[q..].bytes().take_while(|c| *c == b' ').count();
        q += sp;
        let mut ok = sp > 0;
        if b.get(q) == Some(&b'\n') {
            q += 1;
            while q < b.len() && (b[q] == b' ' || b[q] == b'\t') {
                q += 1;
            }
            ok = true;
        }
        if ok {
            if let Some((tlen, t)) = def_title(&src[q..]) {
                if let Some(e) = tail(q + tlen) {
                    title = Some(t);
                    end = Some(e);
                }
            }
        }
    }
    let end = match end {
        Some(e) => e,
        None => tail(p)?,
    };
    let tag = crate::chars::collapse_spaces(label).to_lowercase();
    let href = dest.strip_prefix('<').and_then(|d| d.strip_suffix('>')).unwrap_or(dest);
    Some((end, tag, unescape_punct(href), title.map(|t| unescape_punct(&t))))
}

fn def_title(s: &str) -> Option<(usize, String)> {
    let open = s.chars().next()?;
    let close = match open {
        '"' => '"',
        '\'' => '\'',
        '(' => ')',
        _ => return None,
    };
    let mut j = 1;
    let b = s.as_bytes();
    while j < b.len() {
        let c = b[j] as char;
        if c == '\\' && open == '"' {
            j += 2;
            continue;
        }
        if c == close {
            return Some((j + 1, s[1..j].to_string()));
        }
        if open == '(' && c == '(' {
            return None;
        }
        j += 1;
    }
    None
}

/// marked's GFM table rule.
fn gfm_table(src: &str) -> Option<Block> {
    let (hlen, astart, aend) = table_head(src)?;
    let header_line = &src[..hlen];
    let lead = spaces(header_line, usize::MAX);
    let cap1 = &header_line[lead..];
    let cap2 = &src[astart..aend];
    let mut end = aend;
    let mut rows_text = "";
    if end < src.len() {
        // \n then rows then \n*
        let rows_start = end + 1;
        let mut p = rows_start;
        while p < src.len() {
            let line = &src[p..];
            if table_row_stop(line) {
                break;
            }
            let le = line_end(line, 0);
            p += le;
            if p < src.len() {
                p += 1;
            } else {
                break;
            }
        }
        rows_text = &src[rows_start..p];
        end = p + src[p..].bytes().take_while(|b| *b == b'\n').count();
    }
    if !cap2.contains([':', '|']) {
        return None;
    }
    let headers = split_cells(cap1, None);
    let mut a = cap2;
    a = a.strip_prefix('|').unwrap_or(a);
    let a = {
        let t = a.trim_end_matches(' ');
        t.strip_suffix('|').unwrap_or(a)
    };
    let aligns: Vec<&str> = a.split('|').collect();
    if headers.len() != aligns.len() {
        return None;
    }
    let align = aligns
        .iter()
        .map(|c| {
            let t = c.trim_matches(' ');
            let dashes = |s: &str| !s.is_empty() && s.bytes().all(|b| b == b'-');
            if let Some(inner) = t.strip_suffix(':') {
                if let Some(inner2) = inner.strip_prefix(':') {
                    if dashes(inner2) {
                        return Some("center");
                    }
                } else if dashes(inner) {
                    return Some("right");
                }
            } else if let Some(inner) = t.strip_prefix(':') {
                if dashes(inner) {
                    return Some("left");
                }
            }
            None
        })
        .collect::<Vec<_>>();
    let rows = if trim(rows_text).is_empty() {
        Vec::new()
    } else {
        // replace(/\n[ \t]*$/, '')
        let t = match rows_text.rfind('\n') {
            Some(i) if rows_text[i + 1..].bytes().all(|b| b == b' ' || b == b'\t') => &rows_text[..i],
            _ => rows_text,
        };
        t.split('\n').map(|r| split_cells(r, Some(headers.len()))).collect()
    };
    Some(Block::Table { raw: src[..end].to_string(), align, header: headers, rows })
}

/// marked's GFM setext heading rule.
fn lheading(src: &str) -> Option<Block> {
    if lheading_interrupt(src) {
        return None;
    }
    let mut end = line_end(src, 0);
    if end == 0 {
        return None;
    }
    loop {
        if end >= src.len() {
            return None;
        }
        let next = &src[end + 1..];
        // underline?
        let k = spaces(next, 3);
        let u = &next[k..];
        if let Some(c) = u.chars().next().filter(|c| *c == '=' || *c == '-') {
            let run = u.bytes().take_while(|b| *b as char == c).count();
            let sp = u[run..].bytes().take_while(|b| *b == b' ').count();
            if let Some(nl) = newlines_or_end(&u[run + sp..]) {
                let text = trim(&src[..end]).to_string();
                let raw_len = end + 1 + k + run + sp + nl;
                return Some(Block::Heading {
                    raw: src[..raw_len].to_string(),
                    depth: if c == '=' { 1 } else { 2 },
                    text,
                });
            }
        }
        // continuation line?
        let le = line_end(next, 0);
        let blank = next[..le].chars().all(is_space) && le < next.len();
        if blank || lheading_interrupt(next) || le == 0 {
            return None;
        }
        end += 1 + le;
    }
}

/// The interrupters of the setext heading rule (`bull |blockCode|fences|blockquote|heading|html|table`).
fn lheading_interrupt(s: &str) -> bool {
    let k = spaces(s, 3);
    let r = &s[k..];
    if bullet_len(r).is_some_and(|b| r[b..].starts_with(' ')) {
        return true;
    }
    if code_line_start(s).is_some() {
        return true;
    }
    if r.starts_with("```") || r.starts_with("~~~") || r.starts_with('>') || r.starts_with('#') {
        return true;
    }
    if let Some(t) = r.strip_prefix('<') {
        let le = line_end(t, 0);
        if le < t.len() {
            if let Some(gt) = t[..le].find('>') {
                if gt > 0 && gt + 1 == le {
                    return true;
                }
            }
        }
    }
    // ` {0,3}\|?(?:[:\- ]*\|)+[\:\- ]*\n`
    let le = line_end(r, 0);
    if le < r.len() {
        let line = &r[..le];
        if line.contains('|') && line.bytes().all(|b| matches!(b, b':' | b'-' | b' ' | b'|')) {
            return true;
        }
    }
    false
}

// ---------------------------------------------------------------- the editor's block tokenizers

/// The start functions of the block extensions on `src.slice(1)`: where to clip a paragraph.
fn start_block(src: &str) -> Option<usize> {
    let first = src.chars().next()?;
    let off = first.len_utf8();
    // `src.slice(1)` drops one UTF-16 unit: after a character outside the BMP, half of it is left
    let astral;
    let temp: &str = if first.len_utf16() == 2 {
        astral = format!("\u{fffe}{}", &src[off..]);
        &astral
    } else {
        &src[off..]
    };
    let shift = |i: usize| if first.len_utf16() == 2 { off + i - '\u{fffe}'.len_utf8() } else { off + i };
    let mut best: Option<usize> = None;
    let mut take = |i: Option<usize>| {
        if let Some(i) = i {
            best = Some(best.map_or(i, |b: usize| b.min(i)));
        }
    };
    // mathBlock: indexOf('$$')
    take(temp.find("$$"));
    // callout: /^ {0,3}>[ \t]?\[!\w+\]/m
    take(line_starts(temp).find(|&i| callout_head(&temp[i..])));
    // diagram, sketch: /^!?\[[^\]\n]*\]\(diagram:dg_/m ; canvas: /^!\[[^\]\n]*\]\(canvas:cv_/m
    take(line_starts(temp).find(|&i| {
        let l = &temp[i..];
        drawing_head(l, "diagram:dg_", true)
            || drawing_head(l, "sketch:sk_", true)
            || drawing_head(l, "canvas:cv_", false)
    }));
    // table: second line is a separator with a pipe and the first holds a pipe. A failed table clips a paragraph
    // one character at a time, each step reading the line again: lines longer than this are not considered, so
    // that stays linear
    {
        let le0 = line_end(temp, 0);
        if le0 <= MAX_CLIP_LINE && le0 < temp.len() {
            let l1 = &temp[le0 + 1..line_end(temp, le0 + 1)];
            if is_table_sep(l1) && temp[..le0].contains('|') {
                take(Some(0));
            }
        }
    }
    // taskList: /^\s*[-+*]\s+\[([ xX])\]\s+/ (no m flag)
    {
        let t = crate::chars::trim_start(temp);
        let mut cs = t.chars();
        if cs.next().is_some_and(|c| matches!(c, '-' | '+' | '*')) {
            let r = cs.as_str();
            let ws = crate::chars::leading_space_count(r);
            if ws > 0 {
                let r2: String = r.chars().skip(ws).collect();
                let b = r2.as_bytes();
                if b.len() >= 4
                    && b[0] == b'['
                    && matches!(b[1], b' ' | b'x' | b'X')
                    && b[2] == b']'
                    && r2[3..].chars().next().is_some_and(is_space)
                {
                    take(Some(0));
                }
            }
        }
    }
    best.filter(|i| first.len_utf16() == 1 || *i >= '\u{fffe}'.len_utf8()).map(shift)
}

fn line_starts(s: &str) -> impl Iterator<Item = usize> + '_ {
    std::iter::once(0).chain(s.match_indices('\n').map(|(i, _)| i + 1).filter(move |i| *i <= s.len()))
}

/// `^ {0,3}>[ \t]?\[!\w+\]`.
fn callout_head(s: &str) -> bool {
    let k = spaces(s, 3);
    let Some(r) = s[k..].strip_prefix('>') else { return false };
    let r = r.strip_prefix([' ', '\t']).unwrap_or(r);
    let Some(r) = r.strip_prefix("[!") else { return false };
    let n = r.bytes().take_while(|b| is_word(*b as char)).count();
    n > 0 && r[n..].starts_with(']')
}

/// `^!?\[[^\]\n]*\]\(scheme` (with `bang_optional`) or `^!\[…`.
fn drawing_head(s: &str, scheme: &str, bang_optional: bool) -> bool {
    let r = match s.strip_prefix('!') {
        Some(r) => r,
        None if bang_optional => s,
        None => return false,
    };
    let Some(r) = r.strip_prefix('[') else { return false };
    let Some(k) = r.find([']', '\n']) else { return false };
    if r.as_bytes()[k] != b']' {
        return false;
    }
    r[k + 1..].strip_prefix('(').is_some_and(|t| t.starts_with(scheme))
}

/// `/^[ \t|:]*-[ \t|:-]*$/` and contains a pipe.
fn is_table_sep(l: &str) -> bool {
    l.contains('|') && l.contains('-') && l.bytes().all(|b| matches!(b, b' ' | b'\t' | b'|' | b':' | b'-'))
}

/// The MathBlock tokenizer: `^\$\$[ \t]*\n?([\s\S]+?)\n?[ \t]*\$\$[ \t]*(?:\n|$)`.
fn math_block(src: &str) -> Option<Block> {
    let rest = src.strip_prefix("$$")?;
    let b = rest.as_bytes();
    let mut cs = rest.bytes().take_while(|c| *c == b' ' || *c == b'\t').count();
    if b.get(cs) == Some(&b'\n') {
        cs += 1;
    }
    // closing "$$" at c, followed by [ \t]* and \n or the end: (c, end of match)
    let closings = (0..rest.len().saturating_sub(1)).filter(|c| b[*c] == b'$' && b[*c + 1] == b'$').filter_map(|c| {
        let after = &rest[c + 2..];
        let ws = after.bytes().take_while(|x| *x == b' ' || *x == b'\t').count();
        let tail = &after[ws..];
        (tail.is_empty() || tail.starts_with('\n')).then(|| (c, c + 2 + ws + usize::from(tail.starts_with('\n'))))
    });
    // the earliest content end e >= cs + 1 from which `\n?[ \t]*$$` reaches a closing
    let min_e = |c: usize| {
        let mut e = c;
        while e > 0 && matches!(b[e - 1], b' ' | b'\t') {
            e -= 1;
        }
        if e > 0 && b[e - 1] == b'\n' {
            e -= 1;
        }
        e
    };
    for (c, end) in closings {
        if c < cs {
            continue;
        }
        let start = if c > cs {
            cs
        } else if cs > 0 {
            cs - 1
        } else {
            continue;
        };
        let e = min_e(c).max(start + 1);
        if e > c {
            continue;
        }
        let latex = trim(&rest[start..e]).to_string();
        return Some(Block::Math { raw: src[..2 + end].to_string(), latex });
    }
    None
}

/// The Diagram, Sketch and Canvas tokenizers.
fn drawing(src: &str) -> Option<Block> {
    let le = line_end(src, 0);
    let line = &src[..le];
    let trimmed = line.trim_end_matches([' ', '\t']);
    let raw_len = if le < src.len() { le + 1 } else { le };
    let bang = trimmed.starts_with('!');
    let r = trimmed.strip_prefix('!').unwrap_or(trimmed).strip_prefix('[')?;
    let k = r.find(']')?;
    let label = &r[..k];
    let target = r[k + 1..].strip_prefix('(')?.strip_suffix(')')?;
    let hex8 = |s: &str| s.len() == 8 && s.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b));
    if let Some(id) = target.strip_prefix("diagram:dg_") {
        if hex8(id) {
            return Some(Block::Diagram {
                raw: src[..raw_len].to_string(),
                label: label.to_string(),
                id: format!("dg_{id}"),
            });
        }
    } else if let Some(id) = target.strip_prefix("sketch:sk_") {
        if hex8(id) {
            return Some(Block::Sketch {
                raw: src[..raw_len].to_string(),
                label: label.to_string(),
                id: format!("sk_{id}"),
            });
        }
    } else if let Some(t) = target.strip_prefix("canvas:cv_") {
        if !bang {
            return None;
        }
        let (id, frag) = match t.split_once('#') {
            Some((id, f)) => (id, Some(f)),
            None => (t, None),
        };
        if !hex8(id) {
            return None;
        }
        let fragment = match frag {
            Some(f) => {
                let ok = (f.starts_with("b_") || f.starts_with("p_")) && hex8(&f[2..]);
                if !ok {
                    return None;
                }
                f.to_string()
            }
            None => String::new(),
        };
        return Some(Block::Canvas {
            raw: src[..raw_len].to_string(),
            label: label.to_string(),
            id: format!("cv_{id}"),
            fragment,
        });
    }
    None
}

/// `^(\s*)([-+*])\s+\[([ xX])\]\s+(.*)$` on one line: (indent, checked, text).
fn task_item_line(line: &str) -> Option<(usize, bool, &str)> {
    let ind = crate::chars::leading_space_count(line);
    let r: &str = {
        let skip: usize = line.chars().take(ind).map(char::len_utf8).sum();
        &line[skip..]
    };
    let mut cs = r.chars();
    if !cs.next().is_some_and(|c| matches!(c, '-' | '+' | '*')) {
        return None;
    }
    let r = cs.as_str();
    let ws = crate::chars::leading_space_count(r);
    if ws == 0 {
        return None;
    }
    let r = &r[r.chars().take(ws).map(char::len_utf8).sum::<usize>()..];
    let b = r.as_bytes();
    if b.len() < 3 || b[0] != b'[' || !matches!(b[1], b' ' | b'x' | b'X') || b[2] != b']' {
        return None;
    }
    let checked = b[1] != b' ';
    let r = &r[3..];
    let ws = crate::chars::leading_space_count(r);
    if ws == 0 {
        return None;
    }
    let text = &r[r.chars().take(ws).map(char::len_utf8).sum::<usize>()..];
    if text.contains(['\r', '\u{2028}', '\u{2029}']) {
        return None;
    }
    Some((ind, checked, text))
}

// ---------------------------------------------------------------- the editor's ordered list

/// One collected item of the editor's ordered list tokenizer.
#[derive(Debug, Clone)]
struct OlItem {
    indent: usize,
    number: f64,
    type_marker: Option<String>,
    content_lines: Vec<String>,
    raw: String,
}

/// `ORDERED_LIST_ITEM_REGEX`: (indent, marker, content).
fn ordered_item_line(line: &str) -> Option<(usize, &str, &str)> {
    let ind = crate::chars::leading_space_count(line);
    let skip: usize = line.chars().take(ind).map(char::len_utf8).sum();
    let r = &line[skip..];
    let b = r.as_bytes();
    let try_marker = |len: usize| -> Option<(usize, &str, &str)> {
        if len == 0 || !matches!(b.get(len), Some(b'.') | Some(b')')) {
            return None;
        }
        let after = &r[len + 1..];
        let ws = crate::chars::leading_space_count(after);
        if ws == 0 {
            return None;
        }
        let content = &after[after.chars().take(ws).map(char::len_utf8).sum::<usize>()..];
        if content.contains(['\r', '\n', '\u{2028}', '\u{2029}']) {
            return None;
        }
        Some((ind, &r[..len], content))
    };
    let digits = b.iter().take_while(|c| c.is_ascii_digit()).count();
    if digits > 0 {
        return try_marker(digits);
    }
    let roman = b.iter().take_while(|c| b"ivxlcdmIVXLCDM".contains(c)).count();
    if roman > 0 {
        if let Some(m) = try_marker(roman) {
            return Some(m);
        }
    }
    let alpha = b.iter().take(2).take_while(|c| c.is_ascii_alphabetic()).count();
    (1..=alpha).rev().find_map(try_marker)
}

fn collect_ordered_items(lines: &mut LazyLines) -> (Vec<OlItem>, usize) {
    let mut items = Vec::new();
    let mut i = 0;
    let mut consumed = 0;
    while let Some(line) = lines.get(i) {
        let Some((indent, marker, content)) = ordered_item_line(line) else { break };
        let (number, type_marker) = marker_number(marker);
        let mut content_lines = vec![content.to_string()];
        let mut item_lines = vec![line.to_string()];
        let mut j = i + 1;
        let mut saw_blank = false;
        while let Some(next) = lines.get(j) {
            if ordered_item_line(next).is_some() {
                break;
            }
            if trim(next).is_empty() {
                item_lines.push(next.to_string());
                content_lines.push(String::new());
                saw_blank = true;
                j += 1;
            } else if next.chars().next().is_some_and(is_space) {
                let lead = crate::chars::leading_space_count(next);
                let content_indent = indent + marker.chars().count() + 1;
                item_lines.push(next.to_string());
                content_lines.push(next.chars().skip(lead.min(content_indent)).collect());
                j += 1;
            } else {
                if saw_blank || lazy_interrupt(next) {
                    break;
                }
                item_lines.push(next.to_string());
                content_lines.push(next.to_string());
                j += 1;
            }
        }
        items.push(OlItem { indent, number, type_marker, content_lines, raw: item_lines.join("\n") });
        consumed = j;
        i = j;
    }
    (items, consumed)
}

fn marker_number(marker: &str) -> (f64, Option<String>) {
    if marker.bytes().all(|b| b.is_ascii_digit()) {
        return (marker.parse::<f64>().unwrap_or(1.0), None);
    }
    let ty = detect_marker_type(marker);
    let n = match ty.as_deref() {
        Some("i") | Some("I") => from_roman(marker) as f64,
        Some("a") | Some("A") => {
            let s = from_alpha(marker);
            if s > 0 { s as f64 } else { 1.0 }
        }
        _ => 1.0,
    };
    (n, ty)
}

const ROMAN: &[(u32, &str)] = &[
    (1000, "m"),
    (900, "cm"),
    (500, "d"),
    (400, "cd"),
    (100, "c"),
    (90, "xc"),
    (50, "l"),
    (40, "xl"),
    (10, "x"),
    (9, "ix"),
    (5, "v"),
    (4, "iv"),
    (1, "i"),
];

/// Lower-case roman numeral of `n`.
pub fn to_roman(mut n: u64) -> String {
    let mut out = String::new();
    for (v, s) in ROMAN {
        while n >= *v as u64 {
            out.push_str(s);
            n -= *v as u64;
        }
    }
    out
}

fn from_roman(s: &str) -> u32 {
    let lower = s.to_ascii_lowercase();
    let mut i = 0;
    let mut out: u32 = 0;
    while i < lower.len() {
        let Some((v, n)) = ROMAN.iter().find(|(_, n)| lower[i..].starts_with(n)) else { return 0 };
        out = out.saturating_add(*v);
        i += n.len();
    }
    out
}

fn detect_marker_type(marker: &str) -> Option<String> {
    if marker.is_empty() || marker.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    if marker.bytes().all(|b| b"ivxlcdmIVXLCDM".contains(&b)) {
        let v = from_roman(marker);
        if v > 0 {
            let lower = marker == marker.to_ascii_lowercase();
            let expected = to_roman(v as u64);
            let expected = if lower { expected } else { expected.to_ascii_uppercase() };
            if expected == marker {
                return Some(if lower { "i" } else { "I" }.to_string());
            }
        }
    }
    if marker.len() <= 2 && marker.bytes().all(|b| b.is_ascii_lowercase()) {
        return Some("a".to_string());
    }
    if marker.len() <= 2 && marker.bytes().all(|b| b.is_ascii_uppercase()) {
        return Some("A".to_string());
    }
    None
}

fn from_alpha(marker: &str) -> u32 {
    let l = marker.to_ascii_lowercase();
    let b = l.as_bytes();
    match b.len() {
        1 => (b[0] - b'a') as u32 + 1,
        2 => ((b[0] - b'a') as u32 + 1) * 26 + (b[1] - b'a') as u32 + 1,
        _ => 0,
    }
}

/// Letter marker `a`… `z`, `aa`… of position `n` (1-based).
pub fn to_alpha(n: u64) -> String {
    const A: &[u8] = b"abcdefghijklmnopqrstuvwxyz";
    if n == 0 {
        return String::new();
    }
    if n <= 26 {
        return (A[(n - 1) as usize] as char).to_string();
    }
    let first = (n - 1) / 26;
    let second = ((n - 1) % 26) as usize;
    if first == 0 {
        return (A[second] as char).to_string();
    }
    let f = A.get((first - 1) as usize).copied().unwrap_or(b'z');
    format!("{}{}", f as char, A[second] as char)
}

/// `interruptsLazyContinuation`.
fn lazy_interrupt(line: &str) -> bool {
    let b = line.as_bytes();
    let hashes = b.iter().take_while(|c| **c == b'#').count();
    if (1..=6).contains(&hashes) && line[hashes..].chars().next().is_none_or(is_space) {
        return true;
    }
    if b.first().is_some_and(|c| matches!(c, b'-' | b'+' | b'*')) && line[1..].chars().next().is_some_and(is_space) {
        return true;
    }
    if line.starts_with("```") || line.starts_with("~~~") || line.starts_with("$$") {
        return true;
    }
    thematic_break_line(line)
}

/// `^(?:(?:-[ \t]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})$`.
fn thematic_break_line(line: &str) -> bool {
    let Some(c) = line.chars().next().filter(|c| matches!(c, '-' | '_' | '*')) else { return false };
    let mut count = 0;
    for x in line.chars() {
        if x == c {
            count += 1;
        } else if x != ' ' && x != '\t' {
            return false;
        }
    }
    count >= 3
}

/// `isBlockContentLine` (on the trimmed line).
fn block_content_line(line: &str) -> bool {
    let t = crate::chars::trim_start(line);
    let b = t.as_bytes();
    (b.first().is_some_and(|c| matches!(c, b'-' | b'+' | b'*')) && t[1..].chars().next().is_some_and(is_space))
        || ordered_item_line(crate::chars::trim_start(t)).is_some()
        || {
            let h = b.iter().take_while(|c| **c == b'#').count();
            (1..=6).contains(&h) && t[h..].chars().next().is_none_or(is_space)
        }
        || (thematic_break_line(t) && !t.starts_with('-'))
        || t.starts_with('>')
        || t.starts_with("```")
        || t.starts_with("~~~")
        || t.starts_with("$$")
}

fn split_item_content(lines: &[String]) -> (Vec<&str>, Vec<&str>) {
    let mut para = Vec::new();
    let mut block = Vec::new();
    let mut reached = false;
    for l in lines {
        if reached {
            block.push(l.as_str());
            continue;
        }
        if trim(l).is_empty() {
            reached = true;
            block.push(l.as_str());
            continue;
        }
        if !para.is_empty() && block_content_line(l) {
            reached = true;
            block.push(l.as_str());
            continue;
        }
        para.push(l.as_str());
    }
    (para, block)
}

/// `escapeTableCellPipes` on every line holding a pipe and a backtick.
fn preprocess_table_pipes(src: &str) -> String {
    src.split('\n')
        .map(|line| {
            if !line.contains('|') || !line.contains('`') {
                return line.to_string();
            }
            escape_table_cell_pipes(line)
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn escape_table_cell_pipes(line: &str) -> String {
    let c: Vec<char> = line.chars().collect();
    let mut out = String::with_capacity(line.len() + 4);
    let mut i = 0;
    while i < c.len() {
        if c[i] == '\\' && i + 1 < c.len() {
            out.push(c[i]);
            out.push(c[i + 1]);
            i += 2;
            continue;
        }
        if c[i] != '`' {
            out.push(c[i]);
            i += 1;
            continue;
        }
        let mut run = 0;
        while i + run < c.len() && c[i + run] == '`' {
            run += 1;
        }
        let mut j = i + run;
        let mut found = false;
        while j < c.len() {
            if c[j] != '`' {
                j += 1;
                continue;
            }
            let mut close = 0;
            while j + close < c.len() && c[j + close] == '`' {
                close += 1;
            }
            if close == run {
                out.extend(&c[i..i + run]);
                let mut k = i + run;
                while k < j {
                    if c[k] == '\\' && k + 1 < j && c[k + 1] == '|' {
                        out.push('\\');
                        out.push('|');
                        k += 2;
                    } else if c[k] == '|' {
                        out.push('\\');
                        out.push('|');
                        k += 1;
                    } else {
                        out.push(c[k]);
                        k += 1;
                    }
                }
                out.extend(&c[j..j + run]);
                i = j + run;
                found = true;
                break;
            }
            j += close;
        }
        if !found {
            out.extend(&c[i..i + run]);
            i += run;
        }
    }
    out
}
