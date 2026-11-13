//! `tests/test_database.py`: where the SQLite file and the uploads folder are, from the environment and the saved
//! data folder. The Python tests reloaded the `database` module; here `database::setup()` reads the settings again.

use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use kb_base::config as app_config;
use kb_db::database;
use serde_json::Value;

/// These tests change the environment and the settings file of the process: one at a time.
static SERIAL: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

#[allow(unsafe_code)]
fn set_env(name: &str, value: Option<&str>) {
    // Every test that reads these holds `SERIAL`.
    unsafe {
        match value {
            Some(value) => std::env::set_var(name, value),
            None => std::env::remove_var(name),
        }
    }
}

/// A settings folder of the tests' own; `data_folder` is what `config.get_data_folder` gives.
fn settings(data_folder: Option<&Path>) -> &'static Path {
    static DIR: OnceLock<PathBuf> = OnceLock::new();
    let dir = DIR.get_or_init(|| {
        let dir = tempfile::tempdir().expect("tmp").keep();
        set_env("KANBAN_CONFIG_DIR", Some(&dir.to_string_lossy()));
        dir
    });
    set_env("KANBAN_DATABASE_URL", None);
    match data_folder {
        Some(folder) => app_config::set_data_folder(folder).expect("settings"),
        None => app_config::set_value("data_folder", Value::Null).expect("settings"),
    }
    dir
}

#[tokio::test]
async fn test_database_uses_repo_default_path_when_env_missing() {
    let _serial = SERIAL.lock().await;
    settings(None);
    set_env("KANBAN_DB_PATH", None);
    database::setup().await.expect("setup");
    // next to the program, as the Python server kept it next to its sources
    let expected = std::env::current_exe().expect("exe").parent().expect("folder").join("kanban.db");
    assert_eq!(database::get_db_path(), expected);
    assert_eq!(database::database_url(), format!("sqlite+aiosqlite:///{}", expected.display()));
    let _ = database::conn().close().await;
    for suffix in ["", "-wal", "-shm"] {
        let _ = std::fs::remove_file(format!("{}{suffix}", expected.display()));
    }
}

#[tokio::test]
async fn test_database_resolves_env_path_and_creates_parent_directory() {
    let _serial = SERIAL.lock().await;
    settings(None);
    let tmp = tempfile::tempdir().expect("tmp");
    let db_path = tmp.path().join("nested").join("state").join("kanban.db");
    set_env("KANBAN_DB_PATH", Some(&db_path.to_string_lossy()));
    database::setup().await.expect("setup");
    let resolved = db_path.parent().expect("folder").canonicalize().expect("the folder was made").join("kanban.db");
    assert_eq!(database::get_db_path(), resolved);
    assert!(db_path.parent().expect("folder").is_dir());
    assert_eq!(database::database_url(), format!("sqlite+aiosqlite:///{}", resolved.display()));
    assert_eq!(database::get_data_dir(), resolved.parent().expect("folder"));
    let _ = database::conn().close().await;
}

#[tokio::test]
async fn test_data_folder_from_settings_wins_over_env_path() {
    let _serial = SERIAL.lock().await;
    // The desktop app always passes KANBAN_DB_PATH (its default location). Someone who moved their data folder in
    // Settings must still get that data after an upgrade.
    let tmp = tempfile::tempdir().expect("tmp");
    let chosen = tmp.path().join("my-data");
    settings(Some(&chosen));
    set_env("KANBAN_DB_PATH", Some(&tmp.path().join("app-default").join("kanban.db").to_string_lossy()));
    database::setup().await.expect("setup");
    assert_eq!(database::get_db_path(), chosen.join("kanban.db"));
    let _ = database::conn().close().await;
    settings(None);
}

#[tokio::test]
async fn test_uploads_uses_data_folder_when_configured() {
    let _serial = SERIAL.lock().await;
    let tmp = tempfile::tempdir().expect("tmp");
    let chosen = tmp.path().canonicalize().expect("tmp").join("my-data");
    settings(Some(&chosen));
    set_env("KANBAN_UPLOADS_DIR", None);
    assert_eq!(kb_files::uploads::get_uploads_dir(true), chosen.join("uploads"));
    settings(None);
}

#[tokio::test]
async fn test_uploads_uses_env_when_set() {
    let _serial = SERIAL.lock().await;
    let tmp = tempfile::tempdir().expect("tmp");
    let custom = tmp.path().canonicalize().expect("tmp").join("custom-uploads");
    settings(Some(&tmp.path().join("other")));
    set_env("KANBAN_UPLOADS_DIR", Some(&custom.to_string_lossy()));
    assert_eq!(kb_files::uploads::get_uploads_dir(true), custom);
    set_env("KANBAN_UPLOADS_DIR", None);
    settings(None);
}
