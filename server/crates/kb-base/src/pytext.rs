//! The few `str` methods of Python whose result differs from the Rust method of the same name.

/// `ch.isspace()`: Rust's whitespace plus the four ASCII separators (FS, GS, RS, US) that Python also strips.
pub fn is_space(c: char) -> bool {
    c.is_whitespace() || ('\u{1c}'..='\u{1f}').contains(&c)
}

/// `text.strip()`.
pub fn strip(text: &str) -> &str {
    text.trim_matches(is_space)
}

/// `text.split()`: the words between runs of whitespace.
pub fn split(text: &str) -> Vec<&str> {
    text.split(is_space).filter(|part| !part.is_empty()).collect()
}

/// `" ".join(text.split())`.
pub fn squash(text: &str) -> String {
    split(text).join(" ")
}

/// `text.splitlines()`: Python also breaks a line at `\r`, `\v`, `\f`, FS, GS, RS, NEL, LS and PS.
pub fn splitlines(text: &str) -> Vec<&str> {
    let mut lines = Vec::new();
    let mut start = 0;
    let mut chars = text.char_indices().peekable();
    while let Some((i, c)) = chars.next() {
        let is_break = matches!(
            c,
            '\n' | '\r' | '\u{0b}' | '\u{0c}' | '\u{1c}' | '\u{1d}' | '\u{1e}' | '\u{85}' | '\u{2028}' | '\u{2029}'
        );
        if !is_break {
            continue;
        }
        lines.push(&text[start..i]);
        let mut end = i + c.len_utf8();
        if c == '\r' {
            if let Some(&(j, '\n')) = chars.peek() {
                chars.next();
                end = j + 1;
            }
        }
        start = end;
    }
    if start < text.len() {
        lines.push(&text[start..]);
    }
    lines
}

/// A titlecase letter (category Lt): cased, but neither upper nor lower.
fn is_titlecase(c: char) -> bool {
    matches!(c, '\u{1c5}' | '\u{1c8}' | '\u{1cb}' | '\u{1f2}' | '\u{1f88}'..='\u{1f8f}' | '\u{1f98}'..='\u{1f9f}'
        | '\u{1fa8}'..='\u{1faf}' | '\u{1fbc}' | '\u{1fcc}' | '\u{1ffc}')
}

/// `text.isupper()`: at least one cased character, and no cased character that is not uppercase.
pub fn isupper(text: &str) -> bool {
    let mut cased = false;
    for c in text.chars() {
        if c.is_lowercase() || is_titlecase(c) {
            return false;
        }
        cased = cased || c.is_uppercase();
    }
    cased
}

/// `repr(text)`: quoted as Python shows a string, e.g. in `f"{name!r}"`.
///
/// Python escapes every character that is not printable; without the Unicode tables this escapes control
/// characters, separators other than the space and the unassigned or private ranges Rust knows as not
/// alphanumeric control characters. Format characters (category Cf) are left as they are.
pub fn repr(text: &str) -> String {
    let quote = if text.contains('\'') && !text.contains('"') { '"' } else { '\'' };
    let mut out = String::with_capacity(text.len() + 2);
    out.push(quote);
    for c in text.chars() {
        match c {
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if c == quote => {
                out.push('\\');
                out.push(c);
            }
            ' ' => out.push(' '),
            c if c.is_control() || c.is_whitespace() => {
                let n = c as u32;
                if n < 0x100 {
                    out.push_str(&format!("\\x{n:02x}"));
                } else if n < 0x10000 {
                    out.push_str(&format!("\\u{n:04x}"));
                } else {
                    out.push_str(&format!("\\U{n:08x}"));
                }
            }
            c => out.push(c),
        }
    }
    out.push(quote);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strip_and_split_use_pythons_whitespace() {
        assert_eq!(strip(" \t a b \u{1f}\n"), "a b");
        assert_eq!(split("  a \u{1c} b\u{a0}c "), vec!["a", "b", "c"]);
        assert_eq!(squash(" An   Nguyen\n"), "An Nguyen");
        assert_eq!(squash(" \t "), "");
    }

    #[test]
    fn splitlines_breaks_where_python_does() {
        assert_eq!(splitlines("a\nb\r\nc\rd\n"), vec!["a", "b", "c", "d"]);
        assert_eq!(splitlines("a\n\nb"), vec!["a", "", "b"]);
        assert_eq!(splitlines(""), Vec::<&str>::new());
        assert_eq!(splitlines("a\u{2028}b\u{0c}c"), vec!["a", "b", "c"]);
    }

    #[test]
    fn isupper_needs_a_cased_character() {
        assert!(isupper("ABC") && isupper("A1") && isupper("É-2"));
        assert!(!isupper("") && !isupper("123") && !isupper("Ab") && !isupper("\u{1c5}"));
    }

    #[test]
    fn repr_quotes_as_python_does() {
        assert_eq!(repr("bad name"), "'bad name'");
        assert_eq!(repr("it's"), "\"it's\"");
        assert_eq!(repr("a'b\"c"), "'a\\'b\"c'");
        assert_eq!(repr("a\\b\n\t\u{1}\u{a0}é"), "'a\\\\b\\n\\t\\x01\\xa0é'");
    }
}
