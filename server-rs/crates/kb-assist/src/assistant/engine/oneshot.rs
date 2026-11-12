//! `any_cli` and `oneshot` of `services/assistant/engine.py` (lines 541 to 682): one answer with a skill and
//! nothing else.

use std::time::{Duration, Instant};

use kb_ai_run::{accounts, cli, launch, stream};
use kb_base::secrets::redact;
use kb_base::{pyjson, time};
use kb_db::database;
use kb_db::entities::{ai_account, ai_team};
use kb_db::sea_orm::{DbErr, EntityTrait};
use serde_json::{Map, Value, json};

use super::{DEFAULT_MODEL, Turn, child_env, first_chars, render_inputs};
use crate::assistant::errors::{AssistError, Error};
use crate::assistant::settings::round_to;
use crate::assistant::skills;

/// The first team that is not paused: its CLI path and its account.
async fn first_team() -> Result<(Option<String>, Option<ai_account::Model>), DbErr> {
    let session = database::session();
    for profile in ai_team::Entity::find().all(&session).await? {
        if profile.paused {
            continue;
        }
        let account = match profile.account_id.as_deref().filter(|id| !id.is_empty()) {
            Some(account_id) => ai_account::Entity::find_by_id(account_id).one(&session).await?,
            None => None,
        };
        return Ok((profile.cli_path, account));
    }
    Ok((None, None))
}

/// (path of Claude Code, the account to run it with): the first AI team's of any project, else the one on PATH.
pub async fn any_cli() -> (Option<String>, Option<ai_account::Model>) {
    let (explicit, account) = match first_team().await {
        Ok(found) => found,
        // the database may be the thing that is being repaired
        Err(err) => {
            tracing::debug!(target: "kanban.assistant", "no team read for a one-shot answer: {err}");
            (None, None)
        }
    };
    let (path, _) = cli::find_cli("claude", explicit.as_deref()).await;
    (path.filter(|p| !p.is_empty()), account)
}

/// The keyword arguments of `oneshot`.
#[derive(Debug, Clone, Copy)]
pub struct OneshotOpts<'a> {
    /// The person who asks.
    pub by: &'a str,
    /// How long the answer may say nothing, in seconds.
    pub timeout_s: f64,
    /// The model that answers.
    pub model: &'a str,
}

impl Default for OneshotOpts<'_> {
    fn default() -> Self {
        Self { by: "user", timeout_s: 240.0, model: DEFAULT_MODEL }
    }
}

fn other<E: std::fmt::Display>(err: E) -> Error {
    Error::Other(err.to_string())
}

/// One answer with a skill and nothing else: no board tools, no conversation, and nothing written to the board's
/// database (the helper of a database copy runs while the database is being moved).
///
/// Fails with `AssistError` `not_configured` when Claude Code is not on this computer.
pub async fn oneshot(skill: &str, inputs: &Map<String, Value>, opts: OneshotOpts<'_>) -> Result<Turn, Error> {
    let OneshotOpts { by, timeout_s, model } = opts;
    let (path, account) = any_cli().await;
    let Some(path) = path else {
        return Err(AssistError::new(
            "not_configured",
            "Claude Code was not found on this computer. Install it, then ask again.",
        )
        .into());
    };
    let folder = launch::data_root()
        .map_err(other)?
        .join("assistant-cwd")
        .join(format!("oneshot-{}", &time::uuid4_hex()[..8]));
    std::fs::create_dir_all(&folder).map_err(other)?;
    let folder_text = folder.to_string_lossy().into_owned();
    let system_file = folder.join("system.md").to_string_lossy().into_owned();
    std::fs::write(
        &system_file,
        format!(
            "<board trusted>\nYou are Board AI, the assistant of the Kanban board. Use the skill `{}:{skill}` and follow \
             it exactly; your final answer is only the JSON it asks for. You have no tools for this: reason from what \
             you are given.\n</board trusted>",
            skills::PLUGIN
        ),
    )
    .map_err(other)?;
    let sub_file = folder.join("subagent-system.md").to_string_lossy().into_owned();
    std::fs::write(&sub_file, "Answer concretely.").map_err(other)?;
    let deny: Vec<String> = launch::DEFAULT_DENY.iter().map(|rule| rule.to_string()).collect();
    let disallowed: Vec<String> =
        ["Bash", "Edit", "Write", "NotebookEdit", "WebFetch", "WebSearch", "Task", "Agent"].map(String::from).to_vec();
    let session_id = time::uuid4();
    let args = launch::args_for(&launch::ArgsFor {
        path: &path,
        prompt: &render_inputs(skill, inputs, by),
        live: false,
        system_file: &system_file,
        sub_system_file: &sub_file,
        agents_file: None,
        mcp: json!({"mcpServers": {}}),
        settings: launch::settings_json(&deny),
        schema: skills::schema_for(skill),
        plugin_dirs: &[skills::plugin_dir().map_err(other)?],
        permission_mode: "bypass",
        disallowed: &disallowed,
        session_id: &session_id,
        resume: false,
        name: None,
        model: Some(model),
        effort: None,
        debug_file: None,
        add_dirs: &[],
    });
    let env = match &account {
        Some(account) => accounts::env_for(account, &child_env()).await.map_err(other)?,
        None => child_env(),
    };
    // a CLI whose answer nobody waits for any more is stopped when `proc` is dropped (Python: `CancelledError`)
    let proc = cli::CliProcess::new(args, &folder_text, Some(env), true, None);
    let mut out = Turn::new("", "Board AI", Some(model));
    let started = Instant::now();
    proc.start().await.map_err(other)?;
    let mut parser = stream::Parser::new(&folder_text, None);
    let mut result: Option<Value> = None;
    let limit = Duration::try_from_secs_f64(timeout_s.max(0.0)).unwrap_or(Duration::MAX);
    let mut lines = proc.lines();
    loop {
        let line = match tokio::time::timeout(limit, lines.next()).await {
            Ok(Ok(Some(line))) => line,
            Ok(Ok(None)) => break,
            Ok(Err(err)) => return Err(other(err)),
            Err(_) => {
                proc.kill();
                out.state = "failed".to_string();
                out.error = Some("The assistant said nothing for too long and was stopped.".to_string());
                break;
            }
        };
        let parsed = parser.parse(&line).map_err(other)?;
        if let Some(found) = parsed.result.filter(pyjson::truthy) {
            result = Some(found);
        }
    }
    let code = proc.wait().await.map_err(other)?;
    out.elapsed_s = round_to(started.elapsed().as_secs_f64(), 1);
    if out.state == "failed" {
        return Ok(out);
    }
    let Some(result) = result else {
        let tail = proc.stderr_tail();
        let tail = tail[tail.len().saturating_sub(3)..].join(" · ");
        out.state = "failed".to_string();
        out.error = Some(format!(
            "Claude Code exited with code {code}{}",
            if tail.is_empty() { String::new() } else { format!(": {tail}") }
        ));
        return Ok(out);
    };
    out.tokens_in = result["tokens_in"].as_i64().unwrap_or(0);
    out.tokens_out = result["tokens_out"].as_i64().unwrap_or(0);
    out.cost = result["cost_usd"].as_f64().unwrap_or(0.0);
    let text = result.get("text").filter(|v| pyjson::truthy(v)).map(|v| match v {
        Value::String(text) => text.clone(),
        other => pyjson::py_str(other),
    });
    if pyjson::truthy(&result["is_error"]) {
        out.state = "failed".to_string();
        out.error =
            Some(first_chars(&redact(&text.unwrap_or_else(|| "Claude Code reported an error.".to_string())), 600));
        return Ok(out);
    }
    out.text = text.unwrap_or_default();
    out.structured = result.get("structured").and_then(Value::as_object).cloned();
    Ok(out)
}
