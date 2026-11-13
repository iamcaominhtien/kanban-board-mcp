//! `json.dumps` as Python writes it, for what the fake prints: `", "` and `": "` separators, non-ASCII as `\uXXXX`,
//! floats as `repr(float)`. Keys keep their order (`serde_json` is built with `preserve_order`).

use serde_json::Value;

/// `json.dumps(value)`.
pub fn dumps(value: &Value) -> String {
    let mut out = String::new();
    write(value, &mut out);
    out
}

fn write(value: &Value, out: &mut String) {
    match value {
        Value::Null => out.push_str("null"),
        Value::Bool(true) => out.push_str("true"),
        Value::Bool(false) => out.push_str("false"),
        Value::Number(n) => match (n.as_i64(), n.as_u64(), n.as_f64()) {
            (Some(i), _, _) => out.push_str(&i.to_string()),
            (_, Some(u), _) => out.push_str(&u.to_string()),
            (_, _, Some(f)) => out.push_str(&float_repr(f)),
            _ => out.push_str(&n.to_string()),
        },
        Value::String(s) => write_str(s, out),
        Value::Array(items) => {
            out.push('[');
            for (i, item) in items.iter().enumerate() {
                if i > 0 {
                    out.push_str(", ");
                }
                write(item, out);
            }
            out.push(']');
        }
        Value::Object(map) => {
            out.push('{');
            for (i, (key, item)) in map.iter().enumerate() {
                if i > 0 {
                    out.push_str(", ");
                }
                write_str(key, out);
                out.push_str(": ");
                write(item, out);
            }
            out.push('}');
        }
    }
}

fn write_str(text: &str, out: &mut String) {
    out.push('"');
    for c in text.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            '\u{08}' => out.push_str("\\b"),
            '\u{0c}' => out.push_str("\\f"),
            c if (c as u32) < 0x20 || (c as u32) > 0x7e && (c as u32) != 0x7f => {
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

/// `repr(f)` of a Python float: the shortest digits that read back, an exponent from `1e16` up and below `1e-4`.
pub fn float_repr(f: f64) -> String {
    if f.is_nan() {
        return "NaN".into();
    }
    if f.is_infinite() {
        return if f > 0.0 { "Infinity".into() } else { "-Infinity".into() };
    }
    if f == 0.0 {
        return if f.is_sign_negative() { "-0.0".into() } else { "0.0".into() };
    }
    // Rust's `{:e}` gives the shortest digits: "1.2345e20", "1e-2"
    let sci = format!("{f:e}");
    let (mantissa, exponent) = sci.split_once('e').unwrap_or((&sci, "0"));
    let exponent: i32 = exponent.parse().unwrap_or(0);
    let (sign, mantissa) = match mantissa.strip_prefix('-') {
        Some(rest) => ("-", rest),
        None => ("", mantissa),
    };
    let digits: String = mantissa.chars().filter(char::is_ascii_digit).collect();
    if (-4..16).contains(&exponent) {
        let point = exponent + 1; // digits before the decimal point
        let body = if point <= 0 {
            format!("0.{}{digits}", "0".repeat(usize::try_from(-point).unwrap_or(0)))
        } else {
            let point = usize::try_from(point).unwrap_or(0);
            if digits.len() <= point {
                format!("{digits}{}.0", "0".repeat(point - digits.len()))
            } else {
                format!("{}.{}", &digits[..point], &digits[point..])
            }
        };
        return format!("{sign}{body}");
    }
    let (first, rest) = digits.split_at(1);
    let mantissa = if rest.is_empty() { first.to_string() } else { format!("{first}.{rest}") };
    format!("{sign}{mantissa}e{}{:02}", if exponent < 0 { '-' } else { '+' }, exponent.abs())
}

/// `str(value)` of the Python object a JSON value came from (a string is itself).
pub fn py_str(value: &Value) -> String {
    match value {
        Value::Null => "None".into(),
        Value::Bool(true) => "True".into(),
        Value::Bool(false) => "False".into(),
        Value::String(s) => s.clone(),
        other => dumps(other),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn floats_read_as_python_prints_them() {
        for (f, want) in [
            (0.3, "0.3"),
            (1.0, "1.0"),
            (0.01, "0.01"),
            (0.0001, "0.0001"),
            (0.00001, "1e-05"),
            (1.5e-7, "1.5e-07"),
            (1e15, "1000000000000000.0"),
            (1e16, "1e+16"),
            (1.2345e20, "1.2345e+20"),
            (123.456, "123.456"),
            (-2.5, "-2.5"),
            (100.0, "100.0"),
        ] {
            assert_eq!(float_repr(f), want);
        }
    }

    #[test]
    fn text_is_escaped_as_python_escapes_it() {
        let got = dumps(&json!({"a": ["Tôi ✓ 😀", "q\"\\\n\t\u{1}\u{7f}"], "b": null, "c": 1, "d": 0.5}));
        let want = "{\"a\": [\"T\\u00f4i \\u2713 \\ud83d\\ude00\", \"q\\\"\\\\\\n\\t\\u0001\u{7f}\"], \"b\": null, \"c\": 1, \"d\": 0.5}";
        assert_eq!(got, want);
    }
}
