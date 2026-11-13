//! The message of Python's `json.JSONDecodeError`.
//!
//! The HTTP transport answers a body that is not JSON with `Parse error: <str(exc)>`, so the text of Python's own
//! decoder is part of the reply: `Expecting value: line 1 column 1 (char 0)`. This walks the text the way
//! CPython 3.12's scanner does (`Modules/_json.c`) and reports the first error it would raise.

/// `str(JSONDecodeError)` for `text`, or `None` when Python's decoder accepts it.
pub fn python_json_error(text: &str) -> Option<String> {
    let doc: Vec<char> = text.chars().collect();
    if doc.first() == Some(&'\u{feff}') {
        return Some(message("Unexpected UTF-8 BOM (decode using utf-8-sig)", &doc, 0));
    }
    let start = skip_whitespace(&doc, 0);
    match scan_once(&doc, start, 0) {
        Ok(end) => {
            let end = skip_whitespace(&doc, end);
            (end != doc.len()).then(|| message("Extra data", &doc, end))
        }
        Err((msg, pos)) => Some(message(msg, &doc, pos)),
    }
}

/// `"{msg}: line {lineno} column {colno} (char {pos})"`.
fn message(msg: &str, doc: &[char], pos: usize) -> String {
    let before = &doc[..pos.min(doc.len())];
    let lineno = before.iter().filter(|c| **c == '\n').count() + 1;
    let colno = match before.iter().rposition(|c| *c == '\n') {
        Some(newline) => pos - newline,
        None => pos + 1,
    };
    format!("{msg}: line {lineno} column {colno} (char {pos})")
}

fn is_whitespace(c: char) -> bool {
    matches!(c, ' ' | '\t' | '\n' | '\r')
}

fn skip_whitespace(doc: &[char], mut idx: usize) -> usize {
    while idx < doc.len() && is_whitespace(doc[idx]) {
        idx += 1;
    }
    idx
}

type Scan = Result<usize, (&'static str, usize)>;

const EXPECTING_VALUE: &str = "Expecting value";

fn literal(doc: &[char], idx: usize, word: &str) -> bool {
    let word: Vec<char> = word.chars().collect();
    doc.len() >= idx + word.len() && doc[idx..idx + word.len()] == word[..]
}

/// `scan_once`: one JSON term starting at `idx`; the index after it.
fn scan_once(doc: &[char], idx: usize, depth: usize) -> Scan {
    let Some(&c) = doc.get(idx) else { return Err((EXPECTING_VALUE, idx)) };
    // (Python gives up with a RecursionError far deeper than any message a client sends)
    if depth > 900 {
        return Err((EXPECTING_VALUE, idx));
    }
    match c {
        '"' => scan_string(doc, idx + 1),
        '{' => parse_object(doc, idx + 1, depth),
        '[' => parse_array(doc, idx + 1, depth),
        'n' if literal(doc, idx, "null") => Ok(idx + 4),
        't' if literal(doc, idx, "true") => Ok(idx + 4),
        'f' if literal(doc, idx, "false") => Ok(idx + 5),
        'N' if literal(doc, idx, "NaN") => Ok(idx + 3),
        'I' if literal(doc, idx, "Infinity") => Ok(idx + 8),
        '-' if literal(doc, idx, "-Infinity") => Ok(idx + 9),
        _ => match_number(doc, idx),
    }
}

/// `scanstring` in strict mode, from the character after the opening quote.
fn scan_string(doc: &[char], begin: usize) -> Scan {
    const UNTERMINATED: &str = "Unterminated string starting at";
    let mut idx = begin;
    loop {
        let Some(&c) = doc.get(idx) else { return Err((UNTERMINATED, begin - 1)) };
        match c {
            '"' => return Ok(idx + 1),
            '\\' => {
                let Some(&escape) = doc.get(idx + 1) else { return Err((UNTERMINATED, begin - 1)) };
                if escape == 'u' {
                    let digits = doc.get(idx + 2..idx + 6);
                    // Python wants one more character after the four digits (the closing quote at least)
                    let complete = idx + 6 < doc.len();
                    if !complete || !digits.is_some_and(|d| d.iter().all(char::is_ascii_hexdigit)) {
                        return Err(("Invalid \\uXXXX escape", idx + 1));
                    }
                    idx += 6;
                } else if matches!(escape, '"' | '\\' | '/' | 'b' | 'f' | 'n' | 'r' | 't') {
                    idx += 2;
                } else {
                    return Err(("Invalid \\escape", idx));
                }
            }
            c if (c as u32) < 0x20 => return Err(("Invalid control character at", idx)),
            _ => idx += 1,
        }
    }
}

fn parse_object(doc: &[char], idx: usize, depth: usize) -> Scan {
    let mut idx = skip_whitespace(doc, idx);
    if doc.get(idx) == Some(&'}') {
        return Ok(idx + 1);
    }
    loop {
        if doc.get(idx) != Some(&'"') {
            return Err(("Expecting property name enclosed in double quotes", idx));
        }
        idx = skip_whitespace(doc, scan_string(doc, idx + 1)?);
        if doc.get(idx) != Some(&':') {
            return Err(("Expecting ':' delimiter", idx));
        }
        idx = skip_whitespace(doc, idx + 1);
        idx = skip_whitespace(doc, scan_once(doc, idx, depth + 1)?);
        match doc.get(idx) {
            Some('}') => return Ok(idx + 1),
            Some(',') => idx = skip_whitespace(doc, idx + 1),
            _ => return Err(("Expecting ',' delimiter", idx)),
        }
    }
}

fn parse_array(doc: &[char], idx: usize, depth: usize) -> Scan {
    let mut idx = skip_whitespace(doc, idx);
    if doc.get(idx) == Some(&']') {
        return Ok(idx + 1);
    }
    loop {
        idx = skip_whitespace(doc, scan_once(doc, idx, depth + 1)?);
        match doc.get(idx) {
            Some(']') => return Ok(idx + 1),
            Some(',') => idx = skip_whitespace(doc, idx + 1),
            _ => return Err(("Expecting ',' delimiter", idx)),
        }
    }
}

/// `_match_number_unicode`: `-?(0|[1-9]\d*)(\.\d+)?([eE][-+]?\d+)?`, as far as it goes.
fn match_number(doc: &[char], start: usize) -> Scan {
    let digit = |idx: usize| doc.get(idx).is_some_and(char::is_ascii_digit);
    let mut idx = start;
    if doc.get(idx) == Some(&'-') {
        idx += 1;
    }
    match doc.get(idx) {
        Some('1'..='9') => {
            while digit(idx) {
                idx += 1;
            }
        }
        Some('0') => idx += 1,
        _ => return Err((EXPECTING_VALUE, start)),
    }
    if doc.get(idx) == Some(&'.') && digit(idx + 1) {
        idx += 2;
        while digit(idx) {
            idx += 1;
        }
    }
    if matches!(doc.get(idx), Some('e' | 'E')) {
        let mut exponent = idx + 1;
        if matches!(doc.get(exponent), Some('-' | '+')) {
            exponent += 1;
        }
        if digit(exponent) {
            while digit(exponent) {
                exponent += 1;
            }
            idx = exponent;
        }
    }
    Ok(idx)
}

#[cfg(test)]
mod tests {
    use super::python_json_error as err;

    #[test]
    fn the_messages_of_pythons_decoder() {
        let cases: [(&str, &str); 16] = [
            ("", "Expecting value: line 1 column 1 (char 0)"),
            ("hello", "Expecting value: line 1 column 1 (char 0)"),
            ("  \n ", "Expecting value: line 2 column 2 (char 4)"),
            (
                r#"{"jsonrpc":"2.0","id":1,"#,
                "Expecting property name enclosed in double quotes: line 1 column 25 (char 24)",
            ),
            (r#"{"jsonrpc":"2.0","id":1,"method":"ping"} x"#, "Extra data: line 1 column 42 (char 41)"),
            ("{'jsonrpc':'2.0'}", "Expecting property name enclosed in double quotes: line 1 column 2 (char 1)"),
            (r#"{"a":1,}"#, "Expecting property name enclosed in double quotes: line 1 column 8 (char 7)"),
            (r#"{"jsonrpc" "2.0"}"#, "Expecting ':' delimiter: line 1 column 12 (char 11)"),
            (r#"{"jsonrpc":"2.0" "id":1}"#, "Expecting ',' delimiter: line 1 column 18 (char 17)"),
            (r#"{"jsonrpc":"2.0"#, "Unterminated string starting at: line 1 column 12 (char 11)"),
            (r#"{"jsonrpc":"2.\x"}"#, "Invalid \\escape: line 1 column 15 (char 14)"),
            ("[1,", "Expecting value: line 1 column 4 (char 3)"),
            ("[1,]", "Expecting value: line 1 column 4 (char 3)"),
            ("01", "Extra data: line 1 column 2 (char 1)"),
            ("[1 2]", "Expecting ',' delimiter: line 1 column 4 (char 3)"),
            ("\"a\tb\"", "Invalid control character at: line 1 column 3 (char 2)"),
        ];
        for (text, expected) in cases {
            assert_eq!(err(text).as_deref(), Some(expected), "{text:?}");
        }
        for valid in ["{}", "[]", " 5 ", "-1.5e3", r#"{"a": [1, {"b": null}], "c": "é\n"}"#, "NaN", "[-Infinity]"] {
            assert_eq!(err(valid), None, "{valid:?}");
        }
    }
}
