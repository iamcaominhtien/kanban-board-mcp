//! Port of `server/tests/test_version.py`.

mod common;

use common::*;
use testkit::{Options, Server, Target, skip_unless_available, target};

fn tuple(version: &str) -> Vec<u64> {
    version.split('.').map(|part| part.parse().expect("number")).collect()
}

async fn version_of(server: &Server) -> serde_json::Value {
    let r = get(server, "/version").await;
    assert_eq!(r.status, 200);
    r.json()
}

#[tokio::test]
async fn test_version_endpoint_reports_versions() {
    if !skip_unless_available("test_version_endpoint_reports_versions") {
        return;
    }
    let s = Server::start().await;
    let body = version_of(&s).await;
    let mut keys: Vec<&str> = body.as_object().expect("object").keys().map(String::as_str).collect();
    keys.sort_unstable();
    assert_eq!(keys, ["latest", "min_supported_version", "version"]);
    assert_eq!(body["version"], body["latest"]);
    // `version.APP_VERSION` of the server under test
    let app_version = match target() {
        Target::Python => {
            let text = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/../../../server/version.py"))
                .expect("version.py");
            let line = text.lines().find(|l| l.starts_with("APP_VERSION")).expect("APP_VERSION");
            line.split('"').nth(1).expect("quoted version").to_string()
        }
        Target::Rust => kb_base::version::APP_VERSION.to_string(),
    };
    assert_eq!(body["version"], app_version.as_str());
    s.stop().await;
}

#[tokio::test]
async fn test_min_supported_is_not_newer_than_the_server() {
    if !skip_unless_available("test_min_supported_is_not_newer_than_the_server") {
        return;
    }
    let s = Server::start().await;
    let body = version_of(&s).await;
    assert!(
        tuple(body["min_supported_version"].as_str().expect("min"))
            <= tuple(body["version"].as_str().expect("version"))
    );
    s.stop().await;
}

#[tokio::test]
async fn test_min_supported_version_can_be_overridden() {
    if !skip_unless_available("test_min_supported_version_can_be_overridden") {
        return;
    }
    let s = Server::start_with(Options {
        env: vec![("KANBAN_MIN_UI_VERSION".into(), "9.9.9".into())],
        ..Options::default()
    })
    .await;
    assert_eq!(version_of(&s).await["min_supported_version"], "9.9.9");
    s.stop().await;
}

/// The desktop and UI packages carry the server's version. The Rust server is 5.0.0 and the packages still say the
/// Python server's version until the switch (P7 of the plan bumps them), so against Rust the packages are only
/// compared with the Python server's `version.py`, which they must still match.
#[tokio::test]
async fn test_server_version_matches_the_desktop_and_ui_packages() {
    if !skip_unless_available("test_server_version_matches_the_desktop_and_ui_packages") {
        return;
    }
    let s = Server::start().await;
    let body = version_of(&s).await;
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..");
    let py = std::fs::read_to_string(root.join("server/version.py")).expect("version.py");
    let python_version = py
        .lines()
        .find(|l| l.starts_with("APP_VERSION"))
        .and_then(|l| l.split('"').nth(1))
        .expect("version")
        .to_string();
    for package in ["desktop", "ui"] {
        let text = std::fs::read_to_string(root.join(package).join("package.json")).expect("package.json");
        let pkg: serde_json::Value = serde_json::from_str(&text).expect("json");
        let expected = if target() == Target::Python {
            body["version"].as_str().expect("version")
        } else {
            python_version.as_str()
        };
        assert_eq!(pkg["version"], expected, "{package}/package.json is out of sync with server/version.py");
    }
    s.stop().await;
}
