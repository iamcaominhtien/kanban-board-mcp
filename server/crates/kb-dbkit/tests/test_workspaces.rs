//! Workspaces (`/workspaces`): several boards on one computer and the switch between them, on a real server.

use serde_json::{Value, json};
use testkit::{Client, Options, Server, skip_unless_available};

/// A server whose home folder is `<tmp>/home` (a workspace folder must be inside it).
async fn start() -> (Server, std::path::PathBuf, tempfile::TempDir) {
    let tmp = tempfile::tempdir().unwrap();
    let home = tmp.path().join("home");
    std::fs::create_dir(&home).unwrap();
    let home = std::fs::canonicalize(home).unwrap();
    let env = vec![("HOME".into(), home.display().to_string())];
    let server = Server::start_with(Options { env, ..Default::default() }).await;
    (server, home, tmp)
}

async fn overview(c: &Client) -> Value {
    let r = c.get("/workspaces").await;
    assert_eq!(r.status, 200, "{}", r.text());
    r.json()
}

fn id_of(overview: &Value, name: &str) -> String {
    overview["items"]
        .as_array()
        .unwrap()
        .iter()
        .find(|item| item["name"] == name)
        .unwrap_or_else(|| panic!("no workspace {name} in {overview}"))["id"]
        .as_str()
        .unwrap()
        .to_string()
}

async fn project_names(c: &Client) -> Vec<String> {
    let r = c.get("/projects").await;
    assert_eq!(r.status, 200);
    r.json().as_array().unwrap().iter().map(|p| p["name"].as_str().unwrap().to_string()).collect()
}

#[tokio::test]
async fn test_lists_the_board_in_use_before_any_workspace_is_added() {
    if !skip_unless_available("test_lists_the_board_in_use_before_any_workspace_is_added") {
        return;
    }
    let (s, _home, _tmp) = start().await;
    let o = overview(&s.client()).await;
    let items = o["items"].as_array().unwrap();
    assert_eq!(items.len(), 1);
    assert_eq!(items[0]["name"], "Default");
    assert_eq!(items[0]["active"], true);
    assert_eq!(items[0]["id"], "current");
    assert_eq!(o["active_id"], "current");
    assert_eq!(o["switchable"], true);
}

#[tokio::test]
async fn test_add_checks_the_name_and_the_folder() {
    if !skip_unless_available("test_add_checks_the_name_and_the_folder") {
        return;
    }
    let (s, home, tmp) = start().await;
    let c = s.client();
    let r = c.post("/workspaces", json!({"name": "Office"})).await;
    assert_eq!(r.status, 200, "{}", r.text());
    assert_eq!(r.json()["active"], false);
    assert!(std::path::Path::new(r.json()["folder"].as_str().unwrap()).is_dir());

    assert_eq!(c.post("/workspaces", json!({"name": "office"})).await.status, 409, "names are unique, any case");
    assert_eq!(c.post("/workspaces", json!({"name": "  "})).await.status, 400);
    let outside = tmp.path().join("elsewhere").display().to_string();
    let r = c.post("/workspaces", json!({"name": "Away", "folder": outside})).await;
    assert_eq!(r.status, 400);
    assert_eq!(r.json(), json!({"detail": "Workspace folder must be within your home directory"}));
    let inside = home.join("home-board").display().to_string();
    let r = c.post("/workspaces", json!({"name": "Home", "folder": inside})).await;
    assert_eq!(r.status, 200, "{}", r.text());
    let again = c.post("/workspaces", json!({"name": "Home again", "folder": inside})).await;
    assert_eq!(again.status, 409, "one folder, one workspace");

    // the folder in use got its entry when the first workspace was added, so the way back is kept
    let o = overview(&c).await;
    assert_eq!(o["items"].as_array().unwrap().len(), 3);
    assert_ne!(id_of(&o, "Default"), "current");
}

#[tokio::test]
async fn test_switch_shows_the_other_board_and_back() {
    if !skip_unless_available("test_switch_shows_the_other_board_and_back") {
        return;
    }
    let (s, _home, _tmp) = start().await;
    let c = s.client();
    let made = c.post("/projects", json!({"name": "Office project", "prefix": "OFF", "color": "#0a0"})).await;
    assert_eq!(made.status, 201, "{}", made.text());
    assert_eq!(c.post("/workspaces", json!({"name": "Home"})).await.status, 200);
    let o = overview(&c).await;
    let (office, home) = (id_of(&o, "Default"), id_of(&o, "Home"));

    let r = c.post_empty(&format!("/workspaces/{home}/switch")).await;
    assert_eq!(r.status, 200, "{}", r.text());
    assert_eq!(r.json()["active_id"], json!(home));
    assert!(project_names(&c).await.is_empty(), "the new board starts empty");
    let made = c.post("/projects", json!({"name": "Home project", "prefix": "HOM", "color": "#a00"})).await;
    assert_eq!(made.status, 201, "{}", made.text());
    assert_eq!(project_names(&c).await, vec!["Home project"]);

    let r = c.post_empty(&format!("/workspaces/{office}/switch")).await;
    assert_eq!(r.status, 200, "{}", r.text());
    assert_eq!(project_names(&c).await, vec!["Office project"]);

    // the choice is kept for the next start and for the MCP processes of editors
    let config = std::fs::read_to_string(s.config_dir().join("config.json")).unwrap();
    assert!(config.contains("\"data_folder\""), "{config}");
    // switching to the board already in use changes nothing
    assert_eq!(c.post_empty(&format!("/workspaces/{office}/switch")).await.status, 200);
    assert_eq!(c.post_empty("/workspaces/nope/switch").await.status, 404);
}

#[tokio::test]
async fn test_rename_and_remove() {
    if !skip_unless_available("test_rename_and_remove") {
        return;
    }
    let (s, _home, _tmp) = start().await;
    let c = s.client();
    let made = c.post("/workspaces", json!({"name": "Home"})).await.json();
    let folder = std::path::PathBuf::from(made["folder"].as_str().unwrap());
    let id = made["id"].as_str().unwrap();

    let r = c.patch(&format!("/workspaces/{id}"), json!({"name": "Default"})).await;
    assert_eq!(r.status, 409, "{}", r.text());
    let r = c.patch(&format!("/workspaces/{id}"), json!({"name": "Cottage"})).await;
    assert_eq!(r.status, 200);
    assert_eq!(r.json()["name"], "Cottage");

    // the one in use cannot be removed
    let o = overview(&c).await;
    let r = c.delete(&format!("/workspaces/{}", id_of(&o, "Default"))).await;
    assert_eq!(r.status, 400, "{}", r.text());

    let r = c.delete(&format!("/workspaces/{id}")).await;
    assert_eq!(r.status, 200, "{}", r.text());
    assert_eq!(r.json()["items"].as_array().unwrap().len(), 1);
    assert!(folder.is_dir(), "removing forgets the entry and leaves the data alone");
    assert_eq!(c.delete(&format!("/workspaces/{id}")).await.status, 404);
}

#[tokio::test]
async fn test_a_folder_with_a_newer_database_is_refused_and_the_board_stays() {
    if !skip_unless_available("test_a_folder_with_a_newer_database_is_refused_and_the_board_stays") {
        return;
    }
    let (s, home, _tmp) = start().await;
    let c = s.client();
    let made = c.post("/projects", json!({"name": "Stays", "prefix": "STY", "color": "#0a0"})).await;
    assert_eq!(made.status, 201);
    // a file that is some other program's database
    let folder = home.join("foreign");
    std::fs::create_dir_all(&folder).unwrap();
    std::fs::write(folder.join("kanban.db"), b"this is not a database").unwrap();
    let r = c.post("/workspaces", json!({"name": "Foreign", "folder": folder.display().to_string()})).await;
    assert_eq!(r.status, 200, "{}", r.text());
    let id = r.json()["id"].as_str().unwrap().to_string();

    let r = c.post_empty(&format!("/workspaces/{id}/switch")).await;
    assert_eq!(r.status, 500, "{}", r.text());
    // the board in use works as before
    assert_eq!(project_names(&c).await, vec!["Stays"]);
    let o = overview(&c).await;
    assert_eq!(o["items"].as_array().unwrap().iter().filter(|i| i["active"] == true).count(), 1);
    assert_eq!(id_of(&o, "Default"), o["active_id"].as_str().unwrap());
}
