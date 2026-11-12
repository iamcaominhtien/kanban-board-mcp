//! AI runs (v2): one Claude Code session per ticket, led by the team's lead; its roles are subagents
//! (`services/ai/runs.py`; this file ports lines 1-160: the constants, `RunLife`, the errors, the runtime `RT`,
//! `set_board_url`, `defers_to_runner`).
//!
//! The board queues a run, starts the CLI with what `launch` prepares, reads its stream into step rows (`stream`,
//! `steps`), keeps the session for the next turn on the ticket (`--resume`), takes the lead's final report
//! (`--json-schema`) and ends the run. People talk to a running lead through its stdin (`send_message`); a question
//! the lead asks (`ai_run ask`) parks the run in `needs_input` until `answer`.
//!
//! The Python module is one file; here it is this file and, in the order of the Python text: `describe` (161-236),
//! `queue` (237-562: queueing, the scheduler, recovery), `execute` (563-951: driving the CLI), `ending` (952-1386),
//! `actions` (1387-1826: cancel, restart, answer, retry, messages) and `board` (1827-2140: what the board's tools and
//! the ticket flow call). `writer` is `steps.StepWriter` with the rows it holds open to `execute` (see there). Every
//! name of the Python module is `runs::<name>` here too.

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, LazyLock, Mutex, MutexGuard};
use std::time::Instant;

use kb_ai::runner_link;
use kb_db::sea_orm::DbErr;
use serde_json::{Map, Value};
use tokio::sync::{Notify, watch};
use tokio::task::JoinHandle;

use crate::cli::CliProcess;
use crate::stream::Parsed;

mod actions;
mod board;
mod describe;
mod ending;
mod execute;
mod queue;
mod writer;

pub use actions::*;
pub use board::*;
pub use describe::*;
pub use ending::*;
pub(crate) use execute::{ctx_for, spawn_execute};
pub use queue::*;
pub use writer::StepWriter;

/// The states of a run that is over.
pub const ENDED: [&str; 3] = ["finished", "failed", "cancelled"];
/// How many AI-to-AI hand-offs may lie behind a run: a note an AI sends (ai_run message, the Board AI routing Docs
/// threads, a ticket's team writing to a page) starts a run one deeper; at this depth the send is refused, so two AIs
/// (or a ticket and a page) cannot keep each other busy.
pub const MAX_DEPTH: i64 = 3;
/// The states of a run that is not over.
pub const ACTIVE: [&str; 4] = ["queued", "starting", "running", "needs_input"];
/// The stop code of a run ended because the board closed under it.
pub const BOARD_CLOSED: &str = kb_ai::seams::BOARD_CLOSED;

static STARTING_TIMEOUT_MS: AtomicU64 = AtomicU64::new(180_000);
static WATCH_EVERY_MS: AtomicU64 = AtomicU64::new(5_000);
static RESULT_GRACE_MS: AtomicU64 = AtomicU64::new(20_000);

/// `STARTING_TIMEOUT_S`: how long a CLI may take to say it is ready (180 s).
pub fn starting_timeout_s() -> f64 {
    STARTING_TIMEOUT_MS.load(Ordering::SeqCst) as f64 / 1000.0
}

/// `WATCH_EVERY_S`: how often a quiet CLI is looked at (5 s).
pub fn watch_every_s() -> f64 {
    WATCH_EVERY_MS.load(Ordering::SeqCst) as f64 / 1000.0
}

/// `RESULT_GRACE_S`: how long a CLI that answered may stay open with nothing left to wait for (20 s).
// A role the lead called runs in the background: the lead's turn can end while it still works, and the CLI then
// finishes the role, wakes the lead for another turn and exits by itself once its input is closed (measured). The
// board only watches: it closes the input at the lead's first real result and never stops a CLI that still has a role
// working; a person's Stop is the only thing that does.
pub fn result_grace_s() -> f64 {
    RESULT_GRACE_MS.load(Ordering::SeqCst) as f64 / 1000.0
}

/// Change `STARTING_TIMEOUT_S`, `WATCH_EVERY_S` and `RESULT_GRACE_S` (tests shorten them; `None` keeps a value).
pub fn set_timing(starting_timeout_s: Option<f64>, watch_every_s: Option<f64>, result_grace_s: Option<f64>) {
    let ms = |seconds: f64| (seconds.max(0.0) * 1000.0) as u64;
    if let Some(s) = starting_timeout_s {
        STARTING_TIMEOUT_MS.store(ms(s), Ordering::SeqCst);
    }
    if let Some(s) = watch_every_s {
        WATCH_EVERY_MS.store(ms(s), Ordering::SeqCst);
    }
    if let Some(s) = result_grace_s {
        RESULT_GRACE_MS.store(ms(s), Ordering::SeqCst);
    }
}

static START: LazyLock<Instant> = LazyLock::new(Instant::now);

/// `time.monotonic()`.
pub(crate) fn monotonic() -> f64 {
    START.elapsed().as_secs_f64()
}

/// When a live run's CLI may be closed and when it must be stopped, from what its own stream says.
///
/// A CLI session has many turns; each ends with a `result` (a turn with no content, `turns` 0, is the CLI handling a
/// notification left by an earlier run: not an answer). At the lead's first real result the input is closed and the CLI
/// is left to finish: it ends the roles that still work, wakes the lead for another turn and exits by itself. It is
/// stopped only when it lingers with nothing left to wait for (a dev server the lead started).
#[derive(Debug, Default, Clone)]
pub struct RunLife {
    /// roles (local_agent tasks) started and not ended
    pub open_agents: HashSet<String>,
    /// When the lead last answered (`monotonic` seconds), None while it works.
    pub answered_at: Option<f64>,
}

impl RunLife {
    /// Nothing has been answered and no role works.
    pub fn new() -> Self {
        Self::default()
    }

    /// Take one parsed line; True when it is the lead's real answer (the caller closes the input).
    pub fn feed(&mut self, parsed: &Parsed, now: f64) -> bool {
        if parsed.ready {
            // a new turn begins (a role reported, or a message came): the lead works again
            self.answered_at = None;
        }
        for task in &parsed.tasks {
            let text = |key: &str| task.get(key).and_then(Value::as_str).unwrap_or("");
            let id = task.get("id").map(kb_base::pyjson::py_str).unwrap_or_default();
            if text("event") == "started" && text("type") == "local_agent" {
                self.open_agents.insert(id);
            } else if text("event") == "ended" && self.open_agents.contains(&id) {
                self.open_agents.remove(&id);
                if self.open_agents.is_empty() && self.answered_at.is_some() {
                    // the last role reported: the CLI has the grace to wake the lead
                    self.answered_at = Some(now);
                }
            }
        }
        if parsed.result.as_ref().is_some_and(kb_base::pyjson::truthy) {
            self.answered_at = Some(now);
            return true;
        }
        false
    }

    /// How long to wait for the next line before looking at the clock again.
    pub fn wait_s(&self, now: f64, default: f64) -> f64 {
        let Some(answered_at) = self.answered_at else { return default };
        let since = now - answered_at;
        if since < result_grace_s() {
            return (result_grace_s() - since).max(0.5);
        }
        watch_every_s()
    }

    /// The CLI answered and stays open: stop it unless a role still works. A question to a person does not change
    /// that: the roles finish, then the run waits for the answer.
    pub fn must_stop(&self, now: f64) -> bool {
        match self.answered_at {
            Some(answered_at) if now - answered_at >= result_grace_s() => self.open_agents.is_empty(),
            _ => false,
        }
    }
}

/// What a function of this module fails with.
#[derive(Debug, thiserror::Error)]
pub enum RunError {
    /// `RunError` (a `ValueError`): a run could not be started or changed; the message is for the person.
    #[error("{0}")]
    Run(String),
    /// `RunConflict` (a `RunError`): the ticket already has an active run.
    #[error("{0}")]
    Conflict(String),
    /// A plain `ValueError` (`record_question`, `record_report`, a ticket that refuses a comment).
    #[error("{0}")]
    Value(String),
    /// The database call failed.
    #[error(transparent)]
    Db(#[from] DbErr),
    /// Any other exception.
    #[error("{0}")]
    Other(String),
}

impl RunError {
    /// Whether Python's `except RunError` catches it (`RunConflict` is one).
    pub fn is_run_error(&self) -> bool {
        matches!(self, RunError::Run(_) | RunError::Conflict(_))
    }

    /// Whether Python's `except ValueError` catches it (`RunError` is one).
    pub fn is_value_error(&self) -> bool {
        matches!(self, RunError::Run(_) | RunError::Conflict(_) | RunError::Value(_))
    }
}

impl From<kb_board::tickets::Error> for RunError {
    fn from(err: kb_board::tickets::Error) -> Self {
        match err {
            kb_board::tickets::Error::Value(message) => RunError::Value(message),
            kb_board::tickets::Error::Db(err) => RunError::Db(err),
            other => RunError::Other(other.to_string()),
        }
    }
}

pub(crate) fn refuse<T>(message: impl Into<String>) -> Result<T, RunError> {
    Err(RunError::Run(message.into()))
}

/// `asyncio.Event`: `set`, `clear`, `wait`.
#[derive(Default)]
pub struct Event {
    flag: AtomicBool,
    notify: Notify,
}

impl Event {
    /// Set the flag: everyone who waits goes on.
    pub fn set(&self) {
        self.flag.store(true, Ordering::SeqCst);
        self.notify.notify_waiters();
    }

    /// Clear the flag.
    pub fn clear(&self) {
        self.flag.store(false, Ordering::SeqCst);
    }

    /// Whether the flag is set.
    pub fn is_set(&self) -> bool {
        self.flag.load(Ordering::SeqCst)
    }

    /// Wait until the flag is set.
    pub async fn wait(&self) {
        loop {
            let waiting = self.notify.notified();
            tokio::pin!(waiting);
            waiting.as_mut().enable();
            if self.is_set() {
                return;
            }
            waiting.await;
        }
    }
}

/// The task of a run (`RT.tasks[run_id]`): `generation` tells it from an earlier task of the same run, `done` turns
/// true when it is over (`task.done()`).
pub(crate) struct RunTask {
    pub(crate) generation: u64,
    pub(crate) abort: tokio::task::AbortHandle,
    pub(crate) done: watch::Receiver<bool>,
}

#[derive(Default)]
pub(crate) struct Inner {
    pub(crate) tasks: HashMap<String, RunTask>,
    pub(crate) procs: HashMap<String, (u64, Arc<CliProcess>)>,
    pub(crate) writers: HashMap<String, StepWriter>,
    pub(crate) cancelled: HashSet<String>,
    pub(crate) waiting: HashMap<String, String>,
    /// a CLI that was stopped on purpose (the memory limit, or a person's Restart): who asked and the numbers
    pub(crate) restart_requests: HashMap<String, Map<String, Value>>,
    pub(crate) board_url: Option<String>,
    pub(crate) scheduler: Option<JoinHandle<()>>,
    /// When the teams were last checked (`last_health`); None: never (Python starts at 0.0).
    pub(crate) last_health: Option<Instant>,
}

/// The runtime of the runs of this process (`_Runtime`).
#[derive(Default)]
pub struct Runtime {
    /// Set to make the scheduler look at the queue now.
    pub wake: Event,
    inner: Mutex<Inner>,
    /// the API brought the database up to date (the runner may start)
    db_ready: AtomicBool,
    generation: AtomicU64,
}

/// The runtime of this process (`RT`).
pub static RT: LazyLock<Runtime> = LazyLock::new(Runtime::default);

impl Runtime {
    pub(crate) fn inner(&self) -> MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub(crate) fn next_generation(&self) -> u64 {
        self.generation.fetch_add(1, Ordering::SeqCst) + 1
    }

    /// `RT.procs.get(run_id)`: the CLI of a run this process runs.
    pub fn proc(&self, run_id: &str) -> Option<Arc<CliProcess>> {
        self.inner().procs.get(run_id).map(|(_, proc)| proc.clone())
    }

    /// `run_id in RT.procs`.
    pub fn has_proc(&self, run_id: &str) -> bool {
        self.inner().procs.contains_key(run_id)
    }

    /// `run_id in RT.tasks`: the run's own task is starting or finishing it right now.
    pub fn has_task(&self, run_id: &str) -> bool {
        self.inner().tasks.contains_key(run_id)
    }

    /// `run_id in RT.cancelled`.
    pub fn is_cancelled(&self, run_id: &str) -> bool {
        self.inner().cancelled.contains(run_id)
    }

    /// `RT.waiting.get(run_id)`: why a queued run waits, as the last tick saw it.
    pub fn waiting(&self, run_id: &str) -> Option<String> {
        self.inner().waiting.get(run_id).cloned()
    }

    /// `RT.board_url`.
    pub fn board_url(&self) -> Option<String> {
        self.inner().board_url.clone()
    }

    /// `RT.db_ready`.
    pub fn db_ready(&self) -> bool {
        self.db_ready.load(Ordering::SeqCst)
    }

    pub(crate) fn set_db_ready(&self, ready: bool) {
        self.db_ready.store(ready, Ordering::SeqCst);
    }

    /// Whether the scheduler loop runs (`RT.scheduler is not None and not RT.scheduler.done()`).
    pub fn scheduler_running(&self) -> bool {
        self.inner().scheduler.as_ref().is_some_and(|t| !t.is_finished())
    }

    /// What a crash of the board leaves behind (tests of the recovery): every task is gone and everything is
    /// forgotten, but no CLI is stopped (a process object that is let go stops its CLI, so they are kept forever).
    pub fn abandon(&self) {
        let mut inner = self.inner();
        if let Some(scheduler) = inner.scheduler.take() {
            scheduler.abort();
        }
        for task in inner.tasks.values() {
            task.abort.abort();
        }
        for (_, (_, proc)) in inner.procs.drain() {
            std::mem::forget(proc);
        }
        *inner = Inner::default();
        drop(inner);
        self.wake.clear();
        self.set_db_ready(false);
    }

    /// A new runtime in place of this one (`monkeypatch.setattr(runs, "RT", runs._Runtime())` of the Python tests):
    /// every task is stopped and everything is forgotten. The CLIs are stopped with their process objects.
    pub fn reset(&self) {
        let mut inner = self.inner();
        if let Some(scheduler) = inner.scheduler.take() {
            scheduler.abort();
        }
        for task in inner.tasks.values() {
            task.abort.abort();
        }
        for (_, proc) in inner.procs.values() {
            proc.kill();
        }
        *inner = Inner::default();
        drop(inner);
        self.wake.clear();
        self.set_db_ready(false);
    }
}

/// One writer of steps at a time for each run.
///
/// `steps.append` reads the run's step count and the next step number, then writes both back with the new rows. In
/// Python every task of the board shares one thread and such a write is in practice never cut in two by another; here
/// the run's own task, a person's message and a cancel run on different threads at once, and two of them in the
/// middle of `append` would give two steps the same number and lose one from the count. So every step `runs` writes
/// for a run goes through this lock. (The hook route writes through `kb_ai::steps::append` itself, outside it.)
static APPENDS: LazyLock<Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>> = LazyLock::new(Mutex::default);

fn append_lock(run_id: &str) -> Arc<tokio::sync::Mutex<()>> {
    APPENDS.lock().unwrap_or_else(|e| e.into_inner()).entry(run_id.to_string()).or_default().clone()
}

/// The run is over: nothing more is written for it.
pub(crate) fn forget_append_lock(run_id: &str) {
    APPENDS.lock().unwrap_or_else(|e| e.into_inner()).remove(run_id);
}

/// `steps.append(run_id, rows, ...)` for a run of this module (one at a time for each run).
pub(crate) async fn append_steps(
    run_id: &str,
    rows: Vec<Value>,
    extras: kb_ai::steps::Extras,
) -> Result<Vec<kb_db::entities::ai_run_step::Model>, DbErr> {
    let lock = append_lock(run_id);
    let _one = lock.lock().await;
    kb_ai::steps::append(run_id, rows, extras).await
}

/// `steps.close_roles(run_id)` for a run of this module (one writer at a time for each run).
pub(crate) async fn close_roles(run_id: &str) -> Result<(), DbErr> {
    let lock = append_lock(run_id);
    let _one = lock.lock().await;
    kb_ai::steps::close_roles(run_id).await
}

/// What a test adds to the environment of every CLI a run starts (the Python tests call `monkeypatch.setenv` with
/// `FAKE_CLAUDE_*` before a run; the environment of this process is never changed after it started).
static CLI_ENV: Mutex<Vec<(String, String)>> = Mutex::new(Vec::new());

/// Set the variables added to the environment of every CLI a run starts (tests); an empty list adds none.
pub fn set_cli_env(extra: Vec<(String, String)>) {
    *CLI_ENV.lock().unwrap_or_else(|e| e.into_inner()) = extra;
}

pub(crate) fn cli_env() -> Vec<(String, String)> {
    CLI_ENV.lock().unwrap_or_else(|e| e.into_inner()).clone()
}

/// Where the CLI reaches the board (its MCP endpoint and the hook endpoint). In process mode the API also starts the
/// runner once it knows the URL.
pub fn set_board_url(url: &str) {
    RT.inner().board_url = Some(url.to_string());
    // the runner opens the database too: it starts once the API has brought it up to date (start_scheduler)
    if RT.db_ready() && !runner_link::in_runner() {
        runner_link::ensure_started(Some(url));
    }
}

/// True in the API process when a runner process owns the CLIs.
pub fn defers_to_runner() -> bool {
    runner_link::mode() == "process" && !runner_link::in_runner()
}

/// `_url()`: where the board listens.
pub fn url() -> String {
    RT.board_url().filter(|u| !u.is_empty()).unwrap_or_else(|| "http://127.0.0.1:8000".to_string())
}

/// `value[:n]` of a text, counted in characters.
pub(crate) fn clip(text: &str, n: usize) -> String {
    text.chars().take(n).collect()
}

/// `f"{n:,}"`.
pub(crate) fn thousands(n: i64) -> String {
    let digits = n.unsigned_abs().to_string();
    let mut out = String::new();
    for (i, c) in digits.chars().enumerate() {
        if i > 0 && (digits.len() - i).is_multiple_of(3) {
            out.push(',');
        }
        out.push(c);
    }
    if n < 0 { format!("-{out}") } else { out }
}

/// `"\n\n".join(t for t in (a, b) if t)`.
pub(crate) fn join_notes(a: &str, b: &str) -> String {
    [a, b].into_iter().filter(|t| !t.is_empty()).collect::<Vec<_>>().join("\n\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn numbers_read_as_python_writes_them() {
        assert_eq!(thousands(0), "0");
        assert_eq!(thousands(999), "999");
        assert_eq!(thousands(1000), "1,000");
        assert_eq!(thousands(1234567), "1,234,567");
        assert_eq!(join_notes("", "b"), "b");
        assert_eq!(join_notes("a", "b"), "a\n\nb");
    }

    #[tokio::test]
    async fn an_event_wakes_who_waits_and_stays_set() {
        let event = Arc::new(Event::default());
        let waiter = {
            let event = event.clone();
            tokio::spawn(async move { event.wait().await })
        };
        tokio::task::yield_now().await;
        event.set();
        waiter.await.expect("the waiter ends");
        event.wait().await;
        event.clear();
        assert!(!event.is_set());
    }

    #[test]
    fn a_run_is_closed_at_the_leads_answer_and_stopped_only_when_no_role_works() {
        let mut life = RunLife::new();
        let task = |event: &str| Parsed {
            tasks: vec![serde_json::json!({"id": "a1", "type": "local_agent", "event": event})],
            ..Parsed::default()
        };
        assert!(!life.feed(&task("started"), 1.0));
        let answer = Parsed { result: Some(serde_json::json!({"text": "done"})), ..Parsed::default() };
        assert!(life.feed(&answer, 2.0));
        // a role still works: never stopped
        assert!(!life.must_stop(2.0 + result_grace_s() + 1.0));
        assert!(!life.feed(&task("ended"), 30.0));
        assert_eq!(life.answered_at, Some(30.0));
        assert!(!life.must_stop(31.0));
        assert!(life.must_stop(30.0 + result_grace_s()));
        assert_eq!(life.wait_s(31.0, 99.0), result_grace_s() - 1.0);
        assert_eq!(life.wait_s(30.0 + result_grace_s() + 1.0, 99.0), watch_every_s());
        let ready = Parsed { ready: true, ..Parsed::default() };
        life.feed(&ready, 60.0);
        assert_eq!(life.wait_s(61.0, 99.0), 99.0);
    }
}
