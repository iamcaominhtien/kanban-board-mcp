//! The board's MCP server: the tools an AI agent works the board with, and the protocol they are served over.
//!
//! - `protocol`: JSON-RPC as FastMCP 1.27 answers it, over stateless Streamable HTTP (`routes()`, mounted by the app
//!   at `/mcp/`) and over stdio (`protocol::stdio::serve`, the `kanban-mcp-stdio` program).
//! - `registry`: the tool list (served from the snapshot exported from the Python server) and the call of a tool;
//!   `validation` checks a call's arguments as FastMCP and Pydantic do, `pydantic` words the refusal.
//! - `operations`: one function per verb (create a project, add a member, ...), the building blocks.
//! - `tools`: the tools the agent sees; each routes an `action` to one of the operations (`tools::routing`).
//! - `common`: what tools and operations share; `hooks`: the calls into the AI team.
//! - `instructions`: what the server tells the agent on connect; `settings`: switches read from the environment.
//! - `bridge`: `kanban-mcp-stdio --bridge`, stdio forwarded to the board's HTTP endpoint with a run's token.

pub mod bridge;
pub mod common;
pub mod hooks;
pub mod instructions;
pub mod operations;
pub mod protocol;
pub mod pydantic;
pub mod registry;
pub mod settings;
pub mod tools;
pub mod validation;

pub use instructions::{build_instructions, mcp_instructions};
pub use settings::ideas_enabled;

/// The MCP endpoint (`/mcp/` and everything below it, every method), for the app to merge before its other routes.
pub fn routes() -> kb_base::Routes {
    protocol::http::routes()
}
