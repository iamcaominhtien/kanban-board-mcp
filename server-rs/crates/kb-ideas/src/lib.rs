//! The Idea Space: ideas (`IDEA-N`) with an inbox and stages, assumptions and evidence, comments, a log, votes,
//! similarity, and promotion of an idea into tickets (`services/idea_*.py`, `api/idea_space.py`,
//! `api/idea_tickets.py`).
//!
//! Where Python imports the AI team or the assistant late (`api/idea_ai.py`, which is not part of this crate), the
//! upper crate fills the hooks. This crate declares none: its one hook is `kb_board::hooks::IdeaPromoteHook`, which
//! `hooks::register` fills.

pub mod api;
pub mod error;
pub mod hooks;
pub mod idea_promote;
pub mod idea_similarity;
pub mod idea_space;
pub mod idea_tickets;
pub mod model;
pub mod schemas;

pub use error::{Error, IdeaRuleError};
pub use hooks::register;
