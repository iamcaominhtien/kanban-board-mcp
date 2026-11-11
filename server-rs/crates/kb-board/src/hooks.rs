//! Calls into areas that are above this crate (the Python code imports them late, inside a function). The upper
//! crate registers itself at startup; while a hook is not set the call is skipped.

use std::sync::OnceLock;

use async_trait::async_trait;
use kb_db::Session;
use kb_db::sea_orm::DbErr;
use serde_json::{Map, Value};

/// The AI team (`services/ai/teams.py`), as far as the board calls it.
#[async_trait]
pub trait AiTeamsHook: Send + Sync {
    /// `teams.check_name(session, project_id, name, exclude_id)`: names are unique across people and teams in a
    /// project. Returns the dict of the Python function: `{ok, conflict, message, suggestion}`.
    async fn check_name(
        &self,
        session: &Session,
        project_id: &str,
        name: &str,
        exclude_id: Option<&str>,
    ) -> Result<Map<String, Value>, DbErr>;
}

static AI_TEAMS: OnceLock<Box<dyn AiTeamsHook>> = OnceLock::new();

/// Register the AI team (once, at startup; a second call is ignored).
pub fn set_ai_teams_hook(hook: Box<dyn AiTeamsHook>) {
    let _ = AI_TEAMS.set(hook);
}

/// The AI team, when its crate has registered itself.
pub fn ai_teams() -> Option<&'static dyn AiTeamsHook> {
    AI_TEAMS.get().map(|hook| hook.as_ref())
}
