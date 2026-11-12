//! The assistants a person talks to inside the board (`services/assistant/`, `services/docs_ai/`) and their REST
//! routes.
//!
//! Ported: the assistant's engine and the Board AI chat (`assistant::{errors, settings, sessions, skills, drafts,
//! receipt, engine, health, chat}`, part 1), the Docs AI, the editor assistant and the ideas assistant
//! (`assistant::{docs, editor, ideas}`) and `docs_ai::{errors, settings, jobs, tidy, health, handoff}` (part 2). The
//! routes (`api/assist.py`, `api/docs_ai/`, `api/ai_editor.py`, `api/idea_ai.py`, `api/ai_sketch.py`) are a later
//! task. `seams` lists what waits for `services/ai/runs.py`; `hooks` lists the hooks of other crates this crate backs.
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
/// - `kb_draw::hooks::CanvasDelivery` and `kb_docs::hooks::AssignHook` (see `hooks`);
/// - the handlers of the Docs AI jobs (`docs_ai::jobs::register`).
pub fn register() {
    kb_dbkit::hooks::set_assistant_hook(Box::new(DbHelper));
    assistant::docs::register_handlers();
    kb_draw::hooks::set_canvas_delivery(Box::new(hooks::Delivery));
    kb_docs::hooks::set_assign_hook(Box::new(hooks::Assign));
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
