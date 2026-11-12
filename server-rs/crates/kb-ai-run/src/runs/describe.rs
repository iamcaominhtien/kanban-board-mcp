//! Describing a run (`services/ai/runs.py` lines 161-236): `_is_live`, `to_dict`, `_publish_run`.

use kb_ai::store::loads;
use kb_base::events;
use kb_db::database;
use kb_db::entities::ai_run;
use kb_db::sea_orm::{DbErr, EntityTrait};
use serde_json::{Map, Value, json};

use super::RT;

/// Can a message reach the CLI of this run right now? This process knows when it runs the CLI itself; with the
/// runner process the row says it.
pub fn is_live(run: &ai_run::Model) -> bool {
    if let Some(proc) = RT.proc(&run.id) {
        return proc.live && proc.input_open();
    }
    run.live && matches!(run.state.as_str(), "starting" | "running")
}

/// `loads(text, None) if text else None`.
fn loads_or_null(text: Option<&str>) -> Value {
    match text.filter(|t| !t.is_empty()) {
        Some(text) => loads(Some(text), Value::Null),
        None => Value::Null,
    }
}

/// A run for the API: no steps (they are rows, fetched by page).
pub fn to_dict(run: &ai_run::Model) -> Map<String, Value> {
    let mut out = Map::new();
    out.insert("id".into(), json!(run.id));
    out.insert("project_id".into(), json!(run.project_id));
    out.insert("kind".into(), json!(run.kind));
    out.insert("ticket_id".into(), json!(run.ticket_id));
    out.insert("target".into(), json!(run.target));
    out.insert("member_id".into(), json!(run.member_id));
    out.insert("number".into(), json!(run.number));
    out.insert("mode".into(), json!(run.mode));
    out.insert("trigger".into(), json!(run.trigger));
    out.insert("state".into(), json!(run.state));
    out.insert("started_by".into(), json!(run.started_by));
    out.insert("instruction".into(), json!(run.instruction));
    out.insert("queued_at".into(), json!(run.queued_at));
    out.insert("started_at".into(), json!(run.started_at));
    out.insert("ended_at".into(), json!(run.ended_at));
    out.insert("last_output_at".into(), json!(run.last_output_at));
    out.insert("ended_reason".into(), json!(run.ended_reason));
    out.insert("ended_by".into(), json!(run.ended_by));
    out.insert("exit_code".into(), json!(run.exit_code));
    out.insert("summary".into(), json!(run.summary));
    out.insert("report".into(), loads(Some(&run.report), json!({})));
    out.insert("question".into(), loads_or_null(run.question.as_deref()));
    out.insert("answer".into(), json!(run.answer));
    out.insert("session_id".into(), json!(run.session_id));
    out.insert("session_name".into(), json!(run.session_name));
    out.insert("files".into(), loads(Some(&run.files), json!([])));
    out.insert("tokens_in".into(), json!(run.tokens_in));
    out.insert("tokens_out".into(), json!(run.tokens_out));
    out.insert("tokens_cached".into(), json!(run.tokens_cached));
    out.insert("cost_usd".into(), json!(run.cost_usd));
    out.insert("context_used".into(), json!(run.context_used));
    out.insert("context_window".into(), json!(run.context_window));
    out.insert("pid".into(), json!(run.pid));
    out.insert("model".into(), json!(run.model));
    out.insert("effort".into(), json!(run.effort));
    out.insert("paused".into(), json!(run.paused));
    out.insert("stop_code".into(), json!(run.stop_code));
    out.insert("peak_rss_mb".into(), json!(run.peak_rss_mb));
    out.insert("last_rss_mb".into(), json!(run.last_rss_mb));
    out.insert("restarts".into(), loads(Some(&run.restarts), json!([])));
    out.insert("diagnosis".into(), loads_or_null(run.diagnosis.as_deref()));
    out.insert("retries".into(), loads(Some(&run.retries), json!([])));
    out.insert("account_id".into(), json!(run.account_id));
    out.insert("steps_count".into(), json!(run.steps_count));
    out.insert("live".into(), json!(is_live(run)));
    let waiting = if run.state == "queued" {
        RT.waiting(&run.id).filter(|w| !w.is_empty()).or_else(|| run.waiting_reason.clone())
    } else {
        None
    };
    out.insert("waiting_reason".into(), json!(waiting));
    out
}

/// `board_events.publish_typed("ai.run", {"run": to_dict(run)})`.
pub(crate) async fn publish_dict(run: &ai_run::Model) {
    let mut payload = Map::new();
    payload.insert("run".into(), Value::Object(to_dict(run)));
    events::publish_typed("ai.run", &payload).await;
}

/// Announce a run as it is stored now.
pub(crate) async fn publish_run(run_id: &str) -> Result<(), DbErr> {
    let run = {
        let session = database::session();
        ai_run::Entity::find_by_id(run_id).one(&session).await?
    };
    if let Some(run) = run {
        publish_dict(&run).await;
        events::mark_own_change();
    }
    Ok(())
}
