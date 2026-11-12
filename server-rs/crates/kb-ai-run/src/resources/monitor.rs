//! The monitor: the loop that reads the tracked CLIs, their history and peaks, the project limits, and who is told
//! (`Monitor`, the `MON` of the process, its watchers).

use std::collections::{HashMap, HashSet, VecDeque};
use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, LazyLock, Mutex};
use std::time::{Duration, Instant};

use kb_ai::store::{get_settings, save};
use kb_base::{events, time};
use kb_db::database;
use kb_db::entities::ai_run;
use kb_db::sea_orm::{DbErr, EntityTrait};
use serde_json::{Value, json};

use super::{HISTORY_EVERY_S, HISTORY_POINTS, LIMIT_TTL_S, Reading, SAMPLE_S, SAVE_EVERY_S, read_run, snapshot};
use crate::cli::CliProcess;

/// What the run engine is told when a CLI (or what it started) passes the limit: (run id, MB held, the limit).
pub type Breach = Arc<dyn Fn(String, f64, i64) -> Pin<Box<dyn Future<Output = ()> + Send>> + Send + Sync>;

/// A queue that receives a project's snapshot every reading and keeps only the newest
/// (`asyncio.Queue(maxsize=1)`).
#[derive(Default)]
pub struct Watcher {
    slot: Mutex<Option<Value>>,
    news: tokio::sync::Notify,
}

impl Watcher {
    fn put(&self, snap: Value) {
        *self.slot.lock().unwrap_or_else(|e| e.into_inner()) = Some(snap);
        self.news.notify_one();
    }

    /// The newest snapshot not taken yet, if any (`queue.get_nowait()`).
    pub fn get_nowait(&self) -> Option<Value> {
        self.slot.lock().unwrap_or_else(|e| e.into_inner()).take()
    }

    /// The next snapshot (`await queue.get()`).
    pub async fn get(&self) -> Value {
        loop {
            if let Some(snap) = self.get_nowait() {
                return snap;
            }
            self.news.notified().await;
        }
    }
}

/// The waits of the monitor, in seconds (the constants of the module; tests shorten them).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Timing {
    /// `SAMPLE_S`.
    pub sample_s: f64,
    /// `HISTORY_EVERY_S`.
    pub history_every_s: f64,
    /// `SAVE_EVERY_S`.
    pub save_every_s: f64,
    /// `LIMIT_TTL_S`.
    pub limit_ttl_s: f64,
}

impl Default for Timing {
    fn default() -> Self {
        Self {
            sample_s: SAMPLE_S,
            history_every_s: HISTORY_EVERY_S,
            save_every_s: SAVE_EVERY_S,
            limit_ttl_s: LIMIT_TTL_S,
        }
    }
}

#[derive(Default)]
struct Inner {
    /// run id -> (CliProcess, project id), in the order the runs were first tracked
    tracked: Vec<(String, Arc<CliProcess>, String)>,
    readings: HashMap<String, Reading>,
    history: HashMap<String, VecDeque<Value>>,
    peak: HashMap<String, f64>,
    subscribers: Vec<(String, Vec<Arc<Watcher>>)>,
    on_breach: Option<Breach>,
    // the CLI's children together passed the limit: the runner stops the heaviest one (services/ai/runs.py)
    on_child_breach: Option<Breach>,
    child_breached: HashSet<String>,
    task: Option<tokio::task::JoinHandle<()>>,
    hist_at: HashMap<String, Instant>,
    saved_at: HashMap<String, Instant>,
    breached: HashSet<String>,
    limits: HashMap<String, (Instant, i64)>,
    timing: Timing,
}

/// Reads the tracked CLIs, keeps their history and tells watchers and the run engine what it sees.
#[derive(Default)]
pub struct Monitor {
    inner: Mutex<Inner>,
}

/// The monitor of this process.
pub static MON: LazyLock<Monitor> = LazyLock::new(Monitor::new);

impl Monitor {
    /// Nothing is read until a CLI is tracked or someone subscribes.
    pub fn new() -> Self {
        Self::default()
    }

    fn inner(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Forget everything (tests; each starts on its own event loop).
    pub fn reset(&self) {
        let mut inner = self.inner();
        if let Some(task) = inner.task.take() {
            task.abort();
        }
        inner.tracked.clear();
        inner.readings.clear();
        inner.history.clear();
        inner.peak.clear();
        inner.subscribers.clear();
        inner.hist_at.clear();
        inner.saved_at.clear();
        inner.breached.clear();
        inner.limits.clear();
    }

    /// Change the waits of the monitor (tests); `Timing::default()` puts the module's constants back.
    pub fn set_timing(&self, timing: Timing) {
        self.inner().timing = timing;
    }

    /// Who is told when a CLI passes the project's memory limit (`MON.on_breach = ...`).
    pub fn set_on_breach(&self, callback: Option<Breach>) {
        self.inner().on_breach = callback;
    }

    /// Who is told when what a CLI started passes the limit (`MON.on_child_breach = ...`).
    pub fn set_on_child_breach(&self, callback: Option<Breach>) {
        self.inner().on_child_breach = callback;
    }

    /// The last reading of a run's CLI (`MON.readings.get(run_id)`).
    pub fn reading(&self, run_id: &str) -> Option<Reading> {
        self.inner().readings.get(run_id).cloned()
    }

    /// The highest memory a run's CLI held (`MON.peak.get(run_id)`).
    pub fn peak(&self, run_id: &str) -> Option<f64> {
        self.inner().peak.get(run_id).copied()
    }

    /// The history points of a run (`MON.history.get(run_id)`).
    pub fn history(&self, run_id: &str) -> Vec<Value> {
        self.inner().history.get(run_id).map(|h| h.iter().cloned().collect()).unwrap_or_default()
    }

    /// Whether the reading loop runs.
    pub fn running(&self) -> bool {
        self.inner().task.as_ref().is_some_and(|t| !t.is_finished())
    }

    // --- what is watched -------------------------------------------------

    /// Start reading a run's CLI; the new CLI after a restart is tracked again.
    pub fn track(&'static self, run_id: &str, proc: Arc<CliProcess>, project_id: &str) {
        {
            let mut inner = self.inner();
            match inner.tracked.iter_mut().find(|(id, _, _)| id == run_id) {
                Some(slot) => (slot.1, slot.2) = (proc, project_id.to_string()),
                None => inner.tracked.push((run_id.to_string(), proc, project_id.to_string())),
            }
            inner.breached.remove(run_id);
            inner.readings.remove(run_id);
        }
        self.ensure_running();
    }

    /// The CLI ended: save its peak and last value with the run.
    pub async fn untrack(&self, run_id: &str) -> Result<(), DbErr> {
        self.inner().tracked.retain(|(id, _, _)| id != run_id);
        let saved = self.save(run_id).await;
        self.inner().readings.remove(run_id);
        saved
    }

    /// run id -> (pid, project id) of the CLIs that are running.
    pub fn live(&self) -> Vec<(String, i32, String)> {
        let inner = self.inner();
        inner
            .tracked
            .iter()
            .filter(|(_, proc, _)| proc.running())
            .filter_map(|(run_id, proc, project_id)| Some((run_id.clone(), proc.pid()?, project_id.clone())))
            .collect()
    }

    /// Start the reading loop if it is not running.
    pub fn ensure_running(&'static self) {
        let Ok(runtime) = tokio::runtime::Handle::try_current() else { return };
        let mut inner = self.inner();
        if inner.task.as_ref().is_none_or(|t| t.is_finished()) {
            inner.task = Some(runtime.spawn(self.run_loop()));
        }
    }

    // --- limits ------------------------------------------------------------

    /// The project's memory limit for a run's CLI (0: none), remembered for a few seconds.
    pub async fn limit_mb(&self, project_id: &str) -> Result<i64, DbErr> {
        let now = Instant::now();
        {
            let inner = self.inner();
            if let Some((at, limit)) = inner.limits.get(project_id) {
                if now.duration_since(*at).as_secs_f64() < inner.timing.limit_ttl_s {
                    return Ok(*limit);
                }
            }
        }
        let limit = {
            let session = database::session();
            i64::from(get_settings(&session, project_id).await?.run_memory_limit_mb)
        };
        self.inner().limits.insert(project_id.to_string(), (now, limit));
        Ok(limit)
    }

    /// A person changed the project's limit: use it from the next reading.
    pub fn limit_changed(&self, project_id: &str) {
        self.inner().limits.remove(project_id);
    }

    // --- the loop ----------------------------------------------------------

    async fn run_loop(&'static self) {
        loop {
            let live = self.live();
            if live.is_empty() && self.inner().subscribers.is_empty() {
                break;
            }
            let round = async {
                self.read_all(&live).await?;
                self.publish().await
            };
            if let Err(e) = round.await {
                // Python lets the error end the loop; the next `track` or `subscribe` starts it again
                tracing::debug!(target: "kanban.ai.resources", "The resources loop stopped: {e}");
                break;
            }
            let sample = self.inner().timing.sample_s;
            tokio::time::sleep(Duration::from_secs_f64(sample.max(0.0))).await;
        }
        self.inner().task = None;
    }

    async fn read_all(&self, live: &[(String, i32, String)]) -> Result<(), DbErr> {
        let now = Instant::now();
        let timing = self.inner().timing;
        let due = |at: Option<&Instant>, every: f64| at.is_none_or(|at| now.duration_since(*at).as_secs_f64() >= every);
        for (run_id, pid, project_id) in live {
            let pid = *pid;
            let Ok(Some(mut reading)) = tokio::task::spawn_blocking(move || read_run(pid)).await else { continue };
            let at = time::now_iso();
            reading.at = Some(at.clone());
            self.inner().readings.insert(run_id.clone(), reading.clone());
            if !reading.readable {
                continue;
            }
            let rss = reading.cli_rss_mb.unwrap_or(0.0);
            let save_now = {
                let mut inner = self.inner();
                let peak = inner.peak.get(run_id).copied().unwrap_or(0.0).max(rss);
                inner.peak.insert(run_id.clone(), peak);
                if due(inner.hist_at.get(run_id), timing.history_every_s) {
                    inner.hist_at.insert(run_id.clone(), now);
                    let history = inner.history.entry(run_id.clone()).or_default();
                    if history.len() >= HISTORY_POINTS {
                        history.pop_front();
                    }
                    history.push_back(json!({"at": at, "rss_mb": rss, "cpu_pct": reading.cpu_pct}));
                }
                let save_now = due(inner.saved_at.get(run_id), timing.save_every_s);
                if save_now {
                    inner.saved_at.insert(run_id.clone(), now);
                }
                save_now
            };
            if save_now {
                self.save(run_id).await?;
            }
            let limit = self.limit_mb(project_id).await?;
            let on_breach = {
                let mut inner = self.inner();
                let breach = limit > 0 && rss > limit as f64 && !inner.breached.contains(run_id);
                match inner.on_breach.clone().filter(|_| breach) {
                    Some(callback) => {
                        inner.breached.insert(run_id.clone());
                        Some(callback)
                    }
                    None => None,
                }
            };
            if let Some(callback) = on_breach {
                callback(run_id.clone(), rss, limit).await;
            }
            let extra = reading.extra_mb.unwrap_or(0.0);
            let on_child_breach = {
                let mut inner = self.inner();
                let breach = limit > 0 && extra > limit as f64 && !inner.child_breached.contains(run_id);
                match inner.on_child_breach.clone().filter(|_| breach) {
                    Some(callback) => {
                        // what the CLI started holds more than the limit: the child is the cause, not the CLI
                        // (design C)
                        inner.child_breached.insert(run_id.clone());
                        Some(callback)
                    }
                    None => None,
                }
            };
            if let Some(callback) = on_child_breach {
                callback(run_id.clone(), extra, limit).await;
            }
        }
        Ok(())
    }

    /// Write the peak and the last value to the run.
    pub async fn save(&self, run_id: &str) -> Result<(), DbErr> {
        let (reading, peak) = {
            let inner = self.inner();
            (inner.readings.get(run_id).cloned(), inner.peak.get(run_id).copied().unwrap_or(0.0))
        };
        let Some(reading) = reading.filter(|r| r.readable) else { return Ok(()) };
        let session = database::session();
        let Some(mut run) = ai_run::Entity::find_by_id(run_id).one(&session).await? else { return Ok(()) };
        run.last_rss_mb = reading.cli_rss_mb;
        run.peak_rss_mb = Some(run.peak_rss_mb.unwrap_or(0.0).max(peak));
        save(&session, run).await?;
        session.commit().await
    }

    // --- watchers ----------------------------------------------------------

    /// A queue that receives the project's snapshot every reading; keeps only the newest.
    pub fn subscribe(&'static self, project_id: &str) -> Arc<Watcher> {
        let queue = Arc::new(Watcher::default());
        {
            let mut inner = self.inner();
            match inner.subscribers.iter_mut().find(|(p, _)| p == project_id) {
                Some((_, queues)) => queues.push(queue.clone()),
                None => inner.subscribers.push((project_id.to_string(), vec![queue.clone()])),
            }
        }
        self.ensure_running();
        queue
    }

    /// Stop sending to a queue.
    pub fn unsubscribe(&self, project_id: &str, queue: &Arc<Watcher>) {
        let mut inner = self.inner();
        if let Some((_, queues)) = inner.subscribers.iter_mut().find(|(p, _)| p == project_id) {
            queues.retain(|q| !Arc::ptr_eq(q, queue));
        }
        inner.subscribers.retain(|(_, queues)| !queues.is_empty());
    }

    async fn publish(&self) -> Result<(), DbErr> {
        let projects: Vec<String> = self.inner().subscribers.iter().map(|(p, _)| p.clone()).collect();
        for project_id in projects {
            let snap = Value::Object(snapshot(&project_id).await?);
            let queues: Vec<Arc<Watcher>> = self
                .inner()
                .subscribers
                .iter()
                .find(|(p, _)| *p == project_id)
                .map(|(_, queues)| queues.clone())
                .unwrap_or_default();
            for queue in queues {
                queue.put(snap.clone());
            }
        }
        // The CLIs run in the runner process and so does this monitor: the people's app lives in another one, so the
        // same snapshot goes out as a typed event (`ai.resources`) over the event stream, for each project with a
        // live CLI.
        let mut projects: Vec<String> = Vec::new();
        for (_, _, project_id) in self.live() {
            if !projects.contains(&project_id) {
                projects.push(project_id);
            }
        }
        for project_id in projects {
            // numbers for a screen never stop a run
            match snapshot(&project_id).await {
                Ok(snap) => events::publish_typed("ai.resources", &snap).await,
                Err(e) => {
                    tracing::debug!(target: "kanban.ai.resources", "Could not announce the resources of {project_id}: {e}")
                }
            }
        }
        Ok(())
    }
}
