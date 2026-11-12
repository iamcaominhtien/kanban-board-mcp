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
#![allow(dead_code)]

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
