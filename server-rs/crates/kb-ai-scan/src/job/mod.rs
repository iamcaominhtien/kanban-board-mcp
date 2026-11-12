//! The AI sets up the commands (`repo_scan.py` lines 834-1220: `JOB_LIMIT_S`, `LOG_KEEP`, `_TASKS`, `_STEP_LABEL`,
//! `JobRunning`, `running`, `_Job`, `start_job`, `cancel_job`; design C/D).
//!
//! A job is the AI (`mode="ai"`: it proposes, then the board runs each command) or the board alone (`"try"`) working on
//! a scan. It runs in a task of its own, writes its state into the scan row twice a second while it runs (the wizard
//! polls the row), and can be cancelled: the running command and everything it started is killed, the scratch copy
//! removed. Python cancels a task with `task.cancel()` and the `finally:` blocks run; here the job carries a `Cancel`
//! (see `cancel.rs`).
//!
//! - `ai`: what the AI is asked and how its answer is read (`ai_status`, `AI_PROMPT`, `_ask_ai`, `_parse_proposal`...).
//! - `body`: the job's task (`_run_job`, `_stop`, `_job_body`).

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::{Duration, Instant};

use kb_base::pyjson;
use kb_db::Session;
use kb_db::entities::ai_repo_scan;
use kb_db::sea_orm::ActiveValue::Set;
use kb_db::sea_orm::{ActiveModelTrait, EntityTrait, IntoActiveModel};
use serde_json::{Map, Value, json};
use tokio::sync::watch;

use crate::Error;
use crate::cancel::Cancel;
use crate::seams;

mod ai;
mod body;

pub use ai::{
    ai_prompt, ai_status, ai_status_real, ask_ai_real, code_proposal, describe_tool, parse_proposal, AI_PROMPT_TEMPLATE,
};
pub use crate::trial::COMMANDS;

/// `JOB_LIMIT_S`: a job is stopped after this many seconds.
pub const JOB_LIMIT_S: u64 = 10 * 60;
/// `LOG_KEEP`: the lines of a job's log that are kept.
pub const LOG_KEEP: usize = 400;

static JOB_LIMIT_MS: AtomicU64 = AtomicU64::new(JOB_LIMIT_S * 1000);

/// Change `JOB_LIMIT_S` (a test sets it; Python's tests assign `repo_scan.JOB_LIMIT_S`).
pub fn set_job_limit(seconds: f64) {
    JOB_LIMIT_MS.store((seconds.max(0.0) * 1000.0) as u64, Ordering::SeqCst);
}

pub(crate) fn job_limit() -> Duration {
    Duration::from_millis(JOB_LIMIT_MS.load(Ordering::SeqCst))
}

/// `_STEP_LABEL`.
pub(crate) fn step_label(name: &str) -> &'static str {
    match name {
        "prepare" => "Prepare",
        "test" => "Test",
        "lint" => "Lint",
        _ => "Build",
    }
}

/// A job's task: its stop signal and whether it has ended (`_TASKS`).
struct Task {
    cancel: Arc<Cancel>,
    done: watch::Receiver<bool>,
}

static TASKS: LazyLock<Mutex<HashMap<String, Task>>> = LazyLock::new(|| Mutex::new(HashMap::new()));

fn tasks() -> std::sync::MutexGuard<'static, HashMap<String, Task>> {
    TASKS.lock().unwrap_or_else(|e| e.into_inner())
}

/// Whether a job runs for this scan in this process.
pub fn running(scan_id: &str) -> bool {
    tasks().get(scan_id).is_some_and(|task| !*task.done.borrow())
}

/// The job's state as the wizard reads it (`AiRepoScan.job`), saved now and then while it runs.
pub struct Job {
    /// The scan the job works on.
    pub scan_id: String,
    inner: Mutex<Inner>,
    t0: Instant,
    saved: Mutex<Option<Instant>>,
}

struct Inner {
    doc: Map<String, Value>,
    trial: Map<String, Value>,
    proposal: Value,
}

impl Job {
    /// `_Job(scan_id, mode, hint, trial, proposal)`.
    pub fn new(scan_id: &str, mode: &str, hint: &str, trial: Map<String, Value>, proposal: Value) -> Job {
        let mut doc = Map::new();
        doc.insert("mode".into(), json!(mode));
        doc.insert("state".into(), json!("running"));
        doc.insert("started_at".into(), json!(kb_base::time::now_iso()));
        doc.insert("ended_at".into(), Value::Null);
        doc.insert("hint".into(), json!(hint));
        doc.insert("steps".into(), json!([]));
        doc.insert("log".into(), json!([]));
        doc.insert("error".into(), Value::Null);
        Job {
            scan_id: scan_id.to_string(),
            inner: Mutex::new(Inner { doc, trial, proposal }),
            t0: Instant::now(),
            saved: Mutex::new(None),
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// `int(time.monotonic() - self._t0)`.
    pub fn at(&self) -> i64 {
        self.t0.elapsed().as_secs() as i64
    }

    /// `job.doc`, as it is now.
    pub fn doc(&self) -> Value {
        Value::Object(self.lock().doc.clone())
    }

    /// `job.doc[key]`.
    pub fn doc_get(&self, key: &str) -> Value {
        self.lock().doc.get(key).cloned().unwrap_or(Value::Null)
    }

    /// `job.trial`, as it is now.
    pub fn trial(&self) -> Map<String, Value> {
        self.lock().trial.clone()
    }

    /// `job.trial[name] = value`.
    pub fn set_trial(&self, name: &str, value: Value) {
        self.lock().trial.insert(name.to_string(), value);
    }

    /// `job.trial.get(name)`.
    pub fn trial_get(&self, name: &str) -> Value {
        self.lock().trial.get(name).cloned().unwrap_or(Value::Null)
    }

    /// `job.proposal`, as it is now.
    pub fn proposal(&self) -> Value {
        self.lock().proposal.clone()
    }

    /// `job.proposal = value`.
    pub fn set_proposal(&self, value: Value) {
        self.lock().proposal = value;
    }

    /// `job.proposal["env_path"] = entries`.
    pub fn set_proposal_env_path(&self, entries: Value) {
        if let Value::Object(map) = &mut self.lock().proposal {
            map.insert("env_path".into(), entries);
        }
    }

    /// Add a step, or change its label, detail and state when there is one with this key.
    pub fn step(&self, key: &str, label: &str, detail: &str, state: &str) {
        let mut inner = self.lock();
        let Some(Value::Array(steps)) = inner.doc.get_mut("steps") else { return };
        for s in steps.iter_mut() {
            if s.get("key").and_then(Value::as_str) == Some(key) {
                if let Value::Object(map) = s {
                    map.insert("label".into(), json!(label));
                    map.insert("detail".into(), json!(detail));
                    map.insert("state".into(), json!(state));
                }
                return;
            }
        }
        steps.push(json!({"key": key, "label": label, "detail": detail, "state": state, "at_s": null}));
    }

    /// `job.mark(key, state, **kw)`: `label` and `detail` change with the state when given.
    pub fn mark(&self, key: &str, state: &str, label: Option<&str>, detail: Option<&str>) {
        let at = self.at();
        let mut inner = self.lock();
        let Some(Value::Array(steps)) = inner.doc.get_mut("steps") else { return };
        for s in steps.iter_mut() {
            if s.get("key").and_then(Value::as_str) != Some(key) {
                continue;
            }
            if let Value::Object(map) = s {
                map.insert("state".into(), json!(state));
                if state == "done" || state == "failed" {
                    map.insert("at_s".into(), json!(at));
                }
                if let Some(label) = label {
                    map.insert("label".into(), json!(label));
                }
                if let Some(detail) = detail {
                    map.insert("detail".into(), json!(detail));
                }
            }
        }
    }

    /// Add a line to the log (`text[:500]`), keeping the last `LOG_KEEP`.
    pub fn line(&self, text: &str) {
        let mut inner = self.lock();
        let Some(Value::Array(log)) = inner.doc.get_mut("log") else { return };
        log.push(json!(text.chars().take(500).collect::<String>()));
        if log.len() > LOG_KEEP {
            let extra = log.len() - LOG_KEEP;
            log.drain(..extra);
        }
    }

    /// The end of the job: its state, its error, and what was still waiting or running.
    pub fn finish(&self, state: &str, error: Option<&str>) {
        let mut inner = self.lock();
        inner.doc.insert("state".into(), json!(state));
        inner.doc.insert("error".into(), error.map_or(Value::Null, |e| json!(e)));
        inner.doc.insert("ended_at".into(), json!(kb_base::time::now_iso()));
        if let Some(Value::Array(steps)) = inner.doc.get_mut("steps") {
            for s in steps.iter_mut() {
                let now = s.get("state").and_then(Value::as_str).map(str::to_string);
                if let (Some(now), Value::Object(map)) = (now, s) {
                    match now.as_str() {
                        "running" => map.insert("state".into(), json!("failed")),
                        "waiting" => map.insert("state".into(), json!("skipped")),
                        _ => None,
                    };
                }
            }
        }
        let reason = match state {
            "timeout" => "The AI stopped after 10 minutes.".to_string(),
            "cancelled" => "Cancelled.".to_string(),
            _ => error.filter(|e| !e.is_empty()).unwrap_or("It did not run.").to_string(),
        };
        let names: Vec<String> = inner.trial.keys().cloned().collect();
        for name in names {
            let Some(Value::Object(res)) = inner.trial.get(&name).cloned() else { continue };
            if !matches!(res.get("status").and_then(Value::as_str), Some("running" | "waiting")) {
                continue;
            }
            let mut res = res;
            res.insert("status".into(), json!("not_run"));
            res.insert("ok".into(), json!(false));
            res.insert("reason".into(), json!(reason));
            inner.trial.insert(name, Value::Object(res));
        }
    }

    /// Write the state into the scan row (at most twice a second unless `force`).
    pub async fn save(&self, force: bool) -> Result<(), Error> {
        {
            let mut saved = self.saved.lock().unwrap_or_else(|e| e.into_inner());
            let now = Instant::now();
            if !force && saved.is_some_and(|at| now.duration_since(at) < Duration::from_millis(500)) {
                return Ok(());
            }
            *saved = Some(now);
        }
        let (doc, trial, proposal) = {
            let inner = self.lock();
            (pyjson::dumps(&inner.doc), pyjson::dumps(&inner.trial), pyjson::dumps(&inner.proposal))
        };
        let session = kb_db::database::session();
        let Some(row) = ai_repo_scan::Entity::find_by_id(self.scan_id.as_str()).one(&session).await? else {
            return Ok(());
        };
        let mut active = row.into_active_model();
        active.job = Set(doc);
        active.trial = Set(trial);
        active.proposal = Set(proposal);
        active.update(&session).await?;
        session.commit().await?;
        Ok(())
    }
}

/// What `start_job` takes beside the session and the scan.
#[derive(Default, Clone)]
pub struct StartOptions {
    /// `mode`: `"ai"` or `"try"`.
    pub mode: String,
    /// `hint`: what the person says about the repository.
    pub hint: String,
    /// `commands`: the commands as the person has them.
    pub commands: Option<Map<String, Value>>,
    /// `keep`: the commands that are settled (they work, or the person typed them).
    pub keep: Option<Vec<String>>,
    /// `env_path`: extra PATH folders.
    pub env_path: Option<Vec<String>>,
    /// `only`: the checks to run.
    pub only: Option<Vec<String>>,
}

/// `json.loads(text or "{}")` of a column the scan wrote.
pub(crate) fn loads_object(text: &str) -> Value {
    if text.is_empty() {
        return json!({});
    }
    serde_json::from_str(text).unwrap_or_else(|_| json!({}))
}

/// Start the AI (`mode="ai"`: it proposes, then the board runs each command) or the board alone (`"try"`) on a scan.
/// Returns at once; the wizard polls the scan.
pub async fn start_job(session: &Session, scan_id: &str, opts: StartOptions) -> Result<ai_repo_scan::Model, Error> {
    let Some(row) = ai_repo_scan::Entity::find_by_id(scan_id).one(session).await? else {
        return Err(Error::Lookup("Scan not found.".into()));
    };
    if running(scan_id) {
        return Err(Error::JobRunning("The commands are already being set up.".into()));
    }
    let mode = opts.mode.clone();
    if mode == "ai" {
        let status = ai_status(session, true).await?;
        if !status.get("available").is_some_and(pyjson::truthy) {
            let why = status.get("why").map(pyjson::py_str).unwrap_or_default();
            return Err(Error::Value(why));
        }
    }
    let given = opts.commands.unwrap_or_default();
    let commands: Map<String, Value> = COMMANDS
        .iter()
        .map(|n| {
            let text = given.get(*n).filter(|v| pyjson::truthy(v)).map(crate::job::text_of).unwrap_or_default();
            ((*n).to_string(), json!(kb_base::pytext::strip(&text)))
        })
        .collect();
    let env_path: Vec<String> = opts
        .env_path
        .unwrap_or_default()
        .iter()
        .map(|p| kb_base::pytext::strip(p).to_string())
        .filter(|p| !p.is_empty())
        .collect();
    let previous = loads_object(&row.trial);
    let proposal = loads_object(&row.proposal);
    let trial: Map<String, Value> = if mode == "ai" {
        COMMANDS.iter().map(|n| ((*n).to_string(), Value::Null)).collect()
    } else {
        COMMANDS.iter().map(|n| ((*n).to_string(), previous.get(*n).cloned().unwrap_or(Value::Null))).collect()
    };
    let job = Arc::new(Job::new(scan_id, &mode, &opts.hint, trial, proposal));
    let mut active = row.clone().into_active_model();
    active.job = Set(pyjson::dumps(&job.doc()));
    active.update(session).await?;
    session.commit().await?;
    let cancel = Arc::new(Cancel::new());
    let (done_tx, done_rx) = watch::channel(false);
    {
        let mut table = tasks();
        table.insert(scan_id.to_string(), Task { cancel: cancel.clone(), done: done_rx });
        let args = body::Args {
            folder: row.folder.clone(),
            project_id: row.project_id.clone(),
            commands,
            keep: opts.keep.unwrap_or_default(),
            env_path,
            only: opts.only,
            previous,
        };
        kb_base::ctx::spawn(async move {
            body::run_job(job, args, cancel).await;
            let _ = done_tx.send(true);
        });
    }
    let fresh = ai_repo_scan::Entity::find_by_id(scan_id).one(session).await?;
    fresh.ok_or_else(|| Error::Lookup("Scan not found.".into()))
}

/// `str(value)`.
pub(crate) fn text_of(value: &Value) -> String {
    match value {
        Value::String(s) => s.clone(),
        other => pyjson::py_str(other),
    }
}

/// Stop the scan's job: the running command and everything it started is killed, the scratch copy removed.
pub async fn cancel_job(session: &Session, scan_id: &str) -> Result<ai_repo_scan::Model, Error> {
    if ai_repo_scan::Entity::find_by_id(scan_id).one(session).await?.is_none() {
        return Err(Error::Lookup("Scan not found.".into()));
    }
    let task = {
        let table = tasks();
        table.get(scan_id).filter(|t| !*t.done.borrow()).map(|t| (t.cancel.clone(), t.done.clone()))
    };
    if let Some((cancel, mut done)) = task {
        cancel.cancel(crate::cancel::Reason::Cancelled);
        // its own handler saved its state
        let _ = done.wait_for(|d| *d).await;
    }
    let fresh = ai_repo_scan::Entity::find_by_id(scan_id).one(session).await?;
    fresh.ok_or_else(|| Error::Lookup("Scan not found.".into()))
}

/// The calls to the models go through `seams::asker()`.
pub(crate) fn asker() -> Arc<dyn seams::Asker> {
    seams::asker()
}
