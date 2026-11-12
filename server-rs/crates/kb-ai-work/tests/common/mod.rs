//! Shared by the tests of this crate: one process, one temporary database, and the fixtures `tests/ai_helpers.py` builds
//! (a project, a team with its member row, tickets, runs). Copied from `kb-ai-know/tests/common/mod.rs` (which copied
//! `kb-ai/tests/common/mod.rs`). Rows are inserted through the entities, in the stored formats, where the Python helper
//! went through a route that a later task ports.
//!
//! Every test file is its own process and sets its folders before anything reads them (`init`): the database, the
//! config, the log folder, the workspace root, `CLAUDE_CONFIG_DIR`, `KANBAN_AI_ROOTS`, `HOME`, `TZ` and `PATH` are all
//! inside one temporary folder. The database is process-global, so the tests of a file take `init()`'s lock one after
//! the other and each makes its own project.
//!
//! Added by kb-ai-work (marked "added by kb-ai-work" below): `PATH` is a folder of the test's own (`shim`) that holds
//! only `git` and a few system tools, and a fake `gh` (a shell script that logs its calls and answers from files the
//! test writes: `fake_gh_set`, `fake_gh_calls`), so no test can reach GitHub; `git` helpers for repositories with
//! remotes; the rows of the golden views (`insert_view_rows`); worktree fixtures (`worktrees_on`, `ensure_worktree`);
//! `until` (poll for a condition) and an in-memory `Runs` seam.
#![allow(dead_code)]

use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use kb_db::database;
use kb_db::entities::{ai_project_settings, ai_run, ai_team, member, project, ticket};
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

/// The first `name` found on the PATH the test process started with.
fn find_on_path(name: &str, path: &str) -> Option<PathBuf> {
    std::env::split_paths(path).map(|d| d.join(name)).find(|p| p.is_file())
}

/// Set the folders, open the database and take the lock that makes the tests of this file run one after the other.
#[allow(unsafe_code)]
pub async fn init() -> MutexGuard<'static, ()> {
    let guard = LOCK.lock().await;
    READY
        .get_or_init(|| async {
            let dir = tempfile::tempdir().expect("temporary folder").keep();
            let dir = dir.canonicalize().expect("real path of the temporary folder");
            let original_path = std::env::var("PATH").unwrap_or_default();
            // added by kb-ai-work: a PATH that holds git, a few system tools and the fake gh, nothing else
            let shim = dir.join("shim");
            std::fs::create_dir_all(&shim).expect("shim folder");
            #[cfg(unix)]
            for tool in ["git", "kill", "sleep", "cat", "env", "sh", "true", "false", "mkdir", "touch", "rm", "printf"] {
                if let Some(real) = find_on_path(tool, &original_path) {
                    let _ = std::os::unix::fs::symlink(real, shim.join(tool));
                }
            }
            std::fs::create_dir_all(dir.join("gh")).expect("fake gh folder");
            let gh = shim.join("gh");
            std::fs::write(&gh, FAKE_GH).expect("fake gh");
            make_executable(&gh);
            std::fs::write(dir.join("gitconfig"), "").expect("empty git config");
            // This runs once, before any other thread of this process reads the environment.
            unsafe {
                std::env::set_var("KANBAN_CONFIG_DIR", dir.join("config"));
                std::env::set_var("KANBAN_DB_PATH", dir.join("data").join("kanban.db"));
                std::env::set_var("KANBAN_LOG_DIR", dir.join("logs"));
                std::env::set_var("KANBAN_WORKSPACE_ROOT", dir.join("workspace"));
                std::env::set_var("KANBAN_AI_KEY_FILE", dir.join("ai.key"));
                std::env::set_var("CLAUDE_CONFIG_DIR", dir.join("claude-config"));
                std::env::set_var("KANBAN_AI_RUNS_DIR", dir.join("ai-runs"));
                std::env::set_var("KANBAN_UPLOADS_DIR", dir.join("uploads"));
                std::env::set_var("KANBAN_AI_ROOTS", &dir);
                std::env::set_var("HOME", dir.join("home"));
                std::env::set_var("TZ", "UTC");
                std::env::set_var("PATH", &shim);
                std::env::set_var("GIT_CONFIG_GLOBAL", dir.join("gitconfig"));
                std::env::set_var("GIT_CONFIG_NOSYSTEM", "1");
                std::env::set_var("KB_FAKE_GH_DIR", dir.join("gh"));
                std::env::remove_var("KANBAN_DATABASE_URL");
                std::env::remove_var("KANBAN_RUNNER");
                std::env::remove_var("KANBAN_IN_RUNNER");
                for key in ["GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL"] {
                    std::env::remove_var(key);
                }
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
    pub working_dir: Option<String>,
    pub health: Option<String>,
    pub paused: bool,
}

/// A team as `_runner(c, pid, repo, ...)` made it: its member row (kind `ai`) and its `AiTeam` row.
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
    if let Some(h) = opts.health {
        t.health = Set(h);
    }
    t.paused = Set(opts.paused);
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

/// Change a ticket's status in the table (the board's own code that moves a ticket is a later port).
pub async fn set_status(ticket_id: &str, status: &str) {
    use kb_db::sea_orm::{EntityTrait, IntoActiveModel};
    let session = database::session();
    let row = ticket::Entity::find_by_id(ticket_id).one(&session).await.expect("read").expect("ticket");
    let mut active = row.into_active_model();
    active.status = Set(status.to_string());
    active.update(&session).await.expect("update");
    session.commit().await.expect("commit");
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

/// Set a run's state (the end of a run: `runs._end` is a later port).
pub async fn set_run_state(run_id: &str, state: &str) {
    use kb_db::sea_orm::{EntityTrait, IntoActiveModel};
    let session = database::session();
    let row = ai_run::Entity::find_by_id(run_id).one(&session).await.expect("read").expect("run");
    let mut active = row.into_active_model();
    active.state = Set(state.to_string());
    active.update(&session).await.expect("update");
    session.commit().await.expect("commit");
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

/// `AiProjectSettings(project_id=..., ops=...)`: a model that is not stored.
pub fn settings_model(project_id: &str, ops: Option<&str>) -> ai_project_settings::Model {
    let mut s = ai_project_settings::new();
    s.project_id = Set(project_id.to_string());
    if let Some(ops) = ops {
        s.ops = Set(ops.to_string());
    }
    s.try_into_model().expect("every column has a value")
}

/// Write `files` (path below `root`, text) and make the folders.
pub fn write_files(root: &Path, files: &[(&str, &str)]) {
    for (rel, text) in files {
        let path = root.join(rel);
        std::fs::create_dir_all(path.parent().expect("a parent")).expect("folder");
        std::fs::write(&path, text).expect("file");
    }
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

/// Make `script` executable.
#[cfg(unix)]
pub fn make_executable(script: &Path) {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(script, std::fs::Permissions::from_mode(0o755)).expect("chmod");
}

#[cfg(not(unix))]
pub fn make_executable(_script: &Path) {}

// ---------------------------------------------------------------------------------------------------------------
// added by kb-ai-work
// ---------------------------------------------------------------------------------------------------------------

/// The fake `gh`: logs `<cwd>|<arguments>` to `$KB_FAKE_GH_DIR/calls.log` and answers from `$KB_FAKE_GH_DIR/<a>_<b>.*`
/// (`a` and `b` the first two arguments): `.out` is stdout, `.err` stderr, `.rc` the exit code (0), `.sleep` seconds to
/// wait first. A call nobody prepared an answer for fails with 1 and says so; nothing here ever touches a network.
const FAKE_GH: &str = r#"#!/bin/sh
d="$KB_FAKE_GH_DIR"
echo "$PWD|$*" >> "$d/calls.log"
key="$1_$2"
if [ -f "$d/$key.sleep" ]; then sleep "$(cat "$d/$key.sleep")"; fi
if [ ! -f "$d/$key.out" ] && [ ! -f "$d/$key.err" ] && [ ! -f "$d/$key.rc" ]; then
  echo "fake gh: no answer prepared for: $*" >&2
  exit 1
fi
if [ -f "$d/$key.out" ]; then cat "$d/$key.out"; fi
if [ -f "$d/$key.err" ]; then cat "$d/$key.err" >&2; fi
if [ -f "$d/$key.rc" ]; then exit "$(cat "$d/$key.rc")"; fi
exit 0
"#;

fn gh_dir() -> PathBuf {
    folder().join("gh")
}

/// Forget every prepared answer and every logged call of the fake `gh`.
pub fn fake_gh_reset() {
    let dir = gh_dir();
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).expect("fake gh folder");
}

/// Prepare the fake `gh`'s answer to `gh <a> <b> ...`: stdout, stderr and exit code (`key` is `"pr_view"`, `"pr_create"`).
pub fn fake_gh_set(key: &str, out: &str, err: &str, rc: i32) {
    let dir = gh_dir();
    std::fs::write(dir.join(format!("{key}.out")), out).expect("gh out");
    if !err.is_empty() {
        std::fs::write(dir.join(format!("{key}.err")), err).expect("gh err");
    }
    std::fs::write(dir.join(format!("{key}.rc")), rc.to_string()).expect("gh rc");
}

/// Make the fake `gh` wait `secs` before it answers `key`.
pub fn fake_gh_sleep(key: &str, secs: u32) {
    std::fs::write(gh_dir().join(format!("{key}.sleep")), secs.to_string()).expect("gh sleep");
}

/// The calls the fake `gh` got, one `<cwd>|<arguments>` line each.
pub fn fake_gh_calls() -> Vec<String> {
    std::fs::read_to_string(gh_dir().join("calls.log")).unwrap_or_default().lines().map(str::to_string).collect()
}

/// `git` in `cwd` with the identity the Python tests give it (`-c user.email=t@t -c user.name=T`); returns stdout.
pub fn git(cwd: &Path, args: &[&str]) -> String {
    let out = std::process::Command::new("git")
        .args(["-c", "user.email=t@t", "-c", "user.name=T"])
        .args(args)
        .current_dir(cwd)
        .output()
        .expect("git runs");
    assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
    String::from_utf8_lossy(&out.stdout).into_owned()
}

/// A repository in a new folder of the test's temporary folder, `main` branch, one commit holding `calc.py`; returns its
/// path (the Python `repo` fixture: `env["repo"]` after `git init`, `git add -A`, `git commit`).
pub fn repo(name: &str) -> PathBuf {
    let root = folder().join("repos").join(name);
    std::fs::create_dir_all(&root).expect("repo folder");
    write_files(&root, &[("calc.py", "def add(a, b):\n    return a - b\n")]);
    git(&root, &["init", "-q", "-b", "main"]);
    git(&root, &["add", "-A"]);
    git(&root, &["commit", "-q", "-m", "first"]);
    root.canonicalize().expect("real path")
}

/// A bare repository to push to, added to `repo` as `origin`.
pub fn bare_remote(repo: &Path, name: &str) -> PathBuf {
    let bare = folder().join("remotes").join(format!("{name}.git"));
    std::fs::create_dir_all(&bare).expect("remote folder");
    git(&bare, &["init", "-q", "--bare"]);
    git(repo, &["remote", "add", "origin", &bare.to_string_lossy()]);
    bare
}

/// Turn worktrees on for the project with the hand-over `local` (the Python `_on(c, pid, **extra)`).
pub async fn worktrees_on(project_id: &str, extra: serde_json::Value) {
    let mut wt = serde_json::json!({"on": true, "handover": "local"});
    if let (Some(base), Some(more)) = (wt.as_object_mut(), extra.as_object()) {
        for (k, v) in more {
            base.insert(k.clone(), v.clone());
        }
    }
    set_ops(project_id, serde_json::json!({"worktrees": wt})).await;
}

/// The ticket's worktree as `runs` makes it before a run: `worktrees::ensure` for `fallback_folder` (the team's folder).
pub async fn ensure_worktree(
    ticket: &ticket::Model,
    fallback_folder: &Path,
) -> Result<Option<kb_db::entities::ai_worktree::Model>, kb_ai_work::worktrees::Error> {
    let session = database::session();
    kb_ai_work::worktrees::ensure(&session, ticket, Some(&fallback_folder.to_string_lossy())).await
}

/// Poll `check` every 50 ms until it is true; panics after `secs` seconds.
pub async fn until<F, Fut>(secs: u64, mut check: F)
where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = bool>,
{
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(secs);
    while !check().await {
        assert!(std::time::Instant::now() < deadline, "timed out");
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
}

static VIEW_ROWS: tokio::sync::OnceCell<()> = tokio::sync::OnceCell::const_new();

/// Insert the rows of the golden views (`ai_views_rows.json`, made by `gen_ai_views.py`) once per process: each row is
/// the table's defaults with the columns the generator recorded laid over them.
pub async fn insert_view_rows() {
    VIEW_ROWS
        .get_or_init(|| async {
            use kb_db::entities::{ai_run_agent, ai_run_message, ai_run_step};
            let v = golden("ai_views_rows.json");
            let defaults = v["defaults"].as_object().expect("defaults").clone();
            let session = database::session();
            macro_rules! put {
                ($module:ident, $merged:expr) => {{
                    let model: $module::Model = serde_json::from_value($merged).expect("a row of the table");
                    $module::ActiveModel::from(model).insert(&session).await.expect("insert");
                }};
            }
            for pair in v["rows"].as_array().expect("rows") {
                let table = pair[0].as_str().expect("table");
                let mut merged = defaults[table].clone();
                for (k, val) in pair[1].as_object().expect("columns") {
                    merged[k] = val.clone();
                }
                match table {
                    "member" => put!(member, merged),
                    "ai_team" => put!(ai_team, merged),
                    "ticket" => put!(ticket, merged),
                    "ai_run" => put!(ai_run, merged),
                    "ai_run_agent" => put!(ai_run_agent, merged),
                    "ai_run_step" => put!(ai_run_step, merged),
                    "ai_run_message" => put!(ai_run_message, merged),
                    "ai_project_settings" => put!(ai_project_settings, merged),
                    other => panic!("a table the views do not use: {other}"),
                }
            }
            session.commit().await.expect("commit");
        })
        .await;
}

/// Where two JSON values first differ (a path and both sides), or None when they are equal.
pub fn first_diff(got: &serde_json::Value, want: &serde_json::Value) -> Option<String> {
    use serde_json::Value;
    fn walk(path: &str, a: &Value, b: &Value) -> Option<String> {
        match (a, b) {
            (Value::Object(x), Value::Object(y)) => {
                for (k, v) in x {
                    match y.get(k) {
                        Some(w) => {
                            if let Some(d) = walk(&format!("{path}/{k}"), v, w) {
                                return Some(d);
                            }
                        }
                        None => return Some(format!("{path}/{k}: only in the Rust result: {v}")),
                    }
                }
                y.keys().find(|k| !x.contains_key(*k)).map(|k| format!("{path}/{k}: missing from the Rust result"))
            }
            (Value::Array(x), Value::Array(y)) => {
                for (i, (v, w)) in x.iter().zip(y).enumerate() {
                    if let Some(d) = walk(&format!("{path}/{i}"), v, w) {
                        return Some(d);
                    }
                }
                (x.len() != y.len()).then(|| format!("{path}: {} items in Rust, {} in Python", x.len(), y.len()))
            }
            _ => (a != b).then(|| format!("{path}: rust {a} python {b}")),
        }
    }
    walk("", got, want)
}

/// Assert `got` equals `want`, in values and in the order of every object's keys (what `json.dumps` of both gives).
pub fn assert_same(name: &str, got: &serde_json::Value, want: &serde_json::Value) {
    if let Some(d) = first_diff(got, want) {
        panic!("{name}: {d}");
    }
    assert_eq!(kb_base::pyjson::dumps(got), kb_base::pyjson::dumps(want), "{name}: the order of keys");
}
