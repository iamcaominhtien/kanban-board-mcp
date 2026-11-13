//! Differential scenarios of the AI runs (`services/ai/runs.py`, `runner/main.py`): the same story on the Python
//! server and on the Rust server, with the runs in the server's own process (`KANBAN_RUNNER=inprocess`) and again in
//! the runner process (`process`).
//!
//! A story: a project and a person (routes), an account that is signed in (routes and the stand-in CLI's login
//! file), a team (rows: `POST /projects/{id}/ai/teams` is not ported), a ticket (route), and the run started the way
//! a person starts it through a ported route: `PATCH /tickets/{id}` gives the ticket to the team, which wakes its
//! lead. The stand-in CLI then plays one of its modes. What is compared, after each story has come to rest:
//!
//! - the rows of `ticket`, `ai_run`, `ai_run_step`, `ai_run_agent`, `ai_run_message`, `ai_run_command`, `ai_audit`,
//!   `ai_account_state`, `notify_event` and `notification` (`testkit`'s dump), in a stable order, with ids, times,
//!   tokens, ports, pids, hashes and temporary folders normalized;
//! - the typed events of `GET /events`: per run, the states its `ai.run` events went through and the steps its
//!   `ai.step` events carried, and the kinds of typed events seen.
//!
//! The expected outcome of each story is recorded from the Python server in
//! `contract/golden/ai_runs/<story>.<mode>.json` and compared on both targets:
//!
//! `AI_RUNS_RECORD=1 PARITY_TARGET=python cargo test -p kb-ai-api --test runs_scenarios`
//!
//! What is timing and not behavior is left out of the comparison, and said where it is done: how many batches the
//! steps arrive in (the writer's 250 ms timer), plain `invalidate` announcements (the database watcher's), how long a
//! run took (the work log names minutes and seconds), memory readings, the local time a usage window reopens.

mod common;

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::Duration;

use common::{account, exec, id, insert, login, scalar, team, ticket};
use regex::{Captures, Regex};
use serde_json::{Map, Value, json};
use testkit::{Client, Events, Options, Server, normalize, skip_unless_available, target};

/// At most two stories at a time: every story is a server (and a runner, and CLIs), and a computer that is busy
/// with sixteen of them makes the Python server drop what it may drop (a reading of the account's usage window
/// whose write found the database locked is logged and forgotten, and the next run then starts where it should wait).
struct Turn;

static TURNS: (std::sync::Mutex<usize>, std::sync::Condvar) = (std::sync::Mutex::new(0), std::sync::Condvar::new());

fn turn() -> Turn {
    let (count, freed) = &TURNS;
    let mut running = count.lock().unwrap_or_else(|e| e.into_inner());
    while *running >= 2 {
        running = freed.wait(running).unwrap_or_else(|e| e.into_inner());
    }
    *running += 1;
    Turn
}

impl Drop for Turn {
    fn drop(&mut self) {
        let (count, freed) = &TURNS;
        *count.lock().unwrap_or_else(|e| e.into_inner()) -= 1;
        freed.notify_one();
    }
}

/// One server of a story and the folders that outlive it (a restart starts another server on the same folders).
struct Board {
    server: Server,
    c: Client,
    tmp: PathBuf,
    repo: PathBuf,
}

struct Folders {
    _guard: tempfile::TempDir,
    tmp: PathBuf,
}

fn folders() -> Folders {
    let guard = tempfile::Builder::new().prefix("kb-ai-runs-").tempdir().expect("temporary folder");
    let tmp = guard.path().canonicalize().expect("real path");
    let bin = tmp.join("bin");
    std::fs::create_dir_all(&bin).expect("bin folder");
    let linked = fake_claude::install(&bin, "claude");
    std::fs::remove_file(&linked).expect("remove the link");
    std::fs::copy(fake_claude::bin_path(), &linked).expect("copy the fake CLI");
    std::fs::create_dir_all(tmp.join("claude-config")).expect("claude folder");
    let repo = tmp.join("repo");
    std::fs::create_dir_all(&repo).expect("repo folder");
    std::fs::write(repo.join("calc.py"), "def add(a, b):\n    return a - b\n").expect("calc.py");
    Folders { _guard: guard, tmp }
}

/// Start a server of the current target in `mode` with the stand-in CLI as the only `claude`. `again` is the server
/// this one replaces: it runs on that one's folders (its database, its config, its logs, its workspace).
async fn start(folders: &Folders, mode: &str, fake: &[(&str, &str)], again: Option<&Server>) -> Board {
    let tmp = folders.tmp.clone();
    let path = std::env::join_paths([tmp.join("bin"), PathBuf::from("/usr/bin"), PathBuf::from("/bin")]).expect("PATH");
    let text = |p: PathBuf| p.to_string_lossy().into_owned();
    let mut env: Vec<(String, String)> = vec![
        ("PATH".into(), path.to_string_lossy().into_owned()),
        ("HOME".into(), text(tmp.clone())),
        ("KANBAN_AI_ACCOUNTS_HOME".into(), text(tmp.join("accounts"))),
        ("KANBAN_AI_KEY_FILE".into(), text(tmp.join("ai.key"))),
        ("CLAUDE_CONFIG_DIR".into(), text(tmp.join("claude-config"))),
        ("FAKE_CLAUDE_ACCOUNTS".into(), "1".into()),
        ("KANBAN_RUNNER".into(), mode.into()),
    ];
    if let Some(first) = again {
        let roots = std::env::join_paths([first.dir().to_path_buf(), std::env::temp_dir()]).expect("roots");
        env.extend([
            ("KANBAN_CONFIG_DIR".to_string(), text(first.config_dir())),
            ("KANBAN_DB_PATH".to_string(), text(first.db_path())),
            ("KANBAN_LOG_DIR".to_string(), text(first.log_dir())),
            ("KANBAN_WORKSPACE_ROOT".to_string(), text(first.workspace_root())),
            ("KANBAN_UPLOADS_DIR".to_string(), text(first.uploads_dir())),
            ("KANBAN_AI_ROOTS".to_string(), roots.to_string_lossy().into_owned()),
        ]);
    }
    env.extend(fake.iter().map(|(k, v)| (k.to_string(), v.to_string())));
    let server = Server::start_with(Options { env, ..Options::default() }).await;
    let c = server.client();
    Board { server, c, repo: tmp.join("repo"), tmp }
}

/// A project with one person, a signed-in account and a team on it: (project id, team id, account id).
async fn team_on_an_account(b: &Board, extra: Value) -> (String, String, String) {
    let (pid, _an) = common::project(&b.c).await;
    let a = account(&b.c, "Work");
    let a = a.await;
    login(&a, "an@work.example");
    let account_id = id(&a);
    let checked = b.c.post_empty(&format!("/ai/accounts/{account_id}/check")).await.json();
    assert_eq!(checked["status"], "signed_in", "{checked}");
    let mut columns = json!({"working_dir": b.repo.to_string_lossy(), "account_id": account_id, "health": "ok"});
    for (key, value) in extra.as_object().expect("extra columns") {
        columns[key] = value.clone();
    }
    let team_id = team(&b.server, &pid, "Claude Code · Backend", columns).await;
    (pid, team_id, account_id)
}

/// `PATCH /tickets/{id}` with an assignee: how a person gives a ticket to a team (or takes it away).
async fn assign(b: &Board, ticket_id: &str, assignee: Value) {
    b.c.patch(&format!("/tickets/{ticket_id}"), json!({"assignee": assignee})).await.assert_status(200);
}

/// The typed events received so far, and the stream they come from.
struct Heard {
    events: Events,
    typed: Vec<Value>,
}

impl Heard {
    async fn open(b: &Board) -> Heard {
        Heard { events: b.server.events().await, typed: Vec::new() }
    }

    /// Read events until `done` says yes about a typed one (which is kept), at most `secs` seconds.
    async fn until(&mut self, secs: u64, what: &str, mut done: impl FnMut(&Value) -> bool) -> Value {
        let end = tokio::time::Instant::now() + Duration::from_secs(secs);
        loop {
            let left = end.saturating_duration_since(tokio::time::Instant::now());
            assert!(!left.is_zero(), "timed out waiting for {what}; heard {}", self.summary());
            let Some(data) = self.events.next(left.min(Duration::from_secs(1))).await else { continue };
            let Ok(event) = serde_json::from_str::<Value>(&data) else { continue };
            if !event.is_object() || event["type"] == "invalidate" {
                continue;
            }
            self.typed.push(event.clone());
            if done(&event) {
                return event;
            }
        }
    }

    /// An `ai.run` event of the ticket in one of the states.
    async fn run_state(&mut self, ticket_id: &str, states: &[&str]) -> Value {
        let what = format!("{ticket_id} in {states:?}");
        let event = self
            .until(60, &what, |e| {
                e["type"] == "ai.run"
                    && e["run"]["ticket_id"] == ticket_id
                    && states.contains(&e["run"]["state"].as_str().unwrap_or(""))
            })
            .await;
        event["run"].clone()
    }

    /// Keep listening until nothing has come for a while (what a run does after its last state: notices, tidying).
    async fn rest(&mut self) {
        let mut quiet = 0;
        while quiet < 3 {
            match self.events.next(Duration::from_millis(500)).await {
                Some(data) => {
                    if let Ok(event) = serde_json::from_str::<Value>(&data) {
                        if event.is_object() && event["type"] != "invalidate" {
                            self.typed.push(event);
                        }
                    }
                    quiet = 0;
                }
                None => quiet += 1,
            }
        }
    }

    fn summary(&self) -> String {
        let seen: Vec<String> = self
            .typed
            .iter()
            .map(|e| match e["type"].as_str() {
                Some("ai.run") => format!("run:{}", e["run"]["state"].as_str().unwrap_or("?")),
                Some(other) => other.to_string(),
                None => "?".to_string(),
            })
            .collect();
        seen.join(" ")
    }
}

// ---------------------------------------------------------------------------------------------------------------
// What is compared
// ---------------------------------------------------------------------------------------------------------------

fn patterns() -> &'static [(Regex, &'static str)] {
    static P: OnceLock<Vec<(Regex, &'static str)>> = OnceLock::new();
    P.get_or_init(|| {
        [
            // how long a run took (the work log), and when a usage window reopens (the person's local time)
            // the activity log keeps the first 200 characters of a work log entry: where it is cut depends on how
            // many digits the duration before it has
            (r#"("field": "work_log", "from": null, "to": "\*\*Run #\d+\*\* \w+ \\u00b7 )[^"]*""#, "$1<cut>\""),
            (r"\d+ min \d+ s", "<duration>"),
            (r"reopens [^\x22\\]*", "reopens <when>"),
            (r"\bkbr_[A-Za-z0-9_\-•]+", "<token>"),
            (r"\b[0-9a-f]{64}\b", "<hash>"),
        ]
        .into_iter()
        .map(|(pattern, with)| (Regex::new(pattern).expect("static regex"), with))
        .collect()
    })
}

fn prefixed_id() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| Regex::new(r"\b([a-z]{2,5})_([0-9a-f]{8,})\b").expect("static regex"))
}

/// Ids of the form `run_1a2b3c4d5e6f` numbered by first appearance, folders of this story by name, then what
/// `testkit::normalize` knows (uuids, times, ports).
struct Tidy {
    roots: Vec<(String, &'static str)>,
    seen: HashMap<String, usize>,
}

impl Tidy {
    fn new(b: &Board) -> Tidy {
        let mut roots: Vec<(String, &'static str)> = Vec::new();
        let mut add = |path: &Path, name: &'static str| {
            roots.push((path.to_string_lossy().into_owned(), name));
            if let Ok(real) = path.canonicalize() {
                roots.push((real.to_string_lossy().into_owned(), name));
            }
        };
        add(b.server.dir(), "<board>");
        add(&b.tmp, "<tmp>");
        roots.sort_by_key(|(root, _)| std::cmp::Reverse(root.len()));
        roots.dedup();
        Tidy { roots, seen: HashMap::new() }
    }

    fn text(&mut self, s: &str) -> String {
        let mut out = s.to_string();
        for (root, name) in &self.roots {
            out = out.replace(root.as_str(), name);
        }
        for (pattern, with) in patterns() {
            out = pattern.replace_all(&out, *with).into_owned();
        }
        let seen = &mut self.seen;
        prefixed_id()
            .replace_all(&out, |c: &Captures| {
                let next = seen.len() + 1;
                let n = *seen.entry(c[0].to_string()).or_insert(next);
                format!("{}_<{n}>", &c[1])
            })
            .into_owned()
    }

    fn value(&mut self, v: &Value) -> Value {
        match v {
            Value::String(s) => Value::String(self.text(s)),
            Value::Array(a) => Value::Array(a.iter().map(|x| self.value(x)).collect()),
            Value::Object(m) => Value::Object(m.iter().map(|(k, x)| (k.clone(), self.value(x))).collect()),
            other => other.clone(),
        }
    }
}

/// The tables of a story, each in an order that does not depend on ids: (table, the columns it is sorted by).
const TABLES: [(&str, &[&str]); 10] = [
    ("ticket", &["created_at"]),
    ("ai_run", &["queued_at"]),
    ("ai_run_step", &["id"]),
    ("ai_run_agent", &["started_at"]),
    ("ai_run_message", &["at"]),
    ("ai_run_command", &["id"]),
    ("ai_audit", &["seq"]),
    ("ai_account_state", &["key"]),
    ("notify_event", &["id"]),
    ("notification", &["event_id", "recipient"]),
];

/// Columns that hold a measurement, not behavior: memory readings, and the money a model would have cost (the
/// stand-in CLI names none).
const MEASURED: [(&str, &[&str]); 2] = [
    ("ai_run", &["peak_rss_mb", "last_rss_mb"]),
    ("ai_account_state", &["five_hour_resets_at", "seven_day_resets_at"]),
];

fn sort_key(row: &Value, columns: &[&str]) -> Vec<(i64, String)> {
    columns
        .iter()
        .map(|c| match &row[*c] {
            Value::Number(n) => (n.as_i64().unwrap_or(0), String::new()),
            Value::String(s) => (0, s.clone()),
            _ => (0, String::new()),
        })
        .collect()
}

/// The last steps of a cancelled run in one order. A cancel ends the run from the canceller's task ("Cancelled: …",
/// the run's `end` step) while the run's own task closes the roles its CLI left open (a `role` marker each); in the
/// Python server the two tasks race, and the marker lands before the end step on most runs and after it on some. The
/// end step is put last here, and the step numbers (and row ids) of the steps it passes are handed on in order, so
/// both orders compare equal. `kind`, `number` and `id` read those values of a step; `renumber` writes them back.
fn end_step_last<T: Clone>(
    steps: &mut [T],
    kind: impl Fn(&T) -> String,
    numbers: impl Fn(&T) -> Vec<Value>,
    renumber: impl Fn(&mut T, &[Value]),
) {
    let Some(at) = steps.iter().position(|s| kind(s) == "end") else { return };
    if steps[at + 1..].is_empty() || !steps[at + 1..].iter().all(|s| kind(s) == "role") {
        return;
    }
    let held: Vec<Vec<Value>> = steps[at..].iter().map(&numbers).collect();
    steps[at..].rotate_left(1);
    for (step, numbers) in steps[at..].iter_mut().zip(&held) {
        renumber(step, numbers);
    }
}

/// The compared rows of a dump, sorted and normalized. A JSON text column is compared as the text it is.
fn rows_of(dump: &Value, tidy: &mut Tidy) -> Value {
    let mut out = Map::new();
    for (table, order) in TABLES {
        let mut rows: Vec<Value> = dump[table].as_array().cloned().unwrap_or_default();
        rows.sort_by_key(|row| sort_key(row, order));
        for row in &mut rows {
            for (measured_table, columns) in MEASURED {
                if measured_table == table {
                    for column in columns {
                        // (also when there is none: a CLI that ends within two seconds may never be read)
                        row[*column] = json!("<measured>");
                    }
                }
            }
        }
        if table == "ai_run_step" {
            // (the stories that cancel have one run: its steps are the whole table)
            end_step_last(
                &mut rows,
                |row| row["kind"].as_str().unwrap_or("").to_string(),
                |row| vec![row["id"].clone(), row["seq"].clone(), row["at"].clone()],
                |row, numbers| {
                    row["id"] = numbers[0].clone();
                    row["seq"] = numbers[1].clone();
                    row["at"] = numbers[2].clone();
                },
            );
        }
        let rows: Vec<Value> = rows.iter().map(|row| tidy.value(row)).collect();
        out.insert(table.to_string(), Value::Array(rows));
    }
    normalize(&Value::Object(out))
}

/// The typed events as they are compared: per run (named by its ticket and number), the states of its `ai.run`
/// events without repeats and the steps of its `ai.step` events in order (however many batches they came in);
/// and the kinds of typed events seen.
fn events_of(typed: &[Value], dump: &Value, tidy: &mut Tidy) -> Value {
    let mut names: HashMap<String, String> = HashMap::new();
    for run in dump["ai_run"].as_array().cloned().unwrap_or_default() {
        let name = format!("{}#{}", run["ticket_id"].as_str().unwrap_or("-"), run["number"]);
        names.insert(run["id"].as_str().unwrap_or("").to_string(), name);
    }
    let name_of = |run_id: &Value| names.get(run_id.as_str().unwrap_or("")).cloned().unwrap_or_else(|| "?".to_string());
    let mut states: BTreeMap<String, Vec<String>> = BTreeMap::new();
    let mut steps: BTreeMap<String, Vec<Value>> = BTreeMap::new();
    let mut kinds: BTreeSet<String> = BTreeSet::new();
    for event in typed {
        let kind = event["type"].as_str().unwrap_or("?").to_string();
        match kind.as_str() {
            "ai.run" => {
                let list = states.entry(name_of(&event["run"]["id"])).or_default();
                let state = event["run"]["state"].as_str().unwrap_or("?").to_string();
                if list.last() != Some(&state) {
                    list.push(state);
                }
            }
            "ai.step" => {
                let list = steps.entry(name_of(&event["run_id"])).or_default();
                for step in event["steps"].as_array().cloned().unwrap_or_default() {
                    list.push(json!([step["seq"], step["kind"], step["agent_id"], step["title"]]));
                }
            }
            // the monitor's readings come every two seconds while a CLI runs: none for a short run
            "ai.resources" => continue,
            _ => {}
        }
        kinds.insert(kind);
    }
    for list in steps.values_mut() {
        end_step_last(
            list,
            |step| step[1].as_str().unwrap_or("").to_string(),
            |step| vec![step[0].clone()],
            |step, numbers| step[0] = numbers[0].clone(),
        );
    }
    let out = json!({"states": states, "steps": steps, "kinds": kinds});
    normalize(&tidy.value(&out))
}

/// What a story came to: its rows and its events, ready to compare.
async fn outcome(b: &Board, heard: Option<&Heard>) -> Value {
    let dump = b.server.dump_db().await;
    let mut tidy = Tidy::new(b);
    let rows = rows_of(&dump, &mut tidy);
    let events = match heard {
        Some(heard) => events_of(&heard.typed, &dump, &mut tidy),
        None => Value::Null,
    };
    json!({"rows": rows, "events": events})
}

fn differences(path: &str, want: &Value, got: &Value, out: &mut Vec<String>) {
    match (want, got) {
        (Value::Object(a), Value::Object(b)) => {
            let keys: BTreeSet<&String> = a.keys().chain(b.keys()).collect();
            for key in keys {
                differences(
                    &format!("{path}.{key}"),
                    a.get(key).unwrap_or(&Value::Null),
                    b.get(key).unwrap_or(&Value::Null),
                    out,
                );
            }
        }
        (Value::Array(a), Value::Array(b)) if a.len() == b.len() => {
            for (i, (x, y)) in a.iter().zip(b).enumerate() {
                differences(&format!("{path}[{i}]"), x, y, out);
            }
        }
        (Value::String(a), Value::String(b)) if a != b => {
            // a long text: from a little before where the two part
            let (x, y): (Vec<char>, Vec<char>) = (a.chars().collect(), b.chars().collect());
            let at = x.iter().zip(&y).position(|(p, q)| p != q).unwrap_or(x.len().min(y.len()));
            let part = |t: &[char]| t[at.saturating_sub(80)..(at + 240).min(t.len())].iter().collect::<String>();
            out.push(format!("{path} (at character {at})\n    python: …{}\n    here:   …{}", part(&x), part(&y)));
        }
        _ if want != got => out.push(format!("{path}\n    python: {want}\n    here:   {got}")),
        _ => {}
    }
}

/// Compare with what the Python server did (or record it).
fn check(story: &str, mode: &str, got: Value) {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../contract/golden/ai_runs")
        .join(format!("{story}.{mode}.json"));
    if std::env::var("AI_RUNS_RECORD").is_ok_and(|v| v == "1") {
        assert_eq!(format!("{:?}", target()), "Python", "record from the Python server");
        std::fs::create_dir_all(path.parent().expect("folder")).expect("mkdir");
        let mut text = serde_json::to_string_pretty(&got).expect("json");
        text.push('\n');
        std::fs::write(&path, text).expect("write the golden file");
        return;
    }
    let text = std::fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("{}: {e} (record it with AI_RUNS_RECORD=1 PARITY_TARGET=python)", path.display()));
    let want: Value = serde_json::from_str(&text).expect("golden file parses");
    let mut bad = Vec::new();
    differences("", &want, &got, &mut bad);
    assert!(bad.is_empty(), "{story} ({mode}): {} differences from the Python server:\n{}", bad.len(), bad.join("\n"));
}

/// Stop a server as a crash does (SIGKILL to it and, in `process` mode, to the runner in its process group); the
/// CLIs, each a process group of its own, stay. The folders stay too (the `Server` is kept by the caller).
fn crash(server: &Server) {
    let group = format!("-{}", server.pid());
    let _ = std::process::Command::new("kill").args(["-KILL", "--", &group]).status();
}

fn alive(pid: i64) -> bool {
    match std::fs::read_to_string(format!("/proc/{pid}/stat")) {
        Ok(stat) => stat.rsplit(')').next().is_some_and(|rest| !rest.trim_start().starts_with('Z')),
        Err(_) => false,
    }
}

async fn wait_gone(pid: i64, what: &str) {
    let end = tokio::time::Instant::now() + Duration::from_secs(20);
    while alive(pid) {
        assert!(tokio::time::Instant::now() < end, "{what} (pid {pid}) is still running");
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

/// Nothing of a story is left running: no stand-in CLI started from its folder.
async fn nothing_left(tmp: &Path) {
    let needle = tmp.to_string_lossy().into_owned();
    let end = tokio::time::Instant::now() + Duration::from_secs(15);
    loop {
        let out = std::process::Command::new("pgrep").args(["-af", &needle]).output().expect("pgrep");
        let left: Vec<String> =
            String::from_utf8_lossy(&out.stdout).lines().filter(|l| !l.contains("pgrep")).map(str::to_string).collect();
        if left.is_empty() {
            return;
        }
        assert!(tokio::time::Instant::now() < end, "left running: {left:?}");
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

// ---------------------------------------------------------------------------------------------------------------
// The stories
// ---------------------------------------------------------------------------------------------------------------

/// A run that finishes with a report: steps of the lead and of a role, the closing comment, the work log, a lesson,
/// the notice.
async fn finishes_with_a_report(mode: &str) {
    if !skip_unless_available("finishes_with_a_report") {
        return;
    }
    let _turn = turn();
    let f = folders();
    let b = start(&f, mode, &[("FAKE_CLAUDE_MODE", "v2")], None).await;
    let (pid, team_id, _) = team_on_an_account(&b, json!({})).await;
    let tid = ticket(&b.c, &pid, "Fix add()", "todo").await;
    let mut heard = Heard::open(&b).await;
    assign(&b, &tid, json!(team_id)).await;
    heard.run_state(&tid, &["finished", "failed"]).await;
    heard.rest().await;
    check("finishes_with_a_report", mode, outcome(&b, Some(&heard)).await);
    let tmp = b.tmp.clone();
    b.server.stop().await;
    nothing_left(&tmp).await;
}

/// A run that asks a question and parks. With the runner process the answer comes as the API sends it, a row of the
/// command table (no ported route answers a question yet); the lead then asks again, and the first answer is kept.
async fn asks_a_question(mode: &str) {
    if !skip_unless_available("asks_a_question") {
        return;
    }
    let _turn = turn();
    let f = folders();
    // The lead takes a few seconds for each turn (it waits that long for a message before it asks): the board's
    // notification centre closes the answered question in its own loop, and a lead that asked again at once would
    // race it (the second question then lands before or after the first one's row is closed).
    let fake = [("FAKE_CLAUDE_MODE", "v2_ask"), ("FAKE_CLAUDE_V2_WAIT_MESSAGE", "1"), ("FAKE_CLAUDE_WAIT", "3")];
    let b = start(&f, mode, &fake, None).await;
    let (pid, team_id, _) = team_on_an_account(&b, json!({})).await;
    let tid = ticket(&b.c, &pid, "Fix add()", "todo").await;
    let mut heard = Heard::open(&b).await;
    assign(&b, &tid, json!(team_id)).await;
    let run = heard.run_state(&tid, &["needs_input", "failed", "finished"]).await;
    heard.rest().await;
    if mode == "process" {
        let payload = json!({"by": "An Nguyen", "text": "PostgreSQL"}).to_string();
        insert(
            &b.server,
            "ai_run_command",
            &json!({"run_id": run["id"], "command": "answer", "payload": payload, "created_at": common::NOW}),
        )
        .await;
        heard.run_state(&tid, &["starting"]).await;
        heard.run_state(&tid, &["needs_input", "failed", "finished"]).await;
        heard.rest().await;
    }
    check("asks_a_question", mode, outcome(&b, Some(&heard)).await);
    let tmp = b.tmp.clone();
    b.server.stop().await;
    nothing_left(&tmp).await;
}

/// A CLI that crashes: the run fails with its exit code and what it printed, and says so on the ticket.
async fn crashes(mode: &str) {
    if !skip_unless_available("crashes") {
        return;
    }
    let _turn = turn();
    let f = folders();
    let b = start(&f, mode, &[("FAKE_CLAUDE_MODE", "crash")], None).await;
    let (pid, team_id, _) = team_on_an_account(&b, json!({})).await;
    let tid = ticket(&b.c, &pid, "Fix add()", "todo").await;
    let mut heard = Heard::open(&b).await;
    assign(&b, &tid, json!(team_id)).await;
    heard.run_state(&tid, &["finished", "failed"]).await;
    heard.rest().await;
    check("crashes", mode, outcome(&b, Some(&heard)).await);
    let tmp = b.tmp.clone();
    b.server.stop().await;
    nothing_left(&tmp).await;
}

/// A run that is cancelled: the person takes the ticket away from the team while its lead works.
async fn is_cancelled(mode: &str) {
    if !skip_unless_available("is_cancelled") {
        return;
    }
    let _turn = turn();
    let f = folders();
    let fake = [("FAKE_CLAUDE_MODE", "v2"), ("FAKE_CLAUDE_V2_WAIT_MESSAGE", "1"), ("FAKE_CLAUDE_WAIT", "60")];
    let b = start(&f, mode, &fake, None).await;
    let (pid, team_id, _) = team_on_an_account(&b, json!({})).await;
    let tid = ticket(&b.c, &pid, "Fix add()", "todo").await;
    let mut heard = Heard::open(&b).await;
    assign(&b, &tid, json!(team_id)).await;
    // the lead works: its steps are written and it waits for a message
    heard
        .until(60, "the lead's first words", |e| {
            e["type"] == "ai.step" && e["steps"].as_array().is_some_and(|s| s.iter().any(|x| x["kind"] == "text"))
        })
        .await;
    let cli = scalar(&b.server, "SELECT pid FROM ai_run WHERE ticket_id = ?", &[json!(tid)]).await;
    assign(&b, &tid, Value::Null).await;
    heard.run_state(&tid, &["cancelled"]).await;
    heard.rest().await;
    if let Some(pid) = cli.as_i64() {
        wait_gone(pid, "the cancelled CLI").await;
    }
    check("is_cancelled", mode, outcome(&b, Some(&heard)).await);
    let tmp = b.tmp.clone();
    b.server.stop().await;
    nothing_left(&tmp).await;
}

/// A run that hits the account's weekly limit: it fails, the account is held, the team is marked, and the next run
/// on that account waits for the window.
async fn hits_a_limit_and_the_next_waits(mode: &str) {
    if !skip_unless_available("hits_a_limit_and_the_next_waits") {
        return;
    }
    let _turn = turn();
    let f = folders();
    let b = start(&f, mode, &[("FAKE_CLAUDE_MODE", "window")], None).await;
    let (pid, team_id, _) = team_on_an_account(&b, json!({})).await;
    let first = ticket(&b.c, &pid, "First", "todo").await;
    let mut heard = Heard::open(&b).await;
    assign(&b, &first, json!(team_id)).await;
    heard.run_state(&first, &["finished", "failed"]).await;
    heard.rest().await;
    let second = ticket(&b.c, &pid, "Second", "todo").await;
    assign(&b, &second, json!(team_id)).await;
    heard
        .until(30, "the second run to say what it waits for", |e| {
            e["type"] == "ai.run"
                && e["run"]["ticket_id"] == second.as_str()
                && e["run"]["waiting_reason"].as_str().is_some_and(|w| w.starts_with("Waiting for the next window"))
        })
        .await;
    heard.rest().await;
    let health = scalar(&b.server, "SELECT health FROM ai_team WHERE id = ?", &[json!(team_id)]).await;
    let mut got = outcome(&b, Some(&heard)).await;
    got["team_health"] = health;
    check("hits_a_limit_and_the_next_waits", mode, got);
    let tmp = b.tmp.clone();
    b.server.stop().await;
    nothing_left(&tmp).await;
}

/// A conversation that grew too long: the CLI refuses the prompt and the run fails with what it said.
async fn runs_too_long(mode: &str) {
    if !skip_unless_available("runs_too_long") {
        return;
    }
    let _turn = turn();
    let f = folders();
    let b = start(&f, mode, &[("FAKE_CLAUDE_MODE", "too_long")], None).await;
    let (pid, team_id, _) = team_on_an_account(&b, json!({})).await;
    let tid = ticket(&b.c, &pid, "Fix add()", "todo").await;
    let mut heard = Heard::open(&b).await;
    assign(&b, &tid, json!(team_id)).await;
    heard.run_state(&tid, &["finished", "failed"]).await;
    heard.rest().await;
    check("runs_too_long", mode, outcome(&b, Some(&heard)).await);
    let tmp = b.tmp.clone();
    b.server.stop().await;
    nothing_left(&tmp).await;
}

/// Two tickets behind an account that runs one CLI at a time: the second waits for the slot, then runs.
async fn two_tickets_behind_one_account(mode: &str) {
    if !skip_unless_available("two_tickets_behind_one_account") {
        return;
    }
    let _turn = turn();
    let f = folders();
    let fake = [("FAKE_CLAUDE_MODE", "v2"), ("FAKE_CLAUDE_V2_WAIT_MESSAGE", "1"), ("FAKE_CLAUDE_WAIT", "4")];
    let b = start(&f, mode, &fake, None).await;
    let (pid, team_id, account_id) = team_on_an_account(&b, json!({})).await;
    exec(
        &b.server,
        "INSERT INTO ai_account_state (key, max_parallel, move_urgent) VALUES (?, 1, 0)",
        &[json!(account_id)],
    )
    .await;
    let first = ticket(&b.c, &pid, "First", "todo").await;
    let second = ticket(&b.c, &pid, "Second", "todo").await;
    let mut heard = Heard::open(&b).await;
    assign(&b, &first, json!(team_id)).await;
    heard.run_state(&first, &["starting"]).await;
    assign(&b, &second, json!(team_id)).await;
    let waiting = heard
        .until(30, "the second run to say what it waits for", |e| {
            e["type"] == "ai.run" && e["run"]["ticket_id"] == second.as_str() && !e["run"]["waiting_reason"].is_null()
        })
        .await;
    assert_eq!(waiting["run"]["waiting_reason"], "Waiting for a free slot on the account (1 of 1 in use)");
    // (the two runs end in either order of events; each is waited for by what the database says)
    let end = tokio::time::Instant::now() + Duration::from_secs(60);
    loop {
        let open = scalar(
            &b.server,
            "SELECT count(*) FROM ai_run WHERE state NOT IN ('finished', 'failed', 'cancelled')",
            &[],
        )
        .await;
        if open == json!(0) {
            break;
        }
        assert!(tokio::time::Instant::now() < end, "the two runs never ended");
        heard.rest().await;
    }
    heard.rest().await;
    check("two_tickets_behind_one_account", mode, outcome(&b, Some(&heard)).await);
    let tmp = b.tmp.clone();
    b.server.stop().await;
    nothing_left(&tmp).await;
}

/// The server dies while a lead works and is started again on the same folders: the leftover CLI is stopped, the run
/// goes back to the queue with its conversation and runs to its end. (The events of the second life are not
/// compared: the run is recovered before anyone can listen.)
async fn a_restart_in_the_middle(mode: &str) {
    if !skip_unless_available("a_restart_in_the_middle") {
        return;
    }
    let _turn = turn();
    let f = folders();
    // (a CLI that waits for a message ends by itself when its board dies and its input closes; this one sleeps)
    let first = start(&f, mode, &[("FAKE_CLAUDE_MODE", "sleep")], None).await;
    let (pid, team_id, _) = team_on_an_account(&first, json!({})).await;
    let tid = ticket(&first.c, &pid, "Fix add()", "todo").await;
    let mut heard = Heard::open(&first).await;
    assign(&first, &tid, json!(team_id)).await;
    heard
        .until(60, "the lead's first words", |e| {
            e["type"] == "ai.step" && e["steps"].as_array().is_some_and(|s| s.iter().any(|x| x["kind"] == "text"))
        })
        .await;
    heard.rest().await;
    let cli = scalar(&first.server, "SELECT pid FROM ai_run WHERE ticket_id = ?", &[json!(tid)]).await;
    let cli = cli.as_i64().expect("the pid of the CLI");
    let runner = first.c.get("/ai/runner").await.json()["pid"].as_i64();
    drop(heard);
    crash(&first.server);
    wait_gone(i64::from(first.server.pid()), "the server").await;
    if let Some(runner) = runner {
        wait_gone(runner, "the runner").await;
    }
    assert!(alive(cli), "the CLI outlives the crash of its board");
    let second = start(&f, mode, &[("FAKE_CLAUDE_MODE", "v2")], Some(&first.server)).await;
    wait_gone(cli, "the leftover CLI").await;
    // (the second server runs on the first one's folders: the database is read where the first one has it)
    let end = tokio::time::Instant::now() + Duration::from_secs(60);
    loop {
        let state = scalar(&first.server, "SELECT state FROM ai_run WHERE ticket_id = ?", &[json!(tid)]).await;
        if state == "finished" || state == "failed" {
            break;
        }
        assert!(tokio::time::Instant::now() < end, "the recovered run never ended: {state}");
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
    // what a run does after its last state: the comment, the work log, the notice
    let mut after = Heard::open(&second).await;
    after.rest().await;
    drop(after);
    let dump = first.server.dump_db().await;
    let mut tidy = Tidy::new(&first);
    let rows = rows_of(&dump, &mut tidy);
    check("a_restart_in_the_middle", mode, json!({"rows": rows, "events": null}));
    let tmp = first.tmp.clone();
    second.server.stop().await;
    first.server.stop().await;
    nothing_left(&tmp).await;
}

macro_rules! story {
    ($name:ident) => {
        mod $name {
            #[tokio::test]
            async fn inprocess() {
                super::$name("inprocess").await;
            }

            #[tokio::test]
            async fn process() {
                super::$name("process").await;
            }
        }
    };
}

story!(finishes_with_a_report);
story!(asks_a_question);
story!(crashes);
story!(is_cancelled);
story!(hits_a_limit_and_the_next_waits);
story!(runs_too_long);
story!(two_tickets_behind_one_account);
story!(a_restart_in_the_middle);
