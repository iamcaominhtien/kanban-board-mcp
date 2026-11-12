//! The per-ticket workspace folders (`services/workspace.py`): the settings row, which folder belongs to a ticket,
//! listing a folder, and the rules that keep every path inside it. The file operations are in `files`, the retention
//! sweep in `sweep`, moving a folder between tickets in `transfer`.

use std::io;
use std::path::{MAIN_SEPARATOR_STR, Path, PathBuf};
use std::time::UNIX_EPOCH;

use chrono::DateTime;
use kb_base::{activity, pypath, pytext, time};
use kb_db::Session;
use kb_db::database::insert_missing;
use kb_db::entities::{idea_ticket, ticket, workspace_settings};
use kb_db::sea_orm::ActiveValue::Set;
use kb_db::sea_orm::{ActiveModelTrait, DbErr, EntityTrait, IntoActiveModel};
use serde_json::{Map, Value, json};

mod files;
mod sweep;
mod transfer;

pub use files::{
    MAX_PREVIEW_BYTES, MAX_UPLOAD_BYTES, create_folder, delete_entry, open_in_file_manager, read_text_preview,
    read_text_preview_async, resolve_file, save_upload, save_upload_limited,
};
pub use sweep::{SWEEP_INTERVAL_SECONDS, sweep_expired, sweep_loop};
pub use transfer::{move_to_ticket, transfer_workspace};

/// What a function of this module fails with.
#[derive(Debug)]
pub enum Error {
    /// `WorkspaceError`: a workspace request that is invalid or not permitted.
    Workspace(String),
    /// `LookupError`: the ticket or the entry is not there.
    Lookup(String),
    /// The database call failed.
    Db(DbErr),
    /// `OSError` nothing catches: a 500.
    Io(io::Error),
    /// Any other exception: a 500.
    Other(String),
}

impl From<DbErr> for Error {
    fn from(err: DbErr) -> Self {
        Error::Db(err)
    }
}

impl From<io::Error> for Error {
    fn from(err: io::Error) -> Self {
        Error::Io(err)
    }
}

impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Error::Workspace(message) | Error::Lookup(message) | Error::Other(message) => f.write_str(message),
            Error::Db(err) => err.fmt(f),
            Error::Io(err) => err.fmt(f),
        }
    }
}

/// Where ticket workspaces go until a person picks a folder in Settings (`KANBAN_WORKSPACE_ROOT` moves it: the tests
/// keep it out of the home folder).
pub fn default_root() -> String {
    match std::env::var("KANBAN_WORKSPACE_ROOT") {
        Ok(root) if !root.is_empty() => root,
        _ => "~/kanban-workspace".to_string(),
    }
}

/// Return the workspace settings row, creating it with defaults if missing.
pub async fn get_workspace_settings(session: &Session) -> Result<workspace_settings::Model, Error> {
    if let Some(settings) = workspace_settings::Entity::find_by_id(1).one(session).await? {
        return Ok(settings);
    }
    // two runs that start together on a new board both get here: the second insert does nothing
    let mut row = workspace_settings::new();
    row.id = Set(1);
    row.enabled = Set(true);
    row.root_path = Set(default_root());
    row.default_retention_days = Set(Some(14));
    insert_missing(session, row).await?;
    session.commit().await?;
    workspace_settings::Entity::find_by_id(1)
        .one(session)
        .await?
        .ok_or_else(|| Error::Other("the workspace settings row is missing".to_string()))
}

/// Update the given workspace settings; arguments left as None are unchanged.
///
/// `enabled` turns the workspace feature on or off, `root_path` is the folder holding all ticket workspaces (validated
/// before saving), `default_retention_days` the days before an unused workspace expires (0 = keep forever). Returns
/// the saved settings; fails with `WorkspaceError` if `root_path` is not usable.
pub async fn update_workspace_settings(
    session: &Session,
    enabled: Option<bool>,
    root_path: Option<&str>,
    default_retention_days: Option<i32>,
) -> Result<workspace_settings::Model, Error> {
    let settings = get_workspace_settings(session).await?;
    let unchanged = settings.clone();
    let mut settings = kb_db::edit(settings);
    if let Some(enabled) = enabled {
        settings.enabled = Set(enabled);
    }
    if let Some(root_path) = root_path {
        settings.root_path = Set(validate_root_path(root_path).await?);
    }
    if let Some(days) = default_retention_days {
        settings.default_retention_days = Set(Some(days));
    }
    if !settings.is_changed() {
        session.commit().await?;
        return Ok(unchanged);
    }
    let settings = settings.update(session).await?;
    session.commit().await?;
    Ok(settings)
}

/// `^[A-Za-z0-9_-]+$` as a whole (`fullmatch`).
fn is_safe_ticket_id(ticket_id: &str) -> bool {
    !ticket_id.is_empty() && ticket_id.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

/// `root` and `ticket_id` joined, when the result stays inside `root`; the `ValueError` text otherwise.
pub(crate) async fn resolve_workspace_path(root_path: &str, ticket_id: &str) -> Result<PathBuf, String> {
    if !is_safe_ticket_id(ticket_id) {
        return Err(format!("Invalid ticket id: {}", pytext::repr(ticket_id)));
    }
    let root = pypath::realpath(&pypath::expanduser(root_path)).await;
    let folder = pypath::realpath(&pypath::join(&root, ticket_id)).await;
    if !folder.starts_with(&format!("{}{MAIN_SEPARATOR_STR}", root.trim_end_matches(MAIN_SEPARATOR_STR))) {
        return Err("Workspace path escapes the workspace root".to_string());
    }
    Ok(PathBuf::from(folder))
}

pub(crate) const MAX_LISTED_ENTRIES: usize = 2000;
pub(crate) const CLOSED_STATUSES: [&str; 2] = ["done", "wont_do"];
pub(crate) const IDEA_CLOSED_STAGES: [&str; 2] = ["archived", "shipped"];
/// "30 days after the idea is closed" / "auto-delete after 30 days".
pub(crate) const IDEA_RETENTION_DAYS: i64 = 30;

async fn validate_root_path(root_path: &str) -> Result<String, Error> {
    let value = pytext::strip(root_path);
    if value.is_empty() {
        return Err(Error::Workspace("Workspace root path must not be empty".to_string()));
    }
    let resolved = pypath::realpath(&pypath::expanduser(value)).await;
    if resolved == pypath::dirname(&resolved) {
        return Err(Error::Workspace("Workspace root must not be the filesystem root".to_string()));
    }
    if resolved == pypath::realpath(&pypath::expanduser("~")).await {
        return Err(Error::Workspace("Workspace root must not be the home directory itself".to_string()));
    }
    Ok(value.to_string())
}

/// `_resolve_workspace_path` as `WorkspaceError`.
pub(crate) async fn folder_for(root_path: &str, ticket_id: &str) -> Result<PathBuf, Error> {
    resolve_workspace_path(root_path, ticket_id).await.map_err(Error::Workspace)
}

/// Resolve `rel` under `folder`; reject traversal and symlink escapes.
pub(crate) async fn resolve_inside(folder: &Path, rel: &str) -> Result<PathBuf, Error> {
    let rel = rel.replace('\\', "/");
    let rel = rel.trim_matches('/');
    if rel.is_empty() || rel.contains('\0') {
        return Err(Error::Workspace("Path is required".to_string()));
    }
    let base = pypath::realpath(&folder.to_string_lossy()).await;
    let target = pypath::realpath(&pypath::join(&base, rel)).await;
    if !target.starts_with(&format!("{}{MAIN_SEPARATOR_STR}", base.trim_end_matches(MAIN_SEPARATOR_STR))) {
        return Err(Error::Workspace("Path escapes the workspace folder".to_string()));
    }
    Ok(PathBuf::from(target))
}

/// The ticket, or the idea, that owns a workspace folder.
#[derive(Debug, Clone)]
pub enum Owner {
    /// A ticket.
    Ticket(ticket::Model),
    /// An idea (ideas have a workspace too).
    Idea(idea_ticket::Model),
}

impl Owner {
    /// The id, which is also the folder's name.
    pub fn id(&self) -> &str {
        match self {
            Owner::Ticket(ticket) => &ticket.id,
            Owner::Idea(idea) => &idea.id,
        }
    }

    /// A closed ticket (Done, Won't do) or idea (Shipped, Archived): its workspace may expire.
    pub fn is_closed(&self) -> bool {
        match self {
            Owner::Idea(idea) => {
                IDEA_CLOSED_STAGES.contains(&idea.stage.as_str()) || idea.workspace_retention == "30_days"
            }
            Owner::Ticket(ticket) => CLOSED_STATUSES.contains(&ticket.status.as_str()),
        }
    }

    /// Days a closed owner's workspace is kept; None keeps it forever.
    pub fn retention_for(&self, settings: &workspace_settings::Model) -> Option<i64> {
        match self {
            Owner::Idea(idea) => (idea.workspace_retention != "forever").then_some(IDEA_RETENTION_DAYS),
            Owner::Ticket(ticket) => {
                let days = ticket.workspace_retention_days.or(settings.default_retention_days);
                // None / 0 = keep forever
                days.filter(|d| *d != 0).map(i64::from)
            }
        }
    }
}

/// One entry of a folder listing.
#[derive(Debug, Clone)]
pub struct Entry {
    /// Path relative to the folder.
    pub name: String,
    pub is_dir: bool,
    pub size: u64,
    /// ISO time of the last change.
    pub modified_at: String,
}

impl Entry {
    /// `{"name", "is_dir", "size", "modified_at"}`.
    pub fn to_json(&self) -> Value {
        json!({"name": self.name, "is_dir": self.is_dir, "size": self.size, "modified_at": self.modified_at})
    }
}

/// What a walk of a workspace folder found.
#[derive(Debug, Clone)]
pub struct Scan {
    pub entries: Vec<Entry>,
    pub total_bytes: u64,
    /// `last_activity_epoch`: the newest change time of the folder and everything in it.
    pub latest: f64,
    pub truncated: bool,
}

/// `st_mtime`: seconds since the epoch as a float.
fn mtime_of(meta: &std::fs::Metadata) -> f64 {
    match meta.modified().ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()) {
        Some(d) => d.as_secs() as f64 + f64::from(d.subsec_nanos()) * 1e-9,
        None => 0.0,
    }
}

/// `datetime.fromtimestamp(t, tz=timezone.utc).isoformat()`.
pub(crate) fn fromtimestamp_iso(t: f64) -> String {
    let whole = t.trunc();
    let mut secs = whole as i64;
    let mut micros = ((t - whole) * 1e6).round_ties_even() as i64;
    if micros >= 1_000_000 {
        secs += 1;
        micros -= 1_000_000;
    } else if micros < 0 {
        secs -= 1;
        micros += 1_000_000;
    }
    match DateTime::from_timestamp(secs, (micros * 1000) as u32) {
        Some(dt) => time::iso(&dt),
        None => String::new(),
    }
}

/// Walk `folder` without following symlinks (`_scan`).
///
/// Directories and files are listed in `os.walk` order, at most `MAX_LISTED_ENTRIES` of them, then sorted by path
/// parts. A folder or file that cannot be read is skipped, as `os.walk` does; failing to `stat` raises.
pub fn scan(folder: &Path) -> io::Result<Scan> {
    let mut scan =
        Scan { entries: Vec::new(), total_bytes: 0, latest: mtime_of(&std::fs::metadata(folder)?), truncated: false };
    walk(folder, folder, &mut scan)?;
    scan.entries.sort_by(|a, b| a.name.split('/').cmp(b.name.split('/')));
    Ok(scan)
}

fn walk(root: &Path, dir: &Path, scan: &mut Scan) -> io::Result<()> {
    let Ok(read) = std::fs::read_dir(dir) else {
        return Ok(());
    };
    let mut dirs: Vec<String> = Vec::new();
    let mut files: Vec<String> = Vec::new();
    for entry in read.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        let Ok(kind) = entry.file_type() else { continue };
        if kind.is_symlink() {
            // never listed, never followed
            continue;
        }
        if kind.is_dir() { dirs.push(name) } else { files.push(name) }
    }
    dirs.sort();
    files.sort();
    for (names, is_dir) in [(&dirs, true), (&files, false)] {
        for name in names {
            let full = dir.join(name);
            let meta = std::fs::symlink_metadata(&full)?;
            let modified = mtime_of(&meta);
            if !is_dir {
                scan.total_bytes += meta.len();
            }
            scan.latest = scan.latest.max(modified);
            if scan.entries.len() < MAX_LISTED_ENTRIES {
                let relative = full.strip_prefix(root).unwrap_or(&full).to_string_lossy().into_owned();
                scan.entries.push(Entry {
                    name: relative,
                    is_dir,
                    size: if is_dir { 0 } else { meta.len() },
                    modified_at: fromtimestamp_iso(modified),
                });
            } else {
                scan.truncated = true;
            }
        }
    }
    for name in &dirs {
        walk(root, &dir.join(name), scan)?;
    }
    Ok(())
}

/// Run blocking file work off the async threads (`asyncio.to_thread`).
pub(crate) async fn to_thread<T: Send + 'static>(
    work: impl FnOnce() -> io::Result<T> + Send + 'static,
) -> io::Result<T> {
    tokio::task::spawn_blocking(work).await.map_err(io::Error::other)?
}

/// `Path.mkdir(0o755, parents=True, exist_ok=True)`.
pub(crate) async fn mkdir_parents(path: &Path) -> io::Result<()> {
    let path = path.to_path_buf();
    to_thread(move || {
        let mut builder = std::fs::DirBuilder::new();
        builder.recursive(true);
        #[cfg(unix)]
        std::os::unix::fs::DirBuilderExt::mode(&mut builder, 0o755);
        builder.create(path)
    })
    .await
}

/// The ticket that owns the workspace folder named `ticket_id`, or the idea (ideas have one too).
pub async fn get_ticket(session: &Session, ticket_id: &str) -> Result<Option<Owner>, DbErr> {
    if let Some(found) = ticket::Entity::find_by_id(ticket_id).one(session).await? {
        return Ok(Some(Owner::Ticket(found)));
    }
    if ticket_id.starts_with("IDEA-") {
        return Ok(idea_ticket::Entity::find_by_id(ticket_id).one(session).await?.map(Owner::Idea));
    }
    Ok(None)
}

/// Return a ticket's workspace folder state and entries, or None if the ticket is missing.
pub async fn get_ticket_workspace(session: &Session, ticket_id: &str) -> Result<Option<Value>, Error> {
    let Some(owner) = get_ticket(session, ticket_id).await? else {
        return Ok(None);
    };
    let settings = get_workspace_settings(session).await?;
    let Ok(folder_path) = resolve_workspace_path(&settings.root_path, ticket_id).await else {
        return Ok(None);
    };

    let exists = folder_path.is_dir();
    let mut files: Vec<Entry> = Vec::new();
    let mut total_bytes = 0;
    let mut truncated = false;
    let mut last_activity: Option<f64> = None;
    if exists {
        let folder = folder_path.clone();
        if let Ok(found) = to_thread(move || scan(&folder)).await {
            files = found.entries;
            total_bytes = found.total_bytes;
            last_activity = Some(found.latest);
            truncated = found.truncated;
        }
    }

    let retention_days = owner.retention_for(&settings);
    let sweep_eligible = owner.is_closed();
    let mut expires_at = Value::Null;
    if let (true, Some(days), Some(last)) = (exists, retention_days.filter(|d| *d != 0), last_activity) {
        expires_at = json!(fromtimestamp_iso(last + days as f64 * 86400.0));
    }
    let retention_override = match &owner {
        Owner::Idea(idea) => json!(idea.workspace_retention),
        Owner::Ticket(ticket) => json!(ticket.workspace_retention_days),
    };

    let file_count = files.iter().filter(|f| !f.is_dir).count();
    let mut out = Map::new();
    out.insert("enabled".into(), json!(settings.enabled));
    out.insert("path".into(), json!(folder_path.to_string_lossy()));
    out.insert("exists".into(), json!(exists));
    out.insert("retention_days".into(), json!(retention_days.unwrap_or(0)));
    out.insert("retention_override".into(), retention_override);
    out.insert("sweep_eligible".into(), json!(sweep_eligible));
    out.insert("expires_at".into(), expires_at);
    out.insert("files".into(), Value::Array(files.iter().map(Entry::to_json).collect()));
    out.insert("file_count".into(), json!(file_count));
    out.insert("total_bytes".into(), json!(total_bytes));
    out.insert("truncated".into(), json!(truncated));
    Ok(Some(Value::Object(out)))
}

fn retention_label(days: Option<i32>) -> String {
    match days {
        None => "default".to_string(),
        Some(0) => "forever".to_string(),
        Some(days) => format!("{days} days"),
    }
}

/// Set a ticket's retention override.
///
/// `retention_days` is the days to keep the workspace; 0 keeps it forever, None uses the default. Returns the updated
/// ticket, or None if it does not exist; fails with `WorkspaceError` if the value is negative.
pub async fn set_ticket_workspace_retention(
    session: &Session,
    ticket_id: &str,
    retention_days: Option<i32>,
) -> Result<Option<ticket::Model>, Error> {
    let Some(ticket) = ticket::Entity::find_by_id(ticket_id).one(session).await? else {
        return Ok(None);
    };
    if retention_days.is_some_and(|days| days < 0) {
        return Err(Error::Workspace("Retention must be 0 (forever) or a positive number of days".to_string()));
    }
    let mut activity_log = ticket.activity_log.clone();
    if ticket.workspace_retention_days != retention_days {
        activity::record(
            &mut activity_log,
            "workspace_retention",
            json!(retention_label(ticket.workspace_retention_days)),
            json!(retention_label(retention_days)),
            None,
            None,
        );
    }
    let mut row = kb_db::edit(ticket);
    row.activity_log = Set(activity_log);
    row.workspace_retention_days = Set(retention_days);
    row.updated_at = Set(time::now_iso());
    let ticket = row.update(session).await?;
    session.commit().await?;
    Ok(Some(ticket))
}

/// The folder of a ticket whose workspace may be changed: the ticket exists and the feature is on.
pub(crate) async fn enabled_folder(session: &Session, ticket_id: &str) -> Result<PathBuf, Error> {
    if get_ticket(session, ticket_id).await?.is_none() {
        return Err(Error::Lookup("Ticket not found".to_string()));
    }
    let settings = get_workspace_settings(session).await?;
    if !settings.enabled {
        return Err(Error::Workspace("Workspace is disabled".to_string()));
    }
    folder_for(&settings.root_path, ticket_id).await
}

/// Create the ticket's workspace folder and return its path.
pub async fn init_ticket_workspace(session: &Session, ticket_id: &str) -> Result<PathBuf, Error> {
    let folder = enabled_folder(session, ticket_id).await?;
    mkdir_parents(&folder).await?;
    Ok(folder)
}

/// Best-effort removal of a deleted ticket's scratch folder; never fails.
pub async fn remove_ticket_workspace(session: &Session, ticket_id: &str) {
    let removed = async {
        let settings = get_workspace_settings(session).await.map_err(|err| err.to_string())?;
        let folder = resolve_workspace_path(&settings.root_path, ticket_id).await?;
        let is_link = std::fs::symlink_metadata(&folder).is_ok_and(|m| m.file_type().is_symlink());
        if folder.is_dir() && !is_link {
            to_thread(move || std::fs::remove_dir_all(folder)).await.map_err(|err| err.to_string())?;
        }
        Ok::<(), String>(())
    }
    .await;
    if let Err(err) = removed {
        // cleanup must not fail the delete
        tracing::warn!(target: "services.workspace", "Could not remove workspace of {ticket_id}: {err}");
    }
}

/// Return the ticket's workspace path, which an agent can read and write directly.
///
/// `create` makes the folder when the feature is enabled. Returns `{enabled, path, exists}`, or None for an unknown
/// ticket.
pub async fn get_workspace_path(session: &Session, ticket_id: &str, create: bool) -> Result<Option<Value>, Error> {
    if get_ticket(session, ticket_id).await?.is_none() {
        return Ok(None);
    }
    let settings = get_workspace_settings(session).await?;
    let folder = folder_for(&settings.root_path, ticket_id).await?;
    if settings.enabled && create {
        mkdir_parents(&folder).await?;
    }
    Ok(Some(json!({"enabled": settings.enabled, "path": folder.to_string_lossy(), "exists": folder.is_dir()})))
}

/// What an AI needs to know about a ticket's Workspace, read from disk now (never created here): `{path, exists,
/// file_count, files: [newest first, at most `limit`], note}`; None when Workspace is off.
pub async fn brief(session: &Session, ticket_id: &str, limit: usize) -> Result<Option<Value>, Error> {
    let settings = get_workspace_settings(session).await?;
    if !settings.enabled {
        return Ok(None);
    }
    let Ok(folder) = resolve_workspace_path(&settings.root_path, ticket_id).await else {
        return Ok(None);
    };
    let exists = folder.is_dir();
    let mut out = Map::new();
    out.insert("path".into(), json!(folder.to_string_lossy()));
    out.insert("exists".into(), json!(exists));
    if !exists {
        out.insert(
            "note".into(),
            json!("Not created yet: nothing is in it. manage_ticket(action='workspace') creates it."),
        );
        return Ok(Some(Value::Object(out)));
    }
    let found = {
        let folder = folder.clone();
        to_thread(move || scan(&folder)).await
    };
    let files = found.map(|found| found.entries).unwrap_or_default();
    let mut plain: Vec<&Entry> = files.iter().filter(|f| !f.is_dir).collect();
    // newest first; ISO times compare as text, and a tie keeps the listing order (`sorted(..., reverse=True)`)
    plain.sort_by(|a, b| b.modified_at.cmp(&a.modified_at));
    out.insert("file_count".into(), json!(plain.len()));
    out.insert("files".into(), json!(plain.iter().take(limit).map(|f| f.name.clone()).collect::<Vec<_>>()));
    if plain.is_empty() {
        out.insert("note".into(), json!("Empty: the folder exists, nothing has been written to it."));
    }
    Ok(Some(Value::Object(out)))
}
