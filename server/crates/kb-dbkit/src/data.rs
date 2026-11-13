//! What the data backup (`api/data.py`, in `kb-board`) does with the copy code when PostgreSQL or MySQL is in use:
//! the export is a SQLite copy of every table, and an import replaces the server's tables with a SQLite file's.
//!
//! These two functions are what `kb_board::hooks::DbMoveHook` stands for; the app registers a hook that calls them.

use std::path::Path;

use kb_db::database;
use kb_db::targets::Target;

use crate::move_db::{Error, Mover};

async fn copy(source: Target, target: Target, empty_first: bool) -> Result<(), Error> {
    let mut m = Mover::new(source, target, None).await?;
    let copied = async {
        m.open().await?;
        m.plan().await?;
        m.prepare_target(empty_first, false).await?;
        m.copy(None, None).await
    }
    .await;
    m.close().await;
    copied
}

/// `Mover(db.current_target(), Target("sqlite", path=path))`: `plan()`, `prepare_target()`, `copy()`. Writes a SQLite
/// file with every table of the database in use; the error is the message of the failure.
pub async fn copy_current_to_sqlite(path: &Path) -> Result<(), String> {
    let target = Target::sqlite(path.to_string_lossy().into_owned());
    copy(database::current_target(), target, false).await.map_err(|err| err.to_string())
}

/// `Mover(Target("sqlite", path=source), db.current_target())`: `plan()`, `prepare_target(empty_first=True)`,
/// `copy()`. Replaces the data of the database in use with the tables of the SQLite file.
pub async fn copy_sqlite_into_current(source: &Path) -> Result<(), String> {
    let source = Target::sqlite(source.to_string_lossy().into_owned());
    copy(source, database::current_target(), true).await.map_err(|err| err.to_string())
}
