//! A job's task (`repo_scan.py` lines 1221-1466: `_run_job`, `_stop`, `_job_body`).

use std::sync::Arc;
use std::time::Duration;

use kb_ai::store;
use kb_ai_work::project_env;
use kb_base::pyjson;
use kb_db::entities::ai_repo_scan;
use kb_db::sea_orm::EntityTrait;
use serde_json::{Map, Value, json};
use tokio::task::JoinHandle;

use super::{Job, ai, job_limit, loads_object, step_label, tasks};
use crate::Error;
use crate::cancel::{Cancel, Reason};
use crate::refine::claude_account;
use crate::seams::{self, AskError};
use crate::trial::{COMMANDS, Scratch, TryOptions, try_commands};

/// What a job works with, as `start_job` passes it to `_run_job`.
pub(super) struct Args {
    pub folder: String,
    pub project_id: String,
    pub commands: Map<String, Value>,
    pub keep: Vec<String>,
    pub env_path: Vec<String>,
    pub only: Option<Vec<String>>,
    pub previous: Value,
}

/// `str(exc)[:300]`.
fn short(text: &str) -> String {
    text.chars().take(300).collect()
}

/// The job's own task: the body under a time limit, then the state written for the last time.
pub(super) async fn run_job(job: Arc<Job>, args: Args, cancel: Arc<Cancel>) {
    // the wizard polls: the state is written twice a second while it runs
    let keeper: JoinHandle<()> = {
        let job = job.clone();
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(Duration::from_millis(500)).await;
                if let Err(e) = job.save(true).await {
                    tracing::warn!("repo scan job {}: saving its state failed: {e}", job.scan_id);
                }
            }
        })
    };
    let timer: JoinHandle<()> = {
        let cancel = cancel.clone();
        let limit = job_limit();
        tokio::spawn(async move {
            tokio::time::sleep(limit).await;
            cancel.cancel(Reason::TimedOut);
        })
    };
    let result = job_body(&job, &args, &cancel).await;
    timer.abort();
    let mut cancelled = false;
    match result {
        Ok(()) => job.finish("done", None),
        Err(Error::Cancelled) if cancel.reason() == Some(Reason::TimedOut) => {
            job.line("Stopped after 10 minutes.");
            job.finish("timeout", Some("The AI stopped after 10 minutes."));
        }
        Err(Error::Cancelled) => {
            job.line("Cancelled.");
            job.finish("cancelled", None);
            cancelled = true;
        }
        Err(e) => {
            tracing::warn!("repo scan job {} failed: {e}", job.scan_id);
            job.line(&format!("Failed: {e}"));
            job.finish("failed", Some(&short(&e.to_string())));
        }
    }
    stop(keeper).await;
    if cancelled {
        save_last(&job).await;
        tasks().remove(&job.scan_id);
    } else {
        tasks().remove(&job.scan_id);
        save_last(&job).await;
    }
}

async fn save_last(job: &Job) {
    if let Err(e) = job.save(true).await {
        tracing::warn!("repo scan job {}: saving its state failed: {e}", job.scan_id);
    }
}

/// `_stop(task)`: the saver only writes state.
async fn stop(task: JoinHandle<()>) {
    task.abort();
    let _ = task.await;
}

fn command_of(commands: &Map<String, Value>, name: &str) -> String {
    commands.get(name).map(super::text_of).unwrap_or_default()
}

fn env_entry(path: &str, by: &str, why: &str) -> Value {
    json!({"path": path, "by": by, "why": why})
}

/// What the job does: the AI proposes (in `ai` mode), the programs the commands need are looked for, then the board
/// runs each command.
async fn job_body(job: &Arc<Job>, args: &Args, cancel: &Arc<Cancel>) -> Result<(), Error> {
    let session = kb_db::database::session();
    let Some(row) = ai_repo_scan::Entity::find_by_id(job.scan_id.as_str()).one(&session).await? else {
        return Err(Error::Other("'NoneType' object has no attribute 'found'".into()));
    };
    let found = loads_object(&row.found);
    let suggested = loads_object(&row.suggested);
    let settings = store::get_settings(&session, &args.project_id).await?;
    let saved = project_env::extra(Some(&settings));
    let account = claude_account(&session, None).await?;
    drop(session);
    let mode = job.doc_get("mode").as_str().unwrap_or("").to_string();
    let hint = job.doc_get("hint").as_str().unwrap_or("").to_string();
    let names: Vec<&str> = COMMANDS
        .into_iter()
        .filter(|n| *n == "prepare" || args.only.as_ref().is_none_or(|only| only.iter().any(|o| o == n)))
        .collect();
    let mut commands = args.commands.clone();

    if mode == "ai" {
        job.step("ai", "The AI is reading the repository", "Read-only: Read, Glob and Grep.", "running");
        job.step("path", "Looking for the programs the commands need", "", "waiting");
    }
    for n in &names {
        job.step(n, step_label(n), "", "waiting");
    }
    job.save(true).await?;

    let mut env_entries: Vec<Value> = if args.env_path.is_empty() {
        saved.iter().map(|p| env_entry(p, "project", "")).collect()
    } else {
        args.env_path.iter().map(|p| env_entry(p, "you", "")).collect()
    };

    if mode == "ai" {
        let mut keep_cmds: Map<String, Value> = Map::new();
        for n in args.keep.iter().filter(|n| COMMANDS.contains(&n.as_str())) {
            keep_cmds.insert(n.clone(), json!(command_of(&commands, n)));
        }
        let prompt = ai::ai_prompt(&found, &hint, &keep_cmds, &args.previous);
        let mut scratch = Scratch::new(&args.folder)?;
        let work = match scratch.enter().await {
            Ok(work) => work,
            Err(e) => {
                scratch.exit().await;
                return Err(e);
            }
        };
        let work_text = work.to_string_lossy().into_owned();
        let on_tool = {
            let job = job.clone();
            move |text: &str| {
                job.line(&format!("ai: {text}"));
                job.mark("ai", "running", None, Some(text));
            }
        };
        job.line(&format!("$ cd {work_text}"));
        let answer = seams::asker().ask_ai(&prompt, &work_text, account.as_ref(), &on_tool, cancel).await;
        scratch.exit().await;
        let answer = match answer {
            Ok(answer) => answer,
            Err(AskError::Failed(message)) => return Err(Error::Other(message)),
            Err(AskError::Cancelled) => return Err(Error::Cancelled),
        };
        let mut proposal = match ai::parse_proposal(answer.as_deref()) {
            Some(p) => p,
            None => {
                job.line("The AI's answer could not be read; the board's own scan is used.");
                ai::code_proposal(&suggested)
            }
        };
        for (n, cmd) in &keep_cmds {
            let Some(Value::Object(table)) = proposal.get_mut("commands") else { continue };
            let mut entry = table.get(n).and_then(Value::as_object).cloned().unwrap_or_default();
            let source =
                entry.get("source").filter(|v| pyjson::truthy(v)).cloned().unwrap_or_else(|| json!("typed by you"));
            entry.insert("command".into(), cmd.clone());
            entry.insert("source".into(), source);
            table.insert(n.clone(), Value::Object(entry));
        }
        let table = proposal.get("commands").and_then(Value::as_object).cloned().unwrap_or_default();
        commands = COMMANDS
            .iter()
            .map(|n| {
                let command = table.get(*n).and_then(|c| c.get("command")).cloned().unwrap_or_else(|| json!(""));
                ((*n).to_string(), command)
            })
            .collect();
        let mut sources: Vec<String> = table
            .values()
            .filter_map(|c| c.get("source").and_then(Value::as_str).filter(|s| !s.is_empty()))
            .map(|s| s.split(" ›").next().unwrap_or("").split(" ·").next().unwrap_or("").to_string())
            .collect();
        sources.sort();
        sources.dedup();
        let proposed: Vec<(&String, String)> =
            commands.iter().map(|(n, c)| (n, command_text(c))).filter(|(_, c)| !c.is_empty()).collect();
        let found_n = proposed.len();
        if found_n > 0 {
            let list: Vec<String> = proposed.iter().map(|(n, c)| format!("{n} = {c}")).collect();
            job.line(&format!("AI proposed: {}", list.join(", ")));
        } else {
            job.line("AI proposed: no commands (the repository has none it could find)");
        }
        let notes = proposal.get("notes").filter(|v| pyjson::truthy(v)).map(super::text_of);
        let detail = format!(
            "{}{}",
            if sources.is_empty() {
                format!("{found_n} of 4")
            } else {
                format!("{found_n} of 4 · from {}", sources.join(", "))
            },
            notes.map(|n| format!(" · {n}")).unwrap_or_default()
        );
        job.mark(
            "ai",
            "done",
            Some(if found_n > 0 { "The AI proposed the commands" } else { "The AI found no commands" }),
            Some(&detail),
        );
        let mut with_env = proposal.as_object().cloned().unwrap_or_default();
        with_env.insert("env_path".into(), json!([]));
        job.set_proposal(Value::Object(with_env));
        job.save(true).await?;

        // the programs: a folder the app's own PATH does not have, found in the usual install folders
        job.mark("path", "running", None, None);
        let folders: Vec<String> =
            env_entries.iter().filter_map(|e| e.get("path").and_then(Value::as_str).map(str::to_string)).collect();
        let base = project_env::with_path(None, Some(&folders)).get("PATH").cloned().unwrap_or_default();
        let wanted: Vec<String> = commands.values().map(command_text).filter(|c| !c.is_empty()).collect();
        let missing = project_env::missing_folders(&wanted, &base);
        let mut details: Vec<String> = Vec::new();
        for m in &missing {
            let program = m.get("program").and_then(Value::as_str).unwrap_or("");
            let path = m.get("path").and_then(Value::as_str).unwrap_or("");
            job.line(&format!("$ which {program}"));
            job.line(&format!("{program} not found on PATH={}", std::env::var("PATH").unwrap_or_default()));
            job.line(&format!("{path}/{program}"));
            env_entries.push(env_entry(path, "ai", &format!("{program} was found here")));
            details.push(format!("{program} is not on the app’s PATH. Found in {path}; proposed as an extra folder."));
        }
        let detail = if details.is_empty() {
            "Everything the commands need is on the PATH.".to_string()
        } else {
            details.join("; ")
        };
        job.mark("path", "done", Some("Looked for the programs"), Some(&detail));
        job.set_proposal_env_path(Value::Array(env_entries.clone()));
        job.save(true).await?;
    } else {
        let mut proposal = job.proposal().as_object().cloned().unwrap_or_default();
        proposal.insert("env_path".into(), Value::Array(env_entries.clone()));
        job.set_proposal(Value::Object(proposal));
    }

    for n in &names {
        let command = command_of(&commands, n);
        if *n != "prepare" && command.is_empty() {
            job.set_trial(n, Value::Null);
            job.mark(n, "skipped", None, Some("No command."));
        } else if !command.is_empty() {
            job.set_trial(
                n,
                json!({
                    "command": command,
                    "status": "waiting",
                    "ok": false,
                    "exit_code": null,
                    "seconds": 0,
                    "tail": [],
                    "reason": null,
                }),
            );
            job.mark(n, "waiting", None, Some(&command));
        } else {
            job.mark(n, "skipped", None, Some("No command."));
        }
    }

    let on_event = {
        let job = job.clone();
        move |kind: &str, name: &str, data: &Value| match kind {
            "start" => {
                let mut trial = job.trial_get(name).as_object().cloned().unwrap_or_default();
                trial.insert("command".into(), data.clone());
                trial.insert("status".into(), json!("running"));
                job.set_trial(name, Value::Object(trial));
                let label = format!("The board is running {name}, the way a ticket will");
                job.mark(name, "running", Some(&label), Some(&command_text(data)));
                job.line(&format!("board$ /bin/sh -c {}  (saved PATH in front)", pyjson::dumps(data)));
            }
            "line" => job.line(&command_text(data)),
            "done" => {
                job.set_trial(name, data.clone());
                if data.is_null() {
                    return;
                }
                let status = data.get("status").and_then(Value::as_str).unwrap_or("");
                if status == "not_run" {
                    let reason =
                        data.get("reason").filter(|v| pyjson::truthy(v)).map(super::text_of).unwrap_or_default();
                    job.mark(name, "skipped", Some(step_label(name)), Some(&reason));
                } else {
                    let seconds = data.get("seconds").map_or_else(|| "None".to_string(), pyjson::py_str);
                    job.mark(
                        name,
                        if status == "works" { "done" } else { "failed" },
                        Some(step_label(name)),
                        Some(&format!("{status} · {seconds} s")),
                    );
                    let exit = data.get("exit_code").map_or_else(|| "None".to_string(), pyjson::py_str);
                    job.line(&format!("{name}: {status}, exit {exit}, {seconds} s"));
                }
            }
            _ => {}
        }
    };
    if names.iter().any(|n| !command_of(&commands, n).is_empty()) {
        let run_cmds: Map<String, Value> =
            names.iter().map(|n| ((*n).to_string(), json!(command_of(&commands, n)))).collect();
        let folders: Vec<String> =
            env_entries.iter().filter_map(|e| e.get("path").and_then(Value::as_str).map(str::to_string)).collect();
        let checks: Vec<String> = names.iter().filter(|n| **n != "prepare").map(|n| (*n).to_string()).collect();
        let result = try_commands(
            &args.folder,
            &run_cmds,
            TryOptions {
                extra_path: Some(&folders),
                only: Some(&checks),
                on_event: Some(&on_event),
                cancel: Some(cancel),
            },
        )
        .await?;
        for n in &names {
            let value = result.get(*n).cloned().unwrap_or(Value::Null);
            if !value.is_null() || *n == "prepare" {
                job.set_trial(n, value);
            }
        }
    }
    job.save(true).await
}

/// `str(value)` of a command (a text already).
fn command_text(value: &Value) -> String {
    if value.is_null() { String::new() } else { super::text_of(value) }
}
