//! A fake `claude` for the install tests (the `FAKE_CLAUDE` script of `tests/test_mcp_clients.py`): `mcp add` and
//! `mcp remove` edit `$HOME/.claude.json` the way the real CLI does for the user scope (the Python fake left out `--env`;
//! this one keeps it, as the real CLI does, so an entry it installed is not reported as out of date). It fails (prints `boom` and
//! exits 1) while the file `$HOME/.fake-claude-fail` exists. It never touches anything outside `$HOME`.

use std::path::PathBuf;
use std::process::ExitCode;

use kb_base::pyjson;
use serde_json::{Map, Value, json};

fn main() -> ExitCode {
    let Some(home) = std::env::var_os("HOME").map(PathBuf::from) else {
        eprintln!("HOME is not set");
        return ExitCode::from(2);
    };
    let path = home.join(".claude.json");
    let mut data: Map<String, Value> = std::fs::read_to_string(&path)
        .ok()
        .and_then(|text| serde_json::from_str::<Value>(&text).ok())
        .and_then(|value| if let Value::Object(map) = value { Some(map) } else { None })
        .unwrap_or_default();
    let args: Vec<String> = std::env::args().skip(1).collect();
    if home.join(".fake-claude-fail").exists() {
        eprintln!("boom");
        return ExitCode::from(1);
    }
    let Some(scope_at) = args.iter().position(|a| a == "--scope") else {
        eprintln!("no --scope");
        return ExitCode::from(1);
    };
    let _scope = args.get(scope_at + 1);
    let has_kanban = |data: &Map<String, Value>| data.get("mcpServers").and_then(|s| s.get("kanban")).is_some();
    if args.starts_with(&["mcp".to_string(), "add".to_string()]) {
        if has_kanban(&data) {
            eprintln!("already exists");
            return ExitCode::from(1);
        }
        let cmd: Vec<&String> = args.iter().skip_while(|a| *a != "--").skip(1).collect();
        let mut entry =
            json!({"type": "stdio", "command": cmd.first(), "args": cmd.iter().skip(1).collect::<Vec<_>>()});
        // `--env KEY=value` (before the `--`) is kept in the entry, as the real CLI keeps it
        let before: Vec<&String> = args.iter().take_while(|a| *a != "--").collect();
        let env: Map<String, Value> = before
            .windows(2)
            .filter(|pair| pair[0] == "--env")
            .filter_map(|pair| pair[1].split_once('='))
            .map(|(key, value)| (key.to_string(), json!(value)))
            .collect();
        if !env.is_empty() {
            entry["env"] = Value::Object(env);
        }
        let servers = data.entry("mcpServers").or_insert_with(|| json!({}));
        if let Some(map) = servers.as_object_mut() {
            map.insert("kanban".into(), entry);
        }
    } else if args.starts_with(&["mcp".to_string(), "remove".to_string()])
        && let Some(map) = data.get_mut("mcpServers").and_then(Value::as_object_mut)
    {
        map.shift_remove("kanban");
    }
    if std::fs::write(&path, pyjson::dumps(&Value::Object(data))).is_err() {
        return ExitCode::from(1);
    }
    ExitCode::SUCCESS
}
