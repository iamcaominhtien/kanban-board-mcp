//! The board's database: which one is in use, its pool and sessions, and bringing its schema up to date.
//!
//! SQLite in the data folder is the default. PostgreSQL or MySQL/MariaDB is used when `KANBAN_DATABASE_URL` says so
//! or when it was chosen in Settings › Storage & backup (`targets`). Every module reaches the database through
//! `conn()` and `session()`, so `reinit_db` re-points the whole app without a restart.

use std::path::{Path, PathBuf};
use std::sync::RwLock;
use std::time::{Duration, Instant};

use sea_orm::sqlx::{self, ConnectOptions as _, Connection as _};
use sea_orm::{
    ActiveModelTrait, ConnectionTrait, DatabaseConnection, DbBackend, DbErr, EntityTrait, Statement, TransactionTrait,
};
use serde_json::{Map, Value, json};

use kb_base::{config as app_config, events, pyjson, time};

use crate::session::Session;
use crate::targets::{self, Target, TargetError};
use crate::{changes, schema};

/// The database cannot be used as it is: it was made by a newer app, or it holds something that is not a board.
/// `code` is "newer", "foreign", "older" or "locked".
#[derive(Debug, Clone, thiserror::Error)]
#[error("{message}")]
pub struct SchemaError {
    pub code: &'static str,
    pub message: String,
}

/// Why the database could not be set up or reached.
#[derive(Debug, thiserror::Error)]
pub enum DatabaseError {
    #[error(transparent)]
    Schema(#[from] SchemaError),
    #[error(transparent)]
    Target(#[from] TargetError),
    #[error(transparent)]
    Db(#[from] DbErr),
    #[error("{0}")]
    Other(String),
}

struct State {
    db_path: PathBuf,
    target: Target,
    source: &'static str,
    conn: DatabaseConnection,
}

static STATE: RwLock<Option<State>> = RwLock::new(None);

/// Set while the database in use cannot be reached: `{"since": epoch seconds, "error": str, "target": public dict}`.
/// The API answers 503 with code "database_unreachable" meanwhile, and the app shows the reconnect screen.
static UNREACHABLE: RwLock<Option<Map<String, Value>>> = RwLock::new(None);
pub const RETRY_S: u64 = 8;
/// How long the database is given to answer at the start before the app starts without it.
const FIRST_ANSWER: Duration = Duration::from_secs(10);

/// Whether the schema of the database in use was checked (and brought up to date) by `init_db`: what reads the
/// database in the background starts only then.
static SCHEMA_CHECKED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// Whether `init_db` has checked the schema of the database in use (false from the moment another one is opened
/// until its schema is checked).
pub fn schema_checked() -> bool {
    SCHEMA_CHECKED.load(std::sync::atomic::Ordering::SeqCst)
}

fn read<T>(f: impl FnOnce(&State) -> T) -> T {
    let guard = STATE.read().unwrap_or_else(|e| e.into_inner());
    f(guard.as_ref().expect("database::setup runs before anything uses the database"))
}

/// `Path(text).resolve()`: absolute, with symlinks of the existing part followed.
fn resolve_path(path: &Path) -> PathBuf {
    let absolute = std::path::absolute(path).unwrap_or_else(|_| path.to_path_buf());
    match (absolute.parent(), absolute.file_name()) {
        (Some(parent), Some(name)) => match parent.canonicalize() {
            Ok(parent) => parent.join(name),
            Err(_) => absolute,
        },
        _ => absolute,
    }
}

fn resolve_db_path() -> PathBuf {
    // A data folder chosen in Settings wins over KANBAN_DB_PATH. The desktop app always sets KANBAN_DB_PATH to its
    // default location, so letting it win would hide the data of anyone who moved their data folder (the board
    // would look empty after an upgrade).
    if let Some(configured) = app_config::get_data_folder() {
        let _ = std::fs::create_dir_all(&configured);
        return configured.join("kanban.db");
    }
    let from_env = std::env::var("KANBAN_DB_PATH").unwrap_or_default();
    if !from_env.is_empty() {
        let path = PathBuf::from(&from_env);
        if let Some(parent) = std::path::absolute(&path).ok().and_then(|p| p.parent().map(Path::to_path_buf)) {
            let _ = std::fs::create_dir_all(parent);
        }
        return resolve_path(&path);
    }
    // next to the program, as the Python server kept it next to its sources
    std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(|dir| dir.join("kanban.db")))
        .unwrap_or_else(|| PathBuf::from("kanban.db"))
}

fn resolve_target(db_path: &Path) -> Result<(Target, &'static str), TargetError> {
    match targets::resolve(db_path) {
        Ok(found) => Ok(found),
        Err(err) => {
            // A broken KANBAN_DATABASE_URL must not silently fall back to another database
            if !std::env::var(targets::ENV_URL).unwrap_or_default().is_empty() {
                return Err(err);
            }
            tracing::error!("The saved database setting cannot be used; using SQLite: {err}");
            Ok((Target::sqlite(db_path.to_string_lossy().into_owned()), "default"))
        }
    }
}

/// Decide which database to use and open its pool (once, at startup, before `init_db`). The pool connects on first
/// use, so this does not fail because a server is away.
pub async fn setup() -> Result<(), DatabaseError> {
    let db_path = resolve_db_path();
    let (target, source) = resolve_target(&db_path)?;
    let conn = targets::make_engine(&target, None).await?;
    *STATE.write().unwrap_or_else(|e| e.into_inner()) = Some(State { db_path, target, source, conn });
    Ok(())
}

/// Whether `setup` has run.
pub fn is_set_up() -> bool {
    STATE.read().unwrap_or_else(|e| e.into_inner()).is_some()
}

/// The pool of the database in use.
pub fn conn() -> DatabaseConnection {
    read(|s| s.conn.clone())
}

/// `async_session()`: a new unit of work on the database in use.
pub fn session() -> Session {
    Session::new(conn())
}

/// The connection URL of the database in use, without its password.
pub fn database_url() -> String {
    read(|s| s.target.url(true))
}

/// The SQLite file in the data folder (the database when SQLite is in use; folders of the app sit next to it).
pub fn get_db_path() -> PathBuf {
    read(|s| s.db_path.clone())
}

/// The data folder: attachments, AI run logs and the SQLite file live here whichever database is in use.
pub fn get_data_dir() -> PathBuf {
    read(|s| s.db_path.parent().map(Path::to_path_buf).unwrap_or_default())
}

/// The database in use (with its password; never print it, use `display()`).
pub fn current_target() -> Target {
    read(|s| s.target.clone())
}

/// Where the database in use was set: "environment", "settings" or "default".
pub fn target_source() -> &'static str {
    read(|s| s.source)
}

/// Whether the board runs on a SQLite file (FTS5 search, the WAL file, the file-based export).
pub fn is_sqlite() -> bool {
    read(|s| s.conn.get_database_backend() == DbBackend::Sqlite)
}

/// The engine in use as the Python code names it: "sqlite", "postgresql" or "mysql".
pub fn dialect() -> &'static str {
    read(|s| crate::session::dialect_name(s.conn.get_database_backend()))
}

/// Insert one row unless it exists (INSERT OR IGNORE), in the session's transaction: how a row is made on first use.
///
/// Two requests that both find the row missing can both try to make it. With a plain insert and commit, the second
/// one's commit fails and it has to roll back. With this, the second insert does nothing and both read the row
/// back. The same on every engine.
pub async fn insert_missing<C, A>(conn: &C, row: A) -> Result<(), DbErr>
where
    C: ConnectionTrait,
    A: ActiveModelTrait + Send,
{
    <A::Entity as EntityTrait>::insert(row).on_conflict_do_nothing().exec_without_returning(conn).await.map(|_| ())
}

/// Bring the database in use up to the newest schema.
///
/// SQLite: turn on WAL (readers never wait for a writer) and make or upgrade the tables. PostgreSQL and MySQL: an
/// empty database gets the app's tables, one of ours gets its pending migrations, anything else is refused. Safe
/// to call on every startup; it does nothing when the schema is already at head.
pub async fn init_db() -> Result<(), DatabaseError> {
    let conn = conn();
    if conn.get_database_backend() == DbBackend::Sqlite {
        conn.execute_unprepared("PRAGMA journal_mode=WAL").await?;
    }
    let txn = conn.begin().await?;
    let state = schema::schema_state(&txn).await?;
    match state.state {
        "empty" => schema::create_schema(&txn).await?,
        "foreign" => {
            if conn.get_database_backend() != DbBackend::Sqlite {
                return Err(SchemaError {
                    code: "foreign",
                    message: format!(
                        "This database already holds {} tables that are not a Kanban board. Choose an empty database.",
                        state.tables
                    ),
                }
                .into());
            }
            // a SQLite file with tables but no stamp: the Python chain started from its first migration here
            return Err(SchemaError {
                code: "foreign",
                message: "This file holds tables that are not a Kanban board.".into(),
            }
            .into());
        }
        _ => {
            if let Some(rev) = state.revision.as_deref() {
                if !schema::known_revision(rev) {
                    let short: String = rev.chars().take(8).collect();
                    return Err(SchemaError {
                        code: "newer",
                        message: format!(
                            "This database was made by a newer version of the app (migration {short}…). Update the app first; \
                             the board will not touch it."
                        ),
                    }
                    .into());
                }
            }
            changes::create(&txn).await?;
            schema::restamp_legacy_revision(&txn).await?;
            crate::migrations::upgrade(&txn).await?;
        }
    }
    txn.commit().await?;
    SCHEMA_CHECKED.store(true, std::sync::atomic::Ordering::SeqCst);
    Ok(())
}

async fn set_target(target: Target, source: &'static str, db_path: PathBuf) -> Result<(), DbErr> {
    let conn = targets::make_engine(&target, None).await?;
    *STATE.write().unwrap_or_else(|e| e.into_inner()) = Some(State { db_path, target, source, conn });
    SCHEMA_CHECKED.store(false, std::sync::atomic::Ordering::SeqCst);
    Ok(())
}

/// Re-read which database to use (after the data folder moved, an import, or a switch), then bring its schema up to
/// date. Every later `conn()` and `session()` uses the new database; a request that already holds a session goes on
/// with the old pool until it ends.
pub async fn reinit_db(new_db_path: Option<PathBuf>) -> Result<(), DatabaseError> {
    let old = conn();
    let db_path = new_db_path.unwrap_or_else(get_db_path);
    let (target, source) = resolve_target(&db_path)?;
    set_target(target, source, db_path).await?;
    // the old pool closes once the requests that still hold it end; a server that hangs would keep this waiting for
    // its timeout, and the board just opened has nothing to wait for
    tokio::spawn(async move {
        let _ = old.close().await;
    });
    init_db().await?;
    // the board just opened answered (the schema was checked on it): it is no longer "cannot be reached", which was
    // about the one left behind
    set_unreachable(None);
    Ok(())
}

/// Point the app at `target` now and remember it in Settings (the wizard's Switch). Refused while
/// `KANBAN_DATABASE_URL` is set: the environment wins.
pub async fn use_target(target: &Target) -> Result<(), DatabaseError> {
    if !std::env::var(targets::ENV_URL).unwrap_or_default().is_empty() {
        return Err(SchemaError {
            code: "locked",
            message: "KANBAN_DATABASE_URL is set, so the database cannot be changed from here.".into(),
        }
        .into());
    }
    // this process re-points itself below; its follow loop must not do it at the same time
    let _quiet = pause_following();
    let old = app_config::get_section(targets::CONFIG_KEY);
    targets::save_choice(target).map_err(|e| DatabaseError::Other(e.to_string()))?;
    match reinit_db(None).await {
        Ok(()) => Ok(()),
        Err(err) => {
            let _ = app_config::set_section(targets::CONFIG_KEY, if old.is_empty() { None } else { Some(old) });
            reinit_db(None).await?;
            Err(err)
        }
    }
}

// ---------------------------------------------------------------------------
// Following the setting, and a database that does not answer
// ---------------------------------------------------------------------------

/// The "cannot reach the database" state, or `None` when the database answers.
pub fn unreachable() -> Option<Map<String, Value>> {
    UNREACHABLE.read().unwrap_or_else(|e| e.into_inner()).clone()
}

fn set_unreachable(value: Option<Map<String, Value>>) {
    *UNREACHABLE.write().unwrap_or_else(|e| e.into_inner()) = value;
}

/// What decides the database: the environment variable, the saved choice (never shown) and the data folder (a
/// workspace switch changes only that).
fn settings_key() -> String {
    let saved = app_config::get_section(targets::CONFIG_KEY);
    let folder = app_config::get_data_folder().map(|f| f.to_string_lossy().into_owned());
    pyjson::Dumps::new().sort_keys(true).dump(&json!([
        std::env::var(targets::ENV_URL).unwrap_or_default(),
        saved,
        folder
    ]))
}

fn is_connection_error(err: &DatabaseError) -> bool {
    match err {
        DatabaseError::Db(DbErr::Conn(_) | DbErr::ConnectionAcquire(_)) => true,
        DatabaseError::Db(other) => {
            let text = other.to_string().to_lowercase();
            text.contains("connection")
                || text.contains("timed out")
                || text.contains("pool")
                || text.contains("io error")
        }
        _ => false,
    }
}

/// The first line of an error, 300 characters at most.
fn first_line(err: &dyn std::fmt::Display) -> String {
    err.to_string().lines().next().unwrap_or("").chars().take(300).collect()
}

fn unreachable_entry(error: String) -> Map<String, Value> {
    let target = current_target();
    let mut public = target.public();
    public.insert("label".into(), json!(target.label()));
    public.insert("display".into(), json!(target.display()));
    let mut entry = Map::new();
    entry.insert("since".into(), json!(time::epoch()));
    entry.insert("error".into(), json!(error));
    entry.insert("target".into(), Value::Object(public));
    entry
}

/// Bring the database up at the start of the app. A server database that does not answer within `FIRST_ANSWER`
/// does not stop the app: the "cannot be reached" state is set (the app shows its reconnect screen, from which
/// another board can be opened) and the start is tried again every `RETRY_S` seconds until the schema is checked.
///
/// # Errors
/// The schema cannot be used (made by a newer app, not a board), or SQLite fails.
pub async fn init_db_or_wait() -> Result<(), DatabaseError> {
    // a quick question first: the pool would wait its whole timeout (30 s) for a server that does not answer, and
    // `init_db` itself must not be cut off in the middle of a migration
    let answered = is_sqlite() || check_reachable(FIRST_ANSWER).await["ok"] == json!(true);
    if answered {
        match init_db().await {
            Ok(()) => {
                set_unreachable(None);
                return Ok(());
            }
            Err(err @ DatabaseError::Schema(_)) => return Err(err),
            Err(err) => {
                if is_sqlite() || !is_connection_error(&err) {
                    return Err(err);
                }
                let entry = unreachable_entry(first_line(&err));
                tracing::error!("The database cannot be reached: {}", entry["error"].as_str().unwrap_or(""));
                set_unreachable(Some(entry));
            }
        }
    } else if let Some(entry) = unreachable() {
        tracing::error!("The database cannot be reached: {}", entry["error"].as_str().unwrap_or(""));
    }
    tokio::spawn(async {
        // until a schema is checked: this board's when it answers, or the board a switch opened meanwhile
        while !schema_checked() {
            tokio::time::sleep(Duration::from_secs(RETRY_S)).await;
            if schema_checked() {
                break;
            }
            match init_db().await {
                Ok(()) => {
                    set_unreachable(None);
                    tracing::info!("The database answers again");
                }
                Err(err) => {
                    // keep trying
                    let mut guard = UNREACHABLE.write().unwrap_or_else(|e| e.into_inner());
                    match guard.as_mut() {
                        Some(entry) => {
                            entry.insert("error".into(), json!(first_line(&err)));
                        }
                        None => *guard = Some(unreachable_entry(first_line(&err))),
                    }
                }
            }
        }
    });
    Ok(())
}

/// Ask the database in use for one row; updates the unreachable state.
pub async fn check_reachable(timeout: Duration) -> Value {
    let started = Instant::now();
    let conn = conn();
    let ping = async {
        let backend = conn.get_database_backend();
        conn.query_one_raw(Statement::from_string(backend, "SELECT 1")).await
    };
    let outcome = match tokio::time::timeout(timeout, ping).await {
        Ok(Ok(_)) => Ok(()),
        Ok(Err(err)) => Err(first_line(&err)),
        Err(_) => Err("TimeoutError".to_string()),
    };
    match outcome {
        Ok(()) => {
            set_unreachable(None);
            json!({"ok": true, "latency_ms": started.elapsed().as_millis() as u64})
        }
        Err(error) => {
            let error = if error.is_empty() { "Error".to_string() } else { error };
            let mut guard = UNREACHABLE.write().unwrap_or_else(|e| e.into_inner());
            match guard.as_mut() {
                Some(entry) => {
                    entry.insert("error".into(), json!(error));
                }
                None => {
                    drop(guard);
                    set_unreachable(Some(unreachable_entry(error.clone())));
                }
            }
            json!({"ok": false, "error": error})
        }
    }
}

static FOLLOW_PAUSED: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);

/// Keeps `follow_settings` of this process still while it is alive: a workspace switch changes the settings and
/// re-points the process itself, and must not be raced by the follow loop reading the file in between.
pub struct FollowPause(());

impl Drop for FollowPause {
    fn drop(&mut self) {
        FOLLOW_PAUSED.fetch_sub(1, std::sync::atomic::Ordering::SeqCst);
    }
}

/// Pause `follow_settings` of this process until the returned guard is dropped. What changed meanwhile is seen at the
/// next look afterwards (and does nothing when it is the database already in use).
pub fn pause_following() -> FollowPause {
    FOLLOW_PAUSED.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    FollowPause(())
}

/// What `follow_settings` does when the person opens another workspace: the board in use and `workspace_active` of
/// the config file change together.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OnSwitch {
    /// Open the other board too (the app itself: it shows what the person chose, and its windows are told).
    Follow,
    /// Stay on the board this process works on and refuse to work (`left_behind`) until the person opens it again.
    /// For the stdio MCP of an editor: its agent holds ticket keys of the board it started on, and `KAN-12` names
    /// another ticket on another board.
    Stay,
}

/// The key of the config file that names the workspace in use (`kb_dbkit::workspaces`).
pub const WORKSPACE_ACTIVE_KEY: &str = "workspace_active";

/// Why this process stopped working after the person opened another workspace, or `None`.
static LEFT_BEHIND: RwLock<Option<String>> = RwLock::new(None);

/// Why this process (an editor's stdio MCP) does nothing more: the person opened another workspace in the app, and
/// this process stays on the board its agent was working on. `None` while it works on the board in use.
pub fn left_behind() -> Option<String> {
    LEFT_BEHIND.read().unwrap_or_else(|e| e.into_inner()).clone()
}

fn set_left_behind(value: Option<String>) {
    *LEFT_BEHIND.write().unwrap_or_else(|e| e.into_inner()) = value;
}

/// The id of the workspace in use as the config file names it (`None` before any workspace was added).
fn active_workspace() -> Option<String> {
    app_config::get_value(WORKSPACE_ACTIVE_KEY).and_then(|v| v.as_str().map(str::to_string))
}

/// The name of a workspace of the config file's list, quoted, or a description when it has none.
fn workspace_label(id: Option<&str>) -> String {
    let list = app_config::get_value("workspaces");
    let name = id.and_then(|id| {
        list.as_ref()?
            .as_array()?
            .iter()
            .find(|w| w.get("id").and_then(Value::as_str) == Some(id))?
            .get("name")?
            .as_str()
    });
    match name {
        Some(name) => format!("\"{name}\""),
        None => "the board it started on".to_string(),
    }
}

/// What an agent is told when its MCP process stays on the board it worked on (`OnSwitch::Stay`).
fn left_behind_message(stayed_on: Option<&str>, opened: Option<&str>) -> String {
    let stayed = workspace_label(stayed_on);
    let opened = workspace_label(opened);
    format!(
        "The Kanban app was switched from {stayed} to another board, {opened}. This MCP server stays on {stayed} and \
         does nothing more, so that the ticket keys you read there are not used to change other tickets in {opened}. \
         Nothing was changed. Tell the person, and do not retry: either switch back to {stayed} in the app and go on, \
         or reconnect the Kanban MCP server in the editor (Claude Code: type /mcp, choose kanban, reconnect; or start \
         a new session) and read the tickets again on {opened} before changing anything."
    )
}

/// Re-point this process when the database setting or the data folder changes (the wizard's switch in the board,
/// `kanban-db use` on the command line, a workspace switch): the board and the stdio MCP processes that editors
/// launch then always use one database. `on_switch` says what to do when the change is the person opening another
/// workspace.
pub async fn follow_settings(interval: Duration, on_switch: OnSwitch) {
    let mut seen = settings_key();
    // the workspace this process works on
    let mut workspace = active_workspace();
    loop {
        tokio::time::sleep(interval).await;
        if FOLLOW_PAUSED.load(std::sync::atomic::Ordering::SeqCst) > 0 {
            continue;
        }
        let now = settings_key();
        let active_now = active_workspace();
        if now == seen {
            // the same board under a new id (the first workspace added names the board in use)
            if left_behind().is_none() {
                workspace = active_now;
            }
            continue;
        }
        seen = now;
        let current = current_target();
        // the data folder may have changed too (another process switched workspace), so the file is resolved again
        let db_path = resolve_db_path();
        let (target, _source) = match resolve_target(&db_path) {
            Ok(found) => found,
            Err(err) => {
                tracing::error!("Could not follow the database setting: {err}");
                continue;
            }
        };
        let same = target.url(false) == current.url(false) && target.password == current.password;
        if on_switch == OnSwitch::Stay && active_now != workspace && !same {
            let message = left_behind_message(workspace.as_deref(), active_now.as_deref());
            if left_behind().is_none() {
                tracing::warn!("Another workspace was opened in the app: this process stays on its board and stops");
            }
            set_left_behind(Some(message));
            continue;
        }
        if left_behind().is_some() {
            tracing::info!("The workspace of this process is open again: it works again");
        }
        set_left_behind(None);
        workspace = active_now;
        if same {
            continue;
        }
        tracing::info!("The database setting changed; now using {}", target.label());
        match reinit_db(Some(db_path)).await {
            // the windows of the app refetch, and see that another board is open (`board_token`)
            Ok(()) => events::invalidate().await,
            // keep following
            Err(err) => tracing::error!("Could not follow the database setting: {err}"),
        }
    }
}

/// Where the board in use lives: its database (with its password) and its data folder.
#[derive(Debug, Clone)]
pub struct Place {
    /// The database.
    pub target: Target,
    /// The data folder (attachments and AI logs; `kanban.db` when the board is SQLite).
    pub folder: PathBuf,
}

/// Where the board in use lives now; take it before moving the board, for `board_moved`.
pub fn place_in_use() -> Place {
    read(|s| Place { target: s.target.clone(), folder: s.db_path.parent().map(Path::to_path_buf).unwrap_or_default() })
}

/// What is told that the board in use moved (the workspace list: `kb_dbkit::workspaces::follow_move`).
type MovedHook = Box<dyn Fn(&Place) + Send + Sync>;
static ON_MOVED: std::sync::OnceLock<MovedHook> = std::sync::OnceLock::new();

/// Register what follows a move of the board in use (once, at startup; a second call is ignored).
pub fn on_board_moved(hook: MovedHook) {
    let _ = ON_MOVED.set(hook);
}

/// The board in use was moved from `before` to where it is now (Settings › Data folder, the database wizard's move):
/// it is the same board at a new place. Pointing the app at another board that already exists (the database card's
/// connection, `kanban-db use`) is not a move and must not call this.
pub fn board_moved(before: &Place) {
    if let Some(hook) = ON_MOVED.get() {
        hook(before);
    }
}

/// A short token that names the board in use: its database and its data folder. It changes when the app opens
/// another board (a workspace switch, a move to another folder or database), so a window that loaded one board can
/// tell, and the server can refuse its changes, once another board is open.
pub fn board_token() -> String {
    use std::hash::{Hash, Hasher};
    let (url, path) = read(|s| (s.target.url(true), s.db_path.clone()));
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    url.hash(&mut hasher);
    path.hash(&mut hasher);
    format!("{:016x}", hasher.finish())
}

/// Announce changes that another process made to the database.
///
/// The stdio MCP server (what the desktop app and editors launch) is a separate process from the API: its own
/// `publish` reaches nobody, so the board only showed the change after a restart. This loop notices such changes
/// and publishes one invalidation. A change this process published itself (a REST call, an MCP call over HTTP) is
/// not repeated.
///
/// On SQLite it reads the commit counter of *other* connections (`PRAGMA data_version`); on PostgreSQL and MySQL it
/// reads the newest row another process added to the change log (`changes`). It follows the database in use, so a
/// switch in Settings needs no restart.
///
/// `path` is the SQLite file to watch (`None` follows the database in use), `interval` the time between checks,
/// `grace` the wait after a change for this process's own `publish` to land.
pub async fn watch_database(path: Option<PathBuf>, interval: Duration, grace: Duration) {
    let mut watcher: Option<(PathBuf, sqlx::SqliteConnection)> = None;
    let mut seen: Option<i64> = None;
    // the SQLite path or the server URL the last value came from
    let mut watching: Option<String> = None;
    let mut trimmed_at = Instant::now();
    // What this process had announced when the version was last read: an announcement since then explains a change
    let mut seen_published = events::published();
    // when the version was last read: a runner commit since then explains a change
    let mut read_at = time::epoch();
    // the last refetch of tickets and Docs for changes the runner's commits explained (Python's 0.0: never)
    let mut runner_masked_at = 0.0;
    loop {
        tokio::time::sleep(interval).await;
        let last_read_at = read_at;
        let step: Result<(i64, String, bool), String> = async {
            if path.is_some() || is_sqlite() {
                let db_path = path.clone().unwrap_or_else(get_db_path);
                if watcher.as_ref().is_none_or(|(p, _)| *p != db_path) {
                    if let Some((_, old)) = watcher.take() {
                        let _ = old.close().await;
                    }
                    let options = sqlx::sqlite::SqliteConnectOptions::new()
                        .filename(&db_path)
                        .create_if_missing(false)
                        .busy_timeout(Duration::from_secs(1))
                        .disable_statement_logging();
                    let connection = sqlx::SqliteConnection::connect_with(&options).await.map_err(|e| e.to_string())?;
                    watcher = Some((db_path.clone(), connection));
                }
                let (_, connection) = watcher.as_mut().ok_or("no watcher connection")?;
                let version: i64 =
                    sqlx::query_scalar("PRAGMA data_version").fetch_one(connection).await.map_err(|e| e.to_string())?;
                Ok((version, db_path.to_string_lossy().into_owned(), false))
            } else {
                if let Some((_, old)) = watcher.take() {
                    let _ = old.close().await;
                }
                let conn = conn();
                let version = changes::latest_from_others(&conn).await.map_err(|e| e.to_string())?;
                Ok((version, current_target().url(true), true))
            }
        }
        .await;
        match step {
            Ok((version, source, server)) => {
                // after the read: a runner commit made while the version was being read is in this reading
                read_at = time::epoch();
                if watching.as_deref() != Some(source.as_str()) {
                    // another database: start over, nothing to announce yet
                    seen = None;
                    watching = Some(source);
                }
                if seen.is_some_and(|s| s != version) {
                    tokio::time::sleep(Duration::from_secs_f64(events::grace_for(grace.as_secs_f64()))).await;
                    // Counted from the last read, not from now: this process announces right after it commits,
                    // usually before the watcher looks, and a change it announced must not be announced a second
                    // time. The change log of a server database names the writer, so only other processes' rows
                    // are counted. A commit the AI runner told about counts when it was made between the last
                    // reading and this one.
                    if server || events::published() == seen_published {
                        if server || !events::runner_committed(last_read_at, read_at) {
                            events::invalidate().await;
                        } else if time::epoch() - runner_masked_at >= events::runner_mask_refresh_s() {
                            // SQLite does not say who wrote: a change made by another app in the same moment as one
                            // of the runner's (an editor's MCP server, while a run streams) would never show. So
                            // while the runner's commits explain the changes, the tickets and Docs are refetched now
                            // and then.
                            runner_masked_at = time::epoch();
                            events::publish(events::INVALIDATE, &["tickets", "docs"]).await;
                        }
                    }
                }
                seen = Some(version);
                seen_published = events::published();
                if server && trimmed_at.elapsed() > Duration::from_secs(300) {
                    trimmed_at = Instant::now();
                    let _ = changes::trim(&conn()).await;
                }
            }
            Err(err) => {
                tracing::debug!("Database watcher could not read the version: {err}");
                if let Some((_, old)) = watcher.take() {
                    let _ = old.close().await;
                }
                seen = None;
            }
        }
    }
}
