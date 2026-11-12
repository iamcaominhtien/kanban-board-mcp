//! Shared by the ported tests of the AI routes: a server that finds the stand-in CLI as `claude`, rows the tests add
//! straight to the server's SQLite file (a team, a run, a note) where no ported route can, and a WebSocket client for
//! the sign-in terminal.
#![allow(dead_code)]

pub mod rec;

use std::path::{Path, PathBuf};
use std::time::Duration;

use futures::{SinkExt, StreamExt};
use serde_json::{Value, json};
use sqlx::sqlite::{SqliteArguments, SqliteConnectOptions};
use sqlx::{Arguments, ConnectOptions, Connection, Row, SqliteConnection};
use testkit::{Client, Options, Server, skip_unless_available};
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::HeaderValue;
use tokio_tungstenite::tungstenite::protocol::Message;

/// `datetime.now(timezone.utc).isoformat()`, near enough for a row a test adds.
pub const NOW: &str = "2026-11-12T08:00:00.000000+00:00";

/// A server whose `PATH` starts with a folder holding the stand-in CLI as `claude` (`fake_claude::install`, what
/// `FAKE` of `ai_helpers.py` is: the Python server finds `claude` on `PATH` the same way). Its accounts, its key file
/// and its home are in a temporary folder of this test (the server's own folder does not exist before it starts).
pub struct Fixture {
    /// The server.
    pub server: Server,
    /// A client of it.
    pub c: Client,
    /// The folder of the accounts (`KANBAN_AI_ACCOUNTS_HOME`).
    pub accounts: PathBuf,
    /// The folder the stand-in CLI is in.
    pub bin: PathBuf,
    /// The folder of the login on this computer (`CLAUDE_CONFIG_DIR`).
    pub claude: PathBuf,
    _tmp: tempfile::TempDir,
}

/// The folder-and-environment of a fixture: `with_cli` puts the fake first on `PATH` (and none at all when false).
pub async fn start(name: &str, with_cli: bool, extra: &[(&str, &str)]) -> Option<Fixture> {
    if !skip_unless_available(name) {
        return None;
    }
    let tmp = tempfile::Builder::new().prefix("kb-ai-api-").tempdir().expect("temporary folder");
    let bin = tmp.path().join("bin");
    std::fs::create_dir_all(&bin).expect("bin folder");
    if with_cli {
        // `install` links the program; a CLI the board is handed by path (`GET /ai/accounts-on-this-computer`) must
        // really be in one of the folders `KANBAN_AI_ROOTS` names, so the link is replaced by a copy
        let linked = fake_claude::install(&bin, "claude");
        std::fs::remove_file(&linked).expect("remove the link");
        std::fs::copy(fake_claude::bin_path(), &linked).expect("copy the fake CLI");
    }
    let accounts = tmp.path().join("accounts");
    let claude = tmp.path().join("claude-config");
    std::fs::create_dir_all(&claude).expect("claude folder");
    // the system folders stay: the server runs `git`. No `claude` is in them, so without the fake there is none
    let mut folders = vec![PathBuf::from("/usr/bin"), PathBuf::from("/bin")];
    if with_cli {
        folders.insert(0, bin.clone());
    }
    let path = std::env::join_paths(folders).expect("PATH");
    let mut env: Vec<(String, String)> = vec![
        ("PATH".into(), path.to_string_lossy().into_owned()),
        ("HOME".into(), tmp.path().to_string_lossy().into_owned()),
        ("KANBAN_AI_ACCOUNTS_HOME".into(), accounts.to_string_lossy().into_owned()),
        ("KANBAN_AI_KEY_FILE".into(), tmp.path().join("ai.key").to_string_lossy().into_owned()),
        ("CLAUDE_CONFIG_DIR".into(), claude.to_string_lossy().into_owned()),
        ("FAKE_CLAUDE_ACCOUNTS".into(), "1".into()),
        // the server starts the runs of the AI team in its own process (as `monkeypatch.delenv("KANBAN_RUNNER")` of the
        // Python tests does for the app they call), not in a runner process
        ("KANBAN_RUNNER".into(), "inprocess".into()),
    ];
    env.extend(extra.iter().map(|(k, v)| (k.to_string(), v.to_string())));
    let server = Server::start_with(Options { env, ..Options::default() }).await;
    let c = server.client();
    Some(Fixture { server, c, accounts, bin, claude, _tmp: tmp })
}

/// A connection to the running server's SQLite file (WAL: the server keeps serving).
pub async fn db(server: &Server) -> SqliteConnection {
    SqliteConnectOptions::new()
        .filename(server.db_path())
        .busy_timeout(Duration::from_secs(10))
        // as the server itself: no engine enforces foreign keys, and tests add rows that point at nothing
        .foreign_keys(false)
        .disable_statement_logging()
        .connect()
        .await
        .unwrap_or_else(|e| panic!("open {}: {e}", server.db_path().display()))
}

fn arguments(params: &[Value]) -> SqliteArguments {
    let mut args = SqliteArguments::default();
    for p in params {
        match p {
            Value::Null => args.add(Option::<String>::None),
            Value::Bool(b) => args.add(*b),
            Value::Number(n) if n.is_i64() => args.add(n.as_i64()),
            Value::Number(n) => args.add(n.as_f64()),
            Value::String(s) => args.add(s.clone()),
            other => args.add(other.to_string()),
        }
        .expect("bind");
    }
    args
}

/// Run one statement with `?` parameters and commit.
pub async fn exec(server: &Server, sql: &str, params: &[Value]) {
    let mut c = db(server).await;
    sqlx::query_with(sqlx::AssertSqlSafe(sql.to_string()), arguments(params))
        .execute(&mut c)
        .await
        .unwrap_or_else(|e| panic!("{sql}: {e}"));
    let _ = c.close().await;
}

/// One value of one row, as JSON (Null when there is no row).
pub async fn scalar(server: &Server, sql: &str, params: &[Value]) -> Value {
    let mut c = db(server).await;
    let wrapped = format!("SELECT json_array(({sql}))");
    let row = sqlx::query_with(sqlx::AssertSqlSafe(wrapped), arguments(params))
        .fetch_one(&mut c)
        .await
        .unwrap_or_else(|e| panic!("{sql}: {e}"));
    let text: String = row.get(0);
    let _ = c.close().await;
    serde_json::from_str::<Value>(&text).expect("json")[0].clone()
}

/// Insert one row given as `{column: value}`.
pub async fn insert(server: &Server, table: &str, columns: &Value) {
    let columns = columns.as_object().expect("columns");
    let names: Vec<String> = columns.keys().map(|k| format!("\"{k}\"")).collect();
    let marks = vec!["?"; names.len()].join(", ");
    let values: Vec<Value> = columns.values().cloned().collect();
    exec(server, &format!("INSERT INTO \"{table}\" ({}) VALUES ({marks})", names.join(", ")), &values).await;
}

/// `async def _project(c)`: the project and its human member of the Python helper (`(project id, member id)`).
pub async fn project(c: &Client) -> (String, String) {
    let r = c.post("/projects", json!({"name": "Kanban Board", "prefix": "KAN", "color": "#2E6F40"})).await;
    r.assert_status(201);
    let pid = id(&r.json());
    let r = c.post(&format!("/projects/{pid}/members"), json!({"name": "An Nguyen"})).await;
    r.assert_status(201);
    (pid, id(&r.json()))
}

/// `async def _ticket(c, pid, title, status)`: the id of a new ticket.
pub async fn ticket(c: &Client, pid: &str, title: &str, status: &str) -> String {
    let r = c.post(&format!("/projects/{pid}/tickets"), json!({"title": title, "status": status})).await;
    r.assert_status(201);
    id(&r.json())
}

/// The `id` of a reply.
pub fn id(value: &Value) -> String {
    value["id"].as_str().unwrap_or_else(|| panic!("no id in {value}")).to_string()
}

/// A team as `_runner(c, pid, repo, ...)` made it where no route can (`POST /projects/{pid}/ai/teams` is not ported):
/// its member row (kind `ai`) and its `AiTeam` row with the defaults of the Python model, `extra` on top. Returns the
/// id of both.
pub async fn team(server: &Server, project_id: &str, name: &str, extra: Value) -> String {
    let member_id = format!("mem_{}", unique());
    insert(
        server,
        "member",
        &json!({"id": member_id, "project_id": project_id, "name": name, "color": "#8B5CF6", "created_at": NOW,
                "role": "member", "kind": "ai"}),
    )
    .await;
    let mut columns = json!({
        "id": member_id, "project_id": project_id, "provider": "claude-code", "connection": "local",
        "description": "", "persona": "", "config": "{}", "permission_mode": "bypass", "max_parallel": 2,
        "scope": "assigned", "paused": false, "health": "unknown", "model": "haiku", "created_at": NOW,
        "updated_at": NOW,
    });
    for (key, value) in extra.as_object().expect("extra columns") {
        columns[key] = value.clone();
    }
    insert(server, "ai_team", &columns).await;
    member_id
}

/// A run row as `AiRun(project_id=, ticket_id=, member_id=, state=, pid=)` makes it. Returns its id.
pub async fn run(
    server: &Server,
    project_id: &str,
    team_id: &str,
    ticket_id: &str,
    state: &str,
    pid: Option<i64>,
) -> String {
    let run_id = format!("run_{}", unique());
    insert(
        server,
        "ai_run",
        &json!({
            "id": run_id, "project_id": project_id, "kind": "team", "ticket_id": ticket_id, "member_id": team_id,
            "number": 1, "mode": "work", "trigger": "assign", "state": state, "started_by": "user",
            "instruction": "", "queued_at": NOW, "report": "{}", "files": "[]", "tokens_in": 0, "tokens_out": 0,
            "cost_usd": 0.0, "metered": false, "paused": false, "restarts": "[]", "retries": "[]",
            "steps_count": 0, "live": false, "depth": 0, "pid": pid,
        }),
    )
    .await;
    run_id
}

/// A row id that is not used twice in one process.
pub fn unique() -> String {
    use std::sync::atomic::{AtomicU64, Ordering};
    static N: AtomicU64 = AtomicU64::new(1);
    let n = N.fetch_add(1, Ordering::Relaxed);
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.subsec_nanos())
        .unwrap_or_default();
    format!("{nanos:08x}{n:04x}")
}

/// `async def _account(c, name, cli_)`: `POST /ai/accounts`, returning the account.
pub async fn account(c: &Client, name: &str) -> Value {
    let r = c.post("/ai/accounts", json!({"name": name, "cli": "claude"})).await;
    r.assert_status(201);
    r.json()
}

/// What a finished sign-in leaves in the fake CLI's folder.
pub fn login(account: &Value, email: &str) {
    std::fs::write(Path::new(account["folder"].as_str().expect("folder")).join(".fake-login"), email)
        .expect("write the fake login");
}

// ---------------------------------------------------------------------------
// The sign-in terminal
// ---------------------------------------------------------------------------

/// An open terminal window.
pub struct Terminal {
    stream: tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>,
}

/// What a refused handshake answered.
#[derive(Debug)]
pub struct Refused(pub u16);

/// Open `/ai/accounts/{id}/terminal` with the given headers (`Origin`, `X-Forwarded-For`...).
pub async fn terminal(server: &Server, account_id: &str, headers: &[(&str, &str)]) -> Result<Terminal, Refused> {
    let url = format!("ws://127.0.0.1:{}/ai/accounts/{account_id}/terminal", server.port());
    let mut request = url.into_client_request().expect("request");
    for (name, value) in headers {
        request.headers_mut().insert(
            tokio_tungstenite::tungstenite::http::HeaderName::from_bytes(name.as_bytes()).expect("header name"),
            HeaderValue::from_str(value).expect("header value"),
        );
    }
    match tokio_tungstenite::connect_async(request).await {
        Ok((stream, _)) => Ok(Terminal { stream }),
        Err(tokio_tungstenite::tungstenite::Error::Http(response)) => Err(Refused(response.status().as_u16())),
        Err(other) => panic!("terminal: {other}"),
    }
}

impl Terminal {
    /// The next message of the server (`{"type": "out" | "state", ...}`), within `secs` seconds.
    pub async fn next(&mut self, secs: u64) -> Value {
        loop {
            let frame = tokio::time::timeout(Duration::from_secs(secs), self.stream.next())
                .await
                .expect("a message within the time")
                .expect("the terminal is open")
                .expect("a frame");
            if let Message::Text(text) = frame {
                return serde_json::from_str(text.as_str()).expect("JSON");
            }
        }
    }

    /// Send a message of the window.
    pub async fn send(&mut self, message: Value) {
        self.stream.send(Message::text(message.to_string())).await.expect("send");
    }

    /// Send raw text.
    pub async fn send_raw(&mut self, text: &str) {
        self.stream.send(Message::text(text)).await.expect("send");
    }

    /// What the person types (`signin.write`).
    pub async fn write(&mut self, data: &str) {
        self.send(json!({"type": "input", "data": data})).await;
    }

    /// `_drain(q, until)`: collect messages until `until(msg)`; returns (text so far, last state).
    pub async fn drain(&mut self, until: impl Fn(&Value) -> bool) -> (String, Value) {
        let (mut text, mut state) = (String::new(), Value::Null);
        loop {
            let msg = self.next(10).await;
            if msg["type"] == "out" {
                text.push_str(msg["data"].as_str().unwrap_or_default());
            } else {
                state = msg.clone();
            }
            if until(&msg) {
                return (text, state);
            }
        }
    }

    /// Close the window.
    pub async fn close(mut self) {
        let _ = self.stream.close(None).await;
    }
}

/// `m["type"] == "state" and m.get("phase") == "paste_code"`.
pub fn asks_for_the_code(m: &Value) -> bool {
    m["type"] == "state" && m["phase"] == "paste_code"
}

/// `m["type"] == "state" and m.get("signed_in")`.
pub fn says_signed_in(m: &Value) -> bool {
    m["type"] == "state" && m["signed_in"] == true
}

/// Poll `check` until it is true (`_until`).
pub async fn until(secs: u64, mut check: impl AsyncFnMut() -> bool) {
    let end = tokio::time::Instant::now() + Duration::from_secs(secs);
    while !check().await {
        assert!(tokio::time::Instant::now() < end, "timed out");
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

/// `team` with an id of the test's choosing (the same for the member row and the team row).
pub async fn team_as(server: &Server, project_id: &str, name: &str, team_id: &str, extra: Value) -> String {
    insert(
        server,
        "member",
        &json!({"id": team_id, "project_id": project_id, "name": name, "color": "#8B5CF6", "created_at": NOW,
                "role": "member", "kind": "ai"}),
    )
    .await;
    let mut columns = json!({
        "id": team_id, "project_id": project_id, "provider": "claude-code", "connection": "local",
        "description": "", "persona": "", "config": "{}", "permission_mode": "bypass", "max_parallel": 2,
        "scope": "assigned", "paused": false, "health": "unknown", "model": "haiku", "created_at": NOW,
        "updated_at": NOW,
    });
    for (key, value) in extra.as_object().expect("extra columns") {
        columns[key] = value.clone();
    }
    insert(server, "ai_team", &columns).await;
    team_id.to_string()
}
