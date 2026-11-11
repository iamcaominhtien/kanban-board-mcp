//! JSON text as Python's `json.dumps` writes it.
//!
//! Lists and objects are stored as JSON text in TEXT columns, and some SSE payloads are built with `json.dumps`, so
//! the bytes matter: `", "` and `": "` separators, non-ASCII escaped as `\uXXXX`, floats as `repr(float)`. Keys keep
//! their insertion order (`serde_json` is built with `preserve_order`), as a Python dict does.

use serde::Serialize;
use serde_json::Value;

/// `json.dumps(value)` with Python's defaults.
pub fn dumps<T: Serialize>(value: &T) -> String {
    Dumps::new().dump(value)
}

/// `json.loads(text)`, `None` where Python raises.
pub fn loads(text: &str) -> Option<Value> {
    serde_json::from_str(text).ok()
}

/// The options of `json.dumps` the server uses.
#[derive(Clone, Copy, Debug)]
pub struct Dumps {
    ensure_ascii: bool,
    sort_keys: bool,
    indent: Option<usize>,
    compact: bool,
}

impl Default for Dumps {
    fn default() -> Self {
        Self::new()
    }
}

impl Dumps {
    /// Python's defaults: `ensure_ascii=True`, no sorting, no indent, separators `(", ", ": ")`.
    pub const fn new() -> Self {
        Self {
            ensure_ascii: true,
            sort_keys: false,
            indent: None,
            compact: false,
        }
    }

    /// `ensure_ascii=...`.
    pub const fn ensure_ascii(mut self, on: bool) -> Self {
        self.ensure_ascii = on;
        self
    }

    /// `sort_keys=...`.
    pub const fn sort_keys(mut self, on: bool) -> Self {
        self.sort_keys = on;
        self
    }

    /// `indent=n` (items on their own lines; the item separator is then `","` without a space).
    pub const fn indent(mut self, n: usize) -> Self {
        self.indent = Some(n);
        self
    }

    /// `separators=(",", ":")`.
    pub const fn compact(mut self) -> Self {
        self.compact = true;
        self
    }

    /// The JSON text.
    pub fn dump<T: Serialize>(&self, value: &T) -> String {
        let value = serde_json::to_value(value).unwrap_or(Value::Null);
        let mut out = String::new();
        self.write(&value, 0, &mut out);
        out
    }

    fn write(&self, value: &Value, depth: usize, out: &mut String) {
        match value {
            Value::Null => out.push_str("null"),
            Value::Bool(true) => out.push_str("true"),
            Value::Bool(false) => out.push_str("false"),
            Value::Number(n) => write_number(n, out),
            Value::String(s) => write_string(s, self.ensure_ascii, out),
            Value::Array(items) => {
                if items.is_empty() {
                    out.push_str("[]");
                    return;
                }
                out.push('[');
                for (i, item) in items.iter().enumerate() {
                    if i > 0 {
                        out.push_str(self.item_separator());
                    }
                    self.newline(depth + 1, out);
                    self.write(item, depth + 1, out);
                }
                self.newline(depth, out);
                out.push(']');
            }
            Value::Object(map) => {
                if map.is_empty() {
                    out.push_str("{}");
                    return;
                }
                out.push('{');
                let mut entries: Vec<(&String, &Value)> = map.iter().collect();
                if self.sort_keys {
                    entries.sort_by(|a, b| a.0.cmp(b.0));
                }
                for (i, (key, item)) in entries.into_iter().enumerate() {
                    if i > 0 {
                        out.push_str(self.item_separator());
                    }
                    self.newline(depth + 1, out);
                    write_string(key, self.ensure_ascii, out);
                    out.push_str(if self.compact { ":" } else { ": " });
                    self.write(item, depth + 1, out);
                }
                self.newline(depth, out);
                out.push('}');
            }
        }
    }

    fn item_separator(&self) -> &'static str {
        if self.compact || self.indent.is_some() {
            ","
        } else {
            ", "
        }
    }

    fn newline(&self, depth: usize, out: &mut String) {
        if let Some(n) = self.indent {
            out.push('\n');
            out.extend(std::iter::repeat_n(' ', n * depth));
        }
    }
}

fn write_string(s: &str, ensure_ascii: bool, out: &mut String) {
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            '\u{08}' => out.push_str("\\b"),
            '\u{0c}' => out.push_str("\\f"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c if ensure_ascii && !c.is_ascii() => {
                let mut units = [0u16; 2];
                for unit in c.encode_utf16(&mut units) {
                    out.push_str(&format!("\\u{unit:04x}"));
                }
            }
            c => out.push(c),
        }
    }
    out.push('"');
}

fn write_number(n: &serde_json::Number, out: &mut String) {
    if let Some(i) = n.as_i64() {
        out.push_str(&i.to_string());
    } else if let Some(u) = n.as_u64() {
        out.push_str(&u.to_string());
    } else if let Some(f) = n.as_f64() {
        out.push_str(&float_repr(f));
    } else {
        out.push_str(&n.to_string());
    }
}

/// `repr(f)` of a Python float: the shortest digits that round-trip, as a plain decimal when the exponent is in
/// `-4..16` (`0.0001`, `1234.5`, `1e+16`, `1e-05`), always with a `.0` for whole numbers in that range.
pub fn float_repr(f: f64) -> String {
    if f.is_nan() {
        return "NaN".into();
    }
    if f.is_infinite() {
        return if f > 0.0 {
            "Infinity".into()
        } else {
            "-Infinity".into()
        };
    }
    if f == 0.0 {
        return if f.is_sign_negative() {
            "-0.0".into()
        } else {
            "0.0".into()
        };
    }
    // Rust's `{:e}` gives the shortest round-trip digits: "1.2345e-5", "1e16"
    let sci = format!("{f:e}");
    let (mantissa, exponent) = sci.split_once('e').unwrap_or((&sci, "0"));
    let exponent: i32 = exponent.parse().unwrap_or(0);
    let negative = mantissa.starts_with('-');
    let digits: String = mantissa.chars().filter(char::is_ascii_digit).collect();
    let sign = if negative { "-" } else { "" };
    if (-4..16).contains(&exponent) {
        let point = exponent + 1; // digits before the decimal point
        if point <= 0 {
            format!("{sign}0.{}{digits}", "0".repeat((-point) as usize))
        } else if (point as usize) >= digits.len() {
            format!(
                "{sign}{digits}{}.0",
                "0".repeat(point as usize - digits.len())
            )
        } else {
            let (whole, fraction) = digits.split_at(point as usize);
            format!("{sign}{whole}.{fraction}")
        }
    } else {
        let (first, rest) = digits.split_at(1);
        let mantissa = if rest.is_empty() {
            first.to_string()
        } else {
            format!("{first}.{rest}")
        };
        let exp_sign = if exponent < 0 { '-' } else { '+' };
        format!("{sign}{mantissa}e{exp_sign}{:02}", exponent.abs())
    }
}

/// `str(value)` of a JSON value the way Python prints the object it came from (`str(1.0)` is `"1.0"`, `str(True)` is
/// `"True"`, `str(None)` is `"None"`, a string is itself).
pub fn py_str(value: &Value) -> String {
    match value {
        Value::Null => "None".into(),
        Value::Bool(true) => "True".into(),
        Value::Bool(false) => "False".into(),
        Value::Number(n) => {
            let mut out = String::new();
            write_number(n, &mut out);
            out
        }
        Value::String(s) => s.clone(),
        other => dumps(other),
    }
}

/// Python truthiness of a JSON value: `None`, `False`, `0`, `""`, `[]` and `{}` are false.
pub fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().is_some_and(|f| f != 0.0),
        Value::String(s) => !s.is_empty(),
        Value::Array(a) => !a.is_empty(),
        Value::Object(o) => !o.is_empty(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn default_separators_and_ascii_escapes() {
        let v = json!({"a": [1, 2.0, "x"], "b": {"c": null, "d": true}, "e": "Giọt 😀 \"q\"\n"});
        let esc = |hex: &str| format!("{}u{hex}", '\\');
        let want = format!(
            r#"{{"a": [1, 2.0, "x"], "b": {{"c": null, "d": true}}, "e": "Gi{}t {}{} \"q\"\n"}}"#,
            esc("1ecd"),
            esc("d83d"),
            esc("de00")
        );
        assert_eq!(dumps(&v), want);
        assert_eq!(
            Dumps::new()
                .compact()
                .ensure_ascii(false)
                .dump(&json!({"k": ["ọ", 1]})),
            r#"{"k":["ọ",1]}"#
        );
        assert_eq!(dumps(&json!([])), "[]");
        assert_eq!(dumps(&json!({})), "{}");
    }

    #[test]
    fn indent_like_python() {
        let v = json!({"a": 1, "b": [], "c": [1, {"d": 2}]});
        assert_eq!(
            Dumps::new().indent(2).dump(&v),
            "{\n  \"a\": 1,\n  \"b\": [],\n  \"c\": [\n    1,\n    {\n      \"d\": 2\n    }\n  ]\n}"
        );
    }

    #[test]
    fn sort_keys() {
        assert_eq!(
            Dumps::new()
                .sort_keys(true)
                .dump(&json!({"b": 1, "a": {"z": 1, "y": 2}})),
            r#"{"a": {"y": 2, "z": 1}, "b": 1}"#
        );
    }

    #[test]
    fn floats_like_repr() {
        for (f, want) in [
            (1.0, "1.0"),
            (0.1, "0.1"),
            (1234.5, "1234.5"),
            (1e16, "1e+16"),
            (1.5e16, "1.5e+16"),
            (123456789012345.0, "123456789012345.0"),
            (1e15, "1000000000000000.0"),
            (0.0001, "0.0001"),
            (0.00001, "1e-05"),
            (1.2345e-7, "1.2345e-07"),
            (-2.5, "-2.5"),
            (1e100, "1e+100"),
            (0.30000000000000004, "0.30000000000000004"),
        ] {
            assert_eq!(float_repr(f), want);
        }
    }
}
