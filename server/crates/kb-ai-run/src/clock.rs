//! The clock of `schedules`, `touches` and `health`: `datetime.now(UTC)` of those Python modules. A test stops it at
//! one moment (the Python generators of the golden vectors replace the modules' `datetime` the same way), so what
//! depends on the time of day can be compared. The stamps a row is written with (`now_iso()`) are always the real
//! time.

use std::sync::RwLock;

use chrono::{DateTime, Utc};

static FROZEN: RwLock<Option<DateTime<Utc>>> = RwLock::new(None);

/// `datetime.now(UTC)`.
pub fn now() -> DateTime<Utc> {
    FROZEN.read().unwrap_or_else(|e| e.into_inner()).unwrap_or_else(Utc::now)
}

/// Stop the clock at `at` for the whole process (None lets it run again). For tests.
pub fn set_now(at: Option<DateTime<Utc>>) {
    *FROZEN.write().unwrap_or_else(|e| e.into_inner()) = at;
}
