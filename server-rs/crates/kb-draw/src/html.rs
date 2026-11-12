//! Python's `html.escape` and `html.unescape`, and `html.parser.HTMLParser` (the lenient tokenizer, as the Python
//! 3.12 of the reference server has it, with the HTML5-style fixes for comments, CDATA and raw text elements).

use std::sync::OnceLock;

use regex::Regex;

use crate::html_entities::{INVALID_CHARREFS, INVALID_CODEPOINTS, NAMED};

/// `html.escape(text, quote=True)`.
pub fn escape(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#x27;"),
            c => out.push(c),
        }
    }
    out
}

fn named(name: &str) -> Option<&'static str> {
    NAMED.binary_search_by(|(k, _)| (*k).cmp(name)).ok().map(|i| NAMED[i].1)
}

fn charref() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"&(#[0-9]+;?|#[xX][0-9a-fA-F]+;?|[^\t\n\x0c <&#;]{1,32};?)").expect("static pattern"))
}

fn replace_charref(s: &str) -> String {
    if let Some(rest) = s.strip_prefix('#') {
        let (digits, radix) = match rest.strip_prefix(['x', 'X']) {
            Some(hex) => (hex, 16),
            None => (rest, 10),
        };
        let digits = digits.trim_end_matches(';');
        // a number too big for u32 is above 0x10FFFF as well
        let num = u32::from_str_radix(digits, radix).unwrap_or(u32::MAX);
        if let Some((_, text)) = INVALID_CHARREFS.iter().find(|(n, _)| *n == num) {
            return (*text).to_string();
        }
        if (0xD800..=0xDFFF).contains(&num) || num > 0x10FFFF {
            return "\u{fffd}".to_string();
        }
        if INVALID_CODEPOINTS.contains(&num) {
            return String::new();
        }
        return char::from_u32(num).map(String::from).unwrap_or_default();
    }
    if let Some(text) = named(s) {
        return text.to_string();
    }
    // the longest matching name (as the HTML standard defines)
    let chars: Vec<(usize, char)> = s.char_indices().collect();
    for x in (2..chars.len()).rev() {
        let cut = chars[x].0;
        if let Some(text) = named(&s[..cut]) {
            return format!("{text}{}", &s[cut..]);
        }
    }
    format!("&{s}")
}

/// `html.unescape(text)`.
pub fn unescape(text: &str) -> String {
    if !text.contains('&') {
        return text.to_string();
    }
    charref().replace_all(text, |caps: &regex::Captures| replace_charref(&caps[1])).into_owned()
}


// --- html.parser.HTMLParser (convert_charrefs=True, scripting=False) -----------------------------------------------

/// The handlers of `HTMLParser` that a caller overrides (comments, declarations and processing instructions are
/// parsed to find where they end, and dropped).
pub trait Handler {
    /// `handle_starttag(tag, attrs)`; `attrs` are `(name, value)` with a `None` value for a bare attribute.
    fn handle_starttag(&mut self, tag: &str, attrs: &[(String, Option<String>)]);
    /// `handle_endtag(tag)`.
    fn handle_endtag(&mut self, tag: &str);
    /// `handle_data(data)`.
    fn handle_data(&mut self, data: &str);
    /// `handle_startendtag(tag, attrs)`: a start tag then an end tag, unless the handler says otherwise.
    fn handle_startendtag(&mut self, tag: &str, attrs: &[(String, Option<String>)]) {
        self.handle_starttag(tag, attrs);
        self.handle_endtag(tag);
    }
}

/// `p = Handler(); p.feed(source); p.close()` for a parser with the default `convert_charrefs=True`.
pub fn parse<H: Handler>(source: &str, handler: &mut H) {
    let mut p = Parser { raw: source.chars().collect(), cdata: None, escapable: true, h: handler };
    // `feed` parses what it can (`goahead(0)`), `close` the rest (`goahead(1)`)
    if !p.raw.is_empty() {
        p.goahead(false);
    }
    p.goahead(true);
}

const CDATA_CONTENT_ELEMENTS: [&str; 6] = ["script", "style", "xmp", "iframe", "noembed", "noframes"];
const RCDATA_CONTENT_ELEMENTS: [&str; 2] = ["textarea", "title"];

/// `[\t\n\r\f ]`.
fn ws(c: char) -> bool {
    matches!(c, '\t' | '\n' | '\r' | '\x0c' | ' ')
}

/// `[\t\n\r\f /]`.
fn ws_slash(c: char) -> bool {
    ws(c) || c == '/'
}

fn ascii_alpha(c: char) -> bool {
    c.is_ascii_alphabetic()
}

struct Parser<'h, H> {
    raw: Vec<char>,
    cdata: Option<String>,
    escapable: bool,
    h: &'h mut H,
}

/// The end of a value (`'[^']*'|"[^"]*"|(?!['"])[^>\t\n\r\f ]*`) that starts at `p`.
fn value_at(raw: &[char], p: usize) -> Option<usize> {
    match raw.get(p) {
        Some(&q @ ('\'' | '"')) => raw[p + 1..].iter().position(|&c| c == q).map(|e| p + 1 + e + 1),
        _ => {
            let mut e = p;
            while e < raw.len() && raw[e] != '>' && !ws(raw[e]) {
                e += 1;
            }
            Some(e)
        }
    }
}

/// The optional value part of an attribute that follows its name at `q`: `(group end, value start, value end)`.
/// The regex gives back whitespace after the `=` when the value that follows is an unclosed quote: an empty bare value
/// is then found before the last blank.
fn value_group(raw: &[char], q: usize) -> Option<(usize, usize, usize)> {
    let mut r = q;
    while r < raw.len() && ws(raw[r]) {
        r += 1;
    }
    if r >= raw.len() || raw[r] != '=' {
        return None;
    }
    let s = r + 1;
    let mut t = s;
    while t < raw.len() && ws(raw[t]) {
        t += 1;
    }
    if let Some(e) = value_at(raw, t) {
        return Some((e, t, e));
    }
    if t > s { Some((t - 1, t - 1, t - 1)) } else { None }
}

/// `tagfind_tolerant.match(raw, i)`: `(end of the name, end of the match)`.
fn tagfind(raw: &[char], i: usize) -> Option<(usize, usize)> {
    if !raw.get(i).is_some_and(|&c| ascii_alpha(c)) {
        return None;
    }
    let mut e = i + 1;
    while e < raw.len() && !(ws_slash(raw[e]) || raw[e] == '>') {
        e += 1;
    }
    let mut k = e;
    while k < raw.len() {
        if ws(raw[k]) || (raw[k] == '/' && raw.get(k + 1) != Some(&'>')) {
            k += 1;
        } else {
            break;
        }
    }
    Some((e, k))
}

/// `locatetagend.match(raw, start).end()`: where a start or end tag that begins at `start` (its name) ends.
fn locatetagend(raw: &[char], start: usize) -> usize {
    let n = raw.len();
    let mut p = start + 1;
    while p < n && !(ws_slash(raw[p]) || raw[p] == '>') {
        p += 1;
    }
    while p < n && ws_slash(raw[p]) {
        p += 1;
    }
    loop {
        // the attribute name must follow a quote, a blank or a slash
        if !matches!(raw[p - 1], '\'' | '"') && !ws_slash(raw[p - 1]) {
            break;
        }
        if p >= n || ws_slash(raw[p]) || raw[p] == '>' {
            break;
        }
        let mut q = p + 1;
        while q < n && !(ws_slash(raw[q]) || raw[q] == '=' || raw[q] == '>') {
            q += 1;
        }
        if let Some((end, _, _)) = value_group(raw, q) {
            q = end;
        }
        while q < n && ws_slash(raw[q]) {
            q += 1;
        }
        p = q;
    }
    if p < n && raw[p] == '>' {
        p += 1;
    }
    p
}

/// `attrfind_tolerant.match(raw, k)`: `(name, value, end)`.
#[allow(clippy::type_complexity)]
fn attrfind(raw: &[char], k: usize) -> Option<(String, Option<String>, usize)> {
    let n = raw.len();
    if k == 0 || !(matches!(raw[k - 1], '\'' | '"') || ws_slash(raw[k - 1])) {
        return None;
    }
    if k >= n || ws_slash(raw[k]) || raw[k] == '>' {
        return None;
    }
    let mut q = k + 1;
    while q < n && !(ws_slash(raw[q]) || raw[q] == '=' || raw[q] == '>') {
        q += 1;
    }
    let name: String = raw[k..q].iter().collect();
    let mut value = None;
    if let Some((end, vs, ve)) = value_group(raw, q) {
        q = end;
        value = Some(raw[vs..ve].iter().collect::<String>());
    }
    while q < n {
        if ws(raw[q]) || (raw[q] == '/' && raw.get(q + 1) != Some(&'>')) {
            q += 1;
        } else {
            break;
        }
    }
    Some((name, value, q))
}

fn starts(raw: &[char], i: usize, pat: &str) -> bool {
    let mut at = i;
    for c in pat.chars() {
        if raw.get(at) != Some(&c) {
            return false;
        }
        at += 1;
    }
    true
}

fn find_char(raw: &[char], c: char, from: usize) -> Option<usize> {
    raw.get(from..)?.iter().position(|&x| x == c).map(|p| from + p)
}

fn find_str(raw: &[char], pat: &str, from: usize) -> Option<usize> {
    let pat: Vec<char> = pat.chars().collect();
    if from > raw.len() || raw.len() - from < pat.len() {
        return None;
    }
    (from..=raw.len() - pat.len()).find(|&i| raw[i..i + pat.len()] == pat[..])
}

impl<H: Handler> Parser<'_, H> {
    fn text(&self, a: usize, b: usize) -> String {
        self.raw[a.min(self.raw.len())..b.min(self.raw.len())].iter().collect()
    }

    /// `self.interesting.search(raw, i)` in raw-text mode: `</elem` (any ASCII case) followed by a blank, `/` or
    /// `>`; `\Z` for `plaintext`.
    fn interesting_end(&self, elem: &str, i: usize) -> Option<usize> {
        let n = self.raw.len();
        if elem == "plaintext" {
            return Some(n);
        }
        let want: Vec<char> = elem.chars().collect();
        (i..n).find(|&at| {
            let name_at = at + 2;
            self.raw[at] == '<'
                && self.raw.get(at + 1) == Some(&'/')
                && name_at + want.len() < n
                && self.raw[name_at..name_at + want.len()].iter().zip(&want).all(|(a, b)| a.to_ascii_lowercase() == *b)
                && (ws_slash(self.raw[name_at + want.len()]) || self.raw[name_at + want.len()] == '>')
        })
    }

    fn data_text(&mut self, a: usize, b: usize) {
        let text = self.text(a, b);
        if self.escapable {
            let text = unescape(&text);
            self.h.handle_data(&text);
        } else {
            self.h.handle_data(&text);
        }
    }

    fn goahead(&mut self, end: bool) {
        let n = self.raw.len();
        let mut i = 0usize;
        while i < n {
            let j;
            if self.cdata.is_none() {
                match find_char(&self.raw, '<', i) {
                    Some(found) => j = found,
                    None => {
                        // a charref may be cut in half at the end: wait for more text when an `&` near the end has
                        // no blank or `;` after it
                        let from = i.max(n.saturating_sub(34));
                        let amppos = self.raw[from..].iter().rposition(|&c| c == '&').map(|p| from + p);
                        if let Some(amp) = amppos {
                            if !self.raw[amp..].iter().any(|&c| ws(c) || c == ';') {
                                break;
                            }
                        }
                        j = n;
                    }
                }
            } else {
                let elem = self.cdata.clone().unwrap_or_default();
                match self.interesting_end(&elem, i) {
                    Some(found) => j = found,
                    None => break,
                }
            }
            if i < j {
                self.data_text(i, j);
            }
            i = j;
            if i == n {
                break;
            }
            // a `<` here
            let k: isize;
            if self.raw.get(i + 1).is_some_and(|&c| ascii_alpha(c)) {
                k = self.parse_starttag(i);
            } else if starts(&self.raw, i, "</") {
                k = self.parse_endtag(i);
            } else if starts(&self.raw, i, "<!--") {
                k = self.parse_comment(i);
            } else if starts(&self.raw, i, "<?") {
                k = self.parse_pi(i);
            } else if starts(&self.raw, i, "<!") {
                k = self.parse_html_declaration(i);
            } else if i + 1 < n || end {
                self.h.handle_data("<");
                k = (i + 1) as isize;
            } else {
                break;
            }
            let mut k = k;
            if k < 0 {
                if !end {
                    break;
                }
                // the input ends inside the construct: what is left is data or a comment, or dropped
                if starts(&self.raw, i, "</") && i + 2 == n {
                    self.h.handle_data("</");
                }
                k = n as isize;
            }
            i = k as usize;
        }
        if end && i < n {
            self.data_text(i, n);
            i = n;
        }
        self.raw.drain(..i.min(self.raw.len()));
    }

    fn parse_html_declaration(&mut self, i: usize) -> isize {
        let raw = &self.raw;
        if starts(raw, i, "<![CDATA[") {
            return match find_str(raw, "]]>", i + 9) {
                Some(j) => (j + 3) as isize,
                None => -1,
            };
        }
        let lower: String = raw[i..(i + 9).min(raw.len())].iter().collect::<String>().to_lowercase();
        if lower == "<!doctype" {
            return match find_char(raw, '>', i + 9) {
                Some(gt) => (gt + 1) as isize,
                None => -1,
            };
        }
        if starts(raw, i, "<![") {
            return match find_char(raw, '>', i + 3) {
                Some(j) => (j + 1) as isize,
                None => -1,
            };
        }
        self.parse_bogus_comment(i)
    }

    /// `commentclose` (`--!?>`) searched from `i + 4`, else `commentabruptclose` (`-?>`) right at `i + 4`.
    fn parse_comment(&mut self, i: usize) -> isize {
        let raw = &self.raw;
        let mut p = i + 4;
        while p + 2 < raw.len() {
            if raw[p] == '-' && raw[p + 1] == '-' {
                if raw[p + 2] == '>' {
                    return (p + 3) as isize;
                }
                if raw[p + 2] == '!' && raw.get(p + 3) == Some(&'>') {
                    return (p + 4) as isize;
                }
            }
            p += 1;
        }
        let q = i + 4;
        if raw.get(q) == Some(&'>') {
            return (q + 1) as isize;
        }
        if raw.get(q) == Some(&'-') && raw.get(q + 1) == Some(&'>') {
            return (q + 2) as isize;
        }
        -1
    }

    fn parse_bogus_comment(&mut self, i: usize) -> isize {
        match find_char(&self.raw, '>', i + 2) {
            Some(pos) => (pos + 1) as isize,
            None => -1,
        }
    }

    fn parse_pi(&mut self, i: usize) -> isize {
        match find_char(&self.raw, '>', i + 2) {
            Some(pos) => (pos + 1) as isize,
            None => -1,
        }
    }

    fn parse_starttag(&mut self, i: usize) -> isize {
        let endpos = locatetagend(&self.raw, i + 1);
        if self.raw[endpos - 1] != '>' {
            return -1;
        }
        let Some((name_end, mut k)) = tagfind(&self.raw, i + 1) else { return -1 };
        let tag = self.text(i + 1, name_end).to_lowercase();
        let mut attrs: Vec<(String, Option<String>)> = Vec::new();
        while k < endpos {
            let Some((name, value, e)) = attrfind(&self.raw, k) else { break };
            let value = value.map(|v| {
                let quoted = |q: char| v.chars().next() == Some(q) && v.chars().last() == Some(q);
                let v = if (quoted('\'') || quoted('"')) && v.chars().count() >= 2 {
                    v.chars().skip(1).take(v.chars().count() - 2).collect()
                } else {
                    v
                };
                if v.is_empty() { v } else { unescape(&v) }
            });
            attrs.push((name.to_lowercase(), value));
            k = e;
        }
        let tail = self.text(k, endpos);
        let tail = kb_base::pytext::strip(&tail);
        if tail != ">" && tail != "/>" {
            let data = self.text(i, endpos);
            self.h.handle_data(&data);
            return endpos as isize;
        }
        if tail.ends_with("/>") {
            self.h.handle_startendtag(&tag, &attrs);
        } else {
            self.h.handle_starttag(&tag, &attrs);
            if CDATA_CONTENT_ELEMENTS.contains(&tag.as_str()) || tag == "plaintext" {
                self.cdata = Some(tag);
                self.escapable = false;
            } else if RCDATA_CONTENT_ELEMENTS.contains(&tag.as_str()) {
                self.cdata = Some(tag);
                self.escapable = true;
            }
        }
        endpos as isize
    }

    fn parse_endtag(&mut self, i: usize) -> isize {
        if find_char(&self.raw, '>', i + 2).is_none() {
            return -1;
        }
        if !self.raw.get(i + 2).is_some_and(|&c| ascii_alpha(c)) {
            if self.raw.get(i + 2) == Some(&'>') {
                return (i + 3) as isize;
            }
            return self.parse_bogus_comment(i);
        }
        let j = locatetagend(&self.raw, i + 2);
        if self.raw[j - 1] != '>' {
            return -1;
        }
        let Some((name_end, _)) = tagfind(&self.raw, i + 2) else { return -1 };
        let tag = self.text(i + 2, name_end).to_lowercase();
        self.h.handle_endtag(&tag);
        self.cdata = None;
        self.escapable = true;
        j as isize
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unescapes_like_python() {
        assert_eq!(unescape("a &lt;b&gt; &amp;amp; &#65;&#x42; &notit; &foo;"), "a <b> &amp; AB ¬it; &foo;");
        assert_eq!(escape("<a href=\"x\">'</a>"), "&lt;a href=&quot;x&quot;&gt;&#x27;&lt;/a&gt;");
    }
}
