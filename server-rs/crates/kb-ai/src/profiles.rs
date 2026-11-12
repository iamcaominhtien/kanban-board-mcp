//! Separate logins of the same AI CLI, so two of them can run at the same time (AI accounts).
//!
//! How it works: a profile is a directory. Running a CLI "as" a profile means starting it with an environment that
//! points its config and login at that directory, so two profiles never share a login. Each CLI is a `Profile`
//! implementation that says which variables to set (`env`), which to remove (`dropped_env`), how to sign in
//! (`login_argv`) and how to tell whether it is signed in (`check`). To support another CLI add a type and register it in
//! `profile_for` and `CLIS`. Per-CLI details are in `.claude/scripts/ai_profile.md`.
//!
//! The login itself is kept by the CLI: in the profile's folder (`agy`, `codex`, `opencode`) or, for `claude` on macOS,
//! in the login keychain under an entry named from the folder. This module never reads a token.
//!
//! The Python module is standard library only because the developer script `.claude/scripts/ai_profile.py` loads it by
//! path; the Rust one is used by the server alone. An environment is a list of `(name, value)` pairs in the order of the
//! Python dict.

use std::collections::HashSet;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::LazyLock;
use std::time::{Duration, Instant};

use kb_base::{pyjson, pytext};
use regex::Regex;
use serde_json::{Map, Value, json};

/// The user's real home. Profiles must not change it: the agy profile swaps HOME, and some tools still need the real one.
pub fn real_home() -> PathBuf {
    kb_base::config::home_dir()
}

pub const CLIS: [&str; 4] = ["agy", "claude", "codex", "opencode"];
/// Colour codes in a CLI's output.
static ANSI_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new("\x1b\\[[0-9;]*m").expect("the colour pattern compiles"));
/// Profile names become directory names and command arguments: no slashes, no leading dot or dash. (`$` of Python
/// also matches before a final newline.)
static NAME_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^[A-Za-z0-9_][A-Za-z0-9._-]*\n?$").expect("the name pattern compiles"));
/// Codex setting: where to keep the login (file, keyring, auto).
pub const CODEX_STORE_KEY: &str = "cli_auth_credentials_store";

/// A user-facing error: one line, no traceback.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{0}")]
pub struct Fail(pub String);

/// What a profile call fails with: a `Fail`, or the operating system (`OSError`, `subprocess.TimeoutExpired`).
#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("{0}")]
    Fail(#[from] Fail),
    #[error("{0}")]
    Io(#[from] std::io::Error),
    #[error("Command timed out after 45 seconds")]
    Timeout,
}

fn fail<T>(text: impl Into<String>) -> Result<T, Error> {
    Err(Error::Fail(Fail(text.into())))
}

/// An environment: `(name, value)` pairs in the order of the Python dict.
pub type Env = Vec<(String, String)>;

/// What a CLI says about a profile's login. Only `claude` says who; the others say whether a call works.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Status {
    pub signed_in: bool,
    /// one line, as the CLI words it
    pub detail: String,
    pub email: Option<String>,
    pub plan: Option<String>,
    /// subscription | api key | ChatGPT login | Google sign-in ...
    pub method: Option<String>,
}

/// Folder that holds every profile of one CLI for the developer script. Override with `<CLI>_PROFILES_HOME`.
pub fn profiles_root(cli: &str) -> PathBuf {
    match std::env::var(format!("{}_PROFILES_HOME", cli.to_uppercase())) {
        Ok(v) if !v.is_empty() => PathBuf::from(v),
        _ => real_home().join(format!(".{cli}-profiles")),
    }
}

/// `shutil.which(cmd)` on `PATH`.
pub fn which(cmd: &str) -> Option<String> {
    let candidates: Vec<PathBuf> = if cmd.contains('/') || (cfg!(windows) && cmd.contains('\\')) {
        vec![PathBuf::from(cmd)]
    } else {
        std::env::split_paths(&std::env::var_os("PATH")?).map(|dir| dir.join(cmd)).collect()
    };
    candidates.into_iter().find(|p| is_executable(p)).map(|p| p.to_string_lossy().into_owned())
}

fn is_executable(path: &Path) -> bool {
    let Ok(meta) = std::fs::metadata(path) else { return false };
    if !meta.is_file() {
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

/// Path of the CLI to run: `<CLI>_BIN` if set, else the first match on PATH.
pub fn find_bin(cli: &str) -> Result<String, Fail> {
    let from_env = std::env::var(format!("{}_BIN", cli.to_uppercase())).ok().filter(|v| !v.is_empty());
    from_env.or_else(|| which(cli)).ok_or_else(|| Fail(format!("{cli} not found on PATH (set {}_BIN)", cli.to_uppercase())))
}

/// What a captured call gave (`subprocess.CompletedProcess` with text output).
#[derive(Debug, Clone)]
pub struct Completed {
    pub returncode: i32,
    pub stdout: String,
    pub stderr: String,
}

/// Text output as Python's text mode reads it: invalid bytes replaced, line ends turned into `\n`.
fn text_of(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).replace("\r\n", "\n").replace('\r', "\n")
}

/// `subprocess.run(argv, stdin=DEVNULL, capture_output=True, text=True, timeout=45, env=env, cwd=cwd)`.
fn run_captured(argv: &[String], env: &Env, cwd: Option<&Path>) -> Result<Completed, Error> {
    let Some((program, args)) = argv.split_first() else {
        return Err(Error::Io(std::io::Error::new(std::io::ErrorKind::InvalidInput, "empty command")));
    };
    let mut command = Command::new(program);
    command.args(args).env_clear().envs(env.iter().map(|(k, v)| (k, v))).stdin(Stdio::null());
    command.stdout(Stdio::piped()).stderr(Stdio::piped());
    if let Some(cwd) = cwd {
        command.current_dir(cwd);
    }
    let mut child = command.spawn()?;
    let mut out = child.stdout.take();
    let mut err = child.stderr.take();
    let read = |pipe: Option<impl Read + Send + 'static>| {
        std::thread::spawn(move || {
            let mut buf = Vec::new();
            if let Some(mut pipe) = pipe {
                let _ = pipe.read_to_end(&mut buf);
            }
            buf
        })
    };
    let out_reader = read(out.take());
    let err_reader = read(err.take());
    let deadline = Instant::now() + Duration::from_secs(45);
    let status = loop {
        if let Some(status) = child.try_wait()? {
            break status;
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            return Err(Error::Timeout);
        }
        std::thread::sleep(Duration::from_millis(10));
    };
    let stdout = out_reader.join().unwrap_or_default();
    let stderr = err_reader.join().unwrap_or_default();
    Ok(Completed { returncode: status.code().unwrap_or(-1), stdout: text_of(&stdout), stderr: text_of(&stderr) })
}

/// What every profile has: its name, its folder and the CLI's path.
#[derive(Debug, Clone)]
pub struct ProfileBase {
    pub name: String,
    pub dir: PathBuf,
    pub binary: Option<String>,
}

impl ProfileBase {
    /// `Profile.__init__`: `name` is directory-safe; `folder` defaults to `<profiles_root(cli)>/<name>`.
    pub fn new(cli: &str, name: &str, folder: Option<&Path>, binary: Option<&str>) -> Result<Self, Fail> {
        if name.is_empty() {
            return Err(Fail("missing profile name".into()));
        }
        if !NAME_RE.is_match(name) {
            return Err(Fail(format!("bad profile name: {}", pytext::repr(name))));
        }
        let dir = match folder {
            Some(f) if !f.as_os_str().is_empty() => f.to_path_buf(),
            _ => profiles_root(cli).join(name),
        };
        Ok(Self { name: name.to_string(), dir, binary: binary.map(str::to_string) })
    }
}

/// One account of one CLI. Implementations say how its login is kept apart from the others.
///
/// The provided methods are the plumbing every CLI shares (naming, building the environment, running the CLI); an
/// implementation overrides only what differs. Only `check` has no default.
pub trait Profile: Send + Sync {
    /// The command name, also used for `<CLI>_BIN` and `<CLI>_PROFILES_HOME`.
    fn cli(&self) -> &'static str;
    /// The arguments that start a sign-in, after the command itself.
    fn login_args(&self) -> &'static [&'static str] {
        &[]
    }
    fn base(&self) -> &ProfileBase;

    fn name(&self) -> &str {
        &self.base().name
    }
    fn dir(&self) -> &Path {
        &self.base().dir
    }

    /// The CLI to run.
    fn bin(&self) -> Result<String, Fail> {
        match self.base().binary.as_deref().filter(|b| !b.is_empty()) {
            Some(b) => Ok(b.to_string()),
            None => find_bin(self.cli()),
        }
    }

    /// Variables to set so the CLI keeps its config and login inside this profile.
    fn env(&self) -> Env {
        Vec::new()
    }

    /// Variables to remove from the caller's environment because they would override the profile's login.
    fn dropped_env(&self) -> Vec<&'static str> {
        Vec::new()
    }

    /// `base` minus `dropped_env()`, plus `env()`. Everything else (PATH, proxies) is kept.
    fn overlay(&self, base: &[(String, String)]) -> Env {
        let dropped = self.dropped_env();
        let mut env: Env = base.iter().filter(|(k, _)| !dropped.contains(&k.as_str())).cloned().collect();
        for (k, v) in self.env() {
            match env.iter_mut().find(|(name, _)| *name == k) {
                Some(slot) => slot.1 = v,
                None => env.push((k, v)),
            }
        }
        env
    }

    /// The caller's own environment with the profile applied.
    fn build_env(&self) -> Env {
        let current: Env = std::env::vars_os().map(|(k, v)| (k.to_string_lossy().into_owned(), v.to_string_lossy().into_owned())).collect();
        self.overlay(&current)
    }

    /// Run a command in the profile's environment, sharing the terminal (interactive use); returns the exit code.
    fn call(&self, argv: &[String], cwd: Option<&Path>) -> Result<i32, Error> {
        let Some((program, args)) = argv.split_first() else {
            return Err(Error::Io(std::io::Error::new(std::io::ErrorKind::InvalidInput, "empty command")));
        };
        let mut command = Command::new(program);
        command.args(args).env_clear().envs(self.build_env().iter().map(|(k, v)| (k, v)));
        if let Some(cwd) = cwd {
            command.current_dir(cwd);
        }
        Ok(command.status()?.code().unwrap_or(-1))
    }

    /// Run a command in the profile's environment with text output and no stdin, so a prompt cannot hang a status check.
    fn call_capture(&self, argv: &[String], cwd: Option<&Path>) -> Result<Completed, Error> {
        run_captured(argv, &self.build_env(), cwd)
    }

    /// Whether `create` has been run for this profile.
    fn exists(&self) -> bool {
        self.dir().is_dir()
    }

    /// Make the profile directory (and anything else the CLI needs there). `flags`: options given to `new`.
    fn create(&self, _flags: &HashSet<String>) -> Result<(), Error> {
        mkdir_parents(self.dir())
    }

    /// Called before login, run and status. For things that must be true each time, such as unlocking a keychain.
    fn prepare(&self) -> Result<(), Error> {
        Ok(())
    }

    /// Called before removal, for a login kept outside the profile directory that deleting the folder would not remove.
    fn forget(&self) {}

    /// The command that signs in. `extra` are further arguments for the CLI's own login.
    fn login_argv(&self, extra: &[String]) -> Result<Vec<String>, Fail> {
        let mut argv = vec![self.bin()?];
        argv.extend(self.login_args().iter().map(|a| a.to_string()));
        argv.extend(extra.iter().cloned());
        Ok(argv)
    }

    /// Folder to start the sign-in in, or None for the current one.
    fn login_cwd(&self) -> Option<PathBuf> {
        None
    }

    /// A line for the developer script to print before the sign-in, or None.
    fn login_hint(&self) -> Option<String> {
        None
    }

    /// Ask the CLI whether this profile is signed in. Never reads the token.
    fn check(&self) -> Result<Status, Error>;

    /// (signed in, one line to print); the developer script's exit code follows the first value.
    fn status(&self) -> Result<(bool, String), Error> {
        let st = self.check()?;
        Ok((st.signed_in, format!("{}: {}", self.name(), st.detail)))
    }

    /// What `new` tells the user to do next.
    fn next_step(&self, script: &str) -> String {
        format!("next: {script} {} login {}", self.cli(), self.name())
    }

    /// Files inside the folder that hold the login (deleted by `sign_out`); empty when the CLI uses a keychain.
    fn credential_files(&self) -> Vec<PathBuf> {
        Vec::new()
    }

    /// Make the CLI forget the login but keep the profile: ask the CLI to log out where it can, delete the file that
    /// holds the login where it cannot.
    fn sign_out(&self) {
        self.forget();
        for path in self.credential_files() {
            let _ = std::fs::remove_file(path);
        }
    }

    /// Sign out of a login kept outside the folder, then delete the folder.
    fn remove(&self) {
        self.forget();
        let _ = std::fs::remove_dir_all(self.dir());
    }
}

/// `Path.mkdir(parents=True)`: an existing last folder is an error.
fn mkdir_parents(path: &Path) -> Result<(), Error> {
    if path.exists() {
        return Err(Error::Io(std::io::Error::new(
            std::io::ErrorKind::AlreadyExists,
            format!("[Errno 17] File exists: '{}'", path.display()),
        )));
    }
    std::fs::create_dir_all(path)?;
    Ok(())
}

fn argv(parts: &[&str]) -> Vec<String> {
    parts.iter().map(|p| p.to_string()).collect()
}

/// Antigravity CLI. It keeps its data in ~/.gemini and tries to keep its Google login in the OS keychain (on macOS one
/// entry per user: service `gemini`, account `antigravity`). Two profiles sharing that entry would overwrite each other,
/// so a profile gets its own HOME. Under a swapped HOME the macOS `security` tool finds no keychain, and agy falls back
/// to keeping the login in a file inside the profile (.gemini/antigravity-cli/antigravity-oauth-token, mode 0600). That
/// fallback was seen on macOS only, from a terminal. Started from the desktop session, the failed lookup makes macOS show
/// a dialog, so on macOS a profile gets a keychain of its own (see `prepare`).
pub struct Agy(pub ProfileBase);

impl Agy {
    /// The HOME agy sees. It is the only thing in the profile directory.
    pub fn home(&self) -> PathBuf {
        self.0.dir.join("home")
    }

    /// The profile's own keychain (macOS only; see `prepare`).
    pub fn keychain(&self) -> PathBuf {
        self.home().join("Library").join("Keychains").join("login.keychain-db")
    }

    fn security(&self, args: &[&str]) -> Result<(), Error> {
        let mut full = vec!["security".to_string()];
        full.extend(args.iter().map(|a| a.to_string()));
        let result = run_captured(&full, &self.build_env(), None)?;
        if result.returncode != 0 {
            return fail(format!("cannot prepare the keychain of this profile ({} failed)", args[0]));
        }
        Ok(())
    }

    /// The MCP servers agy starts (`mcpServers`), kept in the profile's HOME.
    pub fn mcp_config(&self) -> PathBuf {
        self.home().join(".gemini").join("config").join("mcp_config.json")
    }

    /// Make sure the profile's MCP config has the server `name` exactly as `entry` says; other servers are left alone.
    /// Returns True when the file changed. agy has no per-run place for a secret, so the entry names a program that
    /// reads it from the environment of the run.
    pub fn ensure_mcp(&self, name: &str, entry: &Value) -> Result<bool, Error> {
        let path = self.mcp_config();
        let mut data = match std::fs::read_to_string(&path).ok().and_then(|t| serde_json::from_str::<Value>(&t).ok()) {
            Some(Value::Object(map)) => map,
            _ => Map::new(),
        };
        let servers = data.entry("mcpServers").or_insert_with(|| Value::Object(Map::new()));
        let Some(servers) = servers.as_object_mut() else {
            return fail("mcpServers of the profile's MCP config is not an object");
        };
        if servers.get(name) == Some(entry) {
            return Ok(false);
        }
        servers.insert(name.to_string(), entry.clone());
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let tmp = path.with_extension("tmp");
        std::fs::write(&tmp, pyjson::Dumps::new().indent(2).dump(&Value::Object(data)))?;
        std::fs::rename(&tmp, &path)?;
        Ok(true)
    }
}

impl Profile for Agy {
    fn cli(&self) -> &'static str {
        "agy"
    }
    fn base(&self) -> &ProfileBase {
        &self.0
    }

    /// HOME is swapped; git and the updater are pointed back at the real ones.
    fn env(&self) -> Env {
        let home = self.home().to_string_lossy().into_owned();
        let mut env = vec![
            ("HOME".to_string(), home.clone()),
            // git is configured under HOME too; point it back at the real file or commits lose the user's identity.
            ("GIT_CONFIG_GLOBAL".to_string(), real_home().join(".gitconfig").to_string_lossy().into_owned()),
            // An update would try to install into the profile's HOME instead of the real one.
            ("AGY_CLI_DISABLE_AUTO_UPDATE".to_string(), "1".to_string()),
        ];
        if cfg!(windows) {
            // Windows' home is not HOME (untested)
            env.push(("USERPROFILE".to_string(), home));
        }
        env
    }

    /// No desktop keyring lookup unless the profile has a keychain of its own.
    fn dropped_env(&self) -> Vec<&'static str> {
        // Without a keychain agy should use its file store, not look for a desktop keyring over D-Bus (Linux, untested).
        if self.keychain().exists() { Vec::new() } else { vec!["DBUS_SESSION_BUS_ADDRESS"] }
    }

    /// Make the HOME and link the real .ssh and .config/gh into it.
    fn create(&self, _flags: &HashSet<String>) -> Result<(), Error> {
        if cfg!(windows) {
            // The Windows credential store belongs to the Windows user, not to HOME: profiles might share one login.
            return fail("Antigravity accounts are not available on Windows (the login may not stay in the account)");
        }
        mkdir_parents(&self.home().join(".config"))?;
        // Tools agy starts (git over ssh, gh) read these under HOME. Link to the real ones, read-only in practice.
        for rel in [".ssh", ".config/gh"] {
            let source = real_home().join(rel);
            if source.exists() {
                #[cfg(unix)]
                {
                    // the tool just will not see it when the link cannot be made
                    let _ = std::os::unix::fs::symlink(&source, self.home().join(rel));
                }
            }
        }
        Ok(())
    }

    /// On macOS give the profile a keychain of its own, empty and unlocked.
    ///
    /// Under a swapped HOME there is no default keychain, and when agy asks for one from a program started inside the
    /// desktop session, macOS shows a "Keychain Not Found" dialog (from a terminal it just fails quietly and agy falls
    /// back to a file). A keychain inside the HOME makes the lookup succeed, and being the profile's own it cannot mix
    /// two accounts up. It is locked again after a restart or a long idle, so it is unlocked each time.
    fn prepare(&self) -> Result<(), Error> {
        if !cfg!(target_os = "macos") {
            return Ok(());
        }
        let keychain = self.keychain();
        let keychain_text = keychain.to_string_lossy().into_owned();
        if !keychain.exists() {
            if let Some(parent) = keychain.parent() {
                std::fs::create_dir_all(parent)?;
            }
            self.security(&["create-keychain", "-p", "", &keychain_text])?;
            // No automatic lock after a while: a run can be long.
            self.security(&["set-keychain-settings", &keychain_text])?;
        }
        self.security(&["unlock-keychain", "-p", "", &keychain_text])
    }

    /// The OAuth token file under the profile's HOME, and the profile's own keychain (where macOS keeps it).
    fn credential_files(&self) -> Vec<PathBuf> {
        vec![self.home().join(".gemini").join("antigravity-cli").join("antigravity-oauth-token"), self.keychain()]
    }

    /// agy has no login subcommand: starting it without a login opens the sign-in itself.
    fn login_argv(&self, _extra: &[String]) -> Result<Vec<String>, Fail> {
        Ok(vec![self.bin()?])
    }

    /// Which Google account to choose.
    fn login_hint(&self) -> Option<String> {
        Some(format!(
            "Sign in as the Google account for '{}' (choose it in the browser; a private window helps).",
            self.0.name
        ))
    }

    /// Start in the profile's HOME: signing in needs no project folder.
    fn login_cwd(&self) -> Option<PathBuf> {
        Some(self.home())
    }

    /// `agy models` needs a login and exits non-zero without one; it lists models and does not run one.
    fn check(&self) -> Result<Status, Error> {
        let ok = self.call_capture(&[self.bin()?, "models".to_string()], None)?.returncode == 0;
        Ok(Status {
            signed_in: ok,
            detail: if ok { "signed in" } else { "not signed in" }.to_string(),
            method: Some("Google sign-in".to_string()),
            ..Status::default()
        })
    }
}

/// `str(x)` of a JSON value that is not None.
fn py_text(value: &Value) -> String {
    pyjson::py_str(value)
}

fn truthy_text(value: Option<&Value>) -> Option<String> {
    value.filter(|v| pyjson::truthy(v)).map(py_text)
}

/// Claude Code. CLAUDE_CONFIG_DIR is the documented way to keep several logins: it holds the settings, the session
/// history and the login (on macOS the keychain entry name includes a hash of that directory).
pub struct Claude(pub ProfileBase);

impl Profile for Claude {
    fn cli(&self) -> &'static str {
        "claude"
    }
    /// The Claude subscription; Console logins are stored outside the dir.
    fn login_args(&self) -> &'static [&'static str] {
        &["auth", "login", "--claudeai"]
    }
    fn base(&self) -> &ProfileBase {
        &self.0
    }

    /// CLAUDE_CONFIG_DIR is the profile folder.
    fn env(&self) -> Env {
        vec![("CLAUDE_CONFIG_DIR".to_string(), self.0.dir.to_string_lossy().into_owned())]
    }

    /// Credential variables that outrank a saved login.
    fn dropped_env(&self) -> Vec<&'static str> {
        // Per Claude Code's docs these outrank a saved login, so one set in the caller's shell would make every profile
        // use that credential instead of its own account.
        vec!["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY"]
    }

    /// On macOS the login is a keychain entry outside the profile directory; log out so it is removed.
    fn forget(&self) {
        if let Ok(bin) = self.bin() {
            // CLI gone: nothing more can be done for the entry
            let _ = self.call_capture(&[bin, "auth".into(), "logout".into()], None);
        }
    }

    /// Parse `auth status --json`. Warnings may come before the JSON, so start at the first brace.
    fn check(&self) -> Result<Status, Error> {
        let out = self.call_capture(&[self.bin()?, "auth".into(), "status".into(), "--json".into()], None)?.stdout;
        let info: Value = match out.find('{') {
            Some(at) => serde_json::from_str(&out[at..]).unwrap_or(Value::Object(Map::new())),
            None => Value::Object(Map::new()),
        };
        let info = match info {
            Value::Object(map) => map,
            _ => Map::new(),
        };
        let ok = info.get("loggedIn").is_some_and(pyjson::truthy);
        let auth_method = info.get("authMethod");
        let method = match auth_method.map_or("None".to_string(), py_text).as_str() {
            "claude.ai" | "oauth_token" => Some("subscription".to_string()),
            _ => truthy_text(auth_method),
        };
        let plan = info.get("subscriptionType");
        let detail: Vec<String> = [auth_method, plan].into_iter().filter_map(|v| truthy_text(v)).collect();
        Ok(Status {
            signed_in: ok,
            detail: format!("{} ({})", if ok { "signed in" } else { "not signed in" }, detail.join(", ")),
            email: truthy_text(info.get("email")),
            plan: truthy_text(plan),
            method,
        })
    }
}

/// Codex CLI. CODEX_HOME holds its state and, by default, the login as auth.json.
pub struct Codex(pub ProfileBase);

impl Profile for Codex {
    fn cli(&self) -> &'static str {
        "codex"
    }
    fn login_args(&self) -> &'static [&'static str] {
        &["login"]
    }
    fn base(&self) -> &ProfileBase {
        &self.0
    }

    /// CODEX_HOME is the profile folder.
    fn env(&self) -> Env {
        vec![("CODEX_HOME".to_string(), self.0.dir.to_string_lossy().into_owned())]
    }

    /// Make the folder and keep the login in a file.
    fn create(&self, _flags: &HashSet<String>) -> Result<(), Error> {
        mkdir_parents(&self.0.dir)?;
        self.prepare()
    }

    /// Make sure the profile's config.toml keeps the login in a file.
    ///
    /// Codex can store the login in the OS keyring (setting cli_auth_credentials_store: file, keyring or auto), and its
    /// docs do not say a keyring entry is per CODEX_HOME. Forcing "file" keeps the login inside the profile on every
    /// system. Idempotent; an existing value of the setting is left alone.
    fn prepare(&self) -> Result<(), Error> {
        let config = self.0.dir.join("config.toml");
        let text = if config.exists() { std::fs::read_to_string(&config)? } else { String::new() };
        let key = Regex::new(&format!(r"(?m)^\s*{CODEX_STORE_KEY}\s*=")).expect("the setting pattern compiles");
        if !key.is_match(&text) {
            // top-level keys must come before any [table]
            std::fs::write(&config, format!("{CODEX_STORE_KEY} = \"file\"\n{text}"))?;
        }
        Ok(())
    }

    /// auth.json in CODEX_HOME.
    fn credential_files(&self) -> Vec<PathBuf> {
        vec![self.0.dir.join("auth.json")]
    }

    /// `login status` says "Logged in using ..." or "Not logged in". Codex may print warnings before that line (for
    /// example about PATH aliases when the profile is under /tmp), so look for the answer, not the first line.
    fn check(&self) -> Result<Status, Error> {
        let out = self.call_capture(&[self.bin()?, "login".into(), "status".into()], None)?;
        let all = format!("{}{}", out.stdout, out.stderr);
        let lines: Vec<&str> = pytext::splitlines(&all).into_iter().map(pytext::strip).filter(|l| !l.is_empty()).collect();
        let answer = lines.iter().find(|l| l.starts_with("Logged in") || l.starts_with("Not logged in")).copied();
        let text = answer.or_else(|| lines.first().copied()).unwrap_or("no answer").to_string();
        let ok = answer.is_some_and(|a| a.starts_with("Logged in"));
        let method = ok.then(|| text.chars().skip("Logged in using ".chars().count()).collect::<String>());
        Ok(Status { signed_in: ok, detail: text, method, ..Status::default() })
    }
}

/// opencode. It follows the XDG directories: login in $XDG_DATA_HOME/opencode/auth.json, config under $XDG_CONFIG_HOME.
/// Its free models (opencode/*-free) work with no login, so a profile may have no credentials.
pub struct Opencode(pub ProfileBase);

impl Profile for Opencode {
    fn cli(&self) -> &'static str {
        "opencode"
    }
    fn login_args(&self) -> &'static [&'static str] {
        &["auth", "login"]
    }
    fn base(&self) -> &ProfileBase {
        &self.0
    }

    /// The four XDG folders live inside the profile.
    fn env(&self) -> Env {
        let sub = |name: &str| self.0.dir.join(name).to_string_lossy().into_owned();
        vec![
            ("XDG_DATA_HOME".to_string(), sub("data")),
            ("XDG_CONFIG_HOME".to_string(), sub("config")),
            ("XDG_CACHE_HOME".to_string(), sub("cache")),
            ("XDG_STATE_HOME".to_string(), sub("state")),
        ]
    }

    /// Make the four XDG folders.
    fn create(&self, _flags: &HashSet<String>) -> Result<(), Error> {
        for sub in ["data", "config", "cache", "state"] {
            mkdir_parents(&self.0.dir.join(sub))?;
        }
        Ok(())
    }

    /// auth.json under XDG_DATA_HOME.
    fn credential_files(&self) -> Vec<PathBuf> {
        vec![self.0.dir.join("data").join("opencode").join("auth.json")]
    }

    /// Free models need no login.
    fn next_step(&self, script: &str) -> String {
        format!("free models need no login: {script} opencode run {} run -m opencode/<model>-free \"...\"", self.0.name)
    }

    /// Always signed in: without credentials the free models still work. Counts the stored credentials.
    fn check(&self) -> Result<Status, Error> {
        let out = self.call_capture(&[self.bin()?, "auth".into(), "list".into()], None)?;
        let plain = ANSI_RE.replace_all(&format!("{}{}", out.stdout, out.stderr), "").into_owned();
        let count: u64 = Regex::new(r"([0-9]+) credentials?")
            .expect("the count pattern compiles")
            .captures(&plain)
            .and_then(|c| c[1].parse().ok())
            .unwrap_or(0);
        Ok(Status {
            signed_in: true,
            detail: format!("{count} stored credential(s); free models need none"),
            method: Some(if count > 0 { "API key or OAuth" } else { "free models" }.to_string()),
            ..Status::default()
        })
    }
}

/// The Profile object of `cli` (does not create anything).
pub fn profile_for(cli: &str, name: &str, folder: Option<&Path>, binary: Option<&str>) -> Result<Box<dyn Profile>, Fail> {
    if !CLIS.contains(&cli) {
        return Err(Fail(format!("unknown CLI '{cli}' (use one of: {})", CLIS.join(", "))));
    }
    let base = ProfileBase::new(cli, name, folder, binary)?;
    Ok(match cli {
        "agy" => Box::new(Agy(base)),
        "claude" => Box::new(Claude(base)),
        "codex" => Box::new(Codex(base)),
        _ => Box::new(Opencode(base)),
    })
}

/// `PROFILE_CLASSES` keys, for a caller that lists them.
pub fn profile_classes() -> Value {
    json!(CLIS)
}
