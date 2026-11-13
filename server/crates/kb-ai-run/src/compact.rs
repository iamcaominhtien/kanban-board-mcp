//! `/compact` in the ticket chat: summarise the older part of the lead's conversation so it has room again
//! (`services/ai/compact.py`).
//!
//! A lead that is working is not stopped (tried with the light model: a `/compact` sent to a working session waits
//! for the end of its turn, and the board closes the session's input then, so the command would be lost). The board
//! keeps the wish and runs the compaction itself when the run has ended. A lead that is idle has its last session
//! compacted by the CLI, run once with `--resume` in the folder the session was made in. For a lead that works for
//! hours, the project's auto-compact level (Settings > AI) is what keeps its context from filling: Claude Code then
//! compacts between two steps, without a stop.

use std::path::Path;
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use kb_ai::store::{active_runs, now_iso};
use kb_ai_work::worktrees;
use kb_base::{ctx, pyjson, pytext};
use kb_db::database;
use kb_db::entities::{ai_account, ai_run, ai_run_message, ticket};
use kb_db::sea_orm::{
    ActiveModelTrait, ActiveValue::Set, ColumnTrait, EntityTrait, ModelTrait, QueryFilter, QueryOrder, QuerySelect,
};
use serde_json::{Map, Value, json};
use tokio::io::AsyncReadExt;

use crate::runs::RunError;
use crate::teams::get_profile;
use crate::{accounts, cli};

/// How long the CLI may take to compact a conversation, in seconds.
pub const TIMEOUT_S: u64 = 300;
/// The note the chat leaves on a working run; the run's end acts on it.
pub const WISH: &str = "/compact (when this run has ended)";

/// How long `after_run` waits before it compacts (the session file is closed, and a run that follows on the ticket
/// can be seen): 2 seconds in Python (`asyncio.sleep(2)`); milliseconds here, so a test can shorten it.
static SETTLE_MS: AtomicU64 = AtomicU64::new(2_000);

/// Change the wait of `after_run` before it compacts (the Python tests would patch `asyncio.sleep`).
pub fn set_settle_s(seconds: f64) {
    SETTLE_MS.store((seconds * 1000.0) as u64, Ordering::SeqCst);
}

/// Compact the conversation of the team that works the ticket. Returns `{"state": "queued" | "done", ...}`.
pub async fn compact_ticket(ticket_id: &str, by: &str) -> Result<Map<String, Value>, RunError> {
    let (live, last) = {
        let session = database::session();
        let live = active_runs(&session, None, Some(ticket_id)).await?;
        let last = ai_run::Entity::find()
            .filter(ai_run::Column::TicketId.eq(ticket_id))
            .filter(ai_run::Column::SessionId.is_not_null())
            .order_by_desc(ai_run::Column::QueuedAt)
            .limit(1)
            .one(&session)
            .await?;
        (live, last)
    };
    if let Some(run) = live.first() {
        let session = database::session();
        // a row in the run's messages: the process that ends the run (the runner) reads it from the database
        let mut row = ai_run_message::new();
        row.run_id = Set(run.id.clone());
        row.direction = Set("in".to_string());
        row.peer = Set(by.chars().take(200).collect());
        row.text = Set(WISH.to_string());
        row.insert(&session).await?;
        session.commit().await?;
        let mut out = Map::new();
        out.insert("state".into(), json!("queued"));
        out.insert("run_id".into(), json!(run.id));
        return Ok(out);
    }
    let Some(last) = last else {
        return Err(RunError::Run("There is no conversation of the team on this ticket yet.".into()));
    };
    compact_idle(&last, by).await
}

/// A run ended: compact the lead's conversation now when someone asked for it while the run worked (in the
/// background, as Python's task does).
pub fn after_run(ticket_id: &str, run_id: &str) {
    let (ticket_id, run_id) = (ticket_id.to_string(), run_id.to_string());
    ctx::spawn(async move {
        match go(&ticket_id, &run_id).await {
            Ok(()) => {}
            // (Python catches `RunError` and `OSError`; anything else ends the task with its traceback)
            Err(err) => tracing::info!(target: "kanban.ai.compact", "compact after run {run_id} skipped: {err}"),
        }
    });
}

async fn go(ticket_id: &str, run_id: &str) -> Result<(), RunError> {
    {
        let session = database::session();
        let asked = ai_run_message::Entity::find()
            .filter(ai_run_message::Column::RunId.eq(run_id))
            .filter(ai_run_message::Column::Text.eq(WISH))
            .one(&session)
            .await?;
        let Some(asked) = asked else { return Ok(()) };
        asked.delete(&session).await?;
        session.commit().await?;
    }
    // the session file is closed, and a run that follows on the ticket can be seen
    tokio::time::sleep(Duration::from_millis(SETTLE_MS.load(Ordering::SeqCst))).await;
    let last = {
        let session = database::session();
        if !active_runs(&session, None, Some(ticket_id)).await?.is_empty() {
            return Ok(()); // it works again: the auto-compact level looks after it
        }
        ai_run::Entity::find_by_id(run_id).one(&session).await?
    };
    let Some(last) = last.filter(|r| r.session_id.as_deref().is_some_and(|s| !s.is_empty())) else {
        return Ok(());
    };
    compact_idle(&last, "the chat").await.map(|_| ())
}

/// `_compact_idle`: run the CLI once on the lead's last session with `/compact`, and keep the session it answers
/// with and the size of the conversation after it.
pub(crate) async fn compact_idle(last: &ai_run::Model, _by: &str) -> Result<Map<String, Value>, RunError> {
    let (path, cwd, session_id, model, account, config_dir) = {
        let session = database::session();
        let Some(run) = ai_run::Entity::find_by_id(last.id.as_str()).one(&session).await? else {
            return Err(RunError::Other(format!("run {} is gone", last.id)));
        };
        let (member, profile) = get_profile(&session, &run.member_id).await?;
        let (Some(_member), Some(profile)) = (member, profile) else {
            return Err(RunError::Run("The team no longer exists.".into()));
        };
        let account_id = run
            .account_id
            .clone()
            .filter(|a| !a.is_empty())
            .or_else(|| profile.account_id.clone().filter(|a| !a.is_empty()));
        let account = match account_id {
            Some(id) => ai_account::Entity::find_by_id(id).one(&session).await?,
            None => None,
        };
        let config_dir = accounts::claude_config_dir(account.as_ref());
        let ticket = match run.ticket_id.as_deref() {
            Some(id) => ticket::Entity::find_by_id(id).one(&session).await?,
            None => None,
        };
        let tree = match (&ticket, run.ticket_id.as_deref()) {
            (Some(_), Some(id)) => worktrees::for_ticket(&session, id).await?,
            _ => None,
        };
        let cwd = match tree.filter(|t| !t.path.is_empty() && Path::new(&t.path).is_dir()) {
            Some(tree) => Some(tree.path),
            None => profile.working_dir.clone(),
        };
        let (path, _checked) = cli::find_cli("claude", profile.cli_path.as_deref()).await;
        let model = run.model.clone().filter(|m| !m.is_empty()).or_else(|| profile.model.clone());
        (path, cwd, run.session_id.clone(), model, account, config_dir)
    };
    let (Some(path), Some(cwd), Some(session_id)) =
        (path.filter(|p| !p.is_empty()), cwd.filter(|c| !c.is_empty()), session_id.filter(|s| !s.is_empty()))
    else {
        return Err(RunError::Run("Claude Code, the team's folder or its session was not found.".into()));
    };
    if !cli::session_exists(&session_id, config_dir.as_deref(), None) {
        return Err(RunError::Run("The lead's last conversation is not on this computer any more.".into()));
    }
    let mut args: Vec<String> = [
        "-p",
        "/compact",
        "--resume",
        session_id.as_str(),
        "--setting-sources",
        "",
        "--output-format",
        "stream-json",
        "--verbose",
    ]
    .iter()
    .map(|a| a.to_string())
    .collect();
    if let Some(model) = model.filter(|m| !m.is_empty()) {
        args.push("--model".into());
        args.push(model);
    }
    let base = cli::child_env(None);
    let env = match &account {
        Some(account) => accounts::env_for(account, &base).await.map_err(|err| match err {
            accounts::Error::Db(err) => RunError::Db(err),
            other => RunError::Other(other.to_string()),
        })?,
        None => base,
    };
    let mut command = tokio::process::Command::new(&path);
    command
        .args(&args)
        .current_dir(&cwd)
        .env_clear()
        .envs(env)
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    // (an `OSError` in Python)
    let mut child = command.spawn().map_err(|err| RunError::Other(err.to_string()))?;
    let mut stdout = child.stdout.take().ok_or_else(|| RunError::Other("the CLI has no output to read".into()))?;
    let work = async {
        let mut out = Vec::new();
        let (read, _status) = tokio::join!(stdout.read_to_end(&mut out), child.wait());
        read.map(|_| out)
    };
    let out = match tokio::time::timeout(Duration::from_secs(TIMEOUT_S), work).await {
        Ok(out) => out.map_err(|err| RunError::Other(err.to_string()))?,
        Err(_elapsed) => {
            let _ = child.start_kill();
            return Err(RunError::Run("Compacting took too long and was stopped.".into()));
        }
    };
    let (mut before, mut after) = (Value::Null, Value::Null);
    let mut new_id = Value::String(session_id);
    let text = String::from_utf8_lossy(&out);
    for line in pytext::splitlines(&text) {
        let Some(Value::Object(ev)) = pyjson::loads(line) else { continue };
        if let Some(id) = ev.get("session_id").filter(|v| pyjson::truthy(v)) {
            new_id = id.clone();
        }
        let meta =
            if ev.get("subtype") == Some(&json!("compact_boundary")) { ev.get("compact_metadata") } else { None };
        if let Some(Value::Object(meta)) = meta.filter(|m| pyjson::truthy(m)) {
            before = meta.get("pre_tokens").cloned().unwrap_or(Value::Null);
            after = meta.get("post_tokens").cloned().unwrap_or(Value::Null);
        }
    }
    if after.is_null() {
        return Err(RunError::Run("Claude Code did not compact the conversation.".into()));
    }
    {
        let session = database::session();
        let Some(run) = ai_run::Entity::find_by_id(last.id.as_str()).one(&session).await? else {
            return Err(RunError::Other(format!("run {} is gone", last.id)));
        };
        let mut row = kb_db::edit(run);
        row.session_id = Set(Some(match &new_id {
            Value::String(s) => s.clone(),
            other => pyjson::py_str(other),
        }));
        row.context_used = Set(kb_ai::store::py_int(&after).and_then(|n| i32::try_from(n).ok()));
        row.update(&session).await?;
        session.commit().await?;
    }
    tracing::info!(
        target: "kanban.ai.compact",
        "compacted {}: {} -> {} tokens ({})",
        last.id,
        pyjson::py_str(&before),
        pyjson::py_str(&after),
        now_iso()
    );
    let mut result = Map::new();
    result.insert("state".into(), json!("done"));
    result.insert("before".into(), before);
    result.insert("after".into(), after);
    Ok(result)
}
