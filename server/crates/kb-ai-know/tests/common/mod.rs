//! Shared by the tests of this crate: one process, one temporary database, and the fixtures `tests/ai_helpers.py` builds
//! (a project, a team with its member row, tickets, runs, a run context). Copied from `kb-ai/tests/common/mod.rs`; what
//! this crate added is at the end (marked "added by kb-ai-know"): `TeamOpts::{config, pack_key, cli_path}`, a plugin
//! row, a git repository of files, a `Cli` seam that runs a script, a project's AI settings, and text digests. Rows are inserted through the entities, in the
//! stored formats, where the Python helper went through a route that a later task ports.
//!
//! Every test file is its own process and sets its folders before anything reads them (`init`): the database,
//! the config, the log folder, `CLAUDE_CONFIG_DIR`, the AI key file, the transcripts folder and `HOME` are all inside one
//! temporary folder. The database is process-global, so the tests of a file take `init()`'s lock one after the other and
//! each makes its own project. To extend: add a function here that inserts the rows a later module's tests need (a
//! schedule, a worktree, an account) and give it the same shape as `team` (a `...Opts` struct with `Default`).
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
#[allow(unsafe_code)]
pub async fn init() -> MutexGuard<'static, ()> {
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
                std::env::remove_var("KANBAN_AI_ROOTS");
            }
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
    /// The team's `config` JSON text (added by kb-ai-know).
    pub config: Option<String>,
    /// The team's `pack_key` (added by kb-ai-know).
    pub pack_key: Option<String>,
    /// The team's `cli_path` (added by kb-ai-know).
    pub cli_path: Option<String>,
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
    if let Some(c) = opts.config {
        t.config = Set(c);
    }
    t.pack_key = Set(opts.pack_key);
    t.cli_path = Set(opts.cli_path);
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
// added by kb-ai-know
// ---------------------------------------------------------------------------------------------------------------

use std::collections::HashMap;
use std::process::Command;
use std::sync::Arc;

use kb_db::entities::ai_plugin;
use sha2::{Digest, Sha256};

/// `{sha256, chars, bytes}` of a text, as `gen_*.py` writes them.
pub fn digest(text: &str) -> (String, usize, usize) {
    (format!("{:x}", Sha256::digest(text.as_bytes())), text.chars().count(), text.len())
}

/// The digest of a golden `{sha256, chars, bytes}` entry.
pub fn digest_of(v: &serde_json::Value) -> (String, usize, usize) {
    (
        v["sha256"].as_str().expect("sha256").to_string(),
        v["chars"].as_u64().expect("chars") as usize,
        v["bytes"].as_u64().expect("bytes") as usize,
    )
}

/// SHA-256 of bytes.
pub fn sha256_hex(data: &[u8]) -> String {
    format!("{:x}", Sha256::digest(data))
}

/// Write `files` (path below `root`, text) and make the folders.
pub fn write_files(root: &Path, files: &[(&str, &str)]) {
    for (rel, text) in files {
        let path = root.join(rel);
        std::fs::create_dir_all(path.parent().expect("a parent")).expect("folder");
        std::fs::write(&path, text).expect("file");
    }
}

/// A git repository in `root` holding `files`, with one commit; returns the commit. No network, no signing, no hooks.
pub fn git_repo(root: &Path, files: &[(&str, &str)]) -> String {
    std::fs::create_dir_all(root).expect("folder");
    write_files(root, files);
    let git = |args: &[&str]| {
        let out = Command::new("git")
            .args(["-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false"])
            .args(args)
            .current_dir(root)
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .env("GIT_CONFIG_SYSTEM", "/dev/null")
            .output()
            .expect("git runs");
        assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
        String::from_utf8_lossy(&out.stdout).trim().to_string()
    };
    git(&["init", "-q", "-b", "main"]);
    git(&["add", "-A"]);
    git(&["commit", "-q", "-m", "first"]);
    git(&["rev-parse", "HEAD"])
}

/// Another commit in the repository: `files` written over the old ones, then everything added.
pub fn git_commit(root: &Path, files: &[(&str, &str)], message: &str) -> String {
    write_files(root, files);
    let run = |args: &[&str]| {
        let out = Command::new("git")
            .args(["-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false"])
            .args(args)
            .current_dir(root)
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .env("GIT_CONFIG_SYSTEM", "/dev/null")
            .output()
            .expect("git runs");
        assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
        String::from_utf8_lossy(&out.stdout).trim().to_string()
    };
    run(&["add", "-A"]);
    run(&["commit", "-q", "-m", message]);
    run(&["rev-parse", "HEAD"])
}

/// A plugin row as `tests/test_ai_launch_v2.py` builds it: a folder with a manifest, one skill, the roles it is
/// suggested for.
pub async fn plugin_row(
    project_id: &str,
    folder: &Path,
    name: &str,
    roles: &[&str],
    edit: impl FnOnce(&mut ai_plugin::ActiveModel),
) -> ai_plugin::Model {
    std::fs::create_dir_all(folder.join(".claude-plugin")).expect("manifest folder");
    let session = database::session();
    let mut row = ai_plugin::new();
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
    let patch = patch.as_object().expect("an object").clone();
    kb_ai::ops::update(&mut settings, &patch);
    let ops_text = settings.ops.clone();
    let mut active = kb_db::entities::ai_project_settings::ActiveModel::from(settings);
    active.ops = Set(ops_text);
    active.update(&session).await.expect("save");
    session.commit().await.expect("commit");
}

/// The `cli` / `accounts` seam of the light model, with a script in place of `claude`: `find_cli` answers the script, the
/// environment is `PATH` and `HOME`, and `kill_tree` is `kill -9`.
pub struct ScriptCli {
    /// The script that stands in for the CLI.
    pub script: PathBuf,
}

impl kb_ai_know::seams::Cli for ScriptCli {
    fn find_cli(&self, _kind: &str, _cli_path: Option<&str>) -> Option<String> {
        Some(self.script.to_string_lossy().into_owned())
    }
    fn child_env(&self) -> HashMap<String, String> {
        let mut env = HashMap::new();
        env.insert("PATH".to_string(), std::env::var("PATH").unwrap_or_default());
        env.insert("HOME".to_string(), std::env::var("HOME").unwrap_or_default());
        env
    }
    fn env_for_account(&self, _account: &ai_account::Model, env: HashMap<String, String>) -> HashMap<String, String> {
        env
    }
    fn kill_tree(&self, pid: u32) {
        let _ = Command::new("kill").args(["-9", &pid.to_string()]).status();
    }
}

/// Fill the `cli` seam with a `ScriptCli` of `script`.
pub fn use_script_cli(script: &Path) {
    kb_ai_know::seams::set_cli(Some(Arc::new(ScriptCli { script: script.to_path_buf() })));
}

/// Make `script` executable.
#[cfg(unix)]
pub fn make_executable(script: &Path) {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(script, std::fs::Permissions::from_mode(0o755)).expect("chmod");
}
