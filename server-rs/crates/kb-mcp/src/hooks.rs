//! Calls into the AI team (`services/ai/guard.py`), which the Python tools import late, inside a function. The AI
//! crate registers itself at startup (`kb-app/src/hooks.rs`); while the hook is not set a call acts as one from
//! outside any board run, which is what the guard does for a request without a run's token.
//!
//! The other calls into the AI team that tools make (`ai_runs.before_ticket_change`, `note_person_edit`,
//! `wake_new_assignee`, `ai_worktrees.on_status`) are already declared by the board: use
//! `kb_board::hooks::ai_runs()` for them, do not declare them again here.

use std::sync::OnceLock;

use async_trait::async_trait;
use futures::future::BoxFuture;
use serde_json::{Map, Value};

use crate::common::ToolResult;

/// `services.ai.context.RunContext`: who is acting while a run's tool calls are handled.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct RunContext {
    pub run_id: String,
    pub member_id: String,
    pub member_name: String,
    pub project_id: String,
    /// None for a run that is not on a ticket
    pub ticket_id: Option<String>,
    pub on_behalf_of: String,
    /// work | ask
    pub mode: String,
    pub trigger: String,
    /// AI-to-AI hand-offs behind this run
    pub depth: i64,
    /// A Board AI chat answer that acts by risk tier: its board tools only read
    pub acts_by_tier: bool,
}

/// The operation a guarded call runs, given the arguments the guard settled on.
pub type GuardedCall = Box<dyn FnOnce(Map<String, Value>) -> BoxFuture<'static, ToolResult> + Send>;

/// The guard of the AI team: who an MCP call acts for.
#[async_trait]
pub trait AiGuardHook: Send + Sync {
    /// `guard.resolve()`: the run of the current MCP request, or the one already entered. `authorization` is the
    /// `Authorization` header of the request being handled (`None` over stdio or without one); a board run sends
    /// `Bearer kbr_…` (`common::request_token_of` reads the token). The error is the message of `AiActionError`
    /// (the run has ended).
    async fn resolve(&self, authorization: Option<&str>) -> Result<Option<RunContext>, String>;

    /// `guard.guarded(tool, action, given, call)`: run `call(given)` for an MCP tool, attributed to the AI run it
    /// comes from (and skipped when the run repeats a write it made right before it was resumed). Outside a run
    /// it is `call(given)`.
    async fn guarded(
        &self,
        tool: &str,
        action: &str,
        given: Map<String, Value>,
        authorization: Option<&str>,
        call: GuardedCall,
    ) -> ToolResult;
}

static AI_GUARD: OnceLock<Box<dyn AiGuardHook>> = OnceLock::new();

/// Register the AI team's guard (once, at startup; a second call is ignored).
pub fn set_ai_guard_hook(hook: Box<dyn AiGuardHook>) {
    let _ = AI_GUARD.set(hook);
}

/// The AI team's guard, when its crate has registered itself.
pub fn ai_guard() -> Option<&'static dyn AiGuardHook> {
    AI_GUARD.get().map(|hook| hook.as_ref())
}
