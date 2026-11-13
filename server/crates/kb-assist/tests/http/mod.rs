//! Shared by the tests of this crate that go through HTTP (`routes_*.rs`, `assist_routes.rs`): a server that finds a
//! stand-in for the `claude` CLI, and the helpers of `server/tests/ai_helpers.py` (`_project`, `_runner`, `_ticket`,
//! waiting for a job, a message, a draft).
//!
//! The stand-in CLI reads `FAKE_CLAUDE_*` from the environment of the server, which cannot change once it runs (the
//! Python tests `monkeypatch.setenv` between two requests of one test). So `PATH` holds a small `claude` script that
//! sources `FAKE_CTL` first and then runs the stand-in: `Fixture::fake` rewrites that file, and the next turn sees the
//! new values, on the Python server and on the Rust one alike.
//!
//! Rows that no ported route can make (a team) are added straight to the server's SQLite file, as `kb-ai-api`'s tests
//! do. The golden recorder (`Rec`) is the one of `kb-ai-api/tests/ai_routes.rs`: `ASSIST_ROUTES_RECORD=1
//! PARITY_TARGET=python cargo test -p kb-assist --test assist_routes` writes `contract/golden/assist_routes/`.
#![allow(dead_code)]

use std::collections::{BTreeMap, HashMap};
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use regex::{Captures, Regex};
use serde_json::{Map, Value, json};
use sqlx::sqlite::{SqliteArguments, SqliteConnectOptions};
use sqlx::{Arguments, ConnectOptions, Connection, SqliteConnection};
use testkit::{Client, Options, Resp, Server, normalize, skip_unless_available, target};

/// `datetime.now(timezone.utc).isoformat()`, near enough for a row a test adds.
pub const NOW: &str = "2026-11-12T08:00:00.000000+00:00";

/// A server on a fresh database whose `claude` is the stand-in.
pub struct Fixture {
    /// The server.
    pub server: Server,
    /// A client of it.
    pub c: Client,
    /// The folder the repository of a team is in (`env["repo"]`).
    pub repo: PathBuf,
    /// The folder of this test (`env["tmp"]`): prompts are recorded in it.
    pub tmp: PathBuf,
    ctl: PathBuf,
    set: Mutex<BTreeMap<String, String>>,
    _dir: tempfile::TempDir,
}

/// Start a server with `FAKE_CLAUDE_MODE=assistant` (the autouse fixture of the Python files) and `extra` variables.
/// None when the Rust server is not built (the test is skipped).
pub async fn start(name: &str, extra: &[(&str, &str)]) -> Option<Fixture> {
    if !skip_unless_available(name) {
        return None;
    }
    let dir = tempfile::Builder::new().prefix("kb-assist-").tempdir().expect("temporary folder");
    let root = dir.path().canonicalize().expect("real path");
    let bin = root.join("bin");
    std::fs::create_dir_all(&bin).expect("bin folder");
    let ctl = root.join("fake.env");
    std::fs::write(&ctl, "").expect("control file");
    let script = format!(
        "#!/bin/sh\n[ -f \"$FAKE_CTL\" ] && . \"$FAKE_CTL\"\nexec \"{}\" \"$@\"\n",
        fake_claude::bin_path().display()
    );
    let claude = bin.join("claude");
    std::fs::write(&claude, script).expect("claude script");
    #[allow(clippy::disallowed_methods)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&claude, std::fs::Permissions::from_mode(0o755)).expect("chmod");
    }
    let repo = root.join("repo");
    std::fs::create_dir_all(&repo).expect("repo");
    std::fs::write(repo.join("calc.py"), "def add(a, b):\n    return a - b\n").expect("calc.py");
    let path = std::env::join_paths([bin.clone(), PathBuf::from("/usr/bin"), PathBuf::from("/bin")]).expect("PATH");
    let mut env: Vec<(String, String)> = vec![
        ("PATH".into(), path.to_string_lossy().into_owned()),
        ("HOME".into(), root.to_string_lossy().into_owned()),
        ("KANBAN_AI_KEY_FILE".into(), root.join("ai.key").to_string_lossy().into_owned()),
        ("KANBAN_AI_ACCOUNTS_HOME".into(), root.join("accounts").to_string_lossy().into_owned()),
        ("CLAUDE_CONFIG_DIR".into(), root.join("claude-config").to_string_lossy().into_owned()),
        ("KANBAN_RUNNER".into(), "inprocess".into()),
        ("FAKE_CTL".into(), ctl.to_string_lossy().into_owned()),
        ("FAKE_CLAUDE_MODE".into(), "assistant".into()),
    ];
    env.extend(extra.iter().map(|(k, v)| (k.to_string(), v.to_string())));
    let server = Server::start_with(Options { env, ..Options::default() }).await;
    let c = server.client();
    Some(Fixture { server, c, repo, tmp: root, ctl, set: Mutex::new(BTreeMap::new()), _dir: dir })
}

impl Fixture {
    /// `monkeypatch.setenv(name, value)` for the next turns (a later call of the same name replaces it).
    pub fn fake(&self, vars: &[(&str, &str)]) {
        let mut set = self.set.lock().expect("lock");
        for (k, v) in vars {
            set.insert(k.to_string(), v.to_string());
        }
        let text: String = set.iter().map(|(k, v)| format!("export {k}='{}'\n", v.replace('\'', "'\\''"))).collect();
        std::fs::write(&self.ctl, text).expect("write the control file");
    }

    /// `monkeypatch.setenv("FAKE_CLAUDE_ASSISTANT_BY_SKILL", json.dumps(answers))`.
    pub fn by_skill(&self, answers: &Value) {
        self.fake(&[("FAKE_CLAUDE_ASSISTANT_BY_SKILL", &answers.to_string())]);
    }

    /// `monkeypatch.setenv("FAKE_CLAUDE_ASSISTANT_JSON", json.dumps(answer))`.
    pub fn answer_json(&self, answer: &Value) {
        self.fake(&[("FAKE_CLAUDE_ASSISTANT_JSON", &answer.to_string())]);
    }

    /// The file the stand-in records each start in (`FAKE_CLAUDE_PROMPTS`): the path is set for the next turns.
    pub fn record(&self) -> PathBuf {
        let path = self.tmp.join("prompts.jsonl");
        self.fake(&[("FAKE_CLAUDE_PROMPTS", &path.to_string_lossy())]);
        path
    }

    /// What the stand-in recorded, one object per start.
    pub fn prompts(&self) -> Vec<Value> {
        let path = self.tmp.join("prompts.jsonl");
        std::fs::read_to_string(path).unwrap_or_default().lines().filter_map(|l| serde_json::from_str(l).ok()).collect()
    }

    async fn db(&self) -> SqliteConnection {
        SqliteConnectOptions::new()
            .filename(self.server.db_path())
            .busy_timeout(Duration::from_secs(10))
            .foreign_keys(false)
            .disable_statement_logging()
            .connect()
            .await
            .expect("open the database")
    }

    /// Insert one row given as `{column: value}`.
    pub async fn insert(&self, table: &str, columns: &Value) {
        let columns = columns.as_object().expect("columns");
        let names: Vec<String> = columns.keys().map(|k| format!("\"{k}\"")).collect();
        let marks = vec!["?"; names.len()].join(", ");
        let mut args = SqliteArguments::default();
        for v in columns.values() {
            match v {
                Value::Null => args.add(Option::<String>::None),
                Value::Bool(b) => args.add(*b),
                Value::Number(n) if n.is_i64() => args.add(n.as_i64()),
                Value::Number(n) => args.add(n.as_f64()),
                Value::String(s) => args.add(s.clone()),
                other => args.add(other.to_string()),
            }
            .expect("bind");
        }
        let sql = format!("INSERT INTO \"{table}\" ({}) VALUES ({marks})", names.join(", "));
        let mut conn = self.db().await;
        sqlx::query_with(sqlx::AssertSqlSafe(sql.clone()), args)
            .execute(&mut conn)
            .await
            .unwrap_or_else(|e| panic!("{sql}: {e}"));
        let _ = conn.close().await;
    }

    /// `async def _project(c)`: (project id, member id) of a project with one person.
    pub async fn project(&self) -> (String, String) {
        let r = self.c.post("/projects", json!({"name": "Kanban Board", "prefix": "KAN", "color": "#2E6F40"})).await;
        r.assert_status(201);
        let pid = id(&r.json());
        let r = self.c.post(&format!("/projects/{pid}/members"), json!({"name": "An Nguyen"})).await;
        r.assert_status(201);
        (pid, id(&r.json()))
    }

    /// `async def _runner(c, pid, repo, name, **extra)`: a team on the stand-in CLI. The route
    /// `POST /projects/{pid}/ai/teams` is not ported yet, so its member row and `ai_team` row are added directly, with
    /// the defaults of the Python model. Returns `{id, name}`.
    pub async fn runner(&self, pid: &str, name: &str, extra: Value) -> Value {
        let member_id = format!("mem_{}", unique());
        self.insert(
            "member",
            &json!({"id": member_id, "project_id": pid, "name": name, "color": "#8B5CF6", "created_at": NOW,
                    "role": "member", "kind": "ai"}),
        )
        .await;
        let mut columns = json!({
            "id": member_id, "project_id": pid, "provider": "claude-code", "connection": "local",
            "description": "", "persona": "", "config": "{}", "permission_mode": "bypass", "max_parallel": 2,
            "scope": "assigned", "paused": false, "health": "unknown", "model": "stand-in", "created_at": NOW,
            "updated_at": NOW, "working_dir": self.repo.to_string_lossy(),
        });
        for (key, value) in extra.as_object().expect("extra columns") {
            columns[key] = value.clone();
        }
        self.insert("ai_team", &columns).await;
        json!({"id": member_id, "name": name})
    }

    /// `_board(env)` of `test_board_ai_v2.py`: a project with a team on the stand-in CLI.
    pub async fn board(&self) -> String {
        let (pid, _) = self.project().await;
        self.runner(&pid, "Claude Code · Backend", json!({})).await;
        pid
    }

    /// `async def _ticket(c, pid, title, status)`: the id of a new ticket.
    pub async fn ticket(&self, pid: &str, title: &str) -> String {
        let r = self.c.post(&format!("/projects/{pid}/tickets"), json!({"title": title, "status": "todo"})).await;
        r.assert_status(201);
        id(&r.json())
    }

    /// `_job(c, job)` of `test_docs_ai_v2.py`: wait until a Docs AI job is not queued or running.
    pub async fn job(&self, job_id: &str) -> Value {
        poll(|| async {
            let j = self.c.get(&format!("/docs/ai/jobs/{job_id}")).await.json();
            (!matches!(j["state"].as_str(), Some("queued" | "running"))).then_some(j)
        })
        .await
    }

    /// `_answer(c, message)` of `test_board_ai_v2.py`.
    pub async fn answer(&self, message_id: &str) -> Value {
        poll(|| async {
            let m = self.c.get(&format!("/ai/assist/messages/{message_id}")).await.json();
            (!matches!(m["state"].as_str(), Some("queued" | "thinking" | "streaming"))).then_some(m)
        })
        .await
    }

    /// `_draft(c, draft)` of `test_board_ai_v2.py`.
    pub async fn draft(&self, draft_id: &str) -> Value {
        poll(|| async {
            let d = self.c.get(&format!("/ai/assist/drafts/{draft_id}")).await.json();
            (d["status"] != "pending").then_some(d)
        })
        .await
    }
}

impl Fixture {
    /// `job`, answering the last `GET` itself (what a route test records).
    pub async fn job_resp(&self, job_id: &str) -> Resp {
        poll_resp(|| async {
            let r = self.c.get(&format!("/docs/ai/jobs/{job_id}")).await;
            (!matches!(r.json()["state"].as_str(), Some("queued" | "running"))).then_some(r)
        })
        .await
    }

    /// `answer`, answering the last `GET` itself.
    pub async fn answer_resp(&self, message_id: &str) -> Resp {
        poll_resp(|| async {
            let r = self.c.get(&format!("/ai/assist/messages/{message_id}")).await;
            (!matches!(r.json()["state"].as_str(), Some("queued" | "thinking" | "streaming"))).then_some(r)
        })
        .await
    }

    /// `draft`, answering the last `GET` itself.
    pub async fn draft_resp(&self, draft_id: &str) -> Resp {
        poll_resp(|| async {
            let r = self.c.get(&format!("/ai/assist/drafts/{draft_id}")).await;
            (r.json()["status"] != "pending").then_some(r)
        })
        .await
    }
}

/// `poll` for a whole reply.
pub async fn poll_resp<F, Fut>(mut check: F) -> Resp
where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = Option<Resp>>,
{
    let end = std::time::Instant::now() + Duration::from_secs(15);
    loop {
        if let Some(found) = check().await {
            return found;
        }
        assert!(std::time::Instant::now() < end, "nothing happened within 15 s");
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

/// Call `check` every 50 ms for up to 15 s until it answers.
pub async fn poll<F, Fut>(mut check: F) -> Value
where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = Option<Value>>,
{
    let end = std::time::Instant::now() + Duration::from_secs(15);
    loop {
        if let Some(found) = check().await {
            return found;
        }
        assert!(std::time::Instant::now() < end, "nothing happened within 15 s");
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

/// The `id` of a reply.
pub fn id(value: &Value) -> String {
    value["id"].as_str().unwrap_or_else(|| panic!("no id in {value}")).to_string()
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

/// A `multipart/form-data` body of text fields and files, and its content type.
pub fn multipart(fields: &[(&str, &str)], files: &[(&str, &str, &[u8])]) -> (Vec<u8>, String) {
    let boundary = "----kbassistboundary7d4a";
    let mut body: Vec<u8> = Vec::new();
    for (name, value) in fields {
        body.extend_from_slice(
            format!("--{boundary}\r\nContent-Disposition: form-data; name=\"{name}\"\r\n\r\n").as_bytes(),
        );
        body.extend_from_slice(value.as_bytes());
        body.extend_from_slice(b"\r\n");
    }
    for (name, filename, data) in files {
        body.extend_from_slice(
            format!(
                "--{boundary}\r\nContent-Disposition: form-data; name=\"{name}\"; filename=\"{filename}\"\r\nContent-Type: application/octet-stream\r\n\r\n"
            )
            .as_bytes(),
        );
        body.extend_from_slice(data);
        body.extend_from_slice(b"\r\n");
    }
    body.extend_from_slice(format!("--{boundary}--\r\n").as_bytes());
    (body, format!("multipart/form-data; boundary={boundary}"))
}

/// POST a multipart form.
pub async fn post_form(c: &Client, path: &str, fields: &[(&str, &str)], files: &[(&str, &str, &[u8])]) -> Resp {
    let (body, content_type) = multipart(fields, files);
    c.request("POST", path, &[("content-type", content_type.as_str())], Some(body)).await
}

// ---------------------------------------------------------------------------
// The recorded answers
// ---------------------------------------------------------------------------

/// The recorded answers of one test, and what this run answers.
pub struct Rec {
    path: PathBuf,
    golden: Map<String, Value>,
    got: BTreeMap<String, Value>,
    record: bool,
}

impl Rec {
    /// The recorder of `contract/golden/assist_routes/<name>.json`.
    pub fn new(name: &str) -> Rec {
        let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../contract/golden/assist_routes")
            .join(format!("{name}.json"));
        let record = std::env::var("ASSIST_ROUTES_RECORD").is_ok_and(|v| v == "1");
        if record {
            assert_eq!(format!("{:?}", target()), "Python", "record from the Python server");
        }
        let golden = match std::fs::read_to_string(&path) {
            Ok(text) => serde_json::from_str::<Map<String, Value>>(&text).expect("golden file parses"),
            Err(_) if record => Map::new(),
            Err(e) => panic!("{}: {e} (record it with ASSIST_ROUTES_RECORD=1 PARITY_TARGET=python)", path.display()),
        };
        Rec { path, golden, got: BTreeMap::new(), record }
    }

    /// Note the answer under `label`.
    pub fn check(&mut self, label: &str, r: &Resp) {
        if r.is_ui_index() {
            // a GET no route serves, on a machine with a built UI: recorded as on a machine without one
            let entry = json!({"status": 404, "json": {"detail": "UI not built"}});
            assert!(self.got.insert(label.to_string(), entry).is_none(), "label {label} twice");
            return;
        }
        let mut entry = Map::new();
        entry.insert("status".into(), json!(r.status));
        let text = r.text();
        match serde_json::from_str::<Value>(&text) {
            Ok(body) if r.status == 422 && body["detail"].is_array() => {
                // the wording of a validation message is Pydantic's: the field is compared
                // (the Rust body extractors report the first field that is wrong; Pydantic lists them all)
                let locs: Vec<Value> =
                    body["detail"].as_array().expect("detail").iter().take(1).map(|d| d["loc"].clone()).collect();
                entry.insert("json".into(), json!({"loc": locs}));
            }
            Ok(body) => {
                entry.insert("json".into(), tidy(&body));
            }
            Err(_) => {
                entry.insert("text".into(), json!(text));
            }
        }
        assert!(self.got.insert(label.to_string(), Value::Object(entry)).is_none(), "label {label} twice");
    }

    /// Note a value that is not an answer (a row of the database, a file's bytes).
    pub fn note(&mut self, label: &str, value: Value) {
        assert!(self.got.insert(label.to_string(), json!({"note": tidy(&value)})).is_none(), "label {label} twice");
    }

    /// Compare with the recorded answers (or record them).
    pub fn finish(self) {
        if self.record {
            let all: Map<String, Value> = self.got.into_iter().collect();
            std::fs::create_dir_all(self.path.parent().expect("folder")).expect("mkdir");
            let mut text = serde_json::to_string_pretty(&Value::Object(all)).expect("json");
            text.push('\n');
            std::fs::write(&self.path, text).expect("write the golden file");
            return;
        }
        let mut bad = Vec::new();
        for (label, got) in &self.got {
            match self.golden.get(label) {
                Some(want) if want == got => {}
                Some(want) => bad.push(format!(
                    "{label}\n  want {want}\n  got  {got}\n  first difference: {}",
                    first_difference(want, got, "$")
                )),
                None => bad.push(format!("{label}: not recorded")),
            }
        }
        for label in self.golden.keys() {
            if !self.got.contains_key(label) {
                bad.push(format!("{label}: recorded but not asked"));
            }
        }
        assert!(bad.is_empty(), "{} differences:\n{}", bad.len(), bad.join("\n"));
    }
}

/// Where two JSON values first differ (a path, and what is there).
fn first_difference(want: &Value, got: &Value, at: &str) -> String {
    match (want, got) {
        (Value::Object(a), Value::Object(b)) => {
            for (k, v) in a {
                match b.get(k) {
                    Some(w) => {
                        if v != w {
                            return first_difference(v, w, &format!("{at}.{k}"));
                        }
                    }
                    None => return format!("{at}.{k} is missing"),
                }
            }
            for k in b.keys() {
                if !a.contains_key(k) {
                    return format!("{at}.{k} is not wanted");
                }
            }
            format!("{at}: same")
        }
        (Value::Array(a), Value::Array(b)) => {
            for (i, (v, w)) in a.iter().zip(b).enumerate() {
                if v != w {
                    return first_difference(v, w, &format!("{at}[{i}]"));
                }
            }
            format!("{at}: want {} items, got {}", a.len(), b.len())
        }
        _ => format!("{at}: want {want}, got {got}"),
    }
}

fn prefixed_id() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| Regex::new(r"\b([a-z]{2,5})_([0-9a-f]{8,})\b").expect("static regex"))
}

/// Keys in order, ids of the form `mem_1a2b3c4d5e` numbered by first appearance, then uuids, times and ports (the
/// `testkit` normalizer). Costs, durations and the folders of a run are not compared (they are the stand-in's and the
/// machine's); see `scrub`.
pub fn tidy(value: &Value) -> Value {
    fn sorted(v: &Value) -> Value {
        match v {
            Value::Object(m) => {
                let mut keys: Vec<&String> = m.keys().collect();
                keys.sort();
                let mut out = Map::new();
                for k in keys {
                    // a request id is made up for each reply (12 hex characters)
                    if k == "request_id" && m[k].is_string() {
                        out.insert(k.clone(), Value::String("<request-id>".to_string()));
                    } else if k == "day"
                        && m[k].as_str().is_some_and(|d| chrono::NaiveDate::parse_from_str(d, "%Y-%m-%d").is_ok())
                    {
                        // the date of a board digest is the day the check runs
                        out.insert(k.clone(), Value::String("<day>".to_string()));
                    } else {
                        out.insert(k.clone(), sorted(&m[k]));
                    }
                }
                Value::Object(out)
            }
            Value::Array(a) => Value::Array(a.iter().map(sorted).collect()),
            other => other.clone(),
        }
    }
    fn rename(s: &str, seen: &mut HashMap<String, usize>) -> String {
        prefixed_id()
            .replace_all(s, |c: &Captures| {
                let next = seen.len() + 1;
                let n = *seen.entry(c[0].to_string()).or_insert(next);
                format!("<{}:{n}>", &c[1])
            })
            .into_owned()
    }
    fn numbered(v: &Value, seen: &mut HashMap<String, usize>) -> Value {
        match v {
            Value::String(s) => Value::String(rename(s, seen)),
            Value::Array(a) => Value::Array(a.iter().map(|x| numbered(x, seen)).collect()),
            Value::Object(m) => {
                let mut out = Map::new();
                for (k, x) in m {
                    out.insert(rename(k, seen), numbered(x, seen));
                }
                Value::Object(out)
            }
            other => other.clone(),
        }
    }
    normalize(&numbered(&sorted(value), &mut HashMap::new()))
}
