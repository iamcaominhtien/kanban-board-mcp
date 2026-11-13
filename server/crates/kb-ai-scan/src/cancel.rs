//! What `task.cancel()` and `asyncio.wait_for(..., timeout)` do to a job's task, for code that cannot be dropped in the
//! middle: Python raises `CancelledError` at the task's current `await` and the `finally:` blocks run (the child
//! process is killed, the scratch worktree removed). A Rust future that is dropped runs none of that, so a job
//! carries a `Cancel` and the places that wait (a command running, the AI running) watch it and return
//! `Error::Cancelled` after cleaning up.

use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};

use tokio::sync::Notify;

/// Why a job was told to stop.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Reason {
    /// `cancel_job` (the person pressed Cancel).
    Cancelled,
    /// `JOB_LIMIT_S` passed (`asyncio.wait_for` raised `TimeoutError`).
    TimedOut,
}

/// A stop signal that can be waited for.
#[derive(Default)]
pub struct Cancel {
    flag: AtomicBool,
    reason: Mutex<Option<Reason>>,
    notify: Notify,
}

impl Cancel {
    /// A signal that has not been given.
    pub fn new() -> Self {
        Self::default()
    }

    /// Give the signal (the first reason stays).
    pub fn cancel(&self, why: Reason) {
        {
            let mut reason = self.reason.lock().unwrap_or_else(|e| e.into_inner());
            if reason.is_none() {
                *reason = Some(why);
            }
        }
        self.flag.store(true, Ordering::SeqCst);
        self.notify.notify_waiters();
    }

    /// Whether the signal was given.
    pub fn is_cancelled(&self) -> bool {
        self.flag.load(Ordering::SeqCst)
    }

    /// Why it was given.
    pub fn reason(&self) -> Option<Reason> {
        *self.reason.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Wait until the signal is given (at once when it already was).
    pub async fn cancelled(&self) {
        loop {
            let notified = self.notify.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            if self.is_cancelled() {
                return;
            }
            notified.await;
        }
    }
}
