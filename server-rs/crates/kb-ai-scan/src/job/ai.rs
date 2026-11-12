//! What the AI is asked and how its answer is read (`repo_scan.py` lines 852-878 `ai_status`, 971-1151 `AI_PROMPT`,
//! `_ai_prompt`, `_describe_tool`, `_ask_ai`, `_parse_proposal`, `_code_proposal`).

use std::collections::HashMap;
use std::process::Stdio;
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant};

use kb_ai_run::{accounts, cli};
use kb_base::{pyjson, pytext};
use kb_db::Session;
use kb_db::entities::ai_account;
use serde_json::{Map, Value, json};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, BufReader};
use tokio::process::Command;

use super::text_of;
use crate::Error;
use crate::cancel::Cancel;
use crate::pyfs::type_name;
use crate::refine::{claude_account, parse_refined};
use crate::seams::{self, AskError, OnLine};
use crate::trial::COMMANDS;

/// `AI_PROMPT` with `{facts}` and `{extra}` where Python's `str.format` puts them (the braces of the JSON example are
/// single here: `format` turned `{{` into `{`).
pub const AI_PROMPT_TEMPLATE: &str = include_str!("../text/ai_prompt.txt");

static AI_STATUS: LazyLock<Mutex<HashMap<String, (Instant, Value)>>> = LazyLock::new(|| Mutex::new(HashMap::new()));

/// Whether the AI can set up the commands: Claude Code found and signed in (the board's signed-in account, else this
/// computer's own login). Cached for 15 s, since the wizard polls. Goes through `seams::asker()`.
pub async fn ai_status(session: &Session, force: bool) -> Result<Value, Error> {
    seams::asker().ai_status(session, force).await
}

/// `ai_status` itself.
pub async fn ai_status_real(session: &Session, force: bool) -> Result<Value, Error> {
    let account = claude_account(session, None).await?;
    let key = account.as_ref().map_or_else(|| "local".to_string(), |a| a.id.clone());
    if !force {
        let cache = AI_STATUS.lock().unwrap_or_else(|e| e.into_inner());
        if let Some((at, value)) = cache.get(&key) {
            if at.elapsed() < Duration::from_secs(15) {
                return Ok(value.clone());
            }
        }
    }
    let env = match &account {
        Some(account) => {
            Some(accounts::env_for(account, &cli::child_env(None)).await.map_err(|e| Error::Other(e.to_string()))?)
        }
        None => None,
    };
    // a detection failure is "not available", never a broken wizard
    let info = match cli::detect("claude-code", "claude", None, env.as_ref()).await {
        Ok(info) => info,
        Err(_) => {
            let mut m = Map::new();
            m.insert("found".into(), json!(false));
            m
        }
    };
    let value = if !info.get("found").is_some_and(pyjson::truthy) {
        json!({
            "available": false,
            "why": "Claude Code is not installed on this computer (the claude command was not found).",
        })
    } else if info.get("logged_in") == Some(&json!(false)) {
        json!({
            "available": false,
            "why": "Claude Code is not signed in on this computer. The AI needs it to read the repository.",
        })
    } else {
        json!({"available": true, "why": null})
    };
    AI_STATUS.lock().unwrap_or_else(|e| e.into_inner()).insert(key, (Instant::now(), value.clone()));
    Ok(value)
}

/// Forget the cached answers of `ai_status` (Python's tests assign `repo_scan._AI_STATUS = {}`).
pub fn forget_ai_status() {
    AI_STATUS.lock().unwrap_or_else(|e| e.into_inner()).clear();
}

/// What the AI is told: the board's scan, what the person says, the commands that are settled and what the last run
/// found wrong.
pub fn ai_prompt(found: &Value, hint: &str, keep: &Map<String, Value>, last: &Value) -> String {
    let mut facts = Map::new();
    for k in ["languages", "frameworks", "packages", "ci_commands", "makefile_targets", "agent_files", "monorepo", "ui"]
    {
        facts.insert(k.to_string(), found.get(k).cloned().unwrap_or(Value::Null));
    }
    let mut extra = String::new();
    if !pytext::strip(hint).is_empty() {
        let said: String = pytext::strip(hint).chars().take(1000).collect();
        extra += &format!("\nThe person says: {said}\n");
    }
    if !keep.is_empty() {
        extra += "\nThese commands are settled (they work, or the person typed them): return them unchanged.\n";
        let lines: Vec<String> = keep.iter().map(|(k, v)| format!("- {k}: {}", text_of(v))).collect();
        extra += &lines.join("\n");
        extra += "\n";
    }
    let wrong: Vec<(&String, &Value)> = last
        .as_object()
        .map(|m| {
            m.iter()
                .filter(|(k, r)| {
                    pyjson::truthy(r)
                        && matches!(r.get("status").and_then(Value::as_str), Some("wrong" | "fails" | "timeout"))
                        && !keep.contains_key(*k)
                })
                .collect()
        })
        .unwrap_or_default();
    if !wrong.is_empty() {
        extra += "\nThe last run, by the board:\n";
        let lines: Vec<String> = wrong
            .iter()
            .map(|(k, r)| {
                let tail: Vec<String> = r
                    .get("tail")
                    .filter(|t| pyjson::truthy(t))
                    .and_then(Value::as_array)
                    .map(|t| t.iter().map(text_of).collect())
                    .unwrap_or_default();
                let last4: Vec<&str> = tail.iter().skip(tail.len().saturating_sub(4)).map(String::as_str).collect();
                let joined: String = last4.join(" | ").chars().take(400).collect();
                let show = |key: &str| r.get(key).map_or_else(|| "None".to_string(), pyjson::py_str);
                format!("- {k}: `{}` → {} (exit {}): {joined}", show("command"), show("status"), show("exit_code"))
            })
            .collect();
        extra += &lines.join("\n");
        extra += "\n'wrong' means the shell could not run it (a missing program or script): fix the command. 'fails' means it ran and the project's own tests or checks failed: keep the command unless it is the wrong one.\n";
    }
    let facts_text: String = pyjson::Dumps::new().indent(1).dump(&Value::Object(facts)).chars().take(12000).collect();
    let (head, rest) = AI_PROMPT_TEMPLATE.split_once("{facts}").unwrap_or((AI_PROMPT_TEMPLATE, ""));
    let (middle, tail) = rest.split_once("{extra}").unwrap_or((rest, ""));
    format!("{head}{facts_text}{middle}{extra}{tail}")
}

/// What a tool call of the AI looks like in the log ("Read .github/workflows/ci.yml").
pub fn describe_tool(name: &str, data: &Value, cwd: &str) -> String {
    let get = |key: &str| data.as_object().and_then(|m| m.get(key)).cloned().unwrap_or(Value::Null);
    let rel = |p: Value| -> String {
        let p = if pyjson::truthy(&p) { text_of(&p) } else { String::new() };
        if !cwd.is_empty() && p.starts_with(cwd) { p[cwd.len()..].trim_start_matches('/').to_string() } else { p }
    };
    match name {
        "Read" => format!("Read {}", rel(get("file_path"))),
        "Glob" => format!("Looked for {}", pyjson::py_str(&get("pattern"))),
        "Grep" => format!("Searched for {}", pyjson::py_str(&get("pattern"))),
        "LS" => {
            let shown = rel(get("path"));
            format!("Listed {}", if shown.is_empty() { ".".to_string() } else { shown })
        }
        other => other.to_string(),
    }
}

fn attr_error(value: &Value) -> AskError {
    AskError::Failed(format!("'{}' object has no attribute 'get'", type_name(value)))
}

/// One Claude Code run that may only read (Read, Glob, Grep) in `cwd`; returns its final text. `on_line` gets what it
/// does ("Read .github/workflows/ci.yml").
pub async fn ask_ai_real(
    prompt: &str,
    cwd: &str,
    account: Option<&ai_account::Model>,
    on_line: &OnLine<'_>,
    cancel: &Cancel,
) -> Result<Option<String>, AskError> {
    let (path, _) = cli::find_cli("claude", None).await;
    let Some(path) = path.filter(|p| !p.is_empty()) else {
        return Err(AskError::Failed("Claude Code is not installed on this computer.".into()));
    };
    let mut env = cli::child_env(None);
    if let Some(account) = account {
        env = accounts::env_for(account, &env).await.map_err(|e| AskError::Failed(e.to_string()))?;
    }
    let mut command = Command::new(&path);
    command
        .args([
            "-p",
            prompt,
            "--model",
            "sonnet",
            "--output-format",
            "stream-json",
            "--verbose",
            "--permission-mode",
            "dontAsk",
            "--allowedTools",
            "Read,Glob,Grep,LS",
            "--disallowedTools",
            "Bash,Edit,Write,MultiEdit,NotebookEdit,WebFetch,WebSearch,Task",
            "--strict-mcp-config",
            "--mcp-config",
            "{\"mcpServers\": {}}",
        ])
        .current_dir(cwd)
        .env_clear()
        .envs(env)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    cli::popen_kwargs(&mut command);
    let mut child = command.spawn().map_err(|e| AskError::Failed(format!("{e}: {}", pytext::repr(&path))))?;
    let pid = child.id().and_then(|p| i32::try_from(p).ok());
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    // what the CLI says on standard error is read as it comes, so a chatty one never blocks on a full pipe
    let err_task = tokio::spawn(async move {
        let mut text = Vec::new();
        if let Some(mut err) = stderr {
            let mut buf = vec![0u8; 8192];
            while let Ok(n) = err.read(&mut buf).await {
                if n == 0 {
                    break;
                }
                if text.len() < 1 << 20 {
                    text.extend_from_slice(&buf[..n]);
                }
            }
        }
        text
    });
    let outcome = {
        let work = async {
            let mut result: Option<String> = None;
            let Some(stdout) = stdout else { return Ok(result) };
            let mut reader = BufReader::new(stdout);
            loop {
                let mut raw: Vec<u8> = Vec::new();
                let n = reader.read_until(b'\n', &mut raw).await.map_err(|e| AskError::Failed(e.to_string()))?;
                if n == 0 {
                    break;
                }
                if raw.len() > 16 * 1024 * 1024 {
                    return Err(AskError::Failed("Separator is not found, and chunk exceed the limit".into()));
                }
                let Ok(event) = serde_json::from_slice::<Value>(&raw) else { continue };
                let Some(map) = event.as_object() else { return Err(attr_error(&event)) };
                match map.get("type").and_then(Value::as_str) {
                    Some("assistant") => {
                        let message = map.get("message").filter(|m| pyjson::truthy(m));
                        let content = match message {
                            Some(Value::Object(m)) => m.get("content").filter(|c| pyjson::truthy(c)),
                            Some(other) => return Err(attr_error(other)),
                            None => None,
                        };
                        if let Some(Value::Array(parts)) = content {
                            for part in parts {
                                let Some(part_map) = part.as_object() else { return Err(attr_error(part)) };
                                if part_map.get("type").and_then(Value::as_str) == Some("tool_use") {
                                    let name = part_map.get("name").map(text_of).unwrap_or_default();
                                    let input = part_map.get("input").cloned().unwrap_or(Value::Null);
                                    on_line(&describe_tool(&name, &input, cwd));
                                }
                            }
                        }
                    }
                    Some("result") => {
                        if map.get("is_error").is_some_and(pyjson::truthy) {
                            let said = map.get("result").filter(|v| pyjson::truthy(v)).map(text_of);
                            let said = said.unwrap_or_else(|| "The AI run failed.".to_string());
                            return Err(AskError::Failed(said.chars().take(300).collect()));
                        }
                        result = match map.get("result") {
                            None | Some(Value::Null) => None,
                            Some(v) => Some(text_of(v)),
                        };
                    }
                    _ => {}
                }
            }
            Ok(result)
        };
        tokio::select! {
            r = work => Some(r),
            () = cancel.cancelled() => None,
        }
    };
    let result = match outcome {
        Some(Ok(result)) => result,
        other => {
            // never left behind: the CLI and what it started go, and it is waited for
            cli::kill_tree(pid);
            let _ = child.wait().await;
            err_task.abort();
            return match other {
                Some(Err(e)) => Err(e),
                _ => Err(AskError::Cancelled),
            };
        }
    };
    let status = child.wait().await.map_err(|e| AskError::Failed(e.to_string()))?;
    let stderr_text = err_task.await.unwrap_or_default();
    if result.is_none() && !status.success() {
        let err = String::from_utf8_lossy(&stderr_text).into_owned();
        let last = pytext::splitlines(pytext::strip(&err)).last().copied().unwrap_or("The AI run failed.").to_string();
        return Err(AskError::Failed(last.chars().take(300).collect()));
    }
    Ok(result)
}

/// The AI's answer as a proposal: for each command its text, where it came from and a note. None when the answer cannot
/// be read.
pub fn parse_proposal(text: Option<&str>) -> Option<Value> {
    let data = parse_refined(text)?;
    if data.is_empty() {
        return None;
    }
    let commands = data.get("commands").and_then(Value::as_object)?;
    let mut out = Map::new();
    for name in COMMANDS {
        let item = match commands.get(name) {
            Some(Value::String(s)) => {
                let mut m = Map::new();
                m.insert("command".into(), json!(s));
                m
            }
            Some(Value::Object(m)) => m.clone(),
            _ => Map::new(),
        };
        let field = |key: &str| item.get(key).filter(|v| pyjson::truthy(v)).map(text_of).unwrap_or_default();
        out.insert(
            name.to_string(),
            json!({
                "command": pytext::squash(&field("command")).chars().take(1000).collect::<String>(),
                "source": field("source").chars().take(200).collect::<String>(),
                "note": field("note").chars().take(300).collect::<String>(),
            }),
        );
    }
    let notes = data.get("notes").filter(|v| pyjson::truthy(v)).map(text_of).unwrap_or_default();
    Some(json!({"commands": out, "notes": notes.chars().take(300).collect::<String>()}))
}

/// The scan's own suggestion in the proposal's shape (when the AI's answer cannot be read).
pub fn code_proposal(suggested: &Value) -> Value {
    let mut cmds: Map<String, Value> =
        suggested.get("commands").filter(|v| pyjson::truthy(v)).and_then(Value::as_object).cloned().unwrap_or_default();
    let prepare = suggested.get("prepare").filter(|v| pyjson::truthy(v)).cloned().unwrap_or_else(|| json!(""));
    cmds.insert("prepare".into(), prepare);
    let mut out = Map::new();
    for name in COMMANDS {
        let command = cmds.get(name).filter(|v| pyjson::truthy(v)).cloned();
        let source = if command.is_some() { "the board's scan" } else { "" };
        out.insert(
            name.to_string(),
            json!({"command": command.unwrap_or_else(|| json!("")), "source": source, "note": ""}),
        );
    }
    json!({"commands": out, "notes": ""})
}
