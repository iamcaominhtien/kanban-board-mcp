//! Small loaders shared by the AI services (`services/ai/store.py`).

use std::collections::HashSet;

use chrono::{DateTime, FixedOffset};
use kb_base::time;
use kb_db::Session;
use kb_db::database;
use kb_db::entities::{ai_project_settings, ai_run, ai_team, member};
use kb_db::sea_orm::{ColumnTrait, DbErr, EntityTrait, QueryFilter};
use serde_json::Value;

/// Current UTC time, ISO formatted.
pub fn now_iso() -> String {
    time::now_iso()
}

/// Parse an ISO time, or None. A time without an offset is read as UTC.
///
/// This is `datetime.fromisoformat` of Python 3.12 (its C implementation, which accepts shapes the documentation does
/// not list: any single character between the date and the time, any single character before the fraction or the
/// offset sign, week dates, basic format), then `parse_iso`'s own step: no offset means UTC.
pub fn parse_iso(value: Option<&str>) -> Option<DateTime<FixedOffset>> {
    let value = value.filter(|v| !v.is_empty())?;
    from_isoformat(value)
}

/// `str.isdigit` of an ASCII byte.
fn is_digit(b: u8) -> bool {
    b.is_ascii_digit()
}

/// `parse_digits(p, &var, n)`: exactly `n` ASCII digits at `pos`.
fn digits(s: &[u8], pos: usize, n: usize) -> Option<(i32, usize)> {
    let mut value = 0i32;
    for i in 0..n {
        let b = *s.get(pos + i)?;
        if !is_digit(b) {
            return None;
        }
        value = value * 10 + i32::from(b - b'0');
    }
    Some((value, pos + n))
}

/// `_find_isoformat_datetime_separator`: where the date ends, or None for a string that cannot be a date.
fn separator_location(s: &[u8]) -> Option<usize> {
    let at = |i: usize| s.get(i).copied().unwrap_or(0);
    let len = s.len();
    if len == 7 {
        return Some(7);
    }
    if at(4) == b'-' {
        if at(5) == b'W' {
            if len < 8 {
                return None;
            }
            if len > 8 && at(8) == b'-' {
                if len == 9 {
                    return None;
                }
                if len > 10 && is_digit(at(10)) {
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
        while idx < len && is_digit(at(idx)) {
            idx += 1;
        }
        if idx < 9 {
            return Some(idx);
        }
        return Some(if idx % 2 == 0 { 7 } else { 8 });
    }
    Some(8)
}

/// `parse_isoformat_date` on the first `len` bytes of `s`.
fn parse_date(s: &[u8], len: usize) -> Option<chrono::NaiveDate> {
    let s = &s[..len.min(s.len())];
    let at = |i: usize| s.get(i).copied().unwrap_or(0);
    let (year, mut p) = digits(s, 0, 4)?;
    let uses_separator = at(p) == b'-';
    if uses_separator {
        p += 1;
    }
    if at(p) == b'W' {
        p += 1;
        let (week, np) = digits(s, p, 2)?;
        p = np;
        let day = if p < len {
            if uses_separator {
                let c = at(p);
                p += 1;
                if c != b'-' {
                    return None;
                }
            }
            digits(s, p, 1)?.0
        } else {
            1
        };
        let weekday = match day {
            1 => chrono::Weekday::Mon,
            2 => chrono::Weekday::Tue,
            3 => chrono::Weekday::Wed,
            4 => chrono::Weekday::Thu,
            5 => chrono::Weekday::Fri,
            6 => chrono::Weekday::Sat,
            7 => chrono::Weekday::Sun,
            _ => return None,
        };
        if !(1..=9999).contains(&year) {
            return None;
        }
        return chrono::NaiveDate::from_isoywd_opt(year, u32::try_from(week).ok()?, weekday);
    }
    let (month, np) = digits(s, p, 2)?;
    p = np;
    if uses_separator {
        let c = at(p);
        p += 1;
        if c != b'-' {
            return None;
        }
    }
    let (day, _) = digits(s, p, 2)?;
    if !(1..=9999).contains(&year) {
        return None;
    }
    chrono::NaiveDate::from_ymd_opt(year, u32::try_from(month).ok()?, u32::try_from(day).ok()?)
}

/// What `parse_hh_mm_ss_ff` read: the three components, the microseconds, and whether something follows.
struct Clock {
    parts: [i32; 3],
    micros: i32,
    more: bool,
}

/// `parse_hh_mm_ss_ff(s[start..end])`: the byte after the seconds is taken as the separator of the fraction whatever
/// it is, and a lone character before `end` counts as "something follows".
fn parse_clock(s: &[u8], start: usize, end: usize) -> Option<Clock> {
    let at = |i: usize| s.get(i).copied().unwrap_or(0);
    let mut p = start;
    let mut parts = [0i32; 3];
    let mut has_separator = true;
    for i in 0..3 {
        let (v, np) = digits(s, p, 2)?;
        parts[i] = v;
        p = np;
        let c = at(p);
        p += 1;
        if i == 0 {
            has_separator = c == b':';
        }
        if p >= end {
            return Some(Clock { parts, micros: 0, more: c != 0 });
        } else if has_separator && c != b':' {
            if c == b'.' || c == b',' {
                break;
            }
            return None;
        } else if c == b'.' || c == b',' {
            break;
        } else if !has_separator {
            p -= 1;
        }
    }
    let len_remains = end.checked_sub(p)?;
    if len_remains == 0 {
        return None;
    }
    let to_parse = len_remains.min(6);
    let (mut micros, mut np) = digits(s, p, to_parse)?;
    if to_parse < 6 {
        micros *= [100_000, 10_000, 1_000, 100, 10][to_parse - 1];
    }
    while is_digit(at(np)) {
        np += 1;
    }
    Some(Clock { parts, micros, more: at(np) != 0 })
}

/// `parse_isoformat_time` on `s[start..]`: (hour, minute, second, microsecond, offset in seconds when there is one).
fn parse_time(s: &[u8], start: usize) -> Option<(i32, i32, i32, i32, Option<i32>)> {
    let at = |i: usize| s.get(i).copied().unwrap_or(0);
    let end = s.len();
    let mut tz = start;
    loop {
        if matches!(at(tz), b'Z' | b'+' | b'-') {
            break;
        }
        tz += 1;
        if tz >= end {
            break;
        }
    }
    let clock = parse_clock(s, start, tz)?;
    let [h, m, sec] = clock.parts;
    if tz >= end {
        // no time zone: anything left over is an error
        return if clock.more { None } else { Some((h, m, sec, clock.micros, None)) };
    }
    if at(tz) == b'Z' {
        return if at(tz + 1) != 0 { None } else { Some((h, m, sec, clock.micros, Some(0))) };
    }
    let sign = if at(tz) == b'-' { -1 } else { 1 };
    let zone = parse_clock(s, tz + 1, end)?;
    if zone.more {
        return None;
    }
    let offset = sign * (zone.parts[0] * 3600 + zone.parts[1] * 60 + zone.parts[2]);
    Some((h, m, sec, clock.micros, Some(offset)))
}

/// `datetime.fromisoformat(text)`: the wall time and the offset in seconds when the text has one.
pub fn isoformat_parts(text: &str) -> Option<(chrono::NaiveDateTime, Option<i32>)> {
    let s = text.as_bytes();
    if s.len() < 7 {
        return None;
    }
    let sep = separator_location(s)?;
    let date = parse_date(s, sep)?;
    let (mut h, mut m, mut sec, mut micros, mut offset) = (0, 0, 0, 0, None);
    if s.len() > sep {
        // the separator is one character, which may take several bytes
        let step = match s[sep] {
            b if b & 0x80 == 0 => 1,
            b => match b & 0xf0 {
                0xe0 => 3,
                0xf0 => 4,
                _ => 2,
            },
        };
        let rest = s.get(sep + step..).unwrap_or(&[]);
        (h, m, sec, micros, offset) = parse_time(rest, 0)?;
    }
    let naive = date.and_hms_micro_opt(
        u32::try_from(h).ok()?,
        u32::try_from(m).ok()?,
        u32::try_from(sec).ok()?,
        u32::try_from(micros).ok()?,
    )?;
    // a zone is strictly between -24 and +24 hours
    if offset.is_some_and(|seconds| seconds.abs() >= 86_400) {
        return None;
    }
    Some((naive, offset))
}

fn from_isoformat(text: &str) -> Option<DateTime<FixedOffset>> {
    let (naive, offset) = isoformat_parts(text)?;
    let tz = FixedOffset::east_opt(offset.unwrap_or(0))?;
    chrono::TimeZone::from_local_datetime(&tz, &naive).single()
}

/// `json.loads` that falls back to `default` (for `None`, an empty string or text that is not JSON).
pub fn loads(value: Option<&str>, default: Value) -> Value {
    match value {
        None | Some("") => default,
        Some(text) => serde_json::from_str(text).unwrap_or(default),
    }
}

/// The Member row and its AI profile (either may be None).
pub async fn get_profile(
    session: &Session,
    member_id: &str,
) -> Result<(Option<member::Model>, Option<ai_team::Model>), DbErr> {
    let member = member::Entity::find_by_id(member_id).one(session).await?;
    let profile = ai_team::Entity::find_by_id(member_id).one(session).await?;
    Ok((member, profile))
}

/// The project's AI settings, created with defaults on first use.
pub async fn get_settings(session: &Session, project_id: &str) -> Result<ai_project_settings::Model, DbErr> {
    if let Some(settings) = ai_project_settings::Entity::find_by_id(project_id).one(session).await? {
        return Ok(settings);
    }
    let mut row = ai_project_settings::new();
    row.project_id = kb_db::sea_orm::ActiveValue::Set(project_id.to_string());
    database::insert_missing(session, row).await?;
    session.commit().await?;
    ai_project_settings::Entity::find_by_id(project_id)
        .one(session)
        .await?
        .ok_or_else(|| DbErr::RecordNotFound(format!("ai_project_settings {project_id}")))
}

/// Names of the project's AI members (current and removed): text they wrote is data only.
pub async fn ai_names(session: &Session, project_id: &str) -> Result<HashSet<String>, DbErr> {
    let rows = member::Entity::find()
        .filter(member::Column::ProjectId.eq(project_id))
        .filter(member::Column::Kind.is_in(["ai", "ai_removed"]))
        .all(session)
        .await?;
    Ok(rows.into_iter().map(|m| m.name).collect())
}

/// Runs that are queued, starting, running or waiting for input.
pub async fn active_runs(
    session: &Session,
    member_id: Option<&str>,
    ticket_id: Option<&str>,
) -> Result<Vec<ai_run::Model>, DbErr> {
    let mut stmt =
        ai_run::Entity::find().filter(ai_run::Column::State.is_in(["queued", "starting", "running", "needs_input"]));
    if let Some(member_id) = member_id.filter(|m| !m.is_empty()) {
        stmt = stmt.filter(ai_run::Column::MemberId.eq(member_id));
    }
    if let Some(ticket_id) = ticket_id.filter(|t| !t.is_empty()) {
        stmt = stmt.filter(ai_run::Column::TicketId.eq(ticket_id));
    }
    stmt.all(session).await
}

/// Python's `int(value)` for the JSON values a setting or an event may hold: `None` where Python raises.
pub fn py_int(value: &Value) -> Option<i128> {
    crate::ops::py_int(value)
}

fn text_value(value: &Value) -> String {
    match value {
        Value::String(s) => s.clone(),
        Value::Null => String::new(),
        other => kb_base::pyjson::py_str(other),
    }
}

fn opt_text(value: &Value) -> Option<String> {
    if value.is_null() { None } else { Some(text_value(value)) }
}

fn int_value(value: &Value) -> Option<i32> {
    py_int(value).and_then(|n| i32::try_from(n).ok())
}

fn float_value(value: &Value) -> Option<f64> {
    match value {
        Value::Number(n) => n.as_f64(),
        Value::Bool(b) => Some(f64::from(u8::from(*b))),
        _ => None,
    }
}

/// `setattr(run, key, value)` for a column of the run: puts `value` on the row's active model as a change. A key that
/// is not a column of `AiRun` is ignored (Python would put a plain attribute on the object that is never saved) and
/// `false` is returned; so is a value that does not fit the column.
pub fn set_run_field(row: &mut ai_run::ActiveModel, key: &str, value: &Value) -> bool {
    use kb_db::sea_orm::ActiveValue::Set;
    macro_rules! text {
        ($field:ident) => {{
            row.$field = Set(text_value(value));
            true
        }};
    }
    macro_rules! opt_text_field {
        ($field:ident) => {{
            row.$field = Set(opt_text(value));
            true
        }};
    }
    macro_rules! int {
        ($field:ident) => {
            match int_value(value) {
                Some(n) => {
                    row.$field = Set(n);
                    true
                }
                None => false,
            }
        };
    }
    macro_rules! opt_int {
        ($field:ident) => {
            if value.is_null() {
                row.$field = Set(None);
                true
            } else {
                match int_value(value) {
                    Some(n) => {
                        row.$field = Set(Some(n));
                        true
                    }
                    None => false,
                }
            }
        };
    }
    macro_rules! float {
        ($field:ident) => {
            match float_value(value) {
                Some(n) => {
                    row.$field = Set(n);
                    true
                }
                None => false,
            }
        };
    }
    macro_rules! opt_float {
        ($field:ident) => {
            if value.is_null() {
                row.$field = Set(None);
                true
            } else {
                match float_value(value) {
                    Some(n) => {
                        row.$field = Set(Some(n));
                        true
                    }
                    None => false,
                }
            }
        };
    }
    macro_rules! boolean {
        ($field:ident) => {{
            row.$field = Set(kb_base::pyjson::truthy(value));
            true
        }};
    }
    match key {
        "project_id" => text!(project_id),
        "kind" => text!(kind),
        "ticket_id" => opt_text_field!(ticket_id),
        "target" => opt_text_field!(target),
        "member_id" => text!(member_id),
        "number" => int!(number),
        "mode" => text!(mode),
        "trigger" => text!(trigger),
        "depth" => int!(depth),
        "state" => text!(state),
        "started_by" => text!(started_by),
        "instruction" => text!(instruction),
        "reply_comment_id" => opt_text_field!(reply_comment_id),
        "queued_at" => text!(queued_at),
        "started_at" => opt_text_field!(started_at),
        "ended_at" => opt_text_field!(ended_at),
        "last_output_at" => opt_text_field!(last_output_at),
        "ended_reason" => opt_text_field!(ended_reason),
        "ended_by" => opt_text_field!(ended_by),
        "exit_code" => opt_int!(exit_code),
        "summary" => opt_text_field!(summary),
        "report" => text!(report),
        "question" => opt_text_field!(question),
        "answer" => opt_text_field!(answer),
        "session_id" => opt_text_field!(session_id),
        "session_name" => opt_text_field!(session_name),
        "files" => text!(files),
        "tokens_in" => int!(tokens_in),
        "tokens_out" => int!(tokens_out),
        "tokens_cached" => opt_int!(tokens_cached),
        "cost_usd" => float!(cost_usd),
        "metered" => boolean!(metered),
        "context_used" => opt_int!(context_used),
        "context_window" => opt_int!(context_window),
        "pid" => opt_int!(pid),
        "token_hash" => opt_text_field!(token_hash),
        "model" => opt_text_field!(model),
        "effort" => opt_text_field!(effort),
        "paused" => boolean!(paused),
        "paused_at" => opt_text_field!(paused_at),
        "stop_code" => opt_text_field!(stop_code),
        "peak_rss_mb" => opt_float!(peak_rss_mb),
        "last_rss_mb" => opt_float!(last_rss_mb),
        "restarts" => text!(restarts),
        "diagnosis" => opt_text_field!(diagnosis),
        "retries" => text!(retries),
        "retry_at" => opt_text_field!(retry_at),
        "account_id" => opt_text_field!(account_id),
        "debug_log" => opt_text_field!(debug_log),
        "steps_count" => int!(steps_count),
        "waiting_reason" => opt_text_field!(waiting_reason),
        "live" => boolean!(live),
        "details_removed_at" => opt_text_field!(details_removed_at),
        _ => false,
    }
}
