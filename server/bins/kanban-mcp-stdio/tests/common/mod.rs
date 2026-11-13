//! Shared by the tests of the stdio program: start the Rust `kanban-mcp-stdio` or the Python `mcp_stdio.py` on
//! temporary folders of its own (config, database, log: never the developer's) and talk to it line by line.
#![allow(dead_code)]

use std::io::{BufRead, BufReader, Read, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{Receiver, channel};
use std::time::Duration;

use serde_json::{Value, json};

/// Which program.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Which {
    /// `server/.venv/bin/python mcp_stdio.py`: the reference.
    Python,
    /// The `kanban-mcp-stdio` binary of this crate.
    Rust,
}

/// A running program with its temporary folder.
pub struct Program {
    pub which: Which,
    child: Child,
    stdin: Option<ChildStdin>,
    lines: Receiver<String>,
    stderr: Receiver<String>,
    tmp: tempfile::TempDir,
    sentinels: u32,
}

fn server_dir() -> PathBuf {
    let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../server");
    std::fs::canonicalize(&dir).unwrap_or(dir)
}

/// Whether the Python reference can be started here.
pub fn python_available() -> bool {
    server_dir().join(".venv/bin/python").is_file()
}

/// Start `which` with `args` and extra environment variables.
pub fn spawn(which: Which, args: &[&str], env: &[(&str, &str)]) -> Program {
    let tmp = tempfile::Builder::new().prefix("kanban-stdio-").tempdir().expect("a temporary folder");
    for dir in ["config", "data", "logs", "workspace", "uploads"] {
        std::fs::create_dir_all(tmp.path().join(dir)).expect("create a folder");
    }
    let mut command = match which {
        Which::Python => {
            let mut command = Command::new(server_dir().join(".venv/bin/python"));
            command.arg("mcp_stdio.py").current_dir(server_dir()).env("PYTHONUNBUFFERED", "1");
            command
        }
        Which::Rust => Command::new(env!("CARGO_BIN_EXE_kanban-mcp-stdio")),
    };
    for (name, _) in std::env::vars_os() {
        if name.to_string_lossy().starts_with("KANBAN_") {
            command.env_remove(name);
        }
    }
    command
        .args(args)
        .env("KANBAN_CONFIG_DIR", tmp.path().join("config"))
        .env("KANBAN_DB_PATH", tmp.path().join("data/kanban.db"))
        .env("KANBAN_LOG_DIR", tmp.path().join("logs"))
        .env("KANBAN_WORKSPACE_ROOT", tmp.path().join("workspace"))
        .env("KANBAN_UPLOADS_DIR", tmp.path().join("uploads"))
        .envs(env.iter().copied())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = command.spawn().unwrap_or_else(|e| panic!("cannot start {which:?}: {e}"));
    let stdin = child.stdin.take();
    let (tx, lines) = channel();
    let stdout = child.stdout.take().expect("stdout");
    std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            if tx.send(line).is_err() {
                break;
            }
        }
    });
    let (tx, stderr) = channel();
    let mut err = child.stderr.take().expect("stderr");
    std::thread::spawn(move || {
        let mut text = String::new();
        let _ = err.read_to_string(&mut text);
        let _ = tx.send(text);
    });
    Program { which, child, stdin, lines, stderr, tmp, sentinels: 0 }
}

impl Program {
    /// The log folder of the program.
    pub fn log_dir(&self) -> PathBuf {
        self.tmp.path().join("logs")
    }

    /// Write one line to the program's standard input.
    pub fn send(&mut self, line: &str) {
        let stdin = self.stdin.as_mut().expect("stdin is open");
        stdin.write_all(format!("{line}\n").as_bytes()).expect("write a line");
        stdin.flush().expect("flush");
    }

    /// The next line of standard output (the first one waits for the program to start: a new database is made).
    pub fn next_line(&mut self, timeout: Duration) -> Option<String> {
        self.lines.recv_timeout(timeout).ok()
    }

    /// The next line as JSON; panics when none comes or it is not JSON (nothing else may be on standard output).
    pub fn next_message(&mut self) -> Value {
        let line = self
            .next_line(Duration::from_secs(120))
            .unwrap_or_else(|| panic!("{:?}: no line on standard output", self.which));
        serde_json::from_str(&line)
            .unwrap_or_else(|e| panic!("{:?}: a line that is not JSON ({e}): {line}", self.which))
    }

    /// Send `line` and collect everything the program writes for it. `reply_id` is the id of the reply to wait
    /// for (a request); then a `ping` is sent, and what comes before its reply belongs to the line too (so a line
    /// that is answered with nothing, or with a notification, is seen as that).
    pub fn exchange(&mut self, line: &str, reply_id: Option<Value>) -> Vec<Value> {
        self.send(line);
        let mut got = Vec::new();
        if let Some(id) = reply_id {
            loop {
                let message = self.next_message();
                let found = message.get("id") == Some(&id) && message.get("method").is_none();
                got.push(message);
                if found {
                    break;
                }
            }
        }
        self.sentinels += 1;
        let sentinel = json!(format!("sentinel-{}", self.sentinels));
        self.send(&json!({"jsonrpc": "2.0", "id": sentinel, "method": "ping"}).to_string());
        loop {
            let message = self.next_message();
            if message.get("id") == Some(&sentinel) {
                assert_eq!(message, json!({"jsonrpc": "2.0", "id": sentinel, "result": {}}));
                return got;
            }
            got.push(message);
        }
    }

    /// Close the program's standard input and wait for it to end: its exit code, what was still on standard
    /// output, and its standard error.
    pub fn finish(mut self) -> (Option<i32>, Vec<String>, String) {
        drop(self.stdin.take());
        let mut waited = 0;
        let status = loop {
            match self.child.try_wait().expect("wait") {
                Some(status) => break Some(status),
                None if waited >= 300 => {
                    let _ = self.child.kill();
                    break None;
                }
                None => {
                    std::thread::sleep(Duration::from_millis(100));
                    waited += 1;
                }
            }
        };
        let mut rest = Vec::new();
        while let Ok(line) = self.lines.recv_timeout(Duration::from_secs(2)) {
            rest.push(line);
        }
        let stderr = self.stderr.recv_timeout(Duration::from_secs(2)).unwrap_or_default();
        (status.and_then(|s| s.code()), rest, stderr)
    }
}

impl Drop for Program {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}
