//! Python's `html.escape` and `html.unescape`.

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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unescapes_like_python() {
        assert_eq!(unescape("a &lt;b&gt; &amp;amp; &#65;&#x42; &notit; &foo;"), "a <b> &amp; AB ¬it; &foo;");
        assert_eq!(escape("<a href=\"x\">'</a>"), "&lt;a href=&quot;x&quot;&gt;&#x27;&lt;/a&gt;");
    }
}
