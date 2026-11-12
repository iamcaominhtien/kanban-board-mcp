//! Time (`services/ai/schedules.py` lines 93 to 222): `zone`, `_hm`, `tz_label`, `_once_at`, `slots`, `_advance`,
//! `_fmt_day`, `when_label`, `in_words`.
//!
//! A local time is read as Python's `zoneinfo` reads a `datetime` with `fold=0`: a time that comes twice (clocks set
//! back) is its first coming, and a time that does not exist (clocks set forward) is counted with the offset before
//! the change, so 02:30 on such a night is 03:30 on the clock.

use std::collections::BTreeSet;

use chrono::{DateTime, Datelike, Duration, LocalResult, NaiveDate, NaiveDateTime, Offset, TimeZone, Utc};
use chrono_tz::Tz;
use kb_ai::store::{isoformat_parts, loads, py_int};
use kb_base::{pyjson, pytext, time};
use kb_db::entities::ai_schedule;
use serde_json::{Value, json};

use super::{DAY_NAMES, Error, refuse};
use crate::clock;

/// The time zone, or ScheduleError (`ZoneInfo(name or "UTC")`).
pub fn zone(name: Option<&str>) -> Result<Tz, Error> {
    let key = name.filter(|n| !n.is_empty()).unwrap_or("UTC");
    match key.parse::<Tz>() {
        Ok(tz) => Ok(tz),
        // a name that is a folder of the time zone database ("Europe"): Python fails on it with an `OSError`, which
        // nothing catches
        Err(_)
            if chrono_tz::TZ_VARIANTS
                .iter()
                .any(|tz| tz.name().strip_prefix(key).is_some_and(|rest| rest.starts_with('/'))) =>
        {
            Err(Error::Other(format!("[Errno 21] Is a directory: {key:?}")))
        }
        Err(_) => refuse("invalid", format!("Unknown time zone: {key}.")),
    }
}

/// `_hm`: the hour and the minute of "HH:MM". (`value` None is Python's `None`: the message names it so.)
pub fn hm(value: Option<&str>) -> Result<(u32, u32), Error> {
    let bad = || {
        refuse::<(u32, u32)>(
            "invalid",
            format!("Time must be HH:MM, not {}.", value.map_or_else(|| "None".to_string(), pytext::repr)),
        )
    };
    // `h, m = (int(x) for x in value.split(":")[:2])`: exactly two numbers, as `int` reads them
    let parts: Vec<&str> = value.unwrap_or("").split(':').take(2).collect();
    let [h, m] = parts.as_slice() else { return bad() };
    let (Some(h), Some(m)) = (py_int(&json!(h)), py_int(&json!(m))) else { return bad() };
    if !((0..24).contains(&h) && (0..60).contains(&m)) {
        return bad();
    }
    Ok((h as u32, m as u32))
}

/// UTC+7, UTC+5:30, UTC−3, UTC. (`at` None: now.)
pub fn tz_label(name: &str, at: Option<DateTime<Utc>>) -> Result<String, Error> {
    let tz = zone(Some(name))?;
    let local = at.unwrap_or_else(clock::now).with_timezone(&tz);
    // `int(off.total_seconds() // 60)`
    let mins = i64::from(local.offset().fix().local_minus_utc()).div_euclid(60);
    if mins == 0 {
        return Ok("UTC".to_string());
    }
    let sign = if mins > 0 { "+" } else { "−" };
    let (h, m) = (mins.abs() / 60, mins.abs() % 60);
    Ok(if m != 0 { format!("UTC{sign}{h}:{m:02}") } else { format!("UTC{sign}{h}") })
}

/// The offset (seconds east of UTC) Python gives a wall time that the zone skips: the one before the gap (`fold` 0)
/// or the one after it (`fold` 1).
fn gap_offset(tz: Tz, wall: NaiveDateTime, fold: bool) -> i32 {
    // the nearest wall time that exists, a quarter of an hour at a time (a zone may skip a whole day)
    for step in 1..=200 {
        let near = if fold { wall + Duration::minutes(15 * step) } else { wall - Duration::minutes(15 * step) };
        match tz.from_local_datetime(&near) {
            LocalResult::Single(dt) => return dt.offset().fix().local_minus_utc(),
            LocalResult::Ambiguous(first, second) => {
                return (if fold { first } else { second }).offset().fix().local_minus_utc();
            }
            LocalResult::None => {}
        }
    }
    tz.offset_from_utc_datetime(&wall).fix().local_minus_utc()
}

/// `wall.replace(tzinfo=tz, fold=fold).astimezone(UTC)`.
pub(crate) fn wall_to_utc(tz: Tz, wall: NaiveDateTime, fold: bool) -> DateTime<Utc> {
    match tz.from_local_datetime(&wall) {
        LocalResult::Single(dt) => dt.with_timezone(&Utc),
        LocalResult::Ambiguous(first, second) => (if fold { second } else { first }).with_timezone(&Utc),
        LocalResult::None => Utc.from_utc_datetime(&(wall - Duration::seconds(i64::from(gap_offset(tz, wall, fold))))),
    }
}

/// The `fold` Python gives `at.astimezone(tz)`: true for the second coming of a wall time that comes twice.
pub(crate) fn fold_of(tz: Tz, at: DateTime<Utc>) -> bool {
    match tz.from_local_datetime(&at.with_timezone(&tz).naive_local()) {
        LocalResult::Ambiguous(_, second) => second.with_timezone(&Utc) == at,
        _ => false,
    }
}

/// `_once_at`: when a one-off schedule runs (UTC), or None when its `run_at` is no time.
pub fn once_at(s: &ai_schedule::Model) -> Result<Option<DateTime<Utc>>, Error> {
    let Some(run_at) = s.run_at.as_deref().filter(|r| !r.is_empty()) else { return Ok(None) };
    let Some((local, offset)) = isoformat_parts(run_at) else { return Ok(None) };
    Ok(Some(match offset {
        Some(offset) => Utc.from_utc_datetime(&(local - Duration::seconds(i64::from(offset)))),
        None => wall_to_utc(zone(Some(&s.tz))?, local, false),
    }))
}

/// `{int(d) for d in loads(s.days, [])}`: the weekdays of a repeating schedule (Monday = 0).
pub(crate) fn days_of(s: &ai_schedule::Model) -> Result<BTreeSet<i128>, Error> {
    let items: Vec<Value> = match loads(Some(&s.days), json!([])) {
        Value::Array(items) => items,
        // (Python walks the keys of a dict and the characters of a text)
        Value::Object(map) => map.keys().map(|k| json!(k)).collect(),
        Value::String(text) => text.chars().map(|c| json!(c.to_string())).collect(),
        other => return Err(Error::Other(format!("the days of schedule {} are not a list: {other}", s.id))),
    };
    items
        .iter()
        .map(|d| {
            py_int(d)
                .ok_or_else(|| Error::Other(format!("invalid literal for int() with base 10: {}", pyjson::py_repr(d))))
        })
        .collect()
}

/// The next `n` planned starts after `after` (UTC), honouring the end rule (Python's default `n`: 5).
pub fn slots(s: &ai_schedule::Model, after: DateTime<Utc>, n: usize) -> Result<Vec<DateTime<Utc>>, Error> {
    if s.kind == "once" {
        let at = once_at(s)?;
        return Ok(at.filter(|at| *at > after && s.runs_count == 0).into_iter().collect());
    }
    let days = days_of(s)?;
    if days.is_empty() {
        return Ok(Vec::new());
    }
    let tz = zone(Some(&s.tz))?;
    let (h, m) = hm(Some(&s.time))?;
    let mut out: Vec<DateTime<Utc>> = Vec::new();
    let first: NaiveDate = after.with_timezone(&tz).date_naive();
    let ends_on = s.ends_on.as_deref().filter(|e| !e.is_empty());
    let ends_after = s.ends_after.filter(|n| *n != 0);
    for i in 0..400 {
        let Some(day) = first.checked_add_signed(Duration::days(i)) else { break };
        if s.ends == "on_date" && ends_on.is_some_and(|ends_on| day.to_string().as_str() > ends_on) {
            break;
        }
        if !days.contains(&i128::from(day.weekday().num_days_from_monday())) {
            continue;
        }
        let Some(wall) = day.and_hms_opt(h, m, 0) else { continue };
        let at = wall_to_utc(tz, wall, false);
        if at <= after {
            continue;
        }
        if s.ends == "after" && ends_after.is_some_and(|n| i64::from(s.runs_count) + out.len() as i64 >= i64::from(n)) {
            break;
        }
        out.push(at);
        if out.len() >= n {
            break;
        }
    }
    Ok(out)
}

/// `_advance`: plan the next start; with nothing left the schedule ends (`end` false while its last slot is still
/// open).
pub fn advance(s: &mut ai_schedule::Model, after: DateTime<Utc>, end: bool) -> Result<(), Error> {
    let nxt = slots(s, after, 1)?;
    s.next_run_at = nxt.first().map(time::iso);
    if nxt.is_empty() && end && s.state == "active" {
        s.state = "ended".to_string();
    }
    Ok(())
}

/// `DAY_NAMES[local.weekday()]`.
pub(crate) fn day_name<D: Datelike>(local: &D) -> &'static str {
    DAY_NAMES[local.weekday().num_days_from_monday() as usize]
}

/// `_fmt_day`: "Wed Oct 30" in the zone.
pub fn fmt_day(at: DateTime<Utc>, tz: &str) -> Result<String, Error> {
    let local = at.with_timezone(&zone(Some(tz))?);
    Ok(format!("{} {} {}", day_name(&local), local.format("%b"), local.day()))
}

/// `f"{at.astimezone(zone(tz)):%H:%M}"`.
pub(crate) fn clock_time(at: DateTime<Utc>, tz: &str) -> Result<String, Error> {
    Ok(at.with_timezone(&zone(Some(tz))?).format("%H:%M").to_string())
}

/// Weekdays at 02:00 · Every Mon, Wed at 22:00 · Once · Wed Oct 30, 23:30.
pub fn when_label(s: &ai_schedule::Model) -> Result<String, Error> {
    if s.kind == "once" {
        return Ok(match once_at(s)? {
            Some(at) => format!("Once · {}, {}", fmt_day(at, &s.tz)?, clock_time(at, &s.tz)?),
            None => "Once".to_string(),
        });
    }
    let days: Vec<i128> = days_of(s)?.into_iter().collect();
    let head = if days == [0, 1, 2, 3, 4] {
        "Weekdays".to_string()
    } else if days == [0, 1, 2, 3, 4, 5, 6] {
        "Every day".to_string()
    } else if days == [5, 6] {
        "Weekends".to_string()
    } else {
        let names: Vec<&str> = days
            .iter()
            .map(|d| {
                // (a Python list counts a negative index from its end)
                let index = if *d < 0 { *d + 7 } else { *d };
                usize::try_from(index)
                    .ok()
                    .and_then(|i| DAY_NAMES.get(i).copied())
                    .ok_or_else(|| Error::Other("list index out of range".to_string()))
            })
            .collect::<Result<_, _>>()?;
        format!("Every {}", names.join(", "))
    };
    Ok(format!("{head} at {}", s.time))
}

/// in 6 h 12 m · in 1 d 21 h · in 5 d · 3 h ago. (`now` None: now.)
pub fn in_words(at: DateTime<Utc>, now: Option<DateTime<Utc>>) -> String {
    let delta = at.signed_duration_since(now.unwrap_or_else(clock::now));
    let micros = delta.num_microseconds().unwrap_or_else(|| delta.num_milliseconds().saturating_mul(1000));
    let past = micros < 0;
    let secs = micros.abs() / 1_000_000;
    let (d, rem) = (secs / 86400, secs % 86400);
    let (h, rem) = (rem / 3600, rem % 3600);
    let m = rem / 60;
    let text = if d >= 3 {
        format!("{d} d")
    } else if d != 0 {
        format!("{d} d {h} h")
    } else if h != 0 {
        format!("{h} h {m} m")
    } else {
        format!("{} min", m.max(1))
    };
    if past { format!("{text} ago") } else { format!("in {text}") }
}
