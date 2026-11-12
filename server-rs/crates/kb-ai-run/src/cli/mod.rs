//! Local runner: find the official CLI, check it is signed in, launch it headless, read its stream, kill it cleanly
//! (`services/ai/cli.py`).
//!
//! The board only starts the CLI exactly as a person would type it. It never reads, copies or stores the CLI's login:
//! the account shown is what `claude auth status` prints (no token is in that output).
//!
//! The Python module is one file; here it is this file (finding the CLI, its environment, short commands, `detect`)
//! and four more in the order of the Python text: `limits` (what the CLI says when it is rate-limited), `process`
//! (stopping and pausing process trees, long arguments), `running` (`CliProcess`) and `tools` (tool calls as step
//! texts). Every
//! name of the Python module is `cli::<name>` here too.

use std::path::Path;
use std::process::Stdio;
use std::sync::{Arc, RwLock};
use std::time::Duration;

use kb_ai::paths;
use kb_ai::profiles::Env;
use kb_base::{pyjson, pypath, pytext};
use serde_json::{Map, Value, json};
use tokio::io::AsyncReadExt;

mod limits;
mod process;
mod running;
mod tools;

pub use limits::*;
pub use process::*;
pub use running::*;
pub use tools::*;

/// The command name of the local runner (AI v2: Claude Code only)
pub const LOCAL_CLIS: [&str; 1] = ["claude"];

const SEARCH_DIRS: [&str; 8] = [
    "~/.local/bin",
    "~/.claude/local",
    "~/.npm-global/bin",
    "~/bin",
    "/usr/local/bin",
    "/opt/homebrew/bin",
    "/usr/bin",
    "~/AppData/Roaming/npm",
];

/// What stands in for `find_cli` (the Python tests replace the function with `monkeypatch`): given the binary and the
/// configured path, `Some((path, checked))` answers the call, `None` lets the real search run.
pub type FindCliHook = Arc<dyn Fn(&str, Option<&str>) -> Option<(Option<String>, Vec<String>)> + Send + Sync>;

static FIND_CLI_HOOK: RwLock<Option<FindCliHook>> = RwLock::new(None);

/// Replace `find_cli` (tests); `None` puts the real search back.
pub fn set_find_cli_hook(hook: Option<FindCliHook>) {
    *FIND_CLI_HOOK.write().unwrap_or_else(|e| e.into_inner()) = hook;
}

/// `os.path.isfile(p) and os.access(p, os.X_OK)`.
fn is_runnable_file(path: &str) -> bool {
    if !Path::new(path).is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        nix::unistd::access(path, nix::unistd::AccessFlags::X_OK).is_ok()
    }
    #[cfg(not(unix))]
    {
        true
    }
}

/// `shutil.which(binary)`.
fn which(binary: &str) -> Option<String> {
    #[cfg(windows)]
    {
        // Windows also tries each extension of PATHEXT (npm installs `claude.cmd`)
        let exts = std::env::var("PATHEXT").unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD".to_string());
        if Path::new(binary).extension().is_none() {
            for ext in exts.split(';').filter(|e| !e.is_empty()) {
                if let Some(found) = kb_ai::profiles::which(&format!("{binary}{ext}")) {
                    return Some(found);
                }
            }
        }
    }
    kb_ai::profiles::which(binary)
}

/// Path of the CLI: the configured one, or, when none is configured, PATH and then the usual install folders.
///
/// A path the person configured is the only one tried: if it is refused or cannot run, there is no CLI (and
/// `missing` says why), never another `claude` found on PATH that would spend the wrong account's quota.
///
/// Returns (path or None, the places that were checked).
pub async fn find_cli(binary: &str, explicit: Option<&str>) -> (Option<String>, Vec<String>) {
    let hook = FIND_CLI_HOOK.read().unwrap_or_else(|e| e.into_inner()).clone();
    if let Some(answer) = hook.and_then(|hook| hook(binary, explicit)) {
        return answer;
    }
    let mut checked: Vec<String> = Vec::new();
    if let Some(explicit) = explicit.filter(|e| !pytext::strip(e).is_empty()) {
        let p = match paths::program(explicit).await {
            Ok(p) => p,
            Err(paths::PathRefused(_)) => {
                checked.push(explicit.to_string());
                return (None, checked);
            }
        };
        checked.push(p.clone());
        if is_runnable_file(&p) {
            return (Some(p), checked);
        }
        return (None, checked);
    }
    checked.push("PATH".to_string());
    if let Some(found) = which(binary) {
        return (Some(found), checked);
    }
    let names: Vec<String> = if cfg!(windows) {
        vec![binary.to_string(), format!("{binary}.cmd"), format!("{binary}.exe")]
    } else {
        vec![binary.to_string()]
    };
    for folder in SEARCH_DIRS {
        // `str(Path(folder).expanduser())`
        let base = pypath::normpath(&pypath::expanduser(folder));
        checked.push(base.clone());
        for name in &names {
            let cand = pypath::join(&base, name);
            if is_runnable_file(&cand) {
                return (Some(cand), checked);
            }
        }
    }
    (None, checked)
}

/// Why there is no CLI, in a sentence: the configured path and what is wrong with it, or just that it was not
/// found (see `find_cli`: a configured path is never replaced by another program).
pub async fn missing(binary: &str, explicit: Option<&str>) -> String {
    let Some(explicit) = explicit.filter(|e| !pytext::strip(e).is_empty()) else {
        return format!("“{binary}” was not found on this computer");
    };
    let why = match paths::program(explicit).await {
        // a fixed sentence, not the exception's text: nothing but our own words goes back to the browser
        Err(paths::PathRefused(_)) => "it is outside your home folder and the usual install folders",
        Ok(p) => {
            if !Path::new(&p).is_file() {
                "it is not a file"
            } else {
                "it cannot be run (not executable)"
            }
        }
    };
    format!(
        "The CLI set for this AI, {}, cannot be used: {why}. \
         The board does not run another {binary} instead. Fix the path in the AI's settings, or clear it to use the \
         one on this computer",
        pytext::strip(explicit)
    )
}

/// Start the CLI in its own process group so cancel can stop it and every child it started (`_popen_kwargs`).
///
/// Python starts a new session (`start_new_session=True`, `setsid`); the standard library of Rust has no stable call
/// for that, so the child gets a process group of its own (`setpgid(0, 0)`), which is all the board uses: the group id
/// is the CLI's pid and every signal goes to the group. The child keeps the board's controlling terminal, if any.
pub fn popen_kwargs(command: &mut tokio::process::Command) {
    #[cfg(unix)]
    {
        command.process_group(0);
    }
    #[cfg(windows)]
    {
        command.creation_flags(CREATE_NEW_PROCESS_GROUP);
    }
}

/// `popen_kwargs` for a command of the standard library (`subprocess.Popen(..., **_popen_kwargs())`).
pub fn popen_kwargs_std(command: &mut std::process::Command) {
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(CREATE_NEW_PROCESS_GROUP);
    }
}

/// `subprocess.CREATE_NEW_PROCESS_GROUP`
#[cfg(windows)]
const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;

/// `taskpolicy -b` on macOS, only when KANBAN_CLI_LOW_PRIORITY=1: the CLI and its children run on the efficiency
/// cores with a lower disk priority. Off by default: five real CLIs took 144 s instead of 106 s with it and the
/// CPU peak did not drop. `taskpolicy` execs the command, so the pid stays the CLI's.
pub fn low_priority_prefix() -> Vec<String> {
    if !cfg!(target_os = "macos") || std::env::var("KANBAN_CLI_LOW_PRIORITY").ok().as_deref() != Some("1") {
        return Vec::new();
    }
    match which("taskpolicy") {
        Some(tool) => vec![tool, "-b".to_string()],
        None => Vec::new(),
    }
}

/// `dict(os.environ)`. Without `KANBAN_PROCESS_TOKEN`, which Python takes out of the environment at startup
/// (`dbkit/targets.py`) so the runner's children (the CLIs and the board's MCP server they start) do not share the
/// runner's token: the API would take their changes for the runner's and not announce them.
pub(crate) fn os_environ() -> Env {
    std::env::vars_os()
        .map(|(k, v)| (k.to_string_lossy().into_owned(), v.to_string_lossy().into_owned()))
        .filter(|(k, _)| k != kb_db::targets::PROCESS_TOKEN_ENV)
        .collect()
}

/// `child_env` over a given environment (`os.environ` in `child_env`).
pub fn child_env_of(base: Env, compact_at_pct: Option<i64>) -> Env {
    let mut env: Env = base
        .into_iter()
        .filter(|(key, _)| !matches!(key.as_str(), "CLAUDECODE" | "CLAUDE_CODE_ENTRYPOINT" | "CLAUDE_CODE_SESSION_ID"))
        .collect();
    // A board tool call may wait for a person's approval (guard.APPROVAL_WAIT_S); keep the CLI from giving up first
    if !env.iter().any(|(key, _)| key == "MCP_TOOL_TIMEOUT") {
        env.push(("MCP_TOOL_TIMEOUT".to_string(), (15 * 60 * 1000).to_string()));
    }
    if let Some(pct) = compact_at_pct.filter(|pct| *pct != 0) {
        match env.iter_mut().find(|(key, _)| key == "CLAUDE_AUTOCOMPACT_PCT_OVERRIDE") {
            Some(slot) => slot.1 = pct.to_string(),
            None => env.push(("CLAUDE_AUTOCOMPACT_PCT_OVERRIDE".to_string(), pct.to_string())),
        }
    }
    env
}

/// Environment for the CLI: the person's own, minus variables that would make it think it runs inside a
/// Claude Code session (when the board itself was started from one). `compact_at_pct` is the share of the context
/// window at which the CLI compacts a long session by itself.
pub fn child_env(compact_at_pct: Option<i64>) -> Env {
    child_env_of(os_environ(), compact_at_pct)
}

/// Whether the CLI still has this conversation on disk (it is gone when the person cleaned ~/.claude).
/// `config_dir` is the folder of an AI account, which keeps its own sessions.
///
/// Python globs `*/<session id>.jsonl`; a session id is a UUID, so the name is looked up as it is in each folder.
pub fn session_exists(session_id: &str, config_dir: Option<&str>, _provider: Option<&str>) -> bool {
    let base = config_dir
        .filter(|d| !d.is_empty())
        .map(str::to_string)
        .or_else(|| std::env::var("CLAUDE_CONFIG_DIR").ok().filter(|d| !d.is_empty()))
        .unwrap_or_else(|| "~/.claude".to_string());
    let root = Path::new(&pypath::expanduser(&base)).join("projects");
    let Ok(entries) = std::fs::read_dir(root) else { return false };
    let name = format!("{session_id}.jsonl");
    entries.flatten().any(|entry| entry.path().join(&name).exists())
}

/// The exit code as Python gives it: the code, or minus the signal that ended the process.
pub(crate) fn returncode_of(status: std::process::ExitStatus) -> i32 {
    #[cfg(unix)]
    {
        use std::os::unix::process::ExitStatusExt;
        status.code().or_else(|| status.signal().map(|s| -s)).unwrap_or(-1)
    }
    #[cfg(not(unix))]
    {
        status.code().unwrap_or(-1)
    }
}

/// Stops the process tree of a short command when the call that waits for it is dropped (a cancelled task): no
/// command outlives the code that asked for it.
struct TreeGuard(Option<i32>);

impl Drop for TreeGuard {
    fn drop(&mut self) {
        if let Some(pid) = self.0.take() {
            kill_tree(Some(pid));
        }
    }
}

async fn read_all<R: tokio::io::AsyncRead + Unpin>(pipe: Option<R>) -> Vec<u8> {
    let mut buf = Vec::new();
    if let Some(mut pipe) = pipe {
        let _ = pipe.read_to_end(&mut buf).await;
    }
    buf
}

/// Run a short command and capture its output; kills it on timeout. `env` replaces the usual environment
/// (an AI account's). An error is the program that could not be started (Python's `OSError`).
pub async fn run_capture(
    args: &[String],
    timeout: f64,
    cwd: Option<&str>,
    env: Option<&Env>,
) -> std::io::Result<(i32, String, String)> {
    let Some((program, rest)) = args.split_first() else {
        return Err(std::io::Error::new(std::io::ErrorKind::InvalidInput, "empty command"));
    };
    let own;
    let env = match env.filter(|e| !e.is_empty()) {
        Some(env) => env,
        None => {
            own = child_env(None);
            &own
        }
    };
    let mut command = tokio::process::Command::new(program);
    command.args(rest).env_clear().envs(env.iter().map(|(k, v)| (k, v)));
    command.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    if let Some(cwd) = cwd {
        command.current_dir(cwd);
    }
    popen_kwargs(&mut command);
    let mut child = command.spawn()?;
    let pid = child.id().and_then(|id| i32::try_from(id).ok());
    let mut guard = TreeGuard(pid);
    let (stdout, stderr) = (child.stdout.take(), child.stderr.take());
    let limit = Duration::try_from_secs_f64(timeout.max(0.0)).unwrap_or(Duration::MAX);
    let communicate = async { tokio::join!(read_all(stdout), read_all(stderr), child.wait()) };
    let done = tokio::time::timeout(limit, communicate).await;
    match done {
        Ok((out, err, status)) => {
            guard.0 = None;
            let code = status.map(returncode_of)?;
            Ok((code, String::from_utf8_lossy(&out).into_owned(), String::from_utf8_lossy(&err).into_owned()))
        }
        Err(_) => {
            kill_tree(pid);
            let _ = child.wait().await;
            guard.0 = None;
            Ok((-1, String::new(), format!("Timed out after {} s", timeout as i64)))
        }
    }
}

/// `text.capitalize()`.
fn capitalize(text: &str) -> String {
    let mut chars = text.chars();
    match chars.next() {
        Some(first) => first.to_uppercase().chain(chars.flat_map(char::to_lowercase)).collect(),
        None => String::new(),
    }
}

/// CLI found? version? signed in (and as whom, without ever touching the token)? `env` is the environment of
/// an AI account, so the answer is about that account's login.
pub async fn detect(
    provider: &str,
    binary: &str,
    explicit: Option<&str>,
    env: Option<&Env>,
) -> std::io::Result<Map<String, Value>> {
    let (path, checked) = find_cli(binary, explicit).await;
    let mut info = Map::new();
    info.insert("found".into(), json!(path.as_deref().is_some_and(|p| !p.is_empty())));
    info.insert("path".into(), json!(path));
    info.insert("checked".into(), json!(checked));
    info.insert("version".into(), Value::Null);
    info.insert("logged_in".into(), Value::Null);
    info.insert("account".into(), Value::Null);
    let Some(path) = path.filter(|p| !p.is_empty()) else { return Ok(info) };
    let (code, out, _) = run_capture(&[path.clone(), "--version".into()], 20.0, None, env).await?;
    if code == 0 {
        let first = pytext::strip(&out).split('\n').next().unwrap_or("");
        info.insert("version".into(), json!(first.chars().take(80).collect::<String>()));
    }
    if provider == "claude-code" {
        let (_, out, _) = run_capture(&[path, "auth".into(), "status".into()], 20.0, None, env).await?;
        // a program that answers `auth status` with something else is not a signed-in CLI
        let status = match serde_json::from_str::<Value>(&out) {
            Ok(Value::Object(map)) => map,
            _ => Map::new(),
        };
        if !status.is_empty() {
            let truthy = |key: &str| status.get(key).filter(|v| pyjson::truthy(v));
            info.insert("logged_in".into(), json!(truthy("loggedIn").is_some()));
            let account = truthy("email").or_else(|| truthy("account")).or_else(|| truthy("orgName"));
            let plan = truthy("subscriptionType").map(pyjson::py_str).unwrap_or_default();
            let plan = pytext::strip(&plan);
            let method = if plan.is_empty() {
                match status.get("authMethod") {
                    Some(Value::String(m)) if m == "oauth_token" => Some(json!("subscription login")),
                    Some(Value::String(m)) if m == "api_key" => Some(json!("API key")),
                    other => other.cloned(),
                }
            } else {
                Some(json!(format!("{} plan", capitalize(plan))))
            };
            let parts: Vec<String> = [account, method.as_ref()]
                .into_iter()
                .flatten()
                .filter(|v| pyjson::truthy(v))
                .map(pyjson::py_str)
                .collect();
            info.insert("account".into(), if parts.is_empty() { Value::Null } else { json!(parts.join(" · ")) });
        }
    }
    Ok(info)
}
