//! `tests/test_git_branches.py`: branches of a ticket in a real git repository, through the routes (create, list,
//! worktrees, delete, merge check, rename, checkout, the commit graph, commit details, the default base).
//!
//! In pytest the `repo_dir` fixture returns `tmp_path`, so a test that takes both gets one folder: the worktree
//! folders of those tests are inside the repository here too. Where the Python test asked `git_repo` which branches
//! the repository has, this asks git.

mod common;

use std::path::Path;

use common::{git as _git, id, repo_dir as new_repo};
use serde_json::{Value, json};
use testkit::{Client, Server, skip_unless_available};

/// The `repo_dir` fixture.
fn repo_dir() -> tempfile::TempDir {
    new_repo("main", "Tester")
}

/// The `master_repo_dir` fixture.
fn master_repo_dir() -> tempfile::TempDir {
    new_repo("master", "Tester")
}

/// `str(path)`.
fn text(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

/// `git_repo.list_local_branches(git_repo.open_repo(str(repo_dir)))`.
fn list_local_branches(repo_dir: &Path) -> Vec<String> {
    _git(repo_dir, &["for-each-ref", "--format=%(refname:short)", "refs/heads"]).lines().map(str::to_string).collect()
}

fn has(names: &[String], name: &str) -> bool {
    names.iter().any(|n| n == name)
}

async fn _project(c: &Client) -> Value {
    c.post("/projects", json!({"name": "G", "prefix": "GIT", "color": "#123456"})).await.json()
}

async fn _project_with_repo(c: &Client, repo_dir: &Path) -> Value {
    let p = _project(c).await;
    let r = c.patch(&format!("/projects/{}", id(&p)), json!({"repo_path": text(repo_dir)})).await;
    assert_eq!(r.status, 200);
    assert_eq!(r.json()["repo_path"], json!(text(&repo_dir.canonicalize().expect("resolve"))));
    p
}

async fn _new_ticket(c: &Client, p: &Value) -> Value {
    c.post(&format!("/projects/{}/tickets", id(p)), json!({"title": "x"})).await.json()
}

async fn _ticket_with_repo(c: &Client, repo_dir: &Path) -> Value {
    let p = _project_with_repo(c, repo_dir).await;
    _new_ticket(c, &p).await
}

async fn _branch(c: &Client, t: &Value, name: &str) -> String {
    let r = c.post(&format!("/tickets/{}/branches", id(t)), json!({"name": name})).await;
    assert_eq!(r.status, 201);
    let branches = r.json()["branches"].clone();
    id(branches.as_array().expect("branches").iter().find(|b| b["name"] == name).expect("the branch"))
}

fn _commit_on(repo_dir: &Path, branch: &str, fname: &str) {
    _git(repo_dir, &["checkout", "-q", branch]);
    std::fs::write(repo_dir.join(fname), fname).expect("write");
    _git(repo_dir, &["add", "."]);
    _git(repo_dir, &["commit", "-qm", fname]);
    _git(repo_dir, &["checkout", "-q", "main"]);
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
    let row = |hash: &Value| commits.iter().position(|c| c["hash"] == *hash);
    for (i, c) in commits.iter().enumerate() {
        for (idx, ph) in c["parents"].as_array().expect("parents").iter().enumerate() {
            let Some(parent_row) = row(ph) else { continue };
            let lane = if idx == 0 { &c["lane"] } else { &commits[parent_row]["lane"] };
            if *lane == 0 {
                continue;
            }
            for between in commits.iter().take(parent_row).skip(i + 1) {
                assert!(
                    between["lane"] != *lane,
                    "{} overlaps edge {} -> {}",
                    between["subject"],
                    c["subject"],
                    commits[parent_row]["subject"]
                );
            }
        }
    }
}

async fn branches_of(c: &Client, t: &Value) -> Vec<Value> {
    c.get(&format!("/tickets/{}/branches", id(t))).await.json().as_array().expect("branches").clone()
}

#[tokio::test]
async fn test_link_rejects_non_repo() {
    if !skip_unless_available("test_link_rejects_non_repo") {
        return;
    }
    let s = Server::start().await;
    let c = s.client();
    let tmp_path = tempfile::tempdir().expect("temporary folder");
    let p = _project(&c).await;
    let r = c.patch(&format!("/projects/{}", id(&p)), json!({"repo_path": text(tmp_path.path())})).await;
    assert_eq!(r.status, 400);
}

#[tokio::test]
async fn test_create_branch_creates_real_git_branch() {
    if !skip_unless_available("test_create_branch_creates_real_git_branch") {
        return;
    }
    let s = Server::start().await;
    let c = s.client();
    let repo_dir = repo_dir();
    let p = _project_with_repo(&c, repo_dir.path()).await;
    let t = _new_ticket(&c, &p).await;
    let url = format!("/tickets/{}/branches", id(&t));
    let r = c.post(&url, json!({"name": "feature/x", "branch_from": "main"})).await;
    assert_eq!(r.status, 201);
    let br = r.json()["branches"][0].clone();
    assert!(!br["commit_hash"].as_str().expect("commit_hash").is_empty());
    assert!(br["ahead_count"] == 0 && br["behind_count"] == 0);
    assert!(has(&list_local_branches(repo_dir.path()), "feature/x"));

    // Duplicate and invalid names are rejected
    assert_eq!(c.post(&url, json!({"name": "feature/x"})).await.status, 400);
    assert_eq!(c.post(&url, json!({"name": "bad name..x"})).await.status, 400);
    assert_eq!(c.post(&url, json!({"name": "y", "branch_from": "nope"})).await.status, 400);
}

#[tokio::test]
async fn test_list_branches_reports_live_ahead_behind() {
    if !skip_unless_available("test_list_branches_reports_live_ahead_behind") {
        return;
    }
    let s = Server::start().await;
    let c = s.client();
    let repo_dir = repo_dir();
    let git = |args: &[&str]| _git(repo_dir.path(), args);
    let p = _project_with_repo(&c, repo_dir.path()).await;
    let t = _new_ticket(&c, &p).await;
    c.post(&format!("/tickets/{}/branches", id(&t)), json!({"name": "feature/x"})).await;

    git(&["checkout", "feature/x"]);
    std::fs::write(repo_dir.path().join("b.txt"), "b").expect("write");
    git(&["add", "."]);
    git(&["commit", "-m", "on branch"]);
    git(&["checkout", "main"]);
    std::fs::write(repo_dir.path().join("c.txt"), "c").expect("write");
    git(&["add", "."]);
    git(&["commit", "-m", "on main"]);

    let br = branches_of(&c, &t).await[0].clone();
    assert_eq!(br["ahead_count"], 1);
    assert_eq!(br["behind_count"], 1);
}

#[tokio::test]
async fn test_branches_without_repo_stay_db_only() {
    if !skip_unless_available("test_branches_without_repo_stay_db_only") {
        return;
    }
    let s = Server::start().await;
    let c = s.client();
    let p = _project(&c).await;
    let t = _new_ticket(&c, &p).await;
    let r = c.post(&format!("/tickets/{}/branches", id(&t)), json!({"name": "feature/x", "ahead_count": 3})).await;
    assert_eq!(r.status, 201);
    assert_eq!(r.json()["branches"][0]["ahead_count"], 3);
}

#[tokio::test]
async fn test_ticket_repo_overrides_project_repo() {
    if !skip_unless_available("test_ticket_repo_overrides_project_repo") {
        return;
    }
    let s = Server::start().await;
    let c = s.client();
    let repo_dir = repo_dir();
    let other = tempfile::tempdir().expect("temporary folder");
    for args in [["init", "-b", "main"], ["config", "user.email", "t@e.com"], ["config", "user.name", "T"]] {
        _git(other.path(), &args);
    }
    std::fs::write(other.path().join("z.txt"), "z").expect("write");
    _git(other.path(), &["add", "."]);
    _git(other.path(), &["commit", "-qm", "init"]);

    let p = _project_with_repo(&c, repo_dir.path()).await;
    let t = _new_ticket(&c, &p).await;
    let tid = id(&t);
    assert!(t["repo_path"].is_null()); // inherits from project

    // Invalid override is rejected
    let bad = c.patch(&format!("/tickets/{tid}"), json!({"repo_path": text(&repo_dir.path().join("nope"))})).await;
    assert!(bad.status == 400 || bad.status == 422);

    let r = c.patch(&format!("/tickets/{tid}"), json!({"repo_path": text(other.path())})).await;
    assert!(r.status == 200 && r.json()["repo_path"] == json!(text(&other.path().canonicalize().expect("resolve"))));
    c.post(&format!("/tickets/{tid}/branches"), json!({"name": "only-in-other"})).await;
    assert!(has(&list_local_branches(other.path()), "only-in-other"));
    assert!(!has(&list_local_branches(repo_dir.path()), "only-in-other"));

    // Clearing the override falls back to the project repo
    let r = c.patch(&format!("/tickets/{tid}"), json!({"repo_path": ""})).await;
    assert!(r.json()["repo_path"].is_null());
    c.post(&format!("/tickets/{tid}/branches"), json!({"name": "in-project"})).await;
    assert!(has(&list_local_branches(repo_dir.path()), "in-project"));
}

#[tokio::test]
async fn test_branch_missing_from_repo_is_flagged() {
    if !skip_unless_available("test_branch_missing_from_repo_is_flagged") {
        return;
    }
    let s = Server::start().await;
    let c = s.client();
    let repo_dir = repo_dir();
    let p = _project_with_repo(&c, repo_dir.path()).await;
    let t = _new_ticket(&c, &p).await;
    c.post(&format!("/tickets/{}/branches", id(&t)), json!({"name": "feature/x"})).await;
    _git(repo_dir.path(), &["branch", "-D", "feature/x"]);
    assert_eq!(branches_of(&c, &t).await[0]["in_repo"], false);
}

#[tokio::test]
async fn test_project_worktree_settings() {
    if !skip_unless_available("test_project_worktree_settings") {
        return;
    }
    let s = Server::start().await;
    let c = s.client();
    let repo_dir = repo_dir();
    let p = _project_with_repo(&c, repo_dir.path()).await;
    let r = c
        .patch(
            &format!("/projects/{}", id(&p)),
            json!({"worktree_template": "../worktrees/{project}/{ticket_id}-{branch}", "worktree_by_default": true}),
        )
        .await;
    assert_eq!(r.status, 200);
    let data = r.json();
    assert_eq!(data["worktree_template"], "../worktrees/{project}/{ticket_id}-{branch}");
    assert_eq!(data["worktree_by_default"], true);
}

#[tokio::test]
async fn test_create_branch_with_worktree() {
    if !skip_unless_available("test_create_branch_with_worktree") {
        return;
    }
    let s = Server::start().await;
    let c = s.client();
    let repo_dir = repo_dir();
    let p = _project_with_repo(&c, repo_dir.path()).await;
    let wt_base = repo_dir.path().join("custom_worktrees");
    c.patch(&format!("/projects/{}", id(&p)), json!({"worktree_template": text(&wt_base.join("{branch}"))})).await;
    let t = _new_ticket(&c, &p).await;
    let tid = id(&t);

    // Create branch with worktree
    let r = c
        .post(&format!("/tickets/{tid}/branches"), json!({"name": "feature/worktree-test", "create_worktree": true}))
        .await;
    assert_eq!(r.status, 201);
    let br = r.json()["branches"][0].clone();
    assert!(!br["worktree_path"].is_null());
    assert!(wt_base.join("feature-worktree-test").exists());

    // Delete branch with remove_worktree=true
    let del_r = c.delete(&format!("/tickets/{tid}/branches/{}?remove_worktree=true", id(&br))).await;
    assert_eq!(del_r.status, 200);
    assert!(!wt_base.join("feature-worktree-test").exists());
}

#[tokio::test]
async fn test_failed_worktree_rolls_back_branch() {
    if !skip_unless_available("test_failed_worktree_rolls_back_branch") {
        return;
    }
    let s = Server::start().await;
    let c = s.client();
    let repo_dir = repo_dir();
    let taken = repo_dir.path().join("taken");
    std::fs::create_dir(&taken).expect("mkdir");
    let t = _ticket_with_repo(&c, repo_dir.path()).await;
    let url = format!("/tickets/{}/branches", id(&t));
    let r = c.post(&url, json!({"name": "feat/b", "create_worktree": true, "worktree_path": text(&taken)})).await;
    assert_eq!(r.status, 400);
    assert!(!has(&list_local_branches(repo_dir.path()), "feat/b"));
    // retrying with a free path now works (no orphan branch blocking the name)
    let free = repo_dir.path().join("free");
    let ok = c.post(&url, json!({"name": "feat/b", "create_worktree": true, "worktree_path": text(&free)})).await;
    assert!(ok.status == 201 && free.is_dir());
}

#[tokio::test]
async fn test_worktree_requires_linked_repo() {
    if !skip_unless_available("test_worktree_requires_linked_repo") {
        return;
    }
    let s = Server::start().await;
    let c = s.client();
    let p = _project(&c).await;
    let t = _new_ticket(&c, &p).await;
    let r = c
        .post(
            &format!("/tickets/{}/branches", id(&t)),
            json!({"name": "feat/c", "create_worktree": true, "worktree_path": "/tmp/nowhere-xyz"}),
        )
        .await;
    assert_eq!(r.status, 400);
    assert_eq!(c.get(&format!("/tickets/{}/branches", id(&t))).await.json(), json!([]));
}

#[tokio::test]
async fn test_worktree_removal_failure_is_not_hidden() {
    if !skip_unless_available("test_worktree_removal_failure_is_not_hidden") {
        return;
    }
    let s = Server::start().await;
    let c = s.client();
    let repo_dir = repo_dir();
    let wt = repo_dir.path().join("wt");
    let t = _ticket_with_repo(&c, repo_dir.path()).await;
    let tid = id(&t);
    let r = c
        .post(
            &format!("/tickets/{tid}/branches"),
            json!({"name": "feat/d", "create_worktree": true, "worktree_path": text(&wt)}),
        )
        .await;
    let bid = id(&r.json()["branches"][0]);
    // make the worktree impossible to remove: a locked worktree refuses even --force once
    _git(repo_dir.path(), &["worktree", "lock", &text(&wt)]);
    let res =
        c.patch(&format!("/tickets/{tid}/branches/{bid}"), json!({"status": "merged", "remove_worktree": true})).await;
    assert_eq!(res.status, 400);
    let br = branches_of(&c, &t).await[0].clone();
    assert!(!br["worktree_path"].as_str().expect("worktree_path").is_empty() && br["status"] == "open"); // board unchanged
    _git(repo_dir.path(), &["worktree", "unlock", &text(&wt)]);
}

#[tokio::test]
async fn test_delete_branch_can_also_delete_git_branch() {
    if !skip_unless_available("test_delete_branch_can_also_delete_git_branch") {
        return;
    }
    let s = Server::start().await;
    let c = s.client();
    let repo_dir = repo_dir();
    let repo = repo_dir.path();
    let t = _ticket_with_repo(&c, repo).await;
    let tid = id(&t);
    let r = c.post(&format!("/tickets/{tid}/branches"), json!({"name": "feat/e"})).await;
    let bid = id(&r.json()["branches"][0]);
    // default: board record removed, git branch kept
    c.post(&format!("/tickets/{tid}/branches"), json!({"name": "feat/keep"})).await;
    let keep_id = id(branches_of(&c, &t).await.iter().find(|b| b["name"] == "feat/keep").expect("feat/keep"));
    assert_eq!(c.delete(&format!("/tickets/{tid}/branches/{keep_id}")).await.status, 200);
    assert!(has(&list_local_branches(repo), "feat/keep"));

    // unmerged work: safe delete refuses and leaves the board record in place
    _git(repo, &["checkout", "-q", "feat/e"]);
    std::fs::write(repo.join("n.txt"), "n").expect("write");
    _git(repo, &["add", "."]);
    _git(repo, &["commit", "-qm", "unmerged"]);
    _git(repo, &["checkout", "-q", "main"]);
    // (httpx writes `True` in a query as "true")
    let res = c.delete(&format!("/tickets/{tid}/branches/{bid}?delete_git_branch=true")).await;
    assert!(res.status == 400 && res.detail().as_str().expect("detail").contains("not fully merged"));
    assert_eq!(branches_of(&c, &t).await.len(), 1);
    assert!(has(&list_local_branches(repo), "feat/e"));

    // force removes both
    let res = c.delete(&format!("/tickets/{tid}/branches/{bid}?delete_git_branch=true&force=true")).await;
    assert_eq!(res.status, 200);
    assert!(!has(&list_local_branches(repo), "feat/e"));
}

#[tokio::test]
async fn test_mark_merged_is_verified_against_git() {
    if !skip_unless_available("test_mark_merged_is_verified_against_git") {
        return;
    }
    let s = Server::start().await;
    let c = s.client();
    let repo_dir = repo_dir();
    let t = _ticket_with_repo(&c, repo_dir.path()).await;
    let bid = _branch(&c, &t, "feat/m").await;
    _commit_on(repo_dir.path(), "feat/m", "m.txt");
    // not merged in git yet -> refused, board unchanged
    let url = format!("/tickets/{}/branches/{bid}", id(&t));
    let r = c.patch(&url, json!({"status": "merged"})).await;
    assert!(r.status == 400 && r.detail().as_str().expect("detail").contains("not in 'main'"));
    assert_eq!(branches_of(&c, &t).await[0]["status"], "open");
    // merge in git, then marking merged is accepted
    _git(repo_dir.path(), &["merge", "-q", "--no-ff", "feat/m", "-m", "merge"]);
    let r = c.patch(&url, json!({"status": "merged"})).await;
    assert!(r.status == 200 && r.json()["branches"][0]["status"] == "merged");
}

#[tokio::test]
async fn test_rename_branch_renames_in_git() {
    if !skip_unless_available("test_rename_branch_renames_in_git") {
        return;
    }
    let s = Server::start().await;
    let c = s.client();
    let repo_dir = repo_dir();
    let t = _ticket_with_repo(&c, repo_dir.path()).await;
    let bid = _branch(&c, &t, "feat/old").await;
    _branch(&c, &t, "feat/taken").await;
    // name collision is refused and nothing changes
    let url = format!("/tickets/{}/branches/{bid}", id(&t));
    let r = c.patch(&url, json!({"name": "feat/taken"})).await;
    assert_eq!(r.status, 400);
    let r = c.patch(&url, json!({"name": "feat/new"})).await;
    assert_eq!(r.status, 200);
    let names = list_local_branches(repo_dir.path());
    assert!(has(&names, "feat/new") && !has(&names, "feat/old"));
    assert_eq!(branches_of(&c, &t).await[0]["name"], "feat/new");
}

#[tokio::test]
async fn test_checkout_branch() {
    if !skip_unless_available("test_checkout_branch") {
        return;
    }
    let s = Server::start().await;
    let c = s.client();
    let repo_dir = repo_dir();
    let repo = repo_dir.path();
    let t = _ticket_with_repo(&c, repo).await;
    let bid = _branch(&c, &t, "feat/co").await;
    let branches = branches_of(&c, &t).await;
    assert_eq!(branches[0]["is_current"], false);

    // dirty working tree -> refused, HEAD stays on main
    std::fs::write(repo.join("a.txt"), "changed").expect("write");
    let url = format!("/tickets/{}/branches/{bid}/checkout", id(&t));
    let r = c.post_empty(&url).await;
    assert!(r.status == 400 && r.detail().as_str().expect("detail").contains("uncommitted"));
    assert_eq!(_git(repo, &["branch", "--show-current"]).trim(), "main");

    _git(repo, &["checkout", "--", "a.txt"]);
    let r = c.post_empty(&url).await;
    assert_eq!(r.status, 200);
    assert_eq!(_git(repo, &["branch", "--show-current"]).trim(), "feat/co");
    assert_eq!(branches_of(&c, &t).await[0]["is_current"], true);
}

#[tokio::test]
async fn test_graph_without_repo_is_not_linked() {
    if !skip_unless_available("test_graph_without_repo_is_not_linked") {
        return;
    }
    let s = Server::start().await;
    let c = s.client();
    let p = _project(&c).await;
    let t = _new_ticket(&c, &p).await;
    let g = c.get(&format!("/tickets/{}/graph", id(&t))).await.json();
    assert!(g["linked"] == false && g["commits"] == json!([]));
}

#[tokio::test]
async fn test_graph_shows_real_history_with_multiple_merges_and_branches() {
    if !skip_unless_available("test_graph_shows_real_history_with_multiple_merges_and_branches") {
        return;
    }
    let s = Server::start().await;
    let c = s.client();
    let repo_dir = repo_dir();
    let repo = repo_dir.path();
    let t = _ticket_with_repo(&c, repo).await;
    for name in ["feat/a", "feat/b", "feat/c"] {
        _branch(&c, &t, name).await;
    }
    // feat/a: 2 commits, stays open
    _commit(repo, "a1.txt", Some("feat/a"));
    _commit(repo, "a2.txt", None);
    // feat/b: merged into main (branch kept), then main moves on
    _commit(repo, "b1.txt", Some("feat/b"));
    _git(repo, &["checkout", "-q", "main"]);
    _git(repo, &["merge", "-q", "--no-ff", "feat/b", "-m", "merge b"]);
    _commit(repo, "m1.txt", None);
    // feat/c: merged then branch deleted from git
    _commit(repo, "c1.txt", Some("feat/c"));
    _git(repo, &["checkout", "-q", "main"]);
    _git(repo, &["merge", "-q", "--no-ff", "feat/c", "-m", "merge c"]);
    _git(repo, &["branch", "-D", "feat/c"]);

    let g = c.get(&format!("/tickets/{}/graph", id(&t))).await.json();
    assert!(g["linked"] == true && g["base"] == "main");
    let commits = g["commits"].as_array().expect("commits");
    let by_subject = |subject: &str| -> &Value {
        commits.iter().find(|x| x["subject"] == subject).unwrap_or_else(|| panic!("no commit {subject}"))
    };
    // mainline commits sit on lane 0, side work on lanes >= 1
    for subject in ["init", "merge b", "add m1.txt", "merge c"] {
        assert_eq!(by_subject(subject)["lane"], 0, "{subject}");
    }
    for subject in ["add a1.txt", "add a2.txt", "add b1.txt", "add c1.txt"] {
        assert!(by_subject(subject)["lane"].as_i64().expect("lane") >= 1, "{subject}");
    }
    // both merges are real two-parent commits
    let parents = |subject: &str| by_subject(subject)["parents"].as_array().expect("parents").len();
    assert!(parents("merge b") == 2 && parents("merge c") == 2);
    // open branch commits are attributed to feat/a; merged work is no longer 'exclusive'
    assert_eq!(by_subject("add a2.txt")["ticket_branches"], json!(["feat/a"]));
    assert_eq!(by_subject("add b1.txt")["ticket_branches"], json!([]));
    // tips carry their ref labels, HEAD on main
    let refs = |subject: &str| by_subject(subject)["refs"].as_array().expect("refs").clone();
    assert!(refs("add a2.txt").iter().any(|r| r["name"] == "feat/a"));
    assert!(refs("merge c").iter().any(|r| r["name"] == "HEAD"));
    assert!(g["lane_count"].as_i64().expect("lane_count") >= 2);
    _assert_no_lane_overlap(commits);
}

#[tokio::test]
async fn test_graph_window_reaches_back_to_branch_fork() {
    if !skip_unless_available("test_graph_window_reaches_back_to_branch_fork") {
        return;
    }
    let s = Server::start().await;
    let c = s.client();
    let repo_dir = repo_dir();
    let repo = repo_dir.path();
    let t = _ticket_with_repo(&c, repo).await;
    _branch(&c, &t, "feat/old").await;
    _commit(repo, "o1.txt", Some("feat/old"));
    _git(repo, &["checkout", "-q", "main"]);
    for i in 0..30 {
        _commit(repo, &format!("main{i}.txt"), None);
    }
    let g = c.get_query(&format!("/tickets/{}/graph", id(&t)), &[("limit", "5")]).await.json();
    let commits = g["commits"].as_array().expect("commits");
    let subjects: Vec<&str> = commits.iter().map(|x| x["subject"].as_str().expect("subject")).collect();
    // window grew past limit=5 so the branch and its fork point are both present
    assert!(subjects.contains(&"add o1.txt") && subjects.contains(&"init"));
    assert!(commits.len() >= 32);
}

#[tokio::test]
async fn test_graph_limit_truncates_when_branch_forked_recently() {
    if !skip_unless_available("test_graph_limit_truncates_when_branch_forked_recently") {
        return;
    }
    let s = Server::start().await;
    let c = s.client();
    let repo_dir = repo_dir();
    let repo = repo_dir.path();
    let t = _ticket_with_repo(&c, repo).await;
    for i in 0..12 {
        _commit(repo, &format!("main{i}.txt"), None);
    }
    _branch(&c, &t, "feat/new").await; // forks at the current tip
    _commit(repo, "n1.txt", Some("feat/new"));
    _git(repo, &["checkout", "-q", "main"]);
    let g = c.get_query(&format!("/tickets/{}/graph", id(&t)), &[("limit", "5")]).await.json();
    assert!(g["commits"].as_array().expect("commits").len() == 5 && g["truncated"] == true);
}

#[tokio::test]
async fn test_commit_detail_message_and_file_changes() {
    if !skip_unless_available("test_commit_detail_message_and_file_changes") {
        return;
    }
    let s = Server::start().await;
    let c = s.client();
    let repo_dir = repo_dir();
    let repo = repo_dir.path();
    let t = _ticket_with_repo(&c, repo).await;
    let tid = id(&t);
    let files = |d: &Value| -> Vec<(Value, Value)> {
        d["files"].as_array().expect("files").iter().map(|f| (f["status"].clone(), f["path"].clone())).collect()
    };
    let by_path = |d: &Value, path: &str| -> Value {
        d["files"].as_array().expect("files").iter().find(|f| f["path"] == path).expect("the file").clone()
    };
    // root commit: a.txt added
    let root = _git(repo, &["rev-parse", "HEAD"]).trim().to_string();
    let d = c.get(&format!("/tickets/{tid}/commits/{root}")).await.json();
    assert!(d["subject"] == "init" && d["body"] == "" && d["parents"] == json!([]));
    assert_eq!(files(&d), vec![(json!("A"), json!("a.txt"))]);

    // modify + add + delete + rename + binary in one multi-line commit
    std::fs::write(repo.join("a.txt"), "a\nline2\nline3\n").expect("write");
    std::fs::write(repo.join("new.txt"), "n1\nn2\n").expect("write");
    std::fs::write(repo.join("gone.txt"), "x").expect("write");
    _git(repo, &["add", "."]);
    _git(repo, &["commit", "-qm", "seed"]);
    _git(repo, &["rm", "-q", "gone.txt"]);
    _git(repo, &["mv", "new.txt", "renamed.txt"]);
    std::fs::write(repo.join("img.bin"), b"\x00\x01\x02\x03").expect("write");
    _git(repo, &["add", "."]);
    _git(repo, &["commit", "-q", "-m", "Big change", "-m", "Body paragraph one.\n\nSecond paragraph."]);
    let sha = _git(repo, &["rev-parse", "HEAD"]).trim().to_string();
    let d = c.get(&format!("/tickets/{tid}/commits/{}", &sha[..10])).await.json(); // short hash works
    assert!(d["hash"] == json!(sha) && d["subject"] == "Big change");
    assert_eq!(d["body"], "Body paragraph one.\n\nSecond paragraph.");
    assert!(d["author"] == "Tester" && d["author_email"] == "t@example.com");
    assert_eq!(by_path(&d, "gone.txt")["status"], "D");
    assert!(by_path(&d, "renamed.txt")["status"] == "R" && by_path(&d, "renamed.txt")["old_path"] == "new.txt");
    assert!(by_path(&d, "img.bin")["binary"] == true && by_path(&d, "img.bin")["additions"] == 0);
    assert!(d["file_count"] == 3 && d["files_truncated"] == false);

    // the earlier 'seed' commit reports line counts
    let seed = _git(repo, &["rev-parse", "HEAD~1"]).trim().to_string();
    let sd = c.get(&format!("/tickets/{tid}/commits/{seed}")).await.json();
    // "a" (no trailing newline) became "a\nline2\nline3\n": git counts +3 -1
    let a = by_path(&sd, "a.txt");
    assert!(a["status"] == "M" && a["additions"] == 3 && a["deletions"] == 1);
    assert!(by_path(&sd, "new.txt")["additions"] == 2 && by_path(&sd, "gone.txt")["additions"] == 1);
    assert!(sd["additions"] == 6 && sd["deletions"] == 1);
}

#[tokio::test]
async fn test_commit_detail_merge_uses_first_parent_and_validates_input() {
    if !skip_unless_available("test_commit_detail_merge_uses_first_parent_and_validates_input") {
        return;
    }
    let s = Server::start().await;
    let c = s.client();
    let repo_dir = repo_dir();
    let repo = repo_dir.path();
    let t = _ticket_with_repo(&c, repo).await;
    let tid = id(&t);
    _branch(&c, &t, "feat/mm").await;
    _commit(repo, "side.txt", Some("feat/mm"));
    _git(repo, &["checkout", "-q", "main"]);
    _git(repo, &["merge", "-q", "--no-ff", "feat/mm", "-m", "merge side"]);
    let sha = _git(repo, &["rev-parse", "HEAD"]).trim().to_string();
    let d = c.get(&format!("/tickets/{tid}/commits/{sha}")).await.json();
    assert_eq!(d["parents"].as_array().expect("parents").len(), 2);
    let files: Vec<(Value, Value)> =
        d["files"].as_array().expect("files").iter().map(|f| (f["status"].clone(), f["path"].clone())).collect();
    assert_eq!(files, vec![(json!("A"), json!("side.txt"))]);

    assert_eq!(c.get(&format!("/tickets/{tid}/commits/not-a-hash")).await.status, 400);
    assert_eq!(c.get(&format!("/tickets/{tid}/commits/{}", "0".repeat(40))).await.status, 400);
    let status = c.get(&format!("/tickets/{tid}/commits/--output=x")).await.status;
    assert!(status == 400 || status == 404);
}

#[tokio::test]
async fn test_commit_detail_requires_linked_repo() {
    if !skip_unless_available("test_commit_detail_requires_linked_repo") {
        return;
    }
    let s = Server::start().await;
    let c = s.client();
    let p = _project(&c).await;
    let t = _new_ticket(&c, &p).await;
    assert_eq!(c.get(&format!("/tickets/{}/commits/abcdef1", id(&t))).await.status, 400);
}

#[tokio::test]
async fn test_branch_from_main_starts_from_master_when_repo_has_no_main() {
    if !skip_unless_available("test_branch_from_main_starts_from_master_when_repo_has_no_main") {
        return;
    }
    let s = Server::start().await;
    let c = s.client();
    let master_repo_dir = master_repo_dir();
    let p = _project_with_repo(&c, master_repo_dir.path()).await;
    let t = _new_ticket(&c, &p).await;
    let tid = id(&t);
    let base = c.get(&format!("/tickets/{tid}/branches/base")).await;
    assert!(base.status == 200 && base.json() == json!({"base": "master"}));

    // The form's old default ("main") and no base at all both start from master
    let r = c.post(&format!("/tickets/{tid}/branches"), json!({"name": "feature/x", "branch_from": "main"})).await;
    assert_eq!(r.status, 201, "{}", r.text());
    assert_eq!(r.json()["branches"][0]["branch_from"], "master");
    let r = c.post(&format!("/tickets/{tid}/branches"), json!({"name": "feature/y"})).await;
    assert_eq!(r.status, 201, "{}", r.text());

    // A base that really does not exist is still refused
    let r = c.post(&format!("/tickets/{tid}/branches"), json!({"name": "z", "branch_from": "nope"})).await;
    assert_eq!(r.status, 400);

    let mut listed: Vec<String> =
        branches_of(&c, &t).await.iter().map(|b| b["name"].as_str().expect("name").to_string()).collect();
    listed.sort();
    assert_eq!(listed, ["feature/x", "feature/y"]);
}

#[tokio::test]
async fn test_default_base_without_repo_and_for_missing_ticket() {
    if !skip_unless_available("test_default_base_without_repo_and_for_missing_ticket") {
        return;
    }
    let s = Server::start().await;
    let c = s.client();
    let p = _project(&c).await;
    let t = _new_ticket(&c, &p).await;
    assert_eq!(c.get(&format!("/tickets/{}/branches/base", id(&t))).await.json(), json!({"base": null}));
    assert_eq!(c.get("/tickets/NOPE-1/branches/base").await.status, 404);
}

#[tokio::test]
async fn test_default_base_prefers_main() {
    if !skip_unless_available("test_default_base_prefers_main") {
        return;
    }
    let s = Server::start().await;
    let c = s.client();
    let repo_dir = repo_dir();
    let p = _project_with_repo(&c, repo_dir.path()).await;
    let t = _new_ticket(&c, &p).await;
    assert_eq!(c.get(&format!("/tickets/{}/branches/base", id(&t))).await.json(), json!({"base": "main"}));
}
