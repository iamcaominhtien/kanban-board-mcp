//! Canvas tools through `docs_write`: a Docs page owner named `page`, resizing a frame by updating it with a
//! frame.json, and deleting (and restoring) a canvas.

mod common;

use common::{call, call_err};
use serde_json::{Value, json};

const FRAME: &str = "<!doctype html><meta name='viewport' content='width=device-width'><h1>Hello</h1>";

async fn write(mcp: &testkit::Mcp, action: &str, rest: Value) -> Value {
    let mut arguments = json!({"action": action});
    for (key, value) in rest.as_object().expect("an object") {
        arguments[key] = value.clone();
    }
    call(mcp, "docs_write", arguments).await
}

async fn read(mcp: &testkit::Mcp, action: &str, rest: Value) -> Value {
    let mut arguments = json!({"action": action});
    for (key, value) in rest.as_object().expect("an object") {
        arguments[key] = value.clone();
    }
    call(mcp, "docs_read", arguments).await
}

/// A project with a Docs page and a canvas on it (made with the owner kind given), from one frame folder.
async fn canvas_on_page(s: &testkit::Server, dir: &std::path::Path, kind: &str) -> (Value, Value, Value) {
    let mcp = s.mcp();
    let made = s.client().post("/projects", json!({"name": "Kanban", "prefix": "KAN", "color": "#0a0"})).await;
    made.assert_status(201);
    let pid = made.json()["id"].clone();
    let page =
        write(&mcp, "create", json!({"project_id": pid, "title": "Screens", "markdown": "## Home\n\ntext"})).await;
    let frame = dir.join("canvas/01-home");
    std::fs::create_dir_all(&frame).expect("a folder");
    std::fs::write(frame.join("index.html"), FRAME).expect("a file");
    let cv = write(
        &mcp,
        "canvas_create",
        json!({"path": dir.join("canvas").to_string_lossy(), "owner_kind": kind, "owner_id": page["id"], "title": "Home"}),
    )
    .await;
    (pid, page, cv)
}

#[tokio::test]
async fn test_a_canvas_can_belong_to_a_page() {
    let s = common::start().await;
    let dir = tempfile::tempdir().expect("a folder");
    let (pid, page, cv) = canvas_on_page(&s, dir.path(), "page").await;
    assert_eq!(cv["boards"].as_array().expect("boards").len(), 1);
    let listed = read(&s.mcp(), "canvases", json!({"project_id": pid})).await;
    let first =
        &listed.as_array().cloned().unwrap_or_else(|| listed["canvases"].as_array().cloned().expect("a list"))[0];
    assert_eq!(first["owner_kind"], "doc");
    assert_eq!(first["owner_id"], page["id"]);
}

#[tokio::test]
async fn test_updating_a_frame_with_a_new_frame_json_resizes_it() {
    let s = common::start().await;
    let dir = tempfile::tempdir().expect("a folder");
    let (_, _, cv) = canvas_on_page(&s, dir.path(), "doc").await;
    let board = cv["boards"][0].clone();
    assert_eq!((board["w"].as_f64(), board["h"].as_f64()), (Some(1280.0), Some(800.0)));
    let frame = dir.path().join("canvas/01-home");
    std::fs::write(frame.join("frame.json"), r#"{"size": [390, 844], "name": "Home phone"}"#).expect("a file");
    let out = write(
        &s.mcp(),
        "canvas_update",
        json!({"canvas_id": cv["id"], "board_id": board["id"], "path": frame.to_string_lossy()}),
    )
    .await;
    assert_eq!(out["name"], "Home phone");
    let seen = read(&s.mcp(), "canvas", json!({"canvas_id": cv["id"]})).await;
    let boards = seen["boards"].as_array().expect("boards");
    assert_eq!((boards[0]["width"].as_f64(), boards[0]["height"].as_f64()), (Some(390.0), Some(844.0)));
    assert_eq!(boards[0]["name"], "Home phone");
    // a preset name works too, and a frame.json without a size leaves the size alone
    std::fs::write(frame.join("frame.json"), r#"{"size": "tablet"}"#).expect("a file");
    write(
        &s.mcp(),
        "canvas_update",
        json!({"canvas_id": cv["id"], "board_id": board["id"], "path": frame.to_string_lossy()}),
    )
    .await;
    std::fs::write(frame.join("frame.json"), "{}").expect("a file");
    write(
        &s.mcp(),
        "canvas_update",
        json!({"canvas_id": cv["id"], "board_id": board["id"], "path": frame.to_string_lossy()}),
    )
    .await;
    let seen = read(&s.mcp(), "canvas", json!({"canvas_id": cv["id"]})).await;
    assert_eq!(
        seen["boards"][0]["width"].as_f64(),
        Some(kb_draw::canvases::size_preset("tablet").expect("preset").0 as f64)
    );
}

#[tokio::test]
async fn test_a_canvas_can_be_deleted_and_restored() {
    let s = common::start().await;
    let dir = tempfile::tempdir().expect("a folder");
    let (pid, _, cv) = canvas_on_page(&s, dir.path(), "doc").await;
    let out = write(&s.mcp(), "canvas_delete", json!({"canvas_id": cv["id"]})).await;
    assert_eq!(out["id"], cv["id"]);
    let gone = call_err(&s.mcp(), "docs_read", json!({"action": "canvas", "canvas_id": cv["id"]})).await;
    assert!(gone.contains("Canvas not found"), "{gone}");
    let again = call_err(&s.mcp(), "docs_write", json!({"action": "canvas_delete", "canvas_id": cv["id"]})).await;
    assert!(again.contains("Canvas not found"), "{again}");
    let listed = read(&s.mcp(), "canvases", json!({"project_id": pid})).await;
    assert!(!listed.to_string().contains(cv["id"].as_str().expect("an id")));
    let back = write(&s.mcp(), "canvas_restore", json!({"canvas_id": cv["id"]})).await;
    assert_eq!(back["id"], cv["id"]);
    read(&s.mcp(), "canvas", json!({"canvas_id": cv["id"]})).await;
}
