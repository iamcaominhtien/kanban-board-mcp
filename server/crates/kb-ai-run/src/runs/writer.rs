//! `steps.StepWriter` (`services/ai/steps.py` lines 251-313) as `runs` uses it.
//!
//! `kb_ai::steps::StepWriter` is the port of that class, but it keeps the rows it has not written yet to itself, and
//! `runs._attach_result` reads and changes them (`for row in writer.rows`: a tool's result that arrives before its
//! step is written goes onto the waiting row). So the run's writer lives here, with that one extra call
//! (`attach_pending`); everything else is the class as it is, writing through `kb_ai::steps::append` (one writer at a time for each run:
//! see `runs::append_steps`).

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::Duration;

use kb_ai::steps::{Extras, FLUSH_S};
use kb_base::ctx;
use serde_json::{Map, Value};
use tokio::task::JoinHandle;

/// The batch a `StepWriter` holds until its next flush.
#[derive(Default)]
struct Pending {
    rows: Vec<Value>,
    agents: Vec<Value>,
    files: Vec<Value>,
    fields: Map<String, Value>,
}

struct Inner {
    run_id: String,
    pending: StdMutex<Pending>,
    task: StdMutex<Option<JoinHandle<()>>>,
    lock: tokio::sync::Mutex<()>,
    written: AtomicUsize,
}

/// Gathers a run's steps as its stream yields them and writes them in batches.
#[derive(Clone)]
pub struct StepWriter {
    inner: Arc<Inner>,
}

impl StepWriter {
    /// Batch the steps of `run_id`.
    pub fn new(run_id: &str) -> Self {
        Self {
            inner: Arc::new(Inner {
                run_id: run_id.to_string(),
                pending: StdMutex::new(Pending::default()),
                task: StdMutex::new(None),
                lock: tokio::sync::Mutex::new(()),
                written: AtomicUsize::new(0),
            }),
        }
    }

    /// How many steps this writer has written so far.
    pub fn written(&self) -> usize {
        self.inner.written.load(Ordering::SeqCst)
    }

    /// Queue rows (and agents, fields, files) for the next flush. Must run inside the Tokio runtime.
    pub fn add(&self, rows: Vec<Value>, agents: Vec<Value>, files: Vec<Value>, fields: Map<String, Value>) {
        {
            let mut p = self.inner.pending.lock().unwrap_or_else(|e| e.into_inner());
            p.rows.extend(rows);
            p.agents.extend(agents);
            p.files.extend(files);
            p.fields.extend(fields);
        }
        let mut task = self.inner.task.lock().unwrap_or_else(|e| e.into_inner());
        if task.as_ref().is_none_or(JoinHandle::is_finished) {
            let me = self.clone();
            *task = Some(ctx::spawn(async move { me.later().await }));
        }
    }

    /// `for row in writer.rows: if row.get("tool_id") == tool_id: ...` of `runs._attach_result`: put a tool's result
    /// onto the step that waits to be written. False when no waiting row is that tool call.
    pub fn attach_pending(&self, tool_id: &Value, output: &Value, detail: &Map<String, Value>) -> bool {
        let mut p = self.inner.pending.lock().unwrap_or_else(|e| e.into_inner());
        for row in &mut p.rows {
            let Value::Object(row) = row else { continue };
            if row.get("tool_id").unwrap_or(&Value::Null) != tool_id {
                continue;
            }
            row.insert("output".into(), output.clone());
            let mut merged = match row.get("detail") {
                Some(Value::Object(old)) => old.clone(),
                _ => Map::new(),
            };
            merged.extend(detail.clone());
            row.insert("detail".into(), Value::Object(merged));
            return true;
        }
        false
    }

    async fn later(&self) {
        tokio::time::sleep(Duration::from_secs_f64(FLUSH_S)).await;
        self.flush().await;
    }

    /// Write what is queued now.
    pub async fn flush(&self) {
        let _guard = self.inner.lock.lock().await;
        self.write_pending().await;
    }

    async fn write_pending(&self) {
        let pending = std::mem::take(&mut *self.inner.pending.lock().unwrap_or_else(|e| e.into_inner()));
        if pending.rows.is_empty() && pending.agents.is_empty() && pending.files.is_empty() && pending.fields.is_empty()
        {
            return;
        }
        let extras = Extras { agents: pending.agents, fields: pending.fields, files: pending.files, announce: true };
        // a lost batch of steps never stops the run
        match super::append_steps(&self.inner.run_id, pending.rows, extras).await {
            Ok(written) => {
                self.inner.written.fetch_add(written.len(), Ordering::SeqCst);
            }
            Err(err) => {
                tracing::error!(target: "kanban.ai.steps", "Could not write the steps of run {}: {err}", self.inner.run_id);
            }
        }
    }

    /// Write what is left and stop the timer.
    ///
    /// Python cancels the timer task wherever it is; one that is cancelled in the middle of its write loses the batch
    /// it had taken. Here a write that is under way is let finish first (the lock), then the timer is stopped.
    pub async fn close(&self) {
        let _guard = self.inner.lock.lock().await;
        let task = self.inner.task.lock().unwrap_or_else(|e| e.into_inner()).take();
        if let Some(task) = task {
            if !task.is_finished() {
                task.abort();
            }
        }
        self.write_pending().await;
    }
}
