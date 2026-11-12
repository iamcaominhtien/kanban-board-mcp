//! What the CLI prints when the provider limits it: is it limited, until when, and the line to show as the reason.

use std::sync::LazyLock;

use chrono::{DateTime, Datelike, Days, NaiveDateTime, TimeZone, Timelike, Utc};
use kb_base::pytext;
use kb_base::secrets::redact;
use regex::Regex;

fn pattern(text: &str) -> Regex {
    Regex::new(text).expect("a pattern written in the code compiles")
}

/// `_RATE_LIMITED` without its `hit your ... limit` alternative, which ends with a look-ahead (`(?! of)`) the `regex`
/// crate does not have; `hits_your_limit` tests that one.
static RATE_LIMITED: LazyLock<Regex> = LazyLock::new(|| {
    pattern(concat!(
        r"(?i)(\b429\b|rate.?limit|usage limit|overloaded_error|too many requests",
        r"|(?:5-hour|weekly|opus|sonnet|session|daily|usage|monthly) limit reached",
        r"|resource_exhausted|insufficient_quota|exhausted your \w+ quota|quota exceeded for quota metric)",
    ))
});
static HIT_YOUR: LazyLock<Regex> = LazyLock::new(|| pattern(r"(?i)hit your "));
/// The two ways `hit your (?:\w+ )?limit\b` can match from its start: with a word before `limit`, and without.
static HIT_LIMIT: LazyLock<[Regex; 2]> =
    LazyLock::new(|| [pattern(r"(?i)^hit your \w+ limit\b"), pattern(r"(?i)^hit your limit\b")]);

/// `hit your (?:\w+ )?limit\b(?! of)` found anywhere in `text`.
fn hits_your_limit(text: &str) -> bool {
    HIT_YOUR.find_iter(text).any(|start| {
        let rest = &text[start.start()..];
        HIT_LIMIT.iter().any(|way| way.find(rest).is_some_and(|m| !rest[m.end()..].starts_with(" of")))
    })
}

/// `_RATE_LIMITED.search(text)`.
pub(crate) fn rate_limited(text: &str) -> bool {
    RATE_LIMITED.is_match(text) || hits_your_limit(text)
}

/// "resets Nov 2 at 4pm (Asia/Saigon)", "resets Nov 3, 9am", "resets 3:30pm (America/New_York)". Digits are ASCII
/// digits here (Python's `\d` also takes other scripts' digits, which no CLI prints).
static RESETS: LazyLock<Regex> = LazyLock::new(|| {
    pattern(concat!(
        r"(?i)resets?\s+(?:(?P<mon>[A-Za-z]{3,9})\.?\s+(?P<day>[0-9]{1,2})(?:,|\s+at)?\s+)?",
        r"(?P<h>[0-9]{1,2})(?::(?P<m>[0-9]{2}))?\s*(?P<ap>am|pm)\b(?:\s*\((?P<tz>[A-Za-z_]+(?:/[A-Za-z_+\-0-9]+)*)\))?",
    ))
});
static RESET_STAMP: LazyLock<Regex> = LazyLock::new(|| pattern(r"\|([0-9]{10})\b"));
static RETRY_AFTER: LazyLock<Regex> = LazyLock::new(|| pattern(r"(?i)retry[- ]after\D{0,10}([0-9]+)"));
/// How long to wait when a limit message names no time.
pub const RATE_WAIT_DEFAULT: f64 = 45.0;
/// The longest wait a limit message can ask for.
pub const RATE_WAIT_MAX: f64 = 6.0 * 3600.0;

const MONTHS: [&str; 12] = [
    "january",
    "february",
    "march",
    "april",
    "may",
    "june",
    "july",
    "august",
    "september",
    "october",
    "november",
    "december",
];

/// Python's dates run from the year 1 to the year 9999; past them it raises, and `reset_wait` gives None.
fn in_python_range(when: &NaiveDateTime) -> bool {
    (1..=9999).contains(&when.year())
}

/// Seconds until the time a plan-limit message says the limit resets, or None when it names none. `now` is the
/// moment to count from (None: now). A message without a zone means this computer's own.
pub fn reset_wait(text: &str, now: Option<DateTime<Utc>>) -> Option<f64> {
    reset_wait_in(text, now.unwrap_or_else(Utc::now), &chrono::Local)
}

/// `reset_wait` with the zone to use when the message names none or one that does not exist (`_reset_wait`).
///
/// Python does all of it on the clock of that zone (two times with the same `tzinfo` are compared and subtracted as
/// the clock shows them, without the zone's offset), and so does this.
pub fn reset_wait_in<Z: TimeZone>(text: &str, now: DateTime<Utc>, local: &Z) -> Option<f64> {
    let m = RESETS.captures(text)?;
    let number = |name: &str| m.name(name).and_then(|g| g.as_str().parse::<u32>().ok());
    let h = number("h")?;
    let minute = number("m").unwrap_or(0);
    if !(1..=12).contains(&h) || minute > 59 {
        return None;
    }
    let zone = m.name("tz").and_then(|tz| tz.as_str().parse::<chrono_tz::Tz>().ok());
    let now: NaiveDateTime = match zone {
        Some(zone) => now.with_timezone(&zone).naive_local(),
        None => now.with_timezone(local).naive_local(), // zone None: this computer's own
    };
    if !in_python_range(&now) {
        return None; // OverflowError
    }
    let pm = m.name("ap").is_some_and(|ap| ap.as_str().eq_ignore_ascii_case("pm"));
    let hour = h % 12 + if pm { 12 } else { 0 };
    let mut when = now.with_hour(hour)?.with_minute(minute)?.with_second(0)?.with_nanosecond(0)?;
    if let Some(mon) = m.name("mon") {
        let head: String = mon.as_str().to_lowercase().chars().take(3).collect();
        let month = MONTHS.iter().position(|name| name.starts_with(&head))? + 1;
        let day = number("day")?;
        when = when.date().with_day(1)?.with_month(u32::try_from(month).ok()?)?.with_day(day)?.and_time(when.time());
        if when < now.checked_sub_days(Days::new(1)).filter(in_python_range)? {
            when = when.with_year(when.year() + 1).filter(in_python_range)?;
        }
    } else if when < now {
        when = when.checked_add_days(Days::new(1)).filter(in_python_range)?;
    }
    let delta = when - now;
    Some(delta.num_microseconds()? as f64 / 1e6)
}

/// The line of the CLI's output that says it is limited, to show as the reason.
pub fn rate_limit_line(text: Option<&str>) -> Option<String> {
    pytext::splitlines(text.unwrap_or(""))
        .into_iter()
        .find(|line| rate_limited(line))
        .map(|line| redact(pytext::strip(line)).chars().take(160).collect())
}

/// Seconds to wait when the CLI's output says the provider is rate-limiting it, else None. A usage-limit
/// message names the time it resets (`...limit reached|1760000000` or "resets Nov 2 at 4pm (Asia/Saigon)");
/// "retry after N" is honoured too.
pub fn rate_limit_wait(text: Option<&str>) -> Option<f64> {
    rate_limit_wait_at(text, kb_base::time::epoch(), Utc::now(), &chrono::Local)
}

/// `rate_limit_wait` with the clock (`time.time()`, `datetime.now(UTC)`) and the computer's zone given.
pub fn rate_limit_wait_at<Z: TimeZone>(text: Option<&str>, epoch: f64, now: DateTime<Utc>, local: &Z) -> Option<f64> {
    let text = text.filter(|t| !t.is_empty() && rate_limited(t))?;
    let wait = if let Some(reset) = RESET_STAMP.captures(text) {
        reset[1].parse::<f64>().unwrap_or(0.0) - epoch
    } else if let Some(until) = reset_wait_in(text, now, local) {
        until
    } else {
        RETRY_AFTER.captures(text).and_then(|after| after[1].parse::<f64>().ok()).unwrap_or(RATE_WAIT_DEFAULT)
    };
    Some(wait.clamp(5.0, RATE_WAIT_MAX))
}
