//! The Settings routes of `api/settings.py` that are not the MCP integrations: the data folder and its move
//! (`tests/test_data_path_validation.py` and a move that succeeds), the storage info, and the "Full control over MCP"
//! switch.
//!
//! Run against the Python server (`PARITY_TARGET=python`) and, by default, against this crate's router in the test
//! process over a temporary database (`kb-app` does not merge the Settings routes yet). `kb-board`'s own
//! `test_data_path_validation.rs` skips on the Rust server until `POST /settings/data-path` is served and runs on
//! `kanban-server` once the routes are merged.

mod common;

use std::time::Duration;

use common::Fixture;
use serde_json::{Value, json};
use sqlx::sqlite::SqliteConnectOptions;
use sqlx::{ConnectOptions, Connection, Row};

async fn post_path(fx: &Fixture, path: &str) -> common::Resp {
    fx.post("/settings/data-path", json!({"path": path})).await
}

// ---- tests/test_data_path_validation.py

#[tokio::test]
async fn test_rejects_a_folder_outside_home() {
    let fx = Fixture::with_db().await;
    let elsewhere = fx.tmp.path().join("elsewhere");
    let r = post_path(&fx, &elsewhere.display().to_string()).await;
    assert_eq!(r.status, 400);
    assert!(r.detail().as_str().unwrap().contains("home directory"));
    assert_eq!(r.json(), &json!({"detail": "Data folder must be within your home directory"}));
    assert!(!elsewhere.exists());
}

#[tokio::test]
async fn test_rejects_dot_dot_escape() {
    let fx = Fixture::with_db().await;
    let escape = fx.home.join("data").join("..").join("..").join("escaped");
    let r = post_path(&fx, &escape.display().to_string()).await;
    assert_eq!(r.status, 400);
    assert!(!fx.tmp.path().join("escaped").exists());
}

#[tokio::test]
async fn test_rejects_a_sibling_whose_name_starts_with_the_home_name() {
    let fx = Fixture::with_db().await;
    let r = post_path(&fx, &format!("{}-other/data", fx.home.display())).await;
    assert_eq!(r.status, 400);
}

#[cfg(unix)]
#[tokio::test]
async fn test_rejects_a_symlink_that_points_outside_home() {
    let fx = Fixture::with_db().await;
    let outside = fx.tmp.path().join("outside");
    std::fs::create_dir(&outside).unwrap();
    std::os::unix::fs::symlink(&outside, fx.home.join("link")).unwrap();
    let r = post_path(&fx, &fx.home.join("link").join("data").display().to_string()).await;
    assert_eq!(r.status, 400);
    assert!(!outside.join("data").exists());
}

#[tokio::test]
async fn test_rejects_an_empty_path() {
    let fx = Fixture::with_db().await;
    let r = post_path(&fx, "   ").await;
    assert_eq!(r.status, 400);
    assert_eq!(r.json(), &json!({"detail": "Path must not be empty"}));
}

#[tokio::test]
async fn test_a_body_without_a_path_is_422() {
    let fx = Fixture::with_db().await;
    let r = fx.post("/settings/data-path", json!({})).await;
    assert_eq!(r.status, 422);
}

// ---- the move itself

async fn tables_of(db: &std::path::Path) -> Vec<String> {
    let mut conn = SqliteConnectOptions::new()
        .filename(db)
        .read_only(true)
        .busy_timeout(Duration::from_secs(10))
        .disable_statement_logging()
        .connect()
        .await
        .unwrap_or_else(|e| panic!("open {}: {e}", db.display()));
    let rows = sqlx::query("SELECT name FROM sqlite_master WHERE type = 'table'").fetch_all(&mut conn).await.unwrap();
    let _ = conn.close().await;
    rows.iter().map(|r| r.get::<String, _>(0)).collect()
}

#[tokio::test]
async fn test_data_path_moves_the_database_and_uploads() {
    let fx = Fixture::with_schema().await;
    std::fs::create_dir_all(fx.uploads()).unwrap();
    std::fs::write(fx.uploads().join("a.txt"), "hello").unwrap();
    let old_db = fx.db_file();
    let before = fx.get("/settings", &[]).await;
    assert_eq!(before.status, 200);
    assert_eq!(before.json()["db_path"], json!(old_db.display().to_string()));
    assert_eq!(before.json()["data_folder"], json!(old_db.parent().unwrap().display().to_string()));
    assert_eq!(before.json()["uploads_dir"], json!(fx.uploads().display().to_string()));
    assert_eq!(before.json().as_object().unwrap().len(), 3);

    let dest = fx.home.join("moved");
    let r = post_path(&fx, &dest.display().to_string()).await;
    assert_eq!(r.status, 200, "{}", r.json());
    assert_eq!(
        r.json(),
        &json!({
            "db_path": dest.join("kanban.db").display().to_string(),
            "data_folder": dest.display().to_string(),
            "uploads_dir": dest.join("uploads").display().to_string(),
            "warning": "If you use VS Code MCP integration, restart the MCP server to pick up the new data path.",
        })
    );
    assert!(dest.join("kanban.db").is_file());
    assert!(!old_db.exists());
    assert_eq!(std::fs::read_to_string(dest.join("uploads").join("a.txt")).unwrap(), "hello");
    assert!(!fx.uploads().exists());
    // the board is still there after the move: its tables came with the file
    assert!(tables_of(&dest.join("kanban.db")).await.iter().any(|t| t == "project"));

    let after = fx.get("/settings", &[]).await;
    assert_eq!(after.json()["db_path"], json!(dest.join("kanban.db").display().to_string()));
    assert_eq!(after.json()["data_folder"], json!(dest.display().to_string()));
    assert_eq!(after.json()["uploads_dir"], json!(dest.join("uploads").display().to_string()));
    if fx.is_remote() {
        let projects = fx.get("/projects", &[]).await;
        assert_eq!((projects.status, projects.json().clone()), (200, json!([])));
    } else {
        assert_eq!(kb_db::database::get_db_path(), dest.join("kanban.db"));
    }
}

#[tokio::test]
async fn test_data_path_refuses_a_folder_that_holds_a_database() {
    let fx = Fixture::with_schema().await;
    let taken = fx.folder("taken");
    std::fs::write(taken.join("kanban.db"), "x").unwrap();
    let r = post_path(&fx, &taken.display().to_string()).await;
    assert_eq!(r.status, 409);
    assert_eq!(
        r.json(),
        &json!({"detail": format!("A database already exists at {}. Remove it first or choose a different folder.", taken.join("kanban.db").display())})
    );
    assert_eq!(std::fs::read_to_string(taken.join("kanban.db")).unwrap(), "x");
    // an empty file is not a database: the move goes ahead over it
    std::fs::write(taken.join("kanban.db"), "").unwrap();
    let r = post_path(&fx, &taken.display().to_string()).await;
    assert_eq!(r.status, 200, "{}", r.json());
}

#[tokio::test]
async fn test_data_path_merges_uploads_into_a_folder_that_exists() {
    let fx = Fixture::with_schema().await;
    std::fs::create_dir_all(fx.uploads().join("sub")).unwrap();
    std::fs::write(fx.uploads().join("a.txt"), "a").unwrap();
    std::fs::write(fx.uploads().join("sub").join("b.txt"), "b").unwrap();
    let dest = fx.folder("merge");
    std::fs::create_dir_all(dest.join("uploads")).unwrap();
    std::fs::write(dest.join("uploads").join("keep.txt"), "k").unwrap();
    let r = post_path(&fx, &dest.display().to_string()).await;
    assert_eq!(r.status, 200, "{}", r.json());
    let moved = dest.join("uploads");
    assert_eq!(std::fs::read_to_string(moved.join("keep.txt")).unwrap(), "k");
    assert_eq!(std::fs::read_to_string(moved.join("a.txt")).unwrap(), "a");
    assert_eq!(std::fs::read_to_string(moved.join("sub").join("b.txt")).unwrap(), "b");
    assert!(!fx.uploads().exists());
}

// ---- storage info and the MCP switch

#[tokio::test]
async fn test_get_settings_lists_the_data_folder_and_uploads() {
    let fx = Fixture::with_db().await;
    let r = fx.get("/settings", &[]).await;
    assert_eq!(r.status, 200);
    assert_eq!(
        r.json(),
        &json!({
            "db_path": fx.db_file().display().to_string(),
            "data_folder": fx.db_file().parent().unwrap().display().to_string(),
            "uploads_dir": fx.uploads().display().to_string(),
        })
    );
}

#[tokio::test]
async fn test_mcp_control_needs_the_risks_accepted_to_turn_on() {
    let fx = Fixture::without_claude().await;
    fx.post("/settings/mcp-control", json!({"enabled": false})).await;
    for body in [json!({"enabled": true}), json!({"enabled": true, "accept_risks": false})] {
        let r = fx.post("/settings/mcp-control", body).await;
        assert_eq!(r.status, 400);
        assert_eq!(r.json(), &json!({"detail": "Confirm that you accept the risks to turn on full control over MCP."}));
    }
    assert_eq!(fx.get("/settings/mcp-control", &[]).await.json(), &json!({"enabled": false}));
    let r = fx.post("/settings/mcp-control", json!({"accept_risks": true})).await;
    assert_eq!(r.status, 422);
}

#[tokio::test]
async fn test_mcp_control_turns_on_and_off() {
    let fx = Fixture::without_claude().await;
    let r = fx.post("/settings/mcp-control", json!({"enabled": true, "accept_risks": true})).await;
    assert_eq!((r.status, r.json().clone()), (200, json!({"enabled": true})));
    assert_eq!(fx.get("/settings/mcp-control", &[]).await.json(), &json!({"enabled": true}));
    // turning it off needs no confirmation
    let r = fx.post("/settings/mcp-control", json!({"enabled": false})).await;
    assert_eq!((r.status, r.json().clone()), (200, json!({"enabled": false})));
    assert_eq!(fx.get("/settings/mcp-control", &[]).await.json(), &json!({"enabled": false}));
}

#[tokio::test]
async fn test_the_route_table_is_the_python_one() {
    // `kb-app` merges these at the position of `settings_router` in `main.py`
    let (_, table) = kb_skills::api::routes().into_parts();
    let table: Vec<String> = table.into_iter().map(|(m, p)| format!("{m} {p}")).collect();
    assert_eq!(
        table,
        vec![
            "GET /settings",
            "GET /settings/mcp-control",
            "POST /settings/mcp-control",
            "POST /settings/data-path",
            "GET /settings/mcp-clients/{client_id}",
            "POST /settings/mcp-clients/{client_id}/install",
            "POST /settings/mcp-clients/{client_id}/remove",
            "POST /settings/mcp-clients/{client_id}/test",
            "POST /settings/mcp-clients/{client_id}/open-file",
        ]
    );
    let _ = Value::Null;
}
