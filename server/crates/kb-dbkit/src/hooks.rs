//! Calls into areas that are above this crate (the Python code imports them late, inside a function). The upper
//! crate registers itself at startup; while a hook is not set the call is skipped.

use std::sync::OnceLock;

use async_trait::async_trait;
use kb_db::sea_orm::{DatabaseTransaction, DbErr};
use serde_json::{Map, Value};

/// What one turn of the board's assistant gave back (`services.assistant.engine.Turn`, as far as the database
/// helper reads it).
#[derive(Debug, Clone, PartialEq)]
pub struct Turn {
    pub text: String,
    pub structured: Option<Map<String, Value>>,
    /// finished | failed | cancelled
    pub state: String,
    pub error: Option<String>,
    pub cost: f64,
    pub elapsed_s: f64,
}

impl Default for Turn {
    fn default() -> Self {
        Self { text: String::new(), structured: None, state: "finished".into(), error: None, cost: 0.0, elapsed_s: 0.0 }
    }
}

/// The board's assistant (`services/assistant/engine.py`), as far as the helper of a stopped copy calls it.
#[async_trait]
pub trait AssistantHook: Send + Sync {
    /// `engine.any_cli()`: the path of Claude Code on this computer (the first AI team's of any project, else the
    /// one on PATH), or `None` when there is none.
    async fn any_cli(&self) -> Option<String>;

    /// `engine.oneshot(skill, inputs)`: one answer with a skill and nothing else. The error is the message of the
    /// engine's `AssistError` (`str(exc)`).
    async fn oneshot(&self, skill: &str, inputs: &Value) -> Result<Turn, String>;
}

static ASSISTANT: OnceLock<Box<dyn AssistantHook>> = OnceLock::new();

/// Register the board's assistant (once, at startup; a second call is ignored).
pub fn set_assistant_hook(hook: Box<dyn AssistantHook>) {
    let _ = ASSISTANT.set(hook);
}

/// The board's assistant, when its crate has registered itself.
pub fn assistant() -> Option<&'static dyn AssistantHook> {
    ASSISTANT.get().map(|hook| hook.as_ref())
}

/// The Docs search index (`services/docs_search.py`), as far as a copy into a SQLite file calls it.
#[async_trait]
pub trait DocsSearchHook: Send + Sync {
    /// `docs_search.backfill_sync(conn)`: index every live page from its latest version (or, if never published, its
    /// draft) into `docs_fts`, inside the transaction of the copy on the new SQLite file.
    async fn backfill(&self, txn: &DatabaseTransaction) -> Result<(), DbErr>;
}

static DOCS_SEARCH: OnceLock<Box<dyn DocsSearchHook>> = OnceLock::new();

/// Register the Docs search (once, at startup; a second call is ignored).
pub fn set_docs_search_hook(hook: Box<dyn DocsSearchHook>) {
    let _ = DOCS_SEARCH.set(hook);
}

/// The Docs search, when its crate has registered itself.
pub fn docs_search() -> Option<&'static dyn DocsSearchHook> {
    DOCS_SEARCH.get().map(|hook| hook.as_ref())
}

/// What a workspace switch must ask of the AI team (`kb-ai`, above this crate).
#[async_trait]
pub trait WorkspaceHook: Send + Sync {
    /// Why the board cannot be switched now (AI runs are working on it), or `None`.
    async fn busy(&self) -> Option<String>;

    /// The board was switched: stop what still holds the old one (the AI runner starts again, on the new board, with
    /// the next run).
    async fn switched(&self);
}

static WORKSPACE: OnceLock<Box<dyn WorkspaceHook>> = OnceLock::new();

/// Register the AI team's side of a workspace switch (once, at startup; a second call is ignored).
pub fn set_workspace_hook(hook: Box<dyn WorkspaceHook>) {
    let _ = WORKSPACE.set(hook);
}

/// The AI team's side of a switch, when its crate has registered itself.
pub fn workspace() -> Option<&'static dyn WorkspaceHook> {
    WORKSPACE.get().map(|hook| hook.as_ref())
}
