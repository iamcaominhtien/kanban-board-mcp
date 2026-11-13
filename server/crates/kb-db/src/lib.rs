//! The board's database: which one is in use, how it is opened, sessions, the tables, and bringing the schema up to
//! date. SQLite in the data folder is the default; PostgreSQL or MySQL/MariaDB when `KANBAN_DATABASE_URL` says so or
//! when it was chosen in Settings.

pub mod changes;
pub mod database;
pub mod entities;
pub mod float;
pub mod migrations;
pub mod save;
pub mod schema;
pub mod session;
pub mod sql;
pub mod sqlite_gate;
pub mod targets;

pub use database::{conn, is_sqlite, session};
pub use float::Float;
pub use save::{Edit, edit, save_model};
pub use sea_orm;
pub use session::Session;

/// What a database call returns.
pub type DbResult<T> = Result<T, sea_orm::DbErr>;
