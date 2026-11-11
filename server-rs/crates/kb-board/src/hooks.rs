//! Calls into areas that are above this crate (the Python code imports them late, inside a function). The upper
//! crate registers itself at startup; while a hook is not set the call is skipped.

use std::path::Path;
use std::sync::OnceLock;

use async_trait::async_trait;
use kb_db::Session;
use kb_db::sea_orm::DbErr;
use serde_json::{Map, Value};

/// The AI team (`services/ai/teams.py`), as far as the board calls it.
#[async_trait]
pub trait AiTeamsHook: Send + Sync {
    /// `teams.check_name(session, project_id, name, exclude_id)`: names are unique across people and teams in a
    /// project. Returns the dict of the Python function: `{ok, conflict, message, suggestion}`.
    async fn check_name(
        &self,
        session: &Session,
        project_id: &str,
        name: &str,
        exclude_id: Option<&str>,
    ) -> Result<Map<String, Value>, DbErr>;
}

static AI_TEAMS: OnceLock<Box<dyn AiTeamsHook>> = OnceLock::new();

/// Register the AI team (once, at startup; a second call is ignored).
pub fn set_ai_teams_hook(hook: Box<dyn AiTeamsHook>) {
    let _ = AI_TEAMS.set(hook);
}

/// The AI team, when its crate has registered itself.
pub fn ai_teams() -> Option<&'static dyn AiTeamsHook> {
    AI_TEAMS.get().map(|hook| hook.as_ref())
}

/// The copy code that moves a board between databases (`dbkit/move.py`'s `Mover`), as far as the data backup calls it
/// when PostgreSQL or MySQL is in use (the export is a SQLite copy of every table; an import replaces them).
#[async_trait]
pub trait DbMoveHook: Send + Sync {
    /// `Mover(db.current_target(), Target("sqlite", path=path))`: `plan()`, `prepare_target()`, `copy()`. Writes a
    /// SQLite file with every table of the database in use; the error is the message of the failure.
    async fn copy_current_to_sqlite(&self, path: &Path) -> Result<(), String>;

    /// `Mover(Target("sqlite", path=source), db.current_target())`: `plan()`, `prepare_target(empty_first=True)`,
    /// `copy()`. Replaces the data of the database in use with the tables of the SQLite file.
    async fn copy_sqlite_into_current(&self, source: &Path) -> Result<(), String>;
}

static DB_MOVE: OnceLock<Box<dyn DbMoveHook>> = OnceLock::new();

/// Register the database kit (once, at startup; a second call is ignored).
pub fn set_db_move_hook(hook: Box<dyn DbMoveHook>) {
    let _ = DB_MOVE.set(hook);
}

/// The database kit, when its crate has registered itself.
pub fn db_move() -> Option<&'static dyn DbMoveHook> {
    DB_MOVE.get().map(|hook| hook.as_ref())
}
