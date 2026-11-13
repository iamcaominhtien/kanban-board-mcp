//! Where the board keeps its data (SQLite, PostgreSQL or MySQL/MariaDB) and how it moves between them.
//!
//! design/screens/ai-databases.md. `kb_db::targets` names a database and opens it, `probe` tests one, `move_db`
//! checks, copies and verifies, `jobs` runs a copy in the background for Settings, `assist` asks an AI about a copy
//! that stopped, and `cli` is the `kanban-db` script. The CLI and the Settings routes run the same copy code.

pub mod api;
pub mod assist;
pub mod cli;
pub mod data;
pub mod hooks;
pub mod jobs;
pub mod move_db;
pub mod probe;
pub mod workspaces;
