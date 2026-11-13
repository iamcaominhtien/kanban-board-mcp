//! Workspaces: several boards on one computer, and a switch between them.
//!
//! A workspace is a name, a data folder (attachments and AI logs, and `kanban.db` when the board is SQLite) and,
//! when the board lives on a database server, that database (PostgreSQL or MySQL/MariaDB). The list is kept in
//! `config.json` under `workspaces`; the one in use is the `data_folder` and the `database` section of the same
//! file, which every process already follows (`kb_db::database::follow_settings`), so the stdio MCP processes of
//! Claude Code and VS Code change board too. Switching points the running app at the other board without a restart
//! (the way an import does) and never copies, moves or deletes data; removing an entry forgets it and leaves its
//! folder and database alone.
//!
//! Not the Workspace of a ticket (the scratch folder of `kb-ai-work`): that one belongs to a ticket, this one holds
//! a whole board.
//!
//! The one thing that stops a switch is `KANBAN_DATABASE_URL`: the environment then decides the database.
//!
//! What keeps a person's boards safe: the config file is changed under one lock and saved all or nothing
//! (`kb_base::config::update`), a switch changes its three keys in one save, the board to open is checked before
//! anything is changed, only one switch runs at a time, and this process's own `follow_settings` stands still while
//! it runs. The entry of the board in use follows that board when Settings moves its folder or changes its database.

use std::path::{Path, PathBuf};
use std::time::Duration;

use kb_base::{config, events, pytext, time};
use kb_db::database;
use kb_db::targets::{self, Target};
use kb_files::{pathlib, uploads};
use serde_json::{Map, Value, json};

use crate::hooks;
use crate::probe::{self, Report};

/// The key of the list in the config file.
const LIST_KEY: &str = "workspaces";
/// The key of the workspace the app was last switched to (or registered as): the one that follows the board in use.
const ACTIVE_KEY: &str = "workspace_active";
/// The id of the board in use when no entry of the list names it yet.
pub const CURRENT_ID: &str = "current";
/// The longest name of a workspace, in characters.
pub const MAX_NAME: usize = 60;
/// How long a board is given to answer before a switch to it is refused.
const PREFLIGHT: Duration = Duration::from_secs(15);
/// The folder, in the home folder, that new workspaces are made in.
const FOLDERS: &str = "Kanban Boards";

/// One switch at a time.
static SWITCH: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// A saved workspace.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Workspace {
    /// Its id in the config file and the routes.
    pub id: String,
    /// What the person calls it; unique, any case.
    pub name: String,
    /// The data folder: `uploads/` lives in it, and `kanban.db` when the board is SQLite.
    pub folder: PathBuf,
    /// The database server of the board, as the `database` section of the config file keeps it (the password
    /// encrypted); `None` for SQLite in `folder`.
    pub database: Option<Map<String, Value>>,
}

impl Workspace {
    /// The database server this workspace names, with its password, or `None` for SQLite.
    pub fn target(&self) -> Option<Target> {
        self.database.as_ref().and_then(targets::target_of_section)
    }

    /// Whether this is the board the app shows now: the same database server, or the same SQLite folder.
    fn is_current(&self) -> bool {
        match self.target() {
            Some(target) => !database::is_sqlite() && same_database(&target, &database::current_target()),
            None => database::is_sqlite() && same_folder(&self.folder, &current_folder()),
        }
    }

    /// What the list shows as the place of the board: `host:port/name` of a server, the folder of a SQLite file.
    fn place(&self) -> String {
        self.target().map_or_else(|| self.folder.to_string_lossy().into_owned(), |t| t.display())
    }

    /// `sqlite`, `postgresql` or `mysql`.
    fn engine(&self) -> String {
        self.target().map_or_else(|| "sqlite".to_string(), |t| t.engine)
    }
}

/// A workspace as the list shows it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Item {
    /// The saved workspace.
    pub workspace: Workspace,
    /// This is the board the app shows now.
    pub active: bool,
    /// The board exists already (a new SQLite folder gets its board the first time it is opened).
    pub has_board: bool,
}

impl Item {
    /// The JSON of the REST routes.
    pub fn as_json(&self) -> Value {
        json!({
            "id": self.workspace.id,
            "name": self.workspace.name,
            "folder": self.workspace.folder.to_string_lossy(),
            "engine": self.workspace.engine(),
            "place": self.workspace.place(),
            "active": self.active,
            "has_board": self.has_board,
        })
    }
}

/// Why a workspace call was refused.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum Error {
    /// The name or the folder cannot be used; the message says why.
    #[error("{0}")]
    Invalid(String),
    /// No workspace has this id.
    #[error("Workspace not found")]
    NotFound,
    /// The name or the folder is taken.
    #[error("{0}")]
    Taken(String),
    /// `KANBAN_DATABASE_URL` decides the database, so there is nothing to switch.
    #[error("{0}")]
    Unsupported(String),
    /// Something is running that a switch would cut off.
    #[error("{0}")]
    Busy(String),
    /// The board to open cannot be used (no answer, wrong password, not a board, made by a newer version). Nothing
    /// was changed.
    #[error("{0}")]
    Unusable(String),
    /// The save or the switch failed unexpectedly (the previous board is back in use).
    #[error("{0}")]
    Failed(String),
}

/// The saved list and the id of the workspace that follows the board in use.
struct Book {
    list: Vec<Workspace>,
    active: Option<String>,
}

impl Book {
    fn from_values(list: Option<&Value>, active: Option<&Value>) -> Book {
        let entries = list.and_then(Value::as_array).cloned().unwrap_or_default();
        let list = entries
            .iter()
            .filter_map(|entry| {
                let text = |key: &str| entry.get(key).and_then(Value::as_str).filter(|v| !v.is_empty());
                Some(Workspace {
                    id: text("id")?.to_string(),
                    name: text("name")?.to_string(),
                    folder: PathBuf::from(text("folder")?),
                    database: entry.get("database").and_then(Value::as_object).cloned(),
                })
            })
            .collect();
        Book { list, active: active.and_then(Value::as_str).map(str::to_string) }
    }

    fn from_config(data: &Map<String, Value>) -> Book {
        Book::from_values(data.get(LIST_KEY), data.get(ACTIVE_KEY))
    }

    fn read() -> Book {
        Book::from_values(config::get_value(LIST_KEY).as_ref(), config::get_value(ACTIVE_KEY).as_ref())
    }

    fn write_into(&self, data: &mut Map<String, Value>) {
        let entries: Vec<Value> = self
            .list
            .iter()
            .map(|w| {
                let mut entry = json!({"id": w.id, "name": w.name, "folder": w.folder.to_string_lossy()});
                if let Some(database) = &w.database {
                    entry["database"] = Value::Object(database.clone());
                }
                entry
            })
            .collect();
        data.insert(LIST_KEY.into(), Value::Array(entries));
        match &self.active {
            Some(id) => data.insert(ACTIVE_KEY.into(), Value::String(id.clone())),
            None => data.shift_remove(ACTIVE_KEY),
        };
    }

    /// Make the list agree with the board in use. When another part of Settings moved the data folder or changed
    /// the database of the workspace that was last opened, that workspace now lives there: its entry follows (else
    /// opening it would start an empty board and look like lost data). Returns whether anything changed.
    fn reconcile(&mut self) -> bool {
        if locked().is_some() {
            return false;
        }
        if let Some(current) = self.list.iter().find(|w| w.is_current()) {
            if self.active.as_deref() == Some(current.id.as_str()) {
                return false;
            }
            self.active = Some(current.id.clone());
            return true;
        }
        let Some(active) = self.active.clone() else { return false };
        let Some(entry) = self.list.iter_mut().find(|w| w.id == active) else { return false };
        let database = if database::is_sqlite() {
            None
        } else {
            match targets::section_of(&database::current_target()) {
                Ok(section) => Some(section),
                // the password cannot be kept safely: leave the entry as it is rather than lose its way back
                Err(_) => return false,
            }
        };
        entry.folder = current_folder();
        entry.database = database;
        true
    }
}

/// Read the list, change it, and save it, all under the lock of the config file and in one save.
fn mutate<R>(change: impl FnOnce(&mut Book) -> Result<R, Error>) -> Result<R, Error> {
    let mut outcome: Option<Result<R, Error>> = None;
    let saved = config::update(|data| {
        let mut book = Book::from_config(data);
        book.reconcile();
        let result = change(&mut book);
        let saves = result.is_ok();
        outcome = Some(result);
        if saves {
            book.write_into(data);
        }
        saves
    });
    match (saved, outcome) {
        (Err(err), _) => Err(Error::Failed(format!("Could not save the workspaces: {err}"))),
        (Ok(_), Some(result)) => result,
        (Ok(_), None) => Err(Error::Failed("Could not save the workspaces".into())),
    }
}

/// The data folder in use, resolved.
pub fn current_folder() -> PathBuf {
    pathlib::resolve(&database::get_data_dir())
}

/// Whether two targets are the same database: engine, server, port, name and user (not the password or SSL mode,
/// which are how it is reached, not which one it is).
fn same_database(a: &Target, b: &Target) -> bool {
    a.engine == b.engine
        && a.host.eq_ignore_ascii_case(&b.host)
        && a.port_or_default() == b.port_or_default()
        && a.name == b.name
        && a.user == b.user
}

fn same_folder(a: &Path, b: &Path) -> bool {
    pathlib::resolve(a) == pathlib::resolve(b)
}

/// Whether the workspace holds a board already. A SQLite folder is looked at; a server database is taken as holding
/// one (it was tested when the workspace was added).
fn has_board(workspace: &Workspace) -> bool {
    workspace.database.is_some()
        || std::fs::metadata(workspace.folder.join("kanban.db")).map(|m| m.len() > 0).unwrap_or(false)
}

/// The name of a workspace made from a folder that no entry names yet.
fn name_of_folder(folder: &Path, first: bool) -> String {
    if first {
        return "Default".to_string();
    }
    folder.file_name().map(|n| n.to_string_lossy().into_owned()).filter(|n| !n.is_empty()).unwrap_or("Board".into())
}

/// The workspace of the board in use, for the list when no entry of it was saved yet.
fn current_workspace(name: String) -> Workspace {
    let database = if database::is_sqlite() { None } else { targets::section_of(&database::current_target()).ok() };
    Workspace { id: CURRENT_ID.into(), name, folder: current_folder(), database }
}

/// Every workspace, the one in use marked. The board in use is listed even when no entry names it yet (nobody has
/// added a workspace so far).
pub fn list() -> Vec<Item> {
    let mut book = Book::read();
    book.reconcile();
    let mut items: Vec<Item> = book
        .list
        .iter()
        .map(|w| Item { active: w.is_current(), has_board: has_board(w), workspace: w.clone() })
        .collect();
    if !items.iter().any(|item| item.active) {
        let name = unique_name(&book.list, &name_of_folder(&current_folder(), book.list.is_empty()));
        items.insert(0, Item { active: true, has_board: true, workspace: current_workspace(name) });
    }
    items
}

/// Why a switch is not possible right now, or `None`. The list and the editing of names work either way.
pub fn locked() -> Option<String> {
    (database::target_source() == "environment").then(|| {
        "KANBAN_DATABASE_URL is set, so the environment decides the database and it cannot be switched here.".into()
    })
}

fn clean_name(raw: &str) -> Result<String, Error> {
    let name = pytext::strip(raw);
    if name.is_empty() {
        return Err(Error::Invalid("Name must not be empty".into()));
    }
    if name.chars().count() > MAX_NAME {
        return Err(Error::Invalid(format!("Name must be {MAX_NAME} characters or fewer")));
    }
    if name.chars().any(char::is_control) {
        return Err(Error::Invalid("Name must not contain control characters".into()));
    }
    Ok(name.to_string())
}

fn name_taken(all: &[Workspace], name: &str, except: Option<&str>) -> bool {
    all.iter().any(|w| Some(w.id.as_str()) != except && w.name.to_lowercase() == name.to_lowercase())
}

fn unique_name(all: &[Workspace], wanted: &str) -> String {
    let mut name = wanted.to_string();
    let mut n = 2;
    while name_taken(all, &name, None) {
        name = format!("{wanted} {n}");
        n += 1;
    }
    name
}

/// A folder name from a workspace name: letters, digits and hyphens.
fn slug(name: &str) -> String {
    let mut out = String::new();
    for c in name.to_lowercase().chars() {
        if c.is_ascii_alphanumeric() {
            out.push(c);
        } else if !out.ends_with('-') && !out.is_empty() {
            out.push('-');
        }
    }
    let out = out.trim_end_matches('-').to_string();
    if out.is_empty() { "board".into() } else { out }
}

/// Put the board in use into the list (when no entry names it) so that the way back is kept, and mark it as the one
/// that follows the board in use; returns its id.
///
/// # Errors
/// `Failed` when the password of a server database cannot be encrypted.
fn register_current(book: &mut Book) -> Result<String, Error> {
    if let Some(found) = book.list.iter().find(|w| w.is_current()) {
        book.active = Some(found.id.clone());
        return Ok(found.id.clone());
    }
    let name = unique_name(&book.list, &name_of_folder(&current_folder(), book.list.is_empty()));
    let mut workspace = current_workspace(name);
    if !database::is_sqlite() && workspace.database.is_none() {
        return Err(Error::Failed("The password of the database in use could not be kept safely".into()));
    }
    workspace.id = time::uuid4_hex()[..12].to_string();
    let id = workspace.id.clone();
    book.list.insert(0, workspace);
    book.active = Some(id.clone());
    Ok(id)
}

/// A folder the person typed: a full path (after `~`), inside the home folder (as the data folder is), not a file.
fn checked_folder(raw: &str) -> Result<PathBuf, Error> {
    let raw = pytext::strip(raw);
    if raw.is_empty() || raw.contains('\0') {
        return Err(Error::Invalid("Folder must not be empty".into()));
    }
    let typed = config::expanduser(raw);
    if !typed.is_absolute() {
        return Err(Error::Invalid("Enter the full path of the folder, for example /Users/you/boards/home".into()));
    }
    let resolved = pathlib::resolve(&typed);
    let home = pathlib::resolve(&config::home_dir()).display().to_string();
    let sep = std::path::MAIN_SEPARATOR;
    let home_root = format!("{}{sep}", home.trim_end_matches(sep));
    if !resolved.display().to_string().starts_with(&home_root) {
        return Err(Error::Invalid("Workspace folder must be within your home directory".into()));
    }
    if resolved.is_file() {
        return Err(Error::Invalid("That path is a file, not a folder".into()));
    }
    Ok(resolved)
}

/// Add a workspace. `folder` `None` makes a new one in `~/Kanban Boards`; a folder that already holds a board (a copy
/// of another computer's data, say) is added as it is. `server` names a PostgreSQL or MySQL/MariaDB database the board
/// lives in (the caller has tested it); the folder then holds the attachments only.
///
/// # Errors
/// `Invalid` for a bad name or folder, `Taken` when the name, the folder or the database is already a workspace,
/// `Unsupported` while the environment decides the database.
pub fn add(name: &str, folder: Option<&str>, server: Option<&Target>) -> Result<Item, Error> {
    if let Some(reason) = locked() {
        return Err(Error::Unsupported(reason));
    }
    let name = clean_name(name)?;
    mutate(|book| {
        register_current(book)?;
        if name_taken(&book.list, &name, None) {
            return Err(Error::Taken(format!("A workspace named \"{name}\" already exists")));
        }
        let server = server.filter(|t| !t.is_sqlite());
        if let Some(target) = server {
            if book.list.iter().any(|w| w.target().is_some_and(|t| same_database(&t, target))) {
                return Err(Error::Taken("That database is already a workspace".into()));
            }
        }
        let folder = match folder.map(pytext::strip).filter(|f| !f.is_empty()) {
            Some(raw) => checked_folder(raw)?,
            None => {
                let base = pathlib::resolve(&config::home_dir().join(FOLDERS));
                let (stem, mut n) = (slug(&name), 1);
                let mut candidate = base.join(&stem);
                while candidate.exists() || book.list.iter().any(|w| same_folder(&w.folder, &candidate)) {
                    n += 1;
                    candidate = base.join(format!("{stem}-{n}"));
                }
                candidate
            }
        };
        if book.list.iter().any(|w| same_folder(&w.folder, &folder)) {
            return Err(Error::Taken("That folder is already a workspace".into()));
        }
        let database = match server {
            Some(target) => Some(
                targets::section_of(target)
                    .map_err(|e| Error::Failed(format!("The password could not be kept safely: {e}")))?,
            ),
            None => None,
        };
        std::fs::create_dir_all(&folder).map_err(|e| Error::Failed(format!("Could not create the folder: {e}")))?;
        let workspace = Workspace { id: time::uuid4_hex()[..12].to_string(), name, folder, database };
        book.list.push(workspace.clone());
        Ok(Item { active: false, has_board: has_board(&workspace), workspace })
    })
}

/// Rename a workspace.
///
/// # Errors
/// `NotFound` for an unknown id, `Invalid` or `Taken` for the name.
pub fn rename(id: &str, name: &str) -> Result<Item, Error> {
    let name = clean_name(name)?;
    mutate(|book| {
        let id = if id == CURRENT_ID { register_current(book)? } else { id.to_string() };
        if !book.list.iter().any(|w| w.id == id) {
            return Err(Error::NotFound);
        }
        if name_taken(&book.list, &name, Some(&id)) {
            return Err(Error::Taken(format!("A workspace named \"{name}\" already exists")));
        }
        let entry = book.list.iter_mut().find(|w| w.id == id).ok_or(Error::NotFound)?;
        entry.name = name;
        let workspace = entry.clone();
        Ok(Item { active: workspace.is_current(), has_board: has_board(&workspace), workspace })
    })
}

/// Forget a workspace. Its folder, its database and the data in them stay where they are; add it again to use it.
///
/// # Errors
/// `NotFound` for an unknown id, `Invalid` for the workspace in use.
pub fn remove(id: &str) -> Result<(), Error> {
    mutate(|book| {
        let Some(at) = book.list.iter().position(|w| w.id == id) else {
            return Err(if id == CURRENT_ID { Error::Invalid(in_use()) } else { Error::NotFound });
        };
        if book.list[at].is_current() {
            return Err(Error::Invalid(in_use()));
        }
        book.list.remove(at);
        if book.active.as_deref() == Some(id) {
            book.active = None;
        }
        Ok(())
    })
}

fn in_use() -> String {
    "The workspace in use cannot be removed; switch to another one first".into()
}

/// What stops a board from being opened, in words for the person, or `None` when it can be. A database that is
/// empty or already holds a board is fine.
pub fn problem_of(report: &Report) -> Option<String> {
    let first_error = || report.findings.iter().find(|f| f.level == "error").map(|f| f.title.clone());
    match report.state.as_str() {
        "foreign" => {
            Some("That database already holds tables that are not a Kanban board. Choose an empty one.".into())
        }
        "newer" => Some("That board was made by a newer version of the app. Update the app first.".into()),
        _ if !report.ok() => Some(first_error().unwrap_or_else(|| "That database cannot be reached.".into())),
        "empty" | "board" => None,
        _ => Some(first_error().unwrap_or_else(|| "That database cannot be used.".into())),
    }
}

/// Look at the board a switch would open, before anything is changed: it must answer, and be empty or a board of
/// this app (not made by a newer version). A SQLite folder with no database yet gets a new board and needs no look.
async fn preflight(workspace: &Workspace) -> Result<(), Error> {
    let target = match workspace.target() {
        Some(target) => target,
        None if !has_board(workspace) => return Ok(()),
        None => Target::sqlite(workspace.folder.join("kanban.db").to_string_lossy().into_owned()),
    };
    let report = tokio::time::timeout(PREFLIGHT, probe::test(&target))
        .await
        .map_err(|_| {
            Error::Unusable(format!("{} did not answer in {} seconds.", workspace.place(), PREFLIGHT.as_secs()))
        })?
        .map_err(|e| Error::Unusable(format!("Could not check {}: {e}", workspace.place())))?;
    match problem_of(&report) {
        None => Ok(()),
        Some(message) => Err(Error::Unusable(message)),
    }
}

/// Open another workspace: the app, its AI runner's next start and the stdio MCP processes use its database and
/// folder from now on. A folder with no board yet gets an empty one, and so does an empty database.
///
/// The board to open is checked first and nothing is changed if it cannot be opened. Refused while an AI run is
/// working (it would go on writing to the board it started on). If opening still fails, the previous workspace
/// stays in use.
///
/// # Errors
/// `NotFound`, `Unsupported` (`KANBAN_DATABASE_URL` decides the database), `Busy` (AI runs are working), `Unusable`
/// (the board does not answer, or is not a usable board), `Failed` (anything unexpected).
pub async fn switch(id: &str) -> Result<Item, Error> {
    if let Some(reason) = locked() {
        return Err(Error::Unsupported(reason));
    }
    let _one_at_a_time = SWITCH.lock().await;
    let mut book = Book::read();
    book.reconcile();
    let target = match book.list.iter().find(|w| w.id == id) {
        Some(w) => w.clone(),
        None if id == CURRENT_ID => return Ok(list().remove(0)),
        None => return Err(Error::NotFound),
    };
    if target.is_current() {
        return Ok(Item { active: true, has_board: has_board(&target), workspace: target });
    }
    // a board that does not answer cannot have runs working on it, and asking it would wait for the connection
    if database::unreachable().is_none() {
        if let Some(hook) = hooks::workspace() {
            if let Some(reason) = hook.busy().await {
                return Err(Error::Busy(reason));
            }
        }
    }
    preflight(&target).await?;
    // keep the way back before leaving
    mutate(|book| register_current(book).map(|_| ()))?;

    let before = Before::capture();
    std::fs::create_dir_all(&target.folder).map_err(|e| Error::Failed(format!("Could not open the folder: {e}")))?;
    // this process must not follow its own change of the settings while it makes it
    let _quiet = database::pause_following();
    if database::is_sqlite() {
        // fold the write-ahead log into the file, so the board left behind is complete on its own
        let conn = database::conn();
        if let Err(err) =
            kb_db::sea_orm::ConnectionTrait::execute_unprepared(&conn, "PRAGMA wal_checkpoint(TRUNCATE)").await
        {
            tracing::warn!(target: "workspaces", "The write-ahead log of the board left behind was not folded in: {err}");
        }
    }
    let opened = async {
        config::update(|data| {
            data.insert("data_folder".into(), Value::String(target.folder.to_string_lossy().into_owned()));
            match &target.database {
                Some(section) => data.insert(targets::CONFIG_KEY.into(), Value::Object(section.clone())),
                None => data.shift_remove(targets::CONFIG_KEY),
            };
            data.insert(ACTIVE_KEY.into(), Value::String(target.id.clone()));
            true
        })
        .map_err(|e| e.to_string())?;
        uploads::set_uploads_dir_env(&target.folder.join("uploads"));
        database::reinit_db(Some(target.folder.join("kanban.db"))).await.map_err(|e| e.to_string())
    }
    .await;
    if let Err(message) = opened {
        tracing::error!(target: "workspaces", "Switch to {} failed: {message}", target.place());
        before.restore().await;
        return Err(Error::Failed(format!("Could not open {}: {message}", target.place())));
    }
    let _ = uploads::get_uploads_dir(true);
    if let Some(hook) = hooks::workspace() {
        hook.switched().await;
    }
    events::invalidate().await;
    Ok(Item { active: true, has_board: true, workspace: target })
}

/// What a switch changes, kept so that a failed one can put it back.
struct Before {
    data_folder: PathBuf,
    db_path: PathBuf,
    uploads: PathBuf,
    /// The `database` section of the config file (empty: SQLite).
    section: Map<String, Value>,
    active: Option<Value>,
}

impl Before {
    fn capture() -> Before {
        Before {
            data_folder: current_folder(),
            db_path: database::get_db_path(),
            uploads: uploads::get_uploads_dir(false),
            section: config::get_section(targets::CONFIG_KEY),
            active: config::get_value(ACTIVE_KEY),
        }
    }

    /// Put the three keys of the config file, the uploads folder and the database connection back.
    async fn restore(&self) {
        let put_back = config::update(|data| {
            data.insert("data_folder".into(), Value::String(self.data_folder.to_string_lossy().into_owned()));
            if self.section.is_empty() {
                data.shift_remove(targets::CONFIG_KEY);
            } else {
                data.insert(targets::CONFIG_KEY.into(), Value::Object(self.section.clone()));
            }
            match &self.active {
                Some(active) => data.insert(ACTIVE_KEY.into(), active.clone()),
                None => data.shift_remove(ACTIVE_KEY),
            };
            true
        });
        if let Err(err) = put_back {
            tracing::error!(target: "workspaces", "The settings of the previous workspace could not be put back: {err}");
        }
        uploads::set_uploads_dir_env(&self.uploads);
        if let Err(err) = database::reinit_db(Some(self.db_path.clone())).await {
            tracing::error!(target: "workspaces", "The previous workspace could not be opened again: {err}");
        }
    }
}
