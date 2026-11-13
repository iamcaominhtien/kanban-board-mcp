//! Runtime config (the data folder and saved settings) kept in a JSON file.
//!
//! The file is `~/.kanban-board/config.json`; `KANBAN_CONFIG_DIR` picks another folder, so a test instance keeps its
//! own settings and data folder while HOME stays the person's own.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{LazyLock, Mutex};

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

/// Serializes every change of the file inside this process (the app writes it from many requests at once).
static WRITE_LOCK: Mutex<()> = Mutex::new(());
/// Makes the name of each temporary file of this process different.
static TMP_COUNTER: AtomicU64 = AtomicU64::new(0);

/// The settings in `file`: empty when there is no file. A file that cannot be read or parsed is moved aside
/// (`config.json.corrupt-<time>`) and read as empty, so that the next save never overwrites what a person may want
/// back.
fn read_file(file: &Path) -> Map<String, Value> {
    let text = match std::fs::read_to_string(file) {
        Ok(text) => text,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Map::new(),
        Err(err) => {
            tracing::warn!("The config file at {} cannot be read ({err}) — using defaults", file.display());
            return Map::new();
        }
    };
    match serde_json::from_str::<Value>(&text) {
        Ok(Value::Object(map)) => map,
        _ => {
            let aside = file.with_extension(format!("json.corrupt-{}", crate::time::epoch() as u64));
            match std::fs::rename(file, &aside) {
                Ok(()) => tracing::warn!(
                    "Corrupted config file at {}: kept as {} — using defaults",
                    file.display(),
                    aside.display()
                ),
                Err(err) => tracing::warn!(
                    "Corrupted config file at {} (could not keep a copy: {err}) — using defaults",
                    file.display()
                ),
            }
            Map::new()
        }
    }
}

fn load() -> Map<String, Value> {
    read_file(&config_file())
}

/// Write `data` to `file` all or nothing: to a temporary file next to it, then renamed over it. A reader (another
/// process, or the follow loop of this one) sees the old settings or the new ones, never half of a file.
fn write_atomic(file: &Path, data: &Map<String, Value>) -> std::io::Result<()> {
    let dir = file.parent().unwrap_or_else(|| Path::new("."));
    std::fs::create_dir_all(dir)?;
    let tmp =
        dir.join(format!(".config.json.{}.{}.tmp", std::process::id(), TMP_COUNTER.fetch_add(1, Ordering::Relaxed)));
    let text = pyjson::Dumps::new().indent(2).dump(&Value::Object(data.clone()));
    let written = std::fs::write(&tmp, text).and_then(|()| std::fs::rename(&tmp, file));
    if written.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    written
}

/// Change `file` as `change` says, under the lock, saving once when `change` returns `true`.
fn update_file(file: &Path, change: impl FnOnce(&mut Map<String, Value>) -> bool) -> std::io::Result<bool> {
    let _guard = WRITE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut data = read_file(file);
    let changed = change(&mut data);
    if changed {
        write_atomic(file, &data)?;
    }
    Ok(changed)
}

/// Read-modify-write of the config file in one step: `change` gets the settings and returns whether it changed
/// anything; only then is the file saved. Several keys changed here are saved together (a switch of workspace changes
/// three), and no other change of this process can come between the read and the write.
///
/// # Errors
/// The file cannot be written.
pub fn update(change: impl FnOnce(&mut Map<String, Value>) -> bool) -> std::io::Result<bool> {
    update_file(&config_file(), change)
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
    update(|data| {
        data.insert("data_folder".into(), Value::String(path.to_string_lossy().into_owned()));
        true
    })
    .map(|_| ())
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
    update(|data| {
        // `data.get("port") != port`, with Python's equality (`8000.0 == 8000`, `True == 1`)
        let same = match data.get("port") {
            Some(Value::Number(n)) => n.as_f64() == Some(f64::from(port)),
            Some(Value::Bool(b)) => u16::from(*b) == port,
            _ => false,
        };
        if !same {
            data.insert("port".into(), Value::from(port));
        }
        !same
    })
    .map(|_| ())
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
    update(|data| {
        match value {
            None => {
                data.shift_remove(name);
            }
            Some(value) => {
                data.insert(name.into(), Value::Object(value));
            }
        }
        true
    })
    .map(|_| ())
}

/// Whether the app-wide switch `name` is on (off when never set).
pub fn get_flag(name: &str) -> bool {
    load().get(name) == Some(&Value::Bool(true))
}

/// Persist an app-wide switch.
pub fn set_flag(name: &str, on: bool) -> std::io::Result<()> {
    update(|data| {
        data.insert(name.into(), Value::Bool(on));
        true
    })
    .map(|_| ())
}

/// Any top-level value of the config file (for the few keys that have no accessor of their own).
pub fn get_value(name: &str) -> Option<Value> {
    load().remove(name)
}

/// Set any top-level value of the config file.
pub fn set_value(name: &str, value: Value) -> std::io::Result<()> {
    update(|data| {
        data.insert(name.into(), value);
        true
    })
    .map(|_| ())
}

#[cfg(test)]
mod tests {
    use serde_json::{Value, json};

    use super::{port_of, read_file, update_file};

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

    #[test]
    fn many_threads_changing_the_file_lose_nothing() {
        let dir = tempfile::tempdir().expect("tmp");
        let file = dir.path().join("config.json");
        let threads: Vec<_> = (0..16)
            .map(|t| {
                let file = file.clone();
                std::thread::spawn(move || {
                    for i in 0..25 {
                        update_file(&file, |data| {
                            data.insert(format!("k{t}_{i}"), Value::from(i));
                            true
                        })
                        .expect("saved");
                    }
                })
            })
            .collect();
        for t in threads {
            t.join().expect("thread");
        }
        assert_eq!(read_file(&file).len(), 16 * 25);
        // no temporary file is left behind
        let left: Vec<_> = std::fs::read_dir(dir.path()).expect("dir").map(|e| e.expect("entry").file_name()).collect();
        assert_eq!(left.len(), 1, "{left:?}");
    }

    #[test]
    fn an_unreadable_file_is_kept_aside_and_never_overwritten() {
        let dir = tempfile::tempdir().expect("tmp");
        let file = dir.path().join("config.json");
        std::fs::write(&file, "{\"data_folder\": \"/precious\", ").expect("write");
        update_file(&file, |data| {
            data.insert("port".into(), json!(8123));
            true
        })
        .expect("saved");
        assert_eq!(read_file(&file).get("port"), Some(&json!(8123)));
        let kept: Vec<_> = std::fs::read_dir(dir.path())
            .expect("dir")
            .map(|e| e.expect("entry").path())
            .filter(|p| p.to_string_lossy().contains("corrupt"))
            .collect();
        assert_eq!(kept.len(), 1, "the damaged file was not kept");
        assert!(std::fs::read_to_string(&kept[0]).expect("read").contains("/precious"));
    }

    #[test]
    fn nothing_is_written_when_nothing_changed() {
        let dir = tempfile::tempdir().expect("tmp");
        let file = dir.path().join("config.json");
        assert!(!update_file(&file, |_| false).expect("ok"));
        assert!(!file.exists());
    }
}
