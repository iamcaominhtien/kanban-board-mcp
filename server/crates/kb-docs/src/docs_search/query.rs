//! Query parsing and snippets (`services/docs_search.py` lines 237-401).

use std::collections::HashSet;

use kb_base::pytext;
use kb_doctext::docs_text::{heading_anchors, heading_match, is_fence, strip_block_prefix, strip_inline};
use kb_doctext::pystr::is_word;
use regex::RegexBuilder;
use serde_json::{Map, Value, json};

use crate::util::{casefold, html_escape};

/// At most this many words of a query count.
pub const MAX_TERMS: usize = 12;
/// A query is cut to this many characters.
pub const MAX_QUERY: usize = 300;

/// Strip leading / trailing non-word characters (linear; `^\W+|\W+$` is quadratic).
fn trim_nonword(text: &str) -> String {
    let chars: Vec<char> = text.chars().collect();
    let (mut start, mut end) = (0, chars.len());
    while start < end && !is_word(chars[start]) {
        start += 1;
    }
    while end > start && !is_word(chars[end - 1]) {
        end -= 1;
    }
    chars[start..end].iter().collect()
}

/// `_TOKEN.findall(q)` with `_TOKEN = re.compile(r'-?"[^"]*"|\S+')`.
fn tokens(q: &str) -> Vec<String> {
    let chars: Vec<char> = q.chars().collect();
    let n = chars.len();
    let mut out = Vec::new();
    let mut i = 0;
    while i < n {
        if pytext::is_space(chars[i]) || ('\u{1c}'..='\u{1f}').contains(&chars[i]) {
            i += 1;
            continue;
        }
        let start = i;
        let q_at = if chars[i] == '-' { i + 1 } else { i };
        if q_at < n && chars[q_at] == '"' {
            if let Some(k) = chars[q_at + 1..].iter().position(|&c| c == '"') {
                let end = q_at + 1 + k + 1;
                out.push(chars[start..end].iter().collect());
                i = end;
                continue;
            }
        }
        while i < n && !(pytext::is_space(chars[i]) || ('\u{1c}'..='\u{1f}').contains(&chars[i])) {
            i += 1;
        }
        out.push(chars[start..i].iter().collect());
    }
    out
}

/// Parsed search query: words, quoted phrases and `-excluded` terms.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Query {
    /// Words (ANDed, prefix matched).
    pub words: Vec<String>,
    /// Phrases that must match as written.
    pub phrases: Vec<String>,
    /// Terms that must not appear.
    pub excludes: Vec<String>,
}

impl Query {
    /// Tokenize `q` (truncated to the maximum length).
    pub fn new(q: &str) -> Self {
        let mut query = Query::default();
        let q: String = q.chars().take(MAX_QUERY).collect();
        for tok in tokens(&q) {
            let neg = tok.starts_with('-') && tok.chars().count() > 1;
            let mut body: String = if neg { tok[1..].to_string() } else { tok.clone() };
            let phrase = body.starts_with('"');
            if phrase {
                body = body.trim_matches('"').to_string();
            }
            let body = trim_nonword(&body);
            let body = pytext::split(&body).join(" ");
            if !body.chars().any(is_word) {
                continue;
            }
            if neg {
                query.excludes.push(body);
            } else if phrase {
                query.phrases.push(body);
            } else {
                query.words.push(body);
            }
        }
        query.words.truncate(MAX_TERMS);
        query
    }

    /// The terms that must match (words and phrases).
    pub fn positive(&self) -> Vec<String> {
        self.words.iter().chain(self.phrases.iter()).cloned().collect()
    }

    /// The FTS5 MATCH expression for this query.
    pub fn fts(&self) -> String {
        fn quote(s: &str) -> String {
            format!("\"{}\"", s.replace('"', "\"\""))
        }
        let pos: Vec<String> =
            self.words.iter().map(|w| format!("{}*", quote(w))).chain(self.phrases.iter().map(|p| quote(p))).collect();
        let mut expr = pos.join(" AND ");
        if !self.excludes.is_empty() {
            expr =
                format!("({expr}) NOT ({})", self.excludes.iter().map(|e| quote(e)).collect::<Vec<_>>().join(" OR "));
        }
        expr
    }
}

/// `needle.casefold() in haystack.casefold()`.
pub(crate) fn contains(haystack: &str, needle: &str) -> bool {
    casefold(haystack).contains(&casefold(needle))
}

/// A page or ticket passes when every positive term is in the fields and no excluded one is.
pub(crate) fn passes(query: &Query, fields: &[&str]) -> bool {
    let blob = fields.join("\n");
    query.positive().iter().all(|t| contains(&blob, t)) && !query.excludes.iter().any(|e| contains(&blob, e))
}

/// HTML-escape text and wrap occurrences of the terms in `<mark>`.
///
/// `terms` are matched case-insensitively; the result is safe HTML.
pub fn highlight(plain: &str, terms: &[String]) -> String {
    Marker::new(terms).mark(plain)
}

/// `highlight` with its pattern built once, for marking many snippets with the same terms (building the
/// case-insensitive pattern costs far more than using it; Python's `re` keeps compiled patterns in a cache).
pub struct Marker {
    rx: Option<regex::Regex>,
}

impl Marker {
    /// The pattern of `terms`: longest first, as `sorted(..., key=len, reverse=True)`. None when there is no term.
    pub fn new(terms: &[String]) -> Self {
        let mut seen = HashSet::new();
        let mut terms: Vec<&String> = terms.iter().filter(|t| !t.is_empty() && seen.insert(*t)).collect();
        terms.sort_by_key(|t| std::cmp::Reverse(t.chars().count()));
        if terms.is_empty() {
            return Marker { rx: None };
        }
        let pattern = terms.iter().map(|t| regex::escape(t)).collect::<Vec<_>>().join("|");
        Marker { rx: RegexBuilder::new(&pattern).case_insensitive(true).build().ok() }
    }

    /// HTML-escape `plain` and wrap each occurrence of a term in `<mark>`.
    pub fn mark(&self, plain: &str) -> String {
        let Some(rx) = &self.rx else { return html_escape(plain) };
        let mut out = String::new();
        let mut last = 0;
        for m in rx.find_iter(plain) {
            out.push_str(&html_escape(&plain[last..m.start()]));
            out.push_str(&format!("<mark>{}</mark>", html_escape(m.as_str())));
            last = m.end();
        }
        out.push_str(&html_escape(&plain[last..]));
        out
    }
}

/// A window of about `width` characters around the first hit (positions as Python reads them: an index into the
/// case-folded text is used on the original).
pub(crate) fn window(plain: &str, terms: &[String], width: usize) -> String {
    let low = casefold(plain);
    let pos = terms
        .iter()
        .filter_map(|t| {
            let needle = casefold(t);
            low.find(&needle).map(|b| low[..b].chars().count())
        })
        .min()
        .unwrap_or(0);
    let total = plain.chars().count();
    let start = pos.saturating_sub(width / 3);
    let end = total.min(start + width);
    let chunk: String = plain.chars().skip(start).take(end.saturating_sub(start)).collect();
    let chunk = pytext::strip(&chunk);
    format!("{}{}{}", if start > 0 { "… " } else { "" }, chunk, if end < total { " …" } else { "" })
}

/// `_plain_line`: a line as plain text.
pub(crate) fn plain_line(raw: &str) -> String {
    strip_inline(&strip_block_prefix(raw, true))
}

/// The sections whose text contains a term, each with a marked snippet: `{section, slug, snippet}`.
pub fn build_matches(markdown: &str, terms: &[String], headings_only: bool, limit: usize) -> Vec<Map<String, Value>> {
    let marker = Marker::new(terms);
    let mut out = Vec::new();
    scan_matches(markdown, terms, headings_only, limit, |section, slug, plain| {
        let mut m = Map::new();
        m.insert("section".into(), section.map(Value::from).unwrap_or(Value::Null));
        m.insert("slug".into(), slug.map(Value::from).unwrap_or(Value::Null));
        m.insert("snippet".into(), json!(marker.mark(&window(plain, terms, 150))));
        out.push(m);
    });
    out
}

/// How many sections `build_matches` would list, without making their snippets.
pub fn count_matches(markdown: &str, terms: &[String], headings_only: bool, limit: usize) -> usize {
    let mut n = 0;
    scan_matches(markdown, terms, headings_only, limit, |_, _, _| n += 1);
    n
}

/// The walk of `build_matches`: `found(section text, slug, the line as plain text)` for the first line of each
/// section that holds a term, at most `limit` times.
fn scan_matches(
    markdown: &str,
    terms: &[String],
    headings_only: bool,
    limit: usize,
    mut found: impl FnMut(Option<&str>, Option<&str>, &str),
) {
    let folded: Vec<String> = terms.iter().map(|t| casefold(t)).collect();
    let anchors = heading_anchors(markdown);
    let mut section: Option<&kb_doctext::docs_text::HeadingAnchor> = None;
    let mut idx = 0;
    let mut in_fence = false;
    let mut seen: HashSet<Option<&str>> = HashSet::new();
    let mut count = 0;
    for raw in pytext::splitlines(markdown) {
        if is_fence(raw) {
            in_fence = !in_fence;
            continue;
        }
        let mut is_heading = false;
        if !in_fence && heading_match(raw).is_some() {
            is_heading = true;
            if idx < anchors.len() {
                section = Some(&anchors[idx]);
                idx += 1;
            }
        }
        if headings_only && !is_heading {
            continue;
        }
        let plain = plain_line(raw);
        if plain.is_empty() {
            continue;
        }
        // `contains(plain, t)` for each term, with the line case-folded once
        let low = casefold(&plain);
        if !folded.iter().any(|t| low.contains(t.as_str())) {
            continue;
        }
        let key = section.map(|s| s.slug.as_str());
        if !seen.insert(key) {
            continue;
        }
        found(section.map(|s| s.text.as_str()), key, &plain);
        count += 1;
        if count >= limit {
            break;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn queries_split_into_words_phrases_and_exclusions() {
        let q = Query::new("  hello \"big world\" -skip -\"not this\" ..x.. -- #");
        assert_eq!(q.words, vec!["hello", "x"]);
        assert_eq!(q.phrases, vec!["big world"]);
        assert_eq!(q.excludes, vec!["skip", "not this"]);
        assert_eq!(q.fts(), "(\"hello\"* AND \"x\"* AND \"big world\") NOT (\"skip\" OR \"not this\")");
        // an unclosed quote: `"abc` is one token (`\S+`) that starts with a quote, so it is a phrase
        let open = Query::new("\"abc def");
        assert_eq!((open.words, open.phrases), (vec!["def".to_string()], vec!["abc".to_string()]));
    }

    #[test]
    fn highlight_marks_and_escapes() {
        assert_eq!(highlight("a <B> b", &["b".to_string()]), "a &lt;<mark>B</mark>&gt; <mark>b</mark>");
        assert_eq!(highlight("x & y", &[]), "x &amp; y");
    }

    #[test]
    fn a_window_has_ellipses_where_it_cuts() {
        let text = format!("{} needle {}", "a".repeat(200), "b".repeat(200));
        let w = window(&text, &["needle".to_string()], 150);
        assert!(w.starts_with("… ") && w.ends_with(" …") && w.contains("needle"));
    }
}
