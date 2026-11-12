//! The MCP servers a Claude Code opened in a member's working folder would load from its own files.
//!
//! The CLI runs with `--strict-mcp-config`, so that nothing else is loaded (account connectors, plugins nobody enabled
//! for this folder). What the folder does ask for is read here and passed on explicitly:
//!
//! - project scope: the folder's `.mcp.json`;
//! - local and user scope: the `mcpServers` of `~/.claude.json` (the entry of this folder, and the top-level one);
//! - the plugins the folder's `.claude/settings.json` and `settings.local.json` enable (`enabledPlugins`), with the
//!   servers of each plugin's own `.mcp.json` or `plugin.json`.
//!
//! A nearer scope wins a name. The board's own `kanban` server is never taken from a file: it is the one that carries
//! the permission guard's token.

use std::path::Path;
use std::sync::LazyLock;

use kb_base::{ctx, pyjson, pypath};
use regex::Regex;
use serde_json::{Map, Value};

pub const MAX_FILE: u64 = 1_000_000;

/// The config folder of the AI account a call is made for (None: the login already on this computer). Set with
/// `set_account_dir`; a value of the current task, so the readers below need no extra argument and two runs on
/// different accounts never see each other's servers.
#[derive(Clone)]
struct AccountDir(Option<String>);

/// `ACCOUNT_DIR.set(value)`; give the token to `ctx::reset` to restore the earlier value.
pub fn set_account_dir(value: Option<&str>) -> ctx::Token {
    ctx::set(AccountDir(value.map(str::to_string)))
}

/// `ACCOUNT_DIR.get()`.
pub fn account_dir() -> Option<String> {
    ctx::get::<AccountDir>().and_then(|a| a.0)
}

fn read_json(path: &str) -> Map<String, Value> {
    let Ok(meta) = std::fs::metadata(path) else { return Map::new() };
    if meta.len() > MAX_FILE {
        return Map::new();
    }
    match std::fs::read_to_string(path).ok().and_then(|t| serde_json::from_str::<Value>(&t).ok()) {
        Some(Value::Object(map)) => map,
        _ => Map::new(),
    }
}

/// The enabled servers of one `mcpServers` object, except the board's own.
fn usable(listed: Option<&Value>) -> Map<String, Value> {
    let Some(Value::Object(listed)) = listed else { return Map::new() };
    listed
        .iter()
        .filter(|(name, spec)| {
            name.as_str() != "kanban"
                && spec.as_object().is_some_and(|s| {
                    !s.get("disabled").is_some_and(pyjson::truthy) && s.get("enabled").is_none_or(pyjson::truthy)
                })
        })
        .map(|(name, spec)| (name.clone(), spec.clone()))
        .collect()
}

fn same_path(a: &str, b: &str) -> bool {
    let norm = |p: &str| {
        let n = pypath::normpath(&p.replace('\\', "/"));
        if cfg!(windows) { n.replace('/', "\\").to_lowercase() } else { n }
    };
    norm(a) == norm(b)
}

fn config_dir() -> String {
    account_dir()
        .filter(|d| !d.is_empty())
        .or_else(|| std::env::var("CLAUDE_CONFIG_DIR").ok().filter(|d| !d.is_empty()))
        .unwrap_or_else(|| pypath::expanduser("~/.claude"))
}

fn account_file() -> String {
    let custom = account_dir().filter(|d| !d.is_empty()).or_else(|| std::env::var("CLAUDE_CONFIG_DIR").ok().filter(|d| !d.is_empty()));
    pypath::join(&custom.unwrap_or_else(|| pypath::expanduser("~")), ".claude.json")
}

fn substitute(value: &Value, root: &str) -> Value {
    match value {
        Value::String(s) => Value::String(s.replace("${CLAUDE_PLUGIN_ROOT}", root)),
        Value::Array(items) => Value::Array(items.iter().map(|v| substitute(v, root)).collect()),
        Value::Object(map) => Value::Object(map.iter().map(|(k, v)| (k.clone(), substitute(v, root))).collect()),
        other => other.clone(),
    }
}

static UNSAFE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[^A-Za-z0-9_-]").expect("the name pattern compiles"));

fn clean(text: &str) -> String {
    UNSAFE.replace_all(text, "_").into_owned()
}

/// `name@marketplace` of the plugins the folder's own settings files switch on.
pub fn enabled_plugins(folder: &str) -> Vec<String> {
    let mut names: Vec<(String, bool)> = Vec::new();
    for fname in ["settings.json", "settings.local.json"] {
        let path = pypath::join(&pypath::join(folder, ".claude"), fname);
        if let Some(Value::Object(listed)) = read_json(&path).get("enabledPlugins") {
            for (k, v) in listed {
                let on = *v == Value::Bool(true);
                match names.iter_mut().find(|(name, _)| name == k) {
                    Some(slot) => slot.1 = on,
                    None => names.push((k.clone(), on)),
                }
            }
        }
    }
    names.into_iter().filter(|(_, on)| *on).map(|(k, _)| k).collect()
}

/// Where Claude Code installed a plugin for this folder (its own scope first, then the user's).
fn install_path(key: &str, folder: &str) -> Option<String> {
    let installed = read_json(&pypath::join(&pypath::join(&config_dir(), "plugins"), "installed_plugins.json"));
    let plugins = installed.get("plugins").filter(|p| pyjson::truthy(p))?;
    let entries = plugins.as_object()?.get(key)?.as_array()?;
    let mut found: Option<String> = None;
    for entry in entries {
        let Some(entry) = entry.as_object() else { continue };
        let Some(path) = entry.get("installPath").and_then(Value::as_str) else { continue };
        let (scope, project) = (entry.get("scope").and_then(Value::as_str), entry.get("projectPath"));
        if let Some(project) = project.filter(|p| pyjson::truthy(p)) {
            if !same_path(&pyjson::py_str(project), folder) {
                continue;
            }
        }
        if matches!(scope, Some("local" | "project")) {
            return Some(path.to_string());
        }
        if found.as_deref().is_none_or(str::is_empty) {
            found = Some(path.to_string());
        }
    }
    found
}

/// The servers one installed plugin declares: its `.mcp.json` (with or without the `mcpServers` wrapper) and the
/// `mcpServers` of its `plugin.json`.
fn plugin_servers_of(root: &str) -> Map<String, Value> {
    let mut found = Map::new();
    let mut manifest = Map::new();
    for rel in [pypath::join(".claude-plugin", "plugin.json"), "plugin.json".to_string()] {
        manifest = read_json(&pypath::join(root, &rel));
        if !manifest.is_empty() {
            break;
        }
    }
    let mut declared = manifest.get("mcpServers").cloned();
    if let Some(Value::String(path)) = &declared {
        // a path inside the plugin
        let target = pypath::normpath(&pypath::join(root, path));
        let sep = if cfg!(windows) { "\\" } else { "/" };
        if target.starts_with(&format!("{}{sep}", pypath::normpath(root))) {
            let file = read_json(&target);
            declared = Some(file.get("mcpServers").cloned().unwrap_or(Value::Object(file)));
        }
    }
    found.extend(usable(declared.as_ref()));
    let flat = read_json(&pypath::join(root, ".mcp.json"));
    let inner = flat.get("mcpServers").cloned().unwrap_or(Value::Object(flat));
    found.extend(usable(Some(&inner)));
    found
}

/// The servers of the plugins this folder enables, named `plugin_<plugin>_<server>` (what the CLI's own
/// `plugin:<plugin>:<server>` becomes in a tool name).
pub fn plugin_servers(folder: &str) -> Map<String, Value> {
    let mut out = Map::new();
    for key in enabled_plugins(folder) {
        let Some(root) = install_path(&key, folder).filter(|r| !r.is_empty() && Path::new(r).is_dir()) else { continue };
        let plugin = clean(key.split('@').next().unwrap_or(""));
        for (name, spec) in plugin_servers_of(&root) {
            out.insert(format!("plugin_{plugin}_{}", clean(&name)), substitute(&spec, &root));
        }
    }
    out
}

/// Every server the folder asks for (see the module notes), by name.
pub fn folder_servers(folder: Option<&str>) -> Map<String, Value> {
    let Some(folder) = folder.filter(|f| !f.is_empty()) else { return Map::new() };
    let account = read_json(&account_file());
    let mut local = Value::Object(Map::new());
    if let Some(Value::Object(projects)) = account.get("projects") {
        for (key, entry) in projects {
            if let Some(entry) = entry.as_object().filter(|_| same_path(key, folder)) {
                local = entry.get("mcpServers").filter(|v| pyjson::truthy(v)).cloned().unwrap_or(Value::Object(Map::new()));
                break;
            }
        }
    }
    let mut out = plugin_servers(folder);
    out.extend(usable(account.get("mcpServers")));
    out.extend(usable(read_json(&pypath::join(folder, ".mcp.json")).get("mcpServers")));
    out.extend(usable(Some(&local)));
    out
}
