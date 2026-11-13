//! Port of `server/tests/test_port_choice.py`: the board keeps its port from one start to the next, so an MCP
//! client's address does not go stale.
//!
//! The Python tests call `port_choice.bind_socket()` with their own config folder; here each test starts the real
//! server (either target) with a config folder of its own, kept across its starts, and reads the port from the
//! `READY` line and the saved one from `config.json`. The values `KANBAN_PORT` may hold are also a unit test of
//! `kb_app::port_choice::env_port`.

use std::net::TcpListener;
use std::path::Path;

use serde_json::{Value, json};
use testkit::{Options, Server, skip_unless_available};

/// A server whose config folder is `cfg` (kept when it stops), with `KANBAN_PORT` when given.
async fn start_in(cfg: &Path, kanban_port: Option<&str>) -> Server {
    let mut env = vec![("KANBAN_CONFIG_DIR".to_string(), cfg.to_string_lossy().into_owned())];
    if let Some(port) = kanban_port {
        env.push(("KANBAN_PORT".to_string(), port.to_string()));
    }
    Server::start_with(Options { env, ..Options::default() }).await
}

/// `config.get_port()` of that folder: the saved port when it is one.
fn saved_port(cfg: &Path) -> Option<Value> {
    let text = std::fs::read_to_string(cfg.join("config.json")).ok()?;
    serde_json::from_str::<Value>(&text).ok()?.get("port").cloned()
}

/// `config.set_port(port)` / `config._save({...})` of that folder.
fn save(cfg: &Path, data: Value) {
    std::fs::create_dir_all(cfg).expect("the config folder");
    std::fs::write(cfg.join("config.json"), data.to_string()).expect("config.json");
}

fn free_port() -> u16 {
    let s = TcpListener::bind("127.0.0.1:0").expect("a free port");
    s.local_addr().expect("its address").port()
}

#[tokio::test]
async fn test_the_first_start_takes_a_free_port_and_remembers_it() {
    if !skip_unless_available("test_the_first_start_takes_a_free_port_and_remembers_it") {
        return;
    }
    let cfg = tempfile::tempdir().expect("temp dir");
    assert_eq!(saved_port(cfg.path()), None);
    let s = start_in(cfg.path(), None).await;
    assert_eq!(saved_port(cfg.path()), Some(json!(s.port())));
    s.stop().await;
}

#[tokio::test]
async fn test_the_next_start_asks_for_the_port_of_the_last_one() {
    if !skip_unless_available("test_the_next_start_asks_for_the_port_of_the_last_one") {
        return;
    }
    let cfg = tempfile::tempdir().expect("temp dir");
    let port = free_port();
    save(cfg.path(), json!({"port": port}));
    let s = start_in(cfg.path(), None).await;
    assert_eq!(s.port(), port);
    s.stop().await;
}

#[tokio::test]
async fn test_the_port_survives_many_restarts() {
    if !skip_unless_available("test_the_port_survives_many_restarts") {
        return;
    }
    let cfg = tempfile::tempdir().expect("temp dir");
    let s = start_in(cfg.path(), None).await;
    let first = s.port();
    s.stop().await;
    for _ in 0..3 {
        let s = start_in(cfg.path(), None).await;
        assert_eq!(s.port(), first);
        s.stop().await;
    }
}

#[tokio::test]
async fn test_an_environment_variable_picks_the_port() {
    if !skip_unless_available("test_an_environment_variable_picks_the_port") {
        return;
    }
    let cfg = tempfile::tempdir().expect("temp dir");
    let port = free_port();
    save(cfg.path(), json!({"port": free_port()}));
    let s = start_in(cfg.path(), Some(&port.to_string())).await;
    assert_eq!(s.port(), port);
    assert_eq!(saved_port(cfg.path()), Some(json!(port)));
    s.stop().await;
}

#[tokio::test]
async fn test_a_port_that_is_taken_gives_a_free_one_and_keeps_the_saved_port() {
    if !skip_unless_available("test_a_port_that_is_taken_gives_a_free_one_and_keeps_the_saved_port") {
        return;
    }
    let cfg = tempfile::tempdir().expect("temp dir");
    let busy = TcpListener::bind("127.0.0.1:0").expect("a socket");
    let taken = busy.local_addr().expect("its address").port();
    save(cfg.path(), json!({"port": taken}));
    let s = start_in(cfg.path(), None).await;
    assert_ne!(s.port(), taken);
    s.stop().await;
    // a second instance that had to move does not steal the first one's port
    assert_eq!(saved_port(cfg.path()), Some(json!(taken)));
    drop(busy);
}

#[tokio::test]
async fn test_a_bad_environment_value_is_ignored() {
    if !skip_unless_available("test_a_bad_environment_value_is_ignored") {
        return;
    }
    for bad in ["abc", "0", "70000", "-5", ""] {
        let cfg = tempfile::tempdir().expect("temp dir");
        let port = free_port();
        save(cfg.path(), json!({"port": port}));
        let s = start_in(cfg.path(), Some(bad)).await;
        assert_eq!(s.port(), port, "KANBAN_PORT={bad:?}");
        s.stop().await;
    }
}

#[tokio::test]
async fn test_a_bad_saved_port_is_ignored() {
    if !skip_unless_available("test_a_bad_saved_port_is_ignored") {
        return;
    }
    let cfg = tempfile::tempdir().expect("temp dir");
    save(cfg.path(), json!({"port": "nope"}));
    let s = start_in(cfg.path(), None).await;
    assert_eq!(saved_port(cfg.path()), Some(json!(s.port())));
    s.stop().await;
}
