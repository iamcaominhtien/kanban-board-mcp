//! Child processes of this crate (`git`, `gh`, a project's prepare command), run as Python's `subprocess.run(...,
//! capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=...)` ran them.
//!
//! Output is decoded as UTF-8 with replacement characters and its line ends are made `\n` (text mode). A child that
//! outlives its timeout is killed and waited for, never left behind; every child is started in a process group of its
//! own and the whole group is killed (Python killed only the child and left what it had started running; "never leave
//! one behind" decides here).

use std::collections::HashMap;
use std::path::Path;
use std::process::Stdio;
use std::time::Duration;

use kb_base::pytext;
use tokio::io::AsyncReadExt;
use tokio::process::Command;

/// What a finished child left: `subprocess.CompletedProcess`.
#[derive(Debug, Clone, Default)]
pub struct Captured {
    /// `returncode`; a child that a signal ended gives `-signal` as Python does.
    pub returncode: i32,
    /// `stdout`, decoded.
    pub stdout: String,
    /// `stderr`, decoded.
    pub stderr: String,
}

impl Captured {
    /// `(stderr or stdout).strip()`.
    pub fn problem(&self) -> String {
        let text = if self.stderr.is_empty() { &self.stdout } else { &self.stderr };
        pytext::strip(text).to_string()
    }
}

/// `OSError` or `subprocess.TimeoutExpired`: the two things `subprocess.run` raises that callers catch.
#[derive(Debug, Clone)]
pub enum ProcError {
    /// The child could not be started (`str(exc)` of the OSError).
    Spawn(String),
    /// The child did not end in time (`str(exc)` of the TimeoutExpired).
    Timeout(String),
}

impl std::fmt::Display for ProcError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ProcError::Spawn(text) | ProcError::Timeout(text) => f.write_str(text),
        }
    }
}

impl std::error::Error for ProcError {}

/// The seconds of a timeout as Python prints the number that was passed (`60`, `1.5`).
pub fn secs_text(secs: f64) -> String {
    if secs.fract() == 0.0 { format!("{}", secs as i64) } else { format!("{secs}") }
}

/// `str(FileNotFoundError)` and the like, for a child that could not start.
fn spawn_text(err: &std::io::Error, what: &str) -> String {
    match err.kind() {
        std::io::ErrorKind::NotFound => format!("[Errno 2] No such file or directory: {}", pytext::repr(what)),
        std::io::ErrorKind::PermissionDenied => format!("[Errno 13] Permission denied: {}", pytext::repr(what)),
        _ => match err.raw_os_error() {
            Some(code) => format!("[Errno {code}] {err}: {}", pytext::repr(what)),
            None => format!("{err}"),
        },
    }
}

/// `str(subprocess.TimeoutExpired(cmd, timeout))`.
fn timeout_text(cmd: &[String], shell: bool, secs: f64) -> String {
    if shell {
        return format!(
            "Command '{}' timed out after {} seconds",
            cmd.first().map_or("", String::as_str),
            secs_text(secs)
        );
    }
    let list: Vec<String> = cmd.iter().map(|a| pytext::repr(a)).collect();
    format!("Command '[{}]' timed out after {} seconds", list.join(", "), secs_text(secs))
}

/// Where and with what a child runs.
#[derive(Default, Clone)]
pub struct Spec<'a> {
    /// The working folder (`cwd=`).
    pub cwd: Option<&'a str>,
    /// Variables added to this process's environment (`env={**os.environ, ...}`).
    pub add_env: Vec<(String, String)>,
    /// The whole environment of the child (`env=` with a complete dict): the process's own is not inherited.
    pub whole_env: Option<HashMap<String, String>>,
    /// Run the command line through the shell (`shell=True`).
    pub shell: bool,
}

#[cfg(unix)]
async fn kill_group(pid: Option<u32>) {
    if let Some(pid) = pid {
        let _ = Command::new("kill")
            .args(["-KILL", "--", &format!("-{pid}")])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .await;
    }
}

#[cfg(not(unix))]
async fn kill_group(_pid: Option<u32>) {}

fn decode(bytes: &[u8]) -> String {
    let text = String::from_utf8_lossy(bytes);
    if text.contains('\r') { text.replace("\r\n", "\n").replace('\r', "\n") } else { text.into_owned() }
}

/// Run `argv` (or, with `spec.shell`, the one command line in `argv[0]`) and capture what it prints.
pub async fn run(argv: &[String], spec: &Spec<'_>, timeout_s: f64) -> Result<Captured, ProcError> {
    if let Some(cwd) = spec.cwd.filter(|c| !c.is_empty()) {
        if !Path::new(cwd).is_dir() {
            return Err(ProcError::Spawn(spawn_text(&std::io::Error::from(std::io::ErrorKind::NotFound), cwd)));
        }
    }
    let mut cmd = if spec.shell {
        #[cfg(windows)]
        let mut c = Command::new("cmd");
        #[cfg(windows)]
        c.arg("/C");
        #[cfg(not(windows))]
        let mut c = Command::new("/bin/sh");
        #[cfg(not(windows))]
        c.arg("-c");
        c.arg(argv.first().map(String::as_str).unwrap_or(""));
        c
    } else {
        let mut c = Command::new(argv.first().map(String::as_str).unwrap_or(""));
        c.args(&argv[1.min(argv.len())..]);
        c
    };
    if let Some(cwd) = spec.cwd.filter(|c| !c.is_empty()) {
        cmd.current_dir(cwd);
    }
    if let Some(env) = &spec.whole_env {
        cmd.env_clear().envs(env);
    }
    for (k, v) in &spec.add_env {
        cmd.env(k, v);
    }
    cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true);
    #[cfg(unix)]
    cmd.process_group(0);
    let what = argv.first().cloned().unwrap_or_default();
    let mut child = cmd.spawn().map_err(|e| ProcError::Spawn(spawn_text(&e, &what)))?;
    let pid = child.id();
    let mut out = child.stdout.take();
    let mut err = child.stderr.take();
    let finished = tokio::time::timeout(Duration::from_secs_f64(timeout_s.max(0.0)), async {
        let read_out = async {
            let mut buf = Vec::new();
            if let Some(o) = out.as_mut() {
                let _ = o.read_to_end(&mut buf).await;
            }
            buf
        };
        let read_err = async {
            let mut buf = Vec::new();
            if let Some(e) = err.as_mut() {
                let _ = e.read_to_end(&mut buf).await;
            }
            buf
        };
        let (o, e) = tokio::join!(read_out, read_err);
        let status = child.wait().await;
        (o, e, status)
    })
    .await;
    match finished {
        Ok((o, e, status)) => {
            let status = status.map_err(|e| ProcError::Spawn(format!("{e}")))?;
            #[cfg(unix)]
            let code = {
                use std::os::unix::process::ExitStatusExt;
                status.code().unwrap_or_else(|| -status.signal().unwrap_or(0))
            };
            #[cfg(not(unix))]
            let code = status.code().unwrap_or(-1);
            Ok(Captured { returncode: code, stdout: decode(&o), stderr: decode(&e) })
        }
        Err(_) => {
            kill_group(pid).await;
            let _ = child.kill().await;
            let _ = child.wait().await;
            Err(ProcError::Timeout(timeout_text(argv, spec.shell, timeout_s)))
        }
    }
}
