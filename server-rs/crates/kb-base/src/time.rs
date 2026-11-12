//! Times as the Python server wrote them: `datetime.now(timezone.utc).isoformat()`.
//!
//! Every time column is such a string, and rows are ordered and compared as text, so the format must not drift:
//! `2026-11-11T14:30:43.123456+00:00`, and no fraction at all when the microseconds are zero.

use chrono::{
    DateTime, Datelike, Duration, FixedOffset, NaiveDate, NaiveDateTime, SecondsFormat, TimeZone, Timelike, Utc,
};

use crate::isoformat;

/// `datetime.now(timezone.utc).isoformat()`.
pub fn now_iso() -> String {
    iso(&Utc::now())
}

/// `dt.isoformat()` for an aware datetime: microseconds only when they are not zero, offset as `+HH:MM`.
pub fn iso<Tz: TimeZone>(dt: &DateTime<Tz>) -> String
where
    Tz::Offset: std::fmt::Display,
{
    let micros = dt.nanosecond() / 1_000;
    let base = dt.format("%Y-%m-%dT%H:%M:%S");
    let offset = dt.format("%:z");
    if micros == 0 { format!("{base}{offset}") } else { format!("{base}.{micros:06}{offset}") }
}

/// `dt.isoformat()` for a naive datetime (no offset).
pub fn iso_naive(dt: &NaiveDateTime) -> String {
    let micros = dt.nanosecond() / 1_000;
    let base = dt.format("%Y-%m-%dT%H:%M:%S");
    if micros == 0 { format!("{base}") } else { format!("{base}.{micros:06}") }
}

/// `dt.isoformat(timespec="milliseconds")` for an aware datetime.
pub fn iso_millis<Tz: TimeZone>(dt: &DateTime<Tz>) -> String
where
    Tz::Offset: std::fmt::Display,
{
    dt.to_rfc3339_opts(SecondsFormat::Millis, false)
}

/// What `datetime.fromisoformat` gave: a time with its offset, or one without (`Naive`), or a bare date.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Parsed {
    Aware(DateTime<FixedOffset>),
    Naive(NaiveDateTime),
}

impl Parsed {
    /// The instant, reading a naive value as UTC (what the server does with `replace(tzinfo=UTC)`).
    pub fn utc(&self) -> DateTime<Utc> {
        match self {
            Parsed::Aware(dt) => dt.with_timezone(&Utc),
            Parsed::Naive(dt) => Utc.from_utc_datetime(dt),
        }
    }
}

/// `datetime.fromisoformat(text)` of Python 3.12, exactly (`isoformat`): `None` where Python raises `ValueError`.
/// The text is taken as it is: white space around it is refused, as Python refuses it, so a caller strips where the
/// Python code strips.
///
/// An offset with a fraction of a second (`+05:30:15.5`, which Python accepts) keeps its whole seconds as the
/// offset of the value; the instant is exact.
pub fn parse_iso(text: &str) -> Option<Parsed> {
    let (wall, offset) = isoformat::parts(text)?;
    let Some((seconds, micros)) = offset else { return Some(Parsed::Naive(wall)) };
    let tz = FixedOffset::east_opt(seconds)?;
    let utc = wall
        .checked_sub_signed(Duration::seconds(i64::from(seconds)))?
        .checked_sub_signed(Duration::microseconds(i64::from(micros)))?;
    Some(Parsed::Aware(DateTime::from_naive_utc_and_offset(utc, tz)))
}

/// `datetime.fromisoformat(text)` as its parts: the wall time as written, and the offset in whole seconds when the
/// text has one.
pub fn isoformat_parts(text: &str) -> Option<(NaiveDateTime, Option<i32>)> {
    let (wall, offset) = isoformat::parts(text)?;
    Some((wall, offset.map(|(seconds, _)| seconds)))
}

/// Above this a number is milliseconds since the epoch, not seconds (Pydantic's watershed).
const MS_WATERSHED: i64 = 20_000_000_000;

/// What Pydantic reads for an `Optional[datetime]` that arrives as text (a query string): not `fromisoformat`, but
/// its own reader. A date and a time (`T`, `t`, a space or `_` between them; `HH:MM` with optional seconds and a
/// fraction after `.` or `,`; `Z`, `z` or `±HH:MM` / `±HHMM`), a date alone (midnight), or a number: seconds since
/// the epoch, milliseconds when it is larger than 2e10, read as UTC. `None` where Pydantic answers 422.
pub fn parse_query_datetime(text: &str) -> Option<Parsed> {
    let parsed = match rfc3339(text.as_bytes()) {
        Some(parsed) => parsed,
        None => Parsed::Aware(unix_time(text)?.fixed_offset()),
    };
    // a Python datetime is in the years 1 to 9999
    let wall = match &parsed {
        Parsed::Aware(at) => at.naive_local(),
        Parsed::Naive(at) => *at,
    };
    (1..=9999).contains(&wall.year()).then_some(parsed)
}

/// Two ASCII digits at `at`.
fn two_digits(s: &[u8], at: usize) -> Option<u32> {
    match (s.get(at)?, s.get(at + 1)?) {
        (a @ b'0'..=b'9', b @ b'0'..=b'9') => Some(u32::from(a - b'0') * 10 + u32::from(b - b'0')),
        _ => None,
    }
}

/// `YYYY-MM-DD`, then nothing or a separator and a time with an optional zone.
fn rfc3339(s: &[u8]) -> Option<Parsed> {
    if s.len() < 10 || s[4] != b'-' || s[7] != b'-' {
        return None;
    }
    let year = two_digits(s, 0)? * 100 + two_digits(s, 2)?;
    let date = NaiveDate::from_ymd_opt(i32::try_from(year).ok()?, two_digits(s, 5)?, two_digits(s, 8)?)?;
    if s.len() == 10 {
        return Some(Parsed::Naive(date.and_hms_opt(0, 0, 0)?));
    }
    if !matches!(s[10], b'T' | b't' | b' ' | b'_') {
        return None;
    }
    let (hour, minute) = (two_digits(s, 11)?, two_digits(s, 14)?);
    if s.get(13) != Some(&b':') {
        return None;
    }
    let mut at = 16;
    let (mut second, mut micros) = (0, 0);
    if s.get(at) == Some(&b':') {
        second = two_digits(s, at + 1)?;
        at += 3;
        if matches!(s.get(at), Some(b'.' | b',')) {
            at += 1;
            let start = at;
            while s.get(at).is_some_and(u8::is_ascii_digit) {
                // the digits after the sixth are dropped
                if at - start < 6 {
                    micros = micros * 10 + u32::from(s[at] - b'0');
                }
                at += 1;
            }
            if at == start {
                return None;
            }
            micros *= 10u32.pow(6 - (at - start).min(6) as u32);
        }
    }
    let wall = date.and_hms_micro_opt(hour, minute, second, micros).filter(|_| second < 60)?;
    let rest = &s[at..];
    let (sign, zone) = match rest {
        [] => return Some(Parsed::Naive(wall)),
        [b'Z' | b'z'] => (1, None),
        [b'+', zone @ ..] => (1, Some(zone)),
        [b'-', zone @ ..] => (-1, Some(zone)),
        // U+2212, the minus sign
        [0xe2, 0x88, 0x92, zone @ ..] => (-1, Some(zone)),
        _ => return None,
    };
    let seconds = match zone {
        None => 0,
        Some(zone) => {
            let minutes = match zone.len() {
                4 => two_digits(zone, 2)?,
                5 if zone[2] == b':' => two_digits(zone, 3)?,
                _ => return None,
            };
            let hours = two_digits(zone, 0)?;
            if minutes > 59 || hours > 23 {
                return None;
            }
            sign * i32::try_from(hours * 3600 + minutes * 60).ok()?
        }
    };
    let tz = FixedOffset::east_opt(seconds)?;
    let utc = wall.checked_sub_signed(Duration::seconds(i64::from(seconds)))?;
    Some(Parsed::Aware(DateTime::from_naive_utc_and_offset(utc, tz)))
}

/// A number as a time: `[+-]digits[.digits]` (one of the two groups of digits may be empty), nothing else.
fn unix_time(text: &str) -> Option<DateTime<Utc>> {
    let body = text.strip_prefix(['+', '-']).unwrap_or(text);
    let (whole, fraction) = body.split_once('.').map_or((body, None), |(w, f)| (w, Some(f)));
    let digits = |part: &str| part.bytes().all(|b| b.is_ascii_digit());
    if !digits(whole) || !fraction.is_none_or(digits) || (whole.is_empty() && fraction.is_none_or(str::is_empty)) {
        return None;
    }
    let (seconds, micros) = match fraction {
        None => (text.parse::<i64>().ok()?, 0),
        Some(_) => {
            let mut value = text.parse::<f64>().ok().filter(|v| v.is_finite())?;
            if value.abs() > MS_WATERSHED as f64 {
                value /= 1000.0;
            }
            let floor = value.floor();
            if floor.abs() > 9.0e18 {
                return None;
            }
            (floor as i64, ((value - floor) * 1_000_000.0).round() as i64)
        }
    };
    // a number this large is in milliseconds
    let (seconds, micros) = if seconds.unsigned_abs() > MS_WATERSHED.unsigned_abs() {
        (seconds.div_euclid(1000), micros + seconds.rem_euclid(1000) * 1000)
    } else {
        (seconds, micros)
    };
    let seconds = seconds.checked_add(micros.div_euclid(1_000_000))?;
    DateTime::<Utc>::from_timestamp(seconds, u32::try_from(micros.rem_euclid(1_000_000)).ok()? * 1000)
}

/// `time.time()`: seconds since the epoch as a float.
pub fn epoch() -> f64 {
    let now = Utc::now();
    now.timestamp() as f64 + f64::from(now.timestamp_subsec_micros()) / 1e6
}

/// `str(uuid.uuid4())`.
pub fn uuid4() -> String {
    uuid::Uuid::new_v4().to_string()
}

/// `uuid.uuid4().hex`.
pub fn uuid4_hex() -> String {
    uuid::Uuid::new_v4().simple().to_string()
}

/// `f"{prefix}{uuid.uuid4().hex[:n]}"`: the short ids of rows such as `run_1a2b3c4d5e6f`.
pub fn prefixed_id(prefix: &str, n: usize) -> String {
    let hex = uuid4_hex();
    format!("{prefix}{}", &hex[..n.min(hex.len())])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn iso_matches_python() {
        let dt = Utc.with_ymd_and_hms(2026, 11, 11, 14, 30, 43).unwrap();
        assert_eq!(iso(&dt), "2026-11-11T14:30:43+00:00");
        let dt = dt + chrono::Duration::microseconds(123_456);
        assert_eq!(iso(&dt), "2026-11-11T14:30:43.123456+00:00");
        let dt = dt.with_timezone(&FixedOffset::east_opt(7 * 3600).unwrap());
        assert_eq!(iso(&dt), "2026-11-11T21:30:43.123456+07:00");
        assert_eq!(iso_millis(&dt), "2026-11-11T21:30:43.123+07:00");
    }

    #[test]
    fn parses_what_python_parses() {
        let p = parse_iso("2026-11-11T14:30:43.123456+00:00").unwrap();
        assert_eq!(iso(&p.utc()), "2026-11-11T14:30:43.123456+00:00");
        assert!(matches!(parse_iso("2026-11-11 14:30"), Some(Parsed::Naive(_))));
        assert!(matches!(parse_iso("2026-11-11"), Some(Parsed::Naive(_))));
        assert_eq!(iso(&parse_iso("2026-11-11T14:30:43Z").unwrap().utc()), "2026-11-11T14:30:43+00:00");
        assert_eq!(iso(&parse_iso("2026-11-11T21:30:43.5+07:00").unwrap().utc()), "2026-11-11T14:30:43.500000+00:00");
        assert!(parse_iso("yesterday").is_none());
        assert!(parse_iso("2026-13-01").is_none());
        // what a lenient reader takes and Python refuses (the whole list is in `tests/parse_iso.rs`)
        assert!(parse_iso(" 2026-11-11T14:30:43+00:00 ").is_none());
        assert!(parse_iso("2026-11-11T14:30:43z").is_none());
        assert!(parse_iso("2026-11-11T1:2:3").is_none());
        // and what Python takes that a lenient reader did not
        assert_eq!(parse_iso("20261111T143043Z").map(|p| iso(&p.utc())).as_deref(), Some("2026-11-11T14:30:43+00:00"));
        assert_eq!(
            isoformat_parts("2026-W46-3").map(|(wall, _)| iso_naive(&wall)).as_deref(),
            Some("2026-11-11T00:00:00")
        );
    }
}
