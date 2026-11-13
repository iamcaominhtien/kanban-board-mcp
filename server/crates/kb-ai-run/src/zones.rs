//! Time zones as Python's `zoneinfo.ZoneInfo` finds them: in the time zone database of the system
//! (`/usr/share/zoneinfo` on macOS and Linux), and in a copy carried in the program where the system has none
//! (Windows; Python carried the `tzdata` package for that). The rules of a zone are then the ones the system knows
//! today, as they were for the Python server, and not the ones of the day the program was built.
//!
//! [`Zone`] is a `chrono::TimeZone`, so the code that counts with local times is written with `chrono` as before.

use std::fmt;
use std::sync::LazyLock;

use chrono::{FixedOffset, LocalResult, NaiveDate, NaiveDateTime, NaiveTime, Offset, TimeZone};
use jiff::tz::{AmbiguousOffset, TimeZone as Rules, TimeZoneDatabase};

/// A time zone of the time zone database.
#[derive(Clone, Debug)]
pub struct Zone(Rules);

/// The offset of a [`Zone`] at one moment.
#[derive(Clone, Debug)]
pub struct ZoneOffset {
    zone: Zone,
    fixed: FixedOffset,
}

impl Offset for ZoneOffset {
    fn fix(&self) -> FixedOffset {
        self.fixed
    }
}

impl fmt::Display for ZoneOffset {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.fixed.fmt(f)
    }
}

fn fixed(seconds: i32) -> FixedOffset {
    FixedOffset::east_opt(seconds).unwrap_or_else(|| FixedOffset::east_opt(0).expect("zero is an offset"))
}

/// The same wall time for `jiff` (None outside the years it counts, which are the years Python counts too).
fn civil(local: &NaiveDateTime) -> Option<jiff::civil::DateTime> {
    use chrono::{Datelike, Timelike};
    jiff::civil::DateTime::new(
        i16::try_from(local.year()).ok()?,
        i8::try_from(local.month()).ok()?,
        i8::try_from(local.day()).ok()?,
        i8::try_from(local.hour()).ok()?,
        i8::try_from(local.minute()).ok()?,
        i8::try_from(local.second()).ok()?,
        // (a leap second of chrono is a nanosecond count of a second and more: the second itself is kept)
        i32::try_from(local.nanosecond().min(999_999_999)).ok()?,
    )
    .ok()
}

/// The copy of the database carried in the program (Python's `tzdata` package).
static CARRIED: LazyLock<TimeZoneDatabase> = LazyLock::new(TimeZoneDatabase::bundled);

/// The zone called exactly `name` in one database.
fn find(db: &TimeZoneDatabase, name: &str) -> Option<Zone> {
    let rules = db.get(name).ok()?;
    // A database answers a name in any letter case, and may answer an older name of a zone with the zone's name of
    // today: when the name that comes back is another one, the name asked for must be one the database lists.
    let exact = match rules.iana_name() {
        Some(found) if found != name => db.available().any(|zone| zone.as_str() == name),
        _ => true,
    };
    exact.then_some(Zone(rules))
}

fn has_folder(db: &TimeZoneDatabase, name: &str) -> bool {
    db.available().any(|zone| zone.as_str().strip_prefix(name).is_some_and(|rest| rest.starts_with('/')))
}

impl Zone {
    /// `ZoneInfo(name)`: the zone of that name, or None when there is none. The name is taken as written: Python
    /// reads a file of that name, and on Linux `europe/paris` is not `Europe/Paris`. As in Python, a name the
    /// system's database does not have is looked for in the carried copy (a system may leave out the older names of
    /// zones, such as `Asia/Saigon`).
    pub fn named(name: &str) -> Option<Zone> {
        find(jiff::tz::db(), name).or_else(|| find(&CARRIED, name))
    }

    /// Whether `name` is a folder of the database (`Europe`), which `ZoneInfo` fails on with an `OSError`.
    pub fn is_folder(name: &str) -> bool {
        !name.is_empty() && (has_folder(jiff::tz::db(), name) || has_folder(&CARRIED, name))
    }

    /// The name of the zone in the database (for an older name of a zone, the database may give today's).
    pub fn name(&self) -> &str {
        self.0.iana_name().unwrap_or("UTC")
    }

    fn at(&self, seconds: i32) -> ZoneOffset {
        ZoneOffset { zone: self.clone(), fixed: fixed(seconds) }
    }
}

impl TimeZone for Zone {
    type Offset = ZoneOffset;

    fn from_offset(offset: &ZoneOffset) -> Zone {
        offset.zone.clone()
    }

    fn offset_from_local_date(&self, local: &NaiveDate) -> LocalResult<ZoneOffset> {
        self.offset_from_local_datetime(&local.and_time(NaiveTime::MIN))
    }

    fn offset_from_local_datetime(&self, local: &NaiveDateTime) -> LocalResult<ZoneOffset> {
        let Some(wall) = civil(local) else { return LocalResult::None };
        match self.0.to_ambiguous_timestamp(wall).offset() {
            AmbiguousOffset::Unambiguous { offset } => LocalResult::Single(self.at(offset.seconds())),
            // a wall time the zone skips
            AmbiguousOffset::Gap { .. } => LocalResult::None,
            // a wall time that comes twice: its first coming (the offset before the change), then its second
            AmbiguousOffset::Fold { before, after } => {
                LocalResult::Ambiguous(self.at(before.seconds()), self.at(after.seconds()))
            }
        }
    }

    fn offset_from_utc_date(&self, utc: &NaiveDate) -> ZoneOffset {
        self.offset_from_utc_datetime(&utc.and_time(NaiveTime::MIN))
    }

    fn offset_from_utc_datetime(&self, utc: &NaiveDateTime) -> ZoneOffset {
        let at = utc.and_utc();
        // (the last day of the year 9999 and the first of the year -9999 are outside what `jiff` counts: the rules
        // of a zone no longer change that far out, so the nearest moment it counts has the same offset)
        let moment = jiff::Timestamp::new(at.timestamp(), at.timestamp_subsec_nanos().min(999_999_999) as i32)
            .unwrap_or(if at.timestamp() > 0 { jiff::Timestamp::MAX } else { jiff::Timestamp::MIN });
        self.at(self.0.to_offset(moment).seconds())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::Utc;

    #[test]
    fn a_zone_is_found_by_its_exact_name() {
        assert!(Zone::named("Europe/Paris").is_some());
        assert!(Zone::named("UTC").is_some());
        assert!(Zone::named("europe/paris").is_none());
        assert!(Zone::named("Asia/Saigon").is_some());
        assert!(Zone::named("asia/saigon").is_none());
        assert!(Zone::named("Mars/Olympus").is_none());
        assert!(Zone::named("Europe").is_none());
        assert!(Zone::is_folder("Europe"));
        assert!(!Zone::is_folder("Europe/Paris"));
        assert!(!Zone::is_folder("Mars"));
    }

    #[test]
    fn offsets_follow_the_clock_changes() {
        let paris = Zone::named("Europe/Paris").expect("zone");
        let winter = Utc.with_ymd_and_hms(2026, 1, 15, 12, 0, 0).unwrap().with_timezone(&paris);
        assert_eq!(winter.offset().fix().local_minus_utc(), 3600);
        let summer = Utc.with_ymd_and_hms(2026, 7, 15, 12, 0, 0).unwrap().with_timezone(&paris);
        assert_eq!(summer.offset().fix().local_minus_utc(), 7200);
        // 02:30 on 2026-03-29 does not exist in Paris; 02:30 on 2026-10-25 comes twice
        let gap = NaiveDate::from_ymd_opt(2026, 3, 29).unwrap().and_hms_opt(2, 30, 0).unwrap();
        assert!(matches!(paris.from_local_datetime(&gap), LocalResult::None));
        let twice = NaiveDate::from_ymd_opt(2026, 10, 25).unwrap().and_hms_opt(2, 30, 0).unwrap();
        match paris.from_local_datetime(&twice) {
            LocalResult::Ambiguous(first, second) => {
                assert_eq!(first.offset().fix().local_minus_utc(), 7200);
                assert_eq!(second.offset().fix().local_minus_utc(), 3600);
                assert!(first < second);
            }
            other => panic!("{other:?}"),
        }
    }
}
