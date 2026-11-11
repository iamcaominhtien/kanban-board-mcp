//! Part of `services/notifications.py`: lines 138 to 190, "Small helpers". It also holds the few Python built-ins
//! the module leans on (`int(...)` of a JSON value, `repr` of a string, `dict.pop`), so the rest reads like the
//! Python.

use chrono::{DateTime, FixedOffset, Local, NaiveDateTime, TimeZone, Utc};
use kb_base::time::{self, Parsed};
use serde_json::{Map, Value};

use crate::error::{NotifyError, Result};
use crate::kinds::{SELF_NAMES, kind_info};

/// Current UTC time, ISO formatted.
pub fn now_iso() -> String {
    time::now_iso()
}

/// The current instant (`datetime.now(UTC)`).
pub fn utcnow() -> DateTime<Utc> {
    Utc::now()
}

/// `dt.isoformat()` of an aware time.
pub fn iso<Tz: TimeZone>(dt: &DateTime<Tz>) -> String
where
    Tz::Offset: std::fmt::Display,
{
    time::iso(dt)
}

/// The plural ending of a count: "1 run", "2 runs".
pub fn plural(n: i64) -> &'static str {
    if n == 1 { "" } else { "s" }
}

/// `datetime.fromisoformat(value)`, a time with no offset read as UTC; `None` for an empty or unreadable value.
pub fn parse(value: Option<&str>) -> Option<DateTime<FixedOffset>> {
    let value = value.filter(|v| !v.is_empty())?;
    Some(match time::parse_iso(value)? {
        Parsed::Aware(dt) => dt,
        Parsed::Naive(naive) => Utc.from_utc_datetime(&naive).fixed_offset(),
    })
}

/// `json.loads(value)`, or `default` when the value is empty or not JSON.
pub fn loads(value: Option<&str>, default: Value) -> Value {
    match value {
        Some(v) if !v.is_empty() => kb_base::pyjson::loads(v).unwrap_or(default),
        _ => default,
    }
}

/// `_loads(value, {})` for a value that holds an object (anything else reads as an empty object).
pub fn loads_map(value: Option<&str>) -> Map<String, Value> {
    match loads(value, Value::Object(Map::new())) {
        Value::Object(map) => map,
        _ => Map::new(),
    }
}

/// `_loads(value, [])` for a value that holds a list (anything else reads as an empty list).
pub fn loads_list(value: Option<&str>) -> Vec<Value> {
    match loads(value, Value::Array(Vec::new())) {
        Value::Array(list) => list,
        _ => Vec::new(),
    }
}

/// `json.dumps(value)`.
pub fn dumps(value: &Value) -> String {
    kb_base::pyjson::dumps(value)
}

/// The recipient key of a person: the name in lower case, "user" for the board's own user.
pub fn person_key(name: Option<&str>) -> String {
    let n = name.unwrap_or("").trim().to_lowercase();
    if SELF_NAMES.contains(&n.as_str()) { "user".to_string() } else { n }
}

/// The recipient key of an AI member.
pub fn ai_key(member_id: &str) -> String {
    format!("ai:{member_id}")
}

/// Whether a kind is Needs you.
pub fn is_needs(kind: &str) -> bool {
    kind_info(kind).is_some_and(|k| k.needs)
}

/// `dt.astimezone()`: the same instant in the machine's local time, with the offset it has at that instant (Python
/// gives a fixed offset, so `.replace(hour=0)` on it does not look at daylight saving again).
pub fn local<Tz: TimeZone>(dt: &DateTime<Tz>) -> DateTime<FixedOffset> {
    dt.with_timezone(&Local).fixed_offset()
}

/// `datetime.fromisoformat(value).astimezone()`: a time with no offset is read as local time. `None` where Python
/// raises.
pub fn local_of_iso(value: &str) -> Option<DateTime<FixedOffset>> {
    match time::parse_iso(value)? {
        Parsed::Aware(dt) => Some(local(&dt)),
        Parsed::Naive(naive) => Local.from_local_datetime(&naive).earliest().map(|dt| dt.fixed_offset()),
    }
}

/// `dt.replace(hour=0, minute=0, second=0, microsecond=0)` on a fixed-offset time.
pub fn midnight(dt: &DateTime<FixedOffset>) -> DateTime<FixedOffset> {
    let naive: NaiveDateTime = dt.date_naive().and_hms_opt(0, 0, 0).unwrap_or(dt.naive_local());
    dt.timezone().from_local_datetime(&naive).single().unwrap_or(*dt)
}

/// `dict.pop(key)`: removes the key and keeps the order of the others (`Map::remove` would swap the last one in).
pub fn pop(map: &mut Map<String, Value>, key: &str) -> Option<Value> {
    map.shift_remove(key)
}

/// Python's `repr` of a string, for the messages of the exceptions it appears in.
pub fn py_repr_str(s: &str) -> String {
    let quote = if s.contains('\'') && !s.contains('"') { '"' } else { '\'' };
    let mut out = String::new();
    out.push(quote);
    for c in s.chars() {
        match c {
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if c == quote => {
                out.push('\\');
                out.push(c);
            }
            c if (c as u32) < 0x20 || c as u32 == 0x7f => out.push_str(&format!("\\x{:02x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push(quote);
    out
}

/// What `int(value)` gives for a JSON value, or the exception Python raises: a `ValueError` for text that is not a
/// number (the router answers its message), a 500 for a type `int()` does not take.
pub fn py_int(value: &Value) -> Result<i128> {
    match value {
        Value::Bool(b) => Ok(i128::from(*b)),
        Value::Number(n) => {
            if let Some(i) = n.as_i64() {
                Ok(i128::from(i))
            } else if let Some(u) = n.as_u64() {
                Ok(i128::from(u))
            } else {
                let f = n.as_f64().unwrap_or(0.0);
                if f.is_nan() {
                    Err(NotifyError::value("cannot convert float NaN to integer"))
                } else if f.is_infinite() {
                    Err(NotifyError::Internal("cannot convert float infinity to integer".into()))
                } else {
                    Ok(f.trunc() as i128)
                }
            }
        }
        Value::String(s) => parse_py_int_text(s)
            .ok_or_else(|| NotifyError::value(format!("invalid literal for int() with base 10: {}", py_repr_str(s)))),
        Value::Null => Err(NotifyError::Internal(
            "int() argument must be a string, a bytes-like object or a real number, not 'NoneType'".into(),
        )),
        Value::Array(_) => Err(NotifyError::Internal(
            "int() argument must be a string, a bytes-like object or a real number, not 'list'".into(),
        )),
        Value::Object(_) => Err(NotifyError::Internal(
            "int() argument must be a string, a bytes-like object or a real number, not 'dict'".into(),
        )),
    }
}

/// `int("  -12 ")`: optional sign, digits with single underscores between them, spaces around.
fn parse_py_int_text(text: &str) -> Option<i128> {
    let t = text.trim();
    let (negative, digits) = match t.strip_prefix('-') {
        Some(rest) => (true, rest),
        None => (false, t.strip_prefix('+').unwrap_or(t)),
    };
    if digits.is_empty() || digits.starts_with('_') || digits.ends_with('_') || digits.contains("__") {
        return None;
    }
    let mut value: i128 = 0;
    for c in digits.chars().filter(|c| *c != '_') {
        let d = c.to_digit(10)?;
        value = value.checked_mul(10)?.checked_add(i128::from(d))?;
    }
    Some(if negative { -value } else { value })
}

/// The `Option<&str>` of a JSON value that is a string (`None` for null and for anything else).
pub fn as_str(value: Option<&Value>) -> Option<&str> {
    value.and_then(Value::as_str)
}

/// `bool(value)` of an optional JSON value (a missing value is false).
pub fn truthy(value: Option<&Value>) -> bool {
    value.is_some_and(kb_base::pyjson::truthy)
}

/// Python's `str.startswith` on an optional text.
pub fn non_empty(value: &Option<String>) -> Option<&str> {
    value.as_deref().filter(|v| !v.is_empty())
}
