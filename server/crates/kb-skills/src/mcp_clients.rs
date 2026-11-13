//! Install the Kanban MCP server into Claude Code and Antigravity (Settings -> MCP integrations).
//!
//! Claude Code is configured only through its own CLI (`claude mcp add/remove`); its config files are read, never
//! written, by us. Antigravity has no CLI, so we merge a single `kanban` key into its `mcp_config.json` (atomic
//! write; a file that is not valid JSON is never overwritten). Other servers in either config are never changed.
//!
//! Port of `services/mcp_clients.py`. Everything that depends on the machine (the home folder, `PATH`, where the
//! program sits) is read through `Env`, so a test gives the code its own home and its own fake `claude` and never
//! touches the person's real configuration (`set_env_override`).

use std::ffi::{OsStr, OsString};
use std::io;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Mutex;
use std::time::Duration;

use kb_base::pyjson::{self, Dumps};
use kb_base::pytext;
use kb_files::pathlib;
use serde_json::{Map, Value, json};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;

/// The name of the entry in the clients' configs.
pub const SERVER_NAME: &str = "kanban";
/// Claude Code's scopes; the first is the default.
pub const CLAUDE_SCOPES: [&str; 3] = ["user", "project", "local"];
/// Antigravity's scopes; the first is the default.
pub const ANTIGRAVITY_SCOPES: [&str; 2] = ["global", "workspace"];
const CLI_TIMEOUT: Duration = Duration::from_secs(30);
const TEST_TIMEOUT: Duration = Duration::from_secs(30);
const TEST_TIMEOUT_SECONDS: u64 = 30;
const CLI_TIMEOUT_SECONDS: u64 = 30;

/// The protocol version a client of the Python `mcp` SDK asks for first, and the ones it accepts in the reply.
const LATEST_PROTOCOL_VERSION: &str = "2025-11-25";
const SUPPORTED_PROTOCOL_VERSIONS: [&str; 4] = ["2024-11-05", "2025-03-26", "2025-06-18", "2025-11-25"];

/// An expected failure, reported to the UI as `error` on the client status.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct McpClientError {
    /// Short error code for the UI, e.g. "command_failed".
    pub code: String,
    /// Human-readable explanation.
    pub message: String,
}

impl McpClientError {
    fn new(code: &str, message: impl Into<String>) -> Self {
        Self { code: code.to_string(), message: message.into() }
    }

    fn to_value(&self) -> Value {
        json!({"code": self.code, "message": self.message})
    }
}

/// What a function of this module raises past its own `except` clauses.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Failure {
    /// `BadRequest`: the request itself is wrong (unknown client or scope, missing or invalid folder); a 400.
    BadRequest(String),
    /// Any other exception (a config file whose entry has the wrong type): a 500.
    Internal(String),
}

impl From<McpClientError> for Failure {
    /// A `McpClientError` that nothing caught.
    fn from(err: McpClientError) -> Self {
        Failure::Internal(err.message)
    }
}

// ---------------------------------------------------------------- the machine

/// What the code reads from the machine it runs on.
#[derive(Debug, Clone)]
pub struct Env {
    /// `Path.home()`.
    pub home: PathBuf,
    /// `PATH`, or `None` when it is not set.
    pub path: Option<OsString>,
    /// `sys.executable`: the running program (the stdio server sits beside it in a packaged app).
    pub exe: PathBuf,
    /// `KANBAN_DB_PATH` ("" when not set).
    pub db_path: String,
    /// The server's workspace folder (`server/`), for the development command.
    pub server_dir: PathBuf,
    /// The absolute places `find_claude` looks after `PATH` and the home folder.
    pub system_candidates: Vec<PathBuf>,
}

impl Env {
    /// The process's own environment.
    pub fn from_process() -> Self {
        Self {
            home: kb_base::config::home_dir(),
            path: std::env::var_os("PATH"),
            exe: std::env::current_exe().unwrap_or_default(),
            db_path: std::env::var("KANBAN_DB_PATH").unwrap_or_default(),
            server_dir: pathlib::resolve(&Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../server")),
            system_candidates: vec![PathBuf::from("/opt/homebrew/bin/claude"), PathBuf::from("/usr/local/bin/claude")],
        }
    }
}

static OVERRIDE: Mutex<Option<Env>> = Mutex::new(None);

/// For tests: use this environment instead of the process's own (`None` goes back to the process's).
pub fn set_env_override(env: Option<Env>) {
    *OVERRIDE.lock().unwrap_or_else(|e| e.into_inner()) = env;
}

fn current_env() -> Env {
    OVERRIDE.lock().unwrap_or_else(|e| e.into_inner()).clone().unwrap_or_else(Env::from_process)
}

// ---------------------------------------------------------------- Python's helpers

/// `shutil.which(cmd)` with `PATH` given (`None`: not set).
fn which(cmd: &str, path: Option<&OsStr>) -> Option<PathBuf> {
    let default = OsString::from("/bin:/usr/bin");
    let path = path.unwrap_or(default.as_os_str());
    if path.is_empty() {
        return None;
    }
    let mut candidates = vec![String::new()];
    if cfg!(windows) {
        let ext = std::env::var("PATHEXT").unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD".to_string());
        let lower = cmd.to_lowercase();
        if !ext.split(';').any(|e| !e.is_empty() && lower.ends_with(&e.to_lowercase())) {
            candidates = ext.split(';').filter(|e| !e.is_empty()).map(str::to_string).collect();
        }
    }
    for dir in std::env::split_paths(path) {
        for suffix in &candidates {
            let name = dir.join(format!("{cmd}{suffix}"));
            if is_executable_file(&name) {
                return Some(name);
            }
        }
    }
    None
}

/// `os.path.exists(p) and os.access(p, os.X_OK) and not os.path.isdir(p)`.
fn is_executable_file(path: &Path) -> bool {
    let Ok(meta) = std::fs::metadata(path) else { return false };
    if meta.is_dir() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        meta.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    {
        true
    }
}

/// `shlex.quote`.
fn shlex_quote(text: &str) -> String {
    if text.is_empty() {
        return "''".to_string();
    }
    if text.chars().all(|c| c.is_ascii_alphanumeric() || "_@%+=:,./-".contains(c)) {
        return text.to_string();
    }
    format!("'{}'", text.replace('\'', "'\"'\"'"))
}

/// `subprocess.list2cmdline` (Windows quoting, including its habit of repeating the trailing backslashes).
fn list2cmdline(parts: &[String]) -> String {
    let mut result = String::new();
    for (index, arg) in parts.iter().enumerate() {
        if index > 0 {
            result.push(' ');
        }
        let needquote = arg.contains(' ') || arg.contains('\t') || arg.is_empty();
        if needquote {
            result.push('"');
        }
        let mut backslashes = 0usize;
        for c in arg.chars() {
            match c {
                '\\' => backslashes += 1,
                '"' => {
                    result.push_str(&"\\".repeat(backslashes * 2));
                    backslashes = 0;
                    result.push_str("\\\"");
                }
                c => {
                    result.push_str(&"\\".repeat(backslashes));
                    backslashes = 0;
                    result.push(c);
                }
            }
        }
        result.push_str(&"\\".repeat(backslashes));
        if needquote {
            result.push_str(&"\\".repeat(backslashes));
            result.push('"');
        }
    }
    result
}

/// `_join`: the parts as one command line to copy.
fn join(parts: &[String]) -> String {
    if cfg!(windows) { list2cmdline(parts) } else { parts.iter().map(|p| shlex_quote(p)).collect::<Vec<_>>().join(" ") }
}

/// `exc.strerror or str(exc)` of an `OSError`: the system's text without Rust's " (os error N)".
fn strerror(err: &io::Error) -> String {
    let text = err.to_string();
    match text.rfind(" (os error ") {
        Some(at) => text[..at].to_string(),
        None => text,
    }
}

/// `str(exc)` of an `OSError` that names no file (uvloop's subprocess errors): `[Errno 2] No such file or directory`.
fn errno_text(err: &io::Error) -> String {
    match err.raw_os_error() {
        Some(code) => format!("[Errno {code}] {}", strerror(err)),
        None => strerror(err),
    }
}

/// `str(exc)` of an `OSError` that names a file: `[Errno 2] No such file or directory: 'name'`.
fn oserror_text(err: &io::Error, filename: &str) -> String {
    match err.raw_os_error() {
        Some(code) => format!("[Errno {code}] {}: {}", strerror(err), pytext::repr(filename)),
        None => strerror(err),
    }
}

/// `list(value)` of a JSON value; a `TypeError` (not iterable) is a failure.
fn py_list(value: &Value) -> Result<Vec<Value>, Failure> {
    match value {
        Value::Array(items) => Ok(items.clone()),
        Value::String(text) => Ok(text.chars().map(|c| Value::String(c.to_string())).collect()),
        Value::Object(map) => Ok(map.keys().map(|k| Value::String(k.clone())).collect()),
        other => Err(Failure::Internal(format!("TypeError: {} is not iterable", pyjson::py_repr(other)))),
    }
}

/// `dict(value)` of a JSON value, for the shapes a config file can hold.
fn py_dict(value: &Value) -> Result<Map<String, Value>, Failure> {
    let bad = || Failure::Internal(format!("cannot convert {} to a dictionary", pyjson::py_repr(value)));
    match value {
        Value::Object(map) => Ok(map.clone()),
        Value::Array(items) if items.is_empty() => Ok(Map::new()),
        Value::String(text) if text.is_empty() => Ok(Map::new()),
        Value::Array(items) => {
            let mut map = Map::new();
            for item in items {
                match item.as_array().map(Vec::as_slice) {
                    Some([Value::String(key), val]) => {
                        map.insert(key.clone(), val.clone());
                    }
                    _ => return Err(bad()),
                }
            }
            Ok(map)
        }
        _ => Err(bad()),
    }
}

/// `data.get(key, default)` when the value present may be anything.
fn get_or<'a>(map: &'a Map<String, Value>, key: &str, default: &'a Value) -> &'a Value {
    map.get(key).unwrap_or(default)
}

// ---------------------------------------------------------------- the server entry

/// Command + args that start the stdio MCP server in this install.
///
/// Python decides with `sys.frozen`: a packaged desktop app has both programs side by side in one folder
/// (`Resources/kanban-mcp-stdio/{kanban-server,kanban-mcp-stdio}`), and the entry is the sibling program with no
/// arguments. A compiled program has no such flag: the same folder layout is the test (`kanban-mcp-stdio` next to the
/// running program, which is also what a `cargo build` of the workspace produces). Otherwise this is development
/// (`cargo run`, a test build): the command is the workspace's own debug build of the program,
/// `<server folder>/target/debug/kanban-mcp-stdio`, which `cargo build -p kanban-server -p kanban-mcp-stdio` makes.
pub fn stdio_command() -> (String, Vec<String>) {
    stdio_command_in(&current_env())
}

fn stdio_command_in(env: &Env) -> (String, Vec<String>) {
    let ext = if cfg!(windows) { ".exe" } else { "" };
    let dir = pathlib::resolve(&env.exe).parent().map(Path::to_path_buf).unwrap_or_default();
    let sibling = dir.join(format!("kanban-mcp-stdio{ext}"));
    if sibling.is_file() {
        return (sibling.to_string_lossy().into_owned(), Vec::new());
    }
    let built = env.server_dir.join("target").join("debug").join(format!("kanban-mcp-stdio{ext}"));
    (built.to_string_lossy().into_owned(), Vec::new())
}

/// The packaged app points the stdio binary at its database through `KANBAN_DB_PATH`.
pub fn stdio_env() -> Vec<(String, String)> {
    stdio_env_in(&current_env())
}

fn stdio_env_in(env: &Env) -> Vec<(String, String)> {
    if env.db_path.is_empty() { Vec::new() } else { vec![("KANBAN_DB_PATH".to_string(), env.db_path.clone())] }
}

/// `_entry(with_type)`: `{type?, command, args, env?}`.
fn entry(env: &Env, with_type: bool) -> Map<String, Value> {
    let (command, args) = stdio_command_in(env);
    let mut out = Map::new();
    if with_type {
        out.insert("type".into(), json!("stdio"));
    }
    out.insert("command".into(), Value::String(command));
    out.insert("args".into(), Value::Array(args.into_iter().map(Value::String).collect()));
    let vars = stdio_env_in(env);
    if !vars.is_empty() {
        out.insert("env".into(), Value::Object(vars.into_iter().map(|(k, v)| (k, Value::String(v))).collect()));
    }
    out
}

/// `_same_entry(installed, expected)`.
fn same_entry(installed: &Map<String, Value>, expected: &Map<String, Value>) -> Result<bool, Failure> {
    let empty_list = json!([]);
    let empty_dict = json!({});
    let command = installed.get("command") == expected.get("command");
    let args = Value::Array(py_list(get_or(installed, "args", &empty_list))?) == expected["args"];
    let env = Value::Object(py_dict(get_or(installed, "env", &empty_dict))?)
        == Value::Object(py_dict(get_or(expected, "env", &empty_dict))?);
    Ok(command && args && env)
}

// ---------------------------------------------------------------- files

/// `_read_json`: the file's JSON object, `{}` when the file does not exist.
fn read_json(path: &Path) -> Result<Map<String, Value>, McpClientError> {
    if !path.exists() {
        return Ok(Map::new());
    }
    let invalid = || {
        McpClientError::new(
            "invalid_json",
            format!("{} is not valid JSON, so it was left untouched. Fix or remove it and try again.", path.display()),
        )
    };
    let bytes = std::fs::read(path).map_err(|_| invalid())?;
    let text = crate::assets::decode_text(&bytes);
    let data = if bytes.is_empty() { "{}" } else { text.as_str() };
    let data: Value = serde_json::from_str(data).map_err(|_| invalid())?;
    match data {
        Value::Object(map) => Ok(map),
        _ => Err(McpClientError::new(
            "invalid_json",
            format!("{} does not contain a JSON object; it was left untouched.", path.display()),
        )),
    }
}

/// `_write_json`: an atomic replace, with the file's mode kept; nothing changes when it fails.
///
/// As in Python, removing the temporary file after a failed write only ignores "not found": any other error from that
/// (a folder where the path's parent should be: "Not a directory") is raised past the `write_failed` report, a 500.
fn write_json(path: &Path, data: &Map<String, Value>) -> Result<(), Stored> {
    let mut tmp_name = path.file_name().unwrap_or_default().to_os_string();
    tmp_name.push(".kanban-tmp");
    let tmp = path.with_file_name(tmp_name);
    let written = (|| -> io::Result<()> {
        if let Some(parent) = path.parent().filter(|p| !p.as_os_str().is_empty()) {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::write(&tmp, Dumps::new().indent(2).dump(&Value::Object(data.clone())))?;
        if path.exists() {
            std::fs::set_permissions(&tmp, std::fs::metadata(path)?.permissions())?;
        }
        std::fs::rename(&tmp, path)
    })();
    let Err(err) = written else { return Ok(()) };
    if let Err(unlink) = std::fs::remove_file(&tmp)
        && unlink.kind() != io::ErrorKind::NotFound
    {
        return Err(Stored::Internal(oserror_text(&unlink, &tmp.display().to_string())));
    }
    Err(Stored::Mcp(McpClientError::new(
        "write_failed",
        format!(
            "Couldn't write {}: {}. Nothing was changed. Copy the JSON and add it to the file yourself.",
            path.display(),
            strerror(&err)
        ),
    )))
}

/// `_servers`: the `mcpServers` object of a config (`{}` when it has none).
fn servers(data: &Map<String, Value>, path: &Path) -> Result<Map<String, Value>, McpClientError> {
    match data.get("mcpServers") {
        None => Ok(Map::new()),
        Some(Value::Object(map)) => Ok(map.clone()),
        Some(_) => Err(McpClientError::new(
            "invalid_json",
            format!("'mcpServers' in {} is not an object; it was left untouched.", path.display()),
        )),
    }
}

/// `_folder`: the project folder, resolved; `None` when it was not given and is not required.
fn folder(raw: Option<&str>, required: bool) -> Result<Option<PathBuf>, Failure> {
    let raw = raw.map(pytext::strip).filter(|text| !text.is_empty());
    let Some(raw) = raw else {
        if required {
            return Err(Failure::BadRequest("Choose a project folder first.".into()));
        }
        return Ok(None);
    };
    let path = pathlib::resolve(Path::new(raw));
    if !path.is_dir() {
        return Err(Failure::BadRequest(format!("{} is not a folder.", path.display())));
    }
    Ok(Some(path))
}

/// `_tilde`: the path with the home folder as `~/`.
fn tilde(env: &Env, path: &Path) -> String {
    match path.strip_prefix(&env.home) {
        Ok(rest) => {
            let rest = rest.components().map(|c| c.as_os_str().to_string_lossy().into_owned()).collect::<Vec<_>>();
            format!("~/{}", if rest.is_empty() { ".".to_string() } else { rest.join("/") })
        }
        Err(_) => path.display().to_string(),
    }
}

// ---------------------------------------------------------------- Claude Code

/// Locate the `claude` CLI on PATH or in common install folders.
pub fn find_claude() -> Option<String> {
    find_claude_in(&current_env())
}

fn find_claude_in(env: &Env) -> Option<String> {
    if let Some(found) = which("claude", env.path.as_deref()) {
        return Some(found.to_string_lossy().into_owned());
    }
    // GUI apps (the desktop build) often start without the shell's PATH.
    let candidates =
        [env.home.join(".claude").join("local").join("claude"), env.home.join(".local").join("bin").join("claude")];
    candidates
        .iter()
        .chain(env.system_candidates.iter())
        .find(|candidate| candidate.is_file() && is_executable_file(candidate))
        .map(|candidate| candidate.to_string_lossy().into_owned())
}

fn claude_add_args(env: &Env, scope: &str) -> Vec<String> {
    let (command, args) = stdio_command_in(env);
    let mut out: Vec<String> =
        ["mcp", "add", SERVER_NAME, "--transport", "stdio", "--scope", scope].iter().map(|s| s.to_string()).collect();
    for (key, value) in stdio_env_in(env) {
        out.push("--env".into());
        out.push(format!("{key}={value}"));
    }
    out.push("--".into());
    out.push(command);
    out.extend(args);
    out
}

/// Return the `claude mcp add ...` command for a scope, as text to copy.
pub fn claude_command_text(scope: &str) -> String {
    claude_command_text_in(&current_env(), scope)
}

fn claude_command_text_in(env: &Env, scope: &str) -> String {
    let mut parts = vec!["claude".to_string()];
    parts.extend(claude_add_args(env, scope));
    join(&parts)
}

/// What a step raised: a `McpClientError` for the status, or something that is a 500.
enum Stored {
    Mcp(McpClientError),
    Internal(String),
}

impl From<McpClientError> for Stored {
    fn from(err: McpClientError) -> Self {
        Stored::Mcp(err)
    }
}

fn not_a_dict(what: &Value) -> Stored {
    Stored::Internal(format!("AttributeError: {} has no attribute 'get'", pyjson::py_repr(what)))
}

/// Where the kanban entry lives for a scope, and its current value (read-only).
fn claude_stored(env: &Env, scope: &str, folder: Option<&Path>) -> Result<(PathBuf, Option<Value>), Stored> {
    if scope == "project" {
        let path = folder.map(|f| f.join(".mcp.json")).unwrap_or_else(|| PathBuf::from(".mcp.json"));
        let found = match folder {
            Some(_) => servers(&read_json(&path)?, &path)?.get(SERVER_NAME).cloned(),
            None => None,
        };
        return Ok((path, found));
    }
    let path = env.home.join(".claude.json");
    let data = read_json(&path)?;
    if scope == "user" {
        let found = servers(&data, &path)?.get(SERVER_NAME).cloned();
        return Ok((path, found));
    }
    let projects = match data.get("projects") {
        Some(value) if pyjson::truthy(value) => value.clone(),
        _ => json!({}),
    };
    let project = match folder {
        Some(folder) => match &projects {
            Value::Object(map) => map.get(&folder.display().to_string()).cloned(),
            other => return Err(not_a_dict(other)),
        },
        None => None,
    };
    let servers = match &project {
        Some(Value::Object(map)) => map.get("mcpServers").cloned(),
        _ => None,
    };
    let servers = match servers {
        Some(value) if pyjson::truthy(&value) => value,
        _ => json!({}),
    };
    match servers {
        Value::Object(map) => Ok((path, map.get(SERVER_NAME).cloned())),
        other => Err(not_a_dict(&other)),
    }
}

/// What `subprocess.run(..., capture_output=True, text=True)` gives back.
struct Completed {
    returncode: i32,
    stdout: String,
    stderr: String,
}

fn text_of(bytes: &[u8]) -> String {
    crate::assets::decode_text(bytes)
}

async fn run_claude(env: &Env, args: &[String], cwd: Option<&Path>) -> Result<Completed, McpClientError> {
    let Some(claude) = find_claude_in(env) else {
        return Err(McpClientError::new(
            "claude_not_found",
            "Couldn't find the claude command. Install Claude Code first, or copy the command and run it yourself.",
        ));
    };
    let cwd = cwd.map(Path::to_path_buf).unwrap_or_else(|| env.home.clone());
    let mut command = Command::new(&claude);
    command.args(args).current_dir(&cwd).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    command.kill_on_drop(true);
    // the child sees the same home and PATH the code looked in (the process's own, outside a test)
    if let Some(path) = &env.path {
        command.env("PATH", path);
    }
    if cfg!(unix) {
        command.env("HOME", &env.home);
    }
    let run = async {
        let child = command.spawn()?;
        child.wait_with_output().await
    };
    match tokio::time::timeout(CLI_TIMEOUT, run).await {
        Err(_) => Err(McpClientError::new(
            "command_failed",
            format!("claude did not finish within {CLI_TIMEOUT_SECONDS} seconds."),
        )),
        Ok(Err(err)) => {
            let named = if cwd.is_dir() { claude.clone() } else { cwd.display().to_string() };
            Err(McpClientError::new("command_failed", format!("Couldn't run claude: {}", oserror_text(&err, &named))))
        }
        Ok(Ok(out)) => Ok(Completed {
            returncode: out.status.code().unwrap_or(-1),
            stdout: text_of(&out.stdout),
            stderr: text_of(&out.stderr),
        }),
    }
}

// ---------------------------------------------------------------- Antigravity

fn antigravity_path(env: &Env, scope: &str, folder: Option<&Path>) -> PathBuf {
    if scope == "workspace" {
        return folder.map(Path::to_path_buf).unwrap_or_default().join(".agents").join("mcp_config.json");
    }
    env.home.join(".gemini").join("config").join("mcp_config.json")
}

// ---------------------------------------------------------------- status / actions

fn scope_for(client: &str, scope: Option<&str>) -> Result<String, Failure> {
    let options: &[&str] = if client == "claude-code" { &CLAUDE_SCOPES } else { &ANTIGRAVITY_SCOPES };
    let scope = scope.filter(|s| !s.is_empty()).unwrap_or(options[0]);
    if !options.contains(&scope) {
        return Err(Failure::BadRequest(format!("Unknown scope '{scope}' for {client}.")));
    }
    Ok(scope.to_string())
}

fn needs_folder(client: &str, scope: &str) -> bool {
    if client == "claude-code" { scope == "project" || scope == "local" } else { scope == "workspace" }
}

/// The status of one client and scope.
#[derive(Debug, Clone, PartialEq)]
struct Status {
    id: String,
    scope: String,
    needs_folder: bool,
    tool_count: usize,
    detected: bool,
    installed: bool,
    update_available: bool,
    installed_command: Option<String>,
    command: Option<String>,
    entry_json: Option<String>,
    stored_in: Option<String>,
    error: Option<McpClientError>,
}

impl Status {
    fn to_value(&self) -> Value {
        json!({
            "id": self.id,
            "scope": self.scope,
            "needs_folder": self.needs_folder,
            "tool_count": self.tool_count,
            "detected": self.detected,
            "installed": self.installed,
            "update_available": self.update_available,
            "installed_command": self.installed_command,
            "command": self.command,
            "entry_json": self.entry_json,
            "stored_in": self.stored_in,
            "error": self.error.as_ref().map(McpClientError::to_value),
        })
    }
}

fn status_of(
    env: &Env,
    client: &str,
    scope: Option<&str>,
    folder_raw: Option<&str>,
    tool_count: usize,
) -> Result<Status, Failure> {
    if client != "claude-code" && client != "antigravity" {
        return Err(Failure::BadRequest(format!("Unknown MCP client '{client}'")));
    }
    let scope = scope_for(client, scope)?;
    let needs = needs_folder(client, &scope);
    let folder = if needs { self::folder(folder_raw, false)? } else { None };

    let mut status = Status {
        id: client.to_string(),
        scope: scope.clone(),
        needs_folder: needs && folder.is_none(),
        tool_count,
        detected: true,
        installed: false,
        update_available: false,
        installed_command: None,
        command: None,
        entry_json: None,
        stored_in: None,
        error: None,
    };
    let looked: Result<(PathBuf, Option<Value>, Map<String, Value>), McpClientError> = (|| {
        if client == "claude-code" {
            status.detected = find_claude_in(env).is_some();
            status.command = Some(claude_command_text_in(env, &scope));
            match claude_stored(env, &scope, folder.as_deref()) {
                Ok((path, installed)) => Ok((path, installed, entry(env, true))),
                Err(Stored::Mcp(err)) => Err(err),
                Err(Stored::Internal(message)) => Err(McpClientError::new("\0internal", message)),
            }
        } else {
            let path = antigravity_path(env, &scope, folder.as_deref());
            status.entry_json = Some(
                Dumps::new().indent(2).dump(&json!({"mcpServers": {SERVER_NAME: Value::Object(entry(env, false))}})),
            );
            let installed =
                if !status.needs_folder { servers(&read_json(&path)?, &path)?.get(SERVER_NAME).cloned() } else { None };
            Ok((path, installed, entry(env, false)))
        }
    })();
    let (path, installed, expected) = match looked {
        Ok(found) => found,
        Err(err) if err.code == "\0internal" => return Err(Failure::Internal(err.message)),
        Err(err) => {
            status.error = Some(err);
            return Ok(status);
        }
    };

    status.stored_in = if !status.needs_folder { Some(tilde(env, &path)) } else { None };
    if let Some(Value::Object(installed)) = installed {
        status.installed = true;
        let mut parts = vec![py_str_or(installed.get("command"), "")];
        let empty = json!([]);
        for arg in py_list(get_or(&installed, "args", &empty))? {
            parts.push(pyjson::py_str(&arg));
        }
        status.installed_command = Some(join(&parts));
        status.update_available = !same_entry(&installed, &expected)?;
    }
    Ok(status)
}

fn py_str_or(value: Option<&Value>, default: &str) -> String {
    value.map(pyjson::py_str).unwrap_or_else(|| default.to_string())
}

/// Report whether the MCP server is installed for a client and scope.
///
/// `client` is "claude-code" or "antigravity"; `scope` is the client's config scope (`None`: its default);
/// `folder_raw` is the project folder, needed for project/local/workspace scopes; `tool_count` is echoed in the
/// status. The status has `installed`, `scope`, `error` and related fields. Unknown client or scope is a
/// `Failure::BadRequest`.
pub fn get_status(
    client: &str,
    scope: Option<&str>,
    folder_raw: Option<&str>,
    tool_count: usize,
) -> Result<Value, Failure> {
    status_of(&current_env(), client, scope, folder_raw, tool_count).map(|s| s.to_value())
}

/// Add or replace the kanban entry; expected failures come back as `status["error"]`.
pub async fn install(
    client: &str,
    scope: Option<&str>,
    folder_raw: Option<&str>,
    tool_count: usize,
) -> Result<Value, Failure> {
    let env = current_env();
    let mut status = status_of(&env, client, scope, folder_raw, tool_count)?;
    let scope = status.scope.clone();
    let folder = folder(folder_raw, needs_folder(client, &scope))?;
    if status.error.is_some() {
        return Ok(status.to_value());
    }
    let done: Result<(), Stored> = async {
        if client == "claude-code" {
            if status.installed {
                // `claude mcp add` refuses an existing name; replace it
                let args: Vec<String> =
                    ["mcp", "remove", SERVER_NAME, "--scope", &scope].iter().map(|s| s.to_string()).collect();
                run_claude(&env, &args, folder.as_deref()).await?;
            }
            let result = run_claude(&env, &claude_add_args(&env, &scope), folder.as_deref()).await?;
            if result.returncode != 0 {
                let detail = if result.stderr.is_empty() { &result.stdout } else { &result.stderr };
                let detail = pytext::strip(detail);
                return Err(Stored::Mcp(McpClientError::new(
                    "command_failed",
                    format!("claude mcp add failed: {}", if detail.is_empty() { "unknown error" } else { detail }),
                )));
            }
        } else {
            let path = antigravity_path(&env, &scope, folder.as_deref());
            let mut data = read_json(&path)?;
            let mut found = servers(&data, &path)?;
            found.insert(SERVER_NAME.into(), Value::Object(entry(&env, false)));
            data.insert("mcpServers".into(), Value::Object(found));
            write_json(&path, &data)?;
        }
        Ok(())
    }
    .await;
    match done {
        Ok(()) => {}
        Err(Stored::Mcp(err)) => {
            status.error = Some(err);
            return Ok(status.to_value());
        }
        Err(Stored::Internal(message)) => return Err(Failure::Internal(message)),
    }
    get_status(client, Some(&scope), folder_raw, tool_count)
}

/// Uninstall the MCP server from a client and return the new status.
pub async fn remove(
    client: &str,
    scope: Option<&str>,
    folder_raw: Option<&str>,
    tool_count: usize,
) -> Result<Value, Failure> {
    let env = current_env();
    let mut status = status_of(&env, client, scope, folder_raw, tool_count)?;
    let scope = status.scope.clone();
    let folder = folder(folder_raw, needs_folder(client, &scope))?;
    if status.error.is_some() || !status.installed {
        return Ok(status.to_value());
    }
    let done: Result<(), Stored> = async {
        if client == "claude-code" {
            let args: Vec<String> =
                ["mcp", "remove", SERVER_NAME, "--scope", &scope].iter().map(|s| s.to_string()).collect();
            let result = run_claude(&env, &args, folder.as_deref()).await?;
            if result.returncode != 0 {
                let detail = if result.stderr.is_empty() { &result.stdout } else { &result.stderr };
                let detail = pytext::strip(detail);
                return Err(Stored::Mcp(McpClientError::new(
                    "command_failed",
                    format!("claude mcp remove failed: {}", if detail.is_empty() { "unknown error" } else { detail }),
                )));
            }
        } else {
            let path = antigravity_path(&env, &scope, folder.as_deref());
            let mut data = read_json(&path)?;
            let mut found = servers(&data, &path)?;
            found.shift_remove(SERVER_NAME);
            data.insert("mcpServers".into(), Value::Object(found));
            write_json(&path, &data)?;
        }
        Ok(())
    }
    .await;
    match done {
        Ok(()) => {}
        Err(Stored::Mcp(err)) => {
            status.error = Some(err);
            return Ok(status.to_value());
        }
        Err(Stored::Internal(message)) => return Err(Failure::Internal(message)),
    }
    get_status(client, Some(&scope), folder_raw, tool_count)
}

/// Return the client's config file path for a scope.
pub fn config_file(client: &str, scope: Option<&str>, folder_raw: Option<&str>) -> Result<PathBuf, Failure> {
    let env = current_env();
    let scope = scope_for(client, scope)?;
    let folder = folder(folder_raw, needs_folder(client, &scope))?;
    if client == "antigravity" {
        return Ok(antigravity_path(&env, &scope, folder.as_deref()));
    }
    match claude_stored(&env, &scope, folder.as_deref()) {
        Ok((path, _)) => Ok(path),
        Err(Stored::Mcp(err)) => Err(err.into()),
        Err(Stored::Internal(message)) => Err(Failure::Internal(message)),
    }
}

/// Open a config file in the OS default editor.
pub fn open_file(path: &Path) -> Result<(), Failure> {
    if !path.exists() {
        return Err(Failure::BadRequest(format!(
            "{} doesn't exist yet. Install first, or create it yourself.",
            path.display()
        )));
    }
    let opener = if cfg!(windows) {
        "explorer"
    } else if cfg!(target_os = "macos") {
        "open"
    } else {
        "xdg-open"
    };
    match std::process::Command::new(opener)
        .arg(path)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
    {
        Ok(mut child) => {
            // Popen does not wait either; reaping it on a thread keeps no zombie behind
            std::thread::spawn(move || {
                let _ = child.wait();
            });
            Ok(())
        }
        Err(err) => {
            Err(Failure::BadRequest(format!("Couldn't open {}: {}", path.display(), oserror_text(&err, opener))))
        }
    }
}

// ---------------------------------------------------------------- the probe

/// Why a probe failed: the server could not be started (the text of the OS error), or anything after that (the
/// Python SDK raises its errors inside a task group, so what it reports is the group's own text).
enum ProbeError {
    Spawn(String),
    Session,
}

/// One line of JSON-RPC to the server.
async fn send(stdin: &mut tokio::process::ChildStdin, message: &Value) -> Result<(), ProbeError> {
    let mut line = serde_json::to_string(message).map_err(|_| ProbeError::Session)?;
    line.push('\n');
    stdin.write_all(line.as_bytes()).await.map_err(|_| ProbeError::Session)?;
    stdin.flush().await.map_err(|_| ProbeError::Session)
}

/// The reply to request `id`: lines that are not JSON and messages for no one are skipped, requests the server makes
/// are answered as a client answers them (`ping` with `{}`, anything else as unknown), and a closed pipe or an
/// `error` reply is a failed session.
async fn reply<R: tokio::io::AsyncBufRead + Unpin>(
    lines: &mut tokio::io::Lines<R>,
    stdin: &mut tokio::process::ChildStdin,
    id: u64,
) -> Result<Value, ProbeError> {
    loop {
        let Some(line) = lines.next_line().await.map_err(|_| ProbeError::Session)? else {
            return Err(ProbeError::Session);
        };
        let Ok(Value::Object(message)) = serde_json::from_str::<Value>(&line) else { continue };
        let is_ours = message.get("id").and_then(Value::as_u64) == Some(id);
        if is_ours && message.contains_key("error") {
            return Err(ProbeError::Session);
        }
        if is_ours && let Some(result) = message.get("result") {
            return Ok(result.clone());
        }
        if let (Some(method), Some(request_id)) = (message.get("method").and_then(Value::as_str), message.get("id")) {
            let answer = if method == "ping" {
                json!({"jsonrpc": "2.0", "id": request_id, "result": {}})
            } else {
                json!({"jsonrpc": "2.0", "id": request_id, "error": {"code": -32601, "message": "Method not found"}})
            };
            send(stdin, &answer).await?;
        }
    }
}

/// `InitializeResult`: a supported protocol version, capabilities and the server's name and version.
fn initialized_ok(result: &Value) -> bool {
    let version = result.get("protocolVersion").and_then(Value::as_str);
    let info = result.get("serverInfo");
    version.is_some_and(|v| SUPPORTED_PROTOCOL_VERSIONS.contains(&v))
        && result.get("capabilities").is_some_and(Value::is_object)
        && info.is_some_and(|i| {
            i.get("name").is_some_and(Value::is_string) && i.get("version").is_some_and(Value::is_string)
        })
}

/// `ListToolsResult`: how many tools the first page lists (the SDK's `list_tools()` asks once and does not follow
/// `nextCursor`).
fn tools_in(result: &Value) -> Option<usize> {
    let tools = result.get("tools")?.as_array()?;
    tools
        .iter()
        .all(|t| t.get("name").is_some_and(Value::is_string) && t.get("inputSchema").is_some_and(Value::is_object))
        .then_some(tools.len())
}

/// Start the server as the client would and perform `initialize`, `notifications/initialized` and `tools/list`
/// (what `ClientSession` over `stdio_client` does), returning the number of tools.
async fn probe(command: &str, args: &[String], extra_env: &[(String, String)]) -> Result<usize, ProbeError> {
    let mut child = Command::new(command);
    child
        .args(args)
        .envs(extra_env.iter().map(|(k, v)| (k.as_str(), v.as_str())))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .kill_on_drop(true);
    let mut child = child.spawn().map_err(|err| ProbeError::Spawn(errno_text(&err)))?;
    let (Some(mut stdin), Some(stdout)) = (child.stdin.take(), child.stdout.take()) else {
        return Err(ProbeError::Session);
    };
    let mut lines = BufReader::new(stdout).lines();

    send(
        &mut stdin,
        &json!({
            "method": "initialize",
            "params": {
                "protocolVersion": LATEST_PROTOCOL_VERSION,
                "capabilities": {},
                "clientInfo": {"name": "mcp", "version": "0.1.0"},
            },
            "jsonrpc": "2.0",
            "id": 0,
        }),
    )
    .await?;
    let initialized = reply(&mut lines, &mut stdin, 0).await?;
    if !initialized_ok(&initialized) {
        return Err(ProbeError::Session);
    }
    send(&mut stdin, &json!({"method": "notifications/initialized", "jsonrpc": "2.0"})).await?;
    send(&mut stdin, &json!({"method": "tools/list", "jsonrpc": "2.0", "id": 1})).await?;
    let listed = reply(&mut lines, &mut stdin, 1).await?;
    // closing the pipe and dropping the child (kill_on_drop) ends the server
    drop(stdin);
    tools_in(&listed).ok_or(ProbeError::Session)
}

/// Start the installed server the way the client would and list its tools: `{ok, tool_count, message}`.
pub async fn test_connection(client: &str, scope: Option<&str>, folder_raw: Option<&str>) -> Result<Value, Failure> {
    let env = current_env();
    let scope = scope_for(client, scope)?;
    let folder = folder(folder_raw, needs_folder(client, &scope))?;
    let found = if client == "claude-code" {
        match claude_stored(&env, &scope, folder.as_deref()) {
            Ok((_, entry)) => Ok(entry),
            Err(Stored::Mcp(err)) => Err(err),
            Err(Stored::Internal(message)) => return Err(Failure::Internal(message)),
        }
    } else {
        let path = antigravity_path(&env, &scope, folder.as_deref());
        read_json(&path).and_then(|data| servers(&data, &path)).map(|found| found.get(SERVER_NAME).cloned())
    };
    let entry = match found {
        Ok(entry) => entry,
        Err(err) => return Ok(json!({"ok": false, "tool_count": 0, "message": err.message})),
    };
    let entry = match entry {
        Some(Value::Object(entry)) if entry.get("command").is_some_and(pyjson::truthy) => entry,
        _ => return Ok(json!({"ok": false, "tool_count": 0, "message": "kanban isn't installed here yet."})),
    };

    let command = pyjson::py_str(&entry["command"]);
    let empty_list = json!([]);
    let args: Vec<String> = py_list(get_or(&entry, "args", &empty_list))?.iter().map(pyjson::py_str).collect();
    let mut extra_env = Vec::new();
    match entry.get("env") {
        Some(value) if pyjson::truthy(value) => match value {
            Value::Object(map) => {
                extra_env.extend(map.iter().map(|(k, v)| (k.clone(), pyjson::py_str(v))));
            }
            other => {
                return Err(Failure::Internal(format!(
                    "AttributeError: {} has no attribute 'items'",
                    pyjson::py_repr(other)
                )));
            }
        },
        _ => {}
    }

    let failed = |message: String| json!({"ok": false, "tool_count": 0, "message": message});
    Ok(match tokio::time::timeout(TEST_TIMEOUT, probe(&command, &args, &extra_env)).await {
        Err(_) => failed(format!("No answer within {TEST_TIMEOUT_SECONDS} seconds.")),
        Ok(Err(ProbeError::Spawn(text))) => failed(format!("Couldn't start the server: {text}")),
        Ok(Err(ProbeError::Session)) => {
            failed("Couldn't start the server: unhandled errors in a TaskGroup (1 sub-exception)".to_string())
        }
        Ok(Ok(count)) => json!({
            "ok": true,
            "tool_count": count,
            "message": format!("Connected - {count} tools available"),
        }),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shlex_and_cmdline_quote_as_python_does() {
        assert_eq!(shlex_quote("a b"), "'a b'");
        assert_eq!(shlex_quote(""), "''");
        assert_eq!(shlex_quote("it's"), "'it'\"'\"'s'");
        assert_eq!(shlex_quote("/usr/bin/uv"), "/usr/bin/uv");
        assert_eq!(shlex_quote("--env=A:b,c@d%e+f"), "--env=A:b,c@d%e+f");
        assert_eq!(shlex_quote("é"), "'é'");
        let parts = |p: &[&str]| p.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert_eq!(list2cmdline(&parts(&["a", "b c", ""])), "a \"b c\" \"\"");
        assert_eq!(list2cmdline(&parts(&["say \"hi\""])), "\"say \\\"hi\\\"\"");
        assert_eq!(list2cmdline(&parts(&["he said \"hi\"", "x\"y"])), "\"he said \\\"hi\\\"\" x\\\"y");
        // Python repeats the trailing backslashes of a quoted argument
        assert_eq!(list2cmdline(&parts(&["C:\\dir with space\\"])), "\"C:\\dir with space\\\\\"");
    }

    #[test]
    fn os_errors_read_like_pythons() {
        let err = io::Error::from_raw_os_error(2);
        assert_eq!(oserror_text(&err, "/x/y"), "[Errno 2] No such file or directory: '/x/y'");
        assert_eq!(strerror(&io::Error::from_raw_os_error(13)), "Permission denied");
    }

    #[test]
    fn python_list_and_dict_conversions() {
        assert_eq!(py_list(&json!(["a", 1])).unwrap(), vec![json!("a"), json!(1)]);
        assert_eq!(py_list(&json!("ab")).unwrap(), vec![json!("a"), json!("b")]);
        assert!(py_list(&json!(null)).is_err());
        assert_eq!(py_dict(&json!([["k", 1]])).unwrap().get("k"), Some(&json!(1)));
        assert!(py_dict(&json!(null)).is_err());
        assert!(py_dict(&json!("ab")).is_err());
    }

    #[test]
    fn the_tilde_form_of_a_path() {
        let env = Env { home: PathBuf::from("/home/me"), ..Env::from_process() };
        assert_eq!(tilde(&env, Path::new("/home/me/.claude.json")), "~/.claude.json");
        assert_eq!(tilde(&env, Path::new("/home/me")), "~/.");
        assert_eq!(tilde(&env, Path::new("/home/mex/a")), "/home/mex/a");
    }
}
