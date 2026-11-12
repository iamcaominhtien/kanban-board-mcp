//! Move the board's data from one database to another, in any direction (design D, E): check both ends, make the
//! tables on the target, copy table by table, then prove the copy (counts, a sample of rows read back, links between
//! rows, counters, docs search). The `kanban-db` script and the Settings wizard both run this module.
//!
//! How the copy keeps its promises:
//!
//! - The source is only read, inside one transaction with a consistent snapshot (SQLite's read transaction,
//!   REPEATABLE READ on PostgreSQL and MySQL), so every table is copied as it was at the same moment while the board
//!   stays usable.
//! - The target gets the app's own tables, at the newest migration (`kb_db::schema::create_schema`).
//! - Each table is one transaction on the target that first empties it. A copy that stops leaves the tables before
//!   it complete and the one it stopped in empty, so resuming re-reads that table from its start and never
//!   duplicates.
//! - Values are converted to the target column's type (SQLite lets a text column hold a number; PostgreSQL does not).
//! - Batches of up to 1,000 rows (fewer when rows are large), each in a savepoint: when a batch fails, its rows are
//!   tried one by one to name the exact row and column that would not go in.
//!
//! The Python module is `dbkit/move.py` (`move` is a keyword in Rust).

mod defaults;
mod errors;
mod mover;
pub(crate) mod raw;
mod search;
mod values;
mod verify;

pub use errors::{Error, MoveError, Stop, clean_any, clean_error, clean_text, error_column};
pub(crate) use errors::{raw_error, sqlx_of as raw_sqlx};
pub(crate) use mover::described;
pub use mover::{
    BATCH_BYTES, BATCH_ROWS, Event, FTS_TABLES, Mover, NOT_COPIED, Plan, Progress, SAMPLE_ROWS, TableState, app_tables,
    model_default, sample_seed, summary_line,
};
pub use values::{Cell, coerce, commas, row_bytes, same};
