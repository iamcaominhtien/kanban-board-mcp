//! The assistants a person talks to inside the board (`services/assistant/`, `services/docs_ai/`) and their REST
//! routes.
//!
//! Ported: the assistant's engine and the Board AI chat (`assistant::{errors, settings, sessions, skills, drafts,
//! receipt, engine, health, chat}`, part 1), the Docs AI, the editor assistant and the ideas assistant
//! (`assistant::{docs, editor, ideas}`) and `docs_ai::{errors, settings, jobs, tidy, health, handoff}` (part 2). The
//! routes (`api/docs_ai/`, `api/assist.py`, `api/ai_editor.py`, `api/ai_sketch.py`, `api/idea_ai.py`) are in `api`,
//! one block in the order of `main.py`. `seams` lists what this crate asks of `services/ai/runs.py` (filled by
//! `register`); `hooks` lists the hooks and seams of other crates this crate backs.
//!
//! The app's lifespan calls, in `server/main.py` (lines 123 to 126), in this order: `ai_runs.start_scheduler()`, then
//! `docs_ai_jobs.recover()` (`docs_ai::jobs::recover().await`, line 124), then `assistant_chat.recover()`
//! (`assistant::chat::recover().await`, line 125), then `ai_schedules.start_scheduler()`. `register()` is called once
//! before them.

pub mod api;
pub mod assistant;
pub mod docs_ai;
pub mod hooks;
pub mod seams;

use async_trait::async_trait;
use serde_json::{Map, Value};

/// Fill the slots of other crates that this crate's modules back (once, at startup):
///
/// - `kb_dbkit::hooks::AssistantHook` (`engine.any_cli()`, `engine.oneshot(skill, inputs)`: the helper of a stopped
///   database copy asks the board's assistant);
/// - `kb_docs::hooks::AssignHook` and `kb_docs::hooks::DocsAiHook` (see `hooks`);
/// - the seams of `kb-ai-run` (`kb_ai_run::seams::set_page_notes`) and of this crate (`seams::set_runs`, backed by
///   `kb_ai_run::runs`);
/// - the handlers of the Docs AI jobs (`docs_ai::jobs::register`).
///
/// `kb_draw::hooks::CanvasDelivery` is `kb_ai_run::register()`'s (one slot, filled first by the app).
pub fn register() {
    kb_dbkit::hooks::set_assistant_hook(Box::new(DbHelper));
    assistant::docs::register_handlers();
    kb_docs::hooks::set_assign_hook(Box::new(hooks::Assign));
    kb_docs::hooks::set_docs_ai_hook(Box::new(hooks::Docs));
    kb_ai_run::seams::set_page_notes(Some(std::sync::Arc::new(hooks::Notes)));
    seams::set_runs(Some(std::sync::Arc::new(hooks::CoreRuns)));
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
