//! How the board's own connections share a SQLite file inside one process: writers in line (`dbkit/sqlite_gate.py`).
//!
//! SQLite lets one writer in at a time, and the others poll for the lock (sleep, try again), which is not first
//! come, first served: under load a writer could miss its turn for the whole busy timeout and fail with "database is
//! locked". Before its first write, a transaction takes the write gate, a lock of the process that gives the turns in
//! order (`tokio::sync::Mutex` is fair: waiters are served in the order they came); it lets go when the transaction
//! ends (commit, rollback, or the session dropped). Other processes still meet at SQLite's own lock, as before.
//! Readers never take the gate (WAL: readers do not wait for writers).
//!
//! PostgreSQL and MySQL are not concerned.
//!
//! Ported differently: the Python module also lets one SQLite call run at a time in the process ("the call lock").
//! That was for Python's GIL, which ten threads of `aiosqlite` fought over (a 6 ms read took 120-330 ms); a Rust
//! connection's calls run on their own thread without such a lock, so it is left out. The gate is taken by the
//! session at the start of its write transaction (`enter_for`), where Python's connection wrapper took it at the
//! first statement that `may_wait`.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::Duration;

use regex::Regex;
use sea_orm::{DatabaseConnection, DbBackend, DbErr, RuntimeErr};
use tokio::sync::OwnedMutexGuard;

/// How long a writer waits for its turn, as SQLite's busy timeout does for the lock itself.
pub const WRITE_WAIT_S: u64 = 30;

/// Statements that never wait for a lock (WAL: readers do not wait for writers).
static READ: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)^\s*(SELECT|EXPLAIN|VALUES)\b").expect("a valid pattern"));
static WITH: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)^\s*WITH\b").expect("a valid pattern"));
static DML: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)\b(INSERT|UPDATE|DELETE|REPLACE)\b").expect("a valid pattern"));
static PRAGMA: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)^\s*PRAGMA\s+(?:\w+\.)?(\w+)").expect("a valid pattern"));
/// The pragmas that take a lock of the file; the others are settings of the connection, or reads.
const LOCKING_PRAGMAS: [&str; 10] = [
    "journal_mode",
    "user_version",
    "application_id",
    "schema_version",
    "wal_checkpoint",
    "incremental_vacuum",
    "optimize",
    "auto_vacuum",
    "page_size",
    "locking_mode",
];

/// The write gate of each file (copying a board to another file writes one while it reads the other).
static GATES: LazyLock<Mutex<HashMap<PathBuf, Arc<tokio::sync::Mutex<()>>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// Whether a statement can take the write lock (and so wait for another process).
pub fn may_wait(sql: &str) -> bool {
    if READ.is_match(sql) {
        return false;
    }
    if WITH.is_match(sql) {
        return DML.is_match(sql);
    }
    if let Some(pragma) = PRAGMA.captures(sql) {
        let name = pragma.get(1).map_or(String::new(), |m| m.as_str().to_lowercase());
        return LOCKING_PRAGMAS.contains(&name.as_str());
    }
    true
}

/// `os.path.realpath(path)`: the key of a file's gate.
fn realpath(path: &Path) -> PathBuf {
    if let Ok(real) = std::fs::canonicalize(path) {
        return real;
    }
    let absolute = std::path::absolute(path).unwrap_or_else(|_| path.to_path_buf());
    match (absolute.parent().and_then(|p| std::fs::canonicalize(p).ok()), absolute.file_name()) {
        (Some(parent), Some(name)) => parent.join(name),
        _ => absolute,
    }
}

/// The write gate of the file at `path`.
fn gate(path: &Path) -> Arc<tokio::sync::Mutex<()>> {
    GATES.lock().unwrap_or_else(|e| e.into_inner()).entry(realpath(path)).or_default().clone()
}

/// A writer's turn: the gate is held until this is dropped (the transaction ended).
#[derive(Debug)]
pub struct WritePermit {
    _turn: OwnedMutexGuard<()>,
}

/// The error of a writer that never got its turn: what SQLite says when its own lock times out.
pub fn locked() -> DbErr {
    DbErr::Exec(RuntimeErr::Internal("database is locked".to_string()))
}

/// Wait in line for the write gate of the file at `path`, at most `WRITE_WAIT_S`.
pub async fn enter(path: &Path) -> Result<WritePermit, DbErr> {
    enter_within(path, Duration::from_secs(WRITE_WAIT_S)).await
}

/// Wait in line for the write gate of the file at `path`, at most `wait`; "database is locked" after that.
pub async fn enter_within(path: &Path, wait: Duration) -> Result<WritePermit, DbErr> {
    match tokio::time::timeout(wait, gate(path).lock_owned()).await {
        Ok(turn) => Ok(WritePermit { _turn: turn }),
        Err(_) => Err(locked()),
    }
}

/// The write gate for a transaction about to write on `conn`: a permit on a SQLite file, `None` on another engine
/// (or an in-memory database, which no other connection shares).
pub async fn enter_for(conn: &DatabaseConnection) -> Result<Option<WritePermit>, DbErr> {
    match file_of(conn) {
        Some(path) => enter(&path).await.map(Some),
        None => Ok(None),
    }
}

/// The SQLite file a pool opens, or `None`.
pub fn file_of(conn: &DatabaseConnection) -> Option<PathBuf> {
    if conn.get_database_backend() != DbBackend::Sqlite {
        return None;
    }
    let pool = conn.get_sqlite_connection_pool();
    let options = pool.connect_options();
    let file = options.get_filename();
    let text = file.to_string_lossy();
    if text.is_empty() || text == ":memory:" { None } else { Some(file.to_path_buf()) }
}

/// Whether a writer holds the gate of the file at `path` now.
pub fn is_held(path: &Path) -> bool {
    gate(path).try_lock().is_err()
}
