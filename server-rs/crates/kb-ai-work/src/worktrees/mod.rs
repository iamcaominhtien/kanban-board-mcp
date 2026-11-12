//! Where an AI works: one git worktree per ticket, and handing the code over
//! (design/screens/ai-operations.md, I, J, K; plan D4, D6, D7). Port of `services/ai/worktrees.py`.
//!
//! - One worktree per ticket, not per member: Dev, Reviewer and Tester of a ticket use it one after another.
//! - Beside the repository, never inside it: `<repo>.worktrees/<KEY>` (a worktree under the checkout shows as
//!   untracked files, and a local merge is refused while the main folder is dirty).
//! - A fixed path (`--resume` needs the same folder), a branch `ai/<KEY>-<slug>`, a port of its own, and the
//!   project's prepare command run once when it is made.
//! - Never removed while something is uncommitted.
//! - Hand-over by project setting: open a pull request (draft at Review, ready at Done), merge on this machine (only when
//!   a person asks: moving to Done or the Merge button, never while the main checkout is dirty, a conflict is rolled
//!   back and becomes a Needs you row), or leave the branch (pushed). Guessed from the remote when set to auto.
//!
//! Projects turn this on in their AI team settings (`ops.worktrees.on`); off, runs keep the member's own folder.
//!
//! The module is split by what it does: this file holds the git calls, the worktree itself and its rows;
//! `outputs` the files a run leaves that are not code; `handover` the pull request, the merge and the status hooks.
//! Every `pub` function of the Python module is `pub` here under its name (a `_private` one that another function of
//! the module calls is `pub(crate)`).

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex};

use kb_base::{pypath, pytext, time};
use kb_db::Session;
use kb_db::entities::{ai_worktree, ticket};
use kb_db::sea_orm::{ColumnTrait, DbErr, EntityTrait, QueryFilter, QueryOrder};
use serde_json::{Map, Value, json};
use unicode_normalization::UnicodeNormalization;

use crate::proc::{self, Captured, ProcError, Spec};

mod handover;
mod outputs;

pub use handover::{
    Handover, after_run, clear_deferred, guess_route, merge, on_review, on_status, route_for, set_handover, tidy_later,
};
pub use outputs::{
    MoveOutcome, commit_now, is_output, log_tidy, move_outputs, note_for, note_text, outputs_in, tidy_after_run,
};

/// `PORT_SPAN`: a worktree's port is the first free one from the project's base port up to this many above it.
pub const PORT_SPAN: i32 = 19;
/// `PREPARE_TIMEOUT_S`: the most a prepare command may take.
pub const PREPARE_TIMEOUT_S: u64 = 15 * 60;

/// What a function of this module fails with.
#[derive(Debug)]
pub enum Error {
    /// `WorktreeError`: the worktree could not be made or used: a board fault, not the AI's.
    Worktree(String),
    /// `WorktreeNeedsYou` (a `WorktreeError`): the worktree cannot be made until a person sets the repository up (it
    /// has no commit yet): trying again on its own would only fail the same way.
    NeedsYou(String),
    /// The database call failed.
    Db(DbErr),
    /// Any other exception: an `OSError`, a `TimeoutExpired`, what the Workspace or the work log raised.
    Other(String),
}

impl Error {
    /// Whether Python's `except WorktreeError` catches it (`WorktreeNeedsYou` is a subclass).
    pub fn is_worktree_error(&self) -> bool {
        matches!(self, Error::Worktree(_) | Error::NeedsYou(_))
    }
}

impl From<DbErr> for Error {
    fn from(err: DbErr) -> Self {
        Error::Db(err)
    }
}

impl From<ProcError> for Error {
    fn from(err: ProcError) -> Self {
        Error::Other(err.to_string())
    }
}

impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Error::Worktree(text) | Error::NeedsYou(text) | Error::Other(text) => f.write_str(text),
            Error::Db(err) => write!(f, "{err}"),
        }
    }
}

impl std::error::Error for Error {}

/// `raise WorktreeError(text)`.
pub(crate) fn fail<T>(text: impl Into<String>) -> Result<T, Error> {
    Err(Error::Worktree(text.into()))
}

fn now() -> String {
    time::now_iso()
}

// The board's own commits (a merge, what an AI left uncommitted) when the repository has no identity of its own;
// a person's configured name and email always win
const BOARD_IDENTITY: [(&str, &str); 4] = [
    ("GIT_AUTHOR_NAME", "Kanban Board"),
    ("GIT_AUTHOR_EMAIL", "kanban-board@localhost"),
    ("GIT_COMMITTER_NAME", "Kanban Board"),
    ("GIT_COMMITTER_EMAIL", "kanban-board@localhost"),
];

static HAS_IDENTITY: LazyLock<Mutex<HashMap<String, bool>>> = LazyLock::new(|| Mutex::new(HashMap::new()));

/// `_identity_env(cwd)`: the board's identity when the repository has none and the environment sets none.
async fn identity_env(cwd: &str) -> Vec<(String, String)> {
    let known = HAS_IDENTITY.lock().unwrap_or_else(|e| e.into_inner()).get(cwd).copied();
    let has = match known {
        Some(has) => has,
        None => {
            let spec = Spec { cwd: Some(cwd), ..Spec::default() };
            let argv = ["git".to_string(), "config".to_string(), "user.email".to_string()];
            let has = match proc::run(&argv, &spec, 20.0).await {
                Ok(out) => !pytext::strip(&out.stdout).is_empty(),
                Err(_) => true,
            };
            HAS_IDENTITY.lock().unwrap_or_else(|e| e.into_inner()).insert(cwd.to_string(), has);
            has
        }
    };
    if has || BOARD_IDENTITY.iter().any(|(k, _)| std::env::var_os(k).is_some()) {
        return Vec::new();
    }
    BOARD_IDENTITY.iter().map(|(k, v)| ((*k).to_string(), (*v).to_string())).collect()
}

/// `git(cwd, *args, timeout=, check=)`: run git in `cwd`. A failure with `check` is a `WorktreeError`; a git that
/// cannot run or does not finish in `timeout` seconds is the `OSError` / `TimeoutExpired` Python lets through
/// (`Error::Other`).
pub async fn git_with(cwd: &str, args: &[&str], timeout: f64, check: bool) -> Result<Captured, Error> {
    let mut add_env = identity_env(cwd).await;
    add_env.push(("GIT_TERMINAL_PROMPT".to_string(), "0".to_string()));
    add_env.push(("GIT_EDITOR".to_string(), "true".to_string()));
    let mut argv = vec!["git".to_string()];
    argv.extend(args.iter().map(|a| (*a).to_string()));
    let spec = Spec { cwd: Some(cwd), add_env, ..Spec::default() };
    let out = proc::run(&argv, &spec, timeout).await?;
    if check && out.returncode != 0 {
        let head: Vec<&str> = args.iter().take(3).copied().collect();
        let problem: String = out.problem().chars().take(300).collect();
        return fail(format!("git {} failed: {problem}", head.join(" ")));
    }
    Ok(out)
}

/// `git(cwd, *args)` with the defaults: 120 seconds, a failure raises.
pub async fn git(cwd: &str, args: &[&str]) -> Result<Captured, Error> {
    git_with(cwd, args, 120.0, true).await
}

/// `git(cwd, *args, check=False)`: the caller reads the return code.
pub async fn git_try(cwd: &str, args: &[&str]) -> Result<Captured, Error> {
    git_with(cwd, args, 120.0, false).await
}

/// `urlparse(url).hostname`, for a URL that has a network location; None when it has none or Python raises.
fn url_hostname(url: &str) -> Option<String> {
    // `urlparse` first drops leading control characters and spaces, and tab and line breaks anywhere
    let url: String = url.trim_start_matches(|c: char| c <= ' ').chars().filter(|c| !matches!(c, '\t' | '\r' | '\n')).collect();
    let mut rest = url.as_str();
    if let Some(i) = rest.find(':') {
        let scheme = &rest[..i];
        let first_ok = scheme.chars().next().is_some_and(|c| c.is_ascii_alphabetic());
        if i > 0
            && first_ok
            && scheme.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '-' | '.'))
        {
            rest = &rest[i + 1..];
        }
    }
    let after = rest.strip_prefix("//")?;
    let end = after.find(['/', '?', '#']).unwrap_or(after.len());
    let netloc = &after[..end];
    // an unbalanced bracket is `ValueError("Invalid IPv6 URL")`, a balanced one an IP address, never github.com
    if netloc.contains('[') || netloc.contains(']') {
        return None;
    }
    let hostinfo = netloc.rsplit_once('@').map_or(netloc, |(_, h)| h);
    let host = hostinfo.split_once(':').map_or(hostinfo, |(h, _)| h);
    if host.is_empty() {
        return None;
    }
    Some(host.to_lowercase())
}

/// Whether a git remote is on github.com (its host, not "github.com" anywhere in the URL): https, ssh:// and
/// scp-like git@github.com:owner/repo.
pub fn is_github(remote: Option<&str>) -> bool {
    let url = pytext::strip(remote.unwrap_or("")).to_string();
    let url = if !url.contains("://") && url.contains('@') && url.contains(':') {
        // git@github.com:owner/repo
        format!("ssh://{}", url.replacen(':', "/", 1))
    } else {
        url
    };
    url_hostname(&url).is_some_and(|host| host.to_lowercase() == "github.com")
}

/// The top of the git repository that holds `folder`, or None when it is not one.
pub async fn repo_root(folder: Option<&str>) -> Option<String> {
    let folder = folder.filter(|f| !f.is_empty() && Path::new(f).is_dir())?;
    let out = git_with(folder, &["rev-parse", "--show-toplevel"], 20.0, false).await.ok()?;
    let top = if out.returncode == 0 { pytext::strip(&out.stdout).to_string() } else { String::new() };
    if top.is_empty() { None } else { Some(top) }
}

/// A branch-safe slug of a ticket title; accents are dropped, not the letters ("Tài liệu học" -> tai-lieu-hoc).
pub fn slug(title: &str, limit: usize) -> String {
    let plain: String = title
        .replace('đ', "d")
        .replace('Đ', "D")
        .nfkd()
        .filter(|ch| unicode_normalization::char::canonical_combining_class(*ch) == 0)
        .collect();
    let lower = plain.to_lowercase();
    let mut out = String::new();
    let mut in_gap = false;
    for ch in lower.chars() {
        if ch.is_ascii_lowercase() || ch.is_ascii_digit() {
            out.push(ch);
            in_gap = false;
        } else if !in_gap {
            out.push('-');
            in_gap = true;
        }
    }
    let trimmed = out.trim_matches('-');
    let cut: String = trimmed.chars().take(limit).collect();
    let cut = cut.trim_end_matches('-');
    if cut.is_empty() { "work".to_string() } else { cut.to_string() }
}

/// `slug(title)` with the default limit of 32.
pub fn slug_default(title: &str) -> String {
    slug(title, 32)
}

/// Beside the repository: `<repo>.worktrees/<KEY>`.
pub fn path_for(repo: &str, key: &str) -> String {
    // `Path(repo)`: doubled separators and `.` pieces are gone
    let root: PathBuf = Path::new(repo).components().filter(|c| !matches!(c, std::path::Component::CurDir)).collect();
    let name = root.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let parent: PathBuf = root.parent().map(Path::to_path_buf).unwrap_or_else(|| root.clone());
    parent.join(format!("{name}.worktrees")).join(key).to_string_lossy().into_owned()
}

async fn free_port(session: &Session, base: i32) -> Result<i32, Error> {
    let rows = ai_worktree::Entity::find()
        .filter(ai_worktree::Column::State.is_in(["active", "conflict", "kept"]))
        .all(session)
        .await?;
    let used: Vec<i32> = rows.iter().filter_map(|w| w.port).filter(|p| *p != 0).collect();
    for port in base..=base + PORT_SPAN {
        if !used.contains(&port) {
            return Ok(port);
        }
    }
    fail(format!("Every port from {base} to {} is taken by a worktree.", base + PORT_SPAN))
}

/// The ticket's worktree row, or None.
pub async fn for_ticket(session: &Session, ticket_id: &str) -> Result<Option<ai_worktree::Model>, DbErr> {
    ai_worktree::Entity::find_by_id(ticket_id).one(session).await
}

/// `session.add(row)` and the update of every column.
pub(crate) async fn save(session: &Session, row: ai_worktree::Model) -> Result<ai_worktree::Model, DbErr> {
    kb_ai::store::save::<_, ai_worktree::Model, ai_worktree::ActiveModel>(session, row).await
}

/// A text setting: the value when it is truthy, as the text Python would use.
fn setting_text(cfg: &Map<String, Value>, key: &str) -> Option<String> {
    let value = cfg.get(key)?;
    if !kb_base::pyjson::truthy(value) {
        return None;
    }
    Some(match value {
        Value::String(s) => s.clone(),
        other => kb_base::pyjson::py_str(other),
    })
}

/// The ticket's worktree, made (and prepared) when it does not exist yet. None when the project has worktrees off
/// or the folder is not a git repository (the run then uses the shared folder, as before).
///
/// Errors: `Error::Worktree` / `Error::NeedsYou`: it could not be made or prepared (a board fault).
pub async fn ensure(
    session: &Session,
    ticket: &ticket::Model,
    fallback_folder: Option<&str>,
) -> Result<Option<ai_worktree::Model>, Error> {
    let settings = kb_ai::store::get_settings(session, &ticket.project_id).await?;
    let all = kb_ai::ops::get(Some(&settings));
    let cfg = all.get("worktrees").and_then(Value::as_object).cloned().unwrap_or_default();
    if !cfg.get("on").is_some_and(kb_base::pyjson::truthy) {
        return Ok(None);
    }
    let wanted = setting_text(&cfg, "repo").or_else(|| fallback_folder.filter(|f| !f.is_empty()).map(str::to_string));
    let Some(repo) = repo_root(Some(&pypath::expanduser(wanted.as_deref().unwrap_or("")))).await else {
        return Ok(None);
    };
    let mut row = ai_worktree::Entity::find_by_id(ticket.id.as_str()).one(session).await?;
    if let Some(existing) = row.clone() {
        if matches!(existing.state.as_str(), "active" | "conflict" | "kept") && Path::new(&existing.path).is_dir() {
            let mut existing = existing;
            existing.last_used_at = Some(now());
            return Ok(Some(commit_row(session, existing).await?));
        }
    }
    if git_try(&repo, &["rev-parse", "--verify", "--quiet", "HEAD"]).await?.returncode != 0 {
        return Err(Error::NeedsYou(format!(
            "The repository at {repo} has no commit yet, so the ticket's branch has nothing to start from. Make a \
             first commit there (for example git commit --allow-empty -m \"Start\"), then retry the run."
        )));
    }
    let path = path_for(&repo, &ticket.id);
    let branch = match &row {
        Some(r) => r.branch.clone(),
        None => format!("ai/{}-{}", ticket.id, slug_default(&ticket.title)),
    };
    let base = match setting_text(&cfg, "base_branch") {
        Some(base) => base,
        None => pytext::strip(&git(&repo, &["rev-parse", "--abbrev-ref", "HEAD"]).await?.stdout).to_string(),
    };
    if let Some(parent) = Path::new(&path).parent() {
        std::fs::create_dir_all(parent).map_err(|e| Error::Other(e.to_string()))?;
    }
    let ref_name = format!("refs/heads/{branch}");
    let exists = git_try(&repo, &["rev-parse", "--verify", "--quiet", &ref_name]).await?.returncode == 0;
    let reused = Path::new(&path).is_dir() && Path::new(&path).join(".git").exists();
    if reused {
        // left from an earlier session of the board: use it as it is
    } else if exists {
        git(&repo, &["worktree", "add", &path, &branch]).await?;
    } else {
        git(&repo, &["worktree", "add", "-b", &branch, &path, &base]).await?;
    }
    if !reused {
        if let Some(r) = row.as_mut() {
            // a new folder (the ticket's earlier worktree was merged or removed): it is prepared again
            r.prepared_at = None;
            r.prepare_s = None;
        }
    }
    let port = match row.as_ref().and_then(|r| r.port).filter(|p| *p != 0) {
        Some(port) => port,
        None => {
            let base_port = match cfg.get("base_port").filter(|v| kb_base::pyjson::truthy(v)) {
                Some(v) => kb_ai::store::py_int(v)
                    .and_then(|n| i32::try_from(n).ok())
                    .ok_or_else(|| Error::Other(format!("invalid literal for int(): {}", kb_base::pyjson::py_repr(v))))?,
                None => 5180,
            };
            free_port(session, base_port).await?
        }
    };
    let mut saved = match row {
        Some(r) => r,
        None => {
            let mut fresh = ai_worktree::new();
            fresh.ticket_id = kb_db::sea_orm::ActiveValue::Set(ticket.id.clone());
            fresh.project_id = kb_db::sea_orm::ActiveValue::Set(ticket.project_id.clone());
            fresh.repo = kb_db::sea_orm::ActiveValue::Set(repo.clone());
            fresh.path = kb_db::sea_orm::ActiveValue::Set(path.clone());
            fresh.branch = kb_db::sea_orm::ActiveValue::Set(branch.clone());
            fresh.base = kb_db::sea_orm::ActiveValue::Set(base.clone());
            fresh.port = kb_db::sea_orm::ActiveValue::Set(Some(port));
            kb_db::sea_orm::ActiveModelTrait::insert(fresh, session).await?
        }
    };
    saved.repo = repo.clone();
    saved.path = path.clone();
    saved.branch = branch.clone();
    saved.base = base.clone();
    saved.port = Some(port);
    saved.state = "active".to_string();
    saved.last_used_at = Some(now());
    let mut saved = commit_row(session, saved).await?;
    let prepare = pytext::strip(&setting_text(&cfg, "prepare").unwrap_or_default()).to_string();
    if !prepare.is_empty() && saved.prepared_at.as_deref().is_none_or(str::is_empty) {
        let started = chrono::Utc::now();
        let mut env = crate::project_env::with_path(None, Some(&crate::project_env::extra(Some(&settings))));
        env.insert("PORT".to_string(), port.to_string());
        let spec = Spec { cwd: Some(&path), whole_env: Some(env), shell: true, ..Spec::default() };
        let out = match proc::run(&[prepare.clone()], &spec, PREPARE_TIMEOUT_S as f64).await {
            Ok(out) => out,
            Err(ProcError::Timeout(_)) => {
                return fail(format!(
                    "The prepare command `{prepare}` did not finish in {} minutes.",
                    PREPARE_TIMEOUT_S / 60
                ));
            }
            Err(other) => return Err(other.into()),
        };
        if out.returncode != 0 {
            let problem = if out.stderr.is_empty() { &out.stdout } else { &out.stderr };
            let lines = pytext::splitlines(pytext::strip(problem));
            let tail = lines[lines.len().saturating_sub(3)..].join(" ");
            let tail: String = tail.chars().take(300).collect();
            return fail(format!("The prepare command `{prepare}` failed: {tail}"));
        }
        saved.prepared_at = Some(now());
        saved.prepare_s = Some(i32::try_from((chrono::Utc::now() - started).num_seconds()).unwrap_or(i32::MAX));
        saved = commit_row(session, saved).await?;
    }
    Ok(Some(saved))
}

/// `session.add(row)`, `await session.commit()`: the row stored and made permanent.
pub(crate) async fn commit_row(session: &Session, row: ai_worktree::Model) -> Result<ai_worktree::Model, DbErr> {
    let stored = save(session, row).await?;
    session.commit().await?;
    Ok(stored)
}

/// What git says about a worktree now.
#[derive(Debug, Clone, Default)]
pub struct Live {
    /// The files changed and not committed (at most 50).
    pub uncommitted: Vec<String>,
    /// The size of the folder without `.git`, in MB with one decimal.
    pub size_mb: Option<f64>,
    /// Whether the folder is still there.
    pub exists: bool,
    /// Commits ahead of the base branch.
    pub ahead: Option<i64>,
    /// The untracked outputs among the changed files (at most 50); only present when the folder exists.
    pub outputs: Option<Vec<String>>,
}

impl Live {
    /// The dict `status()` returns: `uncommitted`, `size_mb`, `exists`, `ahead` and, when the folder exists, `outputs`.
    pub fn to_value(&self) -> Value {
        let mut out = Map::new();
        out.insert("uncommitted".into(), json!(self.uncommitted));
        out.insert("size_mb".into(), json!(self.size_mb));
        out.insert("exists".into(), json!(self.exists));
        out.insert("ahead".into(), json!(self.ahead));
        if let Some(outputs) = &self.outputs {
            out.insert("outputs".into(), json!(outputs));
        }
        Value::Object(out)
    }
}

/// `line[3:]`: a `git status --porcelain` line without its two status letters and the space.
pub(crate) fn after_status(line: &str) -> String {
    line.chars().skip(3).collect()
}

/// What git says about a worktree now: files changed and not committed, size, ahead of its base.
pub async fn status(row: &ai_worktree::Model) -> Result<Live, Error> {
    let mut out = Live { exists: Path::new(&row.path).is_dir(), ..Live::default() };
    if !out.exists {
        return Ok(out);
    }
    let lines = porcelain(&row.path).await?;
    out.uncommitted = lines.iter().map(|l| after_status(l)).take(50).collect();
    out.outputs = Some(outputs_in(&lines).into_iter().take(50).collect());
    let range = format!("{}..HEAD", row.base);
    let ahead = git_try(&row.path, &["rev-list", "--count", &range]).await?;
    let text = pytext::strip(&ahead.stdout);
    out.ahead = if ahead.returncode == 0 && !text.is_empty() && text.bytes().all(|b| b.is_ascii_digit()) {
        text.parse::<i64>().ok()
    } else {
        None
    };
    let folder = row.path.clone();
    out.size_mb = Some(
        tokio::task::spawn_blocking(move || size_mb(Path::new(&folder)))
            .await
            .map_err(|e| Error::Other(e.to_string()))?,
    );
    Ok(out)
}

/// `git status --porcelain` with every untracked file listed by itself (not its folder).
pub(crate) async fn porcelain(path: &str) -> Result<Vec<String>, Error> {
    let st = git_try(path, &["status", "--porcelain", "-uall"]).await?;
    Ok(pytext::splitlines(&st.stdout)
        .into_iter()
        .filter(|l| !pytext::strip(l).is_empty())
        .map(str::to_string)
        .collect())
}

/// `round(x, 1)`: the nearest one-decimal value, a tie going to the even digit as Python's does.
fn round1(x: f64) -> f64 {
    format!("{x:.1}").parse().unwrap_or(x)
}

fn walk_size(dir: &Path, total: &mut u64) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.filter_map(Result::ok) {
        let path = entry.path();
        let Ok(kind) = entry.file_type() else {
            continue;
        };
        if kind.is_symlink() {
            // `os.walk` lists a link to a folder with the folders and does not enter it; a link to a file counts
            match std::fs::metadata(&path) {
                Ok(meta) if meta.is_file() => *total += meta.len(),
                _ => {}
            }
        } else if kind.is_dir() {
            if entry.file_name() != ".git" {
                walk_size(&path, total);
            }
        } else if let Ok(meta) = entry.metadata() {
            *total += meta.len();
        }
    }
}

/// `round(total / (1024 * 1024), 1)`: bytes as MB with one decimal.
pub fn mb_of(total: u64) -> f64 {
    round1(total as f64 / (1024.0 * 1024.0))
}

/// The size of a folder in MB, its `.git` folders left out.
pub fn size_mb(path: &Path) -> f64 {
    let mut total = 0u64;
    walk_size(path, &mut total);
    mb_of(total)
}

/// The ticket's worktree for an AI reading the ticket: where it is, its branch, and what is not committed (outputs
/// apart from code), so nobody reports a vague "not cleaned".
pub async fn brief(session: &Session, ticket_id: &str) -> Result<Option<Value>, Error> {
    let Some(row) = ai_worktree::Entity::find_by_id(ticket_id).one(session).await? else {
        return Ok(None);
    };
    if row.state == "removed" {
        return Ok(None);
    }
    let exists = Path::new(&row.path).is_dir();
    let mut out = Map::new();
    out.insert("path".into(), json!(row.path));
    out.insert("branch".into(), json!(row.branch));
    out.insert("state".into(), json!(row.state));
    out.insert("exists".into(), json!(exists));
    if exists {
        let lines = porcelain(&row.path).await?;
        let outputs = outputs_in(&lines);
        out.insert("uncommitted".into(), json!(lines.iter().map(|l| after_status(l)).take(30).collect::<Vec<_>>()));
        out.insert("outputs".into(), json!(outputs.iter().take(30).collect::<Vec<_>>()));
        if !lines.is_empty() {
            let plural = |n: usize| if n == 1 { "" } else { "s" };
            let mut note = format!("{} file{} not committed", lines.len(), plural(lines.len()));
            if !outputs.is_empty() {
                note.push_str(&format!(", {} of them outputs (screenshots, logs, reports)", outputs.len()));
            }
            note.push_str(": the worktree is not removed until a person commits, moves or discards them.");
            out.insert("note".into(), json!(note));
        }
    }
    Ok(Some(Value::Object(out)))
}

/// What `kb_mcp::hooks::AiTicketViewHook::worktree_brief` needs: `brief` on a session of its own, the error as the
/// text Python's exception would have.
pub async fn worktree_brief(ticket_id: &str) -> Result<Option<Value>, String> {
    let session = kb_db::session();
    brief(&session, ticket_id).await.map_err(|e| e.to_string())
}

/// A worktree for the API.
pub fn to_dict(row: &ai_worktree::Model, live: Option<Value>) -> Value {
    let conflict_files = match serde_json::from_str::<Value>(if row.conflict_files.is_empty() {
        "[]"
    } else {
        &row.conflict_files
    }) {
        Ok(v) => v,
        Err(_) => json!([]),
    };
    let mut out = Map::new();
    out.insert("ticket_id".into(), json!(row.ticket_id));
    out.insert("project_id".into(), json!(row.project_id));
    out.insert("repo".into(), json!(row.repo));
    out.insert("path".into(), json!(row.path));
    out.insert("branch".into(), json!(row.branch));
    out.insert("base".into(), json!(row.base));
    out.insert("port".into(), json!(row.port));
    out.insert("state".into(), json!(row.state));
    out.insert("handover".into(), json!(row.handover));
    out.insert("pr_url".into(), json!(row.pr_url));
    out.insert("pr_number".into(), json!(row.pr_number));
    out.insert("conflict_files".into(), conflict_files);
    out.insert("prepared_at".into(), json!(row.prepared_at));
    out.insert("prepare_s".into(), json!(row.prepare_s));
    out.insert("created_at".into(), json!(row.created_at));
    out.insert("last_used_at".into(), json!(row.last_used_at));
    out.insert("merged_at".into(), json!(row.merged_at));
    if let Some(live) = live {
        out.insert("live".into(), live);
    }
    Value::Object(out)
}

/// Every worktree of a project with what git says now.
pub async fn list_for_project(session: &Session, project_id: &str) -> Result<Vec<Value>, Error> {
    let rows = ai_worktree::Entity::find()
        .filter(ai_worktree::Column::ProjectId.eq(project_id))
        .filter(ai_worktree::Column::State.ne("removed"))
        .order_by_asc(ai_worktree::Column::CreatedAt)
        .order_by_asc(ai_worktree::Column::TicketId)
        .all(session)
        .await?;
    let mut out = Vec::new();
    for r in &rows {
        let live = status(r).await?.to_value();
        out.push(to_dict(r, Some(live)));
    }
    Ok(out)
}

/// Remove a ticket's worktree (never with uncommitted work unless `force`) and give its port back.
///
/// Errors: `Error::Worktree`: something is uncommitted, or git refused.
pub async fn remove(session: &Session, ticket_id: &str, force: bool) -> Result<ai_worktree::Model, Error> {
    let Some(mut row) = ai_worktree::Entity::find_by_id(ticket_id).one(session).await? else {
        return fail("This ticket has no worktree.");
    };
    let live = status(&row).await?;
    if !live.uncommitted.is_empty() && !force {
        return fail(format!("{} files are not committed: keep it, or commit them first.", live.uncommitted.len()));
    }
    if live.exists {
        let mut args = vec!["worktree", "remove"];
        if force {
            args.push("--force");
        }
        args.push(&row.path);
        git_try(&row.repo, &args).await?;
        if Path::new(&row.path).exists() {
            let _ = std::fs::remove_dir_all(&row.path);
        }
        git_try(&row.repo, &["worktree", "prune"]).await?;
    }
    row.state = "removed".to_string();
    row.port = None;
    // a worktree made again for the ticket runs the prepare command again
    row.prepared_at = None;
    row.prepare_s = None;
    commit_row(session, row).await.map_err(Into::into)
}
