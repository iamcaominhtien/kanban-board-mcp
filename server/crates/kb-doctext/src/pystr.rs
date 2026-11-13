//! Python `str` methods and `re` character classes that the Docs text modules use, where the Rust namesake differs.
//!
//! Python's `\w`, `\d` and `\s` are fixed by its Unicode version and are not the sets of the `regex` crate (`\w`
//! there also matches combining marks and connector punctuation), so they come from tables generated from Python's
//! own `re` (`pyuni_tables.rs`). Candidates for `kb_base::pytext`: `lstrip`, `rstrip`, `strip_chars`, `is_word`,
//! `is_decimal`.

use std::sync::LazyLock;

use crate::pyuni_tables::{DECIMAL, WORD};

pub use kb_base::pytext::{is_space, split, splitlines, squash, strip};

fn in_ranges(table: &[(u32, u32)], c: char) -> bool {
    let n = c as u32;
    table
        .binary_search_by(|&(lo, hi)| {
            if n < lo {
                std::cmp::Ordering::Greater
            } else if n > hi {
                std::cmp::Ordering::Less
            } else {
                std::cmp::Ordering::Equal
            }
        })
        .is_ok()
}

/// A character of `\w` in a Python `str` pattern: letters, numbers and `_`.
pub fn is_word(c: char) -> bool {
    if c.is_ascii() { c.is_ascii_alphanumeric() || c == '_' } else { in_ranges(WORD, c) }
}

/// A character of `\d` in a Python `str` pattern: a decimal digit of any script.
pub fn is_decimal(c: char) -> bool {
    if c.is_ascii() { c.is_ascii_digit() } else { in_ranges(DECIMAL, c) }
}

fn class_body(table: &[(u32, u32)]) -> String {
    let mut out = String::new();
    for &(lo, hi) in table {
        if lo == hi {
            out.push_str(&format!("\\x{{{lo:X}}}"));
        } else {
            out.push_str(&format!("\\x{{{lo:X}}}-\\x{{{hi:X}}}"));
        }
    }
    out
}

/// What goes between `[` and `]` in a `regex` pattern to match Python's `\w`.
pub static WORD_CLASS: LazyLock<String> = LazyLock::new(|| class_body(WORD));
/// What goes between `[` and `]` in a `regex` pattern to match Python's `\d`.
pub static DECIMAL_CLASS: LazyLock<String> = LazyLock::new(|| class_body(DECIMAL));
/// What goes between `[` and `]` in a `regex` pattern to match Python's `\s` (`str.isspace`).
pub const SPACE_CLASS: &str = r"\s\x{1C}-\x{1F}";

/// `ch.upper()` of one character, as Python 3.12 (Unicode 15) maps it.
///
/// Rust's tables are newer: Unicode 16 gave four letters an uppercase (U+019B, U+0264, U+A7D3, U+A7D5) that Python
/// still leaves alone. Every other character maps as in Python (`golden_charclasses` compares all of them).
pub fn upper_char(c: char) -> String {
    match c {
        '\u{19B}' | '\u{264}' | '\u{A7D3}' | '\u{A7D5}' => c.to_string(),
        c => c.to_uppercase().collect(),
    }
}

/// `text.lstrip()`.
pub fn lstrip(text: &str) -> &str {
    text.trim_start_matches(is_space)
}

/// `text.rstrip()`.
pub fn rstrip(text: &str) -> &str {
    text.trim_end_matches(is_space)
}

/// `text.lstrip(chars)`.
pub fn lstrip_chars<'a>(text: &'a str, chars: &str) -> &'a str {
    text.trim_start_matches(|c| chars.contains(c))
}

/// `text.rstrip(chars)`.
pub fn rstrip_chars<'a>(text: &'a str, chars: &str) -> &'a str {
    text.trim_end_matches(|c| chars.contains(c))
}

/// `text.strip(chars)`.
pub fn strip_chars<'a>(text: &'a str, chars: &str) -> &'a str {
    text.trim_matches(|c| chars.contains(c))
}

/// `text[:n]`: the first `n` characters.
pub fn head(text: &str, n: usize) -> &str {
    match text.char_indices().nth(n) {
        Some((i, _)) => &text[..i],
        None => text,
    }
}

/// `text[-n:]`: the last `n` characters (`n > 0`).
pub fn tail(text: &str, n: usize) -> &str {
    let total = text.chars().count();
    if total <= n {
        return text;
    }
    match text.char_indices().nth(total - n) {
        Some((i, _)) => &text[i..],
        None => text,
    }
}

/// `str.find(needle, start)` for every start, overlapping hits included: the character offsets of all occurrences.
pub fn find_all_overlapping(text: &str, needle: &str) -> Vec<usize> {
    let mut bytes = Vec::new();
    let mut from = 0;
    while let Some(i) = text[from..].find(needle) {
        let at = from + i;
        bytes.push(at);
        from = at + text[at..].chars().next().map_or(1, char::len_utf8);
        if from > text.len() {
            break;
        }
    }
    if bytes.is_empty() {
        return Vec::new();
    }
    // byte offsets to character offsets in one pass
    let mut out = Vec::with_capacity(bytes.len());
    let mut wanted = bytes.iter().peekable();
    for (n, (i, _)) in text.char_indices().enumerate() {
        while let Some(&&b) = wanted.peek() {
            if b == i {
                out.push(n);
                wanted.next();
            } else {
                break;
            }
        }
    }
    out
}

/// Number of characters (`len(text)`).
pub fn len(text: &str) -> usize {
    text.chars().count()
}

/// `text.find(needle)` as a character offset.
pub fn find(text: &str, needle: &str) -> Option<usize> {
    text.find(needle).map(|b| text[..b].chars().count())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn word_and_decimal_are_pythons_sets_not_rusts() {
        assert!(is_word('a') && is_word('_') && is_word('é') && is_word('中') && is_word('٣') && is_word('²'));
        // a combining mark is `\w` for Rust's regex and not for Python's
        assert!(!is_word('\u{301}') && !is_word('-') && !is_word(' ') && !is_word('‿'));
        assert!(is_decimal('7') && is_decimal('٣') && !is_decimal('²') && !is_decimal('a'));
    }

    #[test]
    fn strip_helpers_follow_python() {
        assert_eq!(lstrip(" \u{1f}x "), "x ");
        assert_eq!(rstrip(" x \u{a0}"), " x");
        assert_eq!(strip_chars("-- a-b ,", " ,-"), "a-b");
        assert_eq!(lstrip_chars(" \t>> x", " \t>"), "x");
        assert_eq!(rstrip_chars("x#### ", "# "), "x");
    }

    #[test]
    fn head_and_tail_count_characters() {
        assert_eq!(head("héllo", 2), "hé");
        assert_eq!(head("hé", 9), "hé");
        assert_eq!(head("hé", 0), "");
        assert_eq!(tail("héllo", 3), "llo");
        assert_eq!(tail("hé", 9), "hé");
    }

    #[test]
    fn find_all_overlapping_gives_character_offsets() {
        assert_eq!(find_all_overlapping("aaa", "aa"), vec![0, 1]);
        assert_eq!(find_all_overlapping("éaéa", "a"), vec![1, 3]);
        assert_eq!(find_all_overlapping("abc", "x"), Vec::<usize>::new());
        assert_eq!(find("éaé", "é"), Some(0));
        assert_eq!(find("aéb", "b"), Some(2));
    }
}
