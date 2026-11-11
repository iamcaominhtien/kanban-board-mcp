//! Runtime config (the data folder and saved settings) kept in a JSON file.
//!
//! The file is `~/.kanban-board/config.json`; `KANBAN_CONFIG_DIR` picks another folder, so a test instance keeps its
//! own settings and data folder while HOME stays the person's own.

use std::path::{Path, PathBuf};
use std::sync::LazyLock;

use serde_json::{Map, Value};

use crate::pyjson;

/// The switch behind "Full control over MCP" (Settings > Integrations).
pub const MCP_FULL_CONTROL: &str = "mcp_full_control";

static CONFIG_DIR: LazyLock<PathBuf> = LazyLock::new(|| match std::env::var("KANBAN_CONFIG_DIR") {
    Ok(dir) if !dir.is_empty() => expanduser(&dir),
    _ => home_dir().join(".kanban-board"),
});

/// `Path.home()`.
pub fn home_dir() -> PathBuf {
    std::env::home_dir().unwrap_or_else(|| PathBuf::from("."))
}

/// `Path(text).expanduser()`: a leading `~` is the home folder.
pub fn expanduser(text: &str) -> PathBuf {
    if text == "~" {
        home_dir()
    } else if let Some(rest) = text.strip_prefix("~/").or_else(|| text.strip_prefix("~\\")) {
        home_dir().join(rest)
    } else {
        PathBuf::from(text)
    }
}

/// The folder that holds `config.json`.
pub fn config_dir() -> &'static Path {
    &CONFIG_DIR
}

fn config_file() -> PathBuf {
    CONFIG_DIR.join("config.json")
}

fn load() -> Map<String, Value> {
    let text = match std::fs::read_to_string(config_file()) {
        Ok(text) => text,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Map::new(),
        Err(_) => {
            tracing::warn!("Corrupted config file at {} — using defaults", config_file().display());
            return Map::new();
        }
    };
    match serde_json::from_str::<Value>(&text) {
        Ok(Value::Object(map)) => map,
        _ => {
            tracing::warn!("Corrupted config file at {} — using defaults", config_file().display());
            Map::new()
        }
    }
}

fn save(data: Map<String, Value>) -> std::io::Result<()> {
    std::fs::create_dir_all(&*CONFIG_DIR)?;
    std::fs::write(config_file(), pyjson::Dumps::new().indent(2).dump(&Value::Object(data)))
}

/// The stored data folder, or `None` when it was never set.
pub fn get_data_folder() -> Option<PathBuf> {
    match load().get("data_folder") {
        Some(Value::String(value)) if !value.is_empty() => Some(PathBuf::from(value)),
        _ => None,
    }
}

/// The uploads folder the desktop app recorded at its start (`uploads_dir`), or `None` when it never did. A server
/// that did not get `KANBAN_UPLOADS_DIR` (the stdio MCP of an outside session) serves and writes the same folder as
/// the app through this.
pub fn get_uploads_dir() -> Option<PathBuf> {
    match load().get("uploads_dir") {
        Some(Value::String(value)) if !value.is_empty() => Some(PathBuf::from(value)),
        _ => None,
    }
}

/// Persist the data folder path in the config file.
pub fn set_data_folder(path: &Path) -> std::io::Result<()> {
    let mut data = load();
    data.insert("data_folder".into(), Value::String(path.to_string_lossy().into_owned()));
    save(data)
}

/// A saved group of settings (for example "database"); empty when never saved.
pub fn get_section(name: &str) -> Map<String, Value> {
    match load().remove(name) {
        Some(Value::Object(map)) => map,
        _ => Map::new(),
    }
}

/// Save a group of settings, or remove it with `None`.
pub fn set_section(name: &str, value: Option<Map<String, Value>>) -> std::io::Result<()> {
    let mut data = load();
    match value {
        None => {
            data.shift_remove(name);
        }
        Some(value) => {
            data.insert(name.into(), Value::Object(value));
        }
    }
    save(data)
}

/// Whether the app-wide switch `name` is on (off when never set).
pub fn get_flag(name: &str) -> bool {
    load().get(name) == Some(&Value::Bool(true))
}

/// Persist an app-wide switch.
pub fn set_flag(name: &str, on: bool) -> std::io::Result<()> {
    let mut data = load();
    data.insert(name.into(), Value::Bool(on));
    save(data)
}

/// Any top-level value of the config file (for the few keys that have no accessor of their own).
pub fn get_value(name: &str) -> Option<Value> {
    load().remove(name)
}

/// Set any top-level value of the config file.
pub fn set_value(name: &str, value: Value) -> std::io::Result<()> {
    let mut data = load();
    data.insert(name.into(), value);
    save(data)
}
