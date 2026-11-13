//! The light model: one answer from Haiku through the Claude Code CLI, as a child process (`kb._ask_light` and
//! `knowledge._ask_light_model` run the same command). Never left behind: a child that does not answer in time is
//! killed with everything it started (`seams::Cli::kill_tree`) and waited for.

use std::collections::HashMap;
use std::process::Stdio;
use std::time::Duration;

use serde_json::Value;
use tokio::io::AsyncReadExt;
use tokio::process::Command;

use crate::seams;

/// The command line of the light model: `claude -p <prompt> --model haiku ...`.
pub(crate) fn args(path: &str, prompt: &str, allow_read: Option<&str>) -> Vec<String> {
    let mut args: Vec<String> = [
        path,
        "-p",
        prompt,
        "--model",
        "haiku",
        "--output-format",
        "json",
        "--permission-mode",
        "dontAsk",
        "--strict-mcp-config",
        "--mcp-config",
        "{\"mcpServers\": {}}",
    ]
    .iter()
    .map(|s| s.to_string())
    .collect();
    if let Some(allow) = allow_read {
        args.push("--allowedTools".into());
        args.push("Read".into());
        args.push("--add-dir".into());
        // `str(Path(allow_read).parent)`
        let parent = std::path::Path::new(allow).parent().map(|p| p.to_string_lossy().into_owned()).unwrap_or_default();
        args.push(if parent.is_empty() { ".".into() } else { parent });
    }
    args
}

/// Run the command, read its JSON reply and return the `result` text. None when the CLI cannot start, does not answer
/// within `timeout`, or does not print JSON.
pub(crate) async fn run(args: &[String], env: HashMap<String, String>, timeout: Duration) -> Option<String> {
    let (program, rest) = args.split_first()?;
    let mut command = Command::new(program);
    command
        .args(rest)
        .env_clear()
        .envs(env)
        .current_dir(std::env::temp_dir())
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let mut child = command.spawn().ok()?;
    let pid = child.id();
    let mut stdout = child.stdout.take()?;
    let mut stderr = child.stderr.take()?;
    let work = async {
        let mut out = Vec::new();
        let mut err = Vec::new();
        let (a, b, _status) = tokio::join!(stdout.read_to_end(&mut out), stderr.read_to_end(&mut err), child.wait());
        a.ok()?;
        b.ok()?;
        Some(out)
    };
    let out = match tokio::time::timeout(timeout, work).await {
        Ok(out) => out?,
        Err(_elapsed) => {
            // never left behind: the child and what it started go, and it is waited for
            if let (Some(pid), Some(cli)) = (pid, seams::cli()) {
                cli.kill_tree(pid);
            }
            let _ = child.start_kill();
            let _ = child.wait().await;
            return None;
        }
    };
    match serde_json::from_str::<Value>(&{
        let text = String::from_utf8_lossy(&out).into_owned();
        if text.is_empty() { "{}".to_string() } else { text }
    }) {
        Ok(Value::Object(map)) => match map.get("result") {
            Some(Value::String(s)) => Some(s.clone()),
            _ => None,
        },
        _ => None,
    }
}
