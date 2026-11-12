//! AI schedules (design/screens/ai-schedules.md, issue #153): an AI team works on a ticket at a set time, once or
//! on repeat (`services/ai/schedules.py`). At the time the board checks that the team can start (paused, budget,
//! desktop app), then starts a normal run tagged `schedule`. The run's lead decides what is done and reports (the
//! final JSON report); the board only follows the run: it stops one that goes over its time limit, starts a crashed
//! one again within the retries, closes the slot with what the lead reported, and pauses a schedule that failed three
//! times in a row. Defaults fail safe: when unsure, skip and tell a person (G).
//!
//! Each planned start is one `AiScheduleRun` row with a unique (schedule, slot) key, so a restart never runs a slot
//! twice. The loop polls run states instead of hooking into the run engine, which keeps both restart-safe.
//!
//! The Python module is one file; here it is this file (lines 1 to 90: the constants, `role_of`, `ScheduleError`, the
//! runtime `RT`) and, in the order of the Python text: `when` (93 to 222: time zones, slots and labels), `read` (225
//! to 365: a schedule for the UI), `check` (368 to 735: validation and preview), `edit` (738 to 898: create, change,
//! pause, run now), `list` (901 to 1110: listing, history, the week), `notify` (1113 to 1200: notifications and
//! activity) and `ticking` (1203 to 1861: the loop, starting, following and closing a slot, the dry run, the card
//! states). Every name of the Python module is `schedules::<name>` here too.
//!
//! A schedule in memory is its row (`ai_schedule::Model`): where Python changes attributes of the object and saves
//! it, the functions here change the model and write every column. A schedule's data arrives as the dict the router
//! makes of its body (`body.model_dump(exclude_unset=True)`) or the `fields` of the `ai_schedules` tool: a
//! `serde_json::Map` with only the keys that were sent.

use std::collections::{HashSet, VecDeque};
use std::sync::atomic::{AtomicI64, AtomicU64, Ordering};
use std::sync::{LazyLock, Mutex};

use kb_db::Session;
use kb_db::entities::member;
use kb_db::sea_orm::{ColumnTrait, DbErr, EntityTrait, QueryFilter};
use serde_json::{Map, Value, json};
use tokio::task::JoinHandle;

mod check;
mod edit;
mod list;
mod notify;
mod read;
mod ticking;
mod when;

pub use check::*;
pub use edit::*;
pub use list::*;
pub use notify::*;
pub use read::*;
pub use ticking::*;
pub use when::*;

/// The weekdays as the labels name them, Monday first.
pub const DAY_NAMES: [&str; 7] = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
/// The events a schedule can tell people about.
pub const NOTIFY_EVENTS: [&str; 4] = ["started", "needs_input", "failed", "finished"];
/// The states of a slot that is not over.
pub const OPEN: [&str; 3] = ["waiting", "ask", "running"];
/// The states of a slot that is over.
pub const ENDED: [&str; 5] = ["passed", "partly", "failed", "skipped", "cancelled"];
/// a start this late counts as catch-up
pub const LATE_AFTER_S: f64 = 300.0;
/// slot busy: the run queues, but not longer than this
pub const BUSY_MAX_WAIT_MIN: i64 = 30;
/// failed runs in a row
pub const AUTO_PAUSE_AFTER: i32 = 3;
/// How often the loop looks at the schedules, in seconds (`TICK_S`).
pub const TICK_S: f64 = 20.0;

static TICK_MS: AtomicU64 = AtomicU64::new(20_000);

/// `TICK_S` as the loop reads it.
pub fn tick_s() -> f64 {
    TICK_MS.load(Ordering::SeqCst) as f64 / 1000.0
}

/// Change how often the loop looks (the Python tests would patch `TICK_S`).
pub fn set_tick_s(seconds: f64) {
    TICK_MS.store((seconds * 1000.0) as u64, Ordering::SeqCst);
}

/// `DEFAULT_LIMITS`: the run limits of a schedule that sets none.
pub fn default_limits() -> Map<String, Value> {
    let mut out = Map::new();
    out.insert("stop_after_min".into(), json!(45));
    out.insert("retries".into(), json!(1));
    out.insert("max_cost".into(), Value::Null);
    out
}

/// viewer | member | admin; the board's own user acts as an admin.
pub async fn role_of(session: &Session, project_id: &str, person: &str) -> Result<String, DbErr> {
    if person.is_empty() || person == "user" {
        return Ok("admin".to_string());
    }
    let row = member::Entity::find()
        .filter(member::Column::ProjectId.eq(project_id))
        .filter(member::Column::Name.eq(person))
        .filter(member::Column::Kind.eq("human"))
        .one(session)
        .await?;
    Ok(row.map_or_else(|| "member".to_string(), |r| r.role))
}

/// `ScheduleError` (a `ValueError`): a schedule cannot be saved or changed; `code` maps to an HTTP status
/// (`not_found`, `invalid`, `forbidden`, `conflict`, `unavailable`), `extra` goes into the error body.
#[derive(Debug, Clone, PartialEq)]
pub struct ScheduleError {
    /// Why, as the API's status table knows it.
    pub code: String,
    /// The words for the person.
    pub message: String,
    /// More fields of the error body (`problems`).
    pub extra: Map<String, Value>,
}

impl ScheduleError {
    /// `ScheduleError(code, message)`.
    pub fn new(code: &str, message: impl Into<String>) -> Self {
        ScheduleError { code: code.to_string(), message: message.into(), extra: Map::new() }
    }
}

impl std::fmt::Display for ScheduleError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for ScheduleError {}

/// What a function of this module fails with.
#[derive(Debug, thiserror::Error)]
pub enum Error {
    /// `ScheduleError`: the router answers it with the status of its code.
    #[error("{0}")]
    Schedule(#[from] ScheduleError),
    /// The database call failed.
    #[error(transparent)]
    Db(#[from] DbErr),
    /// Anything Python lets through as a 500 (a value of the wrong kind in a stored column, an exception of the runs
    /// that is no `RunError`).
    #[error("{0}")]
    Other(String),
}

impl Error {
    /// The `ScheduleError`, when it is one.
    pub fn schedule(&self) -> Option<&ScheduleError> {
        match self {
            Error::Schedule(err) => Some(err),
            _ => None,
        }
    }
}

/// `raise ScheduleError(code, message)`.
pub(crate) fn refuse<T>(code: &str, message: impl Into<String>) -> Result<T, Error> {
    Err(Error::Schedule(ScheduleError::new(code, message)))
}

pub(crate) struct Inner {
    pub(crate) task: Option<JoinHandle<()>>,
    /// runs whose "needs input" was already told
    pub(crate) asked: HashSet<String>,
    pub(crate) events: VecDeque<Map<String, Value>>,
}

/// State of the scheduler in this process (`_Runtime`).
pub struct Runtime {
    /// One tick at a time (`RT.lock`).
    pub(crate) lock: tokio::sync::Mutex<()>,
    pub(crate) inner: Mutex<Inner>,
    /// Starts at the clock, so ids keep growing across restarts (clients keep the last id)
    seq: AtomicI64,
}

/// The most events the feed keeps (`deque(maxlen=200)`).
pub(crate) const EVENTS_KEPT: usize = 200;

impl Default for Runtime {
    fn default() -> Self {
        Runtime {
            lock: tokio::sync::Mutex::new(()),
            inner: Mutex::new(Inner { task: None, asked: HashSet::new(), events: VecDeque::new() }),
            seq: AtomicI64::new((kb_base::time::epoch() * 1000.0) as i64),
        }
    }
}

impl Runtime {
    pub(crate) fn inner(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// `next(RT.seq)`.
    pub(crate) fn next_seq(&self) -> i64 {
        self.seq.fetch_add(1, Ordering::SeqCst)
    }

    /// Whether the loop runs (`RT.task` is there and not done).
    pub fn running(&self) -> bool {
        self.inner().task.as_ref().is_some_and(|t| !t.is_finished())
    }

    /// A new runtime for a test: no loop, nothing told, an empty feed (Python's tests make a new `_Runtime()`).
    pub fn reset(&self) {
        let mut inner = self.inner();
        if let Some(task) = inner.task.take() {
            task.abort();
        }
        inner.asked.clear();
        inner.events.clear();
    }
}

/// The runtime of this process (`RT`).
pub static RT: LazyLock<Runtime> = LazyLock::new(Runtime::default);
