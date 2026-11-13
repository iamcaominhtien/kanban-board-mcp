//! Starting and stopping the server under test.

use crate::client::{Client, Events};
use crate::mcp::Mcp;
use serde_json::Value;
use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::OnceCell;

const STARTUP_TIMEOUT: Duration = Duration::from_secs(60);
const KEPT_LINES: usize = 60;

/// Which server a test talks to.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Target {
    /// The frozen FastAPI reference server.
    Python,
    /// The Rust rewrite.
    Rust,
}

/// What `PARITY_TARGET=python` says since the Python server is gone.
const PYTHON_GONE: &str = "PARITY_TARGET=python: the Python server was removed in 5.0.0. Its answers are kept in \
                           contract/golden/; to run a test against it, check out the commit before its removal \
                           (see PORTING.md).";

/// `PARITY_TARGET=python|rust` (default `rust`). The Python target ran the ported tests against the Python server
/// while the port was made; that server is gone, and asking for it stops the test with a message that says so.
pub fn target() -> Target {
    match std::env::var("PARITY_TARGET").unwrap_or_default().trim().to_lowercase().as_str() {
        "python" | "py" => Target::Python,
        "" | "rust" | "rs" => Target::Rust,
        other => panic!("PARITY_TARGET must be python or rust, got {other:?}"),
    }
}

/// How to start one server.
#[derive(Default, Clone)]
pub struct Options {
    /// Extra environment variables (win over the harness's own).
    pub env: Vec<(String, String)>,
    /// An API secret: written to the child's stdin and sent by the client as `X-Kanban-Secret`.
    pub secret: Option<String>,
    /// Do not copy the migrated template database: the server migrates a new file itself.
    pub fresh_db: bool,
}

/// How many hours east of UTC the servers under test are told they are (`TZ`): a zone in which it is about nine in
/// the morning when the test process starts. The board does things by the clock of the computer (from 18:00 on a
/// working day it writes each person's card of the day into the notifications), so a test that counts rows would
/// pass or fail by the hour it runs at. In this zone a server under test never reaches the evening. A test that
/// expects a local time of the server in an answer counts with this offset.
pub fn server_hours_east() -> i64 {
    static EAST: std::sync::OnceLock<i64> = std::sync::OnceLock::new();
    *EAST.get_or_init(|| {
        let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
        let hour = (now / 3600 % 24) as i64;
        // local = UTC + east, with east in -12..=14
        let east = 9 - hour;
        if east < -12 { east + 24 } else { east }
    })
}

/// The `TZ` value of `server_hours_east` (POSIX writes the hours to add to local time to get UTC: the sign is the
/// other way round). A test that runs the board's code in its own process, and is the only test of its process,
/// sets it for itself before anything reads the clock.
pub fn morning_zone() -> String {
    format!("KBT{}", -server_hours_east())
}

fn workspace() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../..").components().collect::<PathBuf>()
}

fn workspace_clean() -> PathBuf {
    let w = workspace();
    std::fs::canonicalize(&w).unwrap_or(w)
}

fn rust_binary() -> PathBuf {
    match std::env::var("KANBAN_SERVER_BIN") {
        Ok(p) if !p.trim().is_empty() => PathBuf::from(p),
        _ => workspace_clean().join("target/debug/kanban-server"),
    }
}

/// Whether the Rust server binary exists.
pub fn rust_binary_available() -> bool {
    rust_binary().is_file()
}

/// For tests: `false` (after printing a notice) when the target is Rust and its binary does not exist yet.
pub fn skip_unless_available(test: &str) -> bool {
    if target() == Target::Rust && !rust_binary_available() {
        eprintln!("SKIPPED {test}: the Rust server binary {} does not exist", rust_binary().display());
        return false;
    }
    true
}

type Tail = Arc<Mutex<VecDeque<String>>>;

/// A running server and its temporary folder. Dropping it kills the process group and removes the folder.
pub struct Server {
    tmp: Option<tempfile::TempDir>,
    child: Option<Child>,
    port: u16,
    base: String,
    secret: Option<String>,
}

fn push(tail: &Tail, line: String) {
    let mut t = tail.lock().unwrap_or_else(|e| e.into_inner());
    if t.len() >= KEPT_LINES {
        t.pop_front();
    }
    t.push_back(line);
}

fn tail_text(tail: &Tail) -> String {
    let t = tail.lock().unwrap_or_else(|e| e.into_inner());
    t.iter().cloned().collect::<Vec<_>>().join("\n")
}

/// Kill the child and everything in its process group, then reap it.
fn kill_group(child: &mut Child) {
    if let Some(pid) = child.id() {
        let _ =
            std::process::Command::new("kill").args(["-KILL", "--", &format!("-{pid}")]).stderr(Stdio::null()).status();
    }
    let _ = child.start_kill();
    for _ in 0..200 {
        match child.try_wait() {
            Ok(Some(_)) | Err(_) => return,
            Ok(None) => std::thread::sleep(Duration::from_millis(10)),
        }
    }
}

impl Server {
    /// Start with the default options.
    pub async fn start() -> Server {
        Server::start_with(Options::default()).await
    }

    /// Start a server of the current target.
    pub async fn start_with(opts: Options) -> Server {
        let template = if opts.fresh_db { None } else { template_db().await };
        Server::spawn(target(), &opts, template.as_deref()).await
    }

    async fn spawn(target: Target, opts: &Options, template: Option<&Path>) -> Server {
        let tmp = tempfile::Builder::new().prefix("kanban-testkit-").tempdir().expect("temporary folder");
        let root = tmp.path().to_path_buf();
        for d in ["data", "config", "logs", "workspace", "uploads", "claude"] {
            std::fs::create_dir_all(root.join(d)).expect("create folder");
        }
        if let Some(t) = template {
            std::fs::copy(t, root.join("data/kanban.db")).expect("copy template database");
        }
        let ai_roots = std::env::join_paths([root.clone(), std::env::temp_dir()]).expect("KANBAN_AI_ROOTS");

        let mut cmd = match target {
            Target::Python => panic!("{PYTHON_GONE}"),
            Target::Rust => Command::new(rust_binary()),
        };
        for (k, _) in std::env::vars_os() {
            if k.to_string_lossy().starts_with("KANBAN_") {
                cmd.env_remove(k);
            }
        }
        cmd.env("KANBAN_CONFIG_DIR", root.join("config"))
            .env("KANBAN_DB_PATH", root.join("data/kanban.db"))
            .env("KANBAN_LOG_DIR", root.join("logs"))
            .env("KANBAN_WORKSPACE_ROOT", root.join("workspace"))
            .env("KANBAN_UPLOADS_DIR", root.join("uploads"))
            .env("CLAUDE_CONFIG_DIR", root.join("claude"))
            .env("KANBAN_DIAGRAM_EXPORT", "off")
            .env("KANBAN_DRAWIO_DIR", root.join("none"))
            .env("KANBAN_AI_ROOTS", ai_roots)
            .env("PYTHONUNBUFFERED", "1")
            .env("TZ", morning_zone());
        if opts.secret.is_some() {
            cmd.env("KANBAN_API_SECRET_STDIN", "1");
        }
        for (k, v) in &opts.env {
            cmd.env(k, v);
        }
        cmd.stdin(if opts.secret.is_some() { Stdio::piped() } else { Stdio::null() })
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        // its own process group, so stopping it stops what it started (Unix only)
        #[cfg(unix)]
        cmd.process_group(0);

        let mut child = cmd.spawn().unwrap_or_else(|e| panic!("cannot start the server: {e}"));
        if let Some(secret) = &opts.secret {
            let mut stdin = child.stdin.take().expect("stdin");
            stdin.write_all(format!("{secret}\n").as_bytes()).await.expect("write the secret");
            stdin.flush().await.expect("flush the secret");
            // the server reads one line; closing stdin afterwards is harmless
            drop(stdin);
        }
        let tail: Tail = Arc::default();
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<u16>();
        let out = child.stdout.take().expect("stdout");
        let t = tail.clone();
        tokio::spawn(async move {
            let mut lines = BufReader::new(out).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                if let Some(p) = line.trim().strip_prefix("READY port=")
                    && let Ok(p) = p.trim().parse::<u16>()
                {
                    let _ = tx.send(p);
                }
                push(&t, format!("[stdout] {line}"));
            }
        });
        let err = child.stderr.take().expect("stderr");
        let t = tail.clone();
        tokio::spawn(async move {
            let mut lines = BufReader::new(err).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                push(&t, format!("[stderr] {line}"));
            }
        });

        let mut server =
            Server { tmp: Some(tmp), child: Some(child), port: 0, base: String::new(), secret: opts.secret.clone() };
        match tokio::time::timeout(STARTUP_TIMEOUT, rx.recv()).await {
            Ok(Some(port)) => {
                server.port = port;
                server.base = format!("http://127.0.0.1:{port}");
                server
            }
            Ok(None) => {
                let status = server.child.as_mut().and_then(|c| c.try_wait().ok().flatten());
                let log = tail_text(&tail);
                drop(server);
                panic!("the server exited before READY ({status:?}); last output:\n{log}");
            }
            Err(_) => {
                let log = tail_text(&tail);
                drop(server);
                panic!("the server printed no READY line within {STARTUP_TIMEOUT:?}; last output:\n{log}");
            }
        }
    }

    /// `http://127.0.0.1:PORT`.
    pub fn base_url(&self) -> &str {
        &self.base
    }

    /// The port the server listens on.
    pub fn port(&self) -> u16 {
        self.port
    }

    /// The process id of the server.
    pub fn pid(&self) -> u32 {
        self.child.as_ref().and_then(|c| c.id()).expect("server running")
    }

    /// The temporary root folder.
    pub fn dir(&self) -> &Path {
        self.tmp.as_ref().expect("server folder").path()
    }

    /// The SQLite file.
    pub fn db_path(&self) -> PathBuf {
        self.dir().join("data/kanban.db")
    }

    /// `KANBAN_UPLOADS_DIR`.
    pub fn uploads_dir(&self) -> PathBuf {
        self.dir().join("uploads")
    }

    /// `KANBAN_WORKSPACE_ROOT`.
    pub fn workspace_root(&self) -> PathBuf {
        self.dir().join("workspace")
    }

    /// `KANBAN_CONFIG_DIR`.
    pub fn config_dir(&self) -> PathBuf {
        self.dir().join("config")
    }

    /// `KANBAN_LOG_DIR`.
    pub fn log_dir(&self) -> PathBuf {
        self.dir().join("logs")
    }

    /// A client; it sends `X-Kanban-Secret` when the server was started with a secret.
    pub fn client(&self) -> Client {
        let headers = self.secret.iter().map(|s| ("X-Kanban-Secret".to_string(), s.clone())).collect();
        Client::new(&self.base, headers)
    }

    /// A client that does not send the secret.
    pub fn client_without_secret(&self) -> Client {
        Client::new(&self.base, Vec::new())
    }

    /// An MCP client.
    pub fn mcp(&self) -> Mcp {
        Mcp::new(self.client())
    }

    /// `GET /events`.
    pub async fn events(&self) -> Events {
        self.client().events().await
    }

    /// Every table of the SQLite file as rows of objects, in a stable order (opened read-only).
    pub async fn dump_db(&self) -> Value {
        crate::dump::dump(&self.db_path()).await
    }

    /// Stop the server and remove its folder.
    pub async fn stop(mut self) {
        if let Some(mut c) = self.child.take() {
            kill_group(&mut c);
            let _ = c.wait().await;
        }
    }
}

impl Drop for Server {
    fn drop(&mut self) {
        if let Some(mut c) = self.child.take() {
            kill_group(&mut c);
        }
        // the TempDir field removes the folder afterwards
    }
}

/// The migrated template database, made once per process (and cached on disk across processes) by the server under
/// test, or `None` when it cannot be made: the server then migrates a new file itself.
async fn template_db() -> Option<PathBuf> {
    static CELL: OnceCell<Option<PathBuf>> = OnceCell::const_new();
    CELL.get_or_init(build_template).await.clone()
}

async fn build_template() -> Option<PathBuf> {
    let head_file = workspace_clean().join("contract/alembic-head.txt");
    let head = std::fs::read_to_string(&head_file).ok()?;
    let key: String = head.trim().chars().filter(|c| c.is_ascii_alphanumeric()).collect();
    let dir = workspace_clean().join("target/testkit");
    std::fs::create_dir_all(&dir).ok()?;
    // (`v3`: made by the Rust server, without the rows about the folders of the server that made it)
    let final_path = dir.join(format!("template-v3-{key}.db"));
    if final_path.is_file() {
        return Some(final_path);
    }
    if !rust_binary_available() {
        return None;
    }
    let mut server = Server::spawn(Target::Rust, &Options::default(), None).await;
    let db = server.db_path();
    // the server is killed, not stopped politely: fold its WAL into the file before copying
    if let Some(mut c) = server.child.take() {
        kill_group(&mut c);
        let _ = c.wait().await;
    }
    crate::dump::checkpoint(&db).await;
    crate::dump::forget_own_folders(&db).await;
    let unique = dir.join(format!(".template-{key}.{}.tmp", std::process::id()));
    let copied = std::fs::copy(&db, &unique);
    drop(server);
    copied.ok()?;
    // a rename is atomic: a racing process either sees the whole file or none
    std::fs::rename(&unique, &final_path).ok()?;
    Some(final_path)
}
