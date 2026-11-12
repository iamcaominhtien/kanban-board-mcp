//! Shared by the tests of this crate: one process, one temporary database, and the fixtures `tests/ai_helpers.py` builds
//! (a project, a team with its member row, tickets, runs, a run context). Rows are inserted through the entities, in the
//! stored formats, where the Python helper went through a route that a later task ports.
//!
//! Every test file is its own process and sets its folders before anything reads them (`init`): the database,
//! the config, the log folder, `CLAUDE_CONFIG_DIR`, the AI key file, the transcripts folder and `HOME` are all inside one
//! temporary folder. The database is process-global, so the tests of a file take `init()`'s lock one after the other and
//! each makes its own project. To extend: add a function here that inserts the rows a later module's tests need (a
//! schedule, a worktree, an account) and give it the same shape as `team` (a `...Opts` struct with `Default`).
//!
//! This file is `crates/kb-ai/tests/common/mod.rs` with what the tests of the CLI, the accounts and the sign-in need
//! (everything below "Added for kb-ai-run"): `PATH` holds only a folder with the stand-in CLI under the name `claude`
//! (`fake-claude`, see `crates/fake-claude`) and the system folders, so no test can start a real `claude`;
//! `KANBAN_AI_ROOTS` and `KANBAN_AI_ACCOUNTS_HOME` point into the temporary folder; `init_with` takes more variables
//! (the environment cannot change once the tests run, so what the Python tests set with `monkeypatch.setenv` for a
//! whole file is given there).
//!
//! Added for `teams` and `launch` (everything below "Added for teams and launch"): `KANBAN_WORKSPACE_ROOT`; rows from a
//! golden file put into their tables (`insert_rows`), with the folders of the generator's run replaced by this
//! process's (`to_local`, `to_golden`: `<ROOT>` is `folder()`, `<TMP>` the system's temporary folder, `<TODAY>` today's
//! date in UTC); a long text against its hash and length, printing both texts around the first difference
//! (`same_text`); `team_of` (a team made by `teams::create` on the stand-in CLI, as `_runner` of the Python helpers);
//! `Cancels` (a `seams::Runs` that records what `teams` asks of the runs).
#![allow(dead_code)]

pub mod runs_env;

use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use kb_ai::context::RunContext;
use kb_db::database;
use kb_db::entities::{ai_account, ai_project_settings, ai_run, ai_team, member, project, ticket};
use kb_db::sea_orm::ActiveValue::Set;
use kb_db::sea_orm::{ActiveModelTrait, TryIntoModel};
use tokio::sync::{Mutex, MutexGuard};

static FOLDER: OnceLock<PathBuf> = OnceLock::new();
static LOCK: Mutex<()> = Mutex::const_new(());
static READY: tokio::sync::OnceCell<()> = tokio::sync::OnceCell::const_new();

/// The temporary folder of this process.
pub fn folder() -> &'static Path {
    FOLDER.get().expect("common::init() ran first")
}

/// Set the folders, open the database and take the lock that makes the tests of this file run one after the other.
pub async fn init() -> MutexGuard<'static, ()> {
    init_with(&[]).await
}

/// `init` with more environment variables for the whole test file (the first call of a process decides).
#[allow(unsafe_code)]
pub async fn init_with(extra: &[(&str, &str)]) -> MutexGuard<'static, ()> {
    let guard = LOCK.lock().await;
    READY
        .get_or_init(|| async {
            let dir = tempfile::tempdir().expect("temporary folder").keep();
            let dir = dir.canonicalize().expect("real path of the temporary folder");
            // This runs once, before any other thread of this process reads the environment.
            unsafe {
                std::env::set_var("KANBAN_CONFIG_DIR", dir.join("config"));
                std::env::set_var("KANBAN_DB_PATH", dir.join("data").join("kanban.db"));
                std::env::set_var("KANBAN_LOG_DIR", dir.join("logs"));
                std::env::set_var("KANBAN_AI_KEY_FILE", dir.join("ai.key"));
                std::env::set_var("CLAUDE_CONFIG_DIR", dir.join("claude-config"));
                std::env::set_var("KANBAN_AI_RUNS_DIR", dir.join("ai-runs"));
                std::env::set_var("KANBAN_UPLOADS_DIR", dir.join("uploads"));
                std::env::set_var("KANBAN_WORKSPACE_ROOT", dir.join("workspace"));
                std::env::set_var("HOME", dir.join("home"));
                std::env::remove_var("KANBAN_DATABASE_URL");
                std::env::remove_var("KANBAN_RUNNER");
                std::env::remove_var("KANBAN_IN_RUNNER");
                // Added for kb-ai-run: the stand-in CLI is the only `claude` on PATH, and what a person may name as a
                // folder or a program lives in the temporary folder
                std::env::set_var("KANBAN_AI_ROOTS", &dir);
                std::env::set_var("KANBAN_AI_ACCOUNTS_HOME", dir.join("accounts"));
                std::env::set_var("PATH", format!("{}:/usr/bin:/bin", dir.join("bin").display()));
                for name in [
                    "CLAUDECODE",
                    "CLAUDE_CODE_ENTRYPOINT",
                    "CLAUDE_CODE_SESSION_ID",
                    "KANBAN_CLI_LOW_PRIORITY",
                    "MCP_TOOL_TIMEOUT",
                ] {
                    std::env::remove_var(name);
                }
                for name in ["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY", "CLAUDE_BIN"] {
                    std::env::remove_var(name);
                }
                let fake: Vec<String> =
                    std::env::vars().map(|(k, _)| k).filter(|k| k.starts_with("FAKE_CLAUDE_")).collect();
                for name in fake {
                    std::env::remove_var(name);
                }
                for (name, value) in extra {
                    std::env::set_var(name, value);
                }
            }
            fake_claude::install(&dir.join("bin"), "claude");
            std::fs::create_dir_all(dir.join("home")).expect("home folder");
            FOLDER.set(dir).expect("set once");
            database::setup().await.expect("database setup");
            database::init_db().await.expect("schema");
        })
        .await;
    guard
}

/// A project with one person (`An Nguyen`), as `_project(c)` made through the routes: (project id, member id).
pub async fn project() -> (String, String) {
    let session = database::session();
    let prefix = format!("K{}", kb_base::time::uuid4_hex()[..4].to_uppercase());
    let mut row = project::new();
    row.name = Set("Kanban Board".into());
    row.prefix = Set(prefix);
    row.color = Set("#2E6F40".into());
    row.ticket_counter = Set(0);
    let project = row.insert(&session).await.expect("project");
    let mut an = member::new();
    an.project_id = Set(project.id.clone());
    an.name = Set("An Nguyen".into());
    an.color = Set("#3B82F6".into());
    let an = an.insert(&session).await.expect("member");
    session.commit().await.expect("commit");
    (project.id, an.id)
}

/// What a test sets on a team besides the defaults of the model.
#[derive(Default, Clone)]
pub struct TeamOpts {
    pub account_id: Option<String>,
    pub connection: Option<String>,
    pub provider: Option<String>,
    pub max_runs_per_day: Option<i32>,
    pub working_dir: Option<String>,
}

/// A team on the fake CLI as `_runner(c, pid, repo, ...)` made it: its member row (kind `ai`) and its `AiTeam` row.
pub async fn team(project_id: &str, name: &str, opts: TeamOpts) -> (member::Model, ai_team::Model) {
    let session = database::session();
    let mut m = member::new();
    m.project_id = Set(project_id.to_string());
    m.name = Set(name.to_string());
    m.color = Set("#8B5CF6".into());
    m.kind = Set("ai".into());
    let m = m.insert(&session).await.expect("member");
    let mut t = ai_team::new();
    t.id = Set(m.id.clone());
    t.project_id = Set(project_id.to_string());
    t.model = Set(Some("haiku".into()));
    t.working_dir = Set(opts.working_dir);
    t.account_id = Set(opts.account_id);
    t.max_runs_per_day = Set(opts.max_runs_per_day);
    if let Some(c) = opts.connection {
        t.connection = Set(c);
    }
    if let Some(p) = opts.provider {
        t.provider = Set(p);
    }
    let t = t.insert(&session).await.expect("team");
    session.commit().await.expect("commit");
    (m, t)
}

/// `_ticket(c, pid, title, status)`: a ticket of the project.
pub async fn ticket(project_id: &str, title: &str, status: &str) -> ticket::Model {
    let session = database::session();
    let mut row = ticket::new();
    row.id = Set(format!("T-{}", &kb_base::time::uuid4_hex()[..8]));
    row.project_id = Set(project_id.to_string());
    row.title = Set(title.to_string());
    row.status = Set(status.to_string());
    let row = row.insert(&session).await.expect("ticket");
    session.commit().await.expect("commit");
    row
}

/// A run row: `AiRun(project_id=, ticket_id=, member_id=, state=, ...)`; `edit` sets any other column.
pub async fn run(
    project_id: &str,
    member_id: &str,
    ticket_id: Option<&str>,
    state: &str,
    edit: impl FnOnce(&mut ai_run::ActiveModel),
) -> ai_run::Model {
    let session = database::session();
    let mut row = ai_run::new();
    row.project_id = Set(project_id.to_string());
    row.member_id = Set(member_id.to_string());
    row.ticket_id = Set(ticket_id.map(str::to_string));
    row.state = Set(state.to_string());
    edit(&mut row);
    let row = row.insert(&session).await.expect("run");
    session.commit().await.expect("commit");
    row
}

/// A signed-in Claude account.
pub async fn account(name: &str) -> ai_account::Model {
    let session = database::session();
    let mut row = ai_account::new();
    row.id = Set(format!("acct_{}", &kb_base::time::uuid4_hex()[..8]));
    row.name = Set(name.to_string());
    row.cli = Set("claude".into());
    row.folder = Set(folder().join("accounts").join(name).to_string_lossy().into_owned());
    row.status = Set("signed_in".into());
    let row = row.insert(&session).await.expect("account");
    session.commit().await.expect("commit");
    row
}

/// `_ctx(env)` of the Python helpers: a project, a team, a ticket and a running run whose token is `token`, and the
/// context the guard gives for it.
pub async fn run_context(token: &str) -> (RunContext, String, String, String) {
    let (pid, _an) = project().await;
    let (m, _t) = team(&pid, "Claude Code · Backend", TeamOpts::default()).await;
    let tk = ticket(&pid, "Fix add()", "todo").await;
    let hash = kb_ai::guard::token_hash(token);
    run(&pid, &m.id, Some(&tk.id), "running", |r| {
        r.started_by = Set("An Nguyen".into());
        r.token_hash = Set(Some(hash));
    })
    .await;
    let context = kb_ai::guard::context_for_token(token).await.expect("a live run's token");
    (context, pid, m.id, tk.id)
}

/// `AiTeam(id=..., project_id=..., account_id=...)`: a model that is not stored.
pub fn team_model(id: &str, project_id: &str, account_id: Option<&str>) -> ai_team::Model {
    let mut t = ai_team::new();
    t.id = Set(id.to_string());
    t.project_id = Set(project_id.to_string());
    t.account_id = Set(account_id.map(str::to_string));
    t.try_into_model().expect("every column has a value")
}

/// `AiRun(project_id=..., member_id=...)`: a model that is not stored.
pub fn run_model(project_id: &str, member_id: &str, account_id: Option<&str>) -> ai_run::Model {
    let mut r = ai_run::new();
    r.project_id = Set(project_id.to_string());
    r.member_id = Set(member_id.to_string());
    r.account_id = Set(account_id.map(str::to_string));
    r.try_into_model().expect("every column has a value")
}

/// `AiProjectSettings(project_id=..., ops=...)`: a model that is not stored.
pub fn settings_model(project_id: &str, ops: Option<&str>) -> ai_project_settings::Model {
    let mut s = ai_project_settings::new();
    s.project_id = Set(project_id.to_string());
    if let Some(ops) = ops {
        s.ops = Set(ops.to_string());
    }
    s.try_into_model().expect("every column has a value")
}

/// The golden file `name` of `contract/golden/`, parsed.
pub fn golden(name: &str) -> serde_json::Value {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../contract/golden").join(name);
    let text = std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("read {}: {e}", path.display()));
    serde_json::from_str(&text).unwrap_or_else(|e| panic!("parse {}: {e}", path.display()))
}

/// Empty a table: the tests of one file share a database, and a test that counts rows starts from none.
pub async fn clear<E: kb_db::sea_orm::EntityTrait>() {
    let session = database::session();
    E::delete_many().exec(&session).await.expect("delete");
    session.commit().await.expect("commit");
}

// ---------------------------------------------------------------------------------------------------------------
// Added for kb-ai-run
// ---------------------------------------------------------------------------------------------------------------

/// The stand-in CLI as the board finds it: `<temporary folder>/bin/claude` (`FAKE` of the Python helpers).
pub fn fake_cli() -> String {
    folder().join("bin").join("claude").to_string_lossy().into_owned()
}

/// A new empty folder inside the temporary folder (pytest's `tmp_path`).
pub fn tmp_path(name: &str) -> PathBuf {
    let dir = folder().join("tmp").join(format!("{name}-{}", &kb_base::time::uuid4_hex()[..8]));
    std::fs::create_dir_all(&dir).expect("a folder for the test");
    dir
}

/// The environment a test gives the stand-in CLI: the process's own (as `cli::child_env` builds it) with the mode and
/// more `FAKE_CLAUDE_*` variables (Python: `monkeypatch.setenv("FAKE_CLAUDE_MODE", ...)` before the run starts).
pub fn fake_env(mode: &str, more: &[(&str, &str)]) -> kb_ai::profiles::Env {
    let mut env = kb_ai_run::cli::child_env(None);
    env.push(("FAKE_CLAUDE_MODE".to_string(), mode.to_string()));
    env.extend(more.iter().map(|(k, v)| (k.to_string(), v.to_string())));
    env
}

/// The arguments of a run as the launcher builds them, as far as the stand-in reads them: a prompt and a new session.
pub fn stream_args(prompt: &str, session: &str) -> Vec<String> {
    [&fake_cli(), "-p", prompt, "--output-format", "stream-json", "--verbose", "--session-id", session]
        .iter()
        .map(|a| a.to_string())
        .collect()
}

/// The arguments of a live run: the prompt and later messages arrive on stdin.
pub fn live_args(session: &str) -> Vec<String> {
    [
        &fake_cli(),
        "-p",
        "--input-format",
        "stream-json",
        "--output-format",
        "stream-json",
        "--verbose",
        "--session-id",
        session,
    ]
    .iter()
    .map(|a| a.to_string())
    .collect()
}

/// Wait until `ready` says yes (`_until` of the Python tests): polls every 50 ms, panics after `seconds`.
pub async fn until(what: &str, seconds: f64, mut ready: impl FnMut() -> bool) {
    let end = std::time::Instant::now() + std::time::Duration::from_secs_f64(seconds);
    while !ready() {
        assert!(std::time::Instant::now() < end, "timed out waiting for {what}");
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
}

/// Whether a process is still there (`os.kill(pid, 0)`); a zombie counts as gone.
pub fn alive(pid: i32) -> bool {
    match std::fs::read_to_string(format!("/proc/{pid}/stat")) {
        // the state follows the command name in parentheses
        Ok(stat) => stat.rsplit(')').next().is_some_and(|rest| !rest.trim_start().starts_with('Z')),
        Err(_) => false,
    }
}

/// What a finished sign-in leaves in the stand-in CLI's folder (`_login(account, email)`).
pub fn login(account_folder: &str, email: &str) {
    std::fs::create_dir_all(account_folder).expect("the account's folder");
    std::fs::write(Path::new(account_folder).join(".fake-login"), email).expect("the login file");
}

/// A script the test can run as a program: `#!/bin/sh` and the text, executable.
pub fn script(folder: &Path, name: &str, text: &str, executable: bool) -> PathBuf {
    use std::os::unix::fs::PermissionsExt;
    std::fs::create_dir_all(folder).expect("the script's folder");
    let path = folder.join(name);
    std::fs::write(&path, format!("#!/bin/sh\n{text}\n")).expect("the script");
    let mode = if executable { 0o755 } else { 0o644 };
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(mode)).expect("the script's mode");
    path
}

// ---------------------------------------------------------------------------------------------------------------
// Added for teams and launch
// ---------------------------------------------------------------------------------------------------------------

/// The system's temporary folder as texts name it (`tempfile.gettempdir()`).
pub fn tmp_text() -> String {
    std::env::temp_dir().to_string_lossy().trim_end_matches('/').to_string()
}

/// Today's date in UTC (`<TODAY>` of the golden files).
pub fn today() -> String {
    chrono::Utc::now().date_naive().to_string()
}

/// A text of a golden file with this process's folders in place of `<ROOT>`, `<TMP>` and `<TODAY>`.
pub fn local_text(text: &str) -> String {
    text.replace("<ROOT>", &folder().to_string_lossy()).replace("<TMP>", &tmp_text()).replace("<TODAY>", &today())
}

/// A value of a golden file with this process's folders in every text and key (`local_text`).
pub fn to_local(value: &serde_json::Value) -> serde_json::Value {
    use serde_json::Value;
    match value {
        Value::String(s) => Value::String(local_text(s)),
        Value::Array(items) => Value::Array(items.iter().map(to_local).collect()),
        Value::Object(map) => Value::Object(map.iter().map(|(k, v)| (local_text(k), to_local(v))).collect()),
        other => other.clone(),
    }
}

/// A text this process made, as the golden file writes it: `<ROOT>` and `<TMP>` in place of this process's folders
/// (a test whose rows hold `<TODAY>` puts that back itself).
pub fn golden_text(text: &str) -> String {
    text.replace(&*folder().to_string_lossy(), "<ROOT>").replace(&tmp_text(), "<TMP>")
}

/// A value this process made, as the golden file writes it (`golden_text`).
pub fn to_golden(value: &serde_json::Value) -> serde_json::Value {
    use serde_json::Value;
    match value {
        Value::String(s) => Value::String(golden_text(s)),
        Value::Array(items) => Value::Array(items.iter().map(to_golden).collect()),
        Value::Object(map) => Value::Object(map.iter().map(|(k, v)| (golden_text(k), to_golden(v))).collect()),
        other => other.clone(),
    }
}

async fn put<E>(rows: &[serde_json::Value])
where
    E: kb_db::sea_orm::EntityTrait,
    E::Model: serde::de::DeserializeOwned + kb_db::sea_orm::IntoActiveModel<E::ActiveModel>,
    E::ActiveModel: ActiveModelTrait<Entity = E> + kb_db::sea_orm::ActiveModelBehavior + Send,
{
    let session = database::session();
    for row in rows {
        let model: E::Model = serde_json::from_value(to_local(row))
            .unwrap_or_else(|e| panic!("a row of {}: {e}: {row}", E::default().table_name()));
        let active = kb_db::sea_orm::IntoActiveModel::into_active_model(model).reset_all();
        E::insert(active).exec_without_returning(&session).await.expect("insert");
    }
    session.commit().await.expect("commit");
}

/// Put the rows of a golden file into `table` as the Python models dumped them (`<ROOT>` and the other marks replaced
/// by this process's). The one row of `workspace_settings` replaces the one that is there.
pub async fn insert_rows(table: &str, rows: &[serde_json::Value]) {
    use kb_db::entities as e;
    match table {
        "project" => put::<e::project::Entity>(rows).await,
        "member" => put::<e::member::Entity>(rows).await,
        "ai_team" => put::<e::ai_team::Entity>(rows).await,
        "ticket" => put::<e::ticket::Entity>(rows).await,
        "ai_run" => put::<e::ai_run::Entity>(rows).await,
        "ai_project_settings" => put::<e::ai_project_settings::Entity>(rows).await,
        "ai_plugin" => put::<e::ai_plugin::Entity>(rows).await,
        "ai_project_knowledge" => put::<e::ai_project_knowledge::Entity>(rows).await,
        "ai_lesson" => put::<e::ai_lesson::Entity>(rows).await,
        "ai_memory_note" => put::<e::ai_memory_note::Entity>(rows).await,
        "ai_role_pack" => put::<e::ai_role_pack::Entity>(rows).await,
        "ai_account" => put::<e::ai_account::Entity>(rows).await,
        "workspace_settings" => {
            clear::<e::workspace_settings::Entity>().await;
            put::<e::workspace_settings::Entity>(rows).await;
        }
        other => panic!("no table {other} in insert_rows"),
    }
}

/// Every table of a golden case's `rows`, in an order that suits a reader of the database.
pub async fn insert_all(rows: &serde_json::Value) {
    for (table, list) in rows.as_object().expect("rows by table") {
        insert_rows(table, list.as_array().expect("a list of rows")).await;
    }
}

fn sha256_hex(text: &str) -> String {
    use sha2::Digest;
    sha2::Sha256::digest(text.as_bytes()).iter().map(|b| format!("{b:02x}")).collect()
}

/// `got` (already written as the golden file writes paths) against `want`: the text itself when it is short, else
/// `{sha256, chars}` with the text in `blobs`. On a mismatch both texts are printed around the first difference.
pub fn same_text(got: &str, want: &serde_json::Value, blobs: &serde_json::Value, what: &str) {
    let expected: Option<&str> = match want {
        serde_json::Value::String(s) => Some(s.as_str()),
        other => {
            let sha = other["sha256"].as_str().unwrap_or_else(|| panic!("{what}: neither a text nor a hash: {other}"));
            if sha256_hex(got) == sha && got.chars().count() as u64 == other["chars"].as_u64().unwrap_or(u64::MAX) {
                return;
            }
            blobs[sha].as_str()
        }
    };
    let Some(expected) = expected else {
        panic!("{what}: the text differs and the golden file does not hold the expected one:\n{got}");
    };
    // a path written out in the golden file (`/tmp/pictures/...`) may sit under this machine's temporary folder, which
    // `golden_text` replaced on the Rust side: compare both sides in the golden spelling
    let (got, expected) = (golden_text(got), golden_text(expected));
    if got == expected {
        return;
    }
    let (g, e): (Vec<char>, Vec<char>) = (got.chars().collect(), expected.chars().collect());
    let at = g.iter().zip(&e).position(|(a, b)| a != b).unwrap_or(g.len().min(e.len()));
    let around = |text: &[char]| -> String {
        let from = at.saturating_sub(160);
        let to = (at + 160).min(text.len());
        text[from..to].iter().collect()
    };
    panic!(
        "{what}: differs at character {at} (lengths {} and {})\n--- Rust ---\n{}\n--- Python ---\n{}\n",
        g.len(),
        e.len(),
        around(&g),
        around(&e)
    );
}

/// `_runner(c, pid, repo, name=...)` of the Python helpers at service level: what `POST /projects/{id}/ai/teams` does
/// (`teams::create`, `teams::test_connection`, `teams::describe`) with the stand-in CLI and a folder as its working
/// folder. `extra` adds to the body or replaces its keys.
pub async fn team_of(
    project_id: &str,
    name: &str,
    extra: serde_json::Value,
) -> serde_json::Map<String, serde_json::Value> {
    use kb_ai_run::teams;
    let repo = tmp_path("repo");
    std::fs::write(repo.join("calc.py"), "def add(a, b):\n    return a - b\n").expect("calc.py");
    let mut body = serde_json::json!({
        "name": name,
        "working_dir": repo.to_string_lossy(),
        "cli_path": real_cli(),
        "model": "haiku",
    });
    for (k, v) in extra.as_object().cloned().unwrap_or_default() {
        body[k] = v;
    }
    let session = database::session();
    let member =
        teams::create(&session, project_id, body.as_object().expect("body"), "An Nguyen").await.expect("create");
    teams::test_connection(&session, &member.id).await.expect("test");
    described(&member.id).await
}

/// `GET /ai/teams/{id}` at service level: the team, described.
pub async fn described(member_id: &str) -> serde_json::Map<String, serde_json::Value> {
    use kb_ai_run::teams;
    let session = database::session();
    let (member, profile) = teams::get_profile(&session, member_id).await.expect("rows");
    teams::describe(&session, &member.expect("member"), &profile.expect("profile"), None).await.expect("describe")
}

/// A `seams::Runs` that records what `teams` asks of the runs: the cancelled runs and how often the scheduler was
/// woken.
#[derive(Default)]
pub struct Cancels {
    /// (run id, by, reason) of each `cancel`.
    pub cancelled: std::sync::Mutex<Vec<(String, String, String)>>,
    /// How often `wake` was called.
    pub woken: std::sync::atomic::AtomicUsize,
    /// What `cancel` answers; None: it succeeds.
    pub refuse: std::sync::Mutex<Option<kb_ai_run::seams::CancelError>>,
}

#[async_trait::async_trait]
impl kb_ai_run::seams::Runs for Cancels {
    async fn cancel(&self, run_id: &str, by: &str, reason: &str) -> Result<(), kb_ai_run::seams::CancelError> {
        self.cancelled.lock().expect("lock").push((run_id.into(), by.into(), reason.into()));
        match self.refuse.lock().expect("lock").clone() {
            Some(err) => Err(err),
            None => Ok(()),
        }
    }

    fn wake(&self) {
        self.woken.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    }
}

/// The stand-in CLI as a file of its own inside the folders a person may name a program in (`fake_cli()` is a link
/// to the build folder, which a configured path may not lead to): what a team's `cli_path` is set to (`FAKE` of the
/// Python helpers).
pub fn real_cli() -> String {
    let path = folder().join("tools").join("claude");
    if !path.is_file() {
        std::fs::create_dir_all(folder().join("tools")).expect("the tools folder");
        // copied under another name first, so that a test that runs at the same time never starts half a file
        let part = folder().join("tools").join(format!("claude-{}", kb_base::time::uuid4_hex()));
        std::fs::copy(fake_claude::bin_path(), &part).expect("copy of the stand-in CLI");
        std::fs::rename(&part, &path).expect("the stand-in CLI in place");
    }
    path.to_string_lossy().into_owned()
}

/// A run of a team that is about to start (`AiRun(project_id=, ticket_id=, member_id=, state="starting",
/// started_by="An")`) and what `launch::prepare` gives for it, with the team's working folder as the run's folder.
pub async fn launch_of(
    team_id: &str,
    ticket_id: Option<&str>,
    token: &str,
    session_id: &str,
) -> kb_ai_run::launch::Launch {
    let session = database::session();
    let (m, profile) = kb_ai_run::teams::get_profile(&session, team_id).await.expect("rows");
    let (m, profile) = (m.expect("member"), profile.expect("profile"));
    drop(session);
    let run = run(&m.project_id, team_id, ticket_id, "starting", |r| r.started_by = Set("An".into())).await;
    let cwd = profile.working_dir.clone().unwrap_or_else(|| tmp_path("cwd").to_string_lossy().into_owned());
    let session = database::session();
    kb_ai_run::launch::prepare(
        &session,
        &run,
        &profile,
        &m,
        kb_ai_run::launch::PrepareOpts {
            token,
            board_url: "http://127.0.0.1:9",
            cwd: &cwd,
            session_id,
            ..Default::default()
        },
    )
    .await
    .expect("prepare")
}

/// The value after `name` in a command line (`_flag(args, name)`).
pub fn flag(args: &[String], name: &str) -> String {
    let at = args.iter().position(|a| a == name).unwrap_or_else(|| panic!("no {name} in {args:?}"));
    args[at + 1].clone()
}

/// A plugin row as `tests/test_ai_launch_v2.py` builds it: a folder with a manifest, one skill, the roles it is
/// suggested for.
pub async fn plugin_row(
    project_id: &str,
    folder: &Path,
    name: &str,
    roles: &[&str],
    edit: impl FnOnce(&mut kb_db::entities::ai_plugin::ActiveModel),
) -> kb_db::entities::ai_plugin::Model {
    std::fs::create_dir_all(folder.join(".claude-plugin")).expect("manifest folder");
    let session = database::session();
    let mut row = kb_db::entities::ai_plugin::new();
    row.project_id = Set(Some(project_id.to_string()));
    row.name = Set(name.to_string());
    row.source = Set(format!("https://example.com/{name}"));
    row.path = Set(Some(folder.to_string_lossy().into_owned()));
    row.skills = Set(serde_json::to_string(&[format!("{name}-skill")]).expect("json"));
    row.roles = Set(serde_json::to_string(roles).expect("json"));
    edit(&mut row);
    let row = row.insert(&session).await.expect("plugin");
    session.commit().await.expect("commit");
    row
}

/// Merge `patch` into the project's AI settings (`ops.update` and a commit).
pub async fn set_ops(project_id: &str, patch: serde_json::Value) {
    let session = database::session();
    let mut settings = kb_ai::store::get_settings(&session, project_id).await.expect("settings");
    kb_ai::ops::update(&mut settings, patch.as_object().expect("an object"));
    kb_ai::store::save(&session, settings).await.expect("save");
    session.commit().await.expect("commit");
}
