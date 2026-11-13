//! `datetime.fromisoformat` of Python 3.12, shape for shape.
//!
//! This is a port of the C implementation (`_datetimemodule.c`), which reads more than the documentation lists and
//! less than a lenient parser would: any one character between the date and the time, basic format (`20261111T1430`),
//! week dates (`2026-W46-3`), a fraction after `.` or `,` of any length (cut at microseconds), `Z` or an offset
//! `±HH[:MM[:SS[.ffffff]]]` strictly under a day. It refuses white space around the text, a lowercase `z`, one-digit
//! fields, hour 24, a second 60. The vectors are in `contract/golden/parse_iso.json` (`gen_parse_iso.py`).
//!
//! `kb_base::time::parse_iso` is the way in; this module is the parser itself.

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
        // a week of year 9999 may end in year 10000, which is no date in Python
        return chrono::NaiveDate::from_isoywd_opt(year, u32::try_from(week).ok()?, weekday)
            .filter(|date| (1..=9999).contains(&chrono::Datelike::year(date)));
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

/// An offset: whole seconds, and the microseconds an offset with a fraction adds (both carry the sign).
pub type Offset = (i32, i32);

/// `parse_isoformat_time` on `s[start..]`: (hour, minute, second, microsecond, offset when there is one).
fn parse_time(s: &[u8], start: usize) -> Option<(i32, i32, i32, i32, Option<Offset>)> {
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
        return if at(tz + 1) != 0 { None } else { Some((h, m, sec, clock.micros, Some((0, 0)))) };
    }
    let sign = if at(tz) == b'-' { -1 } else { 1 };
    let zone = parse_clock(s, tz + 1, end)?;
    if zone.more {
        return None;
    }
    let offset = sign * (zone.parts[0] * 3600 + zone.parts[1] * 60 + zone.parts[2]);
    // `tzinfo_from_isoformat_results`: an offset of zero seconds is UTC whatever fraction follows it
    let micros = if offset == 0 { 0 } else { sign * zone.micros };
    Some((h, m, sec, clock.micros, Some((offset, micros))))
}

/// `datetime.fromisoformat(text)`: the wall time as written, and the offset when the text has one. `None` where
/// Python raises `ValueError`.
pub fn parts(text: &str) -> Option<(chrono::NaiveDateTime, Option<Offset>)> {
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
    if offset
        .is_some_and(|(seconds, micros)| (i64::from(seconds) * 1_000_000 + i64::from(micros)).abs() >= 86_400_000_000)
    {
        return None;
    }
    Some((naive, offset))
}
