//! `CliProcess`: one running CLI, its lines, its input and its end.
//!
//! How a CLI is kept from outliving the board: see `process` (the group, `kill_tree`). Here: a task started with the
//! CLI waits for its exit, which reaps it and gives `returncode`; `wait` then ends what the CLI left running in its
//! group; a `CliProcess` that is dropped while its CLI runs (a cancelled task, a panic) stops the tree.

use std::process::Stdio;
use std::sync::{Arc, Mutex};

use kb_ai::profiles::Env;
use kb_base::pyjson;
use kb_base::secrets::redact;
use serde_json::json;
use tokio::io::{AsyncBufRead, AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{ChildStderr, ChildStdin, ChildStdout};
use tokio::sync::watch;

use super::{
    child_env, kill_tree, low_priority_prefix, max_command_chars, popen_kwargs, returncode_of, spill_long_args_with,
};

/// The most one line of the CLI may hold (`limit=16 * 1024 * 1024` of the asyncio stream).
pub const LINE_LIMIT: usize = 16 * 1024 * 1024;

/// Reads lines of a pipe as asyncio's `StreamReader` does: a line with its line end, what is left at the end of the
/// stream, and an error for a line over the limit. A read that is dropped half-way (a timeout around it) loses
/// nothing: the part read so far is kept for the next call.
struct LineReader<R> {
    pipe: BufReader<R>,
    partial: Vec<u8>,
}

impl<R: tokio::io::AsyncRead + Unpin> LineReader<R> {
    fn new(pipe: R) -> Self {
        Self { pipe: BufReader::with_capacity(64 * 1024, pipe), partial: Vec::new() }
    }

    async fn next(&mut self) -> std::io::Result<Option<Vec<u8>>> {
        read_line(&mut self.pipe, &mut self.partial, LINE_LIMIT).await
    }
}

async fn read_line<R: AsyncBufRead + Unpin>(
    pipe: &mut R,
    partial: &mut Vec<u8>,
    limit: usize,
) -> std::io::Result<Option<Vec<u8>>> {
    loop {
        let buf = pipe.fill_buf().await?;
        if buf.is_empty() {
            return Ok(if partial.is_empty() { None } else { Some(std::mem::take(partial)) });
        }
        if let Some(at) = buf.iter().position(|b| *b == b'\n') {
            partial.extend_from_slice(&buf[..=at]);
            pipe.consume(at + 1);
            return Ok(Some(std::mem::take(partial)));
        }
        let n = buf.len();
        partial.extend_from_slice(buf);
        pipe.consume(n);
        if partial.len() > limit {
            partial.clear();
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "Separator is not found, and chunk exceed the limit",
            ));
        }
    }
}

/// The CLI once it is started: its pid and its exit code, which a task of its own fills in when the CLI ends.
struct Started {
    pid: i32,
    exit: watch::Receiver<Option<i32>>,
}

#[derive(Default)]
struct State {
    started: Option<Started>,
    /// Held so the drain can be stopped with the process object
    stderr_task: Option<tokio::task::JoinHandle<()>>,
    temp: Option<String>,
    input_open: bool,
    stdin: Option<Arc<tokio::sync::Mutex<ChildStdin>>>,
}

/// One running CLI: yields its stdout lines; `kill()` stops the whole tree.
///
/// Every method takes `&self`, so one task can read the lines while others send a message, pause or stop it.
pub struct CliProcess {
    /// Whether a long prompt may travel by stdin and a long system prompt by a file.
    pub spill: bool,
    /// The command.
    pub args: Vec<String>,
    /// The folder the CLI works in.
    pub cwd: String,
    /// The CLI's environment.
    pub env: Env,
    /// Live input (stream-json on stdin): the first message is the prompt; `send` adds one, `end_input` closes it
    pub first_message: Option<String>,
    /// Whether the CLI takes its messages on stdin.
    pub live: bool,
    /// The longest command line that stays as it is; None: this platform's (`_MAX_COMMAND_CHARS`, which tests lower).
    pub max_command_chars: Option<usize>,
    state: Mutex<State>,
    stderr_tail: Arc<Mutex<Vec<String>>>,
    stdout: tokio::sync::Mutex<Option<LineReader<ChildStdout>>>,
}

/// The stdout lines of a CLI as they arrive (`async for line in proc.lines()`).
pub struct Lines<'a> {
    proc: &'a CliProcess,
}

impl Lines<'_> {
    /// The next line without its line end, or None when the CLI closed its output. An error is a line over
    /// `LINE_LIMIT` (Python's `ValueError`) or a pipe that cannot be read.
    pub async fn next(&mut self) -> std::io::Result<Option<String>> {
        let mut stdout = self.proc.stdout.lock().await;
        let Some(reader) = stdout.as_mut() else {
            return Err(std::io::Error::other("the CLI was not started"));
        };
        Ok(reader.next().await?.map(|raw| String::from_utf8_lossy(&raw).trim_end_matches('\n').to_string()))
    }
}

/// On the way out of `wait`, also when the wait is dropped (Python's `finally`): end what is left of the CLI's group
/// and remove its temp folder.
struct ReapOnDrop<'a>(&'a CliProcess);

impl Drop for ReapOnDrop<'_> {
    fn drop(&mut self) {
        self.0.reap();
        self.0.cleanup();
    }
}

impl CliProcess {
    /// Prepare the command; nothing starts until `start()`. `spill` lets a long prompt travel by stdin (Claude
    /// Code only).
    pub fn new(args: Vec<String>, cwd: &str, env: Option<Env>, spill: bool, first_message: Option<String>) -> Self {
        Self {
            spill,
            args,
            cwd: cwd.to_string(),
            env: env.filter(|e| !e.is_empty()).unwrap_or_else(|| child_env(None)),
            live: first_message.is_some(),
            first_message,
            max_command_chars: None,
            state: Mutex::default(),
            stderr_tail: Arc::default(),
            stdout: tokio::sync::Mutex::new(None),
        }
    }

    fn state(&self) -> std::sync::MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// The CLI's pid once it is started (`proc.proc.pid`).
    pub fn pid(&self) -> Option<i32> {
        self.state().started.as_ref().map(|s| s.pid)
    }

    /// The CLI's exit code once it has ended (`proc.proc.returncode`): None while it runs or before it starts.
    pub fn returncode(&self) -> Option<i32> {
        self.state().started.as_ref().and_then(|s| *s.exit.borrow())
    }

    /// Whether the CLI was started and has not ended (`proc.proc is not None and proc.proc.returncode is None`).
    pub fn running(&self) -> bool {
        self.state().started.as_ref().is_some_and(|s| s.exit.borrow().is_none())
    }

    /// The last 20 lines the CLI wrote to stderr, secrets masked.
    pub fn stderr_tail(&self) -> Vec<String> {
        self.stderr_tail.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }

    /// The temp folder of a spilled system prompt, while there is one (`proc._temp`).
    pub fn temp(&self) -> Option<String> {
        self.state().temp.clone()
    }

    /// Launch; returns the pid.
    pub async fn start(&self) -> std::io::Result<i32> {
        // A live run's stdin carries its messages, so only the system prompt moves to a file: on the command line
        // a cmd.exe shim mangles it, and one argument over 128 KB fails on Linux (E2BIG)
        let (args, stdin_text, temp) = if self.spill {
            let max = self.max_command_chars.unwrap_or(max_command_chars(cfg!(windows)));
            spill_long_args_with(&self.args, !self.live, cfg!(windows), max)?
        } else {
            (self.args.clone(), None, None)
        };
        self.state().temp = temp;
        let argv: Vec<String> = low_priority_prefix().into_iter().chain(args).collect();
        let spawned = match argv.split_first() {
            Some((program, rest)) => {
                let mut command = tokio::process::Command::new(program);
                command.args(rest).current_dir(&self.cwd).env_clear().envs(self.env.iter().map(|(k, v)| (k, v)));
                command.stdin(if stdin_text.is_none() && !self.live { Stdio::null() } else { Stdio::piped() });
                command.stdout(Stdio::piped()).stderr(Stdio::piped());
                popen_kwargs(&mut command);
                command.spawn()
            }
            None => Err(std::io::Error::new(std::io::ErrorKind::InvalidInput, "empty command")),
        };
        let mut child = match spawned {
            Ok(child) => child,
            Err(e) => {
                self.cleanup();
                return Err(e);
            }
        };
        let pid = child.id().and_then(|id| i32::try_from(id).ok()).unwrap_or(0);
        let (stdin, stdout, stderr) = (child.stdin.take(), child.stdout.take(), child.stderr.take());
        // The exit is awaited by a task of its own from the first moment: the CLI is reaped whoever stops reading, and
        // `returncode` is there without a call to `wait` (as asyncio's child watcher fills it in)
        let (exit_tx, exit_rx) = watch::channel(None);
        tokio::spawn(async move {
            let code = child.wait().await.map(returncode_of).unwrap_or(-1);
            let _ = exit_tx.send(Some(code));
        });
        self.state().started = Some(Started { pid, exit: exit_rx });
        *self.stdout.lock().await = stdout.map(LineReader::new);
        if self.live && stdin.is_some() {
            {
                let mut state = self.state();
                state.stdin = stdin.map(|s| Arc::new(tokio::sync::Mutex::new(s)));
                state.input_open = true;
            }
            self.send(self.first_message.as_deref().unwrap_or("")).await;
        } else if let (Some(text), Some(mut stdin)) = (stdin_text, stdin) {
            // an error here: the CLI already exited; its exit code and stderr say why
            if stdin.write_all(text.as_bytes()).await.is_ok() {
                let _ = stdin.flush().await;
            }
            drop(stdin);
        }
        let drain = tokio::spawn(drain_stderr(stderr, self.stderr_tail.clone()));
        self.state().stderr_task = Some(drain);
        Ok(pid)
    }

    /// Write one user message to a live CLI's input; False when it is not live or its input is closed.
    pub async fn send(&self, text: &str) -> bool {
        let stdin = {
            let state = self.state();
            if !(self.live && state.input_open && state.started.is_some()) {
                return false;
            }
            match &state.stdin {
                Some(stdin) => stdin.clone(),
                None => return false,
            }
        };
        let line = pyjson::dumps(&json!({
            "type": "user",
            "message": {"role": "user", "content": [{"type": "text", "text": text}]},
        }));
        let mut stdin = stdin.lock().await;
        let written = async {
            stdin.write_all(format!("{line}\n").as_bytes()).await?;
            stdin.flush().await
        };
        if written.await.is_err() {
            self.state().input_open = false;
            return false;
        }
        true
    }

    /// A live CLI whose input is still open (it waits for the next message).
    pub fn input_open(&self) -> bool {
        self.state().input_open
    }

    /// Close a live CLI's input: it finishes the turn it is on and exits.
    pub fn end_input(&self) {
        let mut state = self.state();
        if self.live && state.input_open && state.started.is_some() && state.stdin.is_some() {
            state.input_open = false;
            // the pipe closes when the last holder lets go: now, or when a message being written is out
            state.stdin = None;
        }
    }

    /// Remove the temp folder of a spilled system prompt.
    fn cleanup(&self) {
        if let Some(temp) = self.state().temp.take() {
            let _ = std::fs::remove_dir_all(temp);
        }
    }

    /// Stdout lines as they arrive.
    pub fn lines(&self) -> Lines<'_> {
        Lines { proc: self }
    }

    /// Exit code. What the CLI started and left running (a web server it looked at pages through, a dev server)
    /// is stopped with it: the CLI leads its own process group, so whatever is still in that group is its leftover.
    /// An error is a CLI that was never started.
    pub async fn wait(&self) -> std::io::Result<i32> {
        let Some(mut exit) = self.state().started.as_ref().map(|s| s.exit.clone()) else {
            return Err(std::io::Error::other("the CLI was not started"));
        };
        let _reap = ReapOnDrop(self);
        let code = match exit.wait_for(Option::is_some).await {
            Ok(code) => (*code).unwrap_or(-1),
            // the task that waited for the CLI is gone (the runtime is closing)
            Err(_) => -1,
        };
        Ok(code)
    }

    fn reap(&self) {
        #[cfg(unix)]
        if let Some(pid) = self.pid().filter(|pid| *pid > 0) {
            use nix::sys::signal::{Signal, killpg};
            // an error: nothing left over
            let _ = killpg(nix::unistd::Pid::from_raw(pid), Signal::SIGTERM);
        }
    }

    /// Stop the CLI and its children.
    pub fn kill(&self) {
        if self.running() {
            kill_tree(self.pid());
        }
        self.cleanup();
    }
}

impl Drop for CliProcess {
    /// A CLI nobody holds any more cannot be stopped later: stop its tree now.
    fn drop(&mut self) {
        self.kill();
        if let Some(task) = self.state().stderr_task.take() {
            task.abort();
        }
    }
}

async fn drain_stderr(stderr: Option<ChildStderr>, tail: Arc<Mutex<Vec<String>>>) {
    let Some(stderr) = stderr else { return };
    let mut reader = LineReader::new(stderr);
    while let Ok(Some(raw)) = reader.next().await {
        let text = String::from_utf8_lossy(&raw);
        let line = text.trim_end_matches(kb_base::pytext::is_space);
        if !line.is_empty() {
            let mut tail = tail.lock().unwrap_or_else(|e| e.into_inner());
            tail.push(redact(line));
            let extra = tail.len().saturating_sub(20);
            tail.drain(..extra);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn a_line_is_read_whole_and_one_over_the_limit_is_an_error() {
        let data = b"one\ntwo two\n\nlast".to_vec();
        let mut pipe = BufReader::with_capacity(4, &data[..]);
        let mut partial = Vec::new();
        let mut got = Vec::new();
        while let Some(line) = read_line(&mut pipe, &mut partial, 100).await.expect("a line") {
            got.push(String::from_utf8(line).expect("text"));
        }
        assert_eq!(got, ["one\n", "two two\n", "\n", "last"]);
        let long = [b'x'; 64];
        let mut pipe = BufReader::with_capacity(8, &long[..]);
        assert!(read_line(&mut pipe, &mut partial, 16).await.is_err());
    }
}
