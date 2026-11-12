//! `_run` of `services/assistant/engine.py` (lines 345 to 501): the CLI of one turn, from what it is started with
//! (prompt, command line, settings, MCP config, environment) to its result.

use std::sync::Arc;
use std::time::Duration;

use kb_ai::pictures;
use kb_ai_know::board_skills;
use kb_ai_run::{accounts, cli, launch, stream};
use kb_base::secrets::redact;
use kb_base::{pyjson, time};
use kb_db::entities::{ai_account, ai_run};
use serde_json::{Map, Value, json};

use super::writer::StepWriter;
use super::{BOARD_SKILLS, Schema, Turn, cancelled, child_env, first_chars, procs, render_inputs, set_env, system_prompt};
use crate::assistant::{sessions, skills};
use crate::seams;

/// The keyword arguments of `_run`.
pub(super) struct RunArgs<'a> {
    pub name: &'a str,
    pub skill: &'a str,
    pub inputs: Map<String, Value>,
    pub by: &'a str,
    pub schema: Schema,
    pub files: Vec<(String, Vec<u8>)>,
    pub timeout_s: f64,
    pub fresh: bool,
    pub token: &'a str,
    pub cwd: &'a str,
    pub path: &'a str,
    pub account: Option<&'a ai_account::Model>,
    pub config_dir: Option<&'a str>,
    pub project_name: &'a str,
    pub member_name: &'a str,
}

/// `Path(fname).name`: the last part of a POSIX path (`.` parts and empty parts are not parts).
fn file_name(fname: &str) -> &str {
    fname.split('/').rfind(|part| !part.is_empty() && *part != ".").unwrap_or("")
}

/// `str(exc)` of whatever a step of the turn failed with.
fn said<E: std::fmt::Display>(err: E) -> String {
    err.to_string()
}

/// A text field of the result (`result.get(key)` when it is true), as text.
fn text_of(result: &Value, key: &str) -> Option<String> {
    result.get(key).filter(|v| pyjson::truthy(v)).map(|v| match v {
        Value::String(text) => text.clone(),
        other => pyjson::py_str(other),
    })
}

/// `_run`: start the CLI of the turn and read it to its end. What it found goes onto `out`; an error is an exception
/// of the Python function (its text), which fails the turn.
pub(super) async fn run(run: &ai_run::Model, out: &mut Turn, args: RunArgs<'_>) -> Result<(), String> {
    let RunArgs {
        name,
        skill,
        mut inputs,
        by,
        schema,
        files,
        timeout_s,
        fresh,
        token,
        cwd,
        path,
        account,
        config_dir,
        project_name,
        member_name,
    } = args;
    let folder = launch::run_dir(&run.id, true).map_err(said)?;
    let text_path = |name: &str| folder.join(name).to_string_lossy().into_owned();
    let mut saved: Vec<String> = Vec::new();
    for (fname, data) in &files {
        let target = folder.join(file_name(fname));
        std::fs::write(&target, data).map_err(said)?;
        saved.push(target.to_string_lossy().into_owned());
    }
    if !saved.is_empty() {
        inputs.insert("files".into(), json!(saved));
        out.files = saved.clone();
    }
    let known = if fresh { None } else { sessions::lookup(name, config_dir).await.map_err(said)? };
    let resume = known.is_some();
    let session_id = known.filter(|s| !s.is_empty()).unwrap_or_else(time::uuid4);
    let system_file = text_path("system.md");
    std::fs::write(&system_file, system_prompt(member_name, by, project_name, skill)).map_err(said)?;
    let sub_file = text_path("subagent-system.md");
    std::fs::write(&sub_file, "You help the board's assistant with one sub-task: do it and answer concretely.")
        .map_err(said)?;
    let mut plugin_dirs = vec![launch::board_plugin_dir().map_err(said)?, skills::plugin_dir().map_err(said)?];
    let board: Vec<String> = BOARD_SKILLS.iter().map(|s| s.to_string()).collect();
    match board_skills::plugin_dir(Some(&board)) {
        Ok(dir) => plugin_dirs.push(dir),
        // the board's skills are a convenience
        Err(err) => tracing::debug!(target: "kanban.assistant", "board skills plugin not built: {err}"),
    }
    // read-only: the board's URL
    let board_url = seams::board_url();
    let use_schema: Option<Value> = match schema {
        Schema::Skill => skills::schema_for(skill).cloned(),
        Schema::Plain => None,
        Schema::Given(given) => Some(given).filter(pyjson::truthy),
    };
    let prompt = render_inputs(skill, &inputs, by);
    // pictures the prompt names (/uploads/…), copied where the CLI may read them (hotfix 3.37.2)
    let (prompt, pictures_dir) = pictures::stage(&prompt, &format!("assistant_{}", run.id)).map_err(said)?;
    let deny: Vec<String> = launch::DEFAULT_DENY.iter().map(|rule| rule.to_string()).collect();
    let debug_file = text_path("debug.log");
    let add_dirs: Vec<String> = [(!saved.is_empty()).then(|| folder.to_string_lossy().into_owned()), pictures_dir]
        .into_iter()
        .flatten()
        .filter(|d| !d.is_empty())
        .collect();
    let command = launch::args_for(&launch::ArgsFor {
        path,
        prompt: &prompt,
        live: false,
        system_file: &system_file,
        sub_system_file: &sub_file,
        agents_file: None,
        mcp: launch::mcp_config(&Map::new(), token, Some(cwd), config_dir, &board_url),
        settings: launch::settings_json(&deny),
        schema: use_schema.as_ref(),
        plugin_dirs: &plugin_dirs,
        permission_mode: "bypass",
        disallowed: &[],
        session_id: &session_id,
        resume,
        name: Some(name),
        model: run.model.as_deref(),
        effort: run.effort.as_deref(),
        debug_file: Some(&debug_file),
        add_dirs: &add_dirs,
    });
    let mut env = match account {
        Some(account) => accounts::env_for(account, &child_env()).await.map_err(said)?,
        None => child_env(),
    };
    set_env(&mut env, "KANBAN_URL", &board_url);
    set_env(&mut env, "KANBAN_RUN_TOKEN", token);
    set_env(&mut env, "KANBAN_RUN_ID", &run.id);
    set_env(&mut env, "KANBAN_WORKTREE", cwd);
    let proc = Arc::new(cli::CliProcess::new(command, cwd, Some(env), true, None));
    let writer = StepWriter::new(&run.id);
    let mut fields = Map::new();
    fields.insert("session_id".into(), json!(session_id));
    let title = format!("{member_name}: {skill}{}", if resume { " (resumed)" } else { "" });
    writer.add(vec![json!({"kind": "start", "title": title})], Vec::new(), Vec::new(), fields);
    let pid = proc.start().await.map_err(said)?;
    procs().insert(run.id.clone(), proc.clone());
    let mut fields = Map::new();
    fields.insert("pid".into(), json!(pid));
    writer.add(Vec::new(), Vec::new(), Vec::new(), fields);
    let mut parser = stream::Parser::new(cwd, None);
    let mut result: Option<Value> = None;
    let mut timed_out = false;
    let limit = Duration::try_from_secs_f64(timeout_s.max(0.0)).unwrap_or(Duration::MAX);
    let mut lines = proc.lines();
    loop {
        let line = match tokio::time::timeout(limit, lines.next()).await {
            Ok(Ok(Some(line))) => line,
            Ok(Ok(None)) => break,
            Ok(Err(err)) => return Err(said(err)),
            Err(_) => {
                timed_out = true;
                proc.kill();
                break;
            }
        };
        let parsed = parser.parse(&line).map_err(said)?;
        let mut fields = Map::new();
        if parsed.ready {
            fields.insert("state".into(), json!("running"));
        }
        for res in &parsed.results {
            let mut detail = Map::new();
            detail.insert("exit_code".into(), res["exit_code"].clone());
            detail.insert("is_error".into(), res["is_error"].clone());
            if !writer.attach_pending(&res["tool_id"], &res["output"], &detail) {
                // a tool call without an id names no step
                if let Some(tool_id) = res["tool_id"].as_str() {
                    kb_ai::steps::attach_result(&run.id, tool_id, res["output"].as_str(), &detail)
                        .await
                        .map_err(said)?;
                }
            }
        }
        if let Some(found) = parsed.result.filter(pyjson::truthy) {
            result = Some(found);
        }
        if !parsed.rows.is_empty() || !parsed.agents.is_empty() || !parsed.files.is_empty() || !fields.is_empty() {
            writer.add(parsed.rows, parsed.agents, parsed.files, fields);
        }
        if cancelled().contains(&run.id) {
            proc.kill();
            break;
        }
    }
    let code = proc.wait().await.map_err(said)?;
    writer.close().await;
    out.session_id = Some(session_id.clone());
    if cancelled().contains(&run.id) {
        out.state = "cancelled".to_string();
        out.error = Some("Stopped.".to_string());
        return Ok(());
    }
    if timed_out {
        out.state = "failed".to_string();
        out.error = Some(format!(
            "The assistant said nothing for {} minutes and was stopped.",
            (timeout_s / 60.0).floor() as i64
        ));
        return Ok(());
    }
    let Some(result) = result else {
        let tail = proc.stderr_tail();
        let tail = tail[tail.len().saturating_sub(3)..].join(" · ");
        out.state = "failed".to_string();
        out.error = Some(format!(
            "Claude Code exited with code {code}{}",
            if tail.is_empty() { String::new() } else { format!(": {tail}") }
        ));
        return Ok(());
    };
    out.tokens_in = result["tokens_in"].as_i64().unwrap_or(0);
    out.tokens_out = result["tokens_out"].as_i64().unwrap_or(0);
    out.cost = result["cost_usd"].as_f64().unwrap_or(0.0);
    if pyjson::truthy(&result["is_error"]) {
        out.state = "failed".to_string();
        let said = text_of(&result, "text")
            .or_else(|| text_of(&result, "api_error"))
            .unwrap_or_else(|| "Claude Code reported an error.".to_string());
        out.error = Some(first_chars(&redact(&said), 600));
        return Ok(());
    }
    out.text = text_of(&result, "text").unwrap_or_default();
    out.structured = result.get("structured").and_then(Value::as_object).cloned();
    sessions::remember(name, &run.project_id, &session_id).await.map_err(said)?;
    Ok(())
}
