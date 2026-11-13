//! Tests of the harness itself. Run with `PARITY_TARGET=python`.

use serde_json::json;
use std::time::Duration;
use testkit::{Options, Server, skip_unless_available};

fn project(name: &str, prefix: &str) -> serde_json::Value {
    json!({"name": name, "prefix": prefix, "color": "#336699"})
}

#[tokio::test]
async fn health_version_and_projects() {
    if !skip_unless_available("health_version_and_projects") {
        return;
    }
    let s = Server::start().await;
    let c = s.client();
    let h = c.get("/health").await;
    h.assert_status(200);
    assert_eq!(h.json(), json!({"status": "ok"}));
    let v = c.get("/version").await;
    v.assert_status(200);
    assert!(v.json().get("version").is_some(), "{}", v.text());

    let created = c.post("/projects", project("Alpha", "ALP")).await;
    created.assert_status(201);
    let id = created.json()["id"].as_str().expect("id").to_string();
    let read = c.get(&format!("/projects/{id}")).await;
    read.assert_status(200);
    assert_eq!(read.json()["name"], "Alpha");
    s.stop().await;
}

#[tokio::test]
async fn mcp_tools_and_get_projects() {
    if !skip_unless_available("mcp_tools_and_get_projects") {
        return;
    }
    let s = Server::start().await;
    let c = s.client();
    c.post("/projects", project("Alpha", "ALP")).await.assert_status(201);
    let mcp = s.mcp();
    mcp.initialize().await;
    let tools = mcp.list_tools().await;
    assert_eq!(tools["tools"].as_array().expect("tools").len(), 13, "{tools}");
    let r = mcp.call_tool("get_projects", json!({})).await;
    assert!(!r.is_error, "{}", r.text);
    assert!(r.text.contains("Alpha"), "{}", r.text);
}

#[tokio::test]
async fn sse_invalidate_and_dump_db() {
    if !skip_unless_available("sse_invalidate_and_dump_db") {
        return;
    }
    let s = Server::start().await;
    let c = s.client();
    c.post("/projects", project("Alpha", "ALP")).await.assert_status(201);
    let mut ev = s.events().await;
    c.post("/projects", project("Beta", "BET")).await.assert_status(201);
    let mut seen = Vec::new();
    while let Some(e) = ev.next(Duration::from_secs(5)).await {
        seen.push(e.clone());
        if e.contains("invalidate") {
            break;
        }
    }
    assert!(seen.iter().any(|e| e.contains("invalidate")), "events: {seen:?}");
    let dump = s.dump_db().await;
    let rows = dump["project"].as_array().expect("project table");
    assert_eq!(rows.len(), 2, "{dump}");
    let names: Vec<_> = rows.iter().map(|r| r["name"].as_str().unwrap_or("")).collect();
    assert!(names.contains(&"Alpha") && names.contains(&"Beta"));
}

#[tokio::test]
async fn secret_is_required_for_changes() {
    if !skip_unless_available("secret_is_required_for_changes") {
        return;
    }
    let s = Server::start_with(Options { secret: Some("s3cret-value".into()), ..Options::default() }).await;
    let bare = s.client_without_secret();
    let denied = bare.post("/projects", project("Alpha", "ALP")).await;
    assert_eq!(denied.status, 403, "{}", denied.text());
    s.client().post("/projects", project("Alpha", "ALP")).await.assert_status(201);
    bare.get("/projects").await.assert_status(200);
}

#[tokio::test]
async fn two_servers_and_cleanup() {
    if !skip_unless_available("two_servers_and_cleanup") {
        return;
    }
    let (a, b) = tokio::join!(Server::start(), Server::start());
    assert_ne!(a.port(), b.port());
    assert_ne!(a.dir(), b.dir());
    a.client().post("/projects", project("Only A", "OAA")).await.assert_status(201);
    let in_b = b.client().get("/projects").await.json();
    assert_eq!(in_b.as_array().expect("list").len(), 0, "{in_b}");
    let (pa, pb) = (a.pid(), b.pid());
    let (da, db) = (a.dir().to_path_buf(), b.dir().to_path_buf());
    a.stop().await;
    drop(b);
    for (pid, dir) in [(pa, da), (pb, db)] {
        assert!(!std::path::Path::new(&format!("/proc/{pid}")).exists(), "process {pid} remains");
        assert!(!dir.exists(), "{} remains", dir.display());
    }
}
