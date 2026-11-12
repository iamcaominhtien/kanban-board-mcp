//! The operations behind the MCP tools: one function per verb, each doing exactly one thing.
//!
//! The tools in `crate::tools` route to these (the Idea Space ones are registered as tools one to one).

pub mod members;
pub mod projects;

pub use members::{add_member, list_members, remove_member};
pub use projects::{create_project, list_projects, update_project};
