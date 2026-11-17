//! Character classes of JavaScript regular expressions, which the UI's Markdown reader (marked) is written in.
//!
//! The converter reproduces regex-based tokenizers by hand; these helpers give `\s`, `\w`, `\p{P}`/`\p{S}` and
//! `[\p{L}\p{N}]` the meaning they have in JavaScript.

use std::sync::OnceLock;

use regex::Regex;

/// Returns whether `c` is JavaScript `\s` (white space or a line terminator).
pub fn is_space(c: char) -> bool {
    matches!(
        c,
        '\t' | '\n' | '\u{0b}' | '\u{0c}' | '\r' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}'
    )
}

/// Returns whether `c` is JavaScript `\w` (ASCII letter, digit or `_`).
pub fn is_word(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_'
}

/// Returns whether `c` ends a line for JavaScript `.` (which matches anything else).
pub fn is_line_term(c: char) -> bool {
    matches!(c, '\n' | '\r' | '\u{2028}' | '\u{2029}')
}

fn class(re: &'static OnceLock<Regex>, pattern: &str, c: char) -> bool {
    let re = re.get_or_init(|| Regex::new(pattern).expect("a fixed, valid pattern"));
    let mut buf = [0u8; 4];
    re.is_match(c.encode_utf8(&mut buf))
}

/// Returns whether `c` is Unicode punctuation or a symbol (`[\p{P}\p{S}]`).
pub fn is_punct(c: char) -> bool {
    if c.is_ascii() {
        return c.is_ascii_punctuation();
    }
    static RE: OnceLock<Regex> = OnceLock::new();
    class(&RE, r"^[\p{P}\p{S}]$", c)
}

/// Returns whether `c` is a Unicode letter or number (`[\p{L}\p{N}]`).
pub fn is_alnum(c: char) -> bool {
    if c.is_ascii() {
        return c.is_ascii_alphanumeric();
    }
    static RE: OnceLock<Regex> = OnceLock::new();
    class(&RE, r"^[\p{L}\p{N}]$", c)
}

/// JavaScript `String.prototype.trim`.
pub fn trim(s: &str) -> &str {
    s.trim_matches(is_space)
}

/// JavaScript `String.prototype.trimEnd`.
pub fn trim_end(s: &str) -> &str {
    s.trim_end_matches(is_space)
}

/// JavaScript `String.prototype.trimStart`.
pub fn trim_start(s: &str) -> &str {
    s.trim_start_matches(is_space)
}

/// Removes every trailing `c` (marked's `rtrim`).
pub fn rtrim_char(s: &str, c: char) -> &str {
    s.trim_end_matches(c)
}

/// Collapses every run of JavaScript white space to one space (`s.replace(/\s+/g, ' ')`).
pub fn collapse_spaces(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut in_space = false;
    for c in s.chars() {
        if is_space(c) {
            if !in_space {
                out.push(' ');
            }
            in_space = true;
        } else {
            out.push(c);
            in_space = false;
        }
    }
    out
}

/// Number of leading characters of `s` that are JavaScript white space (`s.match(/^(\s*)/)[1].length`).
pub fn leading_space_count(s: &str) -> usize {
    s.chars().take_while(|c| is_space(*c)).count()
}

/// The length of `s` in UTF-16 code units, as JavaScript's `length`.
pub fn js_len(s: &str) -> usize {
    s.chars().map(char::len_utf16).sum()
}
