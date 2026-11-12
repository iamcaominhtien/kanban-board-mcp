//! `steps.StepWriter` (`services/ai/steps.py`, lines 251 to 313) as `engine._run` uses it.
//!
//! `kb_ai::steps::StepWriter` is the port of that class, but it keeps the rows it has not written yet to itself, and
//! `engine._run` reads and changes them (`next(r for r in writer.rows if r.get("tool_id") == res["tool_id"])`: a
//! tool's result that arrives before its step is written goes onto the waiting row). So the turn's writer is here,
//! with that one extra call (`attach_pending`); it writes through `kb_ai::steps::append`.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use kb_ai::steps::{self, Extras, FLUSH_S};
use kb_base::ctx;
use serde_json::{Map, Value};
use tokio::task::JoinHandle;

/// What waits for the next flush.
#[derive(Default)]
struct Pending {
    rows: Vec<Value>,
    agents: Vec<Value>,
    files: Vec<Value>,
    fields: Map<String, Value>,
}

impl Pending {
    fn is_empty(&self) -> bool {
        self.rows.is_empty() && self.agents.is_empty() && self.files.is_empty() && self.fields.is_empty()
    }
}

struct Inner {
    run_id: String,
    pending: Mutex<Pending>,
    timer: Mutex<Option<JoinHandle<()>>>,
    writing: tokio::sync::Mutex<()>,
}

/// Gathers a turn's steps as its stream yields them and writes them in batches.
#[derive(Clone)]
pub(crate) struct StepWriter {
    inner: Arc<Inner>,
}

impl StepWriter {
    /// Batch the steps of `run_id`.
    pub(crate) fn new(run_id: &str) -> Self {
        Self {
            inner: Arc::new(Inner {
                run_id: run_id.to_string(),
                pending: Mutex::default(),
                timer: Mutex::new(None),
                writing: tokio::sync::Mutex::new(()),
            }),
        }
    }

    fn pending(&self) -> std::sync::MutexGuard<'_, Pending> {
        self.inner.pending.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Queue rows (and agents, fields, files) for the next flush.
    pub(crate) fn add(&self, rows: Vec<Value>, agents: Vec<Value>, files: Vec<Value>, fields: Map<String, Value>) {
        {
            let mut pending = self.pending();
            pending.rows.extend(rows);
            pending.agents.extend(agents);
            pending.files.extend(files);
            pending.fields.extend(fields);
        }
        let mut timer = self.inner.timer.lock().unwrap_or_else(|e| e.into_inner());
        if timer.as_ref().is_none_or(JoinHandle::is_finished) {
            let writer = self.clone();
            *timer = Some(ctx::spawn(async move {
                tokio::time::sleep(Duration::from_secs_f64(FLUSH_S)).await;
                writer.flush().await;
            }));
        }
    }

    /// A tool's result for a step that waits to be written: its output and detail go onto that row. False when no
    /// waiting row is that tool call (the step is already in the database).
    pub(crate) fn attach_pending(&self, tool_id: &Value, output: &Value, detail: &Map<String, Value>) -> bool {
        let mut pending = self.pending();
        let hit = pending
            .rows
            .iter_mut()
            .filter_map(Value::as_object_mut)
            .find(|row| row.get("tool_id").unwrap_or(&Value::Null) == tool_id);
        let Some(row) = hit else { return false };
        row.insert("output".into(), output.clone());
        // `{**(hit.get("detail") or {}), **detail}`
        let mut merged = match row.get("detail") {
            Some(Value::Object(old)) => old.clone(),
            _ => Map::new(),
        };
        merged.extend(detail.clone());
        row.insert("detail".into(), Value::Object(merged));
        true
    }

    async fn write_pending(&self) {
        let pending = std::mem::take(&mut *self.pending());
        if pending.is_empty() {
            return;
        }
        let extras = Extras { agents: pending.agents, fields: pending.fields, files: pending.files, announce: true };
        // a lost batch of steps never stops the run
        if let Err(err) = steps::append(&self.inner.run_id, pending.rows, extras).await {
            tracing::error!(target: "kanban.ai.steps", "Could not write the steps of run {}: {err}", self.inner.run_id);
        }
    }

    /// Write what is queued now.
    pub(crate) async fn flush(&self) {
        let _writing = self.inner.writing.lock().await;
        self.write_pending().await;
    }

    /// Write what is left and stop the timer. A write the timer has begun is let finish first, so its batch is not
    /// lost with the timer.
    pub(crate) async fn close(&self) {
        let _writing = self.inner.writing.lock().await;
        let timer = self.inner.timer.lock().unwrap_or_else(|e| e.into_inner()).take();
        if let Some(timer) = timer {
            timer.abort();
        }
        self.write_pending().await;
    }
}
