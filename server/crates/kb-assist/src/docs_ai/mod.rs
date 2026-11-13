//! Docs AI: AI inside the Docs space (design/screens/docs-ai.md and docs-ai-care.md).
//!
//! Layout: `settings` holds the per-project switches and says which AI team answers, `jobs` records every Docs AI
//! call (the work the Docs UI polls); the turn itself runs on the assistant engine (`assistant::engine`), which keeps
//! the session of each page and the cost on its `ai_run`. An AI edits pages directly; the page's history undoes it.
//! (`services/docs_ai/__init__.py`, lines 1 to 10.)
//!
//! `tidy`, `health` and `handoff` are the Docs care features on top.

pub mod errors;
pub mod handoff;
pub mod health;
pub mod jobs;
pub mod settings;
pub mod tidy;

pub use errors::DocsAiError;
