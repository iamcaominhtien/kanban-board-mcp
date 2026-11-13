//! One check per route of `api/ai_tools.py` (skills and plugins installed from a source, role packs, and the
//! repository scan that gives a project a team): the answer of each route, for the success case and for each error
//! branch, must be what the Python server answers. Sources are folders and git repositories the test makes; nothing
//! reaches the network. Recorded from the Python server in `contract/golden/ai_tools_routes/<test>.json`:
//!
//! `AI_ROUTES_RECORD=1 PARITY_TARGET=python cargo test -p kb-ai-api --test ai_tools_routes`

mod common;

use std::path::Path;
use std::process::Command;
use std::time::Duration;

use common::rec::Rec;
use common::{id, project, start, tmp};
use serde_json::{Value, json};
use testkit::Client;

/// `git` in a folder, which must succeed.
fn git(folder: &Path, args: &[&str]) {
    let out = Command::new("git").args(args).current_dir(folder).output().expect("git runs");
    assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
}

/// A plugin folder: one skill.
fn make_plugin(folder: &Path, skill: &str, text: &str) {
    let dir = folder.join("skills").join(skill);
    std::fs::create_dir_all(&dir).expect("skill folder");
    std::fs::write(dir.join("SKILL.md"), format!("---\nname: {skill}\ndescription: {text}\n---\n\nDo it.\n"))
        .expect("SKILL.md");
}

#[tokio::test]
async fn catalogue_and_plugin_routes() {
    let name = "catalogue_and_plugin_routes";
    let Some(f) = start(name, true, &[]).await else { return };
    let c = &f.c;
    let mut rec = Rec::new("ai_tools_routes", name, &[&tmp(&f), f.server.dir()]);
    // what an install writes down about where and when
    rec.ignore(&["commit", "installed_at", "updated_at", "current", "latest"]);
    let (pid, _an) = project(c).await;
    rec.check("GET catalogue", &c.get("/ai/catalogue").await);
    rec.check("GET board-skills", &c.get("/ai/board-skills").await);
    let url = format!("/projects/{pid}/ai/plugins");
    rec.check("GET plugins: none", &c.get(&url).await);
    rec.check("GET plugins: no such project", &c.get("/projects/nope/ai/plugins").await);

    let folder = tmp(&f).join("hello-plugin");
    make_plugin(&folder, "hello", "Says hello");
    make_plugin(&folder, "bye", "Says bye");
    let source = folder.to_string_lossy().into_owned();
    rec.check(
        "POST preview: no such project",
        &c.post("/projects/nope/ai/plugins/preview", json!({"source": source, "source_kind": "folder"})).await,
    );
    rec.check("POST preview: no source", &c.post(&format!("{url}/preview"), json!({})).await);
    rec.check(
        "POST preview: a kind that is not one",
        &c.post(&format!("{url}/preview"), json!({"source": source, "source_kind": "svn"})).await,
    );
    rec.check(
        "POST preview: skills is text",
        &c.post(&format!("{url}/preview"), json!({"source": source, "source_kind": "folder", "skills": "hello"})).await,
    );
    rec.check(
        "POST preview: no such folder",
        &c.post(
            &format!("{url}/preview"),
            json!({"source": tmp(&f).join("nowhere").to_string_lossy(), "source_kind": "folder"}),
        )
        .await,
    );
    rec.check(
        "POST preview",
        &c.post(&format!("{url}/preview"), json!({"source": source, "source_kind": "folder"})).await,
    );
    rec.check(
        "POST preview: one skill",
        &c.post(&format!("{url}/preview"), json!({"source": source, "source_kind": "folder", "skills": ["hello"]}))
            .await,
    );
    rec.check(
        "POST preview: a skill that is not there",
        &c.post(&format!("{url}/preview"), json!({"source": source, "source_kind": "folder", "skills": ["nope"]}))
            .await,
    );
    rec.check(
        "POST install: no such project",
        &c.post("/projects/nope/ai/plugins", json!({"source": source, "source_kind": "folder"})).await,
    );
    rec.check("POST install: no source", &c.post(&url, json!({})).await);
    rec.check(
        "POST install: roles is text",
        &c.post(&url, json!({"source": source, "source_kind": "folder", "roles": "dev"})).await,
    );
    rec.check(
        "POST install: no such folder",
        &c.post(&url, json!({"source": tmp(&f).join("nowhere").to_string_lossy(), "source_kind": "folder"})).await,
    );
    let installed = c
        .post(&url, json!({"source": source, "source_kind": "folder", "roles": ["dev", "qa"], "default_on": true}))
        .await;
    rec.check("POST install", &installed);
    installed.assert_status(201);
    let plugin = id(&installed.json());
    rec.check("GET plugins", &c.get(&url).await);
    let one = format!("/ai/plugins/{plugin}");
    rec.check("PATCH plugin: not found", &c.patch("/ai/plugins/nope", json!({"default_on": false})).await);
    rec.check("PATCH plugin: roles is a number", &c.patch(&one, json!({"roles": 3})).await);
    rec.check("PATCH plugin", &c.patch(&one, json!({"default_on": false, "roles": ["dev"]})).await);
    rec.check("PATCH plugin: nothing", &c.patch(&one, json!({})).await);
    rec.check("GET update: not found", &c.get("/ai/plugins/nope/update").await);
    rec.check("GET update", &c.get(&format!("{one}/update")).await);
    rec.check("GET changes: not found", &c.get("/ai/plugins/nope/changes").await);
    rec.check("GET changes: nothing changed", &c.get(&format!("{one}/changes")).await);
    make_plugin(&folder, "later", "Added after the install");
    rec.check("GET changes: a skill was added", &c.get(&format!("{one}/changes")).await);
    rec.check("POST action: not found", &c.post_empty("/ai/plugins/nope/update").await);
    rec.check("POST action: not an action", &c.post_empty(&format!("{one}/explode")).await);
    rec.check("POST rollback: nothing before", &c.post_empty(&format!("{one}/rollback")).await);
    rec.check("POST update", &c.post_empty(&format!("{one}/update")).await);
    rec.check("POST rollback", &c.post_empty(&format!("{one}/rollback")).await);
    rec.check("POST reload", &c.post_empty(&format!("{one}/reload")).await);
    rec.check("POST reset", &c.post_empty(&format!("{one}/reset")).await);
    rec.check("POST pin", &c.post_empty(&format!("{one}/pin")).await);
    rec.check("POST update: it is pinned", &c.post_empty(&format!("{one}/update")).await);
    rec.check("GET update: it is pinned", &c.get(&format!("{one}/update")).await);
    rec.check("POST unpin", &c.post_empty(&format!("{one}/unpin")).await);
    std::fs::remove_dir_all(&folder).expect("remove the source");
    rec.check("POST reload: the source is gone", &c.post_empty(&format!("{one}/reload")).await);
    rec.check("GET changes: the source is gone", &c.get(&format!("{one}/changes")).await);
    // a git source (a local repository)
    let repo = tmp(&f).join("hello-repo");
    make_plugin(&repo, "git-hello", "Says hello from git");
    git(&repo, &["init", "-q", "-b", "main"]);
    git(&repo, &["config", "user.email", "an@work.example"]);
    git(&repo, &["config", "user.name", "An Nguyen"]);
    git(&repo, &["add", "."]);
    git(&repo, &["commit", "-q", "-m", "first"]);
    let from_git = c.post(&url, json!({"source": repo.to_string_lossy(), "source_kind": "git"})).await;
    rec.check("POST install: git", &from_git);
    from_git.assert_status(201);
    let git_plugin = format!("/ai/plugins/{}", id(&from_git.json()));
    rec.check("GET update: git, up to date", &c.get(&format!("{git_plugin}/update")).await);
    make_plugin(&repo, "git-more", "A second skill");
    git(&repo, &["add", "."]);
    git(&repo, &["commit", "-q", "-m", "second"]);
    rec.check("GET update: git, a newer commit", &c.get(&format!("{git_plugin}/update")).await);
    rec.check("GET changes: git", &c.get(&format!("{git_plugin}/changes")).await);
    rec.check("POST update: git", &c.post_empty(&format!("{git_plugin}/update")).await);
    rec.check(
        "POST install: git, no such repository",
        &c.post(&url, json!({"source": tmp(&f).join("no-repo").to_string_lossy(), "source_kind": "git"})).await,
    );
    rec.check("GET plugins: both", &c.get(&url).await);
    rec.check("DELETE plugin: not found", &c.delete("/ai/plugins/nope").await);
    rec.check("DELETE plugin", &c.delete(&one).await);
    rec.check("DELETE plugin: git", &c.delete(&git_plugin).await);
    rec.check("GET plugins: none left", &c.get(&url).await);
    rec.finish();
}

#[tokio::test]
async fn pack_routes() {
    let name = "pack_routes";
    let Some(f) = start(name, true, &[]).await else { return };
    let c = &f.c;
    let mut rec = Rec::new("ai_tools_routes", name, &[&tmp(&f), f.server.dir()]);
    let (pid, _an) = project(c).await;
    let url = format!("/projects/{pid}/ai/packs");
    rec.check("GET packs", &c.get(&url).await);
    rec.check("GET packs: no such project", &c.get("/projects/nope/ai/packs").await);
    rec.check("GET pack: ready-made", &c.get(&format!("{url}/reviewer")).await);
    rec.check("GET pack: not found", &c.get(&format!("{url}/nope")).await);
    rec.check("PUT pack: no such project", &c.put("/projects/nope/ai/packs/mine", json!({"name": "Mine"})).await);
    rec.check("PUT pack: no body", &c.request("PUT", &format!("{url}/mine"), &[], None).await);
    rec.check("PUT pack: a list", &c.put(&format!("{url}/mine"), json!([1])).await);
    rec.check("PUT pack: no name", &c.put(&format!("{url}/mine"), json!({})).await);
    rec.check("PUT pack: a key that is no slug", &c.put(&format!("{url}/%20%20"), json!({"name": "Mine"})).await);
    rec.check(
        "PUT pack",
        &c.put(
            &format!("{url}/mine"),
            json!({"name": "Mine", "description": "My pack", "persona": "Be brief.", "model": "stand-in", "extra": 1}),
        )
        .await,
    );
    rec.check(
        "PUT pack: a second version",
        &c.put(&format!("{url}/mine"), json!({"name": "Mine", "persona": "Be very brief."})).await,
    );
    rec.check(
        "PUT pack: a ready-made one makes the project's copy",
        &c.put(&format!("{url}/reviewer"), json!({"name": "Reviewer", "persona": "Read the diff."})).await,
    );
    rec.check("GET pack", &c.get(&format!("{url}/mine")).await);
    rec.check("GET packs: with the project's own", &c.get(&url).await);
    rec.check("GET export: not found", &c.get(&format!("{url}/nope/export")).await);
    let export = c.get(&format!("{url}/mine/export")).await;
    rec.check("GET export", &export);
    rec.check("POST import: no such project", &c.post("/projects/nope/ai/packs/import", export.json()).await);
    rec.check("POST import: no body", &c.post_empty(&format!("{url}/import")).await);
    rec.check("POST import: not a pack file", &c.post(&format!("{url}/import"), json!({"format": "other"})).await);
    rec.check("POST import", &c.post(&format!("{url}/import"), export.json()).await);
    rec.check("DELETE pack: ready-made", &c.delete(&format!("{url}/triage")).await);
    rec.check("DELETE pack: not found", &c.delete(&format!("{url}/nope")).await);
    rec.check("DELETE pack", &c.delete(&format!("{url}/mine")).await);
    rec.check("DELETE pack: the copy of a ready-made one", &c.delete(&format!("{url}/reviewer")).await);
    rec.check("GET packs: after", &c.get(&url).await);
    rec.finish();
}

/// Poll a scan until its job is no longer running.
async fn settled(c: &Client, scan: &str) -> Value {
    let end = tokio::time::Instant::now() + Duration::from_secs(120);
    loop {
        let r = c.get(&format!("/ai/scans/{scan}")).await.json();
        if r["job"]["state"] != "running" {
            return r;
        }
        assert!(tokio::time::Instant::now() < end, "the job never ended");
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
}

#[tokio::test]
async fn scan_routes() {
    let name = "scan_routes";
    let Some(f) = start(name, true, &[]).await else { return };
    let c = &f.c;
    std::fs::write(f.claude.join(".fake-login"), "an@work.example").expect("login file");
    let mut rec = Rec::new("ai_tools_routes", name, &[&tmp(&f), f.server.dir()]);
    // what a job writes about how long it took
    rec.ignore(&["elapsed_s", "duration_s", "took_s", "seconds", "started_at", "ended_at", "log"]);
    let (pid, _an) = project(c).await;
    let repo = tmp(&f).join("repo");
    std::fs::create_dir_all(repo.join("tests")).expect("repo");
    std::fs::write(repo.join("calc.py"), "def add(a, b):\n    return a + b\n").expect("calc.py");
    std::fs::write(
        repo.join("tests").join("test_calc.py"),
        "from calc import add\n\n\ndef test_add():\n    assert add(1, 2) == 3\n",
    )
    .expect("test");
    std::fs::write(
        repo.join("pyproject.toml"),
        "[project]\nname = \"calc\"\nversion = \"0.1\"\n\n[tool.pytest.ini_options]\ntestpaths = [\"tests\"]\n",
    )
    .expect("pyproject");
    git(&repo, &["init", "-q", "-b", "main"]);
    git(&repo, &["config", "user.email", "an@work.example"]);
    git(&repo, &["config", "user.name", "An Nguyen"]);
    git(&repo, &["add", "."]);
    git(&repo, &["commit", "-q", "-m", "first"]);
    let url = format!("/projects/{pid}/ai/scan");
    let folder = repo.to_string_lossy().into_owned();
    rec.check("POST scan: no such project", &c.post("/projects/nope/ai/scan", json!({"folder": folder})).await);
    rec.check("POST scan: no folder", &c.post(&url, json!({})).await);
    rec.check(
        "POST scan: no such folder",
        &c.post(&url, json!({"folder": tmp(&f).join("nowhere").to_string_lossy()})).await,
    );
    rec.check("GET latest: none", &c.get(&format!("/projects/{pid}/ai/scans/latest")).await);
    rec.check("GET latest: no such project", &c.get("/projects/nope/ai/scans/latest").await);
    let scan = c.post(&url, json!({"folder": folder, "trial": false, "refine": false, "test": "pytest -q"})).await;
    rec.check("POST scan", &scan);
    scan.assert_status(201);
    let sid = id(&scan.json());
    let one = format!("/ai/scans/{sid}");
    rec.check("GET scan", &c.get(&one).await);
    rec.check("GET scan: not found", &c.get("/ai/scans/nope").await);
    rec.check("GET latest", &c.get(&format!("/projects/{pid}/ai/scans/latest")).await);
    // the board tries the commands
    rec.check("POST try: not found", &c.post("/ai/scans/nope/try", json!({"commands": {}})).await);
    rec.check("POST try: no commands", &c.post(&format!("{one}/try"), json!({})).await);
    rec.check(
        "POST try: a command that is a number",
        &c.post(&format!("{one}/try"), json!({"commands": {"test": 1}})).await,
    );
    rec.check("POST try: only is text", &c.post(&format!("{one}/try"), json!({"commands": {}, "only": "test"})).await);
    let tried =
        c.post(&format!("{one}/try"), json!({"commands": {"prepare": "", "test": "true"}, "only": ["test"]})).await;
    tried.assert_status(200);
    let done = settled(c, &sid).await;
    rec.note("the trial ended as", json!({"state": done["job"]["state"], "trial": done["trial"]}));
    rec.check("GET scan: after the trial", &c.get(&one).await);
    rec.check("POST cancel: not found", &c.post_empty("/ai/scans/nope/cancel").await);
    rec.check("POST cancel: nothing runs", &c.post_empty(&format!("{one}/cancel")).await);
    rec.check("POST ai: not found", &c.post("/ai/scans/nope/ai", json!({})).await);
    rec.check("POST ai: hint is a number", &c.post(&format!("{one}/ai"), json!({"hint": 3})).await);
    rec.check("POST ai: keep is text", &c.post(&format!("{one}/ai"), json!({"keep": "test"})).await);
    // the AI sets the commands up: the stand-in CLI answers with no proposal, and the job says so
    let ai = c
        .post(
            &format!("{one}/ai"),
            json!({"hint": "A small library", "commands": {"test": "pytest -q"}, "keep": ["test"]}),
        )
        .await;
    ai.assert_status(200);
    rec.note("the AI job starts as", json!({"state": ai.json()["job"]["state"], "mode": ai.json()["job"]["mode"]}));
    let after_ai = settled(c, &sid).await;
    rec.note("the AI job ended as", json!({"state": after_ai["job"]["state"], "error": after_ai["job"]["error"]}));
    rec.check("POST ai: while a job ran or after", &c.post(&format!("/ai/scans/{sid}/cancel"), json!({})).await);
    // apply: the team and the settings
    rec.check("POST apply: not found", &c.post("/ai/scans/nope/apply", json!({})).await);
    rec.check("POST apply: no body", &c.post_empty(&format!("{one}/apply")).await);
    rec.check("POST apply: a list", &c.post(&format!("{one}/apply"), json!([1])).await);
    rec.check(
        "POST apply",
        &c.post(
            &format!("{one}/apply"),
            json!({"team": [{"name": "Scan Team"}], "commands": {"test": "pytest -q"}, "worktrees": true, "base_port": 5200,
                   "env_path": [" /opt/bin ", ""], "checks_off": ["lint", "nope"], "handover": "local"}),
        )
        .await,
    );
    rec.check("GET latest: it was applied", &c.get(&format!("/projects/{pid}/ai/scans/latest")).await);
    rec.check("GET settings: after the scan", &c.get(&format!("/projects/{pid}/ai/settings")).await);
    rec.check("GET teams: the one the scan made", &c.get(&format!("/projects/{pid}/ai/teams")).await);
    rec.check("POST apply: again", &c.post(&format!("{one}/apply"), json!({"team": [{"name": "Scan Team"}]})).await);
    rec.finish();
}
