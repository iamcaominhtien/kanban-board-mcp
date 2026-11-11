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

/// `publish("invalidate")`: anything may have changed.
pub async fn invalidate() {
    publish(INVALIDATE, &[]).await;
}

/// Broadcast a typed event (AI v2): `{"type": kind, ...payload}`. The app patches its cache from it instead of
/// refetching; `kind` is `ai.step`, `ai.run`, `ai.agent` or `ai.message`.
pub async fn publish_typed(kind: &str, payload: &Map<String, Value>) {
    note_publish();
    let mut event = Map::new();
    event.insert("type".into(), json!(kind));
    for (key, value) in payload {
        event.insert(key.clone(), value.clone());
    }
    send(pyjson::dumps(&Value::Object(event))).await;
}

/// An event that arrived from the runner process: to every subscriber as it is.
pub fn broadcast_raw(event: &str) {
    note_publish();
    deliver(event);
}

/// Note that this process changed the database and chose not to announce it yet (a run's steps are announced at
/// most once a second). The database watcher then does not take the commit for another process's.
pub fn mark_own_change() {
    PUBLISHED.fetch_add(1, Ordering::SeqCst);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn a_slow_subscriber_keeps_its_place_and_loses_the_oldest() {
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
