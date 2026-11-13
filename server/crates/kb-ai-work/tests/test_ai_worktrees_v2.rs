//! Port of `server/tests/test_ai_worktrees_v2.py`: where a team works and how its code is handed over, against real git
//! repositories in a temporary folder: one worktree per ticket beside the repo with a port of its own, nothing written
//! into the repo, merging only when a person asks, a conflict rolled back, uncommitted work never removed.
//!
//! The Python tests drive a full run (the fake CLI through `runs`, the REST routes of `api/ai_code.py`). Here the run is
//! replaced by what it did to the worktree: `worktrees::ensure` is what `runs` calls before it starts the CLI, and the
//! commit the fake CLI made (`FAKE_CLAUDE_COMMIT`) or the files it left (`FAKE_CLAUDE_LEAVE`) are written by the test.
//! What needs the CLI, `runs` or a route is listed at the end of this file (each name with what it waits for).

mod common;

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use kb_ai_work::worktrees::{self, Error, Handover};
use kb_db::database;
use kb_db::entities::{ai_run, ai_worktree, ticket};
use kb_db::sea_orm::{ActiveModelTrait, ActiveValue::Set, EntityTrait, IntoActiveModel};
use serde_json::{Value, json};

/// A project with worktrees on, a team on `repo`, one ticket and its worktree, as `_setup_ticket` made them.
async fn setup_ticket(repo: &Path, extra: Value) -> (String, ticket::Model, ai_worktree::Model) {
    let (pid, _) = common::project().await;
    common::worktrees_on(&pid, extra).await;
    common::team(
        &pid,
        "Claude Code · Backend",
        common::TeamOpts { working_dir: Some(repo.to_string_lossy().into_owned()), ..Default::default() },
    )
    .await;
    let t = common::ticket(&pid, "Fix add()", "todo").await;
    let row = common::ensure_worktree(&t, repo).await.expect("ensure").expect("a worktree");
    (pid, t, row)
}

/// What `FAKE_CLAUDE_COMMIT` does: the AI changes calc.py and commits it on its branch.
fn ai_commit(worktree: &str, body: &str) {
    let dir = Path::new(worktree);
    std::fs::write(dir.join("calc.py"), body).expect("calc.py");
    common::git(dir, &["add", "-A"]);
    common::git(dir, &["-c", "user.email=ai@test", "-c", "user.name=AI", "commit", "-m", "AI change"]);
}

async fn row_of(tid: &str) -> Option<ai_worktree::Model> {
    let session = database::session();
    ai_worktree::Entity::find_by_id(tid).one(&session).await.expect("read")
}

fn read(path: impl AsRef<Path>) -> String {
    std::fs::read_to_string(path).expect("a file")
}

#[tokio::test]
async fn test_a_ticket_works_in_its_own_worktree_beside_the_repo_with_a_port() {
    let _g = common::init().await;
    let repo = common::repo("beside");
    let (pid, _) = common::project().await;
    common::worktrees_on(&pid, json!({"base_port": 5190})).await;
    let t = common::ticket(&pid, "Fix add()", "todo").await;
    let row = common::ensure_worktree(&t, &repo).await.expect("ensure").expect("a worktree");
    // the folder the CLI is started in (the Python test reads it from the fake CLI's record)
    let expected = repo
        .parent()
        .expect("parent")
        .join(format!("{}.worktrees", repo.file_name().expect("name").to_string_lossy()))
        .join(&t.id);
    assert_eq!(Path::new(&row.path).canonicalize().expect("real"), expected.canonicalize().expect("real"));
    assert!(row.branch.starts_with(&format!("ai/{}-fix-add", t.id)) && row.base == "main");
    assert_eq!(row.port, Some(5190));
    let session = database::session();
    let live = worktrees::status(&row).await.expect("status");
    assert!(row.state == "active" && live.exists);
    // nothing the board wrote landed in the repository
    assert!(!repo.join(".claude").exists());
    let listing = worktrees::list_for_project(&session, &pid).await.expect("listing");
    let ids: Vec<&str> = listing.iter().map(|w| w["ticket_id"].as_str().expect("id")).collect();
    assert_eq!(ids, vec![t.id.as_str()]);
}

#[tokio::test]
async fn test_the_same_ticket_keeps_its_worktree_and_another_gets_the_next_port() {
    let _g = common::init().await;
    let repo = common::repo("ports");
    let (pid, _) = common::project().await;
    common::worktrees_on(&pid, json!({"base_port": 5300})).await;
    let t1 = common::ticket(&pid, "One", "todo").await;
    let t2 = common::ticket(&pid, "Two", "todo").await;
    common::ensure_worktree(&t1, &repo).await.expect("ensure").expect("one");
    common::ensure_worktree(&t2, &repo).await.expect("ensure").expect("two");
    let session = database::session();
    let ports: std::collections::HashMap<String, Option<i32>> = worktrees::list_for_project(&session, &pid)
        .await
        .expect("listing")
        .iter()
        .map(|w| (w["ticket_id"].as_str().expect("id").to_string(), w["port"].as_i64().map(|p| p as i32)))
        .collect();
    assert_eq!(ports, [(t1.id.clone(), Some(5300)), (t2.id.clone(), Some(5301))].into_iter().collect());
    let first = row_of(&t1.id).await.expect("first");
    let again =
        worktrees::ensure(&session, &t1, Some(&repo.to_string_lossy())).await.expect("ensure").expect("a worktree");
    assert!(again.path == first.path && again.port == Some(5300));
}

#[tokio::test]
async fn test_a_folder_that_is_not_a_repository_falls_back_to_the_shared_folder() {
    let _g = common::init().await;
    let folder = common::folder().join("repos").join("never-initialised");
    std::fs::create_dir_all(&folder).expect("folder");
    let (pid, _) = common::project().await;
    common::worktrees_on(&pid, json!({})).await;
    let t = common::ticket(&pid, "Fix add()", "todo").await;
    // the run then uses the team's own folder (the Python test reads the CLI's working folder)
    assert!(common::ensure_worktree(&t, &folder).await.expect("ensure").is_none());
    assert!(row_of(&t.id).await.is_none());
}

#[tokio::test]
async fn test_with_worktrees_off_the_team_keeps_its_own_folder() {
    let _g = common::init().await;
    let repo = common::repo("off");
    let (pid, _) = common::project().await;
    let t = common::ticket(&pid, "Fix add()", "todo").await;
    assert!(common::ensure_worktree(&t, &repo).await.expect("ensure").is_none());
    assert!(row_of(&t.id).await.is_none());
    assert!(!repo.parent().expect("parent").join("off.worktrees").exists());
}

#[tokio::test]
async fn test_a_repository_with_no_commit_stops_the_run_and_says_what_to_do() {
    let _g = common::init().await;
    let folder = common::folder().join("repos").join("no-commit");
    std::fs::create_dir_all(&folder).expect("folder");
    common::git(&folder, &["init", "-q", "-b", "main"]);
    let (pid, _) = common::project().await;
    common::worktrees_on(&pid, json!({})).await;
    let t = common::ticket(&pid, "Fix add()", "todo").await;
    // `runs` ends the run with this text and the stop code `board_fault`
    let err = common::ensure_worktree(&t, &folder).await.expect_err("no first commit");
    assert!(matches!(err, Error::NeedsYou(_)) && err.is_worktree_error());
    let text = err.to_string();
    assert!(text.contains("no commit yet") && text.contains("git commit --allow-empty"), "{text}");
}

#[tokio::test]
async fn test_a_failing_prepare_command_fails_the_run_with_its_output() {
    let _g = common::init().await;
    let repo = common::repo("prepare-fails");
    let (pid, _) = common::project().await;
    common::worktrees_on(&pid, json!({"prepare": "echo 'npm exploded' >&2; exit 3"})).await;
    let t = common::ticket(&pid, "Fix add()", "todo").await;
    let err = common::ensure_worktree(&t, &repo).await.expect_err("the prepare command fails");
    assert!(err.is_worktree_error());
    let text = err.to_string();
    assert!(text.contains("prepare command") && text.contains("npm exploded"), "{text}");
    assert_eq!(text, "The prepare command `echo 'npm exploded' >&2; exit 3` failed: npm exploded");
}

#[tokio::test]
async fn test_a_worktree_made_again_runs_the_prepare_command_again() {
    let _g = common::init().await;
    let repo = common::repo("prepare-again");
    let count = common::folder().join("prepared.txt");
    let _ = std::fs::remove_file(&count);
    let (pid, _) = common::project().await;
    common::worktrees_on(&pid, json!({"prepare": format!("printf x >> '{}'", count.display())})).await;
    let t = common::ticket(&pid, "Fix add()", "todo").await;
    let row = common::ensure_worktree(&t, &repo).await.expect("ensure").expect("a worktree");
    assert_eq!(read(&count), "x");
    assert!(row.prepared_at.is_some());
    let session = database::session();
    let removed = worktrees::remove(&session, &t.id, false).await.expect("remove");
    assert!(removed.state == "removed" && removed.port.is_none());
    assert!(!repo.parent().expect("parent").join("prepare-again.worktrees").join(&t.id).exists());
    // the next run makes it again
    common::ensure_worktree(&t, &repo).await.expect("ensure").expect("a worktree");
    assert_eq!(read(&count), "xx");
}

#[tokio::test]
async fn test_a_person_moving_the_ticket_to_done_merges_and_removes_the_worktree() {
    let _g = common::init().await;
    let repo = common::repo("done-merges");
    let (_pid, t, row) = setup_ticket(&repo, json!({})).await;
    ai_commit(&row.path, "def add(a, b):\n    return a + b\n");
    assert!(read(repo.join("calc.py")).contains("a - b"), "not merged yet");
    worktrees::on_status(&t.id, "done", "review", false);
    let tid = t.id.clone();
    common::until(10, || async { row_of(&tid).await.is_some_and(|r| r.state == "removed" && r.merged_at.is_some()) })
        .await;
    assert!(read(repo.join("calc.py")).contains("a + b"));
    assert!(common::git(&repo, &["log", "--oneline", "-3"]).contains(&format!("Merge {}", t.id)));
}

#[tokio::test]
async fn test_a_conflict_is_rolled_back_and_the_worktree_is_left_as_the_ai_made_it() {
    let _g = common::init().await;
    let repo = common::repo("conflict");
    let (_pid, t, row) = setup_ticket(&repo, json!({})).await;
    ai_commit(&row.path, "def add(a, b):\n    return a + b  # AI\n");
    // main moves the same line
    std::fs::write(repo.join("calc.py"), "def add(a, b):\n    return b + a  # main\n").expect("calc.py");
    common::git(&repo, &["commit", "-qam", "main moved"]);
    let out = worktrees::merge(&t.id, "An").await.expect("merge");
    assert_eq!(out, json!({"merged": false, "conflict": ["calc.py"]}));
    assert!(!repo.join(".git").join("MERGE_HEAD").exists());
    assert!(read(repo.join("calc.py")).contains("b + a  # main"));
    let wt = row_of(&t.id).await.expect("row");
    assert_eq!(wt.state, "conflict");
    assert_eq!(wt.conflict_files, r#"["calc.py"]"#);
    assert!(read(Path::new(&wt.path).join("calc.py")).contains("a + b  # AI"));
    // a Needs you row for the board's user
    let session = database::session();
    let opts = kb_notify::ListOptions { view: "panel".into(), tab: Some("needs".into()), ..Default::default() };
    let panel = kb_notify::list_rows(&session, "user", &opts).await.expect("the panel");
    let items = panel["items"].as_array().expect("items");
    assert!(
        items.iter().any(|i| i["kind"] == "merge_conflict" && i["title"].as_str().is_some_and(|t2| t2.contains(&t.id))),
        "{items:?}"
    );
}

#[tokio::test]
async fn test_merging_is_refused_while_the_main_checkout_is_dirty_or_on_another_branch() {
    let _g = common::init().await;
    let repo = common::repo("refused");
    let (_pid, t, row) = setup_ticket(&repo, json!({})).await;
    ai_commit(&row.path, "def add(a, b):\n    return a + b\n");
    std::fs::write(repo.join("notes.txt"), "mine, not committed").expect("notes");
    let out = worktrees::merge(&t.id, "An").await.expect("merge");
    assert!(out["merged"] == false && out["refused"].as_str().expect("why").contains("notes.txt"), "{out}");
    std::fs::remove_file(repo.join("notes.txt")).expect("remove");
    common::git(&repo, &["checkout", "-q", "-b", "elsewhere"]);
    let out = worktrees::merge(&t.id, "An").await.expect("merge");
    let why = out["refused"].as_str().expect("why");
    assert!(out["merged"] == false && why.contains("elsewhere") && why.contains("main"), "{out}");
    common::git(&repo, &["checkout", "-q", "main"]);
    assert_eq!(worktrees::merge(&t.id, "An").await.expect("merge"), json!({"merged": true}));
    assert!(read(repo.join("calc.py")).contains("a + b"));
}

#[tokio::test]
async fn test_merge_with_no_worktree_says_so() {
    let _g = common::init().await;
    let (pid, _) = common::project().await;
    let t = common::ticket(&pid, "No tree", "todo").await;
    let out = worktrees::merge(&t.id, "An").await.expect("merge");
    assert!(out["merged"] == false && out["refused"].as_str().expect("why").contains("no worktree"));
}

#[tokio::test]
async fn test_a_worktree_with_uncommitted_work_is_never_removed_and_commit_now_saves_it() {
    let _g = common::init().await;
    let repo = common::repo("uncommitted");
    let (_pid, t, row) = setup_ticket(&repo, json!({})).await;
    std::fs::write(Path::new(&row.path).join("feature.py"), "x = 1\n").expect("feature");
    let live = worktrees::status(&row).await.expect("status").to_value();
    assert_eq!(live["uncommitted"], json!(["feature.py"]));
    assert_eq!(live["outputs"], json!([]));
    // the route answers 409 with this message
    let session = database::session();
    let err = worktrees::remove(&session, &t.id, false).await.expect_err("uncommitted work stays");
    assert!(err.is_worktree_error() && err.to_string().contains("not committed"), "{err}");
    assert_eq!(err.to_string(), "1 files are not committed: keep it, or commit them first.");
    let done = worktrees::commit_now(&t.id, "An").await.expect("commit");
    assert_eq!(done["committed"], json!(true));
    assert_eq!(done["left"], json!([]));
    assert_eq!(common::git(Path::new(&row.path), &["status", "--porcelain"]), "");
    assert!(common::git(Path::new(&row.path), &["log", "-1", "--format=%s"]).contains("committed by"));
    assert_eq!(worktrees::commit_now(&t.id, "An").await.expect("commit")["committed"], json!(false));
    // with everything committed the worktree can go (what the project's cleanup does)
    assert_eq!(worktrees::remove(&session, &t.id, false).await.expect("remove").state, "removed");
}

#[tokio::test]
async fn test_the_handover_route_of_one_ticket_overrides_the_projects() {
    let _g = common::init().await;
    let repo = common::repo("route");
    let (_pid, _t, row) = setup_ticket(&repo, json!({})).await;
    let session = database::session();
    // the route `PATCH /tickets/{id}/ai/handover` sets: the row's own override
    let mut own = row.clone();
    own.handover = Some("branch".into());
    let own = own.into_active_model().reset_all().update(&session).await.expect("update");
    session.commit().await.expect("commit");
    assert_eq!(worktrees::route_for(&session, &own).await.expect("route"), "branch");
    let mut auto = own.clone();
    auto.handover = None;
    let auto = auto.into_active_model().reset_all().update(&session).await.expect("update");
    session.commit().await.expect("commit");
    // the project's choice
    assert_eq!(worktrees::route_for(&session, &auto).await.expect("route"), "local");
}

#[tokio::test]
async fn test_auto_route_is_local_without_a_remote_and_branch_for_another_host() {
    let _g = common::init().await;
    let repo = common::repo("auto-route");
    let text = repo.to_string_lossy().into_owned();
    assert_eq!(worktrees::guess_route(&text).await.expect("route"), "local");
    common::git(&repo, &["remote", "add", "origin", "https://gitlab.example.com/a/b.git"]);
    assert_eq!(worktrees::guess_route(&text).await.expect("route"), "branch");
}

#[tokio::test]
async fn test_only_a_github_host_is_github() {
    assert!(worktrees::is_github(Some("https://github.com/o/r.git")));
    assert!(worktrees::is_github(Some("git@github.com:o/r.git")));
    assert!(worktrees::is_github(Some("ssh://git@github.com/o/r.git")));
    assert!(!worktrees::is_github(Some("https://gitlab.com/github.com/r.git")));
    assert!(!worktrees::is_github(Some("https://notgithub.com/o/r")) && !worktrees::is_github(None));
}

#[tokio::test]
async fn test_review_with_a_branch_route_commits_leftovers_and_pushes_the_branch() {
    let _g = common::init().await;
    let repo = common::repo("review-branch");
    let bare = common::bare_remote(&repo, "review-branch");
    let (_pid, t, row) = setup_ticket(&repo, json!({"handover": "branch"})).await;
    std::fs::write(Path::new(&row.path).join("late.py"), "y = 2\n").expect("late");
    let out = worktrees::on_review(&t.id).await.expect("review");
    assert_eq!(out, Some(json!({"route": "branch", "pushed": true})));
    assert!(common::git(&bare, &["branch", "--list"]).contains(&row.branch));
    assert!(
        common::git(&bare, &["log", &row.branch, "-1", "--format=%s"])
            .contains("work in progress handed over for review")
    );
    assert!(Path::new(&row.path).join("late.py").exists());
    assert_eq!(common::git(Path::new(&row.path), &["status", "--porcelain"]), "");
}

#[tokio::test]
async fn test_review_with_a_local_route_does_nothing_and_a_failed_push_is_reported() {
    let _g = common::init().await;
    let repo = common::repo("review-local");
    let (_pid, t, row) = setup_ticket(&repo, json!({})).await;
    assert_eq!(worktrees::on_review(&t.id).await.expect("review"), Some(json!({"route": "local"})));
    assert_eq!(worktrees::on_review("KAN-999").await.expect("review"), None);
    // no origin to push to
    let session = database::session();
    let mut own = row.clone();
    own.handover = Some("branch".into());
    own.into_active_model().reset_all().update(&session).await.expect("update");
    session.commit().await.expect("commit");
    let out = worktrees::on_review(&t.id).await.expect("review").expect("a result");
    assert_eq!(out["route"], "branch");
    assert!(out["error"].as_str().expect("error").starts_with("git push failed"), "{out}");
}

/// Stands for the monkeypatched `worktrees.on_review` and `worktrees.merge` of the Python tests.
#[derive(Default)]
struct Spy {
    seen: Mutex<Vec<(String, String)>>,
}

impl Spy {
    fn seen(&self) -> Vec<(String, String)> {
        self.seen.lock().expect("lock").clone()
    }
}

#[async_trait]
impl Handover for Spy {
    async fn on_review(&self, ticket_id: &str) -> Result<Option<Value>, Error> {
        self.seen.lock().expect("lock").push(("review".into(), ticket_id.into()));
        Ok(None)
    }

    async fn merge(&self, ticket_id: &str, _by: &str) -> Result<Value, Error> {
        self.seen.lock().expect("lock").push(("merge".into(), ticket_id.into()));
        Ok(json!({}))
    }
}

/// Puts the spy in place and takes it away at the end of the test, whatever happens.
struct Spying(Arc<Spy>);

impl Spying {
    fn new() -> Self {
        worktrees::clear_deferred();
        let spy = Arc::new(Spy::default());
        worktrees::set_handover(Some(spy.clone()));
        Spying(spy)
    }
}

impl Drop for Spying {
    fn drop(&mut self) {
        worktrees::set_handover(None);
    }
}

async fn running_run(pid: &str, team: &str, tid: &str, id: &str) -> ai_run::Model {
    common::run(pid, team, Some(tid), "running", |r| r.id = Set(id.to_string())).await
}

#[tokio::test]
async fn test_a_move_to_review_while_a_run_works_waits_for_the_run_to_stop() {
    let _g = common::init().await;
    let spying = Spying::new();
    let (pid, _) = common::project().await;
    let (team, _) = common::team(&pid, "Claude Code · Backend", Default::default()).await;
    let t = common::ticket(&pid, "Work", "in-progress").await;
    let run_id = format!("r1-{}", &kb_base::time::uuid4_hex()[..8]);
    running_run(&pid, &team.id, &t.id, &run_id).await;
    // the AI moves its own ticket mid-run
    common::set_status(&t.id, "review").await;
    worktrees::on_status(&t.id, "review", "in-progress", false);
    tokio::time::sleep(std::time::Duration::from_millis(300)).await;
    assert!(spying.0.seen().is_empty());
    common::set_run_state(&run_id, "finished").await;
    worktrees::after_run(&t.id);
    common::until(10, || async { !spying.0.seen().is_empty() }).await;
    assert_eq!(spying.0.seen(), vec![("review".to_string(), t.id.clone())]);
    // once only
    worktrees::after_run(&t.id);
    tokio::time::sleep(std::time::Duration::from_millis(200)).await;
    assert_eq!(spying.0.seen(), vec![("review".to_string(), t.id.clone())]);
}

#[tokio::test]
async fn test_a_person_moving_to_review_hands_over_at_once_and_an_ai_move_to_done_merges_nothing() {
    let _g = common::init().await;
    let spying = Spying::new();
    let (pid, _) = common::project().await;
    let t = common::ticket(&pid, "Work", "in-progress").await;
    worktrees::on_status(&t.id, "review", "in-progress", false);
    common::until(10, || async { !spying.0.seen().is_empty() }).await;
    worktrees::on_status(&t.id, "done", "review", true);
    // no move
    worktrees::on_status(&t.id, "done", "done", false);
    // not a hand-over column
    worktrees::on_status(&t.id, "testing", "review", false);
    tokio::time::sleep(std::time::Duration::from_millis(300)).await;
    assert_eq!(spying.0.seen(), vec![("review".to_string(), t.id.clone())]);
    worktrees::on_status(&t.id, "done", "review", false);
    common::until(10, || async { spying.0.seen().len() >= 2 }).await;
    assert_eq!(spying.0.seen().last(), Some(&("merge".to_string(), t.id.clone())));
}

#[tokio::test]
async fn test_the_run_ending_delivers_a_review_handover_that_waited_for_it() {
    let _g = common::init().await;
    let spying = Spying::new();
    let (pid, _) = common::project().await;
    let (team, _) = common::team(&pid, "Claude Code · Backend", Default::default()).await;
    let t = common::ticket(&pid, "Work", "in-progress").await;
    let run_id = format!("r2-{}", &kb_base::time::uuid4_hex()[..8]);
    running_run(&pid, &team.id, &t.id, &run_id).await;
    common::set_status(&t.id, "review").await;
    worktrees::on_status(&t.id, "review", "in-progress", false);
    tokio::time::sleep(std::time::Duration::from_millis(300)).await;
    // the end of the run: `runs._end` writes the state, then calls `after_run` (a later port)
    common::set_run_state(&run_id, "finished").await;
    worktrees::after_run(&t.id);
    tokio::time::sleep(std::time::Duration::from_millis(1000)).await;
    assert_eq!(spying.0.seen(), vec![("review".to_string(), t.id.clone())]);
}

// --- outputs, names and paths ------------------------------------------------------------------------------------

#[test]
fn test_names_and_paths() {
    assert_eq!(worktrees::slug_default("Fix the CSV export, please!"), "fix-the-csv-export-please");
    // Vietnamese keeps its letters
    assert_eq!(worktrees::slug_default("Bất tài liệu học"), "bat-tai-lieu-hoc");
    assert_eq!(worktrees::slug_default("Đặt lịch hẹn"), "dat-lich-hen");
    assert!(worktrees::slug_default("!!!") == "work" && worktrees::slug_default("") == "work");
    let long = worktrees::slug_default(&"word ".repeat(30));
    assert!(long.chars().count() <= 32 && !long.ends_with('-'));
    assert_eq!(worktrees::path_for("/code/kanban", "KAN-1"), "/code/kanban.worktrees/KAN-1");
}

#[test]
fn test_outputs_are_told_from_code() {
    for rel in [
        "shot.png",
        "qa/step1.txt",
        "run.log",
        "out/evidence/a.txt",
        "test-results/x.json",
        "sub/video.mp4",
        "my_work/notes.md",
    ] {
        assert!(worktrees::is_output(rel), "{rel}");
    }
    for rel in ["src/app.py", "docs/diagram.png", "README.md", "src/logo.png", "script.sh"] {
        assert!(!worktrees::is_output(rel), "{rel}");
    }
    let lines: Vec<String> = ["?? shot.png", "?? src/new.py", " M calc.py", "?? qa/a.txt", "A  staged.log"]
        .iter()
        .map(|s| (*s).to_string())
        .collect();
    assert_eq!(worktrees::outputs_in(&lines), vec!["shot.png".to_string(), "qa/a.txt".to_string()]);
}

/// The work-log notes of a ticket.
async fn work_log(tid: &str) -> Vec<Value> {
    let session = database::session();
    let row = ticket::Entity::find_by_id(tid).one(&session).await.expect("read").expect("ticket");
    serde_json::from_str::<Vec<Value>>(&row.work_log).unwrap_or_default()
}

#[tokio::test]
async fn test_outputs_a_run_leaves_are_tidied_at_its_end_and_never_committed() {
    let _g = common::init().await;
    let repo = common::repo("tidy");
    let (pid, t, row) = setup_ticket(&repo, json!({})).await;
    let (team, _) = common::team(&pid, "Claude Code · QA", Default::default()).await;
    // what `FAKE_CLAUDE_LEAVE` does: the run leaves files in its folder without committing them
    for rel in ["feature.py", "shot.png", "qa/step.txt"] {
        let path = Path::new(&row.path).join(rel);
        std::fs::create_dir_all(path.parent().expect("parent")).expect("folder");
        std::fs::write(path, "left by the run").expect("file");
    }
    let run = common::run(&pid, &team.id, Some(&t.id), "finished", |_| {}).await;
    // the end of the run tidies the worktree and says where the outputs went
    let result = worktrees::tidy_after_run(&t.id, &run.id).await.expect("tidy").expect("a result");
    let log = work_log(&t.id).await;
    let note =
        log.iter().filter_map(|e| e["note"].as_str()).find(|n| n.contains("output file")).expect("a note").to_string();
    if note.starts_with("Moved 2 output files") {
        // the Workspace is on: the ticket's folder has them
        assert!(!Path::new(&row.path).join("shot.png").exists() && !Path::new(&row.path).join("qa").exists());
        let live = worktrees::status(&row_of(&t.id).await.expect("row")).await.expect("status").to_value();
        assert_eq!(live["outputs"], json!([]));
        assert_eq!(result.moved().len(), 2);
    } else {
        // the Workspace is off: they stay, and the note says why the worktree is not clean
        assert!(note.contains("still in the worktree") && Path::new(&row.path).join("shot.png").exists());
    }
    // whichever it was, the code is committed on a person's request and the outputs never are
    let done = worktrees::commit_now(&t.id, "An").await.expect("commit");
    assert_eq!(done["committed"], json!(true));
    let shown = common::git(Path::new(&row.path), &["show", "--name-only", "--format=", "HEAD"]);
    assert_eq!(shown.split_whitespace().collect::<Vec<_>>(), vec!["feature.py"]);
}

// ---------------------------------------------------------------------------------------------------------------------
// Waiting for later ports (the Python tests that are not here, and what each needs):
//
// - `test_the_cli_gets_the_worktrees_port_in_its_environment`: the CLI's environment (`runs` and the fake CLI).
//   The port itself is checked in `test_a_ticket_works_in_its_own_worktree_beside_the_repo_with_a_port`.
// - `test_cleanup_removes_only_finished_tickets_and_a_kept_worktree_stays`: the routes `POST /projects/{id}/ai/worktrees/cleanup`
//   and `POST /tickets/{id}/ai/worktree/keep` of `api/ai_code.py` (`kb-ai-api`); the service calls under them
//   (`remove`, `status`) are checked above.
// - the HTTP halves of the tests above: `GET /tickets/{id}/ai/worktree` (None when none), `POST .../worktree/remove`
//   (409 on uncommitted work), `.../worktree/commit`, `.../merge`, `PATCH .../ai/handover` (404 without a worktree),
//   the run's `ended_reason` and `stop_code` (`board_fault`) when `ensure` fails, the CLI's working folder and
//   `PORT`: all `runs` or `kb-ai-api`.
// - the run's own end (`runs._end` calling `worktrees.after_run` and `tidy_later`): `runs`.
// ---------------------------------------------------------------------------------------------------------------------
#[allow(dead_code)]
fn _paths(_: PathBuf) {}
