//! What the board hands to AI agents and installs for them: the shared and role skills (texts and the folders they
//! carry), the install of the board as an MCP server in Claude Code and Antigravity, and the Settings routes.
//!
//! Port of `services/shared_skills.py`, `role_skills.py`, `slides_skill/`, `demo_video_skill/`, `ba_templates/`,
//! `design_examples/`, `office_examples/`, `services/mcp_clients.py` and `api/settings.py`.
//!
//! The skill folders are product assets that Claude Code runs on the person's machine (Python scripts, Markdown,
//! HTML, themes). The server never runs them; it only hands them out, so they are embedded as data
//! (`assets/<folder>/`, indexed by `asset_index.rs`) and `files()` of each package returns the same names and bytes
//! in the same order as the Python package.

pub mod api;
mod asset_index;
pub mod assets;
pub mod ba_templates;
pub mod demo_video_skill;
pub mod hooks;
pub mod mcp_clients;
pub mod role_skills;
pub mod shared_skills;
pub mod slides_skill;
