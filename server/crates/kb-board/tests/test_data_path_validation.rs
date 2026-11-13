//! `tests/test_data_path_validation.py`: `POST /settings/data-path` must only accept folders inside the user's home
//! directory.
//!
//! The route is in `api/settings.py`, which is not ported yet (it is not part of `api/data.py`, whose tests sit
//! beside this one). On the Rust server these tests report SKIPPED until `/settings/data-path` is served; on the
//! Python server they run. The Python test replaced `Path.home` in process; a server finds the home folder in `HOME`.

// Unix only: it starts shell scripts, makes files executable or links them (Windows CI only compiles the tests).
#![cfg(unix)]

use std::path::{Path, PathBuf};

use serde_json::json;
use testkit::{Client, Options, Server, Target, skip_unless_available, target};

/// A server whose home folder is `<tmp>/home`; returns it, the home folder and the temporary folder.
async fn start() -> (Server, PathBuf, tempfile::TempDir) {
    let tmp = tempfile::tempdir().unwrap();
    let home = tmp.path().join("home");
    std::fs::create_dir(&home).unwrap();
    let home = std::fs::canonicalize(home).unwrap();
    let s =
        Server::start_with(Options { env: vec![("HOME".into(), home.display().to_string())], ..Default::default() })
            .await;
    (s, home, tmp)
}

/// `_post`; None (after saying so) when the Rust server does not serve the route yet.
async fn post(c: &Client, path: &str) -> Option<testkit::Resp> {
    let r = c.post("/settings/data-path", json!({"path": path})).await;
    if target() == Target::Rust && (r.status == 404 || r.status == 405) {
        eprintln!("SKIPPED: the Rust server does not serve POST /settings/data-path yet (api/settings.py)");
        return None;
    }
    Some(r)
}

#[tokio::test]
async fn test_rejects_a_folder_outside_home() {
    if !skip_unless_available("test_rejects_a_folder_outside_home") {
        return;
    }
    let (s, _home, tmp) = start().await;
    let Some(r) = post(&s.client(), &tmp.path().join("elsewhere").display().to_string()).await else { return };
    assert_eq!(r.status, 400);
    assert!(r.detail().as_str().unwrap().contains("home directory"));
    assert_eq!(r.json(), json!({"detail": "Data folder must be within your home directory"}));
    assert!(!tmp.path().join("elsewhere").exists());
}

#[tokio::test]
async fn test_rejects_dot_dot_escape() {
    if !skip_unless_available("test_rejects_dot_dot_escape") {
        return;
    }
    let (s, home, tmp) = start().await;
    let escape: PathBuf = home.join("data").join("..").join("..").join("escaped");
    let Some(r) = post(&s.client(), &escape.display().to_string()).await else { return };
    assert_eq!(r.status, 400);
    assert!(!tmp.path().join("escaped").exists());
}

#[tokio::test]
async fn test_rejects_a_sibling_whose_name_starts_with_the_home_name() {
    if !skip_unless_available("test_rejects_a_sibling_whose_name_starts_with_the_home_name") {
        return;
    }
    let (s, home, _tmp) = start().await;
    let Some(r) = post(&s.client(), &format!("{}-other/data", home.display())).await else { return };
    assert_eq!(r.status, 400);
}

#[tokio::test]
async fn test_rejects_a_symlink_that_points_outside_home() {
    if !skip_unless_available("test_rejects_a_symlink_that_points_outside_home") {
        return;
    }
    let (s, home, tmp) = start().await;
    let outside = tmp.path().join("outside");
    std::fs::create_dir(&outside).unwrap();
    std::os::unix::fs::symlink(&outside, home.join("link")).unwrap();
    let Some(r) = post(&s.client(), &home.join("link").join("data").display().to_string()).await else { return };
    assert_eq!(r.status, 400);
    assert!(!Path::new(&outside).join("data").exists());
}

#[tokio::test]
async fn test_rejects_an_empty_path() {
    if !skip_unless_available("test_rejects_an_empty_path") {
        return;
    }
    let (s, _home, _tmp) = start().await;
    let Some(r) = post(&s.client(), "   ").await else { return };
    assert_eq!(r.status, 400);
    assert_eq!(r.json(), json!({"detail": "Path must not be empty"}));
}
