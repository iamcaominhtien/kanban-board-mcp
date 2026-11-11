//! Times as the Python server wrote them: `datetime.now(timezone.utc).isoformat()`.
//!
//! Every time column is such a string, and rows are ordered and compared as text, so the format must not drift:
//! `2026-11-11T14:30:43.123456+00:00`, and no fraction at all when the microseconds are zero.

use chrono::{
    DateTime, FixedOffset, NaiveDate, NaiveDateTime, SecondsFormat, TimeZone, Timelike, Utc,
};

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
    if micros == 0 {
        format!("{base}{offset}")
    } else {
        format!("{base}.{micros:06}{offset}")
    }
}

/// `dt.isoformat()` for a naive datetime (no offset).
pub fn iso_naive(dt: &NaiveDateTime) -> String {
    let micros = dt.nanosecond() / 1_000;
    let base = dt.format("%Y-%m-%dT%H:%M:%S");
    if micros == 0 {
        format!("{base}")
    } else {
        format!("{base}.{micros:06}")
    }
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

/// `datetime.fromisoformat(text)` (Python 3.11+): date, date and time with `T` or a space, optional fraction of any
/// length, optional `Z` or `±HH:MM` / `±HHMM` / `±HH` offset. `None` where Python raises `ValueError`.
pub fn parse_iso(text: &str) -> Option<Parsed> {
    let text = text.trim();
    if text.len() == 10 {
        let date = NaiveDate::parse_from_str(text, "%Y-%m-%d").ok()?;
        return Some(Parsed::Naive(date.and_hms_opt(0, 0, 0)?));
    }
    if text.len() < 13 {
        return None;
    }
    let (date, rest) = text.split_at(10);
    let date = NaiveDate::parse_from_str(date, "%Y-%m-%d").ok()?;
    let sep = rest.chars().next()?;
    if sep != 'T' && sep != ' ' && sep != 't' {
        return None;
    }
    let rest = &rest[1..];
    // split the offset off: the last '+' or '-' after the time, or a trailing 'Z'
    let (clock, offset) = if let Some(stripped) = rest.strip_suffix(['Z', 'z']) {
        (stripped, Some(0))
    } else if let Some(pos) = rest.rfind(['+', '-']) {
        let (clock, off) = rest.split_at(pos);
        (clock, Some(parse_offset(off)?))
    } else {
        (rest, None)
    };
    let (hms, fraction) = match clock.split_once(['.', ',']) {
        Some((hms, fraction)) => (hms, Some(fraction)),
        None => (clock, None),
    };
    let mut parts = hms.split(':');
    let hour: u32 = parts.next()?.parse().ok()?;
    let minute: u32 = parts
        .next()
        .map(|p| p.parse())
        .transpose()
        .ok()?
        .unwrap_or(0);
    let second: u32 = parts
        .next()
        .map(|p| p.parse())
        .transpose()
        .ok()?
        .unwrap_or(0);
    if parts.next().is_some() {
        return None;
    }
    let micros: u32 = match fraction {
        None => 0,
        Some(f) if !f.is_empty() && f.bytes().all(|b| b.is_ascii_digit()) => {
            let padded: String = f.chars().chain(std::iter::repeat('0')).take(6).collect();
            padded.parse().ok()?
        }
        Some(_) => return None,
    };
    let naive = date.and_hms_micro_opt(hour, minute, second, micros)?;
    match offset {
        None => Some(Parsed::Naive(naive)),
        Some(seconds) => {
            let tz = FixedOffset::east_opt(seconds)?;
            tz.from_local_datetime(&naive).single().map(Parsed::Aware)
        }
    }
}

fn parse_offset(text: &str) -> Option<i32> {
    let sign = if text.starts_with('-') { -1 } else { 1 };
    let digits: String = text[1..].chars().filter(|c| *c != ':').collect();
    if !digits.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let (h, m, s) = match digits.len() {
        2 => (digits.parse::<i32>().ok()?, 0, 0),
        4 => (digits[..2].parse().ok()?, digits[2..].parse().ok()?, 0),
        6 => (
            digits[..2].parse().ok()?,
            digits[2..4].parse().ok()?,
            digits[4..].parse().ok()?,
        ),
        _ => return None,
    };
    Some(sign * (h * 3600 + m * 60 + s))
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
        assert!(matches!(
            parse_iso("2026-11-11 14:30"),
            Some(Parsed::Naive(_))
        ));
        assert!(matches!(parse_iso("2026-11-11"), Some(Parsed::Naive(_))));
        assert_eq!(
            iso(&parse_iso("2026-11-11T14:30:43Z").unwrap().utc()),
            "2026-11-11T14:30:43+00:00"
        );
        assert_eq!(
            iso(&parse_iso("2026-11-11T21:30:43.5+07:00").unwrap().utc()),
            "2026-11-11T14:30:43.500000+00:00"
        );
        assert!(parse_iso("yesterday").is_none());
        assert!(parse_iso("2026-13-01").is_none());
    }
}
