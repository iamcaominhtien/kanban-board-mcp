//! The functions of `services/workspace.py` that no route calls (the MCP tools and the ticket code do), and the
//! sweep loop, in one process with its own database and folders. Stands for the MCP-side checks of
//! `tests/test_workspace.py::test_mcp_tool_returns_path_and_creates_folder`, whose tools are not ported yet.

use std::time::Duration;

use kb_board::workspace::{self, Error};
use kb_db::database;
use kb_db::entities::ticket;
use kb_db::sea_orm::ActiveModelTrait;
use kb_db::sea_orm::ActiveValue::Set;
use serde_json::json;

async fn add_ticket(id: &str, status: &str) {
    let session = database::session();
    let mut row = ticket::new();
    row.id = Set(id.to_string());
    row.project_id = Set("p1".to_string());
    row.title = Set("t".to_string());
    row.status = Set(status.to_string());
    row.insert(&session).await.unwrap();
    session.commit().await.unwrap();
}

fn set_mtime(path: &std::path::Path, secs: u64) {
    let when = std::time::UNIX_EPOCH + Duration::from_secs(secs);
    std::fs::File::open(path).unwrap().set_modified(when).unwrap();
}

#[tokio::test]
#[allow(unsafe_code)]
async fn the_service_functions_the_tools_call() {
    let dir = tempfile::tempdir().unwrap();
    // This test is the only one in its process; the folders are set before anything reads them.
    unsafe {
        std::env::set_var("KANBAN_CONFIG_DIR", dir.path().join("config"));
        std::env::set_var("KANBAN_DB_PATH", dir.path().join("data").join("kanban.db"));
        std::env::set_var("KANBAN_WORKSPACE_ROOT", dir.path().join("default-root"));
        std::env::remove_var("KANBAN_DATABASE_URL");
    }
    database::setup().await.unwrap();
    database::init_db().await.unwrap();
    let session = database::session();
    let root = dir.path().join("root");
    let shown = |id: &str| root.join(id).to_string_lossy().into_owned();

    // the settings row is made on first use, with the root the environment names
    let settings = workspace::get_workspace_settings(&session).await.unwrap();
    assert_eq!(
        (settings.id, settings.enabled, settings.root_path.clone(), settings.default_retention_days),
        (1, true, dir.path().join("default-root").to_string_lossy().into_owned(), Some(14))
    );
    workspace::update_workspace_settings(&session, None, Some(&format!(" {} ", root.display())), None).await.unwrap();
    assert_eq!(workspace::get_workspace_settings(&session).await.unwrap().root_path, root.to_string_lossy());

    add_ticket("WS-1", "todo").await;
    add_ticket("WS-2", "todo").await;
    add_ticket("a.b", "todo").await;

    // get_workspace_path: the tool answers `{enabled, path, exists}` and makes the folder
    let info = workspace::get_workspace_path(&session, "WS-1", true).await.unwrap();
    assert_eq!(info, Some(json!({"enabled": true, "path": shown("WS-1"), "exists": true})));
    assert!(root.join("WS-1").is_dir());
    let info = workspace::get_workspace_path(&session, "WS-2", false).await.unwrap();
    assert_eq!(info, Some(json!({"enabled": true, "path": shown("WS-2"), "exists": false})));
    assert!(!root.join("WS-2").exists());
    assert_eq!(workspace::get_workspace_path(&session, "NOPE-1", true).await.unwrap(), None);
    assert_eq!(workspace::get_workspace_path(&session, "../etc", true).await.unwrap(), None);
    match workspace::get_workspace_path(&session, "a.b", true).await {
        Err(Error::Workspace(message)) => assert_eq!(message, "Invalid ticket id: 'a.b'"),
        other => panic!("{other:?}"),
    }

    // brief: nothing is created, files come newest first, at most `limit`
    let brief = workspace::brief(&session, "WS-2", 20).await.unwrap().unwrap();
    assert_eq!(
        brief,
        json!({"path": shown("WS-2"), "exists": false,
               "note": "Not created yet: nothing is in it. manage_ticket(action='workspace') creates it."})
    );
    assert!(!root.join("WS-2").exists());
    let brief = workspace::brief(&session, "WS-1", 20).await.unwrap().unwrap();
    assert_eq!(
        brief,
        json!({"path": shown("WS-1"), "exists": true, "file_count": 0, "files": [],
               "note": "Empty: the folder exists, nothing has been written to it."})
    );
    for (name, secs) in [("old.txt", 1_700_000_000), ("new.txt", 1_700_000_300), ("mid.txt", 1_700_000_100)] {
        std::fs::write(root.join("WS-1").join(name), name).unwrap();
        set_mtime(&root.join("WS-1").join(name), secs);
    }
    std::fs::create_dir(root.join("WS-1").join("dir")).unwrap();
    let brief = workspace::brief(&session, "WS-1", 2).await.unwrap().unwrap();
    assert_eq!(brief, json!({"path": shown("WS-1"), "exists": true, "file_count": 3, "files": ["new.txt", "mid.txt"]}));
    assert_eq!(workspace::brief(&session, "a.b", 20).await.unwrap(), None);

    // transfer_workspace
    assert_eq!(workspace::transfer_workspace(&session, "WS-1", "WS-2", "leave").await.unwrap(), "left");
    assert!(matches!(
        workspace::transfer_workspace(&session, "WS-1", "WS-2", "swap").await,
        Err(Error::Workspace(message)) if message == "mode must be move, copy or leave"
    ));
    assert_eq!(workspace::transfer_workspace(&session, "WS-2", "WS-1", "copy").await.unwrap(), "none");
    assert_eq!(workspace::transfer_workspace(&session, "WS-1", "WS-2", "copy").await.unwrap(), "copied");
    assert!(root.join("WS-1").join("new.txt").exists() && root.join("WS-2").join("new.txt").exists());
    assert_eq!(workspace::transfer_workspace(&session, "WS-1", "WS-2", "move").await.unwrap(), "moved");
    assert!(!root.join("WS-1").exists());
    assert_eq!(std::fs::read_to_string(root.join("WS-2").join("mid.txt")).unwrap(), "mid.txt");

    // remove_ticket_workspace never fails: a folder goes, a missing one and an odd id are left alone
    workspace::remove_ticket_workspace(&session, "WS-2").await;
    assert!(!root.join("WS-2").exists());
    workspace::remove_ticket_workspace(&session, "WS-2").await;
    workspace::remove_ticket_workspace(&session, "../etc").await;

    // disabled: no path is made, nothing is brought, nothing is moved
    workspace::update_workspace_settings(&session, Some(false), None, None).await.unwrap();
    let info = workspace::get_workspace_path(&session, "WS-1", true).await.unwrap();
    assert_eq!(info, Some(json!({"enabled": false, "path": shown("WS-1"), "exists": false})));
    assert_eq!(workspace::brief(&session, "WS-1", 20).await.unwrap(), None);
    assert_eq!(workspace::transfer_workspace(&session, "WS-1", "WS-2", "move").await.unwrap(), "none");
    assert!(workspace::sweep_expired(&session, false).await.unwrap().is_empty());
    workspace::update_workspace_settings(&session, Some(true), None, Some(7)).await.unwrap();

    // the sweep loop sweeps once as it starts: a closed ticket idle past its days goes, an open one stays
    add_ticket("WS-3", "done").await;
    add_ticket("WS-4", "todo").await;
    for id in ["WS-3", "WS-4"] {
        std::fs::create_dir_all(root.join(id)).unwrap();
        std::fs::write(root.join(id).join("f.txt"), "x").unwrap();
        set_mtime(&root.join(id).join("f.txt"), 1_700_000_000);
        set_mtime(&root.join(id), 1_700_000_000);
    }
    let looping = tokio::spawn(workspace::sweep_loop());
    let mut gone = false;
    for _ in 0..100 {
        if !root.join("WS-3").exists() {
            gone = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    looping.abort();
    assert!(gone, "the loop sweeps as it starts");
    assert!(root.join("WS-4").exists());
}
