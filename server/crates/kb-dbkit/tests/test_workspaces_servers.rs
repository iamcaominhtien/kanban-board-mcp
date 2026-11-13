//! Workspaces on a database server: a board on PostgreSQL or MySQL/MariaDB next to a SQLite one, and the switch between
//! them, on a real server program. Each engine is skipped unless its URL is set: `KANBAN_TEST_POSTGRES_URL`,
//! `KANBAN_TEST_MYSQL_URL` (`server/scripts/dev-databases.sh start`).

mod common;

use std::time::Duration;

use serde_json::{Value, json};
use testkit::{Client, Options, Server, skip_unless_available};

/// Which server engine a test runs on.
#[derive(Clone, Copy)]
struct Engine {
    /// The variable that holds the URL of a database of the test server.
    var: &'static str,
    /// What `GET /database` and the workspace list call it.
    name: &'static str,
    /// A URL nothing listens at.
    nowhere: &'static str,
}

const POSTGRES: Engine =
    Engine { var: "KANBAN_TEST_POSTGRES_URL", name: "postgresql", nowhere: "postgresql://kanban@127.0.0.1:1/none" };
const MYSQL: Engine =
    Engine { var: "KANBAN_TEST_MYSQL_URL", name: "mysql", nowhere: "mysql://kanban:kanban@127.0.0.1:1/none" };

/// A database of this engine for one test, emptied; `None` (after saying so) when the engine's URL is not set.
async fn own_database(test: &str, engine: Engine, database: &str) -> Option<String> {
    let Ok(base) = std::env::var(engine.var) else {
        println!("SKIPPED {test}: {} is not set", engine.var);
        return None;
    };
    let url = common::own_database(&base, database).await;
    common::wipe(&url).await;
    Some(url)
}

/// A server whose home folder is `<tmp>/home` (a workspace folder must be inside it).
async fn start(env: Vec<(String, String)>) -> (Server, tempfile::TempDir) {
    let tmp = tempfile::tempdir().unwrap();
    let home = tmp.path().join("home");
    std::fs::create_dir(&home).unwrap();
    let mut all = vec![("HOME".to_string(), std::fs::canonicalize(home).unwrap().display().to_string())];
    all.extend(env);
    (Server::start_with(Options { env: all, ..Default::default() }).await, tmp)
}

async fn overview(c: &Client) -> Value {
    let r = c.get("/workspaces").await;
    assert_eq!(r.status, 200, "{}", r.text());
    r.json()
}

fn id_of(overview: &Value, name: &str) -> String {
    overview["items"].as_array().unwrap().iter().find(|i| i["name"] == name).unwrap()["id"].as_str().unwrap().into()
}

async fn project_names(c: &Client) -> Vec<String> {
    let r = c.get("/projects").await;
    assert_eq!(r.status, 200, "{}", r.text());
    r.json().as_array().unwrap().iter().map(|p| p["name"].as_str().unwrap().to_string()).collect()
}

async fn engine_of(c: &Client) -> String {
    let r = c.get("/database").await;
    assert_eq!(r.status, 200, "{}", r.text());
    r.json()["engine"].as_str().unwrap().to_string()
}

async fn new_project(c: &Client, name: &str, prefix: &str) {
    let r = c.post("/projects", json!({"name": name, "prefix": prefix, "color": "#0a0"})).await;
    assert_eq!(r.status, 201, "{}", r.text());
}

async fn server_board_next_to_a_sqlite_one(test: &str, engine: Engine, database: &str) {
    if !skip_unless_available(test) {
        return;
    }
    let Some(url) = own_database(test, engine, database).await else { return };
    let (s, _tmp) = start(Vec::new()).await;
    let c = s.client();
    new_project(&c, "On SQLite", "LIT").await;
    assert_eq!(engine_of(&c).await, "sqlite");

    // a server that does not answer is refused when the workspace is added
    let r = c.post("/workspaces", json!({"name": "Nowhere", "connection": {"url": engine.nowhere}})).await;
    assert_eq!(r.status, 422, "{}", r.text());
    assert_eq!(r.json()["detail"]["code"], "not_usable");

    let r = c.post("/workspaces", json!({"name": "Server", "connection": {"url": url}})).await;
    assert_eq!(r.status, 200, "{}", r.text());
    assert_eq!(r.json()["engine"], engine.name);
    assert!(r.json()["place"].as_str().unwrap().contains(database), "{}", r.text());
    let again = c.post("/workspaces", json!({"name": "Server twin", "connection": {"url": url}})).await;
    assert_eq!(again.status, 409, "one database, one workspace");

    let o = overview(&c).await;
    assert_eq!(o["switchable"], true);
    let (lite, server) = (id_of(&o, "Default"), id_of(&o, "Server"));

    // to the server board: empty, then its own project
    let r = c.post_empty(&format!("/workspaces/{server}/switch")).await;
    assert_eq!(r.status, 200, "{}", r.text());
    assert_eq!(engine_of(&c).await, engine.name);
    assert!(project_names(&c).await.is_empty());
    new_project(&c, "On the server", "SRV").await;
    assert_eq!(overview(&c).await["active_id"], json!(server));

    // back to SQLite: its project, not the server's
    let r = c.post_empty(&format!("/workspaces/{lite}/switch")).await;
    assert_eq!(r.status, 200, "{}", r.text());
    assert_eq!(engine_of(&c).await, "sqlite");
    assert_eq!(project_names(&c).await, vec!["On SQLite"]);

    // and to the server again: its project is still there
    assert_eq!(c.post_empty(&format!("/workspaces/{server}/switch")).await.status, 200);
    assert_eq!(project_names(&c).await, vec!["On the server"]);

    // the choice is in the settings file, and a password in it is encrypted, never text
    let config = std::fs::read_to_string(s.config_dir().join("config.json")).unwrap();
    assert!(config.contains(&format!("\"{}\"", engine.name)), "{config}");
    assert!(!config.contains("\"password\""), "a password was kept as text: {config}");
    drop(s);
    common::wipe(&url).await;
}

#[tokio::test]
async fn test_a_postgres_board_next_to_a_sqlite_one_and_back() {
    server_board_next_to_a_sqlite_one(
        "test_a_postgres_board_next_to_a_sqlite_one_and_back",
        POSTGRES,
        "kanban_dbkit_workspaces",
    )
    .await;
}

#[tokio::test]
async fn test_a_mysql_board_next_to_a_sqlite_one_and_back() {
    server_board_next_to_a_sqlite_one(
        "test_a_mysql_board_next_to_a_sqlite_one_and_back",
        MYSQL,
        "kanban_dbkit_workspaces",
    )
    .await;
}

/// The person is on a database server through Settings and never added a workspace: the board in use is kept as
/// "Default" when a second workspace is added, and the way back to it works.
async fn starting_on_a_server_the_board_in_use_is_kept(test: &str, engine: Engine, database: &str) {
    if !skip_unless_available(test) {
        return;
    }
    let Some(url) = own_database(test, engine, database).await else { return };
    let target = kb_db::targets::from_url(&url).expect("a test database URL");
    // the password reaches the server through its environment: a password encrypted here would be with another key
    let env = target.password.clone().map(|p| vec![("KANBAN_DB_PASSWORD".to_string(), p)]).unwrap_or_default();
    let (s, _tmp) = start(env).await;
    let c = s.client();

    // Settings chose the database (the server follows the settings file within a few seconds)
    let file = s.config_dir().join("config.json");
    let mut config: Value =
        std::fs::read_to_string(&file).map(|t| serde_json::from_str(&t).unwrap()).unwrap_or(json!({}));
    config["database"] = Value::Object(target.public());
    std::fs::write(&file, serde_json::to_string_pretty(&config).unwrap()).unwrap();
    let mut on_server = false;
    for _ in 0..60 {
        // an answer while the server is changing database can be an error; look again
        let r = c.get("/database").await;
        if r.status == 200 && r.json()["engine"] == engine.name {
            on_server = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
    assert!(on_server, "the server did not follow the saved database setting");
    new_project(&c, "On the server", "SRV").await;

    let o = overview(&c).await;
    assert_eq!(o["items"].as_array().unwrap().len(), 1);
    assert_eq!(o["items"][0]["engine"], engine.name);

    let r = c.post("/workspaces", json!({"name": "Office"})).await;
    assert_eq!(r.status, 200, "{}", r.text());
    let o = overview(&c).await;
    let (default, office) = (id_of(&o, "Default"), id_of(&o, "Office"));
    assert_eq!(o["active_id"], json!(default), "the board in use was kept, as Default, on its server");

    // to a SQLite board: empty, its own project
    assert_eq!(c.post_empty(&format!("/workspaces/{office}/switch")).await.status, 200);
    assert_eq!(engine_of(&c).await, "sqlite");
    assert!(project_names(&c).await.is_empty());
    new_project(&c, "On SQLite", "LIT").await;

    // and back to the server board
    let r = c.post_empty(&format!("/workspaces/{default}/switch")).await;
    assert_eq!(r.status, 200, "{}", r.text());
    assert_eq!(engine_of(&c).await, engine.name);
    assert_eq!(project_names(&c).await, vec!["On the server"]);
    drop(s);
    common::wipe(&url).await;
}

#[tokio::test]
async fn test_starting_on_postgres_the_board_in_use_is_kept_as_default() {
    starting_on_a_server_the_board_in_use_is_kept(
        "test_starting_on_postgres_the_board_in_use_is_kept_as_default",
        POSTGRES,
        "kanban_dbkit_workspaces_saved",
    )
    .await;
}

#[tokio::test]
async fn test_starting_on_mysql_the_board_in_use_is_kept_as_default() {
    starting_on_a_server_the_board_in_use_is_kept(
        "test_starting_on_mysql_the_board_in_use_is_kept_as_default",
        MYSQL,
        "kanban_dbkit_workspaces_saved",
    )
    .await;
}

#[tokio::test]
async fn test_the_environment_deciding_the_database_turns_the_switch_off() {
    let test = "test_the_environment_deciding_the_database_turns_the_switch_off";
    if !skip_unless_available(test) {
        return;
    }
    let Some(url) = own_database(test, POSTGRES, "kanban_dbkit_workspaces_env").await else { return };
    let (s, _tmp) = start(vec![("KANBAN_DATABASE_URL".into(), url.clone())]).await;
    let c = s.client();
    let o = overview(&c).await;
    assert_eq!(o["switchable"], false);
    assert!(o["reason"].as_str().unwrap().contains("KANBAN_DATABASE_URL"));
    assert_eq!(o["items"].as_array().unwrap()[0]["engine"], "postgresql");
    assert_eq!(c.post("/workspaces", json!({"name": "More"})).await.status, 409);
    drop(s);
    common::wipe(&url).await;
}

/// A TCP proxy to `to`; dropping the returned handle cuts the connections that are open and stops listening, and
/// `hang` makes it a server that stops answering without closing anything (a network that drops the packets).
struct Proxy {
    port: u16,
    task: tokio::task::JoinHandle<()>,
    hung: tokio::sync::watch::Sender<bool>,
}

impl Proxy {
    /// From now on nothing goes through, and nothing is closed either.
    fn hang(&self) {
        let _ = self.hung.send(true);
    }
}

impl Drop for Proxy {
    fn drop(&mut self) {
        self.task.abort();
    }
}

async fn proxy_to(to: String) -> Proxy {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.expect("a free port");
    let port = listener.local_addr().expect("address").port();
    let (hung, watch) = tokio::sync::watch::channel(false);
    let task = tokio::spawn(async move {
        // the connections live in this set: when the task is aborted they go with it
        let mut connections = tokio::task::JoinSet::new();
        while let Ok((mut inbound, _)) = listener.accept().await {
            let to = to.clone();
            let mut watch = watch.clone();
            connections.spawn(async move {
                if !*watch.borrow() {
                    if let Ok(mut outbound) = tokio::net::TcpStream::connect(to).await {
                        tokio::select! {
                            _ = tokio::io::copy_bidirectional(&mut inbound, &mut outbound) => return,
                            _ = watch.wait_for(|hung| *hung) => {}
                        }
                    }
                }
                // hung: keep the connection open and say nothing
                std::future::pending::<()>().await;
                drop(inbound);
            });
        }
    });
    Proxy { port, task, hung }
}

/// The office server is not reachable from home: a board on a server that stops answering must not trap the person. The
/// workspace list and the switch keep working while the board is down, and the way back to the SQLite board is there.
async fn a_server_board_that_stops_answering_can_be_left(test: &str, engine: Engine, database: &str) {
    server_board_that_goes_away_can_be_left(test, engine, database, Away::Closed).await;
}

/// How a database server goes away.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Away {
    /// It refuses connections (the server stopped).
    Closed,
    /// It says nothing and closes nothing (the network drops the packets: the office server seen from home).
    Silent,
}

async fn server_board_that_goes_away_can_be_left(test: &str, engine: Engine, database: &str, away: Away) {
    if !skip_unless_available(test) {
        return;
    }
    let Some(url) = own_database(test, engine, database).await else { return };
    let real = kb_db::targets::from_url(&url).expect("a test database URL");
    let proxy = proxy_to(format!("{}:{}", real.host, real.port_or_default())).await;
    let through = url.replacen(&format!(":{}/", real.port_or_default()), &format!(":{}/", proxy.port), 1);
    let (s, _tmp) = start(Vec::new()).await;
    let c = s.client();
    new_project(&c, "On SQLite", "LIT").await;
    let r = c.post("/workspaces", json!({"name": "Office", "connection": {"url": through}})).await;
    assert_eq!(r.status, 200, "{}", r.text());
    let office = r.json()["id"].as_str().unwrap().to_string();
    let default = id_of(&overview(&c).await, "Default");
    assert_eq!(c.post_empty(&format!("/workspaces/{office}/switch")).await.status, 200);
    new_project(&c, "At the office", "OFC").await;

    // the server goes away
    let _hung = match away {
        Away::Closed => {
            drop(proxy);
            let mut down = false;
            for _ in 0..80 {
                let r = c.get("/projects").await;
                if r.status == 503 {
                    assert_eq!(r.json()["detail"]["code"], "database_unreachable");
                    down = true;
                    break;
                }
                tokio::time::sleep(Duration::from_millis(500)).await;
            }
            assert!(down, "the board never reported the server as unreachable");
            None
        }
        // the board does not know yet: nothing has failed so far, requests just wait
        Away::Silent => {
            proxy.hang();
            Some(proxy)
        }
    };

    // the list shows, and says which board is in use, instead of answering 503
    let o = overview(&c).await;
    assert_eq!(o["active_id"], json!(office));
    // and the person can leave it, without waiting for the connection timeouts of the board left behind
    let started = std::time::Instant::now();
    let r = c.post_empty(&format!("/workspaces/{default}/switch")).await;
    assert_eq!(r.status, 200, "{}", r.text());
    assert!(started.elapsed() < Duration::from_secs(12), "leaving took {:?}", started.elapsed());
    assert_eq!(engine_of(&c).await, "sqlite");
    assert_eq!(project_names(&c).await, vec!["On SQLite"]);
    drop(s);
    common::wipe(&url).await;
}

#[tokio::test]
async fn test_a_postgres_board_that_stops_answering_can_be_left() {
    a_server_board_that_stops_answering_can_be_left(
        "test_a_postgres_board_that_stops_answering_can_be_left",
        POSTGRES,
        "kanban_dbkit_workspaces_down",
    )
    .await;
}

#[tokio::test]
async fn test_a_postgres_board_that_hangs_can_be_left_quickly() {
    server_board_that_goes_away_can_be_left(
        "test_a_postgres_board_that_hangs_can_be_left_quickly",
        POSTGRES,
        "kanban_dbkit_workspaces_hangs",
        Away::Silent,
    )
    .await;
}

#[tokio::test]
async fn test_a_mysql_board_that_hangs_can_be_left_quickly() {
    server_board_that_goes_away_can_be_left(
        "test_a_mysql_board_that_hangs_can_be_left_quickly",
        MYSQL,
        "kanban_dbkit_workspaces_hangs",
        Away::Silent,
    )
    .await;
}

#[tokio::test]
async fn test_a_mysql_board_that_stops_answering_can_be_left() {
    a_server_board_that_stops_answering_can_be_left(
        "test_a_mysql_board_that_stops_answering_can_be_left",
        MYSQL,
        "kanban_dbkit_workspaces_down",
    )
    .await;
}

/// Settings › Database can point the app at another database that already holds a board. That is another board, not
/// the workspace that was open moving: its entry keeps naming its own board, and the list shows the other one as the
/// board in use with no entry yet (a switch away keeps the way back to it).
async fn connecting_to_another_board_keeps_each_workspace_on_its_board(test: &str, engine: Engine, database: &str) {
    if !skip_unless_available(test) {
        return;
    }
    let Some(url) = own_database(test, engine, database).await else { return };
    let (s, _tmp) = start(Vec::new()).await;
    let c = s.client();
    new_project(&c, "On SQLite", "LIT").await;
    // a board on the server (made through a workspace that is then forgotten)
    let r = c.post("/workspaces", json!({"name": "Colleague", "connection": {"url": url}})).await;
    assert_eq!(r.status, 200, "{}", r.text());
    let colleague = r.json()["id"].as_str().unwrap().to_string();
    let default = id_of(&overview(&c).await, "Default");
    assert_eq!(c.post_empty(&format!("/workspaces/{colleague}/switch")).await.status, 200);
    new_project(&c, "On the server", "SRV").await;
    assert_eq!(c.post_empty(&format!("/workspaces/{default}/switch")).await.status, 200);
    assert_eq!(c.delete(&format!("/workspaces/{colleague}")).await.status, 200);

    let r = c.post("/database/connection", json!({"url": url})).await;
    assert_eq!(r.status, 200, "{}", r.text());
    let o = overview(&c).await;
    let items = o["items"].as_array().unwrap();
    let entry = items.iter().find(|i| i["id"] == json!(default)).unwrap();
    assert_eq!((&entry["engine"], &entry["active"]), (&json!("sqlite"), &json!(false)), "{o}");
    let in_use = items.iter().find(|i| i["active"] == true).unwrap();
    assert_eq!((&in_use["id"], &in_use["engine"]), (&json!("current"), &json!(engine.name)), "{o}");

    // Default still opens the SQLite board
    assert_eq!(c.post_empty(&format!("/workspaces/{default}/switch")).await.status, 200);
    assert_eq!(project_names(&c).await, vec!["On SQLite"]);
    drop(s);
    common::wipe(&url).await;
}

#[tokio::test]
async fn test_connecting_to_another_postgres_board_keeps_each_workspace_on_its_board() {
    connecting_to_another_board_keeps_each_workspace_on_its_board(
        "test_connecting_to_another_postgres_board_keeps_each_workspace_on_its_board",
        POSTGRES,
        "kanban_dbkit_workspaces_connect",
    )
    .await;
}

/// The database wizard's move copies the board in use to a server and opens it there: the workspace that named it
/// follows, so opening it later opens the board on the server and not the SQLite copy left behind.
#[tokio::test]
async fn test_a_board_moved_to_postgres_keeps_its_workspace() {
    let test = "test_a_board_moved_to_postgres_keeps_its_workspace";
    if !skip_unless_available(test) {
        return;
    }
    let Some(url) = own_database(test, POSTGRES, "kanban_dbkit_workspaces_moved").await else { return };
    let (s, _tmp) = start(Vec::new()).await;
    let c = s.client();
    new_project(&c, "Moving", "MOV").await;
    let other = c.post("/workspaces", json!({"name": "Other"})).await.json()["id"].as_str().unwrap().to_string();
    let default = id_of(&overview(&c).await, "Default");
    assert_eq!(c.post("/database/move/check", json!({"url": url})).await.status, 200);
    assert_eq!(c.post("/database/move/start", json!({})).await.status, 200);
    let job = common::wait(&c, &["verified", "verified_with_differences", "failed"]).await;
    assert_eq!(job["state"], "verified", "{job}");
    let r = c.post("/database/move/switch", json!({})).await;
    assert_eq!(r.status, 200, "{}", r.text());
    new_project(&c, "After the move", "AFT").await;

    let o = overview(&c).await;
    assert_eq!(o["items"].as_array().unwrap().len(), 2, "{o}");
    let entry = o["items"].as_array().unwrap().iter().find(|i| i["id"] == json!(default)).unwrap().clone();
    assert_eq!((&entry["engine"], &entry["active"]), (&json!("postgresql"), &json!(true)), "{o}");
    // away and back: the board on the server, with what was written after the move
    assert_eq!(c.post_empty(&format!("/workspaces/{other}/switch")).await.status, 200);
    assert_eq!(c.post_empty(&format!("/workspaces/{default}/switch")).await.status, 200);
    assert_eq!(engine_of(&c).await, "postgresql");
    let mut names = project_names(&c).await;
    names.sort();
    assert_eq!(names, vec!["After the move", "Moving"]);
    drop(s);
    common::wipe(&url).await;
}

/// The app starts while the server of its board does not answer (the laptop is away from the office): it opens in a
/// few seconds (the reconnect screen, from which another board can be opened), and what reads the database in the
/// background (the AI runs, schedules, notifications) starts once the server answers.
#[tokio::test]
async fn test_an_app_started_while_its_server_board_is_down_starts_its_work_when_it_answers() {
    let test = "test_an_app_started_while_its_server_board_is_down_starts_its_work_when_it_answers";
    if !skip_unless_available(test) {
        return;
    }
    let Some(url) = own_database(test, POSTGRES, "kanban_dbkit_workspaces_late").await else { return };
    let real = kb_db::targets::from_url(&url).expect("a test database URL");
    // a port nobody listens at yet
    let port = std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
    let config = tempfile::tempdir().unwrap();
    let mut section = real.public();
    section.insert("port".into(), json!(port));
    std::fs::write(config.path().join("config.json"), json!({"database": section}).to_string()).unwrap();

    let started = std::time::Instant::now();
    let (s, _tmp) = start(vec![("KANBAN_CONFIG_DIR".into(), config.path().display().to_string())]).await;
    assert!(started.elapsed() < Duration::from_secs(25), "the start took {:?}", started.elapsed());
    let c = s.client();
    let r = c.get("/projects").await;
    assert_eq!(r.status, 503, "{}", r.text());
    let log = || std::fs::read_to_string(s.log_dir().join("kanban.log")).unwrap_or_default();
    assert!(!log().contains("AI runner started"), "{}", log());

    // the server answers again
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", port)).await.expect("the port is still free");
    let to = format!("{}:{}", real.host, real.port_or_default());
    let _proxy = tokio::spawn(async move {
        while let Ok((mut inbound, _)) = listener.accept().await {
            let to = to.clone();
            tokio::spawn(async move {
                if let Ok(mut outbound) = tokio::net::TcpStream::connect(to).await {
                    let _ = tokio::io::copy_bidirectional(&mut inbound, &mut outbound).await;
                }
            });
        }
    });
    let mut up = false;
    for _ in 0..80 {
        if c.get("/projects").await.status == 200 {
            up = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
    assert!(up, "the board never came back: {}", log());
    let mut working = false;
    for _ in 0..60 {
        let _ = c.get("/projects").await;
        if log().contains("AI runner started") {
            working = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
    assert!(working, "the background work never started: {}", log());
    drop(s);
    common::wipe(&url).await;
}
