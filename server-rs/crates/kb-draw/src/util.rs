//! Small Python behaviors the services of this crate lean on.

use std::path::Path;

use kb_base::pytext;
use serde_json::Value;

/// `str(Path(text))` for an absolute path: separators collapsed, `.` parts and a trailing slash dropped.
pub fn path_str(text: &str) -> String {
    let parts = kb_files::pathlib::parts(text);
    let joined = parts.join("/");
    if kb_files::pathlib::is_absolute(text) { format!("/{joined}") } else if joined.is_empty() { ".".into() } else { joined }
}

/// `OSError.strerror`: the operating system's own words (`Permission denied`), without Rust's ` (os error 13)`.
pub fn strerror(err: &std::io::Error) -> String {
    let text = err.to_string();
    match text.find(" (os error") {
        Some(i) => text[..i].to_string(),
        None => text,
    }
}

/// `re.sub(r"[^\w.-]+", "-", text, flags=re.ASCII).strip("-._")`: a file name stem made from a label.
pub fn file_stem(label: &str) -> String {
    let mut out = String::new();
    let mut in_run = false;
    for c in label.chars() {
        if c.is_ascii_alphanumeric() || c == '_' || c == '.' || c == '-' {
            out.push(c);
            in_run = false;
        } else if !in_run {
            out.push('-');
            in_run = true;
        }
    }
    out.trim_matches(['-', '.', '_']).to_string()
}

/// `text.strip()[:limit]` counted in characters.
pub fn strip_cut(text: &str, limit: usize) -> String {
    pytext::strip(text).chars().take(limit).collect()
}

/// `bytes.decode("utf-8", "ignore")`: invalid bytes are dropped.
pub fn decode_ignore(bytes: &[u8]) -> String {
    let mut out = String::new();
    let mut rest = bytes;
    loop {
        match std::str::from_utf8(rest) {
            Ok(text) => {
                out.push_str(text);
                return out;
            }
            Err(e) => {
                let (good, bad) = rest.split_at(e.valid_up_to());
                out.push_str(&String::from_utf8_lossy(good));
                match e.error_len() {
                    Some(n) => rest = &bad[n..],
                    None => return out,
                }
            }
        }
    }
}

/// `Path.is_file()`.
pub fn is_file(path: &Path) -> bool {
    path.is_file()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stems_and_paths() {
        assert_eq!(file_stem("Auth flow"), "Auth-flow");
        assert_eq!(file_stem("  ..x__ "), "x");
        assert_eq!(file_stem("é"), "");
        assert_eq!(path_str("/a//b/./c/"), "/a/b/c");
        assert_eq!(path_str("/"), "/");
        assert_eq!(decode_ignore(b"a\xffb\xc3"), "ab");
    }
}

// --- json.loads as Python reports its errors -----------------------------------------------------------------------

/// What `json.loads` fails with: a `JSONDecodeError` (a `ValueError`), or the `RecursionError` of a document nested
/// too deeply (which is not one).
#[derive(Debug, Clone, PartialEq)]
pub enum JsonError {
    /// `JSONDecodeError`: `Expecting value: line 1 column 1 (char 0)`.
    Decode(String),
    /// `RecursionError`.
    Recursion(String),
}

struct JsonReader<'a> {
    chars: Vec<char>,
    text: &'a str,
}

impl JsonReader<'_> {
    fn err<T>(&self, message: &str, pos: usize) -> Result<T, JsonError> {
        let upto = &self.chars[..pos.min(self.chars.len())];
        let line = upto.iter().filter(|c| **c == '\n').count() + 1;
        let col = match upto.iter().rposition(|c| *c == '\n') {
            Some(i) => pos - i,
            None => pos + 1,
        };
        Err(JsonError::Decode(format!("{message}: line {line} column {col} (char {pos})")))
    }

    fn skip_ws(&self, mut i: usize) -> usize {
        while matches!(self.chars.get(i), Some(' ' | '\t' | '\n' | '\r')) {
            i += 1;
        }
        i
    }

    fn string(&self, start: usize) -> Result<(String, usize), JsonError> {
        // `start` is the index of the opening quote
        let mut i = start + 1;
        let mut out = String::new();
        loop {
            let Some(&c) = self.chars.get(i) else {
                return self.err("Unterminated string starting at", start);
            };
            match c {
                '"' => return Ok((out, i + 1)),
                '\\' => {
                    let Some(&e) = self.chars.get(i + 1) else {
                        return self.err("Unterminated string starting at", start);
                    };
                    match e {
                        '"' | '\\' | '/' => out.push(e),
                        'b' => out.push('\u{8}'),
                        'f' => out.push('\u{c}'),
                        'n' => out.push('\n'),
                        'r' => out.push('\r'),
                        't' => out.push('\t'),
                        'u' => {
                            let hex = |at: usize| -> Option<u32> {
                                let digits: String = self.chars.get(at..at + 4)?.iter().collect();
                                if digits.chars().all(|c| c.is_ascii_hexdigit()) {
                                    u32::from_str_radix(&digits, 16).ok()
                                } else {
                                    None
                                }
                            };
                            let Some(mut code) = hex(i + 2) else {
                                return self.err("Invalid \\uXXXX escape", i + 1);
                            };
                            i += 4;
                            if (0xd800..0xdc00).contains(&code)
                                && self.chars.get(i + 2) == Some(&'\\')
                                && self.chars.get(i + 3) == Some(&'u')
                            {
                                if let Some(low) = hex(i + 4).filter(|l| (0xdc00..0xe000).contains(l)) {
                                    code = 0x10000 + ((code - 0xd800) << 10) + (low - 0xdc00);
                                    i += 6;
                                }
                            }
                            out.push(char::from_u32(code).unwrap_or('\u{fffd}'));
                        }
                        _ => return self.err("Invalid \\escape", i),
                    }
                    i += 2;
                }
                c if (c as u32) < 0x20 => return self.err("Invalid control character at", i),
                c => {
                    out.push(c);
                    i += 1;
                }
            }
        }
    }

    fn value(&self, i: usize, depth: usize) -> Result<(Value, usize), JsonError> {
        if depth > 400 {
            return Err(JsonError::Recursion("maximum recursion depth exceeded while decoding a JSON document".into()));
        }
        let Some(&c) = self.chars.get(i) else {
            return self.err("Expecting value", i);
        };
        match c {
            '"' => self.string(i).map(|(s, next)| (Value::String(s), next)),
            '{' => {
                let mut map = serde_json::Map::new();
                let mut j = self.skip_ws(i + 1);
                if self.chars.get(j) == Some(&'}') {
                    return Ok((Value::Object(map), j + 1));
                }
                loop {
                    if self.chars.get(j) != Some(&'"') {
                        return self.err("Expecting property name enclosed in double quotes", j);
                    }
                    let (key, next) = self.string(j)?;
                    j = self.skip_ws(next);
                    if self.chars.get(j) != Some(&':') {
                        return self.err("Expecting ':' delimiter", j);
                    }
                    j = self.skip_ws(j + 1);
                    let (v, next) = self.value(j, depth + 1)?;
                    map.insert(key, v);
                    j = self.skip_ws(next);
                    match self.chars.get(j) {
                        Some('}') => return Ok((Value::Object(map), j + 1)),
                        Some(',') => j = self.skip_ws(j + 1),
                        _ => return self.err("Expecting ',' delimiter", j),
                    }
                }
            }
            '[' => {
                let mut items = Vec::new();
                let mut j = self.skip_ws(i + 1);
                if self.chars.get(j) == Some(&']') {
                    return Ok((Value::Array(items), j + 1));
                }
                loop {
                    let (v, next) = self.value(j, depth + 1)?;
                    items.push(v);
                    j = self.skip_ws(next);
                    match self.chars.get(j) {
                        Some(']') => return Ok((Value::Array(items), j + 1)),
                        Some(',') => j = self.skip_ws(j + 1),
                        _ => return self.err("Expecting ',' delimiter", j),
                    }
                }
            }
            _ => {
                let rest: String = self.chars[i..].iter().take(10).collect();
                for (word, v) in [("null", Value::Null), ("true", Value::Bool(true)), ("false", Value::Bool(false))] {
                    if rest.starts_with(word) {
                        return Ok((v, i + word.len()));
                    }
                }
                // NaN and Infinity are accepted by Python; a JSON value cannot hold them, they become null
                for word in ["NaN", "Infinity", "-Infinity"] {
                    if rest.starts_with(word) {
                        return Ok((Value::Null, i + word.len()));
                    }
                }
                self.number(i)
            }
        }
    }

    fn number(&self, i: usize) -> Result<(Value, usize), JsonError> {
        let mut j = i;
        let digit = |k: usize| self.chars.get(k).is_some_and(char::is_ascii_digit);
        if self.chars.get(j) == Some(&'-') {
            j += 1;
        }
        match self.chars.get(j) {
            Some('0') => j += 1,
            Some('1'..='9') => {
                while digit(j) {
                    j += 1;
                }
            }
            _ => return self.err("Expecting value", i),
        }
        let mut is_float = false;
        if self.chars.get(j) == Some(&'.') && digit(j + 1) {
            is_float = true;
            j += 1;
            while digit(j) {
                j += 1;
            }
        }
        if matches!(self.chars.get(j), Some('e' | 'E')) {
            let mut k = j + 1;
            if matches!(self.chars.get(k), Some('+' | '-')) {
                k += 1;
            }
            if digit(k) {
                is_float = true;
                while digit(k) {
                    k += 1;
                }
                j = k;
            }
        }
        let text: String = self.chars[i..j].iter().collect();
        let value = if is_float {
            text.parse::<f64>().ok().and_then(serde_json::Number::from_f64).map_or(Value::Null, Value::Number)
        } else {
            match serde_json::from_str::<Value>(&text) {
                Ok(v) => v,
                // a whole number too big for 64 bits: kept as a float, as Rust has no bigger number
                Err(_) => text.parse::<f64>().ok().and_then(serde_json::Number::from_f64).map_or(Value::Null, Value::Number),
            }
        };
        Ok((value, j))
    }
}

/// `json.loads(text)`: the parsed value, or Python's own error message.
pub fn json_loads(text: &str) -> Result<Value, JsonError> {
    let reader = JsonReader { chars: text.chars().collect(), text };
    if text.starts_with('\u{feff}') {
        return reader.err("Unexpected UTF-8 BOM (decode using utf-8-sig)", 0);
    }
    let start = reader.skip_ws(0);
    let (value, next) = reader.value(start, 0)?;
    let end = reader.skip_ws(next);
    if end != reader.chars.len() {
        return reader.err("Extra data", end);
    }
    let _ = reader.text;
    Ok(value)
}

/// `str(UnicodeDecodeError)` for `bytes.decode("utf-8")`, or `None` when the bytes are valid UTF-8.
pub fn utf8_error_message(bytes: &[u8]) -> Option<String> {
    let err = std::str::from_utf8(bytes).err()?;
    let start = err.valid_up_to();
    let (end, reason) = match err.error_len() {
        Some(n) => {
            let first = bytes[start];
            if first >= 0x80 && !(0xc2..=0xf4).contains(&first) { (start + 1, "invalid start byte") } else { (start + n, "invalid continuation byte") }
        }
        None => (bytes.len(), "unexpected end of data"),
    };
    Some(if end - start == 1 {
        format!("'utf-8' codec can't decode byte 0x{:02x} in position {start}: {reason}", bytes[start])
    } else {
        format!("'utf-8' codec can't decode bytes in position {start}-{}: {reason}", end - 1)
    })
}

/// `repr(value)` of the Python object a JSON value was read into.
pub fn py_repr(value: &Value) -> String {
    match value {
        Value::String(s) => pytext::repr(s),
        Value::Array(items) => format!("[{}]", items.iter().map(py_repr).collect::<Vec<_>>().join(", ")),
        Value::Object(map) => {
            format!("{{{}}}", map.iter().map(|(k, v)| format!("{}: {}", pytext::repr(k), py_repr(v))).collect::<Vec<_>>().join(", "))
        }
        other => kb_base::pyjson::py_str(other),
    }
}

/// `value == n` for a JSON value and a whole number, as Python compares them (`1.0 == 1`, `True == 1`).
pub fn json_equals_int(value: Option<&Value>, n: i64) -> bool {
    match value {
        Some(Value::Number(num)) => num.as_i64().map_or_else(|| num.as_f64() == Some(n as f64), |i| i == n),
        Some(Value::Bool(b)) => i64::from(*b) == n,
        _ => false,
    }
}
