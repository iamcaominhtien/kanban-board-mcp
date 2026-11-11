//! Part of `services/notifications.py`: lines 192 to 223, "Delivery: the log moved to id N". The module-level
//! state of the Python file (`_dirty`, `_pending`, `_later`) lives here as statics.

use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, LazyLock, Mutex};

use kb_base::{events, pyjson};
use kb_db::Session;
use kb_db::entities::notify_event;
use kb_db::sea_orm::{EntityTrait, QuerySelect};
use serde_json::json;
use tokio::sync::Notify;

use crate::error::Result;
use crate::features::CommentFields;
use crate::kinds::TOPIC;
use crate::settings::global;
use crate::writing::PendingEvent;

/// `asyncio.Event`: set, clear, test and wait.
pub struct Event {
    flag: AtomicBool,
    notify: Notify,
}

impl Event {
    /// A new event, not set.
    pub fn new() -> Self {
        Self { flag: AtomicBool::new(false), notify: Notify::new() }
    }

    /// `event.set()`.
    pub fn set(&self) {
        self.flag.store(true, Ordering::SeqCst);
        self.notify.notify_waiters();
    }

    /// `event.clear()`.
    pub fn clear(&self) {
        self.flag.store(false, Ordering::SeqCst);
    }

    /// `event.is_set()`.
    pub fn is_set(&self) -> bool {
        self.flag.load(Ordering::SeqCst)
    }

    /// `await event.wait()`.
    pub async fn wait(&self) {
        loop {
            let notified = self.notify.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            if self.is_set() {
                return;
            }
            notified.await;
        }
    }
}

impl Default for Event {
    fn default() -> Self {
        Self::new()
    }
}

/// `_dirty`: made by `start()`, on the runtime that runs the loop.
pub(crate) static DIRTY: LazyLock<Mutex<Option<Arc<Event>>>> = LazyLock::new(|| Mutex::new(None));
/// `_pending`: events queued by synchronous callers (schedules), written by the loop.
pub(crate) static PENDING: LazyLock<Mutex<VecDeque<PendingEvent>>> = LazyLock::new(|| Mutex::new(VecDeque::new()));
/// `_later`: the Docs comment events to write once the caller has committed (Python holds `(async function,
/// argument)` pairs; `on_comment_event` is the only function ever queued).
pub(crate) static LATER: LazyLock<Mutex<VecDeque<CommentFields>>> = LazyLock::new(|| Mutex::new(VecDeque::new()));

/// Something changed on the board: check the open Needs you rows soon.
pub fn mark_dirty() {
    let event = DIRTY.lock().unwrap_or_else(|e| e.into_inner()).clone();
    if let Some(event) = event {
        event.set();
    }
}

/// Tell every open window (and the desktop notifier) that the log or a row moved. The window asks for what it has
/// not seen, so a dropped message costs nothing.
pub async fn announce(head: Option<i32>) {
    let msg = pyjson::dumps(&json!({"type": "invalidate", "topics": [TOPIC], "head": head.unwrap_or(0)}));
    events::publish(&msg, &[]).await;
}

/// The newest id of the log (0 when empty); never below what retention deleted, so a cursor never goes back.
pub async fn head_id(session: &Session) -> Result<i32> {
    let top: Option<Option<i32>> = notify_event::Entity::find()
        .select_only()
        .column_as(notify_event::Column::Id.max(), "top")
        .into_tuple::<Option<i32>>()
        .one(session)
        .await?;
    let top = top.flatten().unwrap_or(0);
    let g = global(session).await?;
    let pruned = g.get("pruned_through").map(crate::helpers::py_int).and_then(|r| r.ok()).unwrap_or(0);
    Ok(i128::from(top).max(pruned).clamp(0, i128::from(i32::MAX)) as i32)
}
