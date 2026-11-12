//! Skills and plugins installed from a source (design/screens/ai-team-process.md, B; plan D1-D3). Port of
//! `services/ai/plugins.py`.
//!
//! A plugin comes from a git URL, a marketplace (a repository with `.claude-plugin/marketplace.json`) or a folder on
//! this computer. Installing has no review step (D1): the board records the source and the commit, shows what changed
//! before an update, and one button puts the previous version back. The installed copy lives in the board's data
//! folder (`plugin-cache/<id>/<commit>`) and reaches a run as `--plugin-dir` (spike S1: skills are used under `-p`;
//! S3: hooks run; S4: ten plugins cost no start-up time).
//!
//! Layouts understood, as found in the catalogue's repositories:
//! - a plugin at the root (`.claude-plugin/plugin.json`), e.g. `nextlevelbuilder/ui-ux-pro-max-skill`;
//! - a marketplace whose entry is a folder (`"source": "./design"`), e.g. `anthropics/knowledge-work-plugins`;
//! - a marketplace whose entry lists skills of the repository (`"source": "./", "skills": [...]`), e.g.
//!   `anthropics/skills`: a subset of those skills can be installed as a plugin of its own;
//! - a folder with `skills/` and no manifest, or a single `SKILL.md`.
//!
//! Who gets it: the project default (on or off), the roles it is suggested for, and a switch per member.
//!
//! The git commands (`clone`, `checkout`, `rev-parse`, `ls-remote`) are child processes with the timeouts and the
//! environment the Python code gives them (`GIT_TERMINAL_PROMPT=0`); a child that outlives its timeout is killed and
//! waited for. The catalogue is in `text/catalogue.json`.

use std::collections::HashMap;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{LazyLock, Mutex};
use std::time::Duration;

use kb_base::{pyjson, pytext};
use kb_db::Session;
use kb_db::database;
use kb_db::entities::ai_plugin;
use kb_db::sea_orm::ActiveValue::Set;
use kb_db::sea_orm::{ActiveModelTrait, ColumnTrait, DbErr, EntityTrait, ModelTrait, QueryFilter};
use serde_json::{Map, Value, json};
use tokio::process::Command;
use tokio::sync::watch;

mod build;
mod switches;

pub use build::{Built, IGNORED, PluginInfo, build, manifest, skill_dirs, source_name};
pub use switches::{
    catalogue_entry_for, dirs_for, on_for, role_of, set_member, skills_block, team_role_keys, to_dict, usage,
};

/// The most a plugin may copy into the board's cache (checked before anything is copied).
pub const MAX_PLUGIN_BYTES: u64 = 50 * 1024 * 1024;

/// The "Suggested for a role" catalogue (D2, D16): what each role is suggested to install.
pub static CATALOGUE: LazyLock<Vec<Map<String, Value>>> =
    LazyLock::new(|| serde_json::from_str(include_str!("../text/catalogue.json")).unwrap_or_default());

/// What a function of this module fails with.
#[derive(Debug)]
pub enum Error {
    /// `PluginError`: a plugin could not be read, installed or updated; the text is what a person reads.
    Plugin(String),
    /// The database call failed.
    Db(DbErr),
    /// The operating system refused (`OSError`, a missing `git`, `subprocess.TimeoutExpired`).
    Io(std::io::Error),
}

impl From<DbErr> for Error {
    fn from(err: DbErr) -> Self {
        Error::Db(err)
    }
}

impl From<std::io::Error> for Error {
    fn from(err: std::io::Error) -> Self {
        Error::Io(err)
    }
}

impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Error::Plugin(text) => f.write_str(text),
            Error::Db(err) => write!(f, "{err}"),
            Error::Io(err) => write!(f, "{err}"),
        }
    }
}

/// `raise PluginError(text)`.
pub(crate) fn plugin_err<T>(text: impl Into<String>) -> Result<T, Error> {
    Err(Error::Plugin(text.into()))
}

fn is_commit(text: &str) -> bool {
    // `re.fullmatch(r"[0-9a-f]{7,40}", text)`
    (7..=40).contains(&text.len()) && text.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

// Installs still running per project (a pack's plugins install in the background when a member is made from it): a run
// waits for them before it lists its plugin folders, or the first run of a new member would start without them.
static PENDING: LazyLock<Mutex<HashMap<String, Vec<watch::Receiver<bool>>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));
/// `SETTLE_SECONDS`.
pub const SETTLE_SECONDS: u64 = 180;

/// Run an install in the background and remember it until it ends; its failure is logged, never raised.
pub fn installing<F>(project_id: &str, fut: F)
where
    F: Future<Output = Result<(), Error>> + Send + 'static,
{
    let Ok(_handle) = tokio::runtime::Handle::try_current() else {
        // no loop (a sync caller in a test): nothing to schedule
        return;
    };
    let (done_tx, done_rx) = watch::channel(false);
    PENDING.lock().unwrap_or_else(|e| e.into_inner()).entry(project_id.to_string()).or_default().push(done_rx);
    let project = project_id.to_string();
    kb_base::ctx::spawn(async move {
        // a plugin that fails to install never breaks the member it came with
        if let Err(err) = fut.await {
            tracing::error!("Installing plugins on {project} failed: {err}");
        }
        let _ = done_tx.send(true);
        let mut pending = PENDING.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(list) = pending.get_mut(&project) {
            list.retain(|rx| !*rx.borrow());
        }
    });
}

/// Wait for the project's running installs (at most `timeout` seconds). False when some were still running.
pub async fn settled(project_id: &str, timeout: Duration) -> bool {
    let waiting: Vec<watch::Receiver<bool>> = PENDING
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(project_id)
        .map(|l| l.iter().filter(|rx| !*rx.borrow()).cloned().collect())
        .unwrap_or_default();
    if waiting.is_empty() {
        return true;
    }
    let all = async {
        for mut rx in waiting.clone() {
            // `Err`: the sender is gone, which means the task ended
            let _ = rx.wait_for(|done| *done).await;
        }
    };
    let finished = tokio::time::timeout(timeout, all).await.is_ok();
    if !finished {
        let still = waiting.iter().filter(|rx| !*rx.borrow()).count();
        tracing::warn!("A run on {project_id} started while {still} plugin installs were still running");
    }
    finished
}

fn now() -> String {
    kb_base::time::now_iso()
}

/// `plugin-cache` beside the database.
pub fn cache_root() -> std::io::Result<PathBuf> {
    let base = database::get_db_path().parent().map(Path::to_path_buf).unwrap_or_default().join("plugin-cache");
    std::fs::create_dir_all(&base)?;
    Ok(base)
}

/// What a finished child printed.
#[derive(Debug, Clone)]
pub struct Output {
    /// The exit code (-1 for a child ended by a signal).
    pub returncode: i32,
    /// What it printed on stdout.
    pub stdout: String,
    /// What it printed on stderr.
    pub stderr: String,
}

fn universal_newlines(bytes: &[u8]) -> String {
    kb_skills::assets::decode_text(bytes)
}

/// `_run(args, cwd, timeout)`: a command with its output captured; `GIT_TERMINAL_PROMPT=0` so git never asks for a
/// password. A child that outlives `timeout` is killed and waited for.
pub async fn run(args: &[&str], cwd: Option<&Path>, timeout: Duration) -> Result<Output, Error> {
    let Some((program, rest)) = args.split_first() else {
        return plugin_err("No command.");
    };
    let mut command = Command::new(program);
    command
        .args(rest)
        .env("GIT_TERMINAL_PROMPT", "0")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    if let Some(cwd) = cwd {
        command.current_dir(cwd);
    }
    let mut child = command.spawn()?;
    let (Some(mut stdout), Some(mut stderr)) = (child.stdout.take(), child.stderr.take()) else {
        return plugin_err("The command has no output.");
    };
    use tokio::io::AsyncReadExt;
    let work = async {
        let mut out = Vec::new();
        let mut err = Vec::new();
        let (a, b, status) = tokio::join!(stdout.read_to_end(&mut out), stderr.read_to_end(&mut err), child.wait());
        a?;
        b?;
        Ok::<_, std::io::Error>((out, err, status?))
    };
    match tokio::time::timeout(timeout, work).await {
        Ok(done) => {
            let (out, err, status) = done?;
            Ok(Output {
                returncode: status.code().unwrap_or(-1),
                stdout: universal_newlines(&out),
                stderr: universal_newlines(&err),
            })
        }
        Err(_elapsed) => {
            // never left behind
            let _ = child.start_kill();
            let _ = child.wait().await;
            Err(Error::Io(std::io::Error::new(
                std::io::ErrorKind::TimedOut,
                format!("Command '{}' timed out after {} seconds", args.join(" "), timeout.as_secs()),
            )))
        }
    }
}

/// The default timeout of `_run`.
const RUN_TIMEOUT: Duration = Duration::from_secs(300);

/// Shallow clone of `url` at `ref` (a tag, branch or commit); returns the commit.
pub async fn clone(url: &str, ref_: Option<&str>, into: &Path) -> Result<String, Error> {
    let ref_ = ref_.filter(|r| !r.is_empty());
    let into_s = into.to_string_lossy().into_owned();
    let out = match ref_ {
        Some(r) if is_commit(r) => {
            let mut out = run(&["git", "clone", "-q", "--", url, &into_s], None, RUN_TIMEOUT).await?;
            if out.returncode == 0 {
                out = run(&["git", "checkout", "-q", r], Some(into), RUN_TIMEOUT).await?;
            }
            out
        }
        _ => {
            let mut args: Vec<&str> = vec!["git", "clone", "-q", "--depth", "1"];
            if let Some(r) = ref_ {
                args.push("--branch");
                args.push(r);
            }
            // a URL that starts with "-" is never read as an option
            args.push("--");
            args.push(url);
            args.push(&into_s);
            run(&args, None, RUN_TIMEOUT).await?
        }
    };
    if out.returncode != 0 {
        let at = ref_.map(|r| format!("@{r}")).unwrap_or_default();
        let why: String = pytext::strip(&out.stderr).chars().take(240).collect();
        return plugin_err(format!("Could not get {url}{at}: {why}"));
    }
    let head = run(&["git", "rev-parse", "HEAD"], Some(into), RUN_TIMEOUT).await?;
    Ok(pytext::strip(&head.stdout).to_string())
}

/// The source as a local checkout: (folder, commit or None for a plain folder).
pub async fn fetch(
    source_kind: &str,
    source: &str,
    ref_: Option<&str>,
    workdir: &Path,
) -> Result<(PathBuf, Option<String>), Error> {
    if source_kind == "folder" {
        let folder = PathBuf::from(kb_base::pypath::expanduser(source));
        if !folder.is_dir() {
            return plugin_err(format!("No such folder: {source}"));
        }
        let mut commit = None;
        if folder.join(".git").exists() {
            let out = run(&["git", "rev-parse", "HEAD"], Some(&folder), RUN_TIMEOUT).await?;
            let text = pytext::strip(&out.stdout).to_string();
            commit = if text.is_empty() { None } else { Some(text) };
        }
        return Ok((folder, commit));
    }
    let dest = workdir.join("checkout");
    let commit = clone(source, ref_, &dest).await?;
    Ok((dest, Some(commit)))
}

fn temp_dir() -> std::io::Result<tempfile::TempDir> {
    tempfile::Builder::new().prefix("kanban-plugin-").tempdir()
}

/// `asyncio.to_thread(build, ...)`.
async fn build_blocking(
    checkout: PathBuf,
    plugin: Option<String>,
    skills: Option<Vec<String>>,
    into: PathBuf,
    name_hint: Option<String>,
) -> Result<Built, Error> {
    match tokio::task::spawn_blocking(move || {
        build(&checkout, plugin.as_deref(), skills.as_deref(), &into, name_hint.as_deref())
    })
    .await
    {
        Ok(result) => result,
        Err(err) => Err(Error::Io(std::io::Error::other(err.to_string()))),
    }
}

async fn copy_blocking(from: PathBuf, to: PathBuf) -> Result<(), Error> {
    match tokio::task::spawn_blocking(move || build::copy_tree(&from, &to, false)).await {
        Ok(result) => Ok(result?),
        Err(err) => Err(Error::Io(std::io::Error::other(err.to_string()))),
    }
}

/// What would be installed, without installing: name, version, skills, hooks, MCP servers, size, the commit.
pub async fn preview(
    source_kind: &str,
    source: &str,
    ref_: Option<&str>,
    plugin: Option<&str>,
    skills: Option<&[String]>,
) -> Result<Map<String, Value>, Error> {
    let tmp = temp_dir()?;
    let (checkout, commit) = fetch(source_kind, source, ref_, tmp.path()).await?;
    let built = build_blocking(
        checkout,
        plugin.map(str::to_string),
        skills.map(<[String]>::to_vec),
        tmp.path().join("built"),
        None,
    )
    .await?;
    let mut out = match built {
        Built::Choices(choices) => {
            let mut m = Map::new();
            m.insert("choices".into(), Value::Array(choices));
            m
        }
        Built::Plugin(info) => info_map(&info),
    };
    out.insert("commit".into(), json!(commit));
    Ok(out)
}

fn info_map(info: &PluginInfo) -> Map<String, Value> {
    let mut m = Map::new();
    m.insert("name".into(), json!(info.name));
    m.insert("version".into(), json!(info.version));
    m.insert("description".into(), json!(info.description));
    m.insert("skills".into(), json!(info.skills));
    m.insert("hooks".into(), json!(info.hooks));
    m.insert("mcp".into(), json!(info.mcp));
    m.insert("size_bytes".into(), json!(info.size_bytes));
    m
}

/// What `install` takes beside the session and the project.
#[derive(Debug, Clone, Default)]
pub struct InstallOpts<'a> {
    /// "git", "marketplace" or "folder".
    pub source_kind: &'a str,
    /// The URL or the folder.
    pub source: &'a str,
    /// A tag, a branch or a commit.
    pub ref_: Option<&'a str>,
    /// The marketplace entry to install.
    pub plugin: Option<&'a str>,
    /// A subset of the skills of the repository.
    pub skills: Option<Vec<String>>,
    /// The roles it is suggested for.
    pub roles: Option<Vec<String>>,
    /// On for every member unless switched off.
    pub default_on: bool,
    /// Who installs it.
    pub by: &'a str,
}

fn json_list(items: Option<&[String]>) -> String {
    pyjson::dumps(&items.map(<[String]>::to_vec).unwrap_or_default())
}

/// Install a plugin for the project (no review step, D1): copied into the board's cache at its commit.
pub async fn install(session: &Session, project_id: &str, opts: InstallOpts<'_>) -> Result<ai_plugin::Model, Error> {
    if !["git", "marketplace", "folder"].contains(&opts.source_kind) {
        return plugin_err("A source is a git URL, a marketplace or a folder.");
    }
    let tmp = temp_dir()?;
    let (checkout, commit) = fetch(opts.source_kind, opts.source, opts.ref_, tmp.path()).await?;
    let staging = tmp.path().join("built");
    let skills_wanted = opts.skills.clone().filter(|s| !s.is_empty());
    let built = build_blocking(
        checkout,
        opts.plugin.map(str::to_string),
        skills_wanted.clone(),
        staging.clone(),
        Some(source_name(opts.source)),
    )
    .await?;
    let info = match built {
        Built::Choices(_) => return plugin_err("This is a marketplace: pick which plugin to install."),
        Built::Plugin(info) => info,
    };
    let same = ai_plugin::Entity::find()
        .filter(ai_plugin::Column::ProjectId.eq(project_id))
        .filter(ai_plugin::Column::Name.eq(info.name.as_str()))
        .one(session)
        .await?;
    if same.is_some() {
        return plugin_err(format!("{} is already installed on this project.", info.name));
    }
    let mut row = ai_plugin::new();
    let id = match &row.id {
        Set(id) => id.clone(),
        _ => String::new(),
    };
    row.project_id = Set(Some(project_id.to_string()));
    row.name = Set(info.name.clone());
    row.source_kind = Set(opts.source_kind.to_string());
    row.source = Set(opts.source.to_string());
    row.r#ref = Set(opts.ref_.map(str::to_string));
    row.plugin = Set(opts.plugin.map(str::to_string));
    row.skills_wanted = Set(json_list(skills_wanted.as_deref()));
    row.commit = Set(commit.clone());
    row.version = Set(info.version.clone());
    row.description = Set(info.description.clone());
    row.skills = Set(pyjson::dumps(&info.skills));
    row.hooks = Set(info.hooks);
    row.mcp = Set(info.mcp);
    row.size_bytes = Set(info.size_bytes as i32);
    row.default_on = Set(opts.default_on);
    row.roles = Set(json_list(opts.roles.as_deref().filter(|r| !r.is_empty())));
    row.installed_by = Set(Some(opts.by.to_string()));
    row.pinned = Set(opts.ref_.is_some_and(is_commit));
    let dest = cache_root()?.join(&id).join(commit.as_deref().unwrap_or("folder"));
    if dest.exists() {
        let _ = std::fs::remove_dir_all(&dest);
    }
    copy_blocking(staging, dest.clone()).await?;
    row.path = Set(Some(dest.to_string_lossy().into_owned()));
    let saved = row.insert(session).await?;
    session.commit().await?;
    Ok(saved)
}

/// `loads(text, default)` of the stored JSON columns.
pub(crate) fn loads(text: Option<&str>, default: Value) -> Value {
    kb_ai::store::loads(text, default)
}

async fn reinstall(
    session: &Session,
    row: ai_plugin::Model,
    ref_: Option<&str>,
    keep_previous: bool,
) -> Result<ai_plugin::Model, Error> {
    let tmp = temp_dir()?;
    let (checkout, commit) = fetch(&row.source_kind, &row.source, ref_, tmp.path()).await?;
    let staging = tmp.path().join("built");
    let wanted: Option<Vec<String>> = match loads(Some(&row.skills_wanted), json!([])) {
        Value::Array(items) if !items.is_empty() => {
            Some(items.iter().map(|v| v.as_str().map(str::to_string).unwrap_or_else(|| pyjson::py_str(v))).collect())
        }
        _ => None,
    };
    let built = build_blocking(checkout, row.plugin.clone(), wanted, staging.clone(), None).await?;
    let Built::Plugin(info) = built else {
        return plugin_err("This is a marketplace: pick which plugin to install.");
    };
    let folder = match &commit {
        Some(c) => c.clone(),
        None => format!("folder-{}", chrono_secs()),
    };
    let dest = cache_root()?.join(&row.id).join(folder);
    if dest.exists() {
        let _ = std::fs::remove_dir_all(&dest);
    }
    copy_blocking(staging, dest.clone()).await?;
    drop(tmp);
    let dest_text = dest.to_string_lossy().into_owned();
    let mut active = ai_plugin::ActiveModel::from(row.clone());
    match row.path.as_deref().filter(|p| !p.is_empty()) {
        Some(path) if keep_previous => {
            active.previous = Set(Some(pyjson::dumps(&json!({
                "path": path,
                "commit": row.commit,
                "version": row.version,
                "skills": loads(Some(&row.skills), json!([])),
            }))));
        }
        Some(path) if path != dest_text => {
            let _ = std::fs::remove_dir_all(path);
        }
        _ => {}
    }
    active.path = Set(Some(dest_text));
    active.commit = Set(commit);
    active.version = Set(info.version.clone());
    active.skills = Set(pyjson::dumps(&info.skills));
    active.hooks = Set(info.hooks);
    active.mcp = Set(info.mcp);
    active.size_bytes = Set(info.size_bytes as i32);
    active.updated_at = Set(now());
    let saved = active.update(session).await?;
    session.commit().await?;
    Ok(saved)
}

/// `int(datetime.now(UTC).timestamp())`.
fn chrono_secs() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

/// The source's newest commit (on its ref, or the default branch), or None for a folder or when it cannot tell.
pub async fn latest_commit(row: &ai_plugin::Model) -> Result<Option<String>, Error> {
    if row.source_kind == "folder" {
        return Ok(None);
    }
    let want = row.r#ref.as_deref().filter(|r| !r.is_empty()).unwrap_or("HEAD");
    let out = run(&["git", "ls-remote", "--", &row.source, want], None, Duration::from_secs(60)).await?;
    let first = pytext::split(&out.stdout).first().map(|s| s.to_string());
    Ok(if out.returncode == 0 { first } else { None })
}

/// Whether a newer version is out (never applied on its own); a pinned plugin is never offered one.
pub async fn check_update(row: &ai_plugin::Model) -> Result<Value, Error> {
    if row.pinned {
        return Ok(json!({"update": false, "pinned": true}));
    }
    let newest = latest_commit(row).await?;
    let update = match (&newest, &row.commit) {
        (Some(n), Some(c)) => !n.is_empty() && !c.is_empty() && n != c,
        _ => false,
    };
    Ok(json!({"update": update, "latest": newest, "current": row.commit}))
}

/// Every file below `root` as (relative path, bytes).
fn read_tree(root: &Path) -> HashMap<String, Vec<u8>> {
    let mut all = Vec::new();
    build::rglob_all(root, &mut all);
    all.into_iter()
        .filter(|p| p.is_file())
        .filter_map(|p| {
            let rel = p.strip_prefix(root).ok()?.to_string_lossy().into_owned();
            Some((rel, std::fs::read(&p).ok()?))
        })
        .collect()
}

/// What an update would change: files added, removed and changed between the installed copy and the newest.
pub async fn changes(row: &ai_plugin::Model) -> Result<Value, Error> {
    let tmp = temp_dir()?;
    let ref_ = if row.pinned { row.r#ref.as_deref() } else { None };
    let (checkout, commit) = fetch(&row.source_kind, &row.source, ref_, tmp.path()).await?;
    let built = tmp.path().join("built");
    let wanted: Option<Vec<String>> = match loads(Some(&row.skills_wanted), json!([])) {
        Value::Array(items) if !items.is_empty() => {
            Some(items.iter().filter_map(|v| v.as_str().map(str::to_string)).collect())
        }
        _ => None,
    };
    build_blocking(checkout, row.plugin.clone(), wanted, built.clone(), None).await?;
    let old_path = row.path.clone().filter(|p| !p.is_empty() && Path::new(p).is_dir());
    let (old, new) = tokio::task::spawn_blocking(move || {
        let old = old_path.map(|p| read_tree(Path::new(&p))).unwrap_or_default();
        (old, read_tree(&built))
    })
    .await
    .map_err(|e| Error::Io(std::io::Error::other(e.to_string())))?;
    let sorted = |mut v: Vec<String>| {
        v.sort();
        v
    };
    Ok(json!({
        "commit": commit,
        "added": sorted(new.keys().filter(|k| !old.contains_key(*k)).cloned().collect()),
        "removed": sorted(old.keys().filter(|k| !new.contains_key(*k)).cloned().collect()),
        "changed": sorted(new.iter().filter(|(k, v)| old.get(*k).is_some_and(|o| o != *v)).map(|(k, _)| k.clone()).collect()),
    }))
}

/// Install the newest version; the previous one is kept so one button can put it back.
pub async fn update(session: &Session, row: ai_plugin::Model) -> Result<ai_plugin::Model, Error> {
    if row.pinned {
        return plugin_err(format!("{} is pinned: unpin it to update.", row.name));
    }
    let ref_ = row.r#ref.clone();
    reinstall(session, row, ref_.as_deref(), true).await
}

/// Put the previous version back.
pub async fn rollback(session: &Session, row: ai_plugin::Model) -> Result<ai_plugin::Model, Error> {
    let prev = loads(row.previous.as_deref(), Value::Null);
    let prev_path = prev.get("path").and_then(Value::as_str).unwrap_or("");
    let Value::Object(prev) = prev.clone() else {
        return plugin_err("There is no previous version to put back.");
    };
    if prev.is_empty() || !Path::new(prev_path).is_dir() {
        return plugin_err("There is no previous version to put back.");
    }
    let current = json!({
        "path": row.path,
        "commit": row.commit,
        "version": row.version,
        "skills": loads(Some(&row.skills), json!([])),
    });
    let mut active = ai_plugin::ActiveModel::from(row);
    active.path = Set(Some(prev_path.to_string()));
    active.commit = Set(prev.get("commit").and_then(Value::as_str).map(str::to_string));
    active.version = Set(prev.get("version").and_then(Value::as_str).map(str::to_string));
    active.skills =
        Set(pyjson::dumps(&prev.get("skills").filter(|v| pyjson::truthy(v)).cloned().unwrap_or_else(|| json!([]))));
    active.previous = Set(Some(pyjson::dumps(&current)));
    active.updated_at = Set(now());
    let saved = active.update(session).await?;
    session.commit().await?;
    Ok(saved)
}

/// Re-read the source (a folder's current files, or the same commit of a repository).
pub async fn reload(session: &Session, row: ai_plugin::Model) -> Result<ai_plugin::Model, Error> {
    let ref_ = if row.source_kind != "folder" { row.commit.clone() } else { None };
    reinstall(session, row, ref_.as_deref(), false).await
}

/// Back to the catalogue version: the recorded commit, freshly copied, dropping anything changed locally.
pub async fn reset(session: &Session, row: ai_plugin::Model) -> Result<ai_plugin::Model, Error> {
    reload(session, row).await
}

/// Pin to the installed commit (no update is offered until unpinned).
pub async fn pin(session: &Session, row: ai_plugin::Model, on: bool) -> Result<ai_plugin::Model, Error> {
    let mut active = ai_plugin::ActiveModel::from(row.clone());
    active.pinned = Set(on);
    if on && row.commit.as_deref().is_some_and(|c| !c.is_empty()) {
        active.r#ref = Set(row.commit.clone());
    } else if !on && row.r#ref.as_deref().is_some_and(is_commit) {
        active.r#ref = Set(None);
    }
    let saved = active.update(session).await?;
    session.commit().await?;
    Ok(saved)
}

/// Uninstall: the row and every cached copy.
pub async fn remove(session: &Session, row: ai_plugin::Model) -> Result<(), Error> {
    let _ = std::fs::remove_dir_all(cache_root()?.join(&row.id));
    row.delete(session).await?;
    session.commit().await?;
    Ok(())
}
