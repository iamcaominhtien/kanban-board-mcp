//! Step 3, **try** (`repo_scan.py` lines 441-655: `COMMANDS`, `CHECKS`, `_WRONG`, `classify`, `_why_wrong`, `_Scratch`,
//! `_run_one`, `try_commands`, `_try`): the prepare and test commands run once in a scratch worktree; a command that
//! fails is shown failing.
//!
//! A command found in a repository is run through the shell as Python's `asyncio.create_subprocess_shell` does it
//! (`/bin/sh -c`; `cmd /C` on Windows), in a folder of its own with the project's environment, its output (standard
//! output and error in one stream) read line by line, in a process group of its own. A command that outlives its
//! timeout, or a job that is cancelled, kills that group (`cli::kill_tree`) and waits for the shell: no child is left.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::LazyLock;
use std::time::{Duration, Instant};

use kb_ai_run::cli;
use kb_ai_work::proc::{self, Spec};
use kb_ai_work::project_env;
use kb_base::pytext;
use regex::Regex;
use serde_json::{Map, Value, json};
use tokio::process::Command;

use crate::Error;
use crate::cancel::Cancel;
use crate::detect::TRIAL_TIMEOUT_S;

/// `COMMANDS`: the four commands of a project, in the order they are shown.
pub const COMMANDS: [&str; 4] = ["prepare", "test", "lint", "build"];
/// `CHECKS`: the commands that are checks (prepare is not).
pub const CHECKS: [&str; 3] = ["test", "lint", "build"];

/// `_WRONG`: the shell could not run the command at all: a program that is not there, a script that does not exist,
/// bad arguments. Anything else that exits non-zero ran, and the project failed (the two kinds of red, design D4).
static WRONG: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(concat!(
        r"(?im)",
        r"command not found|: not found|Missing script|is not recognized as an internal|Unknown command|",
        r"no such command|unrecognized subcommand|Failed to spawn|Couldn't find a script|Unknown script|",
        r"No such file or directory: '?[\w./-]*'?$|error: unknown option|",
        // the package manager found no package.json where it ran (npm exits 254): the command is not for this folder.
        // Only the package manager's own lines: a test that reads a package.json fixture and fails ran, the project fails
        r"^npm (?:ERR!|error) (?:enoent|path)\b[^\n]*package\.json|",
        r"^(?:error )?Couldn't find a package\.json file|ERR_PNPM_NO_IMPORTER_MANIFEST_FOUND|",
        r"No package\.json \(or package\.yaml, or package\.json5\) was found|",
        // the program's own input is not there (RC-2): the script given to python or the shell, the Makefile or its
        // target, the test path given to pytest
        r"can't open file '[^']*': \[Errno 2\]|^(?:ba|z|da)?sh: [^:\n]+: No such file or directory$|",
        r"No rule to make target '[^']*'\.\s+Stop|No targets specified and no makefile found|",
        r"ERROR: file or directory not found:"
    ))
    .expect("a fixed pattern")
});

/// works | wrong | fails | timeout: the server decides from the exit code and the output, never the AI.
pub fn classify(exit_code: Option<i32>, output: &str, timed_out: bool) -> &'static str {
    if timed_out {
        return "timeout";
    }
    if exit_code == Some(0) {
        return "works";
    }
    if matches!(exit_code, Some(126 | 127)) || WRONG.is_match(output) {
        return "wrong";
    }
    "fails"
}

/// Why a command is "wrong": the line of the output that says so, or that the shell could not run it.
pub fn why_wrong(output: &str, exit_code: Option<i32>) -> String {
    if let Some(m) = WRONG.find(output) {
        let line = pytext::splitlines(output).into_iter().find(|ln| ln.contains(m.as_str())).unwrap_or(m.as_str());
        return pytext::strip(line).chars().take(200).collect();
    }
    let code = exit_code.map_or_else(|| "None".to_string(), |c| c.to_string());
    format!("The shell could not run it (exit {code}).")
}

/// `NotFoundError` and the like as Python prints the `OSError`.
fn os_error(err: &std::io::Error, what: &str) -> Error {
    let text = match err.kind() {
        std::io::ErrorKind::NotFound => format!("[Errno 2] No such file or directory: {}", pytext::repr(what)),
        std::io::ErrorKind::PermissionDenied => format!("[Errno 13] Permission denied: {}", pytext::repr(what)),
        _ => match err.raw_os_error() {
            Some(code) => format!("[Errno {code}] {err}: {}", pytext::repr(what)),
            None => err.to_string(),
        },
    };
    Error::Other(text)
}

/// A scratch worktree of the repository's HEAD (or a copy when it is not a git repository), removed afterwards.
pub struct Scratch {
    root: PathBuf,
    tmp: PathBuf,
    work: PathBuf,
    made_worktree: bool,
}

impl Scratch {
    /// `_Scratch(folder)`: makes the temporary folder (`tempfile.mkdtemp(prefix="kanban-trial-")`).
    pub fn new(folder: &str) -> Result<Scratch, Error> {
        let tmp = tempfile::Builder::new()
            .prefix("kanban-trial-")
            .tempdir()
            .map_err(|e| os_error(&e, "kanban-trial-"))?
            .keep();
        let work = tmp.join("wt");
        Ok(Scratch { root: PathBuf::from(folder), tmp, work, made_worktree: false })
    }

    /// `__enter__`: the worktree (a copy when git cannot make one); returns its folder.
    pub async fn enter(&mut self) -> Result<PathBuf, Error> {
        let root = self.root.to_string_lossy().into_owned();
        if self.root.join(".git").exists() {
            let argv: Vec<String> = ["git", "worktree", "add", "--detach", &self.work.to_string_lossy(), "HEAD"]
                .map(str::to_string)
                .to_vec();
            let res = proc::run(&argv, &Spec { cwd: Some(&root), ..Spec::default() }, 60.0)
                .await
                .map_err(|e| Error::Other(e.to_string()))?;
            self.made_worktree = res.returncode == 0;
        }
        if !self.made_worktree {
            let (from, to) = (self.root.clone(), self.work.clone());
            tokio::task::spawn_blocking(move || copy_tree(&from, &to))
                .await
                .map_err(|e| Error::Other(e.to_string()))??;
        }
        Ok(self.work.clone())
    }

    /// `__exit__`: the worktree is removed from the repository, and the temporary folder with it.
    pub async fn exit(&mut self) {
        if self.made_worktree {
            let root = self.root.to_string_lossy().into_owned();
            let spec = Spec { cwd: Some(&root), ..Spec::default() };
            let remove: Vec<String> =
                ["git", "worktree", "remove", "--force", &self.work.to_string_lossy()].map(str::to_string).to_vec();
            let _ = proc::run(&remove, &spec, 60.0).await;
            let prune: Vec<String> = ["git", "worktree", "prune"].map(str::to_string).to_vec();
            let _ = proc::run(&prune, &spec, 60.0).await;
        }
        let _ = std::fs::remove_dir_all(&self.tmp);
    }
}

/// `shutil.copytree(src, dst, ignore=shutil.ignore_patterns(".git", "node_modules", ".venv"))`: links are followed (their
/// contents are copied); what cannot be copied is reported at the end, after the rest was.
fn copy_tree(src: &Path, dst: &Path) -> Result<(), Error> {
    let mut errors: Vec<String> = Vec::new();
    copy_dir(src, dst, &mut errors);
    if errors.is_empty() { Ok(()) } else { Err(Error::Other(format!("[{}]", errors.join(", ")))) }
}

fn copy_dir(src: &Path, dst: &Path, errors: &mut Vec<String>) {
    let entries = match std::fs::read_dir(src) {
        Ok(entries) => entries,
        Err(e) => {
            errors.push(format!("{}: {e}", src.display()));
            return;
        }
    };
    if let Err(e) = std::fs::create_dir_all(dst) {
        errors.push(format!("{}: {e}", dst.display()));
        return;
    }
    for entry in entries.flatten() {
        let name = entry.file_name();
        if matches!(name.to_str(), Some(".git" | "node_modules" | ".venv")) {
            continue;
        }
        let (from, to) = (entry.path(), dst.join(&name));
        match std::fs::metadata(&from) {
            Ok(meta) if meta.is_dir() => copy_dir(&from, &to, errors),
            Ok(_) => {
                if let Err(e) = std::fs::copy(&from, &to) {
                    errors.push(format!("{}: {e}", from.display()));
                }
            }
            Err(e) => errors.push(format!("{}: {e}", from.display())),
        }
    }
}

/// The exit code as Python's `returncode` gives it: the code, or minus the signal that ended the process.
fn returncode(status: std::process::ExitStatus) -> i32 {
    #[cfg(unix)]
    {
        use std::os::unix::process::ExitStatusExt;
        status.code().unwrap_or_else(|| -status.signal().unwrap_or(0))
    }
    #[cfg(not(unix))]
    {
        status.code().unwrap_or(-1)
    }
}

/// What the shell prints, read in pieces of whatever size the pipe gives.
struct Chunks {
    #[cfg(unix)]
    rx: tokio::net::unix::pipe::Receiver,
    #[cfg(not(unix))]
    rx: tokio::sync::mpsc::Receiver<Vec<u8>>,
}

impl Chunks {
    async fn next(&mut self) -> Option<Vec<u8>> {
        #[cfg(unix)]
        {
            use tokio::io::AsyncReadExt;
            let mut buf = vec![0u8; 8192];
            match self.rx.read(&mut buf).await {
                Ok(0) | Err(_) => None,
                Ok(n) => {
                    buf.truncate(n);
                    Some(buf)
                }
            }
        }
        #[cfg(not(unix))]
        {
            self.rx.recv().await
        }
    }
}

/// `asyncio.create_subprocess_shell(...)` with the output of the command in one stream (`stderr=STDOUT`).
fn start(cmd: &str, cwd: &Path, env: &HashMap<String, String>) -> Result<(tokio::process::Child, Chunks), Error> {
    #[cfg(unix)]
    let mut command = {
        let mut c = Command::new("/bin/sh");
        c.arg("-c").arg(cmd);
        c
    };
    #[cfg(not(unix))]
    let mut command = {
        let mut c = Command::new("cmd");
        c.arg("/C").arg(cmd);
        c
    };
    command.current_dir(cwd).env_clear().envs(env).stdin(Stdio::null()).kill_on_drop(true);
    cli::popen_kwargs(&mut command);
    let what = cwd.to_string_lossy().into_owned();
    #[cfg(unix)]
    {
        let (reader, writer) = std::io::pipe().map_err(|e| os_error(&e, &what))?;
        let second = writer.try_clone().map_err(|e| os_error(&e, &what))?;
        command.stdout(Stdio::from(writer)).stderr(Stdio::from(second));
        let child = command.spawn().map_err(|e| os_error(&e, &what))?;
        // the write ends live in `command`: drop them, or the pipe never reaches its end
        drop(command);
        let rx = tokio::net::unix::pipe::Receiver::from_owned_fd(reader.into()).map_err(|e| os_error(&e, &what))?;
        Ok((child, Chunks { rx }))
    }
    #[cfg(not(unix))]
    {
        use tokio::io::AsyncReadExt;
        command.stdout(Stdio::piped()).stderr(Stdio::piped());
        let mut child = command.spawn().map_err(|e| os_error(&e, &what))?;
        let (tx, rx) = tokio::sync::mpsc::channel::<Vec<u8>>(64);
        if let Some(mut out) = child.stdout.take() {
            let tx = tx.clone();
            tokio::spawn(async move {
                let mut buf = vec![0u8; 8192];
                while let Ok(n) = out.read(&mut buf).await {
                    if n == 0 || tx.send(buf[..n].to_vec()).await.is_err() {
                        break;
                    }
                }
            });
        }
        if let Some(mut err) = child.stderr.take() {
            tokio::spawn(async move {
                let mut buf = vec![0u8; 8192];
                while let Ok(n) = err.read(&mut buf).await {
                    if n == 0 || tx.send(buf[..n].to_vec()).await.is_err() {
                        break;
                    }
                }
            });
        }
        Ok((child, Chunks { rx }))
    }
}

/// The most `asyncio`'s stream reader takes for one line (`limit=2**16`): a longer one is a `ValueError`.
const LINE_LIMIT: usize = 1 << 16;

/// Read lines until the stream ends. `lines` keeps the last 1000 to 2000 of them (`del lines[:1000]` past 2000).
async fn read_lines(
    chunks: &mut Chunks,
    lines: &mut Vec<String>,
    on_line: Option<&(dyn Fn(&str) + Send + Sync)>,
) -> Result<(), Error> {
    let mut pending: Vec<u8> = Vec::new();
    let take = |raw: &[u8], lines: &mut Vec<String>| {
        let line = String::from_utf8_lossy(raw).trim_end_matches(pytext::is_space).to_string();
        lines.push(line.clone());
        if lines.len() > 2000 {
            lines.drain(..1000);
        }
        if let Some(on_line) = on_line {
            on_line(&line);
        }
    };
    while let Some(chunk) = chunks.next().await {
        pending.extend_from_slice(&chunk);
        while let Some(at) = pending.iter().position(|b| *b == b'\n') {
            let rest = pending.split_off(at + 1);
            let line = std::mem::replace(&mut pending, rest);
            if line.len() > LINE_LIMIT {
                return Err(Error::Other("Separator is found, but chunk is longer than limit".into()));
            }
            take(&line, lines);
        }
        if pending.len() > LINE_LIMIT {
            return Err(Error::Other("Separator is not found, and chunk exceed the limit".into()));
        }
    }
    if !pending.is_empty() {
        take(&pending, lines);
    }
    Ok(())
}

/// How a command ended.
enum Ended {
    Exited(std::io::Result<std::process::ExitStatus>),
    Failed(Error),
    TimedOut,
    Cancelled,
}

/// Run one shell line the way a ticket does (`/bin/sh`, the project's environment), in its own process group so a
/// cancel stops it and everything it started. `on_line` gets each line of output as it comes.
pub async fn run_one(
    cmd: &str,
    cwd: &Path,
    env: &HashMap<String, String>,
    on_line: Option<&(dyn Fn(&str) + Send + Sync)>,
    timeout: f64,
    cancel: Option<&Cancel>,
) -> Result<Value, Error> {
    let started = Instant::now();
    let (mut child, mut chunks) = start(cmd, cwd, env)?;
    let mut lines: Vec<String> = Vec::new();
    let ended = {
        let work = async {
            if let Err(e) = read_lines(&mut chunks, &mut lines, on_line).await {
                return Ended::Failed(e);
            }
            Ended::Exited(child.wait().await)
        };
        let stop = async {
            match cancel {
                Some(c) => c.cancelled().await,
                None => std::future::pending().await,
            }
        };
        tokio::select! {
            ended = work => ended,
            () = tokio::time::sleep(Duration::from_secs_f64(timeout.max(0.0))) => Ended::TimedOut,
            () = stop => Ended::Cancelled,
        }
    };
    let status = match ended {
        Ended::Exited(status) => status.map_err(|e| os_error(&e, cmd))?,
        other => {
            // the shell and everything it started go, and the shell is waited for
            cli::kill_tree(child.id().and_then(|p| i32::try_from(p).ok()));
            let _ = child.wait().await;
            match other {
                Ended::Failed(e) => return Err(e),
                Ended::Cancelled => return Err(Error::Cancelled),
                _ => return Ok(finish(cmd, &lines, None, true, timeout, started)),
            }
        }
    };
    Ok(finish(cmd, &lines, Some(returncode(status)), false, timeout, started))
}

/// The result of a command from what it printed.
fn finish(cmd: &str, lines: &[String], code: Option<i32>, timed_out: bool, timeout: f64, started: Instant) -> Value {
    let output = lines.join("\n");
    let last: Vec<&str> = lines.iter().rev().take(40).rev().map(String::as_str).collect();
    let status = classify(code, &last.join("\n"), timed_out);
    let shown: Vec<&String> = lines.iter().filter(|ln| !pytext::strip(ln).is_empty()).collect();
    let mut tail: Vec<Value> = shown.iter().skip(shown.len().saturating_sub(12)).map(|l| json!(l)).collect();
    if tail.is_empty() && timed_out {
        tail = vec![json!("Timed out.")];
    }
    let reason = if timed_out {
        json!(format!("Timed out after {} minutes.", (timeout / 60.0).floor() as i64))
    } else if status == "wrong" {
        let chars: Vec<char> = output.chars().collect();
        let end: String = chars[chars.len().saturating_sub(4000)..].iter().collect();
        json!(why_wrong(&end, code))
    } else {
        Value::Null
    };
    let seconds = (started.elapsed().as_secs_f64() * 10.0).round() / 10.0;
    json!({
        "command": cmd,
        "status": status,
        "ok": status == "works",
        "exit_code": code,
        "seconds": seconds,
        "tail": tail,
        "reason": reason,
    })
}

/// `on_event(kind, name, data)` reports progress: ("start", name, cmd), ("line", name, text), ("done", name, result).
pub type OnEvent = dyn Fn(&str, &str, &Value) + Send + Sync;

/// What `try_commands` takes beside the folder and the commands.
#[derive(Default, Clone, Copy)]
pub struct TryOptions<'a> {
    /// `extra_path`: folders put in front of the PATH.
    pub extra_path: Option<&'a [String]>,
    /// `only`: the checks to run (`None` is all of them).
    pub only: Option<&'a [String]>,
    /// `on_event`.
    pub on_event: Option<&'a OnEvent>,
    /// The job's stop signal.
    pub cancel: Option<&'a Cancel>,
}

fn command_of(commands: &Map<String, Value>, name: &str) -> String {
    pytext::strip(commands.get(name).and_then(Value::as_str).unwrap_or("")).to_string()
}

/// Run the commands once in a scratch worktree, the way a ticket runs them: prepare first (when set), then test, lint
/// and build, each on its own (one failing does not hide the next). Every command gets a result with a status; one that
/// did not run says why.
pub async fn try_commands(folder: &str, commands: &Map<String, Value>, opts: TryOptions<'_>) -> Result<Value, Error> {
    let env = project_env::with_path(None, opts.extra_path);
    let mut out: Map<String, Value> = COMMANDS.iter().map(|n| ((*n).to_string(), Value::Null)).collect();
    let only = opts.only;
    let wanted: Vec<&str> = CHECKS.into_iter().filter(|n| only.is_none_or(|o| o.iter().any(|x| x == n))).collect();
    let emit = |kind: &str, name: &str, data: &Value| {
        if let Some(on_event) = opts.on_event {
            on_event(kind, name, data);
        }
    };
    let not_run = |name: &str, reason: &str| {
        json!({
            "command": command_of(commands, name),
            "status": "not_run",
            "ok": false,
            "exit_code": null,
            "seconds": 0,
            "tail": [],
            "reason": reason,
        })
    };
    let mut scratch = Scratch::new(folder)?;
    let work = match scratch.enter().await {
        Ok(work) => work,
        Err(e) => {
            scratch.exit().await;
            return Err(e);
        }
    };
    let timeout = TRIAL_TIMEOUT_S as f64;
    let result: Result<(), Error> = async {
        let prepare = command_of(commands, "prepare");
        let mut prepared = true;
        if !prepare.is_empty() {
            emit("start", "prepare", &json!(prepare));
            let line = |ln: &str| emit("line", "prepare", &json!(ln));
            let result = run_one(&prepare, &work, &env, Some(&line), timeout, opts.cancel).await?;
            emit("done", "prepare", &result);
            prepared = result.get("ok").and_then(Value::as_bool).unwrap_or(false);
            out.insert("prepare".into(), result);
        }
        for name in CHECKS {
            let cmd = command_of(commands, name);
            if !wanted.contains(&name) {
                continue;
            }
            let result = if cmd.is_empty() {
                // no command: nothing to try (the wizard shows it as empty)
                Value::Null
            } else if !prepared {
                not_run(name, "prepare failed first")
            } else {
                emit("start", name, &json!(cmd));
                let line = |ln: &str| emit("line", name, &json!(ln));
                run_one(&cmd, &work, &env, Some(&line), timeout, opts.cancel).await?
            };
            emit("done", name, &result);
            out.insert(name.to_string(), result);
        }
        Ok(())
    }
    .await;
    scratch.exit().await;
    result?;
    Ok(Value::Object(out))
}

/// The prepare and test commands tried once (the scan's own trial); see `try_commands`.
pub async fn try_(folder: &str, prepare: &str, test: &str) -> Result<Value, Error> {
    let mut commands = Map::new();
    commands.insert("prepare".into(), json!(prepare));
    commands.insert("test".into(), json!(test));
    let only = ["test".to_string()];
    let out = try_commands(folder, &commands, TryOptions { only: Some(&only), ..TryOptions::default() }).await?;
    Ok(json!({"prepare": out["prepare"], "test": out["test"]}))
}
