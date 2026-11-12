//! `services/tickets.py`, lines 48-212: the limits, the `[[doc references]]` and `@mentions` of a text, the
//! validators of a ticket's fields, and the rules of a parent.

use chrono::{Datelike, NaiveDate, Weekday};
use kb_base::{activity as act, pytext};
use kb_db::Session;
use kb_db::entities::ticket;
use kb_db::sea_orm::{ColumnTrait, EntityTrait, QueryFilter, QuerySelect};
use kb_doctext::docs_text::page_ref_contexts;
use kb_doctext::pystr;
use serde_json::Value;

use super::{Error, dumps, loads, value_error};

pub const MAX_TITLE: usize = 300;
pub const MAX_TAGS: usize = 30;
pub const MAX_TAG_LEN: usize = 50;
pub const MAX_ESTIMATE: f64 = 100_000.0;
pub const MAX_COMMENT: usize = 50_000;
pub const MAX_AC_TEXT: usize = 1_000;
pub const MAX_SUB_TASK_TEXT: usize = 500;

/// Ordered, unique `Page` / `Page#Section` keys of the [[references]] in a text.
pub(crate) fn doc_ref_keys(text_: Option<&str>) -> Vec<String> {
    let mut seen: Vec<String> = Vec::new();
    for reference in page_ref_contexts(text_.unwrap_or("")) {
        let key = match reference.anchor.as_deref().filter(|a| !a.is_empty()) {
            Some(anchor) => format!("{}#{anchor}", reference.title),
            None => reference.title,
        };
        if !seen.contains(&key) {
            seen.push(key);
        }
    }
    seen
}

/// doc_ref_removed / doc_ref_added activity entries for a text edit.
pub(crate) fn doc_ref_entries(old: Option<&str>, new: Option<&str>, source: &str) -> Vec<Value> {
    let (before, after) = (doc_ref_keys(old), doc_ref_keys(new));
    let mut out: Vec<Value> = before
        .iter()
        .filter(|key| !after.contains(key))
        .map(|key| act::entry("doc_ref_removed", Value::String(key.clone()), Value::Null, Some(source), None, None))
        .collect();
    out.extend(
        after
            .iter()
            .filter(|key| !before.contains(key))
            .map(|key| act::entry("doc_ref_added", Value::Null, Value::String(key.clone()), Some(source), None, None)),
    );
    out
}

/// Append the doc references a text edit added or removed to the ticket's activity (the caller commits): a
/// [[Page]] in a comment or a test case is a reference as much as one in the description (TicketDocRefs E).
#[allow(dead_code)] // called by the comments and test cases of the second half of `tickets.py`
pub(crate) fn record_doc_refs(
    ticket: &mut ticket::Model,
    old: Option<&str>,
    new: Option<&str>,
    source: &str,
) -> Result<(), Error> {
    let entries = doc_ref_entries(old, new, source);
    if !entries.is_empty() {
        let mut log = loads(&ticket.activity_log)?;
        log.extend(entries);
        ticket.activity_log = dumps(&log);
    }
    Ok(())
}

/// Member ids written as `@[Name](member:id)` in a comment.
///
/// The pattern is `@\[([^\][\n]{1,100})\]\(member:([\w.-]{1,64})\)`, matched by hand: `\w` of a Python `str` pattern
/// is not the `\w` of the `regex` crate.
pub fn mention_ids(text_: &str) -> Vec<String> {
    let chars: Vec<char> = text_.chars().collect();
    let mut ids: Vec<String> = Vec::new();
    let mut i = 0;
    while i < chars.len() {
        match mention_at(&chars, i) {
            Some((id, end)) => {
                if !ids.contains(&id) {
                    ids.push(id);
                }
                i = end;
            }
            None => i += 1,
        }
    }
    ids
}

/// The member id of a mention that starts at `i`, and where the mention ends.
fn mention_at(chars: &[char], i: usize) -> Option<(String, usize)> {
    const OPEN: [char; 2] = ['@', '['];
    const MIDDLE: [char; 9] = [']', '(', 'm', 'e', 'm', 'b', 'e', 'r', ':'];
    if !chars[i..].starts_with(&OPEN) {
        return None;
    }
    let name_start = i + 2;
    let mut p = name_start;
    while p < chars.len() && p - name_start < 100 && !matches!(chars[p], ']' | '[' | '\n') {
        p += 1;
    }
    if p == name_start || !chars[p..].starts_with(&MIDDLE) {
        return None;
    }
    let id_start = p + MIDDLE.len();
    let mut q = id_start;
    while q < chars.len() && q - id_start < 64 && (pystr::is_word(chars[q]) || matches!(chars[q], '.' | '-')) {
        q += 1;
    }
    if q == id_start || chars.get(q) != Some(&')') {
        return None;
    }
    Some((chars[id_start..q].iter().collect(), q + 1))
}

pub(crate) fn clean_title(value: Option<&str>) -> Result<String, Error> {
    let title = pytext::strip(value.unwrap_or(""));
    if title.is_empty() {
        return value_error("Title must not be empty");
    }
    if title.chars().count() > MAX_TITLE {
        return value_error(format!("Title must be at most {MAX_TITLE} characters"));
    }
    Ok(title.to_string())
}

/// Accept an ISO date (or datetime); empty/None clears the field.
pub(crate) fn clean_date(value: Option<&str>, label: &str) -> Result<Option<String>, Error> {
    let raw = pytext::strip(value.unwrap_or(""));
    if raw.is_empty() {
        return Ok(None);
    }
    let valid = if raw.chars().count() == 10 {
        date_fromisoformat(raw)
    } else {
        datetime_fromisoformat(&raw.replace('Z', "+00:00"))
    };
    if !valid {
        return value_error(format!("{label} must be an ISO date (YYYY-MM-DD)"));
    }
    Ok(Some(raw.to_string()))
}

/// `n` ASCII digits of `buf` at `pos`: their value and the position after them (C's `parse_digits`).
fn parse_digits(buf: &[u8], pos: usize, n: usize) -> Option<(u32, usize)> {
    let mut value = 0u32;
    for i in 0..n {
        let digit = *buf.get(pos + i)?;
        if !digit.is_ascii_digit() {
            return None;
        }
        value = value * 10 + u32::from(digit - b'0');
    }
    Some((value, pos + n))
}

/// CPython's `parse_isoformat_date` over the first `len` bytes of `buf`, then the checks of `date(...)`:
/// `YYYY-MM-DD`, `YYYYMMDD`, `YYYY-Www`, `YYYY-Www-D`, `YYYYWww`, `YYYYWwwD`. True when it is a date.
fn parse_isoformat_date(buf: &[u8], len: usize) -> bool {
    if !matches!(len, 7 | 8 | 10) {
        return false;
    }
    let Some((year, mut cur)) = parse_digits(buf, 0, 4) else { return false };
    let uses_separator = buf.get(cur) == Some(&b'-');
    if uses_separator {
        cur += 1;
    }
    let date = if buf.get(cur) == Some(&b'W') {
        // ISO calendar
        cur += 1;
        let Some((iso_week, next)) = parse_digits(buf, cur, 2) else { return false };
        cur = next;
        let mut iso_day = 1;
        if cur < len {
            if uses_separator {
                if buf.get(cur) != Some(&b'-') {
                    return false;
                }
                cur += 1;
            }
            let Some((day, _)) = parse_digits(buf, cur, 1) else { return false };
            iso_day = day;
        }
        let weekday = match iso_day {
            1 => Weekday::Mon,
            2 => Weekday::Tue,
            3 => Weekday::Wed,
            4 => Weekday::Thu,
            5 => Weekday::Fri,
            6 => Weekday::Sat,
            7 => Weekday::Sun,
            _ => return false,
        };
        NaiveDate::from_isoywd_opt(year as i32, iso_week, weekday)
    } else {
        let Some((month, next)) = parse_digits(buf, cur, 2) else { return false };
        cur = next;
        if uses_separator {
            if buf.get(cur) != Some(&b'-') {
                return false;
            }
            cur += 1;
        }
        let Some((day, _)) = parse_digits(buf, cur, 2) else { return false };
        NaiveDate::from_ymd_opt(year as i32, month, day)
    };
    // MINYEAR..MAXYEAR, for the year written and for the date an ISO week gives
    year >= 1 && date.is_some_and(|d| (1..=9999).contains(&d.year()))
}

/// `date.fromisoformat(text)` succeeds (Python 3.12).
fn date_fromisoformat(text: &str) -> bool {
    parse_isoformat_date(text.as_bytes(), text.len())
}

/// CPython's `_find_isoformat_datetime_separator`: where the date part of a datetime text ends.
fn find_isoformat_datetime_separator(buf: &[u8]) -> Option<usize> {
    let len = buf.len();
    if len == 7 {
        return Some(7);
    }
    let at = |i: usize| buf.get(i).copied().unwrap_or(0);
    if at(4) == b'-' {
        if at(5) == b'W' {
            if len < 8 {
                return None;
            }
            if len > 8 && at(8) == b'-' {
                if len == 9 {
                    return None;
                }
                if len > 10 && at(10).is_ascii_digit() {
                    return Some(8);
                }
                return Some(10);
            }
            return Some(8);
        }
        return Some(10);
    }
    if at(4) == b'W' {
        let mut idx = 7;
        while idx < len && buf[idx].is_ascii_digit() {
            idx += 1;
        }
        if idx < 9 {
            return Some(idx);
        }
        return Some(if idx % 2 == 0 { 7 } else { 8 });
    }
    Some(8)
}

/// CPython's `parse_hh_mm_ss_ff` over `buf[start..end]` (`HH[:?MM[:?SS[{.,}ffffff]]]`): hour, minute, second and
/// microsecond, and whether something follows that it did not read.
fn parse_hh_mm_ss_ff(buf: &[u8], start: usize, end: usize) -> Option<([u32; 4], bool)> {
    let at = |i: usize| buf.get(i).copied().unwrap_or(0);
    let mut vals = [0u32; 4];
    let mut p = start;
    let mut has_separator = true;
    for i in 0..3 {
        let (value, next) = parse_digits(buf, p, 2)?;
        vals[i] = value;
        p = next;
        let c = at(p);
        p += 1;
        if i == 0 {
            has_separator = c == b':';
        }
        if p >= end {
            return Some((vals, c != 0));
        } else if has_separator && c == b':' {
            continue;
        } else if c == b'.' || c == b',' {
            break;
        } else if !has_separator {
            p -= 1;
        } else {
            return None;
        }
    }
    // the fraction: at most six digits count, the rest are skipped
    let to_parse = (end - p).min(6);
    let (mut microsecond, next) = parse_digits(buf, p, to_parse)?;
    p = next;
    for _ in to_parse..6 {
        microsecond *= 10;
    }
    vals[3] = microsecond;
    while at(p).is_ascii_digit() {
        p += 1;
    }
    Some((vals, at(p) != 0))
}

/// CPython's `parse_isoformat_time` and the checks of `time(...)` and `timezone(...)`: True when `buf` is a time
/// with an optional `Z` or `±HH[:MM[:SS[.ffffff]]]` offset under 24 hours.
fn parse_isoformat_time(buf: &[u8]) -> bool {
    let end = buf.len();
    let tz_pos = buf.iter().position(|b| matches!(b, b'Z' | b'+' | b'-'));
    let Some((time, trailing)) = parse_hh_mm_ss_ff(buf, 0, tz_pos.unwrap_or(end)) else { return false };
    if time[0] > 23 || time[1] > 59 || time[2] > 59 {
        return false;
    }
    let Some(tz_pos) = tz_pos else { return !trailing };
    if buf[tz_pos] == b'Z' {
        return tz_pos + 1 == end;
    }
    let Some((tz, trailing)) = parse_hh_mm_ss_ff(buf, tz_pos + 1, end) else { return false };
    if trailing {
        return false;
    }
    let micros = (u64::from(tz[0]) * 3600 + u64::from(tz[1]) * 60 + u64::from(tz[2])) * 1_000_000 + u64::from(tz[3]);
    micros < 86_400_000_000
}

/// `datetime.fromisoformat(text)` succeeds (Python 3.12: the C implementation, byte for byte).
fn datetime_fromisoformat(text: &str) -> bool {
    let buf = text.as_bytes();
    let len = buf.len();
    if len < 7 {
        return false;
    }
    let Some(separator) = find_isoformat_datetime_separator(buf) else { return false };
    if !parse_isoformat_date(buf, separator) {
        return false;
    }
    if len <= separator {
        return true;
    }
    // the separator is any one character; in UTF-8 its length is in its first byte
    let width = match buf[separator] {
        b if b & 0x80 == 0 => 1,
        b if b & 0xf0 == 0xe0 => 3,
        b if b & 0xf0 == 0xf0 => 4,
        _ => 2,
    };
    buf.get(separator + width..).is_some_and(parse_isoformat_time)
}

pub(crate) fn clean_estimate(value: Option<f64>) -> Result<Option<f64>, Error> {
    let Some(value) = value else { return Ok(None) };
    if value.is_nan() || !(0.0..=MAX_ESTIMATE).contains(&value) {
        // NaN, negative, absurd
        return value_error(format!("Estimate must be between 0 and {}", MAX_ESTIMATE as i64));
    }
    Ok(Some(value))
}

pub(crate) fn clean_tags(value: Option<&[Value]>) -> Result<Vec<String>, Error> {
    let mut cleaned: Vec<String> = Vec::new();
    let mut seen: Vec<String> = Vec::new();
    for raw in value.unwrap_or(&[]) {
        let Value::String(raw) = raw else {
            return value_error("Tags must be strings");
        };
        let tag = pytext::strip(raw);
        if tag.is_empty() {
            continue;
        }
        if tag.chars().count() > MAX_TAG_LEN {
            return value_error(format!("A tag must be at most {MAX_TAG_LEN} characters"));
        }
        let lower = tag.to_lowercase();
        if seen.contains(&lower) {
            continue;
        }
        seen.push(lower);
        cleaned.push(tag.to_string());
    }
    if cleaned.len() > MAX_TAGS {
        return value_error(format!("A ticket can have at most {MAX_TAGS} tags"));
    }
    Ok(cleaned)
}

pub(crate) fn clean_text(value: Option<&str>, label: &str, limit: usize) -> Result<String, Error> {
    let text_value = pytext::strip(value.unwrap_or(""));
    if text_value.is_empty() {
        return value_error(format!("{label} must not be empty"));
    }
    if text_value.chars().count() > limit {
        return value_error(format!("{label} must be at most {limit} characters"));
    }
    Ok(text_value.to_string())
}

pub(crate) fn check_date_order(start: Option<&str>, due: Option<&str>) -> Result<(), Error> {
    let (Some(start), Some(due)) = (start.filter(|s| !s.is_empty()), due.filter(|d| !d.is_empty())) else {
        return Ok(());
    };
    let day = |text: &str| text.chars().take(10).collect::<String>();
    if day(start) > day(due) {
        return value_error("Start date must not be after the due date");
    }
    Ok(())
}

pub(crate) async fn validate_parent(
    session: &Session,
    parent_id: &str,
    project_id: &str,
    self_id: Option<&str>,
) -> Result<(), Error> {
    if self_id == Some(parent_id) {
        return value_error("A ticket cannot be its own parent");
    }
    let Some(parent) = ticket::Entity::find_by_id(parent_id).one(session).await? else {
        return value_error(format!("Parent ticket '{parent_id}' not found"));
    };
    if parent.project_id != project_id {
        return value_error("Parent must belong to the same project");
    }
    // A ticket holds sub-tickets one level deep; under a Story there is one more level:
    // Story -> ticket -> sub-ticket.
    let mut parent_depth = 0;
    let mut root_type = parent.r#type.clone();
    if let Some(grandparent_id) = &parent.parent_id {
        parent_depth = 1;
        match ticket::Entity::find_by_id(grandparent_id).one(session).await? {
            Some(root) if root.parent_id.is_none() => root_type = root.r#type,
            _ => return value_error("Cannot nest tickets more than 1 level deep"),
        }
    }
    let max_depth = if root_type == "story" { 2 } else { 1 };
    if parent_depth + 1 > max_depth {
        return value_error("Cannot nest tickets more than 1 level deep (only a Story's tickets can have sub-tickets)");
    }
    if let Some(self_id) = self_id {
        let height = subtree_height(session, self_id).await?;
        if parent_depth + 1 + height > max_depth {
            return value_error("Cannot nest tickets more than 1 level deep");
        }
    }
    Ok(())
}

/// How many levels of children hang under a ticket (0 = none; capped at 2).
pub(crate) async fn subtree_height(session: &Session, ticket_id: &str) -> Result<i32, Error> {
    let kids: Vec<String> = ticket::Entity::find()
        .select_only()
        .column(ticket::Column::Id)
        .filter(ticket::Column::ParentId.eq(ticket_id))
        .into_tuple()
        .all(session)
        .await?;
    if kids.is_empty() {
        return Ok(0);
    }
    let grandkids: Option<String> = ticket::Entity::find()
        .select_only()
        .column(ticket::Column::Id)
        .filter(ticket::Column::ParentId.is_in(kids))
        .limit(1)
        .into_tuple()
        .one(session)
        .await?;
    Ok(if grandkids.is_some() { 2 } else { 1 })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn golden() -> Value {
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../contract/golden/ticket_rules.json");
        let text = std::fs::read_to_string(path).expect("golden file ticket_rules.json exists");
        serde_json::from_str(&text).expect("golden file parses")
    }

    /// One case against the Python answer: `out` or the `ValueError` message.
    fn check(name: &str, case: &Value, got: Result<Value, Error>) {
        let got = match got {
            Ok(value) => json!({"out": value}),
            Err(Error::Value(message)) => json!({"error": message}),
            Err(other) => panic!("{name} {}: {other}", case["in"]),
        };
        let mut expected = case.as_object().expect("case").clone();
        expected.shift_remove("in");
        assert_eq!(got, Value::Object(expected), "{name} {}", case["in"]);
    }

    fn cases<'a>(golden: &'a Value, name: &str) -> &'a Vec<Value> {
        let cases = golden[name].as_array().unwrap_or_else(|| panic!("{name} cases"));
        assert!(!cases.is_empty(), "{name}");
        cases
    }

    #[test]
    fn the_validators_answer_as_python_does() {
        let golden = golden();
        for case in cases(&golden, "clean_date") {
            let got = clean_date(case["in"][0].as_str(), case["in"][1].as_str().expect("label"));
            check("clean_date", case, got.map(|v| json!(v)));
        }
        for case in cases(&golden, "clean_title") {
            check("clean_title", case, clean_title(case["in"].as_str()).map(Value::String));
        }
        for case in cases(&golden, "clean_tags") {
            let got = clean_tags(case["in"].as_array().map(Vec::as_slice));
            check("clean_tags", case, got.map(|v| json!(v)));
        }
        for case in cases(&golden, "clean_estimate") {
            // JSON has no NaN or infinity: the generator's `nan` and `inf` come back as null, which is no estimate
            let Some(given) = case["in"].as_f64() else { continue };
            let got = clean_estimate(Some(given)).map(|v| json!(v));
            let mut expected = case.clone();
            if let Some(out) = expected.get("out").and_then(Value::as_f64) {
                expected["out"] = json!(out);
            }
            check("clean_estimate", &expected, got);
        }
        for case in cases(&golden, "clean_text") {
            let label = case["in"][1].as_str().expect("label");
            let limit = case["in"][2].as_u64().expect("limit") as usize;
            check("clean_text", case, clean_text(case["in"][0].as_str(), label, limit).map(Value::String));
        }
        for case in cases(&golden, "check_date_order") {
            let got = check_date_order(case["in"][0].as_str(), case["in"][1].as_str());
            check("check_date_order", case, got.map(|()| Value::Null));
        }
    }

    #[test]
    fn mentions_and_doc_references_are_read_as_python_reads_them() {
        let golden = golden();
        for case in cases(&golden, "mention_ids") {
            assert_eq!(json!(mention_ids(case["in"].as_str().unwrap_or(""))), case["out"], "{}", case["in"]);
        }
        for case in cases(&golden, "doc_ref_keys") {
            assert_eq!(json!(doc_ref_keys(case["in"].as_str())), case["out"], "{}", case["in"]);
        }
    }

    #[tokio::test]
    async fn doc_reference_entries_say_what_an_edit_added_and_removed() {
        kb_base::ctx::scope(async {
            let entries = doc_ref_entries(Some("[[A]] and [[B#x]]"), Some("[[B#x]] then [[C]]"), "description");
            let shown: Vec<(Value, Value, Value, Value)> = entries
                .iter()
                .map(|e| (e["field"].clone(), e["from"].clone(), e["to"].clone(), e["ref"].clone()))
                .collect();
            assert_eq!(
                shown,
                vec![
                    (json!("doc_ref_removed"), json!("A"), Value::Null, json!("description")),
                    (json!("doc_ref_added"), Value::Null, json!("C"), json!("description")),
                ]
            );
            assert!(doc_ref_entries(None, Some("no reference"), "a comment").is_empty());
        })
        .await;
    }
}
