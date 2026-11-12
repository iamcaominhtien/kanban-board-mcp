//! One check per route of `api/ai_code.py` (where the AIs work and how code is handed over): the answer of each
//! route, for the success case and for each error branch, must be what the Python server answers, over a real git
//! repository and worktrees the test makes with `git`. Recorded from the Python server in
//! `contract/golden/ai_code_routes/<test>.json`:
//!
//! `AI_ROUTES_RECORD=1 PARITY_TARGET=python cargo test -p kb-ai-api --test ai_code_routes`

mod common;

use std::path::{Path, PathBuf};
use std::process::Command;

use common::rec::Rec;
use common::{Fixture, exec, insert, project, start, ticket};
use serde_json::json;

/// The folder of the test.
fn tmp(f: &Fixture) -> PathBuf {
    f.accounts.parent().expect("the test's folder").to_path_buf()
}

/// `git` in a folder, which must succeed.
fn git(folder: &Path, args: &[&str]) {
    let out = Command::new("git").args(args).current_dir(folder).output().expect("git runs");
    assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
}

/// A repository with one commit on `main`.
fn make_repo(f: &Fixture) -> PathBuf {
    let repo = tmp(f).join("repo");
    std::fs::create_dir_all(&repo).expect("repo folder");
    git(&repo, &["init", "-q", "-b", "main"]);
    git(&repo, &["config", "user.email", "an@work.example"]);
    git(&repo, &["config", "user.name", "An Nguyen"]);
    std::fs::write(repo.join("calc.py"), "def add(a, b):\n    return a - b\n").expect("calc.py");
    git(&repo, &["add", "."]);
    git(&repo, &["commit", "-q", "-m", "first"]);
    repo
}

/// A worktree of the repository for a ticket, and its row (state `active`).
async fn make_worktree(f: &Fixture, repo: &Path, pid: &str, ticket_id: &str, port: i64) -> PathBuf {
    let path = tmp(f).join("repo.worktrees").join(ticket_id);
    let branch = format!("ai/{ticket_id}-work");
    git(repo, &["worktree", "add", "-q", "-b", &branch, &path.to_string_lossy(), "main"]);
    insert(
        &f.server,
        "ai_worktree",
        &json!({"ticket_id": ticket_id, "project_id": pid, "repo": repo.to_string_lossy(), "path": path.to_string_lossy(),
                "branch": branch, "base": "main", "port": port, "state": "active", "conflict_files": "[]",
                "created_at": common::NOW}),
    )
    .await;
    path
}

#[tokio::test]
async fn worktree_routes() {
    let name = "worktree_routes";
    let Some(f) = start(name, true, &[]).await else { return };
    let c = &f.c;
    let mut rec = Rec::new("ai_code_routes", name, &[&tmp(&f), f.server.dir()]);
    let (pid, _an) = project(c).await;
    let repo = make_repo(&f);
    let t1 = ticket(c, &pid, "Fix add()", "todo").await;
    let t2 = ticket(c, &pid, "No worktree", "todo").await;
    let t3 = ticket(c, &pid, "Merged", "todo").await;
    let t4 = ticket(c, &pid, "Done", "done").await;
    let listing = format!("/projects/{pid}/ai/worktrees");
    rec.check("GET worktrees: none", &c.get(&listing).await);
    rec.check("GET worktrees: no such project", &c.get("/projects/nope/ai/worktrees").await);
    rec.check("GET worktree: none", &c.get(&format!("/tickets/{t2}/ai/worktree")).await);
    rec.check("GET worktree: no such ticket", &c.get("/tickets/nope/ai/worktree").await);
    for (route, body) in [("keep", None), ("outputs", None), ("commit", None), ("open", None)] {
        let url = format!("/tickets/{t2}/ai/worktree/{route}");
        let r = match body {
            None => c.post_empty(&url).await,
            Some(b) => c.post(&url, b).await,
        };
        rec.check(&format!("POST {route}: no worktree"), &r);
    }
    rec.check("POST remove: no worktree", &c.post(&format!("/tickets/{t2}/ai/worktree/remove"), json!({})).await);
    rec.check("POST remove: no body", &c.post_empty(&format!("/tickets/{t2}/ai/worktree/remove")).await);
    rec.check(
        "PATCH handover: no worktree",
        &c.patch(&format!("/tickets/{t2}/ai/handover"), json!({"route": "pr"})).await,
    );
    rec.check("PATCH handover: no route", &c.patch(&format!("/tickets/{t2}/ai/handover"), json!({})).await);
    rec.check(
        "PATCH handover: a route that is not one",
        &c.patch(&format!("/tickets/{t2}/ai/handover"), json!({"route": "fly"})).await,
    );
    rec.check("POST merge: no worktree", &c.post_empty(&format!("/tickets/{t2}/ai/merge")).await);

    // a worktree with a change and an output left in it
    let w1 = make_worktree(&f, &repo, &pid, &t1, 3101).await;
    std::fs::write(w1.join("calc.py"), "def add(a, b):\n    return a + b\n").expect("edit");
    std::fs::write(w1.join("big.bin"), vec![0u8; 1_600_000]).expect("a big file");
    std::fs::create_dir_all(w1.join("screenshots")).expect("folder");
    std::fs::write(w1.join("screenshots").join("shot.png"), b"png").expect("output");
    rec.check("GET worktrees", &c.get(&listing).await);
    let one = format!("/tickets/{t1}/ai/worktree");
    rec.check("GET worktree", &c.get(&one).await);
    rec.check("POST remove: something is not committed", &c.post(&format!("{one}/remove"), json!({})).await);
    rec.check("POST remove: force is text", &c.post(&format!("{one}/remove"), json!({"force": "x"})).await);
    rec.check("POST cleanup: nothing is finished", &c.post_empty(&format!("{listing}/cleanup")).await);
    // (the folder in the Workspace is named by the minute)
    rec.check_hiding("POST outputs", &c.post_empty(&format!("{one}/outputs")).await, &["to"]);
    rec.check("GET worktree: after the outputs", &c.get(&one).await);
    // no file manager here: the board says so; then one that answers
    rec.check("POST open: no file manager", &c.post_empty(&format!("{one}/open")).await);
    let opener = f.bin.join("xdg-open");
    std::fs::write(&opener, "#!/bin/sh\nexit 0\n").expect("opener");
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&opener, std::fs::Permissions::from_mode(0o755)).expect("mode");
    }
    rec.check("POST open", &c.post_empty(&format!("{one}/open")).await);
    rec.check("PATCH handover: pr", &c.patch(&format!("/tickets/{t1}/ai/handover"), json!({"route": "pr"})).await);
    rec.check("PATCH handover: auto", &c.patch(&format!("/tickets/{t1}/ai/handover"), json!({"route": "auto"})).await);
    rec.check(
        "PATCH handover: local",
        &c.patch(&format!("/tickets/{t1}/ai/handover"), json!({"route": "local"})).await,
    );
    rec.check("POST commit", &c.post_empty(&format!("{one}/commit")).await);
    rec.check("POST commit: nothing left", &c.post_empty(&format!("{one}/commit")).await);
    rec.check("GET worktrees: after the commit", &c.get(&listing).await);
    rec.check("POST keep", &c.post_empty(&format!("{one}/keep")).await);
    rec.check("POST cleanup: a kept one stays", &c.post_empty(&format!("{listing}/cleanup")).await);
    rec.check("POST merge", &c.post_empty(&format!("/tickets/{t1}/ai/merge")).await);
    rec.check("GET worktree: merged", &c.get(&one).await);
    rec.check("POST merge: again", &c.post_empty(&format!("/tickets/{t1}/ai/merge")).await);
    // finished worktrees: one whose ticket is done, one that holds something
    let w4 = make_worktree(&f, &repo, &pid, &t4, 3102).await;
    let w3 = make_worktree(&f, &repo, &pid, &t3, 3103).await;
    exec(&f.server, "UPDATE ai_worktree SET state = 'merged' WHERE ticket_id = ?", &[json!(t3)]).await;
    std::fs::write(w3.join("notes.txt"), "left").expect("left");
    rec.check("POST cleanup", &c.post_empty(&format!("{listing}/cleanup")).await);
    rec.check("GET worktrees: after the cleanup", &c.get(&listing).await);
    rec.check("GET worktree: removed", &c.get(&format!("/tickets/{t4}/ai/worktree")).await);
    rec.check("POST open: a removed worktree", &c.post_empty(&format!("/tickets/{t4}/ai/worktree/open")).await);
    let _ = w4;
    rec.finish();
}
