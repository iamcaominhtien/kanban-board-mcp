//! The API's side of the runner process (AI v2, stage 6).
//!
//! With `KANBAN_RUNNER=process` the Claude Code CLIs are started and read by a second process (`runner/main.py`), so
//! the API's event loop never shares its time with a run's stream. The API queues runs (rows) and sends commands
//! (cancel, message, answer, wake) through `ai_run_command`; the runner sends every board event back over
//! `POST /internal/ai/events`. With `inprocess` (the tests, a developer's server) `runs` does it all here.
//!
//! The runner is the current executable started with `--runner`. `KANBAN_RUNNER` and `KANBAN_IN_RUNNER` are read
//! from the environment unless a value was set with `set_mode` / `set_in_runner` (Python assigns `os.environ[...]`
//! at run time; the process environment is never changed here).

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{LazyLock, Mutex, MutexGuard, RwLock};
use std::time::{Duration, Instant};

use base64::Engine;
use kb_base::time;
use kb_db::database;
use kb_db::entities::ai_run_command;
use kb_db::sea_orm::{ActiveModelTrait, ActiveValue::Set, DbErr, EntityTrait};
use serde_json::{Map, Value, json};
use tokio::process::{Child, Command};
use tokio::task::JoinHandle;

/// `secrets.token_urlsafe(n)`: `n` random bytes as URL-safe base64 without padding.
pub fn token_urlsafe(n: usize) -> String {
    let mut bytes = vec![0u8; n];
    if getrandom::fill(&mut bytes).is_err() {
        // the system's random source is gone: fall back to what uuid draws from it as well
        bytes = uuid::Uuid::new_v4().as_bytes().iter().cycle().take(n).copied().collect();
    }
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

/// What the runner shows when it posts events back.
pub static TOKEN: LazyLock<String> = LazyLock::new(|| token_urlsafe(24));
/// How long `command` waits for the runner to take a command, in milliseconds.
static COMMAND_WAIT_MS: AtomicU64 = AtomicU64::new(8000);
/// Restarts within `RESPAWN_WINDOW_S` before the board gives up.
pub const RESPAWN_LIMIT: usize = 5;
/// The window (seconds) in which `RESPAWN_LIMIT` restarts are allowed.
pub const RESPAWN_WINDOW_S: f64 = 600.0;
const WATCH_EVERY: Duration = Duration::from_secs(5);

struct State {
    proc: Option<Child>,
    watch: Option<JoinHandle<()>>,
    board_url: Option<String>,
    starts: Vec<Instant>,
    /// Starts since the board began (`len(_starts)`); `starts` itself only serves the respawn window.
    started: usize,
}

static STATE: Mutex<State> =
    Mutex::new(State { proc: None, watch: None, board_url: None, starts: Vec::new(), started: 0 });
static MODE: RwLock<Option<String>> = RwLock::new(None);
static IN_RUNNER: RwLock<Option<bool>> = RwLock::new(None);

fn state() -> MutexGuard<'static, State> {
    STATE.lock().unwrap_or_else(|e| e.into_inner())
}

/// `COMMAND_WAIT_S` (tests make it short).
pub fn set_command_wait(seconds: f64) {
    COMMAND_WAIT_MS.store((seconds * 1000.0) as u64, Ordering::SeqCst);
}

/// Set `KANBAN_RUNNER` for this process (`None` goes back to the environment's value).
pub fn set_mode(value: Option<&str>) {
    *MODE.write().unwrap_or_else(|e| e.into_inner()) = value.map(str::to_string);
}

/// Set `KANBAN_IN_RUNNER` for this process (`None` goes back to the environment's value).
pub fn set_in_runner(value: Option<bool>) {
    *IN_RUNNER.write().unwrap_or_else(|e| e.into_inner()) = value;
}

/// `process` or `inprocess`.
pub fn mode() -> &'static str {
    let set = MODE.read().unwrap_or_else(|e| e.into_inner()).clone();
    let value = set.or_else(|| std::env::var("KANBAN_RUNNER").ok()).unwrap_or_else(|| "inprocess".to_string());
    if value.to_lowercase() == "process" { "process" } else { "inprocess" }
}

/// Is this process the runner itself?
pub fn in_runner() -> bool {
    match *IN_RUNNER.read().unwrap_or_else(|e| e.into_inner()) {
        Some(on) => on,
        None => std::env::var("KANBAN_IN_RUNNER").is_ok_and(|v| v == "1"),
    }
}

/// The program and arguments that start the runner: this executable with `--runner`.
fn command_line() -> std::io::Result<(std::path::PathBuf, Vec<String>)> {
    Ok((std::env::current_exe()?, vec!["--runner".to_string()]))
}

fn spawn(board_url: Option<&str>) -> std::io::Result<Child> {
    let log_path = database::get_data_dir().join("ai-v2").join("runner.log");
    if let Some(parent) = log_path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let log = std::fs::OpenOptions::new().append(true).create(true).open(&log_path)?;
    let log_err = log.try_clone()?;
    let (program, args) = command_line()?;
    let mut command = Command::new(program);
    command
        .args(args)
        .env("KANBAN_IN_RUNNER", "1")
        .env("KANBAN_BOARD_URL", board_url.unwrap_or(""))
        .env("KANBAN_INTERNAL_TOKEN", TOKEN.as_str())
        .env("KANBAN_PARENT_PID", std::process::id().to_string())
        .env("KANBAN_DB_PATH", database::get_db_path())
        // the same config folder as this process, whatever chose it: the runner must open the same database
        .env("KANBAN_CONFIG_DIR", kb_base::config::config_dir())
        .env_remove("KANBAN_API_SECRET_STDIN")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::from(log))
        .stderr(std::process::Stdio::from(log_err));
    #[cfg(windows)]
    command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    let child = command.spawn()?;
    let mut st = state();
    st.starts.push(Instant::now());
    st.started += 1;
    tracing::info!("AI runner started (pid {})", child.id().unwrap_or(0));
    Ok(child)
}

/// Start the runner (once) when the mode asks for it and the board's URL is known.
pub fn ensure_started(board_url: Option<&str>) -> bool {
    if mode() != "process" || in_runner() {
        return false;
    }
    let url = {
        let mut st = state();
        if let Some(url) = board_url.filter(|u| !u.is_empty()) {
            st.board_url = Some(url.to_string());
        }
        match st.board_url.clone() {
            Some(url) => url,
            None => return false,
        }
    };
    {
        let mut st = state();
        if let Some(child) = st.proc.as_mut() {
            if matches!(child.try_wait(), Ok(None)) {
                return true;
            }
        }
    }
    if tokio::runtime::Handle::try_current().is_err() {
        return false;
    }
    match spawn(Some(&url)) {
        Ok(child) => state().proc = Some(child),
        Err(err) => {
            tracing::error!("The AI runner could not be started: {err}");
            return false;
        }
    }
    let mut st = state();
    if st.watch.as_ref().is_none_or(JoinHandle::is_finished) {
        st.watch = Some(tokio::spawn(watch_loop()));
    }
    true
}

async fn watch_loop() {
    loop {
        tokio::time::sleep(WATCH_EVERY).await;
        let (code, url) = {
            let mut st = state();
            let url = st.board_url.clone();
            let Some(child) = st.proc.as_mut() else { return };
            match child.try_wait() {
                Ok(None) => continue,
                Ok(Some(status)) => (status.code(), url),
                Err(_) => (None, url),
            }
        };
        let recent = state().starts.iter().filter(|t| t.elapsed().as_secs_f64() < RESPAWN_WINDOW_S).count();
        let shown = code.map_or("None".to_string(), |c| c.to_string());
        if recent >= RESPAWN_LIMIT {
            tracing::error!("The AI runner exited (code {shown}) too often; not starting it again");
            state().proc = None;
            return;
        }
        tracing::warn!("The AI runner exited (code {shown}); starting it again");
        match spawn(url.as_deref()) {
            Ok(child) => state().proc = Some(child),
            Err(err) => {
                tracing::error!("The AI runner could not be started again: {err}");
                state().proc = None;
                return;
            }
        }
    }
}

/// The board closes: the runner ends its runs (board_closed) and exits.
pub async fn stop() {
    let (child, watch) = {
        let mut st = state();
        (st.proc.take(), st.watch.take())
    };
    if let Some(watch) = watch {
        watch.abort();
    }
    let Some(mut child) = child else { return };
    if matches!(child.try_wait(), Ok(None)) {
        // SIGTERM first (`Popen.terminate`), then the kill after 15 seconds
        terminate(&child).await;
        if tokio::time::timeout(Duration::from_secs(15), child.wait()).await.is_err() {
            let _ = child.kill().await;
        }
    }
}

/// `Popen.terminate()`: SIGTERM on POSIX (through `kill`, the process API has no safe signal call), the process is
/// stopped by `taskkill` on Windows.
async fn terminate(child: &Child) {
    let Some(pid) = child.id() else { return };
    let mut command = if cfg!(windows) {
        let mut c = Command::new("taskkill");
        c.args(["/PID", &pid.to_string()]);
        c
    } else {
        let mut c = Command::new("kill");
        c.args(["-TERM", &pid.to_string()]);
        c
    };
    let _ = command
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .await;
}

/// Forget the runner, the board's URL and the start count, without touching a process (the Python tests set `_proc` and
/// `_board_url` back to None).
pub fn reset() {
    let mut st = state();
    st.proc = None;
    if let Some(watch) = st.watch.take() {
        watch.abort();
    }
    st.board_url = None;
    st.starts.clear();
    st.started = 0;
}

/// Is the runner this process started still running?
pub fn alive() -> bool {
    let mut st = state();
    st.proc.as_mut().is_some_and(|c| matches!(c.try_wait(), Ok(None)))
}

/// What `GET /ai/runner` shows.
pub fn status() -> Map<String, Value> {
    let pid = state().proc.as_ref().and_then(Child::id);
    let alive = alive();
    let mut out = Map::new();
    out.insert("mode".into(), json!(mode()));
    out.insert("alive".into(), json!(alive));
    out.insert("pid".into(), json!(pid));
    out.insert("starts".into(), json!(state().started));
    out
}

/// Ask the runner to do something with a run; with `wait`, until the runner took it (or the command wait).
pub async fn command(
    run_id: &str,
    command_name: &str,
    payload: Option<&Map<String, Value>>,
    wait: bool,
) -> Result<ai_run_command::Model, DbErr> {
    let session = database::session();
    let mut row = ai_run_command::new();
    row.run_id = Set(run_id.to_string());
    row.command = Set(command_name.to_string());
    row.payload = Set(kb_base::pyjson::dumps(&Value::Object(payload.cloned().unwrap_or_default())));
    row.created_at = Set(time::now_iso());
    let mut row = row.insert(&session).await?;
    session.commit().await?;
    if !wait {
        return Ok(row);
    }
    let deadline = Instant::now() + Duration::from_millis(COMMAND_WAIT_MS.load(Ordering::SeqCst));
    while Instant::now() < deadline {
        tokio::time::sleep(Duration::from_millis(200)).await;
        let session = database::session();
        if let Some(found) = ai_run_command::Entity::find_by_id(row.id).one(&session).await? {
            row = found;
            if row.taken_at.as_ref().is_some_and(|t| !t.is_empty()) {
                return Ok(row);
            }
        }
    }
    Ok(row)
}
