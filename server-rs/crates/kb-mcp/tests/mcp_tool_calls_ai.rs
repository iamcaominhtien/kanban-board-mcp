//! `tools/call`, call by call, for the four tools of the AI team: `ai_run`, `knowledge`, `board_wait` and
//! `ai_schedules`: every action with its good path and each refusal the Python code has (a call from outside a run,
//! from a run that has ended, a parameter that is missing, a thing that is not there, ...). What the Python server
//! answers is kept in `contract/golden/mcp_tool_calls_{ai_run,knowledge,board_wait,ai_schedules}.json` (ids, times and
//! the folders of the test normalized); both servers are compared with them. To record them again after adding a
//! call: `PARITY_TARGET=python KANBAN_WRITE_GOLDEN=1 cargo test -p kb-mcp --test mcp_tool_calls_ai`.
//!
//! The calls of a run are made with the run's token (`Authorization: Bearer kbr_...`): the run is a row the test adds
//! to the server's SQLite file, as the tests of `server/tests` add it (`token_hash` is the SHA-256 of the token).
//! The Rust target is the board's own server (`KANBAN_SERVER_BIN`: `cargo build -p kanban-server -p fake-claude`);
//! the test says so and passes when it does not exist.

mod common;

use std::collections::HashMap;
use std::path::PathBuf;
use std::time::Duration;

use common::check_golden;
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};
use sqlx::sqlite::{SqliteArguments, SqliteConnectOptions};
use sqlx::{Arguments, ConnectOptions, Connection, SqliteConnection};
use testkit::{Options, Server, normalize, skip_unless_available};

/// `datetime.now(timezone.utc).isoformat()`, near enough for a row the test adds.
const NOW: &str = "2026-11-12T08:00:00.000000+00:00";

/// One step of a scenario.
enum Step {
    /// A call: its name in the golden file, who makes it (a run, or `""` for a person), the tool, its arguments
    /// (`$name` stands for an id kept earlier), and the value of the result to keep (`name`, JSON pointer).
    Call { name: &'static str, who: &'static str, tool: &'static str, arguments: Value, keep: Option<(&'static str, &'static str)> },
    /// A statement run on the server's database (`$name` in the parameters as above).
    Sql(&'static str, Vec<Value>),
    /// A call of the REST API: method, path (`$name` filled), body.
    Rest(&'static str, String, Value),
}

fn call(name: &'static str, who: &'static str, tool: &'static str, arguments: Value) -> Step {
    Step::Call { name, who, tool, arguments, keep: None }
}

fn keep(
    name: &'static str,
    who: &'static str,
    tool: &'static str,
    arguments: Value,
    keep: &'static str,
    pointer: &'static str,
) -> Step {
    Step::Call { name, who, tool, arguments, keep: Some((keep, pointer)) }
}

fn fill(value: &Value, ids: &HashMap<String, String>) -> Value {
    match value {
        Value::String(s) => match s.strip_prefix('$').and_then(|name| ids.get(name)) {
            Some(id) => json!(id),
            None => value.clone(),
        },
        Value::Array(items) => Value::Array(items.iter().map(|v| fill(v, ids)).collect()),
        Value::Object(map) => Value::Object(map.iter().map(|(k, v)| (k.clone(), fill(v, ids))).collect()),
        other => other.clone(),
    }
}

/// The token of a run as a test names it.
fn token_of(who: &str) -> String {
    format!("kbr_test_{who}")
}

/// The server, the stand-in CLI and the ids kept.
struct Fx {
    server: Server,
    ids: HashMap<String, String>,
    got: Map<String, Value>,
    _tmp: tempfile::TempDir,
}

impl Fx {
    /// A server that finds the stand-in CLI as `claude` (the Python server finds `claude` on `PATH` the same way),
    /// with its accounts, key file and home in a temporary folder. `None` when the Rust server does not exist.
    async fn start(name: &str) -> Option<Fx> {
        if !skip_unless_available(name) {
            return None;
        }
        let tmp = tempfile::Builder::new().prefix("kb-mcp-ai-").tempdir().expect("temporary folder");
        let bin = tmp.path().join("bin");
        std::fs::create_dir_all(&bin).expect("bin folder");
        let linked = fake_claude::install(&bin, "claude");
        std::fs::remove_file(&linked).expect("remove the link");
        std::fs::copy(fake_claude::bin_path(), &linked).expect("copy the stand-in CLI");
        let claude = tmp.path().join("claude-config");
        std::fs::create_dir_all(&claude).expect("claude folder");
        let folders = vec![bin, PathBuf::from("/usr/bin"), PathBuf::from("/bin")];
        let path = std::env::join_paths(folders).expect("PATH");
        let env: Vec<(String, String)> = vec![
            ("PATH".into(), path.to_string_lossy().into_owned()),
            ("HOME".into(), tmp.path().to_string_lossy().into_owned()),
            ("KANBAN_AI_ACCOUNTS_HOME".into(), tmp.path().join("accounts").to_string_lossy().into_owned()),
            ("KANBAN_AI_KEY_FILE".into(), tmp.path().join("ai.key").to_string_lossy().into_owned()),
            ("CLAUDE_CONFIG_DIR".into(), claude.to_string_lossy().into_owned()),
            ("FAKE_CLAUDE_ACCOUNTS".into(), "1".into()),
            ("KANBAN_RUNNER".into(), "inprocess".into()),
        ];
        let server = Server::start_with(Options { env, ..Options::default() }).await;
        Some(Fx { server, ids: HashMap::new(), got: Map::new(), _tmp: tmp })
    }

    async fn db(&self) -> SqliteConnection {
        SqliteConnectOptions::new()
            .filename(self.server.db_path())
            .busy_timeout(Duration::from_secs(10))
            // as the server itself: no engine enforces foreign keys, and a test adds rows that point at nothing
            .foreign_keys(false)
            .disable_statement_logging()
            .connect()
            .await
            .expect("open the database")
    }

    async fn exec(&self, sql: &str, params: &[Value]) {
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
        let mut c = self.db().await;
        sqlx::query_with(sqlx::AssertSqlSafe(sql.to_string()), args)
            .execute(&mut c)
            .await
            .unwrap_or_else(|e| panic!("{sql}: {e}"));
        let _ = c.close().await;
    }

    async fn insert(&self, table: &str, columns: Value) {
        let columns = columns.as_object().expect("columns");
        let names: Vec<String> = columns.keys().map(|k| format!("\"{k}\"")).collect();
        let marks = vec!["?"; names.len()].join(", ");
        let values: Vec<Value> = columns.values().cloned().collect();
        self.exec(&format!("INSERT INTO \"{table}\" ({}) VALUES ({marks})", names.join(", ")), &values).await;
    }

    /// An AI team: its member row and its `AiTeam` row with the defaults of the Python model, `extra` on top.
    async fn team(&mut self, key: &str, project_id: &str, name: &str, config: Value) {
        let id = format!("mem_{key}");
        self.insert(
            "member",
            json!({"id": id, "project_id": project_id, "name": name, "color": "#8B5CF6", "created_at": NOW,
                   "role": "member", "kind": "ai"}),
        )
        .await;
        self.insert(
            "ai_team",
            json!({"id": id, "project_id": project_id, "provider": "claude-code", "connection": "local",
                   "description": "", "persona": "", "config": config.to_string(), "permission_mode": "bypass",
                   "max_parallel": 2, "scope": "assigned", "paused": false, "health": "unknown", "model": "stand-in",
                   "created_at": NOW, "updated_at": NOW}),
        )
        .await;
        self.ids.insert(key.to_string(), id);
    }

    /// A run row as `AiRun(...)` makes it, with the token `kbr_test_<key>` (`run_id` the key unless given).
    async fn run(&mut self, key: &str, run_id: &str, columns: Value) {
        let token = token_of(key);
        let hash: String = Sha256::digest(token.as_bytes()).iter().map(|b| format!("{b:02x}")).collect();
        let mut row = json!({
            "id": run_id, "kind": "team", "number": 1, "mode": "work", "trigger": "assign", "state": "running",
            "started_by": "An Nguyen", "instruction": "", "queued_at": NOW, "report": "{}", "files": "[]",
            "tokens_in": 0, "tokens_out": 0, "cost_usd": 0.0, "metered": false, "paused": false, "restarts": "[]",
            "retries": "[]", "steps_count": 0, "live": false, "depth": 0, "token_hash": hash,
        });
        for (k, v) in columns.as_object().expect("columns") {
            row[k] = v.clone();
        }
        let filled = fill(&row, &self.ids);
        self.insert("ai_run", filled).await;
        self.ids.insert(format!("run_{key}"), run_id.to_string());
    }

    /// The project, its person, two tickets and the teams and runs the calls come from.
    async fn setup(&mut self) {
        let c = self.server.client();
        let made = c.post("/projects", json!({"name": "Runs", "prefix": "RUN", "color": "#2E6F40"})).await;
        made.assert_status(201);
        let pid = made.json()["id"].as_str().expect("an id").to_string();
        c.post(&format!("/projects/{pid}/members"), json!({"name": "An Nguyen"})).await.assert_status(201);
        let mut tickets = Vec::new();
        for title in ["First", "Second"] {
            let made = c.post(&format!("/projects/{pid}/tickets"), json!({"title": title})).await;
            made.assert_status(201);
            tickets.push(made.json()["id"].as_str().expect("an id").to_string());
        }
        self.ids.insert("p".into(), pid.clone());
        self.ids.insert("t1".into(), tickets[0].clone());
        self.ids.insert("t2".into(), tickets[1].clone());
        self.team("dev", &pid, "Dev An", json!({"role": "dev"})).await;
        self.team("helper", &pid, "Helper", json!({})).await;
        let p = json!({"project_id": pid});
        let on = |ticket: &str, team: &str| json!({"project_id": pid, "ticket_id": ticket, "member_id": team});
        let mut with = |base: Value, more: Value| {
            let mut row = base;
            for (k, v) in more.as_object().expect("columns") {
                row[k] = v.clone();
            }
            row
        };
        let _ = &p;
        let (t1, t2) = (tickets[0].clone(), tickets[1].clone());
        let (dev, helper) = (self.ids["dev"].clone(), self.ids["helper"].clone());
        let rows = [
            ("dev", "run_dev", on(&t1, &dev)),
            ("helper", "run_helper", on(&t2, &helper)),
            ("ended", "run_ended", with(on(&t1, &dev), json!({"state": "done"}))),
            ("deep", "run_deep", with(on(&t1, &dev), json!({"depth": 3}))),
            ("assistant", "run_assistant", with(on(&t1, &dev), json!({"trigger": "assistant"}))),
            ("noticket", "run_noticket", with(on(&t1, &dev), json!({"ticket_id": null}))),
            ("chat", "chat_1", on(&t1, &dev)),
        ];
        for (key, id, columns) in rows {
            self.run(key, id, columns).await;
        }
    }

    async fn go(&mut self, steps: Vec<Step>) {
        for step in steps {
            match step {
                Step::Sql(sql, params) => {
                    let params: Vec<Value> = params.iter().map(|p| fill(p, &self.ids)).collect();
                    self.exec(sql, &params).await;
                }
                Step::Rest(method, path, body) => {
                    let path = path.split('/').map(|s| fill(&json!(s), &self.ids)).map(|v| v.as_str().unwrap_or_default().to_string()).collect::<Vec<_>>().join("/");
                    let c = self.server.client();
                    let body = fill(&body, &self.ids);
                    let reply = match method {
                        "POST" => c.post(&path, body).await,
                        "PUT" => c.put(&path, body).await,
                        other => panic!("method {other}"),
                    };
                    assert!(reply.status < 300, "{method} {path}: {}", reply.text());
                }
                Step::Call { name, who, tool, arguments, keep } => {
                    let mcp = if who.is_empty() { self.server.mcp() } else { self.server.mcp().bearer(&token_of(who)) };
                    let result = mcp.call_tool(tool, fill(&arguments, &self.ids)).await;
                    if let Some((kept, pointer)) = keep {
                        let made = result.json();
                        let id = made.pointer(pointer).and_then(Value::as_str);
                        let id = id.unwrap_or_else(|| panic!("{name}: nothing at {pointer} in {}", result.text));
                        self.ids.insert(kept.to_string(), id.to_string());
                    }
                    assert!(self.got.insert(name.to_string(), result.raw).is_none(), "two calls named {name}");
                }
            }
        }
    }

    fn check(&self, golden: &str) {
        let normalized = normalize(&Value::Object(self.got.clone()));
        check_golden(golden, normalized.as_object().expect("an object"));
    }
}

// ---------------------------------------------------------------------------------------------------------- ai_run

fn ai_run_calls() -> Vec<Step> {
    vec![
        // --- arguments FastMCP refuses, and a call from outside a run
        call("outside: no arguments", "", "ai_run", json!({})),
        call("outside: unknown action", "", "ai_run", json!({"action": "destroy"})),
        call("outside: unknown argument", "dev", "ai_run", json!({"action": "team", "foo": 1})),
        call("outside: options not a list", "dev", "ai_run", json!({"action": "ask", "options": "a"})),
        call("outside: report not an object", "dev", "ai_run", json!({"action": "report", "report": [1]})),
        call("outside: ask", "", "ai_run", json!({"action": "ask", "question": "Which one?"})),
        call("outside: message", "", "ai_run", json!({"action": "message", "to": "RUN-1", "text": "hi"})),
        call("outside: team", "", "ai_run", json!({"action": "team"})),
        call("outside: a token that is not a run's", "nobody", "ai_run", json!({"action": "team"})),
        call("ended: ask", "ended", "ai_run", json!({"action": "ask", "question": "Which one?"})),
        call("ended: team", "ended", "ai_run", json!({"action": "team"})),
        // --- ask
        call("ask: no question", "dev", "ai_run", json!({"action": "ask"})),
        call("ask: an empty question", "dev", "ai_run", json!({"action": "ask", "question": "   "})),
        call("ask: a question", "dev", "ai_run", json!({"action": "ask", "question": "  Which database?  "})),
        call(
            "ask: with choices",
            "dev",
            "ai_run",
            json!({"action": "ask", "question": "Which database?", "options": [
                "SQLite", {"label": "Postgres", "description": "for a team", "recommended": true},
                {"text": "MySQL"}, "", 5, {"label": ""}, "a", "b", "c"]}),
        ),
        call("ask: a parameter it does not use", "dev", "ai_run", json!({"action": "ask", "question": "Again?", "to": "x"})),
        // --- message
        call("message: nothing", "dev", "ai_run", json!({"action": "message"})),
        call("message: no text", "dev", "ai_run", json!({"action": "message", "to": "$t2"})),
        call("message: no target", "dev", "ai_run", json!({"action": "message", "text": "hello"})),
        call("message: blank text", "dev", "ai_run", json!({"action": "message", "to": "$t2", "text": "  "})),
        call("message: to its own ticket", "dev", "ai_run", json!({"action": "message", "to": "$t1", "text": "hello"})),
        call("message: too many hand-offs", "deep", "ai_run", json!({"action": "message", "to": "$t2", "text": "hello"})),
        call("message: a ticket that does not exist", "dev", "ai_run", json!({"action": "message", "to": "RUN-99", "text": "hello"})),
        call("message: a ticket nobody works on", "dev", "ai_run", json!({"action": "message", "to": "$t2", "text": "hello"})),
        call("message: a page that does not exist", "dev", "ai_run", json!({"action": "message", "to": "docs:nope", "text": "hello"})),
        call("message: as the assistant, a ticket that does not exist", "assistant", "ai_run", json!({"action": "message", "to": "RUN-98", "text": "hello"})),
        // --- history
        call("history: its own ticket", "dev", "ai_run", json!({"action": "history"})),
        call("history: no ticket at all", "noticket", "ai_run", json!({"action": "history"})),
        call("history: a blank key", "noticket", "ai_run", json!({"action": "history", "to": "  "})),
        call("history: another ticket", "dev", "ai_run", json!({"action": "history", "to": "$t2"})),
        call("history: a ticket that does not exist", "dev", "ai_run", json!({"action": "history", "to": "RUN-99"})),
        Step::Sql(
            "INSERT INTO ai_session_history (id, ticket_id, member_id, title, summary, session_ids, run_ids, created_at, closed_by) \
             VALUES ('hist_1', ?, ?, 'Login work', 'Fixed the form', '[\"s1\"]', '[\"run_dev\"]', '2026-11-12T08:00:00.000000+00:00', 'An Nguyen')",
            vec![json!("$t1"), json!("$dev")],
        ),
        call("history: with a closed conversation", "dev", "ai_run", json!({"action": "history"})),
        // --- reply
        call("reply: a run with no ticket", "noticket", "ai_run", json!({"action": "reply", "text": "yes"})),
        call("reply: no text", "dev", "ai_run", json!({"action": "reply"})),
        call("reply: nobody wrote", "dev", "ai_run", json!({"action": "reply", "text": "Here it is"})),
        call("reply: a message that does not exist", "dev", "ai_run", json!({"action": "reply", "text": "Here", "message_id": "nope"})),
        // --- team and runs
        call("team: its team", "dev", "ai_run", json!({"action": "team"})),
        call("team: a team without a role", "helper", "ai_run", json!({"action": "team"})),
        call("team: a parameter it does not use", "dev", "ai_run", json!({"action": "team", "question": "x"})),
        call("runs: its runs", "dev", "ai_run", json!({"action": "runs"})),
        call("runs: the other team's", "helper", "ai_run", json!({"action": "runs"})),
        // --- report
        call("report: none", "dev", "ai_run", json!({"action": "report"})),
        call("report: an empty one", "dev", "ai_run", json!({"action": "report", "report": {}})),
        call(
            "report: a report",
            "dev",
            "ai_run",
            json!({"action": "report", "report": {"summary": "Done early", "status": "ok", "branch": "feat/x",
                   "tests": "passed", "open_items": ["docs"], "lessons": []}}),
        ),
        call("report: without a summary", "dev", "ai_run", json!({"action": "report", "report": {"status": "partly"}})),
    ]
}

#[tokio::test]
async fn the_ai_run_tool_answers_as_python_does() {
    let Some(mut fx) = Fx::start("the_ai_run_tool_answers_as_python_does").await else { return };
    fx.setup().await;
    fx.go(ai_run_calls()).await;
    // the run's own rows keep what the calls wrote
    let seen = fx.server.client().get(&format!("/projects/{}/ai/knowledge", fx.ids["p"])).await;
    assert!(seen.status < 500, "{}", seen.text());
    fx.check("mcp_tool_calls_ai_run.json");
}

// ------------------------------------------------------------------------------------------------------ knowledge

fn knowledge_calls() -> Vec<Step> {
    vec![
        // --- outside a run: what every action needs
        call("arguments: no arguments", "", "knowledge", json!({})),
        call("arguments: unknown action", "", "knowledge", json!({"action": "burn"})),
        call("arguments: scope unknown", "", "knowledge", json!({"action": "memory", "project_id": "$p", "scope": "team"})),
        call("arguments: kind unknown", "", "knowledge", json!({"action": "remember", "project_id": "$p", "kind": "dream"})),
        call("arguments: start text", "", "knowledge", json!({"action": "read", "project_id": "$p", "start": "x"})),
        call("arguments: unknown argument", "", "knowledge", json!({"action": "index", "project_id": "$p", "limit": 1})),
        call("index: no project", "", "knowledge", json!({"action": "index"})),
        call("search: no project", "", "knowledge", json!({"action": "search", "query": "x"})),
        call("read: no project", "", "knowledge", json!({"action": "read", "doc_id": "x"})),
        call("memory: no project", "", "knowledge", json!({"action": "memory"})),
        call("remember: no project", "", "knowledge", json!({"action": "remember", "text": "x"})),
        call("forget: no project", "", "knowledge", json!({"action": "forget", "note_id": "x"})),
        call("index: an empty project", "", "knowledge", json!({"action": "index", "project_id": "$p"})),
        call("index: a project that does not exist", "", "knowledge", json!({"action": "index", "project_id": "nope"})),
        call("search: no query", "", "knowledge", json!({"action": "search", "project_id": "$p"})),
        call("search: a blank query", "", "knowledge", json!({"action": "search", "project_id": "$p", "query": "  "})),
        call("search: nothing found", "", "knowledge", json!({"action": "search", "project_id": "$p", "query": "migrations"})),
        call("search: only one-letter words", "", "knowledge", json!({"action": "search", "project_id": "$p", "query": "a b"})),
        call("read: no document", "", "knowledge", json!({"action": "read", "project_id": "$p"})),
        call("read: a document that does not exist", "", "knowledge", json!({"action": "read", "project_id": "$p", "doc_id": "nope"})),
        // --- the knowledge base: a document added where no tool can
        Step::Sql(
            "INSERT INTO ai_knowledge_doc (id, project_id, store, title, kind, source_name, summary, keywords, text, size, created_at, updated_at) \
             VALUES ('doc_1', ?, 'project', 'Release checklist', 'text', 'release.md', 'How a release goes out', '[\"release\"]', ?, 60, '2026-11-12T08:00:00.000000+00:00', '2026-11-12T08:00:00.000000+00:00')",
            vec![json!("$p"), json!("Tag the release, build the wheel and upload it to the index. Then announce it.")],
        ),
        Step::Sql("CREATE VIRTUAL TABLE IF NOT EXISTS kb_fts USING fts5(doc_id UNINDEXED, project_id UNINDEXED, store UNINDEXED, title, summary, keywords, body, tokenize = 'unicode61 remove_diacritics 2')", vec![]),
        Step::Sql(
            "INSERT INTO kb_fts (doc_id, project_id, store, title, summary, keywords, body) VALUES ('doc_1', ?, 'project', 'Release checklist', 'How a release goes out', 'release', 'Tag the release, build the wheel and upload it to the index. Then announce it.')",
            vec![json!("$p")],
        ),
        call("index: with a document", "", "knowledge", json!({"action": "index", "project_id": "$p"})),
        call("search: a hit", "", "knowledge", json!({"action": "search", "project_id": "$p", "query": "release wheel"})),
        call("search: a hit for another project", "", "knowledge", json!({"action": "search", "project_id": "nope", "query": "release"})),
        call("read: the document", "", "knowledge", json!({"action": "read", "project_id": "$p", "doc_id": "doc_1"})),
        call("read: from a character", "", "knowledge", json!({"action": "read", "project_id": "$p", "doc_id": "doc_1", "start": 20})),
        call("read: from a negative start", "", "knowledge", json!({"action": "read", "project_id": "$p", "doc_id": "doc_1", "start": -5})),
        call("read: past the end", "", "knowledge", json!({"action": "read", "project_id": "$p", "doc_id": "doc_1", "start": 5000})),
        call("read: from the other project", "", "knowledge", json!({"action": "read", "project_id": "nope", "doc_id": "doc_1"})),
        // --- the memory, outside a run
        Step::Rest("PUT", "/projects/$p/ai/knowledge/instructions".into(), json!({"instructions": "Tests: uv run pytest."})),
        call("memory: empty", "", "knowledge", json!({"action": "memory", "project_id": "$p"})),
        call("remember: no text", "", "knowledge", json!({"action": "remember", "project_id": "$p"})),
        call("remember: a blank text", "", "knowledge", json!({"action": "remember", "project_id": "$p", "text": "  "})),
        keep(
            "remember: a lesson",
            "",
            "knowledge",
            json!({"action": "remember", "project_id": "$p", "text": "Migrations need uv run alembic revision --autogenerate."}),
            "lesson",
            "/lesson/id",
        ),
        call(
            "remember: the same lesson again",
            "",
            "knowledge",
            json!({"action": "remember", "project_id": "$p", "text": "Migrations need uv run alembic revision --autogenerate."}),
        ),
        call("remember: a lesson from a ticket", "", "knowledge", json!({"action": "remember", "project_id": "$p", "scope": "project", "ticket_id": "$t1", "text": "Keep titles short."})),
        call("remember: a role note outside a run", "", "knowledge", json!({"action": "remember", "project_id": "$p", "scope": "role", "text": "x"})),
        call("remember: a ticket note without a ticket", "", "knowledge", json!({"action": "remember", "project_id": "$p", "scope": "ticket", "text": "x"})),
        call("remember: a ticket note, a ticket that does not exist", "", "knowledge", json!({"action": "remember", "project_id": "$p", "scope": "ticket", "ticket_id": "RUN-99", "text": "x"})),
        keep(
            "remember: a ticket note",
            "",
            "knowledge",
            json!({"action": "remember", "project_id": "$p", "scope": "ticket", "ticket_id": "$t1", "text": "The bug only shows with two tabs open."}),
            "note",
            "/note/id",
        ),
        call("remember: the same note again", "", "knowledge", json!({"action": "remember", "project_id": "$p", "scope": "ticket", "ticket_id": "$t1", "text": "the bug only shows with two TABS open."})),
        call("remember: a note in lower case ids", "", "knowledge", json!({"action": "remember", "project_id": "$p", "scope": "ticket", "ticket_id": "run-2", "kind": "feedback", "text": "  A  long   note\n with   spaces  "})),
        call("remember: a note of another project's ticket", "", "knowledge", json!({"action": "remember", "project_id": "nope", "scope": "ticket", "ticket_id": "$t1", "text": "x"})),
        call("memory: all of it", "", "knowledge", json!({"action": "memory", "project_id": "$p"})),
        call("memory: one ticket's notes", "", "knowledge", json!({"action": "memory", "project_id": "$p", "ticket_id": "$t1"})),
        call("memory: project scope", "", "knowledge", json!({"action": "memory", "project_id": "$p", "scope": "project"})),
        call("memory: ticket scope", "", "knowledge", json!({"action": "memory", "project_id": "$p", "scope": "ticket"})),
        call("memory: role scope", "", "knowledge", json!({"action": "memory", "project_id": "$p", "scope": "role"})),
        call("forget: no note", "", "knowledge", json!({"action": "forget", "project_id": "$p"})),
        call("forget: a note that does not exist", "", "knowledge", json!({"action": "forget", "project_id": "$p", "note_id": "nope"})),
        call("forget: a note of another project", "", "knowledge", json!({"action": "forget", "project_id": "nope", "note_id": "$note"})),
        call("forget: the note", "", "knowledge", json!({"action": "forget", "project_id": "$p", "note_id": "$note"})),
        call("forget: the note again", "", "knowledge", json!({"action": "forget", "project_id": "$p", "note_id": "$note"})),
        // --- in a run: its own project, its role's notes and its ticket's
        call("run: index", "dev", "knowledge", json!({"action": "index"})),
        call("run: search", "dev", "knowledge", json!({"action": "search", "query": "release"})),
        call("run: read", "dev", "knowledge", json!({"action": "read", "doc_id": "doc_1", "start": 4})),
        call("run: another project is ignored", "dev", "knowledge", json!({"action": "index", "project_id": "nope"})),
        call("run: memory", "dev", "knowledge", json!({"action": "memory"})),
        keep("run: remember a role note", "dev", "knowledge", json!({"action": "remember", "text": "Run the linter first."}), "rolenote", "/note/id"),
        call("run: the same role note", "dev", "knowledge", json!({"action": "remember", "text": "run the linter first."})),
        call("run: a feedback note", "dev", "knowledge", json!({"action": "remember", "kind": "feedback", "text": "A person wants small commits."})),
        call("run: replace a note", "dev", "knowledge", json!({"action": "remember", "note_id": "$rolenote", "text": "Run the linter and the tests first."})),
        call("run: replace a note that does not exist", "dev", "knowledge", json!({"action": "remember", "note_id": "nope", "text": "x"})),
        call("run: a ticket note of its own ticket", "dev", "knowledge", json!({"action": "remember", "scope": "ticket", "text": "This ticket has two tabs."})),
        call("run: a ticket note of another ticket", "dev", "knowledge", json!({"action": "remember", "scope": "ticket", "ticket_id": "$t2", "text": "That one is quiet."})),
        call("run: a ticket note, a ticket that does not exist", "dev", "knowledge", json!({"action": "remember", "scope": "ticket", "ticket_id": "RUN-99", "text": "x"})),
        call("run: a lesson", "dev", "knowledge", json!({"action": "remember", "scope": "project", "text": "Review before merge."})),
        call("run: memory after the notes", "dev", "knowledge", json!({"action": "memory"})),
        call("run: memory, role scope", "dev", "knowledge", json!({"action": "memory", "scope": "role"})),
        call("run: memory, ticket scope", "dev", "knowledge", json!({"action": "memory", "scope": "ticket"})),
        call("run: memory, project scope", "dev", "knowledge", json!({"action": "memory", "scope": "project"})),
        call("run: a team without a role keeps its own notes", "helper", "knowledge", json!({"action": "remember", "text": "I have no role."})),
        call("run: that team's memory", "helper", "knowledge", json!({"action": "memory"})),
        call("run: forget a note", "dev", "knowledge", json!({"action": "forget", "note_id": "$rolenote"})),
        call("run: forget without a note", "dev", "knowledge", json!({"action": "forget"})),
        call("run: an ended run", "ended", "knowledge", json!({"action": "index"})),
        // --- notes switched off for the project
        Step::Sql("UPDATE ai_project_settings SET ops = '{\"ai_notes\": false}' WHERE project_id = ?", vec![json!("$p")]),
        call("off: a role note", "dev", "knowledge", json!({"action": "remember", "text": "x"})),
        call("off: forget", "", "knowledge", json!({"action": "forget", "project_id": "$p", "note_id": "nope"})),
        call("off: a lesson is still proposed", "", "knowledge", json!({"action": "remember", "project_id": "$p", "scope": "project", "text": "Another lesson."})),
        call("off: memory is still read", "", "knowledge", json!({"action": "memory", "project_id": "$p", "scope": "project"})),
    ]
}

#[tokio::test]
async fn the_knowledge_tool_answers_as_python_does() {
    let Some(mut fx) = Fx::start("the_knowledge_tool_answers_as_python_does").await else { return };
    fx.setup().await;
    fx.go(knowledge_calls()).await;
    fx.check("mcp_tool_calls_knowledge.json");
}

// ----------------------------------------------------------------------------------------------------- board_wait

fn board_wait_calls() -> Vec<Step> {
    vec![
        call("arguments: since text", "", "board_wait", json!({"since": "x"})),
        call("arguments: since a float", "", "board_wait", json!({"since": 1.5})),
        call("arguments: timeout text", "", "board_wait", json!({"timeout_s": "x"})),
        call("arguments: unknown argument", "", "board_wait", json!({"after": 1})),
        call("head: the head of an empty log", "", "board_wait", json!({})),
        call("head: with a project", "", "board_wait", json!({"project_id": "$p"})),
        call("head: since null", "", "board_wait", json!({"since": null, "timeout_s": 5})),
        call("head: a timeout that is not used", "", "board_wait", json!({"timeout_s": 500})),
        call("head: as a run", "dev", "board_wait", json!({})),
        call("head: as a run that has ended", "ended", "board_wait", json!({})),
        call("wait: nothing happens", "", "board_wait", json!({"since": 0, "timeout_s": 1})),
        call("wait: a negative timeout counts as one second", "", "board_wait", json!({"since": 0, "timeout_s": -5})),
        call("wait: a cursor from the future", "", "board_wait", json!({"since": 99, "timeout_s": 1})),
        // a lesson proposed over MCP tells the owners
        call("lesson: proposed", "", "knowledge", json!({"action": "remember", "project_id": "$p", "text": "Wait for the board."})),
        call("wait: the event", "", "board_wait", json!({"since": 0, "timeout_s": 2})),
        call("wait: only this project", "", "board_wait", json!({"since": 0, "timeout_s": 2, "project_id": "$p"})),
        call("wait: another project", "", "board_wait", json!({"since": 0, "timeout_s": 1, "project_id": "nope"})),
        call("wait: after the head", "", "board_wait", json!({"since": 1, "timeout_s": 1})),
        call("wait: a run reads what is told to it", "dev", "board_wait", json!({"since": 0, "timeout_s": 1})),
        call("wait: another run", "helper", "board_wait", json!({"since": 0, "timeout_s": 1, "project_id": "$p"})),
    ]
}

#[tokio::test]
async fn the_board_wait_tool_answers_as_python_does() {
    let Some(mut fx) = Fx::start("the_board_wait_tool_answers_as_python_does").await else { return };
    fx.setup().await;
    fx.go(board_wait_calls()).await;
    fx.check("mcp_tool_calls_board_wait.json");
}

// ------------------------------------------------------------------------------------------------------ schedules

fn schedule_calls() -> Vec<Step> {
    vec![]
}

#[tokio::test]
async fn the_ai_schedules_tool_answers_as_python_does() {
    let Some(mut fx) = Fx::start("the_ai_schedules_tool_answers_as_python_does").await else { return };
    fx.setup().await;
    fx.go(schedule_calls()).await;
    fx.check("mcp_tool_calls_ai_schedules.json");
}
