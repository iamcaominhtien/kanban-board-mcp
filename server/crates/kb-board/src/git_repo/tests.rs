//! `git_repo` against GitPython: replays `contract/golden/git_repo.json` (made by `gen_git_repo.py` from the Python
//! functions) on a real temporary repository and compares what each function returns or fails with. Plus the
//! parts of `tests/test_git_branches.py` that call `git_repo` directly.

use std::path::Path;
use std::process::Command;

use serde_json::{Value, json};

use super::*;

fn golden() -> Value {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../contract/golden/git_repo.json");
    let text = std::fs::read_to_string(path).expect("golden file git_repo.json exists");
    serde_json::from_str(&text).expect("golden file parses")
}

fn git_version() -> String {
    let out = Command::new("git").arg("--version").output().expect("git is installed");
    String::from_utf8_lossy(&out.stdout).trim().to_string()
}

/// A preparing step of the golden script.
fn step(root: &str, env: &Value, op: &Value) {
    let text = |key: &str| op[key].as_str().unwrap_or_else(|| panic!("{key} in {op}"));
    let full = |key: &str| Path::new(root).join(text(key));
    match text("do") {
        "git" => {
            let mut cmd = Command::new("git");
            cmd.current_dir(full("repo"));
            for arg in op["args"].as_array().expect("args") {
                cmd.arg(arg.as_str().expect("arg"));
            }
            for (name, value) in env.as_object().expect("env") {
                cmd.env(name, value.as_str().expect("env value"));
            }
            cmd.env("GIT_AUTHOR_DATE", text("date")).env("GIT_COMMITTER_DATE", text("date"));
            let out = cmd.output().expect("git runs");
            assert!(out.status.success(), "{op}: {}", String::from_utf8_lossy(&out.stderr));
        }
        "write" => {
            let path = full("path");
            std::fs::create_dir_all(path.parent().expect("parent")).expect("mkdir");
            std::fs::write(path, text("text")).expect("write");
        }
        "write_bytes" => {
            let bytes: Vec<u8> =
                op["bytes"].as_array().expect("bytes").iter().map(|b| b.as_u64().expect("byte") as u8).collect();
            std::fs::write(full("path"), bytes).expect("write");
        }
        "mkdir" => std::fs::create_dir_all(full("path")).expect("mkdir"),
        "symlink" => {
            #[cfg(unix)]
            std::os::unix::fs::symlink(full("target"), full("path")).expect("symlink");
        }
        other => panic!("unknown step {other}"),
    }
}

/// What a function returned or failed with, as the generator wrote it.
fn outcome<T: serde::Serialize>(result: Result<T, GitError>) -> Value {
    match result {
        Ok(value) => json!({"ok": value}),
        Err(GitError::Repo(message)) => json!({"error": "GitRepoError", "message": message}),
        Err(GitError::Command(exc)) => json!({"error": "GitCommandError", "status": exc.status, "stderr": exc.stderr}),
        Err(GitError::Other(message)) => json!({"error": "other", "message": message}),
    }
}

/// A call of the golden script.
async fn call(root: &str, op: &Value) -> Value {
    let args: Vec<Value> = op["args"]
        .as_array()
        .expect("args")
        .iter()
        .map(|a| match a.as_str() {
            Some(text) => json!(text.replace("<ROOT>", root)),
            None => a.clone(),
        })
        .collect();
    let s = |i: usize| args[i].as_str().unwrap_or_else(|| panic!("argument {i} of {op}")).to_string();
    let list = |i: usize| -> Vec<String> {
        args[i].as_array().expect("list").iter().map(|v| v.as_str().expect("text").to_string()).collect()
    };
    let n = |i: usize| args[i].as_u64().expect("number") as usize;
    let flag = |i: usize| args[i].as_bool().expect("bool");
    let name = op["fn"].as_str().expect("fn");

    // functions that take no repository
    match name {
        "open_repo" => {
            return outcome(open_repo(&s(0)).await.map(|r| {
                json!({"working_dir": r.working_dir.to_string_lossy(), "git_dir": r.git_dir.to_string_lossy(),
                    "bare": r.bare})
            }));
        }
        "normalize_repo_path" => return outcome(normalize_repo_path(&s(0)).await),
        "resolve_worktree_path" => {
            return outcome(Ok(resolve_worktree_path(&s(0), &s(1), &s(2), &s(3), &s(4))));
        }
        _ => {}
    }
    let repo_path = Path::new(root).join(op["repo"].as_str().expect("repo"));
    let repo = &open_repo(&repo_path.to_string_lossy()).await.expect("the repository opens");
    let info = |b: BranchInfo| {
        json!({"name": b.name, "commit_hash": b.commit_hash, "ahead_count": b.ahead_count,
            "behind_count": b.behind_count})
    };
    match name {
        "list_local_branches" => outcome(Ok(list_local_branches(repo).await)),
        "branch_exists" => outcome(Ok(branch_exists(repo, &s(0)).await)),
        "current_branch" => outcome(Ok(current_branch(repo).await)),
        "default_base_branch" => outcome(Ok(default_base_branch(repo).await)),
        "resolve_base" => outcome(Ok(resolve_base(repo, args[0].as_str()).await)),
        "_resolve_ref" => outcome(resolve_ref(repo, &s(0)).await),
        "validate_branch_name" => outcome(validate_branch_name(repo, &s(0)).await),
        "branch_info" => outcome(branch_info(repo, &s(0), &s(1)).await.map(info)),
        "create_branch" => outcome(create_branch(repo, &s(0), &s(1)).await.map(info)),
        "is_merged" => outcome(is_merged(repo, &s(0), &s(1)).await),
        "rename_branch" => outcome(rename_branch(repo, &s(0), &s(1)).await),
        "delete_branch" => outcome(delete_branch(repo, &s(0), flag(1)).await),
        "checkout_branch" => outcome(checkout_branch(repo, &s(0)).await),
        "add_worktree" => outcome(add_worktree(repo, &s(0), &s(1)).await),
        "remove_worktree" => outcome(remove_worktree(repo, &s(0), flag(1)).await),
        "list_worktrees" => outcome(list_worktrees(repo).await),
        "commit_graph" => outcome(commit_graph(repo, &list(0), &list(1), n(2)).await),
        "commit_detail" => outcome(commit_detail(repo, &s(0), n(1)).await),
        other => panic!("unknown function {other}"),
    }
}

/// With another git than the one that made the golden file, what git itself wrote is not compared.
fn without_git_text(value: &Value) -> Value {
    let mut value = value.clone();
    for key in ["message", "stderr"] {
        if let Some(text) = value.get(key).and_then(Value::as_str) {
            if let Some(at) = text.find("stderr: '") {
                value[key] = json!(&text[..at]);
            }
        }
    }
    value
}

#[cfg(unix)]
#[tokio::test]
async fn every_function_gives_what_gitpython_gave() {
    let golden = golden();
    let dir = tempfile::tempdir().expect("temporary folder");
    let root = pypath::realpath(&dir.path().to_string_lossy()).await;
    let same_git = golden["git_version"].as_str() == Some(git_version().as_str());
    let mut calls = 0;
    for (i, op) in golden["ops"].as_array().expect("ops").iter().enumerate() {
        if op.get("do").is_some() {
            step(&root, &golden["env"], op);
            continue;
        }
        let got: Value =
            serde_json::from_str(&call(&root, op).await.to_string().replace(&root, "<ROOT>")).expect("json");
        let (got, expected) =
            if same_git { (got, op["out"].clone()) } else { (without_git_text(&got), without_git_text(&op["out"])) };
        assert_eq!(got, expected, "operation {i}: {}({})", op["fn"], op["args"]);
        // the order of the keys is part of the result (a dict in Python)
        assert_eq!(got.to_string(), expected.to_string(), "operation {i}: {}({})", op["fn"], op["args"]);
        calls += 1;
    }
    assert!(calls > 100, "{calls} calls");
}

// --- tests/test_git_branches.py, the parts that call git_repo directly ------------------------------------------

/// The `repo_dir` fixture: a repository on `branch` with one commit.
fn repo_dir(branch: &str) -> tempfile::TempDir {
    let dir = tempfile::tempdir().expect("temporary folder");
    for args in [
        vec!["init", "-b", branch],
        vec!["config", "user.email", "t@example.com"],
        vec!["config", "user.name", "Tester"],
    ] {
        _git(dir.path(), &args);
    }
    std::fs::write(dir.path().join("a.txt"), "a").expect("write");
    _git(dir.path(), &["add", "."]);
    _git(dir.path(), &["commit", "-m", "init"]);
    dir
}

fn _git(cwd: &Path, args: &[&str]) -> String {
    let out = Command::new("git").args(args).current_dir(cwd).output().expect("git runs");
    assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
    String::from_utf8_lossy(&out.stdout).into_owned()
}

fn _commit(repo_dir: &Path, fname: &str, branch: Option<&str>) {
    if let Some(branch) = branch {
        _git(repo_dir, &["checkout", "-q", branch]);
    }
    std::fs::write(repo_dir.join(fname), fname).expect("write");
    _git(repo_dir, &["add", "."]);
    _git(repo_dir, &["commit", "-qm", &format!("add {fname}")]);
}

/// No commit may sit on a lane that another edge is still running through.
fn _assert_no_lane_overlap(commits: &[Value]) {
    let row = |hash: &Value| commits.iter().position(|c| &c["hash"] == hash);
    for (i, c) in commits.iter().enumerate() {
        for (idx, ph) in c["parents"].as_array().expect("parents").iter().enumerate() {
            let Some(parent_row) = row(ph) else { continue };
            let lane = if idx == 0 { c["lane"].as_u64() } else { commits[parent_row]["lane"].as_u64() };
            if lane == Some(0) {
                continue;
            }
            for between in &commits[i + 1..parent_row] {
                assert_ne!(
                    between["lane"].as_u64(),
                    lane,
                    "{} overlaps edge {} -> {}",
                    between["subject"],
                    c["subject"],
                    commits[parent_row]["subject"]
                );
            }
        }
    }
}

async fn open(dir: &tempfile::TempDir) -> Repo {
    open_repo(&dir.path().to_string_lossy()).await.expect("the repository opens")
}

#[tokio::test]
async fn test_link_rejects_non_repo() {
    let dir = tempfile::tempdir().expect("temporary folder");
    let path = dir.path().to_string_lossy().into_owned();
    let err = normalize_repo_path(&path).await.expect_err("not a repository");
    let resolved = pypath::realpath(&path).await;
    assert_eq!(err, GitError::Repo(format!("Not a git repository: {resolved}")));
}

#[tokio::test]
async fn test_create_branch_creates_real_git_branch() {
    let dir = repo_dir("main");
    let repo = open(&dir).await;
    let info = create_branch(&repo, "feature/x", "main").await.expect("created");
    assert_eq!(info.commit_hash, _git(dir.path(), &["rev-parse", "main"]).trim());
    assert_eq!((info.ahead_count, info.behind_count), (0, 0));
    assert!(list_local_branches(&repo).await.contains(&"feature/x".to_string()));
    // the working tree stays on main
    assert_eq!(current_branch(&repo).await.as_deref(), Some("main"));
    let again = create_branch(&repo, "feature/x", "main").await.expect_err("exists");
    assert_eq!(again, GitError::Repo("Branch 'feature/x' already exists".into()));
}

#[tokio::test]
async fn test_list_branches_reports_live_ahead_behind() {
    let dir = repo_dir("main");
    let repo = open(&dir).await;
    create_branch(&repo, "feat/a", "main").await.expect("created");
    _commit(dir.path(), "b.txt", Some("feat/a"));
    _git(dir.path(), &["checkout", "-q", "main"]);
    _commit(dir.path(), "c.txt", None);
    _commit(dir.path(), "d.txt", None);
    let info = branch_info(&repo, "feat/a", "main").await.expect("info");
    assert_eq!((info.ahead_count, info.behind_count), (1, 2));
    assert_eq!(info.commit_hash, _git(dir.path(), &["rev-parse", "feat/a"]).trim());
}

#[tokio::test]
async fn test_failed_worktree_rolls_back_branch() {
    // the route deletes the branch again when the worktree cannot be made: both steps, as tickets.py runs them
    let dir = repo_dir("main");
    let repo = open(&dir).await;
    create_branch(&repo, "feat/b", "main").await.expect("created");
    let taken = dir.path().join("taken");
    std::fs::create_dir(&taken).expect("mkdir");
    let err = add_worktree(&repo, &taken.to_string_lossy(), "feat/b").await.expect_err("the path exists");
    assert!(err.repo_message().is_some_and(|m| m.starts_with("Target worktree path already exists: ")), "{err}");
    delete_branch(&repo, "feat/b", true).await.expect("deleted");
    assert!(!list_local_branches(&repo).await.contains(&"feat/b".to_string()));
}

#[tokio::test]
async fn test_create_branch_with_worktree() {
    let dir = repo_dir("main");
    let repo = open(&dir).await;
    let repo_path = pypath::realpath(&dir.path().to_string_lossy()).await;
    create_branch(&repo, "feature/worktree-test", "main").await.expect("created");
    let target = resolve_worktree_path("../wt-{repo}/{branch}", &repo_path, "GIT", "GIT-1", "feature/worktree-test");
    let name = pypath::basename(&repo_path);
    assert_eq!(target, format!("{}/wt-{name}/feature-worktree-test", pypath::dirname(&repo_path)));
    let made = add_worktree(&repo, &target, "feature/worktree-test").await.expect("worktree");
    assert_eq!(made, target);
    assert!(Path::new(&made).join("a.txt").exists());
    let listed = list_worktrees(&repo).await.expect("worktrees");
    assert!(listed.iter().any(|w| w["path"] == json!(made) && w["branch"] == json!("feature/worktree-test")));
    remove_worktree(&repo, &made, false).await.expect("removed");
    assert!(!Path::new(&made).exists());
    std::fs::remove_dir_all(Path::new(&made).parent().expect("parent")).ok();
}

#[tokio::test]
async fn test_worktree_removal_failure_is_not_hidden() {
    let dir = repo_dir("main");
    let repo = open(&dir).await;
    let other = tempfile::tempdir().expect("temporary folder");
    let target = other.path().join("wt").to_string_lossy().into_owned();
    create_branch(&repo, "feat/c", "main").await.expect("created");
    let made = add_worktree(&repo, &target, "feat/c").await.expect("worktree");
    std::fs::write(Path::new(&made).join("dirty.txt"), "x").expect("write");
    let err = remove_worktree(&repo, &made, false).await.expect_err("untracked files");
    assert!(err.repo_message().is_some_and(|m| m.starts_with(&format!("Could not remove worktree '{made}': "))));
    assert!(Path::new(&made).exists());
    remove_worktree(&repo, &made, true).await.expect("forced");
    assert!(!Path::new(&made).exists());
}

#[tokio::test]
async fn test_delete_branch_can_also_delete_git_branch() {
    let dir = repo_dir("main");
    let repo = open(&dir).await;
    create_branch(&repo, "feat/keep", "main").await.expect("created");
    create_branch(&repo, "feat/e", "main").await.expect("created");
    _commit(dir.path(), "e.txt", Some("feat/e"));
    _git(dir.path(), &["checkout", "-q", "main"]);
    // unmerged: git refuses without force, and the branch is still there
    let err = delete_branch(&repo, "feat/e", false).await.expect_err("unmerged");
    assert!(err.repo_message().is_some_and(|m| m.starts_with("Could not delete git branch 'feat/e': stderr: '")));
    assert!(list_local_branches(&repo).await.contains(&"feat/e".to_string()));
    delete_branch(&repo, "feat/e", true).await.expect("forced");
    assert!(!list_local_branches(&repo).await.contains(&"feat/e".to_string()));
    assert!(list_local_branches(&repo).await.contains(&"feat/keep".to_string()));
    // a branch that is already gone is not an error
    delete_branch(&repo, "feat/e", false).await.expect("nothing to delete");
}

#[tokio::test]
async fn test_mark_merged_is_verified_against_git() {
    let dir = repo_dir("main");
    let repo = open(&dir).await;
    create_branch(&repo, "feat/m", "main").await.expect("created");
    _commit(dir.path(), "m.txt", Some("feat/m"));
    _git(dir.path(), &["checkout", "-q", "main"]);
    assert!(!is_merged(&repo, "feat/m", "main").await.expect("compared"));
    _git(dir.path(), &["merge", "-q", "--no-ff", "-m", "merge", "feat/m"]);
    assert!(is_merged(&repo, "feat/m", "main").await.expect("compared"));
}

#[tokio::test]
async fn test_rename_branch_renames_in_git() {
    let dir = repo_dir("main");
    let repo = open(&dir).await;
    create_branch(&repo, "feat/old", "main").await.expect("created");
    rename_branch(&repo, "feat/old", "feat/new").await.expect("renamed");
    let names = list_local_branches(&repo).await;
    assert!(names.contains(&"feat/new".to_string()) && !names.contains(&"feat/old".to_string()), "{names:?}");
    let err = rename_branch(&repo, "feat/new", "main").await.expect_err("taken");
    assert_eq!(err, GitError::Repo("Branch 'main' already exists".into()));
}

#[tokio::test]
async fn test_checkout_branch() {
    let dir = repo_dir("main");
    let repo = open(&dir).await;
    create_branch(&repo, "feat/co", "main").await.expect("created");
    checkout_branch(&repo, "feat/co").await.expect("checked out");
    assert_eq!(current_branch(&repo).await.as_deref(), Some("feat/co"));
    assert_eq!(_git(dir.path(), &["rev-parse", "--abbrev-ref", "HEAD"]).trim(), "feat/co");
    // local changes are never lost
    std::fs::write(dir.path().join("a.txt"), "changed").expect("write");
    let err = checkout_branch(&repo, "main").await.expect_err("dirty");
    assert_eq!(
        err,
        GitError::Repo(
            "The working tree has uncommitted changes; commit or stash them before switching branches".into()
        )
    );
    assert_eq!(current_branch(&repo).await.as_deref(), Some("feat/co"));
}

#[tokio::test]
async fn test_graph_shows_real_history_with_multiple_merges_and_branches() {
    let dir = repo_dir("main");
    let repo = open(&dir).await;
    for (branch, file) in [("feat/one", "one.txt"), ("feat/two", "two.txt")] {
        create_branch(&repo, branch, "main").await.expect("created");
        _commit(dir.path(), file, Some(branch));
        _git(dir.path(), &["checkout", "-q", "main"]);
        _commit(dir.path(), &format!("main-{file}"), None);
        _git(dir.path(), &["merge", "-q", "--no-ff", "-m", &format!("merge {branch}"), branch]);
    }
    create_branch(&repo, "feat/open", "main").await.expect("created");
    _commit(dir.path(), "open.txt", Some("feat/open"));
    _git(dir.path(), &["checkout", "-q", "main"]);

    let branches = ["feat/one", "feat/two", "feat/open"].map(String::from);
    let graph = commit_graph(&repo, &["main".to_string()], &branches, 80).await.expect("graph");
    assert_eq!(graph["base"], "main");
    assert_eq!(graph["current"], "main");
    assert_eq!(graph["truncated"], false);
    let commits = graph["commits"].as_array().expect("commits");
    let subjects: Vec<&str> = commits.iter().map(|c| c["subject"].as_str().expect("subject")).collect();
    for subject in ["init", "add one.txt", "add two.txt", "merge feat/one", "merge feat/two", "add open.txt"] {
        assert!(subjects.contains(&subject), "{subject} in {subjects:?}");
    }
    let by_subject = |s: &str| commits.iter().find(|c| c["subject"] == s).expect("commit");
    // the mainline is lane 0, merged and open work is beside it
    for subject in ["init", "merge feat/one", "merge feat/two", "add main-one.txt"] {
        assert_eq!(by_subject(subject)["lane"], 0, "{subject}");
    }
    for subject in ["add one.txt", "add two.txt", "add open.txt"] {
        assert!(by_subject(subject)["lane"].as_u64().expect("lane") >= 1, "{subject}");
    }
    assert_eq!(by_subject("merge feat/two")["parents"].as_array().expect("parents").len(), 2);
    assert_eq!(by_subject("add open.txt")["ticket_branches"], json!(["feat/open"]));
    assert_eq!(by_subject("add one.txt")["ticket_branches"], json!([]));
    assert!(graph["lane_count"].as_u64().expect("lane_count") >= 2);
    _assert_no_lane_overlap(commits);
}

#[tokio::test]
async fn test_graph_window_reaches_back_to_branch_fork() {
    let dir = repo_dir("main");
    let repo = open(&dir).await;
    create_branch(&repo, "feat/old", "main").await.expect("created");
    _commit(dir.path(), "old.txt", Some("feat/old"));
    _git(dir.path(), &["checkout", "-q", "main"]);
    for i in 0..6 {
        _commit(dir.path(), &format!("m{i}.txt"), None);
    }
    let graph = commit_graph(&repo, &["main".to_string()], &["feat/old".to_string()], 3).await.expect("graph");
    let commits = graph["commits"].as_array().expect("commits");
    // the window grows past the limit so that the fork point ("init") is shown
    assert!(commits.iter().any(|c| c["subject"] == "init"), "{commits:?}");
    assert_eq!(graph["truncated"], false);
}

#[tokio::test]
async fn test_graph_limit_truncates_when_branch_forked_recently() {
    let dir = repo_dir("main");
    let repo = open(&dir).await;
    for i in 0..6 {
        _commit(dir.path(), &format!("m{i}.txt"), None);
    }
    create_branch(&repo, "feat/new", "main").await.expect("created");
    _commit(dir.path(), "new.txt", Some("feat/new"));
    _git(dir.path(), &["checkout", "-q", "main"]);
    let graph = commit_graph(&repo, &["main".to_string()], &["feat/new".to_string()], 3).await.expect("graph");
    assert_eq!(graph["commits"].as_array().expect("commits").len(), 3);
    assert_eq!(graph["truncated"], true);
}

#[tokio::test]
async fn test_commit_detail_message_and_file_changes() {
    let dir = repo_dir("main");
    let repo = open(&dir).await;
    std::fs::write(dir.path().join("a.txt"), "a\nb\nc\n").expect("write");
    std::fs::write(dir.path().join("new.txt"), "one\ntwo\n").expect("write");
    _git(dir.path(), &["add", "."]);
    _git(dir.path(), &["commit", "-q", "-m", "Change things", "-m", "The body\nof the message."]);
    let rev = _git(dir.path(), &["rev-parse", "HEAD"]).trim().to_string();
    let detail = commit_detail(&repo, &rev[..10], MAX_DETAIL_FILES).await.expect("detail");
    assert_eq!(detail["hash"], json!(rev));
    assert_eq!(detail["short"], json!(&rev[..7]));
    assert_eq!(detail["subject"], "Change things");
    assert_eq!(detail["body"], "The body\nof the message.");
    assert_eq!(detail["author"], "Tester");
    assert_eq!(detail["author_email"], "t@example.com");
    assert_eq!(detail["file_count"], 2);
    assert_eq!(detail["files_truncated"], false);
    let files = detail["files"].as_array().expect("files");
    let file = |path: &str| files.iter().find(|f| f["path"] == path).expect("file");
    assert_eq!(file("a.txt")["status"], "M");
    assert_eq!(file("new.txt")["status"], "A");
    assert_eq!(file("new.txt")["additions"], 2);
    assert_eq!(file("new.txt")["old_path"], Value::Null);
    assert_eq!(detail["additions"].as_i64().expect("additions"), 2 + file("a.txt")["additions"].as_i64().unwrap_or(0));
}

#[tokio::test]
async fn test_commit_detail_merge_uses_first_parent_and_validates_input() {
    let dir = repo_dir("main");
    let repo = open(&dir).await;
    create_branch(&repo, "feat/d", "main").await.expect("created");
    _commit(dir.path(), "d.txt", Some("feat/d"));
    _git(dir.path(), &["checkout", "-q", "main"]);
    _commit(dir.path(), "main.txt", None);
    _git(dir.path(), &["merge", "-q", "--no-ff", "-m", "merge feat/d", "feat/d"]);
    let rev = _git(dir.path(), &["rev-parse", "HEAD"]).trim().to_string();
    let detail = commit_detail(&repo, &rev, MAX_DETAIL_FILES).await.expect("detail");
    assert_eq!(detail["parents"].as_array().expect("parents").len(), 2);
    // what the merge brought into main: only the branch's file
    let paths: Vec<&str> =
        detail["files"].as_array().expect("files").iter().map(|f| f["path"].as_str().expect("path")).collect();
    assert_eq!(paths, vec!["d.txt"]);

    let bad = commit_detail(&repo, "HEAD; rm -rf /", MAX_DETAIL_FILES).await.expect_err("not a commit id");
    assert_eq!(bad, GitError::Repo("Invalid commit id".into()));
    let missing = commit_detail(&repo, "deadbeef", MAX_DETAIL_FILES).await.expect_err("unknown");
    assert_eq!(missing, GitError::Repo("Commit 'deadbeef' not found in the repository".into()));
}

#[tokio::test]
async fn test_branch_from_main_starts_from_master_when_repo_has_no_main() {
    let dir = repo_dir("master");
    let repo = open(&dir).await;
    let base = resolve_base(&repo, Some("main")).await;
    assert_eq!(base, "master");
    let info = create_branch(&repo, "feat/from-main", &base).await.expect("created");
    assert_eq!(info.commit_hash, _git(dir.path(), &["rev-parse", "master"]).trim());
    assert_eq!(default_base_branch(&repo).await.as_deref(), Some("master"));
}

#[tokio::test]
async fn test_default_base_prefers_main() {
    let dir = repo_dir("main");
    let repo = open(&dir).await;
    _git(dir.path(), &["branch", "master"]);
    _git(dir.path(), &["checkout", "-q", "master"]);
    assert_eq!(default_base_branch(&repo).await.as_deref(), Some("main"));
    assert_eq!(resolve_base(&repo, None).await, "main");
}

#[test]
fn a_git_command_error_reads_as_gitpython_wrote_it() {
    let exc = GitCommandError {
        command: vec!["git".into(), "branch".into(), "-d".into(), "x".into()],
        status: Some(1),
        stderr: "\n  stderr: 'error: nope'".into(),
        stdout: String::new(),
    };
    assert_eq!(exc.stderr_stripped(), "stderr: 'error: nope'");
    assert_eq!(
        exc.to_string(),
        "Cmd('git') failed due to: exit code(1)\n  cmdline: git branch -d x\n  stderr: 'error: nope'"
    );
}
