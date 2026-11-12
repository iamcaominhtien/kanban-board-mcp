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

/// The port the server listened on last time (`port`), or `None` when it never saved one.
pub fn get_port() -> Option<u16> {
    port_of(load().get("port"))
}

/// `value if isinstance(value, int) and 0 < value < 65536 else None`. A JSON `true` is an int in Python (1), so it
/// passes as port 1, as it does there.
fn port_of(value: Option<&Value>) -> Option<u16> {
    let number = match value? {
        // a float is not an int; an int beyond i64 is beyond any port
        Value::Number(n) if n.is_f64() => return None,
        Value::Number(n) => n.as_i64().unwrap_or(i64::MAX),
        Value::Bool(b) => i64::from(*b),
        _ => return None,
    };
    if 0 < number && number < 65536 { u16::try_from(number).ok() } else { None }
}

/// Remember the port the server listens on, so the next start asks for the same one.
pub fn set_port(port: u16) -> std::io::Result<()> {
    let mut data = load();
    // `data.get("port") != port`, with Python's equality (`8000.0 == 8000`, `True == 1`)
    let same = match data.get("port") {
        Some(Value::Number(n)) => n.as_f64() == Some(f64::from(port)),
        Some(Value::Bool(b)) => u16::from(*b) == port,
        _ => false,
    };
    if !same {
        data.insert("port".into(), Value::from(port));
        save(data)?;
    }
    Ok(())
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

#[cfg(test)]
mod tests {
    use super::port_of;
    use serde_json::json;

    #[test]
    fn a_saved_port_is_an_int_between_1_and_65535() {
        assert_eq!(port_of(None), None);
        assert_eq!(port_of(Some(&json!(8123))), Some(8123));
        assert_eq!(port_of(Some(&json!(65535))), Some(65535));
        for bad in [json!("nope"), json!("8000"), json!(0), json!(-5), json!(65536), json!(8000.0), json!(null)] {
            assert_eq!(port_of(Some(&bad)), None, "{bad}");
        }
        assert_eq!(port_of(Some(&json!(u64::MAX))), None);
        // `isinstance(True, int)`
        assert_eq!(port_of(Some(&json!(true))), Some(1));
        assert_eq!(port_of(Some(&json!(false))), None);
    }
}
