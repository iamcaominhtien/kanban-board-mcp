//! The assistants (AI v2, spec 4.7): Docs AI, the Board AI, Idea AI, the editor's /ai and the Sketch helper are one
//! kind of Claude Code session, started by the board for a person, with the board's tools and a skill per feature
//! (`services/assistant/__init__.py`, lines 1 to 10).
//!
//! `engine::turn` runs one turn; `sessions` keeps one conversation per thing (a page, the board, an idea, a chat);
//! `skills` ships the feature skills as a plugin; `docs`, `chat`, `ideas` and `editor` are the features on top
//! (`docs`, `editor` and `ideas` are not ported yet).

pub mod chat;
pub mod docs;
pub mod drafts;
pub mod editor;
pub mod engine;
pub mod errors;
pub mod health;
pub mod ideas;
pub mod receipt;
pub mod sessions;
pub mod settings;
pub mod skills;

pub use errors::AssistError;
