//! The move that the Settings wizard runs (design D0 to D4, E1, E2): one at a time, in the background, with its
//! progress readable at any moment, and pause, resume, cancel, an AI's fix, and the switch.
//!
//! The source is always the database the board uses now. What a copy has done is written to `db-move.json` in the
//! data folder as it goes, so a copy the computer's sleep or a restart interrupted is offered again ("Resume from
//! ai_run"). The target's password is kept there encrypted, as in the settings file.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use kb_base::{pyjson, secrets, time};
use kb_db::database;
use kb_db::targets::{self, Target};
use kb_files::uploads;
use serde_json::{Map, Value, json};

use crate::assist::{self, AssistError};
use crate::move_db::{self, Event, Mover, Progress, Stop, TableState, clean_any, described};
use crate::probe;

pub const STATE_FILE: &str = "db-move.json";

static JOB: Mutex<Option<Arc<Job>>> = Mutex::new(None);
static LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// A step that cannot be taken now; `code` and `status` for the API.
#[derive(Debug, Clone, thiserror::Error)]
#[error("{message}")]
pub struct JobError {
    pub code: &'static str,
    pub message: String,
    pub status: u16,
    pub info: Map<String, Value>,
}

impl JobError {
    /// Say what and why (409 unless `status` says otherwise).
    pub fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self { code, message: message.into(), status: 409, info: Map::new() }
    }

    /// The same error with another status.
    pub fn status(mut self, status: u16) -> Self {
        self.status = status;
        self
    }
}

/// What a step of the wizard fails with.
#[derive(Debug, thiserror::Error)]
pub enum Failure {
    /// `JobError`.
    #[error(transparent)]
    Job(#[from] JobError),
    /// `assist.AssistError`: a statement the board will not run.
    #[error(transparent)]
    Assist(#[from] AssistError),
    /// A `MoveError` or a database error of the copy code.
    #[error(transparent)]
    Move(#[from] move_db::Error),
}

/// The attachments that stay in the data folder (they are files, not rows).
fn attachments() -> Value {
    let folder = uploads::get_uploads_dir(false);
    let (mut files, mut size) = (0u64, 0u64);
    let mut todo = vec![folder.clone()];
    while let Some(dir) = todo.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else { continue };
        for entry in entries.flatten() {
            let path = entry.path();
            if entry.file_type().is_ok_and(|kind| kind.is_dir()) {
                todo.push(path);
            } else if let Ok(meta) = std::fs::metadata(&path) {
                if meta.is_file() {
                    files += 1;
                    size += meta.len();
                }
            }
        }
    }
    json!({"folder": folder.to_string_lossy(), "files": files, "size": size})
}

fn state_path() -> PathBuf {
    database::get_data_dir().join(STATE_FILE)
}

/// What a running copy shares with the requests that watch and steer it.
#[derive(Clone)]
struct Handles {
    tables: Arc<Mutex<Vec<TableState>>>,
    paused: Arc<AtomicBool>,
    stop_reason: Arc<Mutex<Option<&'static str>>>,
}

impl Handles {
    fn of(mover: &Mover) -> Self {
        Self { tables: mover.tables_handle(), paused: mover.paused_handle(), stop_reason: mover.stop_reason_handle() }
    }
}

/// What a job knows about itself (everything but the mover).
struct Inner {
    id: String,
    /// new | ready | copying | pausing | paused | stopped | verifying | verified | failed | cancelled | switching |
    /// switched | interrupted
    state: &'static str,
    mode: String,
    plan: Option<Map<String, Value>>,
    report: Option<Map<String, Value>>,
    stop: Option<Stop>,
    verify: Option<Value>,
    error: Option<Value>,
    ai: Value,
    started_at: Option<f64>,
    finished_at: Option<f64>,
    current: Option<String>,
    fingerprint: Option<String>,
    resume_at: Option<String>,
    applied: Vec<String>,
}

/// One move, from the database in use to `target`.
pub struct Job {
    pub source: Target,
    pub target: Target,
    inner: Mutex<Inner>,
    mover: Arc<tokio::sync::Mutex<Option<Mover>>>,
    handles: Mutex<Option<Handles>>,
}

impl Job {
    /// Prepare a move; nothing is opened until `check`.
    pub fn new(target: Target) -> Arc<Job> {
        Arc::new(Job {
            source: database::current_target(),
            target,
            inner: Mutex::new(Inner {
                id: time::uuid4_hex()[..12].to_string(),
                state: "new",
                mode: "copy".into(),
                plan: None,
                report: None,
                stop: None,
                verify: None,
                error: None,
                ai: json!({"state": "idle"}),
                started_at: None,
                finished_at: None,
                current: None,
                fingerprint: None,
                resume_at: None,
                applied: Vec::new(),
            }),
            mover: Arc::new(tokio::sync::Mutex::new(None)),
            handles: Mutex::new(None),
        })
    }

    fn inner<T>(&self, f: impl FnOnce(&mut Inner) -> T) -> T {
        f(&mut self.inner.lock().unwrap_or_else(|e| e.into_inner()))
    }

    fn handles(&self) -> Option<Handles> {
        self.handles.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }

    /// The job's state (new, ready, copying...).
    pub fn state(&self) -> &'static str {
        self.inner(|i| i.state)
    }

    /// Whether the job has a mover (it was checked, or restored after an interruption).
    pub fn has_mover(&self) -> bool {
        self.handles().is_some()
    }

    // -- what the page reads ------------------------------------------------

    /// Per-table progress.
    pub fn tables(&self) -> Vec<TableState> {
        match self.handles() {
            Some(handles) => handles.tables.lock().unwrap_or_else(|e| e.into_inner()).clone(),
            None => Vec::new(),
        }
    }

    /// Everything the wizard shows.
    pub fn as_dict(&self) -> Value {
        let tables = self.tables();
        let rows_total: i64 = tables.iter().map(|t| t.rows).sum();
        let rows_done: i64 = tables.iter().map(|t| if t.state != "done" { t.copied } else { t.rows }).sum();
        let done = tables.iter().filter(|t| t.state == "done").count();
        self.inner(|i| {
            let elapsed = i.started_at.filter(|s| *s != 0.0).map(|started| {
                round_to((i.finished_at.filter(|f| *f != 0.0).unwrap_or_else(time::epoch)) - started, 1)
            });
            let left = match elapsed {
                Some(elapsed) if elapsed != 0.0 && rows_done != 0 && i.state == "copying" && rows_total > rows_done => {
                    Some(round_to(elapsed * (rows_total - rows_done) as f64 / rows_done as f64, 0))
                }
                _ => None,
            };
            json!({
                "id": i.id,
                "state": i.state,
                "mode": i.mode,
                "source": described(&self.source),
                "target": described(&self.target),
                "plan": i.plan,
                "report": i.report,
                "tables": tables.iter().map(|t| json!({
                    "name": t.name,
                    "rows": t.rows,
                    "copied": if t.state == "done" { t.rows } else { t.copied },
                    "state": t.state,
                })).collect::<Vec<_>>(),
                "tables_done": done,
                "tables_total": tables.len(),
                "rows_total": rows_total,
                "rows_done": rows_done,
                "current": i.current,
                "elapsed_s": elapsed,
                "left_s": left,
                "stop": i.stop.as_ref().map(Stop::as_dict),
                "verify": i.verify,
                "error": i.error,
                "ai": i.ai,
                "resume_at": i.resume_at,
                "applied": i.applied,
            })
        })
    }

    /// Remember where the copy is, for a resume after a restart.
    pub fn save(&self) {
        let (id, state, current) = self.inner(|i| (i.id.clone(), i.state, i.current.clone()));
        if matches!(state, "cancelled" | "switched" | "new" | "ready") {
            let _ = std::fs::remove_file(state_path());
            return;
        }
        let done: Vec<&str> = self.tables().iter().filter(|t| t.state == "done").map(|t| t.name).collect();
        let mut data = Map::new();
        data.insert("id".into(), json!(id));
        data.insert("state".into(), json!(state));
        data.insert("target".into(), Value::Object(self.target.public()));
        data.insert("done".into(), json!(done));
        data.insert("stopped_in".into(), json!(current));
        data.insert("saved_at".into(), json!(time::epoch()));
        if let Some(password) = self.target.password.as_deref().filter(|p| !p.is_empty()) {
            match secrets::encrypt(password) {
                Ok(token) => {
                    data.insert("password_enc".into(), json!(token));
                }
                Err(err) => {
                    tracing::warn!(target: "kanban.dbmove", "Could not save the move's progress: {err}");
                    return;
                }
            }
        }
        if let Err(err) = std::fs::write(state_path(), pyjson::Dumps::new().indent(2).dump(&Value::Object(data))) {
            tracing::warn!(target: "kanban.dbmove", "Could not save the move's progress: {err}");
        }
    }

    fn progress(&self, event: &Event) {
        match event {
            Event::Table { table, .. } => self.inner(|i| i.current = Some((*table).to_string())),
            Event::TableDone { .. } => self.save(),
            Event::Rows { .. } => {}
        }
    }

    /// `Mover(self.source, self.target, on_progress=self._progress)`.
    async fn make_mover(self: &Arc<Self>) -> Result<Mover, move_db::Error> {
        let job = Arc::downgrade(self);
        let on_progress: Progress = Arc::new(move |event| {
            let job = job.clone();
            Box::pin(async move {
                if let Some(job) = job.upgrade() {
                    job.progress(&event);
                }
            })
        });
        let mover = Mover::new(self.source.clone(), self.target.clone(), Some(on_progress)).await?;
        *self.handles.lock().unwrap_or_else(|e| e.into_inner()) = Some(Handles::of(&mover));
        Ok(mover)
    }

    // -- steps --------------------------------------------------------------

    /// Step 2: test the target and read what will be copied.
    pub async fn check(self: &Arc<Self>) -> Result<Value, Failure> {
        let report = probe::test(&self.target).await.map_err(move_db::Error::Db)?;
        let dict = report.as_dict();
        self.inner(|i| i.report = Some(dict.clone()));
        if !report.ok() {
            let mut err = JobError::new("target", "The target did not pass the test.").status(422);
            err.info.insert("report".into(), Value::Object(dict));
            return Err(err.into());
        }
        let mut guard = self.mover.clone().lock_owned().await;
        if guard.is_none() {
            *guard = Some(self.make_mover().await?);
        }
        let mover = guard.as_mut().ok_or_else(|| move_db::Error::Other("no mover".into()))?;
        mover.open().await?;
        let plan = mover.plan().await;
        mover.release().await;
        let mut plan = plan?.as_dict();
        plan.insert("attachments".into(), attachments());
        self.inner(|i| {
            i.plan = Some(plan);
            i.state = "ready";
        });
        Ok(self.as_dict())
    }

    /// Run a step in the background, holding the mover until it ends: whoever waits for the mover waits for the step.
    async fn run(self: &Arc<Self>, empty_first: bool, resume: bool, start_at: Option<String>) {
        let mut guard = self.mover.clone().lock_owned().await;
        let job = self.clone();
        tokio::spawn(async move {
            let outcome = job.copy_then_verify(guard.as_mut(), empty_first, resume, start_at).await;
            job.guard(outcome, guard.as_mut()).await;
        });
    }

    /// What `_guard` does with how the step ended.
    async fn guard(&self, outcome: Result<(), move_db::Error>, mover: Option<&mut Mover>) {
        match outcome {
            Ok(()) => {}
            Err(move_db::Error::Stopped(stop)) => {
                tracing::warn!(target: "kanban.dbmove", "The copy stopped at {}: {}", stop.table, stop.error);
                self.inner(|i| {
                    i.state = "stopped";
                    i.resume_at = Some(stop.table.clone());
                    i.stop = Some(*stop);
                });
            }
            Err(move_db::Error::Move(exc)) => {
                let mut error = Map::new();
                error.insert("code".into(), json!(exc.code));
                error.insert("message".into(), json!(exc.message));
                for (key, value) in exc.info {
                    if key != "state" {
                        error.insert(key, value);
                    }
                }
                self.inner(|i| {
                    i.state = "failed";
                    i.error = Some(Value::Object(error));
                });
            }
            // the page shows it
            Err(exc) => {
                tracing::error!(target: "kanban.dbmove", "The move failed: {exc}");
                let (message, code) = clean_any(&exc);
                self.inner(|i| {
                    i.state = "failed";
                    i.error = Some(
                        json!({"code": if code.is_empty() { "error".to_string() } else { code }, "message": message}),
                    );
                });
            }
        }
        let running = self.inner(|i| {
            let running = matches!(i.state, "copying" | "verifying");
            i.finished_at = if running { None } else { Some(time::epoch()) };
            running
        });
        if let Some(mover) = mover {
            if !running {
                mover.release().await;
            }
        }
        self.save();
    }

    /// Step 3: make the tables on the target, then copy (mode "copy") or leave it empty (mode "empty").
    pub async fn start(self: &Arc<Self>, mode: &str, empty_first: bool) -> Result<(), JobError> {
        let state = self.state();
        if !matches!(state, "ready" | "failed") {
            return Err(JobError::new("state", format!("The move is {state}.")));
        }
        self.inner(|i| {
            i.mode = mode.to_string();
            i.started_at = Some(time::epoch());
            i.finished_at = None;
            i.error = None;
            i.state = "copying";
        });
        self.run(empty_first, false, None).await;
        Ok(())
    }

    async fn copy_then_verify(
        &self,
        mover: Option<&mut Mover>,
        empty_first: bool,
        resume: bool,
        start_at: Option<String>,
    ) -> Result<(), move_db::Error> {
        let m = mover.ok_or_else(|| move_db::Error::Other("The move was not checked.".into()))?;
        m.open().await?;
        if resume {
            m.plan().await?; // counts as they are now
        }
        m.prepare_target(empty_first, resume).await?;
        let fingerprint = m.source_fingerprint().await?;
        self.inner(|i| i.fingerprint = Some(fingerprint));
        if self.inner(|i| i.mode == "empty") {
            self.inner(|i| {
                i.state = "verifying";
                i.verify = Some(json!({
                    "ok": true,
                    "empty": true,
                    "checks": [{
                        "key": "schema",
                        "ok": true,
                        "title": "The board's tables were made · no data copied",
                    }],
                }));
                i.state = "verified";
            });
            return Ok(());
        }
        m.paused_handle().store(false, Ordering::SeqCst);
        self.save();
        m.copy(start_at.as_deref(), None).await?;
        if m.is_paused() {
            let cancelled = m.stop_reason() == Some("cancel");
            self.inner(|i| {
                i.state = if cancelled { "cancelled" } else { "paused" };
                i.resume_at = i.current.clone();
            });
            return Ok(());
        }
        self.inner(|i| i.state = "verifying");
        let verify = m.verify(None).await?;
        let ok = verify["ok"] == json!(true);
        self.inner(|i| {
            i.verify = Some(verify);
            i.state = if ok { "verified" } else { "verified_with_differences" };
        });
        Ok(())
    }

    /// Stop at the next batch; the table it was in is copied again on resume.
    pub async fn pause(&self) -> Result<(), JobError> {
        let handles = self.handles();
        let (Some(handles), "copying") = (handles, self.state()) else {
            return Err(JobError::new("state", "Nothing is being copied."));
        };
        self.inner(|i| i.state = "pausing");
        *handles.stop_reason.lock().unwrap_or_else(|e| e.into_inner()) = Some("pause");
        handles.paused.store(true, Ordering::SeqCst);
        // the step in the background holds the mover until it ends
        drop(self.mover.lock().await);
        Ok(())
    }

    /// Go on from the table it stopped in, re-reading that table from its start.
    pub async fn resume(self: &Arc<Self>, start_at: Option<String>) -> Result<(), Failure> {
        let state = self.state();
        if !matches!(state, "paused" | "stopped" | "interrupted" | "verified_with_differences") {
            return Err(JobError::new("state", format!("The move is {state}.")).into());
        }
        {
            let mut guard = self.mover.lock().await;
            if guard.is_none() {
                *guard = Some(self.make_mover().await?);
            }
        }
        let start = self.inner(|i| {
            let start = start_at.filter(|s| !s.is_empty()).or_else(|| i.resume_at.clone());
            i.stop = None;
            i.ai = json!({"state": "idle"});
            i.state = "copying";
            i.started_at = i.started_at.filter(|s| *s != 0.0).or_else(|| Some(time::epoch()));
            i.finished_at = None;
            start
        });
        self.run(false, true, start).await;
        Ok(())
    }

    /// Start over: every table is copied again (`restart` of the resume route).
    pub fn restart(&self) -> Option<String> {
        self.inner(|i| i.resume_at = None);
        let handles = self.handles()?;
        let mut tables = handles.tables.lock().unwrap_or_else(|e| e.into_inner());
        for t in tables.iter_mut() {
            t.state = "waiting";
            t.copied = 0;
        }
        tables.first().map(|t| t.name.to_string())
    }

    /// Stop and clear the new database (the source was only read).
    pub async fn cancel(&self) {
        let handles = self.handles();
        if let (Some(handles), "copying") = (&handles, self.state()) {
            *handles.stop_reason.lock().unwrap_or_else(|e| e.into_inner()) = Some("cancel");
            handles.paused.store(true, Ordering::SeqCst);
        }
        // waits for the step in the background, which holds the mover until it ends
        let mut guard = self.mover.lock().await;
        if let Some(mover) = guard.as_mut() {
            // say it, do not fail the cancel
            if let Err(err) = mover.clear_target().await {
                tracing::error!(target: "kanban.dbmove", "Could not clear the target after a cancel: {err}");
            }
            mover.close().await;
        }
        drop(guard);
        self.inner(|i| i.state = "cancelled");
        self.save();
    }

    /// Ask an AI about the stop, in the background.
    pub async fn ask_ai(self: &Arc<Self>, question: Option<String>) -> Result<(), JobError> {
        let Some(stop) = self.inner(|i| i.stop.clone()) else {
            return Err(JobError::new("state", "The copy has not stopped."));
        };
        let previous = self.inner(|i| if i.ai["state"] == "answered" { i.ai.get("proposal").cloned() } else { None });
        let member = match assist::pick_member().await {
            Ok(member) => member,
            Err(exc) => {
                self.inner(|i| i.ai = json!({"state": "failed", "message": exc.0, "question": question}));
                return Ok(());
            }
        };
        self.inner(|i| {
            i.ai = json!({"state": "asking", "question": question, "previous": previous, "member": member});
        });
        let job = self.clone();
        tokio::spawn(async move {
            let plan = job.inner(|i| i.plan.clone());
            let previous = previous.as_ref().and_then(Value::as_object);
            let answer = assist::ask(&stop, plan.as_ref(), question.as_deref(), previous, Some(member)).await;
            job.inner(|i| {
                i.ai = match answer {
                    Ok(proposal) => json!({"state": "answered", "proposal": proposal, "question": question}),
                    Err(exc) => json!({"state": "failed", "message": exc.0, "question": question}),
                };
            });
        });
        Ok(())
    }

    /// Run the fix on the new database, then resume from the table that stopped (the board re-checks).
    pub async fn apply(self: &Arc<Self>, statements: &[String]) -> Result<(), Failure> {
        if self.inner(|i| i.stop.is_none()) || !self.has_mover() {
            return Err(JobError::new("state", "The copy has not stopped.").into());
        }
        let clean = assist::check_statements(statements)?;
        {
            let mut guard = self.mover.lock().await;
            let Some(mover) = guard.as_mut() else {
                return Err(JobError::new("state", "The copy has not stopped.").into());
            };
            // the server said no
            if let Err(exc) = mover.apply(&clean).await {
                let (message, _) = clean_any(&exc);
                return Err(JobError::new("apply", format!("The database refused it: {message}")).status(422).into());
            }
        }
        self.inner(|i| i.applied.extend(clean));
        self.resume(None).await
    }

    /// Point the board at the target. When the source changed since the copy, the changes are copied first.
    pub async fn switch(&self, force: bool) -> Result<(), JobError> {
        if self.state() != "verified" {
            return Err(JobError::new("state", "Verify the copy before switching."));
        }
        self.inner(|i| i.state = "switching");
        let switched = self.switch_now(force).await;
        let outcome = match switched {
            Ok(()) => {
                self.inner(|i| i.state = "switched");
                Ok(())
            }
            Err(Failure::Job(exc)) => Err(exc),
            Err(exc) => {
                self.inner(|i| i.state = "verified");
                Err(JobError::new("switch", format!("The switch did not happen: {exc}")).status(500))
            }
        };
        self.save();
        outcome
    }

    async fn switch_now(&self, force: bool) -> Result<(), Failure> {
        let mut guard = self.mover.lock().await;
        if self.inner(|i| i.mode == "copy") && !force {
            let mover = guard.as_mut().ok_or_else(|| move_db::Error::Other("The move was not checked.".into()))?;
            mover.open().await?;
            let now = mover.source_fingerprint().await?;
            if Some(&now) != self.inner(|i| i.fingerprint.clone()).as_ref() {
                // the board was used during the copy: copy again, as it is now, and verify
                mover.plan().await?;
                mover.copy(None, None).await?;
                let verify = mover.verify(None).await?;
                let ok = verify["ok"] == json!(true);
                self.inner(|i| i.verify = Some(verify));
                if !ok {
                    self.inner(|i| i.state = "verified_with_differences");
                    return Err(JobError::new("verify", "The latest changes did not copy cleanly.").into());
                }
            }
            mover.release().await;
        }
        if let Some(mover) = guard.as_mut() {
            mover.close().await;
        }
        drop(guard);
        let before = database::place_in_use();
        database::use_target(&self.target).await.map_err(|err| move_db::Error::Other(err.to_string()))?;
        // the board was copied there: the workspace that named it follows
        database::board_moved(&before);
        Ok(())
    }

    async fn close_mover(&self) {
        if let Some(mover) = self.mover.lock().await.as_mut() {
            mover.close().await;
        }
    }
}

/// `round(value, digits)`.
fn round_to(value: f64, digits: i32) -> f64 {
    let scale = 10f64.powi(digits);
    (value * scale).round_ties_even() / scale
}

fn job() -> Option<Arc<Job>> {
    JOB.lock().unwrap_or_else(|e| e.into_inner()).clone()
}

fn set_job(job: Option<Arc<Job>>) {
    *JOB.lock().unwrap_or_else(|e| e.into_inner()) = job;
}

/// The move a state file describes, or `None` when the file cannot be used (a file from an old version).
async fn restore(data: &Value) -> Option<Arc<Job>> {
    let target = targets::from_fields(data.get("target")?.as_object()?).ok()?;
    let password = secrets::decrypt(data.get("password_enc").and_then(Value::as_str));
    let target = target.with_password(password);
    let job = Job::new(target);
    job.inner(|i| {
        if let Some(id) = data.get("id").and_then(Value::as_str) {
            i.id = id.to_string();
        }
        i.state = "interrupted";
    });
    let mover = job.make_mover().await.ok()?;
    let done: Vec<&str> = data
        .get("done")
        .and_then(Value::as_array)
        .map(|d| d.iter().filter_map(Value::as_str).collect())
        .unwrap_or_default();
    let first_left = mover.with_tables(|tables| {
        for t in tables.iter_mut() {
            if done.contains(&t.name) {
                t.state = "done";
            }
        }
        tables.iter().find(|t| !done.contains(&t.name)).map(|t| t.name.to_string())
    });
    let stopped_in = data.get("stopped_in").and_then(Value::as_str).filter(|s| !s.is_empty()).map(str::to_string);
    job.inner(|i| i.resume_at = stopped_in.or(first_left));
    *job.mover.lock().await = Some(mover);
    Some(job)
}

/// The move in progress, or one an interruption left (offered as "Resume").
pub async fn current() -> Option<Arc<Job>> {
    if let Some(job) = job() {
        return Some(job);
    }
    let path = state_path();
    if !path.exists() {
        return None;
    }
    let data = std::fs::read_to_string(&path).ok().and_then(|text| serde_json::from_str::<Value>(&text).ok());
    let restored = match &data {
        Some(data) => restore(data).await,
        None => None,
    };
    match restored {
        Some(restored) => {
            // two requests may both have read the file: the first one's job is the job
            let mut slot = JOB.lock().unwrap_or_else(|e| e.into_inner());
            Some(slot.get_or_insert(restored).clone())
        }
        None => {
            let _ = std::fs::remove_file(&path);
            None
        }
    }
}

/// Start a new move to `target` (step 2), replacing one that has finished.
pub async fn new(target: Target) -> Result<Arc<Job>, JobError> {
    let _lock = LOCK.lock().await;
    let old = current().await;
    if let Some(old) = &old {
        if matches!(old.state(), "copying" | "pausing" | "verifying" | "switching") {
            return Err(JobError::new("busy", "A copy is running. Pause or cancel it first."));
        }
        old.close_mover().await;
    }
    if database::target_source() == "environment" {
        return Err(JobError::new(
            "locked",
            "KANBAN_DATABASE_URL is set, so the database cannot be changed from here.",
        )
        .status(423));
    }
    let job = Job::new(target);
    set_job(Some(job.clone()));
    Ok(job)
}

/// Close a finished move ("Keep SQLite, switch later" keeps nothing running).
pub async fn forget() -> Result<(), JobError> {
    if let Some(job) = job() {
        if matches!(job.state(), "copying" | "pausing" | "verifying" | "switching") {
            return Err(JobError::new("busy", "A copy is running. Pause or cancel it first."));
        }
        job.close_mover().await;
    }
    set_job(None);
    let _ = std::fs::remove_file(state_path());
    Ok(())
}

/// The move the request is about.
pub fn require() -> Result<Arc<Job>, JobError> {
    job().ok_or_else(|| JobError::new("none", "No move is in progress.").status(404))
}
