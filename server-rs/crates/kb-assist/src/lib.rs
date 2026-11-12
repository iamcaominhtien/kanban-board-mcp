//! The assistants a person talks to inside the board (`services/assistant/`, `services/docs_ai/`) and their REST
//! routes.
//!
//! Ported so far: the assistant's engine and the Board AI chat (`assistant::{errors, settings, sessions, skills,
//! drafts, receipt, engine, health, chat}`). `assistant::{docs, editor, ideas}`, `services/docs_ai/` and the routes
//! (`api/assist.py`, `api/ai_tools.py`...) are later tasks. `seams` lists what waits for `services/ai/runs.py`.
//!
//! The app's lifespan calls `assistant::chat::recover()` once at start, right after `ai_runs.start_scheduler()` and
//! `docs_ai_jobs.recover()` and before `ai_schedules.start_scheduler()` (`server/main.py`, line 125).

pub mod api;
pub mod assistant;
pub mod seams;

use async_trait::async_trait;
use serde_json::{Map, Value};

/// Fill the slots of other crates that this crate's modules back (once, at startup):
///
/// - `kb_dbkit::hooks::AssistantHook` (`engine.any_cli()`, `engine.oneshot(skill, inputs)`: the helper of a stopped
///   database copy asks the board's assistant).
pub fn register() {
    kb_dbkit::hooks::set_assistant_hook(Box::new(DbHelper));
}

/// The `kb_dbkit::hooks::AssistantHook` this crate registers.
pub struct DbHelper;

#[async_trait]
impl kb_dbkit::hooks::AssistantHook for DbHelper {
    async fn any_cli(&self) -> Option<String> {
        assistant::engine::any_cli().await.0
    }

    async fn oneshot(&self, skill: &str, inputs: &Value) -> Result<kb_dbkit::hooks::Turn, String> {
        let inputs = inputs.as_object().cloned().unwrap_or_else(Map::new);
        let out = assistant::engine::oneshot(skill, &inputs, assistant::engine::OneshotOpts::default())
            .await
            .map_err(|err| err.to_string())?;
        Ok(kb_dbkit::hooks::Turn {
            text: out.text,
            structured: out.structured,
            state: out.state,
            error: out.error,
            cost: out.cost,
            elapsed_s: out.elapsed_s,
        })
    }
}
