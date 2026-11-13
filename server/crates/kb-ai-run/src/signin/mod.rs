//! The sign-in terminal of an AI account (design/screens/ai-accounts.md, C2 to C4) (`services/ai/signin.py`).
//!
//! A person signs in by running the CLI's own login in a real pseudo-terminal that the app shows. This module starts
//! that process, keeps its latest output so a window can attach again, and every few seconds asks the CLI whether the
//! account is signed in (it never reads the login). The terminal output is kept in memory only: not logged, not stored.
//!
//! Only a person can open it: the routes that use this module are the account routes of the UI, and no MCP tool or AI
//! runner calls it.
//!
//! The pseudo-terminal is opened with the `portable-pty` crate, which has one on macOS, Linux and Windows (ConPTY).
//! The Python module has one on macOS and Linux only (the `pty` module); on Windows the login opens in a console
//! window of its own (`CONSOLE`), with the account's folder in its environment, and the app asks the CLI who is signed
//! in as before; the command to run by hand is offered too, should no window appear. This port keeps that choice:
//! `pty_available()` is true on Unix, so Windows takes the console path as before, and `set_pty(Some(true))` is all
//! it takes to use the terminal there. Anywhere without a pseudo-terminal or a console `start` gives `PtyUnavailable`
//! and the window offers the command instead (`fallback_command`).
//!
//! Processes and threads of one sign-in. The login is the leader of its own session (`portable-pty` calls `setsid` and
//! makes the terminal its controlling one), so `cli::kill_tree` stops it and what it started. Three threads serve it:
//! one waits for its exit (which reaps it, whoever stops watching), one reads the terminal, one writes what the person
//! types. All three end when the login ends; `stop` and `stop_all` end the login.
//!
//! `screen` holds what is plain text (the status bar's reading of the terminal, the command to run by hand), `session`
//! one open sign-in and the list of them; starting, watching and stopping are here. Every name of the Python module is
//! `signin::<name>`.

use std::io::{Read, Write};
use std::path::Path;
use std::sync::{Arc, LazyLock, RwLock};
use std::time::Duration;

use kb_ai::profiles::Env;
use kb_db::database;
use kb_db::entities::ai_account;
use kb_db::sea_orm::EntityTrait;
use portable_pty::{CommandBuilder, PtySize, native_pty_system};
use serde_json::json;
use tokio::sync::watch;

use crate::accounts::{self, AccountError};
use crate::cli;

mod screen;
mod session;

pub use screen::{Screen, fallback_text, powershell, read_screen, shlex_quote};
use session::sessions;
pub use session::{Queue, SignIn, active, session, signing_in_by};

/// Windows: no pseudo-terminal in the Python server, but a program can open a console window of its own
pub const CONSOLE: bool = cfg!(windows);

/// what a window that attaches late replays
pub const KEEP_BYTES: usize = 64 * 1024;
/// how often the CLI is asked who is signed in
pub const POLL_S: f64 = 3.0;
/// a sign-in with no window attached this long is stopped (the tab was closed)
pub const ORPHAN_S: f64 = 90.0;
/// no sign-in outlives this
pub const MAX_S: f64 = 30.0 * 60.0;
/// The waits of a sign-in, in seconds (the constants of the module; tests shorten them).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Timing {
    /// `POLL_S`.
    pub poll_s: f64,
    /// `ORPHAN_S`.
    pub orphan_s: f64,
    /// `MAX_S`.
    pub max_s: f64,
}

impl Default for Timing {
    fn default() -> Self {
        Self { poll_s: POLL_S, orphan_s: ORPHAN_S, max_s: MAX_S }
    }
}

/// What starts the login in a console window (`_open_console`): the command, its folder and its environment.
pub type OpenConsole = Arc<dyn Fn(&[String], &Path, &Env) -> std::io::Result<std::process::Child> + Send + Sync>;

/// What tests replace in this module (Python's `monkeypatch.setattr(signin, ...)`).
#[derive(Default, Clone)]
struct Overrides {
    timing: Option<Timing>,
    pty: Option<bool>,
    console: Option<bool>,
    open_console: Option<OpenConsole>,
}

static OVERRIDES: LazyLock<RwLock<Overrides>> = LazyLock::new(RwLock::default);

fn overrides() -> Overrides {
    OVERRIDES.read().unwrap_or_else(|e| e.into_inner()).clone()
}

fn timing() -> Timing {
    overrides().timing.unwrap_or_default()
}

/// Change the waits (`POLL_S`, `ORPHAN_S`, `MAX_S`); None puts the module's constants back.
pub fn set_timing(timing: Option<Timing>) {
    OVERRIDES.write().unwrap_or_else(|e| e.into_inner()).timing = timing;
}

/// Say whether this computer has a pseudo-terminal (`signin.pty = None` in the Python tests); None: the platform's.
pub fn set_pty(available: Option<bool>) {
    OVERRIDES.write().unwrap_or_else(|e| e.into_inner()).pty = available;
}

/// Say whether a console window can be opened (`signin.CONSOLE`); None: the platform's.
pub fn set_console(available: Option<bool>) {
    OVERRIDES.write().unwrap_or_else(|e| e.into_inner()).console = available;
}

/// Replace what opens the console window (`signin._open_console`); None: the real one.
pub fn set_open_console(open: Option<OpenConsole>) {
    OVERRIDES.write().unwrap_or_else(|e| e.into_inner()).open_console = open;
}

/// Whether the sign-in runs in a terminal the app shows (`signin.pty is not None`).
pub fn pty_available() -> bool {
    overrides().pty.unwrap_or(cfg!(unix))
}

/// Whether the sign-in opens in a console window of its own (`signin.pty is None and signin.CONSOLE`).
pub fn console_available() -> bool {
    !pty_available() && overrides().console.unwrap_or(CONSOLE)
}

/// No pseudo-terminal on this platform (or it could not be opened).
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{0}")]
pub struct PtyUnavailable(pub String);

/// A sign-in of this account is already open.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{by} is signing in to this account")]
pub struct SignInBusy {
    /// Who started it.
    pub by: String,
}

/// What `start` fails with.
#[derive(Debug, thiserror::Error)]
pub enum Error {
    /// Another sign-in of this account is open.
    #[error("{0}")]
    Busy(#[from] SignInBusy),
    /// This platform has no pseudo-terminal.
    #[error("{0}")]
    Pty(#[from] PtyUnavailable),
    /// The CLI is not installed.
    #[error("{0}")]
    Account(#[from] AccountError),
    /// Anything Python lets through as a 500.
    #[error("{0}")]
    Other(String),
}

impl From<accounts::Error> for Error {
    fn from(e: accounts::Error) -> Self {
        match e {
            accounts::Error::Account(e) => Error::Account(e),
            other => Error::Other(other.to_string()),
        }
    }
}

/// The command that signs this account in from the person's own terminal, with the account's folder in the
/// environment so the login lands in this account and not in the one already on this computer.
pub async fn fallback_command(account: &ai_account::Model) -> Result<String, Error> {
    let profile = accounts::profile_of(account).await?;
    let argv = profile.login_argv(&[]).map_err(|e| Error::Other(e.to_string()))?;
    Ok(fallback_text(&argv, &profile.env(), profile.login_cwd().as_deref(), cfg!(windows)))
}

fn size(cols: u16, rows: u16) -> PtySize {
    PtySize { rows, cols, pixel_width: 0, pixel_height: 0 }
}

/// `exc.strerror or exc` of what `portable-pty` or the system said.
fn why(text: String) -> String {
    match text.rfind(" (os error ") {
        Some(at) => text[..at].to_string(),
        None => text,
    }
}

/// Wait for a process this module started, on a thread of its own, and give its exit code to whoever asks.
fn watch_exit(wait: impl FnOnce() -> i32 + Send + 'static) -> std::io::Result<watch::Receiver<Option<i32>>> {
    let (tx, rx) = watch::channel(None);
    std::thread::Builder::new().name("signin-wait".into()).spawn(move || {
        let code = wait();
        let _ = tx.send(Some(code));
    })?;
    Ok(rx)
}

/// The exit code of a process started in the terminal, as Python's `Popen.wait` gives it.
#[cfg(unix)]
fn wait_pid(pid: i32) -> i32 {
    use nix::sys::wait::{WaitStatus, waitpid};
    loop {
        match waitpid(nix::unistd::Pid::from_raw(pid), None) {
            Ok(WaitStatus::Exited(_, code)) => return code,
            Ok(WaitStatus::Signaled(_, signal, _)) => return -(signal as i32),
            Ok(_) | Err(nix::errno::Errno::EINTR) => {}
            Err(_) => return -1,
        }
    }
}

/// Open the CLI's login in a pseudo-terminal in the account's folder and start watching for the result.
///
/// Errors: `Busy` (another sign-in of this account is open), `Pty` (this platform has no pseudo-terminal),
/// `Account` (the CLI is not installed).
pub async fn start(account: &ai_account::Model, by: &str, cols: u16, rows: u16) -> Result<Arc<SignIn>, Error> {
    if let Some(open_one) = active(&account.id) {
        return Err(SignInBusy { by: open_one.by.clone() }.into());
    }
    if !pty_available() {
        if console_available() {
            return start_console(account, by).await;
        }
        return Err(PtyUnavailable("No pseudo-terminal on this platform".into()).into());
    }
    let profile = accounts::profile_of(account).await?;
    if profile.base().binary.as_deref().is_none_or(str::is_empty) {
        return Err(AccountError::new("The CLI was not found on this computer.", "cli_missing").into());
    }
    profile.prepare().map_err(|e| Error::Other(e.to_string()))?;
    let argv = profile.login_argv(&[]).map_err(|e| Error::Other(e.to_string()))?;
    let mut env = profile.overlay(&cli::child_env(None));
    for (key, value) in
        [("TERM", "xterm-256color".to_string()), ("COLUMNS", cols.to_string()), ("LINES", rows.to_string())]
    {
        match env.iter_mut().find(|(k, _)| k == key) {
            Some(slot) => slot.1 = value,
            None => env.push((key.to_string(), value)),
        }
    }
    let cwd = profile.login_cwd().unwrap_or_else(|| profile.dir().to_path_buf());
    let pair = native_pty_system().openpty(size(cols, rows)).map_err(|e| PtyUnavailable(e.to_string()))?;
    let Some((program, rest)) = argv.split_first() else {
        return Err(Error::Other("empty login command".into()));
    };
    let mut command = CommandBuilder::new(program);
    command.args(rest);
    command.cwd(&cwd);
    command.env_clear();
    for (key, value) in &env {
        command.env(key, value);
    }
    let could_not_run = |e: String| PtyUnavailable(format!("Could not run the CLI ({})", why(e)));
    // the child becomes the leader of a new session with this terminal as its controlling one
    let (slave, master) = (pair.slave, pair.master);
    let spawned = tokio::task::spawn_blocking(move || slave.spawn_command(command)).await;
    #[cfg_attr(unix, allow(unused_mut))]
    let mut child = match spawned {
        Ok(Ok(child)) => child,
        Ok(Err(e)) => return Err(could_not_run(e.root_cause().to_string()).into()),
        Err(e) => return Err(could_not_run(e.to_string()).into()),
    };
    let pid = child.process_id().and_then(|id| i32::try_from(id).ok());
    // from here the login runs: whatever fails below must not leave it behind
    let stop_login = |why: String| {
        cli::kill_tree(pid);
        Error::Pty(PtyUnavailable(why))
    };
    #[cfg(unix)]
    let exit = {
        drop(child); // only its pid is needed: the exit is collected with `waitpid`, which gives the signal too
        let pid = pid.unwrap_or(0);
        watch_exit(move || wait_pid(pid))
    };
    #[cfg(not(unix))]
    let exit = watch_exit(move || child.wait().map(|status| status.exit_code() as i32).unwrap_or(-1));
    let exit = exit.map_err(|e| stop_login(e.to_string()))?;
    let reader = master.try_clone_reader().map_err(|e| stop_login(e.to_string()))?;
    let writer = master.take_writer().map_err(|e| stop_login(e.to_string()))?;
    let session = SignIn::with(&account.id, by, argv, account.status == "signed_in", false);
    let (input, typed) = std::sync::mpsc::channel::<Vec<u8>>();
    {
        let mut state = session.lock();
        state.master = Some(master);
        state.input = Some(input);
        state.pid = pid;
        state.exit = Some(exit);
    }
    sessions().insert(account.id.clone(), session.clone());
    let runtime = tokio::runtime::Handle::current();
    let threads = spawn_reader(session.clone(), reader, runtime).and_then(|()| spawn_writer(writer, typed));
    if let Err(e) = threads {
        stop(&session, "cancelled").await;
        return Err(PtyUnavailable(e.to_string()).into());
    }
    let poller = tokio::spawn(poll(session.clone()));
    session.lock().poller = Some(poller);
    Ok(session)
}

/// The thread that reads the terminal (Python: `loop.add_reader(master, _on_output, session)`).
fn spawn_reader(
    session: Arc<SignIn>,
    mut reader: Box<dyn Read + Send>,
    runtime: tokio::runtime::Handle,
) -> std::io::Result<()> {
    std::thread::Builder::new().name("signin-read".into()).spawn(move || {
        let mut chunk = [0u8; 4096];
        loop {
            let n = match reader.read(&mut chunk) {
                Ok(n) => n,
                Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(_) => 0,
            };
            if n == 0 || !on_output(&session, &chunk[..n]) {
                break;
            }
        }
        // the process closed its end (after `stop` nobody listens any more)
        if session.lock().master.is_some() {
            let exiter = runtime.spawn(exited(session.clone()));
            session.lock().exiter = Some(exiter);
        }
    })?;
    Ok(())
}

/// The thread that writes what the person typed, so a terminal that does not read never holds the caller.
fn spawn_writer(mut writer: Box<dyn Write + Send>, typed: std::sync::mpsc::Receiver<Vec<u8>>) -> std::io::Result<()> {
    std::thread::Builder::new().name("signin-write".into()).spawn(move || {
        while let Ok(data) = typed.recv() {
            if writer.write_all(&data).and_then(|()| writer.flush()).is_err() {
                break;
            }
        }
    })?;
    Ok(())
}

/// Start the login in a console window of its own (Windows), so the person answers it there.
fn open_console(argv: &[String], cwd: &Path, env: &Env) -> std::io::Result<std::process::Child> {
    let Some((program, rest)) = argv.split_first() else {
        return Err(std::io::Error::new(std::io::ErrorKind::InvalidInput, "empty command"));
    };
    let mut command = std::process::Command::new(program);
    command.args(rest).current_dir(cwd).env_clear().envs(env.iter().map(|(k, v)| (k, v)));
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        /// `subprocess.CREATE_NEW_CONSOLE`
        const CREATE_NEW_CONSOLE: u32 = 0x0000_0010;
        command.creation_flags(CREATE_NEW_CONSOLE);
    }
    command.spawn()
}

/// The sign-in where there is no pseudo-terminal but a console window can be opened (Windows).
///
/// Errors: `Account` (the CLI is not installed), `Pty` (the window could not be opened: the person then runs the
/// command themselves).
async fn start_console(account: &ai_account::Model, by: &str) -> Result<Arc<SignIn>, Error> {
    let profile = accounts::profile_of(account).await?;
    if profile.base().binary.as_deref().is_none_or(str::is_empty) {
        return Err(AccountError::new("The CLI was not found on this computer.", "cli_missing").into());
    }
    profile.prepare().map_err(|e| Error::Other(e.to_string()))?;
    let argv = profile.login_argv(&[]).map_err(|e| Error::Other(e.to_string()))?;
    let env = profile.overlay(&cli::child_env(None));
    let cwd = profile.login_cwd().unwrap_or_else(|| profile.dir().to_path_buf());
    let opened = match overrides().open_console {
        Some(open) => open(&argv, &cwd, &env),
        None => open_console(&argv, &cwd, &env),
    };
    let could_not_open =
        |e: &std::io::Error| PtyUnavailable(format!("Could not open a window for the CLI ({})", why(e.to_string())));
    let mut proc = opened.map_err(|e| could_not_open(&e))?;
    let pid = i32::try_from(proc.id()).ok();
    let exit = watch_exit(move || proc.wait().map(cli::returncode_of).unwrap_or(-1)).map_err(|e| {
        cli::kill_tree(pid);
        could_not_open(&e)
    })?;
    let session = SignIn::with(&account.id, by, argv, account.status == "signed_in", true);
    {
        let mut state = session.lock();
        state.pid = pid;
        state.exit = Some(exit);
    }
    sessions().insert(account.id.clone(), session.clone());
    let poller = tokio::spawn(poll(session.clone()));
    let exiter = tokio::spawn(exited(session.clone()));
    let mut state = session.lock();
    state.poller = Some(poller);
    state.exiter = Some(exiter);
    drop(state);
    Ok(session)
}

/// What the terminal printed (`_on_output`); false once nobody listens any more.
fn on_output(session: &SignIn, data: &[u8]) -> bool {
    let text = {
        let mut state = session.lock();
        if state.master.is_none() {
            return false;
        }
        state.buffer.extend_from_slice(data);
        let extra = state.buffer.len().saturating_sub(KEEP_BYTES);
        state.buffer.drain(..extra);
        state.decoder.decode(data)
    };
    session.publish(&json!({"type": "out", "data": text}));
    session.publish(&session.state());
    true
}

async fn exited(session: Arc<SignIn>) {
    let exit = session.lock().exit.clone();
    let code = match exit {
        Some(mut exit) => match exit.wait_for(Option::is_some).await {
            Ok(code) => (*code).unwrap_or(-1),
            Err(_) => -1,
        },
        None => -1,
    };
    {
        let mut state = session.lock();
        if state.ended.is_none() {
            state.ended = Some("exited".to_string());
        }
        state.exit_code = Some(code);
    }
    close_fd(&session);
    session.publish(&session.state());
    let _ = check(&session).await; // a CLI that finished may have just signed in
}

fn close_fd(session: &SignIn) {
    let mut state = session.lock();
    state.master = None;
    state.input = None;
}

/// Ask the CLI who is signed in; the account row is updated only from its answer (`_check`).
pub async fn check(session: &Arc<SignIn>) -> Result<(), accounts::Error> {
    let db = database::session();
    let Some(account) = ai_account::Entity::find_by_id(&session.account_id).one(&db).await? else { return Ok(()) };
    let account = accounts::check(&db, account, "check").await?;
    let signed_in = {
        let state = session.lock();
        account.status == "signed_in"
            && (!session.was_signed_in
                || (state.ended.as_deref() == Some("exited") && state.exit_code == Some(0))
                || state.ended.as_deref() == Some("done"))
    };
    let mut duplicate_of = None;
    if let Some(email) = account.email.as_deref().filter(|e| signed_in && !e.is_empty()) {
        for other in accounts::list_all(&db).await? {
            let same = other
                .email
                .as_deref()
                .filter(|e| !e.is_empty())
                .is_some_and(|e| e.to_lowercase() == email.to_lowercase());
            if other.id != account.id && other.cli == account.cli && same {
                duplicate_of = Some(other.name);
                break;
            }
        }
    }
    let users = accounts::counts(&db, None).await?;
    let shown = accounts::to_dict(&account, users.get(&account.id), None)?;
    drop(db);
    {
        let mut state = session.lock();
        state.signed_in = signed_in;
        state.duplicate_of = duplicate_of;
        state.account = Some(shown);
    }
    session.publish(&session.state());
    Ok(())
}

async fn poll(session: Arc<SignIn>) {
    while session.ended().is_none() {
        tokio::time::sleep(Duration::from_secs_f64(timing().poll_s.max(0.0))).await;
        let current = self::session(&session.account_id);
        if !current.is_some_and(|s| Arc::ptr_eq(&s, &session)) || session.ended().is_some() {
            return;
        }
        if kb_base::time::epoch() - session.started > timing().max_s {
            // this task ends here: `stop` must not cancel it half-way
            session.lock().poller = None;
            stop(&session, "cancelled").await;
            return;
        }
        let _ = check(&session).await;
    }
}

/// A queue of messages for one window; it starts with the output so far and the current state.
pub fn attach(session: &Arc<SignIn>) -> Arc<Queue> {
    let q = Arc::new(Queue::default());
    let so_far = {
        let state = session.lock();
        (!state.buffer.is_empty()).then(|| String::from_utf8_lossy(&state.buffer).into_owned())
    };
    if let Some(data) = so_far {
        q.put(json!({"type": "out", "data": data}));
    }
    q.put(session.state());
    let mut state = session.lock();
    state.watchers.push(q.clone());
    if let Some(orphan) = state.orphan.take() {
        orphan.abort();
    }
    q
}

/// A window went away; the sign-in goes on for a little (a reload attaches again). With no window for ORPHAN_S
/// seconds the CLI is stopped, so a closed tab never leaves one running.
pub fn detach(session: &Arc<SignIn>, q: &Arc<Queue>) {
    let mut state = session.lock();
    state.watchers.retain(|w| !Arc::ptr_eq(w, q));
    if !state.watchers.is_empty() || state.ended.is_some() {
        return;
    }
    let Ok(runtime) = tokio::runtime::Handle::try_current() else { return };
    let waiting = session.clone();
    let orphan = runtime.spawn(async move {
        tokio::time::sleep(Duration::from_secs_f64(timing().orphan_s.max(0.0))).await;
        stop_if_orphaned(waiting).await;
    });
    if let Some(earlier) = state.orphan.replace(orphan) {
        earlier.abort();
    }
}

async fn stop_if_orphaned(session: Arc<SignIn>) {
    let orphaned = {
        let mut state = session.lock();
        let orphaned = state.watchers.is_empty() && state.ended.is_none();
        if orphaned {
            // this timer has fired: `stop` has nothing to cancel
            state.orphan = None;
        }
        orphaned
    };
    if orphaned {
        stop(&session, "cancelled").await;
    }
}

/// What the person typed or pasted.
pub fn write(session: &SignIn, data: &str) {
    let state = session.lock();
    if state.ended.is_none() && state.master.is_some() {
        if let Some(input) = &state.input {
            let _ = input.send(data.as_bytes().to_vec());
        }
    }
}

/// The window changed size.
pub fn resize(session: &SignIn, cols: i64, rows: i64) {
    if !((10..=500).contains(&cols) && (4..=200).contains(&rows)) {
        return;
    }
    let state = session.lock();
    if let (Some(master), Ok(cols), Ok(rows)) = (&state.master, u16::try_from(cols), u16::try_from(rows)) {
        let _ = master.resize(size(cols, rows));
    }
}

/// Close the terminal and stop the CLI (and anything it started). `how`: cancelled | done.
pub async fn stop(session: &Arc<SignIn>, how: &str) {
    let (pid, running) = {
        let mut state = session.lock();
        if state.ended.is_none() || state.ended.as_deref() == Some("exited") {
            state.ended = Some(how.to_string());
        }
        (state.pid, state.exit.as_ref().is_some_and(|exit| exit.borrow().is_none()))
    };
    if running {
        cli::kill_tree(pid);
    }
    close_fd(session);
    {
        let mut state = session.lock();
        if let Some(orphan) = state.orphan.take() {
            orphan.abort();
        }
        if let Some(poller) = state.poller.take() {
            poller.abort();
        }
    }
    if how == "done" {
        // the row follows what the CLI says after the last question
        let _ = check(session).await;
    }
    session.publish(&session.state());
    let mut sessions = sessions();
    if sessions.get(&session.account_id).is_some_and(|s| Arc::ptr_eq(s, session)) {
        sessions.remove(&session.account_id);
    }
}

/// The board is closing: no CLI outlives it.
pub async fn stop_all() {
    let open: Vec<Arc<SignIn>> = sessions().values().cloned().collect();
    for s in open {
        stop(&s, "cancelled").await;
    }
}
