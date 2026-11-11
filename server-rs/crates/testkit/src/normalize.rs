//! Normalizers for differential comparison of replies from two servers.

use regex::{Captures, Regex};
use serde_json::Value;
use std::collections::HashMap;
use std::sync::OnceLock;

struct Patterns {
    uuid: Regex,
    time: Regex,
    port: Regex,
}

fn patterns() -> &'static Patterns {
    static P: OnceLock<Patterns> = OnceLock::new();
    P.get_or_init(|| Patterns {
        uuid: Regex::new(
            r"(?i)\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b|\b[0-9a-f]{32}\b",
        )
        .expect("static regex"),
        time: Regex::new(
            r"\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?",
        )
        .expect("static regex"),
        port: Regex::new(r"(https?://(?:127\.0\.0\.1|localhost|\[::1\])):\d+").expect("static regex"),
    })
}

/// Replace UUIDs (hyphenated and 32 hex) by `<uuid:N>` numbered by first appearance (equal ids stay equal), ISO
/// timestamps by `<time>` and the port of a localhost URL by `<port>`; everything else is kept. Object keys are
/// normalized too.
pub fn normalize(value: &Value) -> Value {
    let mut ids = HashMap::new();
    walk(value, &mut ids)
}

fn walk(value: &Value, ids: &mut HashMap<String, usize>) -> Value {
    match value {
        Value::String(s) => Value::String(normalize_str(s, ids)),
        Value::Array(a) => Value::Array(a.iter().map(|v| walk(v, ids)).collect()),
        Value::Object(o) => Value::Object(
            o.iter()
                .map(|(k, v)| {
                    let key = normalize_str(k, ids);
                    (key, walk(v, ids))
                })
                .collect(),
        ),
        other => other.clone(),
    }
}

fn normalize_str(s: &str, ids: &mut HashMap<String, usize>) -> String {
    let p = patterns();
    let out = p.uuid.replace_all(s, |c: &Captures| {
        let next = ids.len() + 1;
        let n = *ids.entry(c[0].to_lowercase()).or_insert(next);
        format!("<uuid:{n}>")
    });
    let out = p.time.replace_all(&out, "<time>");
    p.port.replace_all(&out, "$1:<port>").into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn numbers_ids_by_first_appearance() {
        let v = json!({"a": "3f2b8c1e-0000-4000-8000-000000000001", "b": ["3F2B8C1E-0000-4000-8000-000000000001",
            "0123456789abcdef0123456789abcdef"], "t": "2025-01-02T03:04:05.123456+00:00",
            "u": "http://127.0.0.1:5432/x", "n": 5});
        let n = normalize(&v);
        assert_eq!(n["a"], "<uuid:1>");
        assert_eq!(n["b"], json!(["<uuid:1>", "<uuid:2>"]));
        assert_eq!(n["t"], "<time>");
        assert_eq!(n["u"], "http://127.0.0.1:<port>/x");
        assert_eq!(n["n"], 5);
    }
}
