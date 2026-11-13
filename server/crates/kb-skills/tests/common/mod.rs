//! Shared by the ported route tests: the same assertions run against the Python server (`PARITY_TARGET=python`, a
//! real server started by `testkit` with its own home folder and `PATH`) or, by default, against this crate's own
//! router in the test process (`kb_skills::api::routes()`; `kb-app` does not merge it yet, so the Rust server cannot
//! serve it).
//!
//! Nothing here touches the developer's Claude Code or Antigravity configuration: every fixture has its own home
//! folder and its own `PATH` with a fake `claude` (a copy of this crate's `fake-claude-cli`), and never runs a real one.
#![allow(dead_code, unsafe_code)]

use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use async_trait::async_trait;
use axum::Router;
use axum::body::Body;
use axum::http::Request;
use kb_skills::hooks::{self, McpToolsHook};
use kb_skills::mcp_clients::{self, Env};
use serde_json::Value;
use testkit::{Client, Options, Server, Target, target};
use tower::ServiceExt;

/// One test at a time may own the process-wide environment (home folder, `PATH`, database).
static LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
static CONFIG: OnceLock<tempfile::TempDir> = OnceLock::new();

/// The number of tools the in-process router reports (the Python server reports its own, more than 0).
pub const FAKE_TOOL_COUNT: usize = 3;

struct Tools;

#[async_trait]
impl McpToolsHook for Tools {
    async fn tool_count(&self) -> usize {
        FAKE_TOOL_COUNT
    }
}

/// The lock a test that sets the environment override without a fixture takes.
pub async fn env_lock() -> tokio::sync::MutexGuard<'static, ()> {
    LOCK.lock().await
}

/// An answer: its status and its body (a JSON body parsed; anything else as a string).
pub struct Resp {
    pub status: u16,
    pub body: Value,
}

impl Resp {
    pub fn json(&self) -> &Value {
        &self.body
    }

    pub fn detail(&self) -> &Value {
        &self.body["detail"]
    }
}

#[allow(clippy::large_enum_variant)]
enum Inner {
    Remote { server: Server, client: Client },
    Local { router: Router, _guard: tokio::sync::MutexGuard<'static, ()> },
}

/// A server (or router) with a home folder of its own.
pub struct Fixture {
    inner: Inner,
    /// The temporary folder that holds everything below.
    pub tmp: tempfile::TempDir,
    /// The fake home folder.
    pub home: PathBuf,
    /// A folder with a fake `claude` in it (on `PATH` only for a fixture made with `claude`).
    pub bin: PathBuf,
}

/// What a fixture is made with.
#[derive(Default, Clone)]
pub struct Opts {
    /// A fake `claude` on `PATH`.
    pub claude: bool,
    /// A database in the process (in-process only; the Python server always has one): chosen, not yet made.
    pub db: bool,
    /// With `db`, also make its tables (a test that moves the file).
    pub schema: bool,
}

pub fn skip(test: &str, why: &str) {
    eprintln!("SKIPPED {test}: {why}");
}

pub fn is_python() -> bool {
    target() == Target::Python
}

fn which_dir(name: &str) -> Option<PathBuf> {
    std::env::split_paths(&std::env::var_os("PATH")?).find(|dir| dir.join(name).is_file())
}

/// `PATH` of a fixture: the fake `claude` (if asked), the folder of `uv` and the system's.
fn path_of(bin: &Path, claude: bool) -> String {
    let mut dirs: Vec<String> = Vec::new();
    if claude {
        dirs.push(bin.display().to_string());
    }
    if let Some(uv) = which_dir("uv") {
        dirs.push(uv.display().to_string());
    }
    dirs.push("/usr/bin".into());
    dirs.push("/bin".into());
    dirs.join(":")
}

fn set_var(name: &str, value: impl AsRef<std::ffi::OsStr>) {
    // SAFETY: the fixture lock allows one test at a time to touch the environment, and nothing else in the process
    // reads it through libc.
    unsafe { std::env::set_var(name, value) }
}

fn unset_var(name: &str) {
    // SAFETY: as `set_var`.
    unsafe { std::env::remove_var(name) }
}

impl Fixture {
    pub async fn new(opts: Opts) -> Fixture {
        let tmp = tempfile::Builder::new().prefix("kanban-skills-").tempdir().expect("temporary folder");
        let root = std::fs::canonicalize(tmp.path()).expect("temporary folder path");
        let home = root.join("home");
        let bin = root.join("bin");
        std::fs::create_dir_all(&home).expect("home");
        std::fs::create_dir_all(&bin).expect("bin");
        #[cfg(unix)]
        std::os::unix::fs::symlink(env!("CARGO_BIN_EXE_fake-claude-cli"), bin.join("claude")).expect("fake claude");
        #[cfg(not(unix))]
        std::fs::copy(env!("CARGO_BIN_EXE_fake-claude-cli"), bin.join("claude.exe")).expect("fake claude");
        let path = path_of(&bin, opts.claude);

        let inner = if is_python() {
            let env = vec![("HOME".to_string(), home.display().to_string()), ("PATH".to_string(), path.clone())];
            let server = Server::start_with(Options { env, ..Default::default() }).await;
            let client = server.client();
            Inner::Remote { server, client }
        } else {
            let guard = LOCK.lock().await;
            CONFIG.get_or_init(|| {
                let dir = tempfile::tempdir().expect("config folder");
                set_var("KANBAN_CONFIG_DIR", dir.path().join("config"));
                dir
            });
            set_var("HOME", &home);
            set_var("KANBAN_DB_PATH", root.join("data").join("kanban.db"));
            set_var("KANBAN_UPLOADS_DIR", root.join("uploads"));
            unset_var("KANBAN_DATABASE_URL");
            kb_base::config::set_value("data_folder", Value::Null).expect("config");
            if opts.db {
                kb_db::database::setup().await.expect("database setup");
            }
            if opts.schema {
                kb_db::database::init_db().await.expect("schema");
            }
            let mut env = Env::from_process();
            env.home = home.clone();
            env.path = Some(path.clone().into());
            env.db_path = String::new();
            env.system_candidates = Vec::new();
            mcp_clients::set_env_override(Some(env));
            hooks::set_mcp_tools_hook(Box::new(Tools));
            Inner::Local { router: kb_skills::api::routes().into_parts().0, _guard: guard }
        };
        Fixture { inner, tmp, home, bin }
    }

    pub async fn with_claude() -> Fixture {
        Fixture::new(Opts { claude: true, ..Default::default() }).await
    }

    pub async fn without_claude() -> Fixture {
        Fixture::new(Opts::default()).await
    }

    /// The database is chosen (`setup`), the way a server that has not made its tables yet has it.
    pub async fn with_db() -> Fixture {
        Fixture::new(Opts { db: true, ..Default::default() }).await
    }

    /// The database has its tables.
    pub async fn with_schema() -> Fixture {
        Fixture::new(Opts { db: true, schema: true, ..Default::default() }).await
    }

    /// Whether the Python server answers (otherwise the router in this process does).
    pub fn is_remote(&self) -> bool {
        matches!(self.inner, Inner::Remote { .. })
    }

    /// The SQLite file of the board.
    pub fn db_file(&self) -> PathBuf {
        match &self.inner {
            Inner::Remote { server, .. } => server.db_path(),
            Inner::Local { .. } => self.tmp.path().join("data").join("kanban.db"),
        }
    }

    /// The uploads folder.
    pub fn uploads(&self) -> PathBuf {
        match &self.inner {
            Inner::Remote { server, .. } => server.uploads_dir(),
            Inner::Local { .. } => self.tmp.path().join("uploads"),
        }
    }

    /// A folder inside the fake home (created).
    pub fn folder(&self, name: &str) -> PathBuf {
        let path = self.home.join(name);
        std::fs::create_dir_all(&path).expect("folder");
        path
    }

    /// Make the fake `claude` fail (`FAKE_CLAUDE_FAIL`), or work again.
    pub fn claude_fails(&self, on: bool) {
        let flag = self.home.join(".fake-claude-fail");
        if on {
            std::fs::write(flag, "").expect("flag");
        } else {
            let _ = std::fs::remove_file(flag);
        }
    }

    /// `GET path?query`.
    pub async fn get(&self, path: &str, query: &[(&str, &str)]) -> Resp {
        match &self.inner {
            Inner::Remote { client, .. } => {
                let r = client.get_query(path, query).await;
                Resp { status: r.status, body: parse(&r.body) }
            }
            Inner::Local { router, .. } => {
                let url = if query.is_empty() {
                    path.to_string()
                } else {
                    let pairs: Vec<String> = query.iter().map(|(k, v)| format!("{}={}", enc(k), enc(v))).collect();
                    format!("{path}?{}", pairs.join("&"))
                };
                call(router, "GET", &url, None).await
            }
        }
    }

    /// `POST path` with a JSON body.
    pub async fn post(&self, path: &str, body: Value) -> Resp {
        match &self.inner {
            Inner::Remote { client, .. } => {
                let r = client.post(path, body).await;
                Resp { status: r.status, body: parse(&r.body) }
            }
            Inner::Local { router, .. } => call(router, "POST", path, Some(body)).await,
        }
    }

    /// `POST /settings/mcp-clients/{client}/{action}` with `{scope?, folder?}`.
    pub async fn action(&self, client: &str, action: &str, body: Value) -> Resp {
        self.post(&format!("/settings/mcp-clients/{client}/{action}"), body).await
    }

    /// `GET /settings/mcp-clients/{client}`.
    pub async fn status(&self, client: &str, query: &[(&str, &str)]) -> Resp {
        self.get(&format!("/settings/mcp-clients/{client}"), query).await
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        if matches!(self.inner, Inner::Local { .. }) {
            mcp_clients::set_env_override(None);
        }
    }
}

fn parse(bytes: &[u8]) -> Value {
    serde_json::from_slice(bytes).unwrap_or_else(|_| Value::String(String::from_utf8_lossy(bytes).into_owned()))
}

fn enc(text: &str) -> String {
    text.bytes()
        .map(|b| {
            if b.is_ascii_alphanumeric() || b"-_.~".contains(&b) {
                (b as char).to_string()
            } else {
                format!("%{b:02X}")
            }
        })
        .collect()
}

async fn call(router: &Router, method: &str, url: &str, body: Option<Value>) -> Resp {
    let mut builder = Request::builder().method(method).uri(url);
    let body = match body {
        Some(value) => {
            builder = builder.header("content-type", "application/json");
            Body::from(serde_json::to_vec(&value).expect("json"))
        }
        None => Body::empty(),
    };
    let response = router.clone().oneshot(builder.body(body).expect("request")).await.expect("a router never fails");
    let status = response.status().as_u16();
    let bytes = axum::body::to_bytes(response.into_body(), 1 << 24).await.expect("body");
    Resp { status, body: parse(&bytes) }
}

/// `json.dumps(value)` for a file a test writes.
pub fn dumps(value: &Value) -> String {
    kb_base::pyjson::dumps(value)
}

pub fn read_json(path: &Path) -> Value {
    serde_json::from_str(&std::fs::read_to_string(path).unwrap_or_else(|e| panic!("{}: {e}", path.display())))
        .expect("json")
}

pub fn write_json(path: &Path, value: &Value) {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).expect("folder");
    }
    std::fs::write(path, dumps(value)).expect("write");
}
