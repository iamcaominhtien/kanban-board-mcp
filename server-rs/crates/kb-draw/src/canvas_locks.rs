//! `services/canvas_locks.py`: locks on canvas boards: one per board, held only while its content is open for
//! changing.
//!
//! Moving, resizing, notes, arrows and comments need no lock. A lock ends when its holder saves or cancels, closes the
//! editor, or has been idle for 10 minutes (the editor warns first). Locks live in memory with a time limit: they are
//! not versions and a restart simply frees them. An AI team never takes a lock from a person: a board a person is
//! editing is refused to it.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, MutexGuard, OnceLock};
use std::time::Instant;

use kb_base::time;
use serde_json::{Map, Value, json};

/// Seconds without a heartbeat after which a lock is gone.
pub const IDLE_SECONDS: i64 = 10 * 60;
/// The editor tells the holder from here on.
pub const WARN_SECONDS: i64 = 9 * 60;

/// Who holds a board and since when.
#[derive(Debug, Clone)]
pub struct Lock {
    /// Name of the holder.
    pub holder: String,
    /// `time.monotonic()` when it was taken.
    pub since: f64,
    /// `time.monotonic()` of the last sign of life.
    pub last: f64,
    /// When it was taken, as an ISO time.
    pub since_iso: String,
}

type Key = (String, String);

/// `_LOCKS`: a dict, so in the order the locks were taken.
fn locks() -> MutexGuard<'static, Vec<(Key, Lock)>> {
    static LOCKS: OnceLock<Mutex<Vec<(Key, Lock)>>> = OnceLock::new();
    LOCKS.get_or_init(|| Mutex::new(Vec::new())).lock().unwrap_or_else(|e| e.into_inner())
}

/// Milliseconds the test clock has been moved forward by.
static SKEW_MS: AtomicU64 = AtomicU64::new(0);

/// `_clock()`: `time.monotonic()`.
fn clock() -> f64 {
    static START: OnceLock<Instant> = OnceLock::new();
    let start = START.get_or_init(Instant::now);
    1000.0 + start.elapsed().as_secs_f64() + SKEW_MS.load(Ordering::Relaxed) as f64 / 1000.0
}

/// Move the clock forward (tests: `monkeypatch.setattr(canvas_locks, "_clock", ...)`).
pub fn advance_clock(seconds: f64) {
    SKEW_MS.fetch_add((seconds * 1000.0) as u64, Ordering::Relaxed);
}

fn position(list: &[(Key, Lock)], key: &Key) -> Option<usize> {
    list.iter().position(|(k, _)| k == key)
}

/// `_live(key)`: the lock, after an idle one is released.
fn live(list: &mut Vec<(Key, Lock)>, key: &Key) -> Option<Lock> {
    let at = position(list, key)?;
    if clock() - list[at].1.last > IDLE_SECONDS as f64 {
        list.remove(at);
        return None;
    }
    Some(list[at].1.clone())
}

fn key(canvas_id: &str, board_id: &str) -> Key {
    (canvas_id.to_string(), board_id.to_string())
}

/// The live lock on a board, if any (an idle one is released first).
pub fn holder_of(canvas_id: &str, board_id: &str) -> Option<Lock> {
    live(&mut locks(), &key(canvas_id, board_id))
}

fn describe_in(list: &mut Vec<(Key, Lock)>, canvas_id: &str, board_id: &str) -> Option<Map<String, Value>> {
    let lock = live(list, &key(canvas_id, board_id))?;
    let now = clock();
    let idle = now - lock.last;
    let mut out = Map::new();
    out.insert("board_id".into(), json!(board_id));
    out.insert("holder".into(), json!(lock.holder));
    out.insert("since".into(), json!(lock.since_iso));
    out.insert("started_seconds_ago".into(), json!((now - lock.since) as i64));
    out.insert("idle_seconds".into(), json!(idle as i64));
    out.insert("expires_in".into(), json!(0.max((IDLE_SECONDS as f64 - idle) as i64)));
    out.insert("warn".into(), json!(idle >= WARN_SECONDS as f64));
    Some(out)
}

/// `{board_id, holder, since, started_seconds_ago, idle_seconds, expires_in, warn}` for the API, or None when the
/// board is free.
pub fn describe(canvas_id: &str, board_id: &str) -> Option<Map<String, Value>> {
    describe_in(&mut locks(), canvas_id, board_id)
}

/// Every live lock of one canvas.
pub fn locks_of(canvas_id: &str) -> Vec<Map<String, Value>> {
    let mut list = locks();
    let keys: Vec<Key> = list.iter().map(|(k, _)| k.clone()).collect();
    keys.iter().filter(|(cid, _)| cid == canvas_id).filter_map(|(cid, bid)| describe_in(&mut list, cid, bid)).collect()
}

/// Take the lock if it is free or already yours (refreshing it). `(taken, lock)`; when not taken, `lock` is the one
/// somebody else holds.
pub fn acquire(canvas_id: &str, board_id: &str, holder: &str) -> (bool, Lock) {
    let mut list = locks();
    let k = key(canvas_id, board_id);
    let lock = live(&mut list, &k);
    if let Some(lock) = &lock {
        if lock.holder != holder {
            return (false, lock.clone());
        }
    }
    let now = clock();
    match lock {
        None => {
            let lock = Lock { holder: holder.to_string(), since: now, last: now, since_iso: time::now_iso() };
            list.push((k, lock.clone()));
            (true, lock)
        }
        Some(_) => {
            let at = position(&list, &k).unwrap_or(0);
            list[at].1.last = now;
            (true, list[at].1.clone())
        }
    }
}

/// Show the holder is still there. False if the lock was lost (it ended, or somebody else holds it now).
pub fn heartbeat(canvas_id: &str, board_id: &str, holder: &str) -> bool {
    let mut list = locks();
    let k = key(canvas_id, board_id);
    match live(&mut list, &k) {
        Some(lock) if lock.holder == holder => {
            let at = position(&list, &k).unwrap_or(0);
            list[at].1.last = clock();
            true
        }
        _ => false,
    }
}

/// Let go. With `holder` only that person's lock is released. True if a lock was removed.
pub fn release(canvas_id: &str, board_id: &str, holder: Option<&str>) -> bool {
    let mut list = locks();
    let k = key(canvas_id, board_id);
    match position(&list, &k) {
        Some(at) if holder.is_none_or(|h| list[at].1.holder == h) => {
            list.remove(at);
            true
        }
        _ => false,
    }
}

/// Free every lock of a canvas (or of the given boards): a deleted canvas or board, a restored version.
pub fn release_all(canvas_id: &str, board_ids: Option<&[String]>) {
    locks().retain(|((cid, bid), _)| !(cid == canvas_id && board_ids.is_none_or(|ids| ids.contains(bid))));
}

/// Forget every lock (tests).
pub fn reset() {
    locks().clear();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_lock_warns_at_nine_minutes_and_ends_after_ten_idle() {
        let (c, b) = ("cv_lockunit", "b_00000001");
        reset();
        assert!(acquire(c, b, "user").0);
        let (taken, other) = acquire(c, b, "An");
        assert!(!taken && other.holder == "user");
        advance_clock(9.0 * 60.0 + 1.0);
        let state = describe(c, b).expect("held");
        assert_eq!(state["warn"], json!(true));
        assert!(state["expires_in"].as_i64().is_some_and(|n| n <= 59));
        assert!(heartbeat(c, b, "user"));
        advance_clock(10.0 * 60.0 + 1.0);
        assert!(describe(c, b).is_none());
        assert!(!heartbeat(c, b, "user"));
        release_all(c, None);
    }
}
