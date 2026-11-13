//! `services/docs_text.py`: pure Markdown helpers for the Docs space: slugs, headings and reference parsing.
//!
//! The Python patterns are linear on hostile input (`tests/test_regex_linear.py`): their body classes exclude the next
//! opener (`[`) and are length-bounded. They are matched here by hand-written scanners that follow the same bounds,
//! so one pass over the text never rescans it from every start. All offsets and lengths count characters (code
//! points), as Python's do.

use kb_db::sea_orm::DbErr;
use serde::Serialize;
use serde_json::{Map, Value};
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, LazyLock, Mutex};

/// Domain error carrying an HTTP status and a machine-readable code.
#[derive(Debug, Clone, PartialEq)]
pub struct DocsError {
    /// HTTP status to return.
    pub status: u16,
    /// Short machine-readable code.
    pub code: String,
    /// Human-readable explanation.
    pub message: String,
    /// Extra fields merged into the error response.
    pub extra: Map<String, Value>,
}

impl DocsError {
    /// `DocsError(status, code, message)`.
    pub fn new(status: u16, code: &str, message: impl Into<String>) -> Self {
        Self { status, code: code.to_string(), message: message.into(), extra: Map::new() }
    }

    /// `DocsError(status, code, message, key=value)`: one more extra field.
    pub fn with(mut self, key: &str, value: impl Into<Value>) -> Self {
        self.extra.insert(key.to_string(), value.into());
        self
    }
}

impl std::fmt::Display for DocsError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for DocsError {}

/// What a Docs service function fails with: the `DocsError` it raised, or a database call that failed (an
/// unhandled exception in Python, a 500).
#[derive(Debug)]
pub enum Error {
    /// `raise DocsError(...)`.
    Docs(DocsError),
    /// The database call failed.
    Db(DbErr),
}

impl From<DocsError> for Error {
    fn from(err: DocsError) -> Self {
        Error::Docs(err)
    }
}

impl From<DbErr> for Error {
    fn from(err: DbErr) -> Self {
        Error::Db(err)
    }
}

impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Error::Docs(err) => err.fmt(f),
            Error::Db(err) => err.fmt(f),
        }
    }
}

impl std::error::Error for Error {}

/// What a Docs service function returns.
pub type DocsResult<T> = Result<T, Error>;

// ---------------------------------------------------------------------------------------------------------------
// Pattern scanners. Each one is the Python pattern written out, with its length bounds; the comment above it
// quotes the pattern.
// ---------------------------------------------------------------------------------------------------------------

/// Where one `[[title#anchor|display]]` sits in a line (character offsets, half open).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RefMatch {
    /// Start of the `[[`.
    pub start: usize,
    /// End after the closing `]]`.
    pub end: usize,
    /// `group(1)`.
    pub title: (usize, usize),
    /// `group(2)`, the part after `#`.
    pub anchor: Option<(usize, usize)>,
    /// `group(3)`, the part after `|`.
    pub display: Option<(usize, usize)>,
}

/// Length of the run of characters from `from` that `stop` does not name, looking at most `cap + 1` characters far.
fn run_len(chars: &[char], from: usize, cap: usize, stop: impl Fn(char) -> bool) -> usize {
    let mut n = 0;
    while n <= cap && from + n < chars.len() && !stop(chars[from + n]) {
        n += 1;
    }
    n
}

/// `_REF` at one position:
/// `\[\[([^\][|#\n]{1,200})(?:#([^\][|\n]{1,200}))?(?:\|([^\][\n]{1,200}))?\]\]`.
///
/// `anchor_min` is the least length of the part after `#`: 1 here, 0 in `docs_anchors` (which has `{0,200}`).
pub fn ref_at(chars: &[char], i: usize, anchor_min: usize) -> Option<RefMatch> {
    if chars.get(i) != Some(&'[') || chars.get(i + 1) != Some(&'[') {
        return None;
    }
    let t0 = i + 2;
    // every class excludes the character that ends its run, so a run is as long as the text allows and never
    // gives characters back: a bounded run that is too long fails the whole match
    let t = run_len(chars, t0, 200, |c| matches!(c, ']' | '[' | '|' | '#' | '\n'));
    if !(1..=200).contains(&t) {
        return None;
    }
    let mut p = t0 + t;
    let mut anchor = None;
    if chars.get(p) == Some(&'#') {
        let a0 = p + 1;
        let a = run_len(chars, a0, 200, |c| matches!(c, ']' | '[' | '|' | '\n'));
        if a < anchor_min || a > 200 {
            return None;
        }
        anchor = Some((a0, a0 + a));
        p = a0 + a;
    }
    let mut display = None;
    if chars.get(p) == Some(&'|') {
        let d0 = p + 1;
        let d = run_len(chars, d0, 200, |c| matches!(c, ']' | '[' | '\n'));
        if !(1..=200).contains(&d) {
            return None;
        }
        display = Some((d0, d0 + d));
        p = d0 + d;
    }
    if chars.get(p) == Some(&']') && chars.get(p + 1) == Some(&']') {
        Some(RefMatch { start: i, end: p + 2, title: (t0, t0 + t), anchor, display })
    } else {
        None
    }
}

/// `_REF.finditer(text)`: the references of a line, left to right, not overlapping.
pub fn find_refs(chars: &[char], anchor_min: usize) -> Vec<RefMatch> {
    let mut out = Vec::new();
    let mut i = 0;
    while i < chars.len() {
        match ref_at(chars, i, anchor_min) {
            Some(m) => {
                i = m.end;
                out.push(m);
            }
            None => i += 1,
        }
    }
    out
}

fn text_of(chars: &[char], range: (usize, usize)) -> String {
    chars[range.0..range.1].iter().collect()
}

/// `_REF.sub(lambda m: m.group(3) or m.group(1), text)`.
pub fn ref_labels(text: &str) -> String {
    let chars: Vec<char> = text.chars().collect();
    let mut out = String::new();
    let mut last = 0;
    for m in find_refs(&chars, 1) {
        out.extend(&chars[last..m.start]);
        out.push_str(&text_of(&chars, m.display.unwrap_or(m.title)));
        last = m.end;
    }
    out.extend(&chars[last..]);
    out
}

/// `_LINK` at one position: `\[([^\][\n]{1,300})\]\(([^()\n]{0,500})\)`. Returns the end and the link text range.
pub fn link_at(chars: &[char], i: usize) -> Option<(usize, (usize, usize))> {
    if chars.get(i) != Some(&'[') {
        return None;
    }
    let t0 = i + 1;
    let t = run_len(chars, t0, 300, |c| matches!(c, ']' | '[' | '\n'));
    if !(1..=300).contains(&t) {
        return None;
    }
    let p = t0 + t;
    if chars.get(p) != Some(&']') || chars.get(p + 1) != Some(&'(') {
        return None;
    }
    let u0 = p + 2;
    let u = run_len(chars, u0, 500, |c| matches!(c, '(' | ')' | '\n'));
    if u > 500 || chars.get(u0 + u) != Some(&')') {
        return None;
    }
    Some((u0 + u + 1, (t0, t0 + t)))
}

/// `_LINK.sub(r"\1", text)`: `[text](url)` becomes `text`.
pub fn link_labels(text: &str) -> String {
    let chars: Vec<char> = text.chars().collect();
    let mut out = String::new();
    let mut i = 0;
    while i < chars.len() {
        match link_at(&chars, i) {
            Some((end, label)) => {
                out.extend(&chars[label.0..label.1]);
                i = end;
            }
            None => {
                out.push(chars[i]);
                i += 1;
            }
        }
    }
    out
}

/// `_INLINE_CODE.finditer(text)`: `` `[^`\n]*` ``. Character ranges of the spans of inline code.
pub fn inline_code_spans(chars: &[char]) -> Vec<(usize, usize)> {
    let mut out = Vec::new();
    let mut i = 0;
    while i < chars.len() {
        if chars[i] == '`' {
            let mut j = i + 1;
            while j < chars.len() && chars[j] != '`' && chars[j] != '\n' {
                j += 1;
            }
            if chars.get(j) == Some(&'`') {
                out.push((i, j + 1));
                i = j + 1;
                continue;
            }
        }
        i += 1;
    }
    out
}

/// `_INLINE_CODE.sub("", text)`.
pub fn remove_inline_code(text: &str) -> String {
    let chars: Vec<char> = text.chars().collect();
    let mut out = String::new();
    let mut last = 0;
    for (a, b) in inline_code_spans(&chars) {
        out.extend(&chars[last..a]);
        last = b;
    }
    out.extend(&chars[last..]);
    out
}

/// `_FENCE.match(line)`: `^\s*(```|~~~)`, a line that opens or closes a fenced code block.
pub fn is_fence(line: &str) -> bool {
    let rest = crate::pystr::lstrip(line);
    rest.starts_with("```") || rest.starts_with("~~~")
}

/// `(?:[*+-]|\d{1,9}\.)[ \t]*` matched at the start of `text`: its length in bytes.
fn bullet_len(text: &str) -> Option<usize> {
    let mut it = text.char_indices();
    let (_, first) = it.next()?;
    let mut end = if matches!(first, '*' | '+' | '-') {
        first.len_utf8()
    } else {
        // 1 to 9 digits and a dot (a longer run of digits cannot give characters back)
        let mut digits = 0;
        let mut at = 0;
        for (i, c) in text.char_indices() {
            if crate::pystr::is_decimal(c) {
                digits += 1;
                at = i + c.len_utf8();
                if digits > 9 {
                    return None;
                }
            } else {
                break;
            }
        }
        if digits == 0 || !text[at..].starts_with('.') {
            return None;
        }
        at + 1
    };
    end += text[end..].len() - text[end..].trim_start_matches([' ', '\t']).len();
    Some(end)
}

/// `\[[ xX]\][ \t]*` matched at the start of `text`: its length in bytes.
fn checkbox_len(text: &str) -> Option<usize> {
    let mut it = text.chars();
    if it.next() != Some('[') || !matches!(it.next(), Some(' ' | 'x' | 'X')) || it.next() != Some(']') {
        return None;
    }
    let end = 3;
    Some(end + text[end..].len() - text[end..].trim_start_matches([' ', '\t']).len())
}

/// `_TICKET.finditer(text)`: `\b([A-Z][A-Z0-9]{1,5}-\d+)\b`, as character ranges. `\b` and `\d` are Python's:
/// a combining mark does not count as a word character, an Arabic-Indic digit counts as a digit.
pub fn ticket_matches(chars: &[char]) -> Vec<(usize, usize)> {
    use crate::pystr::{is_decimal, is_word};
    let mut out = Vec::new();
    let mut i = 0;
    while i < chars.len() {
        if !chars[i].is_ascii_uppercase() || (i > 0 && is_word(chars[i - 1])) {
            i += 1;
            continue;
        }
        // [A-Z0-9]{1,5} then "-": the run cannot give characters back because "-" is not in it
        let mut j = i + 1;
        while j < chars.len() && (chars[j].is_ascii_uppercase() || chars[j].is_ascii_digit()) && j - i <= 6 {
            j += 1;
        }
        let run = j - i - 1;
        if !(1..=5).contains(&run) || chars.get(j) != Some(&'-') {
            i += 1;
            continue;
        }
        let d0 = j + 1;
        let mut k = d0;
        while k < chars.len() && is_decimal(chars[k]) {
            k += 1;
        }
        if k == d0 || chars.get(k).is_some_and(|&c| is_word(c)) {
            i += 1;
            continue;
        }
        out.push((i, k));
        i = k;
    }
    out
}

/// `_TICKET.search(text)`: the first ticket key in a text, if any.
pub fn first_ticket(text: &str) -> Option<String> {
    let chars: Vec<char> = text.chars().collect();
    ticket_matches(&chars).first().map(|&r| text_of(&chars, r))
}

/// What `_HeadingMatcher.match` gives: `group(1)` is the `#` run and `group(2)` the heading text.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HeadingMatch {
    /// The run of `#` (one to six).
    pub hashes: String,
    /// The heading text, without the closing `#` run.
    pub text: String,
}

/// `_HEADING.match(line)`: an ATX heading (`## Title ##`) without a regex: no backtracking on odd whitespace or `#`
/// runs.
pub fn heading_match(line: &str) -> Option<HeadingMatch> {
    let n = line.bytes().take(7).take_while(|&b| b == b'#').count();
    if !(1..=6).contains(&n) || !matches!(line.as_bytes().get(n), Some(b' ' | b'\t')) {
        return None;
    }
    let text = crate::pystr::strip(&line[n..]);
    let bare = text.trim_end_matches('#');
    let text = if bare != text && (bare.is_empty() || bare.ends_with([' ', '\t'])) {
        crate::pystr::rstrip(bare)
    } else {
        text
    };
    if text.is_empty() { None } else { Some(HeadingMatch { hashes: line[..n].to_string(), text: text.to_string() }) }
}

/// Drop a quote marker, list bullet or number (or `#` run) and a task checkbox from a line start.
///
/// `headings` also strips a leading `#` run.
pub fn strip_block_prefix(line: &str, headings: bool) -> String {
    use crate::pystr::lstrip_chars;
    let mut line = lstrip_chars(line, " \t>");
    while let Some(rest) = line.strip_prefix('>') {
        // "> > x" and ">  > x"
        line = lstrip_chars(rest, " \t>");
    }
    if headings {
        let hashes = line.len() - line.trim_start_matches('#').len();
        if (1..=6).contains(&hashes) {
            line = lstrip_chars(&line[hashes..], " \t");
        } else if let Some(n) = bullet_len(line) {
            line = &line[n..];
        }
    } else if let Some(n) = bullet_len(line) {
        line = &line[n..];
    }
    if let Some(n) = checkbox_len(line) {
        line = &line[n..];
    }
    line.to_string()
}

/// Lower-case, spaces to dashes, punctuation dropped (``Example request`` -> ``example-request``).
pub fn slugify(text: &str) -> String {
    use crate::pystr::{is_space, is_word};
    // re.sub(r"[^\w\s-]", "", text.lower())
    let kept: String = text.to_lowercase().chars().filter(|&c| is_word(c) || is_space(c) || c == '-').collect();
    // re.sub(r"[\s_]+", "-", slug.strip())
    let mut dashed = String::new();
    let mut in_run = false;
    for c in crate::pystr::strip(&kept).chars() {
        if is_space(c) || c == '_' {
            if !in_run {
                dashed.push('-');
            }
            in_run = true;
        } else {
            dashed.push(c);
            in_run = false;
        }
    }
    // re.sub(r"-{2,}", "-", slug).strip("-")
    let mut out = String::new();
    let mut prev_dash = false;
    for c in dashed.chars() {
        if c == '-' {
            if !prev_dash {
                out.push('-');
            }
            prev_dash = true;
        } else {
            out.push(c);
            prev_dash = false;
        }
    }
    out.trim_matches('-').to_string()
}

/// `_strip_inline`: a line as plain text: `[[page|label]]` and `[text](url)` become their label, emphasis marks go.
pub fn strip_inline(text: &str) -> String {
    // most lines have no link and no mark: then only the surrounding space goes
    if !text.contains(['[', '=', '*', '_', '`', '~']) {
        return crate::pystr::strip(text).to_string();
    }
    let text = link_labels(&ref_labels(text));
    // re.sub(r"==|[*_`~]", "", text).strip()
    let chars: Vec<char> = text.chars().collect();
    let mut out = String::new();
    let mut i = 0;
    while i < chars.len() {
        if chars[i] == '=' && chars.get(i + 1) == Some(&'=') {
            i += 2;
        } else if matches!(chars[i], '*' | '_' | '`' | '~') {
            i += 1;
        } else {
            out.push(chars[i]);
            i += 1;
        }
    }
    crate::pystr::strip(&out).to_string()
}

/// One heading of a page with its slug anchor.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct HeadingAnchor {
    /// 1 to 6.
    pub level: usize,
    /// The heading as plain text.
    pub text: String,
    /// The slug; a duplicate gets `-2`, `-3`...
    pub slug: String,
}

/// A least-recently-used cache of a parse per text (`functools.lru_cache` of the Python module): it counts its hits
/// and misses, and what it holds is shared (`Arc`), so a caller that changes its copy changes nobody else's.
struct TextCache<V> {
    capacity: usize,
    inner: Mutex<CacheState<V>>,
}

struct CacheState<V> {
    entries: HashMap<String, (Arc<V>, u64)>,
    clock: u64,
    hits: u64,
    misses: u64,
}

/// What `cache_info()` of an lru cache says.
#[cfg(test)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct CacheInfo {
    hits: u64,
    misses: u64,
    size: usize,
}

impl<V> TextCache<V> {
    fn new(capacity: usize) -> Self {
        Self { capacity, inner: Mutex::new(CacheState { entries: HashMap::new(), clock: 0, hits: 0, misses: 0 }) }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, CacheState<V>> {
        // a panic while the lock was held leaves nothing half-written: the entries are only inserted whole
        self.inner.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// The parse of `text`, from the cache or made by `parse` (outside the lock) and kept.
    fn get_or_parse(&self, text: &str, parse: impl FnOnce() -> V) -> Arc<V> {
        {
            let mut state = self.lock();
            state.clock += 1;
            let clock = state.clock;
            if let Some((value, used)) = state.entries.get_mut(text) {
                *used = clock;
                let value = value.clone();
                state.hits += 1;
                return value;
            }
            state.misses += 1;
        }
        let value = Arc::new(parse());
        let mut state = self.lock();
        state.clock += 1;
        let clock = state.clock;
        if state.entries.len() >= self.capacity && !state.entries.contains_key(text) {
            let oldest = state.entries.iter().min_by_key(|(_, (_, used))| *used).map(|(key, _)| key.clone());
            if let Some(oldest) = oldest {
                state.entries.remove(&oldest);
            }
        }
        state.entries.insert(text.to_string(), (value.clone(), clock));
        value
    }

    #[cfg(test)]
    fn cache_clear(&self) {
        let mut state = self.lock();
        state.entries.clear();
        state.hits = 0;
        state.misses = 0;
    }

    #[cfg(test)]
    fn cache_info(&self) -> CacheInfo {
        let state = self.lock();
        CacheInfo { hits: state.hits, misses: state.misses, size: state.entries.len() }
    }
}

/// Short texts (ticket descriptions, comments, criteria: hundreds of them are read to find the tickets that mention a
/// page) are kept apart, in a larger cache, so they do not push the pages out of theirs.
pub const SHORT_TEXT: usize = 2048;

/// `len(markdown) < SHORT_TEXT` (a length in characters).
fn is_short(markdown: &str) -> bool {
    markdown.len() < SHORT_TEXT || markdown.chars().count() < SHORT_TEXT
}

type Headings = Vec<HeadingAnchor>;
type ProseLines = Vec<(String, Option<String>, String)>;

static HEADINGS_CACHED: LazyLock<TextCache<Headings>> = LazyLock::new(|| TextCache::new(64));
static HEADINGS_SHORT: LazyLock<TextCache<Headings>> = LazyLock::new(|| TextCache::new(4096));
static PROSE_LINES_CACHED: LazyLock<TextCache<ProseLines>> = LazyLock::new(|| TextCache::new(32));
static PROSE_LINES_SHORT: LazyLock<TextCache<ProseLines>> = LazyLock::new(|| TextCache::new(4096));

/// Headings with their slug anchors; duplicates get ``-2``, ``-3``...
///
/// The same page is read for many requests (an agent reading a ticket reads the headings of every page that links it;
/// a page open reads those of the pages it links), so the result is kept per text and each call gets its own copy.
pub fn heading_anchors(markdown: &str) -> Vec<HeadingAnchor> {
    headings(markdown).as_ref().clone()
}

fn headings(markdown: &str) -> Arc<Headings> {
    let cache = if is_short(markdown) { &HEADINGS_SHORT } else { &HEADINGS_CACHED };
    cache.get_or_parse(markdown, || parse_headings(markdown))
}

fn parse_headings(markdown: &str) -> Headings {
    let mut out = Vec::new();
    let mut seen: std::collections::HashMap<String, usize> = std::collections::HashMap::new();
    let mut in_fence = false;
    for line in crate::pystr::splitlines(markdown) {
        if is_fence(line) {
            in_fence = !in_fence;
            continue;
        }
        if in_fence {
            continue;
        }
        let Some(m) = heading_match(line) else { continue };
        let text = strip_inline(&m.text);
        let mut base = slugify(&text);
        if base.is_empty() {
            base = "section".to_string();
        }
        let count = seen.get(&base).copied().unwrap_or(0) + 1;
        seen.insert(base.clone(), count);
        let slug = if count == 1 { base } else { format!("{base}-{count}") };
        out.push(HeadingAnchor { level: m.hashes.len(), text, slug });
    }
    out
}

/// (line without inline code, current section slug, raw line) for lines outside code fences. Kept per text, like the
/// headings: what is shared cannot be changed by a caller.
fn prose_lines(markdown: &str) -> Arc<ProseLines> {
    let cache = if is_short(markdown) { &PROSE_LINES_SHORT } else { &PROSE_LINES_CACHED };
    cache.get_or_parse(markdown, || parse_prose_lines(markdown))
}

fn parse_prose_lines(markdown: &str) -> ProseLines {
    // {a["text"]: a["slug"] ...}: the last heading with a text wins
    let anchors: std::collections::HashMap<String, String> =
        headings(markdown).iter().map(|a| (a.text.clone(), a.slug.clone())).collect();
    let mut section: Option<String> = None;
    let mut in_fence = false;
    let mut out = Vec::new();
    for raw in crate::pystr::splitlines(markdown) {
        if is_fence(raw) {
            in_fence = !in_fence;
            continue;
        }
        if in_fence {
            continue;
        }
        if let Some(m) = heading_match(raw) {
            if let Some(slug) = anchors.get(&strip_inline(&m.text)) {
                section = Some(slug.clone());
            }
        }
        out.push((remove_inline_code(raw), section.clone(), raw.to_string()));
    }
    out
}

/// A `[[page]]` reference found in a page.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct PageReference {
    /// Always `"page"`.
    pub kind: &'static str,
    /// The page title.
    pub title: String,
    /// The `#section` part, if any.
    pub anchor: Option<String>,
    /// The `|label` part, if any.
    pub display: Option<String>,
    /// Slug of the section it sits in.
    pub section: Option<String>,
    /// A context snippet.
    pub snippet: String,
}

/// A ticket key found in a page.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct TicketReference {
    /// Always `"ticket"`.
    pub kind: &'static str,
    /// The ticket key.
    pub key: String,
    /// Slug of the section it sits in.
    pub section: Option<String>,
    /// A context snippet.
    pub snippet: String,
}

/// One entry of `parse_references`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(untagged)]
pub enum Reference {
    /// A `[[page]]` reference.
    Page(PageReference),
    /// A ticket key.
    Ticket(TicketReference),
}

/// `(m.group(i) or "").strip() or None`.
fn stripped_or_none(chars: &[char], range: Option<(usize, usize)>) -> Option<String> {
    let text = range.map(|r| text_of(chars, r)).unwrap_or_default();
    let text = crate::pystr::strip(&text);
    if text.is_empty() { None } else { Some(text.to_string()) }
}

/// Every [[page]] and ticket-key reference with its section and a context snippet.
pub fn parse_references(markdown: &str) -> Vec<Reference> {
    let mut refs = Vec::new();
    for (line, section, raw) in prose_lines(markdown).iter() {
        let snippet = crate::pystr::head(&strip_block_prefix(&strip_inline(raw), false), 160).to_string();
        let chars: Vec<char> = line.chars().collect();
        let found = find_refs(&chars, 1);
        for m in &found {
            refs.push(Reference::Page(PageReference {
                kind: "page",
                title: crate::pystr::strip(&text_of(&chars, m.title)).to_string(),
                anchor: stripped_or_none(&chars, m.anchor),
                display: stripped_or_none(&chars, m.display),
                section: section.clone(),
                snippet: snippet.clone(),
            }));
        }
        // stripped = _REF.sub("", line)
        let mut stripped: Vec<char> = Vec::new();
        let mut last = 0;
        for m in &found {
            stripped.extend(&chars[last..m.start]);
            last = m.end;
        }
        stripped.extend(&chars[last..]);
        for r in ticket_matches(&stripped) {
            refs.push(Reference::Ticket(TicketReference {
                kind: "ticket",
                key: text_of(&stripped, r),
                section: section.clone(),
                snippet: snippet.clone(),
            }));
        }
    }
    refs
}

/// `^\s*(?:>\s*)*(?:[*+-]|\d+\.)?\s*(?:\[[ xX]\]\s*)?` removed from a line start (the regex of `sentence_around` and
/// `ref_excerpt`; everything in it is optional, so the first greedy path is the match).
fn remove_line_prefix(line: &[char]) -> Vec<char> {
    use crate::pystr::{is_decimal, is_space};
    let skip_ws = |mut p: usize| {
        while p < line.len() && is_space(line[p]) {
            p += 1;
        }
        p
    };
    let mut p = skip_ws(0);
    while line.get(p) == Some(&'>') {
        p = skip_ws(p + 1);
    }
    if matches!(line.get(p), Some('*' | '+' | '-')) {
        p += 1;
    } else {
        let mut q = p;
        while q < line.len() && is_decimal(line[q]) {
            q += 1;
        }
        if q > p && line.get(q) == Some(&'.') {
            p = q + 1;
        }
    }
    p = skip_ws(p);
    if line.get(p) == Some(&'[') && matches!(line.get(p + 1), Some(' ' | 'x' | 'X')) && line.get(p + 2) == Some(&']') {
        p = skip_ws(p + 3);
    }
    line[p..].to_vec()
}

fn chars_str(chars: &[char]) -> String {
    chars.iter().collect()
}

/// Return the sentence of a line that contains a needle, as plain text.
///
/// `limit` is the maximum length of the excerpt (Python's default is 200).
pub fn sentence_around(raw: &str, needle: &str, limit: usize) -> String {
    use crate::pystr::{head, is_space};
    let stripped: Vec<char> = crate::pystr::strip(raw).chars().collect();
    let plain_line = remove_line_prefix(&stripped);
    let plain = chars_str(&plain_line);
    let Some(pos) = crate::pystr::find(&plain, needle) else {
        return head(&strip_inline(&plain), limit).to_string();
    };
    let sentence_end = |c: char| matches!(c, '.' | '!' | '?');
    // for m in re.finditer(r"(?<=[.!?])\s+", plain_line[:pos]): start = m.end()
    let mut start = 0;
    let before = &plain_line[..pos];
    let mut i = 1;
    while i < before.len() {
        if sentence_end(before[i - 1]) && is_space(before[i]) {
            let mut j = i;
            while j < before.len() && is_space(before[j]) {
                j += 1;
            }
            start = j;
            i = j;
        } else {
            i += 1;
        }
    }
    // end_m = re.search(r"(?<=[.!?])\s", plain_line[pos + len(needle):])
    let after_from = pos + needle.chars().count();
    let after = &plain_line[after_from.min(plain_line.len())..];
    let end_at = (1..after.len()).find(|&k| sentence_end(after[k - 1]) && is_space(after[k]));
    let end = match end_at {
        Some(k) => after_from + k + 1,
        None => plain_line.len(),
    };
    head(&strip_inline(&chars_str(&plain_line[start..end])), limit).to_string()
}

/// Cut about `width` characters around a reference, keeping the reference itself as `[[...]]`.
///
/// The UI turns the kept reference into a chip ("...the token rules live in [Data model] and the column
/// schema..."); other Markdown around it is flattened to plain text. `width` is Python's `120` by default.
pub fn ref_excerpt(raw: &str, needle: &str, width: usize) -> String {
    use crate::pystr::{head, len, lstrip, rstrip, tail};
    let stripped: Vec<char> = crate::pystr::strip(raw).chars().collect();
    let line_chars = remove_line_prefix(&stripped);
    let line = chars_str(&line_chars);
    let Some(pos) = crate::pystr::find(&line, needle) else {
        return head(&strip_inline(&line), width).to_string();
    };
    let flat = |text: &str| -> String {
        link_labels(&ref_labels(text)).chars().filter(|c| !matches!(c, '*' | '_' | '`' | '~')).collect()
    };
    let needle_len = needle.chars().count();
    let before_text = flat(&chars_str(&line_chars[..pos]));
    let after_text = flat(&chars_str(&line_chars[pos + needle_len..]));
    let mut before = lstrip(&before_text).to_string();
    let mut after = rstrip(&after_text).to_string();
    let half = std::cmp::max(20, (width as i64 - needle_len as i64).div_euclid(2)) as usize;
    let cut_before = len(&before) > half;
    let cut_after = len(&after) > half;
    if cut_before {
        before = tail(&before, half).to_string();
        if let Some(b) = crate::pystr::find(&before, " ") {
            before = before.chars().skip(b + 1).collect();
        }
    }
    if cut_after {
        after = head(&after, half).to_string();
        if let Some(b) = after.rfind(' ') {
            after = after[..b].to_string();
        }
    }
    format!("{}{before}{needle}{after}{}", if cut_before { "… " } else { "" }, if cut_after { " …" } else { "" })
}

/// `_map_outside_code`: apply `f` to the text between spans of inline code and keep the code as it is.
fn map_outside_code(line: &str, mut f: impl FnMut(&str) -> String) -> String {
    let chars: Vec<char> = line.chars().collect();
    let mut out = String::new();
    let mut last = 0;
    for (a, b) in inline_code_spans(&chars) {
        out.push_str(&f(&chars_str(&chars[last..a])));
        out.push_str(&chars_str(&chars[a..b]));
        last = b;
    }
    out.push_str(&f(&chars_str(&chars[last..])));
    out
}

/// Point `[[Old]]`, `[[Old#S]]` and `[[Old|label]]` at a new title, leaving code alone.
///
/// Returns `(new markdown, number of links rewritten)`.
pub fn rewrite_page_links(markdown: &str, old_title: &str, new_title: &str) -> (String, usize) {
    let needle = crate::pystr::strip(old_title).to_lowercase();
    let mut count = 0;
    let mut sub = |text: &str| -> String {
        let chars: Vec<char> = text.chars().collect();
        let mut out = String::new();
        let mut last = 0;
        for m in find_refs(&chars, 1) {
            out.extend(&chars[last..m.start]);
            last = m.end;
            if crate::pystr::strip(&text_of(&chars, m.title)).to_lowercase() != needle {
                out.extend(&chars[m.start..m.end]);
                continue;
            }
            count += 1;
            let anchor = m.anchor.map(|r| format!("#{}", text_of(&chars, r))).unwrap_or_default();
            let label = m.display.map(|r| format!("|{}", text_of(&chars, r))).unwrap_or_default();
            out.push_str(&format!("[[{new_title}{anchor}{label}]]"));
        }
        out.extend(&chars[last..]);
        out
    };
    let mut out: Vec<String> = Vec::new();
    let mut in_fence = false;
    for raw in markdown.split('\n') {
        if is_fence(raw) {
            in_fence = !in_fence;
            out.push(raw.to_string());
            continue;
        }
        out.push(if in_fence { raw.to_string() } else { map_outside_code(raw, &mut sub) });
    }
    (out.join("\n"), count)
}

/// Count `[[title]]` links to a page in some Markdown.
pub fn count_page_links(markdown: &str, title: &str) -> usize {
    rewrite_page_links(markdown, title, title).1
}

/// A `[[page]]` reference with the sentence it sits in (for "Referenced by" and ticket mentions).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct PageRefContext {
    /// The page title.
    pub title: String,
    /// The `#section` part, if any.
    pub anchor: Option<String>,
    /// Slug of the section it sits in.
    pub section: Option<String>,
    /// The sentence the reference is in.
    pub context: String,
    /// About 120 characters around it.
    pub excerpt: String,
}

/// Every [[page]] reference with the sentence it sits in (for 'Referenced by' and ticket mentions).
///
/// `titles`: keep only references to these (lower-cased) titles; `None` keeps all.
pub fn page_ref_contexts(markdown: &str, titles: Option<&HashSet<String>>) -> Vec<PageRefContext> {
    let mut out = Vec::new();
    for (line, section, _raw) in prose_lines(markdown).iter() {
        let chars: Vec<char> = line.chars().collect();
        for m in find_refs(&chars, 1) {
            let title = crate::pystr::strip(&text_of(&chars, m.title)).to_string();
            if titles.is_some_and(|titles| !titles.contains(&title.to_lowercase())) {
                continue;
            }
            let whole = chars_str(&chars[m.start..m.end]);
            out.push(PageRefContext {
                title,
                anchor: stripped_or_none(&chars, m.anchor),
                section: section.clone(),
                context: sentence_around(line, &whole, 200),
                excerpt: ref_excerpt(line, &whole, 120),
            });
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn docs_error_carries_status_code_message_and_extra_fields() {
        let err = DocsError::new(409, "conflict", "The page changed.").with("current_version", 3).with("by", "Ada");
        assert_eq!((err.status, err.code.as_str(), err.message.as_str()), (409, "conflict", "The page changed."));
        assert_eq!(err.to_string(), "The page changed.");
        let keys: Vec<&String> = err.extra.keys().collect();
        assert_eq!(keys, ["current_version", "by"]);
        assert_eq!(err.extra["current_version"], 3);
    }

    /// `tests/test_docs_text_cache.py`: the headings and prose lines of a page are parsed once per text and shared,
    /// without a caller able to change them. The caches are process-wide, so these tests run one after the other.
    static CACHE_TESTS: Mutex<()> = Mutex::new(());

    fn serial() -> std::sync::MutexGuard<'static, ()> {
        CACHE_TESTS.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    #[test]
    fn test_headings_are_parsed_once_and_each_caller_gets_its_own_copy() {
        let _one_at_a_time = serial();
        let md = "# Title\n\n## Setup\n\ntext\n\n## Setup\n\n```\n## not a heading\n```\n";
        HEADINGS_SHORT.cache_clear();
        let mut first = heading_anchors(md);
        let slugs = |list: &[HeadingAnchor]| list.iter().map(|h| h.slug.clone()).collect::<Vec<_>>();
        assert_eq!(slugs(&first), ["title", "setup", "setup-2"]);
        first[0].slug = "changed".to_string();
        first.push(HeadingAnchor { level: 1, text: String::new(), slug: "extra".to_string() });
        let again = heading_anchors(md);
        assert_eq!(slugs(&again), ["title", "setup", "setup-2"]);
        assert!(HEADINGS_SHORT.cache_info().hits >= 1);
    }

    #[test]
    fn test_page_references_come_from_the_shared_parse() {
        let _one_at_a_time = serial();
        let md = "## Intro\n\nSee [[Spec]] and [[Plan#Goals]].\n";
        PROSE_LINES_SHORT.cache_clear();
        let refs = page_ref_contexts(md, None);
        let found: Vec<(&str, Option<&str>)> = refs.iter().map(|r| (r.title.as_str(), r.section.as_deref())).collect();
        assert_eq!(found, [("Spec", Some("intro")), ("Plan", Some("intro"))]);
        let only_plan: HashSet<String> = ["plan".to_string()].into();
        assert_eq!(page_ref_contexts(md, Some(&only_plan))[0].anchor.as_deref(), Some("Goals"));
        assert!(PROSE_LINES_SHORT.cache_info().hits >= 1);
    }

    /// Reading the tickets that mention a page parses hundreds of comments: the page stays parsed.
    #[test]
    fn test_many_short_texts_do_not_push_a_page_out_of_the_cache() {
        let _one_at_a_time = serial();
        let page =
            format!("# Spec\n\n{}", (0..200).map(|i| format!("## Part {i}\n\nSee [[Plan]].\n\n")).collect::<String>());
        assert!(page.chars().count() >= SHORT_TEXT);
        PROSE_LINES_CACHED.cache_clear();
        page_ref_contexts(&page, None);
        for i in 0..500 {
            page_ref_contexts(&format!("Comment {i}: see [[Spec]]."), None);
        }
        page_ref_contexts(&page, None);
        assert!(PROSE_LINES_CACHED.cache_info().hits >= 1);
    }

    #[test]
    fn the_cache_keeps_the_most_recently_used_texts_up_to_its_size() {
        let cache: TextCache<usize> = TextCache::new(2);
        let parse = |n: usize| move || n;
        cache.get_or_parse("a", parse(1));
        cache.get_or_parse("b", parse(2));
        cache.get_or_parse("a", parse(1)); // a is the latest used
        cache.get_or_parse("c", parse(3)); // b goes
        assert_eq!(cache.cache_info(), CacheInfo { hits: 1, misses: 3, size: 2 });
        cache.get_or_parse("a", parse(1));
        assert_eq!(cache.cache_info().hits, 2);
        cache.get_or_parse("b", parse(2));
        assert_eq!(cache.cache_info().misses, 4);
    }
}
