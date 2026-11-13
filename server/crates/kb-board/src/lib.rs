//! The board: projects, members, the project's git repository, tickets with everything they hold, the ticket
//! workspaces, the data backup and the log export (settings come with the MCP clients).

pub mod api;
pub mod git_repo;
pub mod hooks;
pub mod members;
pub mod projects;
pub mod proofs;
pub mod schemas;
pub mod ticket_guide;
pub mod ticket_waves;
pub mod tickets;
pub mod workspace;
