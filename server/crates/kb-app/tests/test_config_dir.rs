//! Port of `server/tests/test_config_dir.py`: `KANBAN_CONFIG_DIR` gives a test instance its own `config.json` (and so
//! its own data folder) without moving HOME.
//!
//! The Python test reloads the `config` module and reads `_CONFIG_FILE`; the server's view of the same thing is where
//! it finds its data folder, which also names the folder of the uploads (`<data folder>/uploads`) when
//! `KANBAN_UPLOADS_DIR` is not set. So the test writes `config.json` where the variable (or the default
//! `~/.kanban-board`) points, and looks for a file in the uploads folder of the data folder it names.

mod common;

use common::*;
use serde_json::json;
use testkit::{Options, Server, skip_unless_available};

/// No uploads folder from the environment: the data folder of the config file decides.
fn env_for(config_dir: Option<&std::path::Path>, home: &std::path::Path) -> Options {
    Options {
        env: vec![
            ("KANBAN_UPLOADS_DIR".into(), String::new()),
            ("KANBAN_CONFIG_DIR".into(), config_dir.map(|d| d.display().to_string()).unwrap_or_default()),
            ("HOME".into(), home.display().to_string()),
        ],
        fresh_db: true,
        ..Options::default()
    }
}

fn write_config(folder: &std::path::Path, data: &std::path::Path) {
    std::fs::create_dir_all(folder).expect("config folder");
    std::fs::write(folder.join("config.json"), json!({"data_folder": data.display().to_string()}).to_string())
        .expect("config");
}

#[tokio::test]
async fn test_the_config_folder_can_be_moved_with_an_environment_variable() {
    if !skip_unless_available("test_the_config_folder_can_be_moved_with_an_environment_variable") {
        return;
    }
    let tmp = tempfile::tempdir().expect("temp dir");
    let (cfg, data, home) = (tmp.path().join("cfg"), tmp.path().join("data"), tmp.path().join("home"));
    std::fs::create_dir_all(&home).expect("home");
    write_config(&cfg, &data);
    put_file(&data.join("uploads"), "from-data-folder.txt", b"data folder");
    // another config.json in the person's own place: it must not be read
    let other = tmp.path().join("other");
    put_file(&other.join("uploads"), "from-other.txt", b"other");
    write_config(&home.join(".kanban-board"), &other);

    let s = Server::start_with(env_for(Some(&cfg), &home)).await;
    let r = get(&s, "/uploads/from-data-folder.txt?download=1").await;
    assert_eq!((r.status, r.body.as_slice()), (200, &b"data folder"[..]), "the data folder of KANBAN_CONFIG_DIR");
    assert_eq!(get(&s, "/uploads/from-other.txt").await.status, 404);
    s.stop().await;
}

#[tokio::test]
async fn test_without_the_variable_the_config_folder_is_dot_kanban_board_in_home() {
    if !skip_unless_available("test_without_the_variable_the_config_folder_is_dot_kanban_board_in_home") {
        return;
    }
    let tmp = tempfile::tempdir().expect("temp dir");
    let (data, home) = (tmp.path().join("data"), tmp.path().join("home"));
    write_config(&home.join(".kanban-board"), &data);
    put_file(&data.join("uploads"), "from-home.txt", b"home");

    let s = Server::start_with(env_for(None, &home)).await;
    let r = get(&s, "/uploads/from-home.txt?download=1").await;
    assert_eq!((r.status, r.body.as_slice()), (200, &b"home"[..]), "~/.kanban-board/config.json");
    s.stop().await;
}
