//! The event bus behind `GET /events`: what the board's window listens to.
//!
//! An announcement is one string. `"invalidate"` means "anything may have changed, refetch"; with topics it is
//! `{"type": "invalidate", "topics": [...]}` and the app refetches only what depends on them; a typed event
//! (`ai.step`, `ai.run`, ...) carries the change itself.

use std::collections::{HashMap, VecDeque};
use std::future::Future;
use std::pin::Pin;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, LazyLock, Mutex, RwLock};

use serde_json::{Map, Value, json};
use tokio::sync::Notify;

use crate::pyjson;

pub const INVALIDATE: &str = "invalidate";

/// A run's steps and state: the AI screens, the run panels, the workspace of a ticket.
pub const TOPIC_AI: &str = "ai";

/// Typed events that are readings, not changes (`publish_typed`): they reach the windows but are not announcements.
pub const QUIET_KINDS: [&str; 1] = ["ai.resources"];

/// Is this event string (as `publish_typed` wrote it) one of the `QUIET_KINDS`?
fn is_quiet(event: &str) -> bool {
    QUIET_KINDS.iter().any(|kind| event.starts_with(&format!("{{\"type\": \"{kind}\"")))
}

const QUEUE_SIZE: usize = 100;

/// One listener's queue: at most 100 events; when it is full the oldest is dropped for the new one. (Dropping the
/// listener instead would leave its stream open but silent, so the board stopped updating until a restart.)
pub struct Subscriber {
    id: u64,
    queue: Mutex<VecDeque<String>>,
    notify: Notify,
}

impl Subscriber {
    /// The next event, waiting for one.
    pub async fn recv(&self) -> String {
        loop {
            let waiting = self.notify.notified();
            if let Some(event) = self.try_recv() {
                return event;
            }
            waiting.await;
        }
    }

    /// The next event if one is waiting.
    pub fn try_recv(&self) -> Option<String> {
        self.queue.lock().unwrap_or_else(|e| e.into_inner()).pop_front()
    }

    fn push(&self, event: &str) {
        let mut queue = self.queue.lock().unwrap_or_else(|e| e.into_inner());
        if queue.len() >= QUEUE_SIZE {
            queue.pop_front();
        }
        queue.push_back(event.to_string());
        drop(queue);
        self.notify.notify_one();
    }
}

impl Drop for Subscriber {
    fn drop(&mut self) {
        // the registry holds its own Arc, so this runs only after `unsubscribe`; nothing to do
    }
}

type Forwarder = Arc<dyn Fn(String) -> Pin<Box<dyn Future<Output = ()> + Send>> + Send + Sync>;
type Listener = Arc<dyn Fn() + Send + Sync>;

static SUBSCRIBERS: LazyLock<Mutex<HashMap<u64, Arc<Subscriber>>>> = LazyLock::new(|| Mutex::new(HashMap::new()));
static NEXT_ID: AtomicU64 = AtomicU64::new(1);
/// Called (without waiting) on every publish: the notification centre checks its open rows soon after any change.
static ON_PUBLISH: LazyLock<RwLock<Vec<(usize, Listener)>>> = LazyLock::new(|| RwLock::new(Vec::new()));
/// Number of events published so far (lets the database watcher tell whether this process already announced a
/// change).
static PUBLISHED: AtomicU64 = AtomicU64::new(0);
/// When the AI runner's commits happened (`time.time()`, told by the runner with `own_change`): the database watcher
/// takes a change it sees for the runner's when one of these falls between its last two readings.
static RUNNER_COMMITS: Mutex<VecDeque<f64>> = Mutex::new(VecDeque::new());
const RUNNER_COMMITS_KEPT: usize = 2000;
/// Set in the runner process: events go to the API over HTTP instead of local subscribers.
static FORWARDER: LazyLock<RwLock<Option<Forwarder>>> = LazyLock::new(|| RwLock::new(None));

/// Register a new SSE subscriber and return its queue.
pub fn subscribe() -> Arc<Subscriber> {
    let sub = Arc::new(Subscriber {
        id: NEXT_ID.fetch_add(1, Ordering::Relaxed),
        queue: Mutex::new(VecDeque::new()),
        notify: Notify::new(),
    });
    SUBSCRIBERS.lock().unwrap_or_else(|e| e.into_inner()).insert(sub.id, sub.clone());
    sub
}

/// Remove a subscriber's queue.
pub fn unsubscribe(sub: &Subscriber) {
    SUBSCRIBERS.lock().unwrap_or_else(|e| e.into_inner()).remove(&sub.id);
}

/// Number of open subscribers.
pub fn subscriber_count() -> usize {
    SUBSCRIBERS.lock().unwrap_or_else(|e| e.into_inner()).len()
}

/// Call `callback()` (synchronously, cheaply) whenever something is published. `key` names the listener, so
/// registering it twice keeps one.
pub fn on_publish(key: usize, callback: impl Fn() + Send + Sync + 'static) {
    let mut listeners = ON_PUBLISH.write().unwrap_or_else(|e| e.into_inner());
    if !listeners.iter().any(|(k, _)| *k == key) {
        listeners.push((key, Arc::new(callback)));
    }
}

/// Route every announcement through `forward(event_json)` (the runner process has no SSE subscribers of its own).
pub fn set_forwarder<F, Fut>(forward: F)
where
    F: Fn(String) -> Fut + Send + Sync + 'static,
    Fut: Future<Output = ()> + Send + 'static,
{
    *FORWARDER.write().unwrap_or_else(|e| e.into_inner()) = Some(Arc::new(move |event| Box::pin(forward(event))));
}

/// Stop forwarding (tests).
pub fn clear_forwarder() {
    *FORWARDER.write().unwrap_or_else(|e| e.into_inner()) = None;
}

/// How many events this process has published (or marked as its own change).
pub fn published() -> u64 {
    PUBLISHED.load(Ordering::SeqCst)
}

fn note_publish() {
    PUBLISHED.fetch_add(1, Ordering::SeqCst);
    let listeners: Vec<Listener> =
        ON_PUBLISH.read().unwrap_or_else(|e| e.into_inner()).iter().map(|(_, cb)| cb.clone()).collect();
    for cb in listeners {
        // a listener never stops an announcement
        if std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| cb())).is_err() {
            tracing::debug!("A publish listener failed");
        }
    }
}

fn deliver(event: &str) {
    let subscribers: Vec<Arc<Subscriber>> =
        SUBSCRIBERS.lock().unwrap_or_else(|e| e.into_inner()).values().cloned().collect();
    for sub in subscribers {
        sub.push(event);
    }
}

async fn send(event: String) {
    let forwarder = FORWARDER.read().unwrap_or_else(|e| e.into_inner()).clone();
    match forwarder {
        Some(forward) => forward(event).await,
        None => deliver(&event),
    }
}

/// Broadcast an event string to all active SSE subscribers.
///
/// With `topics` an invalidation says what changed (`{"type": "invalidate", "topics": [...]}`), so the app
/// refetches only that. Without, it is the plain string and the app refetches everything.
pub async fn publish(event: &str, topics: &[&str]) {
    note_publish();
    let event = if topics.is_empty() {
        event.to_string()
    } else {
        let mut sorted: Vec<&str> = topics.to_vec();
        sorted.sort_unstable();
        sorted.dedup();
        pyjson::dumps(&json!({"type": event, "topics": sorted}))
    };
    send(event).await;
}

/// Count a change of this process as announced without telling anyone (nothing the app shows changed): the
/// database watcher then does not announce it as another process's.
pub fn mark_announced() {
    PUBLISHED.fetch_add(1, Ordering::SeqCst);
}

/// `publish("invalidate")`: anything may have changed.
pub async fn invalidate() {
    publish(INVALIDATE, &[]).await;
}

/// Broadcast a typed event (AI v2): `{"type": kind, ...payload}`. The app patches its cache from it instead of
/// refetching; `kind` is `ai.step`, `ai.run`, `ai.agent`, `ai.message` or `ai.resources`.
///
/// `ai.resources` (RAM and CPU every 2 s while a CLI runs) is a reading, not a change: it does not count as an
/// announcement (the database watcher would take another process's change for this one's) and does not wake the
/// notification centre.
pub async fn publish_typed(kind: &str, payload: &Map<String, Value>) {
    if !QUIET_KINDS.contains(&kind) {
        note_publish();
    }
    let mut event = Map::new();
    event.insert("type".into(), json!(kind));
    for (key, value) in payload {
        event.insert(key.clone(), value.clone());
    }
    send(pyjson::dumps(&Value::Object(event))).await;
}

/// An event that arrived from the runner process: to every subscriber as it is.
pub fn broadcast_raw(event: &str) {
    if !is_quiet(event) {
        note_publish();
    }
    deliver(event);
}

/// Note that this process changed the database and chose not to announce it yet (a run's steps are announced at
/// most once a second). The database watcher then does not take the commit for another process's.
///
/// (`mark_own_change()` without `at`; `mark_own_change_at` is the call with it.)
pub fn mark_own_change() {
    PUBLISHED.fetch_add(1, Ordering::SeqCst);
}

/// `mark_own_change(at)`: the times of commits the AI runner made (`POST /internal/ai/events` with `own_change`).
/// They are matched to the watcher's readings by when they happened, not by when the news arrived: a commit made
/// while the watcher waits for an announcement is only seen at its next reading, and must be explained there too.
pub fn mark_own_change_at(at: &[f64]) {
    let mut commits = RUNNER_COMMITS.lock().unwrap_or_else(|e| e.into_inner());
    for t in at {
        if commits.len() >= RUNNER_COMMITS_KEPT {
            commits.pop_front();
        }
        commits.push_back(*t);
    }
}

/// Did the runner say it committed between these two times (with a little slack for the clocks of the reads)?
pub fn runner_committed(after: f64, until: f64) -> bool {
    let (lo, hi) = (after - COMMIT_SLACK_S, until + COMMIT_SLACK_S);
    let commits = RUNNER_COMMITS.lock().unwrap_or_else(|e| e.into_inner());
    for &t in commits.iter().rev() {
        if lo < t && t <= hi {
            return true;
        }
        if t <= lo {
            break;
        }
    }
    false
}

/// The slack of `runner_committed`, in seconds.
pub const COMMIT_SLACK_S: f64 = 0.05;

/// How long the database watcher waits for an announcement while the runner runs, at least (seconds).
pub const RUNNER_GRACE_S: f64 = 0.5;
/// How often (seconds) the tickets and Docs are refetched while the runner's commits explain the changes.
pub const RUNNER_MASK_REFRESH_S: f64 = 15.0;
static RUNNER_MASK_REFRESH_BITS: AtomicU64 = AtomicU64::new(0);

/// `RUNNER_MASK_REFRESH_S` as it is now (tests make it short with `set_runner_mask_refresh`).
pub fn runner_mask_refresh_s() -> f64 {
    match RUNNER_MASK_REFRESH_BITS.load(Ordering::SeqCst) {
        0 => RUNNER_MASK_REFRESH_S,
        bits => f64::from_bits(bits),
    }
}

/// Change `RUNNER_MASK_REFRESH_S` (tests; `None` goes back to the default).
pub fn set_runner_mask_refresh(seconds: Option<f64>) {
    RUNNER_MASK_REFRESH_BITS.store(seconds.map_or(0, f64::to_bits), Ordering::SeqCst);
}

static RUNNER_ALIVE: RwLock<Option<fn() -> bool>> = RwLock::new(None);

/// The hook behind `grace_for`: whether the AI runner this process started is running (`runner_link.alive`, an
/// area above this crate).
pub fn set_runner_alive_hook(alive: fn() -> bool) {
    *RUNNER_ALIVE.write().unwrap_or_else(|e| e.into_inner()) = Some(alive);
}

/// How long to wait for a change's announcement. The AI runner writes from its own process and says so over HTTP
/// (`own_change`), which takes longer than this process's own announcement: wait for it while it runs.
pub fn grace_for(grace: f64) -> f64 {
    let alive = *RUNNER_ALIVE.read().unwrap_or_else(|e| e.into_inner());
    // the watcher never fails over this
    let running = alive.is_some_and(|alive| std::panic::catch_unwind(alive).unwrap_or(false));
    if running { grace.max(RUNNER_GRACE_S) } else { grace }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The bus is global: the tests of this module take turns.
    static TURN: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

    /// `test_ai_resources_reaches_the_windows_but_is_not_an_announcement` (tests/test_runner_announcements.py).
    #[tokio::test]
    async fn test_ai_resources_reaches_the_windows_but_is_not_an_announcement() {
        let _turn = TURN.lock().await;
        static CALLS: AtomicU64 = AtomicU64::new(0);
        on_publish(usize::MAX - 1, || {
            CALLS.fetch_add(1, Ordering::SeqCst);
        });
        let q = subscribe();
        let before = published();
        let calls = CALLS.load(Ordering::SeqCst);
        let mut payload = Map::new();
        payload.insert("project_id".into(), json!("p"));
        payload.insert("runs".into(), json!([]));
        publish_typed("ai.resources", &payload).await;
        broadcast_raw(r#"{"type": "ai.resources", "project_id": "p"}"#);
        assert_eq!(published(), before);
        assert_eq!(CALLS.load(Ordering::SeqCst), calls);
        let mut got = Vec::new();
        while let Some(event) = q.try_recv() {
            got.push(event);
        }
        assert!(got.len() == 2 && got.iter().all(|g| g.contains("\"ai.resources\"")), "{got:?}");
        // a real change still counts
        broadcast_raw(r#"{"type": "ai.step", "run_id": "r"}"#);
        assert_eq!(published(), before + 1);
        assert_eq!(CALLS.load(Ordering::SeqCst), calls + 1);
        // nothing the app shows changed: counted, told to nobody
        mark_announced();
        assert_eq!(published(), before + 2);
        assert_eq!(CALLS.load(Ordering::SeqCst), calls + 1);
        unsubscribe(&q);
        ON_PUBLISH.write().unwrap_or_else(|e| e.into_inner()).retain(|(k, _)| *k != usize::MAX - 1);
    }

    /// The timed half of `test_own_change_over_http_counts_and_reaches_nobody`: commits the runner told about are
    /// matched to the readings by time, and are not counted as an announcement.
    #[tokio::test]
    async fn the_runners_commits_are_matched_by_time() {
        let _turn = TURN.lock().await;
        let before = published();
        let now = crate::time::epoch();
        mark_own_change_at(&[now - 0.2, now]);
        assert_eq!(published(), before);
        assert!(runner_committed(now - 0.1, now + 0.1));
        assert!(!runner_committed(now + 1.0, now + 2.0));
        // the slack of the clocks
        assert!(runner_committed(now + 0.04, now + 1.0));
        mark_own_change();
        assert_eq!(published(), before + 1);
    }

    #[test]
    fn the_grace_is_longer_while_the_runner_runs() {
        assert_eq!(grace_for(0.15), 0.15);
        set_runner_alive_hook(|| true);
        assert_eq!(grace_for(0.15), RUNNER_GRACE_S);
        assert_eq!(grace_for(0.8), 0.8);
        set_runner_alive_hook(|| false);
        assert_eq!(grace_for(0.15), 0.15);
    }

    #[tokio::test]
    async fn a_slow_subscriber_keeps_its_place_and_loses_the_oldest() {
        let _turn = TURN.lock().await;
        let sub = subscribe();
        publish(INVALIDATE, &[]).await;
        publish(INVALIDATE, &["b", "a", "b"]).await;
        assert_eq!(sub.recv().await, "invalidate");
        assert_eq!(sub.recv().await, r#"{"type": "invalidate", "topics": ["a", "b"]}"#);
        for i in 0..150 {
            broadcast_raw(&i.to_string());
        }
        assert_eq!(sub.recv().await, "50");
        let mut payload = Map::new();
        payload.insert("run_id".into(), json!("r1"));
        publish_typed("ai.run", &payload).await;
        let mut last = String::new();
        while let Some(event) = sub.try_recv() {
            last = event;
        }
        assert_eq!(last, r#"{"type": "ai.run", "run_id": "r1"}"#);
        unsubscribe(&sub);
    }
}
