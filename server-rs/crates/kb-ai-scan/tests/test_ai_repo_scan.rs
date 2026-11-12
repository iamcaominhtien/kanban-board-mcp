//! The repository scan at service level: `server/tests/test_ai_repo_scan.py` and the scan part of
//! `server/tests/test_ai_tools.py` (both deleted from the tree with the AI v2 reset, taken from git history at
//! `6d94706^` and adapted to the module as it is now: `apply` makes one team with `teams.create`, the suggestion has no
//! `workflow_default`). The tests that went through routes (`POST /ai/scans/{id}/ai`, `/try`, `/cancel`, `/apply`,
//! `GET /ai/scans/{id}`, `POST /projects/{id}/ai/scan`) call the service function the route calls; what the route adds
//! (status codes, bodies) waits for the routes task.
//!
//! Not here: `test_the_programs_a_command_needs_and_where_they_are` (it tests `project_env`, ported with it) and
//! `test_a_repository_with_no_manifest_is_named_after_the_repository` (it tests `plugins.source_name`).
//! Replaced: the plugin installs are not faked (no seam in `kb-ai-know`), so the tests of `apply` give the project the
//! plugins it would install ("once per project") and check what `apply` reports; `python3 -c` is `echo`.

mod common;

use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use common::{
    FakeAsker, account, claude_calls, claude_reset, claude_set, init, node_repo, sample_repo, scan_row, tmp, tool,
    until_done,
};
use kb_ai_scan::job::StartOptions;
use kb_ai_scan::run::ScanOptions;
use kb_ai_scan::trial::TryOptions;
use kb_ai_scan::{Error, apply, cancel_job, classify, why_wrong};
use kb_db::database;
use kb_db::entities::{ai_account, ai_plugin, ai_repo_scan, member};
use kb_db::sea_orm::ActiveValue::Set;
use kb_db::sea_orm::{ActiveModelTrait, ColumnTrait, EntityTrait, PaginatorTrait, QueryFilter};
use serde_json::{Map, Value, json};

fn commands(items: &[(&str, &str)]) -> Map<String, Value> {
    items.iter().map(|(k, v)| ((*k).to_string(), json!(v))).collect()
}

fn found_of(row: &ai_repo_scan::Model) -> Value {
    serde_json::from_str(&row.found).expect("found is JSON")
}

/// Whether a process is gone (not there, or a zombie nobody reaped yet). A signal that was sent is delivered when the
/// process is next scheduled, so it is given up to two seconds.
fn process_gone(pid: u32) -> bool {
    for _ in 0..40 {
        let gone = match std::fs::read_to_string(format!("/proc/{pid}/stat")) {
            Err(_) => true,
            Ok(stat) => stat.rsplit(')').next().is_some_and(|rest| rest.trim_start().starts_with('Z')),
        };
        if gone {
            return true;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    false
}

async fn have_every_plugin(project_id: &str) {
    let session = database::session();
    for entry in kb_ai_know::plugins::CATALOGUE.iter() {
        if entry.get("kind").and_then(Value::as_str) == Some("mcp") {
            continue;
        }
        let mut row = ai_plugin::new();
        row.project_id = Set(Some(project_id.to_string()));
        row.name = Set(entry["name"].as_str().expect("name").to_string());
        row.source = Set("x".into());
        row.insert(&session).await.expect("plugin");
    }
    session.commit().await.expect("commit");
}

// --------------------------------------------------------------------------- apply

#[tokio::test]
async fn test_apply_skips_what_the_project_already_has() {
    let _guard = init().await;
    let (_, _, row) = scan_row(&tmp("apply1"), true).await;
    have_every_plugin(&row.project_id).await;
    let session = database::session();
    let choice = json!({"team": [{"pack": "designer", "name": "D"}, {"pack": "user_tester", "name": "U"}], "plugins": ["design", "playwright"]});
    let out = apply(&session, &row.id, &choice, "t").await.expect("apply");
    // what the project has is not installed again, and the browser tool of the UI roles is reported
    assert_eq!(out["plugins"], json!([]));
    assert_eq!(out["plugin_failures"], json!([]));
    assert!(out["mcp"].as_array().expect("mcp").iter().any(|n| n == "Playwright MCP"), "{}", out["mcp"]);
    assert!(!out["mcp"].as_array().expect("mcp").iter().any(|n| n == "Figma MCP"), "Figma signs in through a browser");
    assert_eq!(out["created"][0]["pack"], "feature_ui");
}

#[tokio::test]
async fn test_apply_reports_a_failing_install_and_skips_ui_plugins_without_ui() {
    let _guard = init().await;
    let (_, _, row) = scan_row(&tmp("apply2"), false).await;
    have_every_plugin(&row.project_id).await;
    let session = database::session();
    let choice = json!({"team": [{"pack": "designer", "name": "D"}], "plugins": ["playwright"]});
    let out = apply(&session, &row.id, &choice, "t").await.expect("apply");
    // Playwright is a browser tool, and there is no UI (and Figma is not in the Designer pack)
    assert_eq!(out["mcp"], json!([]));
    assert_eq!(out["plugin_failures"], json!([]));
    assert_eq!(out["created"][0]["pack"], "feature_ui", "the roles decide the pack, not the repository");
}

#[tokio::test]
async fn test_apply_saves_the_environment_and_the_checks_that_are_off() {
    let _guard = init().await;
    let (_, _, row) = scan_row(&tmp("apply3"), true).await;
    let session = database::session();
    let choice = json!({
        "team": [],
        "commands": {"test": "npm test", "lint": "npm run lint"},
        "env_path": ["/opt/homebrew/bin", " "],
        "checks_off": ["test", "nope"],
    });
    let out = apply(&session, &row.id, &choice, "t").await.expect("apply");
    assert_eq!(out["settings"]["env_path"], json!(["/opt/homebrew/bin"]));
    assert_eq!(out["settings"]["checks_off"], json!(["test"]));
    assert_eq!(out["settings"]["commands"]["lint"], "npm run lint");
    assert_eq!(out["created"][0]["name"], "AI team", "no team asked: the default name");
}

#[tokio::test]
async fn test_the_scan_creates_nothing_until_apply() {
    let _guard = init().await;
    let root = tmp("nothing");
    let (project_id, _) = common::project().await;
    sample_repo(&root.join("repo2"));
    let session = database::session();
    let row = kb_ai_scan::run_scan(
        &session,
        &project_id,
        &root.join("repo2").to_string_lossy(),
        ScanOptions { trial: false, ..Default::default() },
    )
    .await
    .expect("scan");
    let suggested: Value = serde_json::from_str(&row.suggested).expect("suggested");
    assert!(suggested["team"].as_array().is_some_and(|t| !t.is_empty()));
    let count = |project: String| async move {
        member::Entity::find()
            .filter(member::Column::ProjectId.eq(project))
            .count(&database::session())
            .await
            .expect("count")
    };
    let before = count(project_id.clone()).await;
    have_every_plugin(&project_id).await;
    let mut choice = suggested.clone();
    choice["team"] = json!([{"pack": "dev", "name": "Dev An"}, {"pack": "reviewer", "name": "Reviewer Rin"}]);
    choice["plugins"] = json!([]);
    let out = apply(&session, &row.id, &choice, "t").await.expect("apply");
    assert_eq!(out["created"].as_array().expect("created").len(), 1);
    assert_eq!(out["created"][0]["name"], "Dev An");
    assert_eq!(out["created"][0]["pack"], "standard");
    assert_eq!(out["settings"]["worktrees"]["prepare"], suggested["prepare"]);
    assert_eq!(out["settings"]["worktrees"]["repo"], row.folder);
    assert_eq!(count(project_id).await, before + 1);
    let stored =
        ai_repo_scan::Entity::find_by_id(row.id.as_str()).one(&database::session()).await.expect("read").expect("row");
    assert!(stored.applied_at.is_some());
}

#[tokio::test]
async fn test_apply_says_a_team_that_cannot_be_made_was_skipped() {
    let _guard = init().await;
    let (_, _, row) = scan_row(&tmp("apply4"), true).await;
    have_every_plugin(&row.project_id).await;
    let session = database::session();
    let choice = json!({"team": [{"pack": "dev", "name": "Same Name"}]});
    let first = apply(&session, &row.id, &choice, "t").await.expect("apply");
    assert_eq!(first["created"].as_array().expect("created").len(), 1);
    let again = apply(&session, &row.id, &choice, "t").await.expect("apply");
    assert_eq!(again["created"], json!([]));
    assert_eq!(again["skipped"][0]["name"], "Same Name");
    assert!(!again["skipped"][0]["why"].as_str().expect("why").is_empty());
    assert!(matches!(apply(&session, "scn_nope", &choice, "t").await, Err(Error::Lookup(m)) if m == "Scan not found."));
}

// --------------------------------------------------------------------------- the fingerprint rescan

#[tokio::test]
async fn test_a_changed_manifest_scans_again_and_an_unchanged_one_does_not() {
    let _guard = init().await;
    common::clear::<ai_repo_scan::Entity>().await;
    let (pid, repo, row) = scan_row(&tmp("rescan"), true).await;
    assert!(found_of(&row)["fingerprint"].as_str().is_some_and(|f| !f.is_empty()));
    let session = database::session();
    assert!(!kb_ai_scan::rescan_if_changed(&session, &pid).await.expect("rescan"));
    std::fs::write(repo.join("package.json"), json!({"name": "app", "scripts": {}}).to_string()).expect("write");
    assert!(kb_ai_scan::rescan_if_changed(&session, &pid).await.expect("rescan"));
    assert!(!kb_ai_scan::rescan_if_changed(&session, &pid).await.expect("rescan"));
    let rows = ai_repo_scan::Entity::find().all(&database::session()).await.expect("rows");
    assert!(rows.len() == 2 && rows.iter().all(|r| r.applied_at.is_none()));
}

#[tokio::test]
async fn test_sweep_rescans_only_changed_projects() {
    let _guard = init().await;
    common::clear::<ai_repo_scan::Entity>().await;
    let (pid, repo, _) = scan_row(&tmp("sweep"), true).await;
    assert_eq!(kb_ai_scan::sweep(database::session).await.expect("sweep"), Vec::<String>::new());
    common::write_files(&repo, &[(".github/workflows/ci.yml", "run: pytest\n")]);
    assert_eq!(kb_ai_scan::sweep(database::session).await.expect("sweep"), vec![pid]);
}

#[tokio::test]
async fn a_sweep_skips_a_project_whose_folder_is_gone_and_goes_on() {
    let _guard = init().await;
    common::clear::<ai_repo_scan::Entity>().await;
    let (_, gone, _) = scan_row(&tmp("gone"), true).await;
    let (pid, repo, _) = scan_row(&tmp("kept"), true).await;
    std::fs::remove_dir_all(&gone).expect("remove");
    std::fs::write(repo.join("package.json"), "{}").expect("write");
    assert_eq!(kb_ai_scan::sweep(database::session).await.expect("sweep"), vec![pid]);
}

// --------------------------------------------------------------------------- the light model

#[tokio::test]
async fn test_the_light_model_refines_the_suggestion() {
    let _guard = init().await;
    common::clear::<ai_account::Entity>().await;
    let (_, _, row) = scan_row(&tmp("refine"), true).await;
    account().await;
    let asker = FakeAsker::new();
    *asker.light.lock().expect("lock") =
        Ok(Some(r#"{"roles": ["dev", "qa", "bogus"], "plugins": ["design", "nope"], "why": "small repo"}"#.into()));
    asker.install();
    let found = found_of(&row);
    let base: Value = serde_json::from_str(&row.suggested).expect("suggested");
    let session = database::session();
    let out = kb_ai_scan::refine_suggestion(&session, &row.project_id, &found, &base, None).await;
    let packs: Vec<&str> =
        out["team"].as_array().expect("team").iter().map(|t| t["pack"].as_str().expect("pack")).collect();
    assert_eq!(packs, ["dev", "qa"]);
    assert_eq!(out["plugins"], json!(["design"]));
    assert_eq!(out["why"]["refined"], "small repo");
    assert_eq!(out["why"]["commands"], base["why"]["commands"], "the code's reasons stay");
    kb_ai_scan::seams::set_asker(None);
}

#[tokio::test]
async fn test_the_light_model_fails_soft() {
    let _guard = init().await;
    common::clear::<ai_account::Entity>().await;
    let (_, _, row) = scan_row(&tmp("soft"), true).await;
    let found = found_of(&row);
    let base: Value = serde_json::from_str(&row.suggested).expect("suggested");
    let asker = FakeAsker::new();
    *asker.light.lock().expect("lock") = Err("down".into());
    let asker: Arc<FakeAsker> = asker.install();
    let session = database::session();
    // no Claude Code account: never asked
    assert_eq!(kb_ai_scan::refine_suggestion(&session, &row.project_id, &found, &base, None).await, base);
    assert_eq!(asker.light_calls.load(std::sync::atomic::Ordering::SeqCst), 0);
    account().await;
    // an error
    assert_eq!(kb_ai_scan::refine_suggestion(&session, &row.project_id, &found, &base, None).await, base);
    assert_eq!(asker.light_calls.load(std::sync::atomic::Ordering::SeqCst), 1);
    // an answer that is no JSON
    *asker.light.lock().expect("lock") = Ok(Some("no json here".into()));
    assert_eq!(kb_ai_scan::refine_suggestion(&session, &row.project_id, &found, &base, None).await, base);
    // an answer whose lists are not lists
    *asker.light.lock().expect("lock") = Ok(Some(r#"{"roles": 5}"#.into()));
    assert_eq!(kb_ai_scan::refine_suggestion(&session, &row.project_id, &found, &base, None).await, base);
    kb_ai_scan::seams::set_asker(None);
}

#[tokio::test]
async fn the_light_model_is_asked_through_the_cli_when_nothing_replaces_it() {
    let _guard = init().await;
    claude_reset();
    common::clear::<ai_account::Entity>().await;
    let (_, _, row) = scan_row(&tmp("light"), true).await;
    account().await;
    claude_set("light.json", &json!({"result": r#"{"roles": ["dev", "devops"], "why": "has CI"}"#}).to_string());
    let found = found_of(&row);
    let base: Value = serde_json::from_str(&row.suggested).expect("suggested");
    let out = kb_ai_scan::refine_suggestion(&database::session(), &row.project_id, &found, &base, None).await;
    let packs: Vec<&str> =
        out["team"].as_array().expect("team").iter().map(|t| t["pack"].as_str().expect("pack")).collect();
    assert_eq!(packs, ["dev", "devops"]);
    let calls = claude_calls();
    assert!(calls.iter().any(|c| c.contains("--model haiku") && c.contains("Facts: ")), "{calls:?}");
}

// --------------------------------------------------------------------------- the AI sets up the commands

#[test]
fn test_the_server_tells_a_wrong_command_from_a_failing_project() {
    assert_eq!(classify(Some(0), "", false), "works");
    assert_eq!(classify(Some(127), "sh: npm: command not found", false), "wrong");
    assert_eq!(classify(Some(1), "npm error Missing script: \"lint:ci\"", false), "wrong");
    assert_eq!(classify(Some(1), "FAIL src/a.test.ts\nTests  2 failed", false), "fails");
    assert_eq!(classify(None, "", true), "timeout");
}

#[test]
fn test_a_package_manager_with_no_package_json_is_a_wrong_command() {
    let npm = "npm error code ENOENT\nnpm error syscall open\nnpm error path /r/package.json\nnpm error errno -2\n\
               npm error enoent Could not read package.json: Error: ENOENT: no such file or directory, open '/r/package.json'";
    assert_eq!(classify(Some(254), npm, false), "wrong");
    assert_eq!(classify(Some(1), "error Couldn't find a package.json file in \"/r\"", false), "wrong");
    assert_eq!(classify(Some(1), " ERR_PNPM_NO_IMPORTER_MANIFEST_FOUND  No package.json was found", false), "wrong");
    assert!(why_wrong(npm, Some(254)).contains("package.json"));
    // a test that fails because its own fixture is missing ran: the project fails, the command is right
    assert_eq!(
        classify(Some(1), "FAIL a.test.ts\nError: ENOENT: no such file or directory, open 'fixtures/x.json'", false),
        "fails"
    );
    // nor does one whose fixture is a package.json: only npm, yarn and pnpm's own lines make the command wrong
    let fixture = "FAIL src/scan.test.ts\n  ● reads the manifest\n\
                   \x20   Error: ENOENT: no such file or directory, open '/r/test/fixtures/package.json'\n\
                   \x20   Could not read package.json fixture\n\
                   Tests:  1 failed, 4 passed\n\
                   npm error Lifecycle script `test` failed with error:\nnpm error code 1";
    assert_eq!(classify(Some(1), fixture, false), "fails");
    assert_eq!(classify(Some(1), &fixture.replace("npm error", "npm ERR!"), false), "fails");
    assert_eq!(classify(Some(254), "npm ERR! path /r/package.json\nnpm ERR! code ENOENT", false), "wrong");
}

#[test]
fn test_a_missing_input_of_the_program_itself_is_a_wrong_command() {
    // RC-2: the script, the Makefile target or the test path the command names is not there
    for out in [
        "npm ERR! enoent ENOENT: no such file or directory, open '/r/package.json'",
        "python: can't open file '/r/manage.py': [Errno 2] No such file or directory",
        "bash: ./scripts/ci.sh: No such file or directory",
        "make: *** No rule to make target 'lint'.  Stop.",
        "make: *** No targets specified and no makefile found.  Stop.",
        "ERROR: file or directory not found: tests/",
    ] {
        assert_eq!(classify(Some(2), out, false), "wrong", "{out}");
        assert_eq!(why_wrong(out, Some(2)), out);
    }
    // the project's own build missing a file it needs ran: the command is right
    assert_eq!(classify(Some(2), "make: *** No rule to make target 'a.o', needed by 'app'.  Stop.", false), "fails");
    assert_eq!(classify(Some(1), "sh: line 3: tool: No such file or directory\n1 failed", false), "fails");
}

#[tokio::test]
async fn test_every_command_gets_its_own_result() {
    let _guard = init().await;
    let repo = node_repo(&tmp("each").join("r"), true);
    let out = kb_ai_scan::try_commands(
        &repo.to_string_lossy(),
        &commands(&[
            ("prepare", "true"),
            ("test", "echo 'FAIL a'; exit 1"),
            ("lint", "no-such-tool-xyz --check"),
            ("build", "echo built"),
        ]),
        TryOptions::default(),
    )
    .await
    .expect("try");
    assert_eq!(out["prepare"]["status"], "works");
    assert_eq!(out["test"]["status"], "fails", "one failing does not hide the next");
    assert_eq!(out["lint"]["status"], "wrong");
    assert_eq!(out["lint"]["exit_code"], 127);
    assert!(out["lint"]["reason"].as_str().expect("reason").contains("not found"));
    assert_eq!(out["build"]["status"], "works");
    assert_eq!(out["build"]["tail"], json!(["built"]));
    assert_eq!(out["test"]["tail"], json!(["FAIL a"]));
    let keys: Vec<&String> = out.as_object().expect("object").keys().collect();
    assert_eq!(keys, ["prepare", "test", "lint", "build"]);
}

#[tokio::test]
async fn test_the_project_path_goes_in_front_of_the_apps() {
    let _guard = init().await;
    let root = tmp("path");
    let repo = node_repo(&root.join("r"), true);
    let tools = tool(&root.join("tools"), "mytool-xyz", "echo from-tool");
    let cmd = commands(&[("test", "mytool-xyz")]);
    let without = kb_ai_scan::try_commands(&repo.to_string_lossy(), &cmd, TryOptions::default()).await.expect("try");
    assert_eq!(without["test"]["status"], "wrong");
    let extra = [tools.to_string_lossy().into_owned()];
    let with = kb_ai_scan::try_commands(
        &repo.to_string_lossy(),
        &cmd,
        TryOptions { extra_path: Some(&extra), ..TryOptions::default() },
    )
    .await
    .expect("try");
    assert_eq!(with["test"]["status"], "works");
    assert_eq!(with["test"]["tail"], json!(["from-tool"]));
}

#[tokio::test]
async fn test_a_manifest_under_a_hidden_folder_is_tooling() {
    let _guard = init().await;
    let repo = node_repo(&tmp("hidden").join("r"), true);
    common::write_files(
        &repo,
        &[
            (".github/skills/x/scripts/pyproject.toml", "[project]\nname='x'\n"),
            (".github/skills/x/scripts/uv.lock", ""),
        ],
    );
    let found = kb_ai_scan::scan(&repo.to_string_lossy()).await.expect("scan");
    let paths: Vec<&str> =
        found["packages"].as_array().expect("packages").iter().map(|p| p["path"].as_str().expect("path")).collect();
    assert_eq!(paths, ["."]);
    assert!(!kb_ai_scan::suggest(&found).expect("suggest")["prepare"].as_str().expect("prepare").contains(".github"));
}

#[tokio::test]
async fn test_the_scan_reads_the_repository_by_code_and_suggests_a_team() {
    let _guard = init().await;
    let root = tmp("bycode");
    sample_repo(&root);
    let found = kb_ai_scan::scan(&root.to_string_lossy()).await.expect("scan");
    let languages: Vec<&str> =
        found["languages"].as_array().expect("languages").iter().filter_map(Value::as_str).collect();
    assert!(languages.len() == 2 && languages.contains(&"node") && languages.contains(&"python"));
    let frameworks: Vec<&str> =
        found["frameworks"].as_array().expect("frameworks").iter().filter_map(Value::as_str).collect();
    for fw in ["react", "vite", "vitest", "fastapi"] {
        assert!(frameworks.contains(&fw), "{fw} in {frameworks:?}");
    }
    assert_eq!(found["ui"], true);
    assert_eq!(found["monorepo"], true);
    assert_eq!(found["ci_commands"], json!(["cd server && uv run pytest -q"]));
    assert!(found["agent_files"].as_array().expect("agent files").iter().any(|f| f == "CLAUDE.md"));
    let s = kb_ai_scan::suggest(&found).expect("suggest");
    let test = s["commands"]["test"].as_str().expect("test");
    assert!(test.contains("npm --prefix ui test -- --run"), "{test}");
    assert!(test.contains("uv --directory server run pytest -q"), "{test}");
    let prepare = s["prepare"].as_str().expect("prepare");
    assert!(
        prepare == "npm --prefix ui ci && uv --directory server sync"
            || prepare == "uv --directory server sync && npm --prefix ui ci"
    );
    let every = format!("{prepare}{test}{}", s["commands"]["lint"].as_str().expect("lint"));
    assert!(!every.contains("cd "), "{every}");
    let team: Vec<&str> =
        s["team"].as_array().expect("team").iter().map(|m| m["pack"].as_str().expect("pack")).collect();
    assert_eq!(team, ["triage", "pm", "ba", "designer", "dev", "qa", "reviewer", "user_tester"]);
    assert_eq!(s["handover"], "local");
    let plugins: Vec<&str> = s["plugins"].as_array().expect("plugins").iter().filter_map(Value::as_str).collect();
    assert!(plugins.contains(&"playwright") && plugins.contains(&"design"), "{plugins:?}");
}

#[tokio::test]
async fn test_a_folder_git_does_not_track_is_not_suggested() {
    // A vendored checkout that git ignores is on the disk but not in a worktree: `cd vendor/x && npm ci` failed there
    // with "The system cannot find the path specified" (Windows).
    let _guard = init().await;
    let root = tmp("ignored");
    sample_repo(&root);
    common::write_files(
        &root,
        &[("vendor/tool/package.json", r#"{"name": "tool", "scripts": {"test": "x"}}"#), (".gitignore", "vendor/\n")],
    );
    common::git(&root, &["init", "-q"]);
    common::git(&root, &["add", "-A"]);
    common::git(&root, &["commit", "-qm", "x"]);
    let found = kb_ai_scan::scan(&root.to_string_lossy()).await.expect("scan");
    let mut paths: Vec<&str> =
        found["packages"].as_array().expect("packages").iter().map(|p| p["path"].as_str().expect("path")).collect();
    paths.sort_unstable();
    assert_eq!(paths, ["server", "ui"]);
    assert!(!kb_ai_scan::suggest(&found).expect("suggest")["prepare"].as_str().expect("prepare").contains("vendor"));
}

#[test]
fn test_a_package_folder_does_not_move_the_commands_after_it() {
    let found = json!({
        "packages": [
            {"path": "vendor/my tool", "kind": "node", "scripts": {}},
            {"path": ".", "kind": "python", "manager": "uv", "pytest": true},
            {"path": "lib", "kind": "python", "manager": "pip", "pytest": true, "ruff": true},
        ],
        "languages": ["node", "python"],
        "ui": false,
    });
    let s = kb_ai_scan::suggest(&found).expect("suggest");
    assert_eq!(s["prepare"], "npm --prefix \"vendor/my tool\" ci && uv sync");
    assert_eq!(s["commands"]["test"], "uv run pytest -q && pytest -q lib");
    assert_eq!(s["commands"]["lint"], "ruff check lib");
}

#[tokio::test]
async fn test_the_trial_runs_the_commands_in_a_scratch_worktree_and_shows_failures() {
    let _guard = init().await;
    let repo = common::repo("trial");
    let folder = repo.to_string_lossy().into_owned();
    // `python3 -c 'print(42)'` is `echo 42`: a command of the test's own, no interpreter of the machine
    let ok = kb_ai_scan::try_(&folder, "true", "echo 42").await.expect("try");
    assert!(ok["prepare"]["ok"] == true && ok["test"]["ok"] == true);
    assert_eq!(ok["test"]["tail"], json!(["42"]));
    let bad = kb_ai_scan::try_(&folder, "exit 3", "echo never").await.expect("try");
    assert!(bad["prepare"]["ok"] == false && bad["prepare"]["exit_code"] == 3);
    assert_eq!(bad["prepare"]["status"], "fails");
    // nothing runs after a failing prepare, and the row says why
    assert_eq!(bad["test"]["status"], "not_run");
    assert_eq!(bad["test"]["reason"], "prepare failed first");
    let worktrees = common::git(&repo, &["worktree", "list"]);
    assert_eq!(worktrees.trim().lines().count(), 1, "the scratch worktree was removed: {worktrees}");
}

#[tokio::test]
async fn the_trial_of_a_folder_that_is_not_a_repository_runs_in_a_copy() {
    let _guard = init().await;
    let root = tmp("copy");
    let repo = node_repo(&root.join("r"), true);
    common::write_files(&repo, &[("node_modules/x/y.txt", "x"), (".venv/z", "x"), ("src/a.txt", "x")]);
    let out = kb_ai_scan::try_(&repo.to_string_lossy(), "", "ls src; ls -d node_modules .venv .git 2>&1; pwd").await;
    // `ls` and `pwd` are not on the test's PATH: the shell's own builtins show what the copy holds
    let out = out.expect("try");
    assert!(out["test"]["status"].is_string());
    let out = kb_ai_scan::try_(
        &repo.to_string_lossy(),
        "",
        "[ -f package.json ] && [ ! -e node_modules ] && [ ! -e .venv ] && echo copied",
    )
    .await
    .expect("try");
    assert_eq!(out["test"]["tail"], json!(["copied"]), "{out}");
}

#[tokio::test]
async fn a_command_that_runs_too_long_is_stopped_with_everything_it_started() {
    let _guard = init().await;
    let root = tmp("timeout");
    let repo = node_repo(&root.join("r"), true);
    let pid_file = root.join("pid");
    let env = kb_ai_work::project_env::with_path(None, None);
    let started = std::time::Instant::now();
    let cmd = format!("sleep 60 & echo $! > {}; wait", pid_file.display());
    let result = kb_ai_scan::trial::run_one(&cmd, &repo, &env, None, 1.0, None).await.expect("run");
    assert!(started.elapsed() < Duration::from_secs(20));
    assert_eq!(result["status"], "timeout");
    assert_eq!(result["exit_code"], Value::Null);
    assert_eq!(result["ok"], false);
    assert_eq!(result["tail"], json!(["Timed out."]));
    assert_eq!(result["reason"], "Timed out after 0 minutes.");
    let pid: u32 = std::fs::read_to_string(&pid_file).expect("pid file").trim().parse().expect("a pid");
    assert!(process_gone(pid), "the sleep the shell started is gone");
}

#[tokio::test]
async fn the_output_of_a_command_is_capped_and_its_tail_kept() {
    let _guard = init().await;
    let repo = node_repo(&tmp("cap").join("r"), true);
    let env = kb_ai_work::project_env::with_path(None, None);
    let cmd = "i=0; while [ $i -lt 2500 ]; do echo l$i; i=$((i+1)); done; echo '' ; echo err >&2; echo last";
    let result = kb_ai_scan::trial::run_one(cmd, &repo, &env, None, 60.0, None).await.expect("run");
    assert_eq!(result["status"], "works");
    let tail: Vec<&str> = result["tail"].as_array().expect("tail").iter().filter_map(Value::as_str).collect();
    assert_eq!(tail.len(), 12);
    assert_eq!(tail[11], "last");
    assert_eq!(tail[10], "err", "standard error is in the same stream");
    assert_eq!(tail[9], "l2499");
}

#[tokio::test]
async fn a_line_longer_than_the_stream_reader_takes_fails_the_command_and_leaves_no_child() {
    let _guard = init().await;
    let root = tmp("long");
    let repo = node_repo(&root.join("r"), true);
    let env = kb_ai_work::project_env::with_path(None, None);
    let pid_file = root.join("pid");
    let cmd = format!(
        "sleep 60 & echo $! > {}; s=0123456789abcdef; i=0; while [ $i -lt 13 ]; do s=$s$s; i=$((i+1)); done; echo $s; wait",
        pid_file.display()
    );
    let err = kb_ai_scan::trial::run_one(&cmd, &repo, &env, None, 60.0, None).await.expect_err("a ValueError");
    assert!(matches!(err, Error::Other(_)), "{err:?}");
    let pid: u32 = std::fs::read_to_string(&pid_file).expect("pid file").trim().parse().expect("a pid");
    assert!(process_gone(pid));
}

async fn start_ai_job(
    row: &ai_repo_scan::Model,
    mode: &str,
    items: &[(&str, &str)],
    only: Option<Vec<String>>,
) -> ai_repo_scan::Model {
    let session = database::session();
    kb_ai_scan::start_job(
        &session,
        &row.id,
        StartOptions {
            mode: mode.into(),
            hint: "the app is at the root".into(),
            commands: Some(commands(items)),
            only,
            ..Default::default()
        },
    )
    .await
    .expect("start")
}

#[tokio::test]
async fn test_the_ai_proposes_and_the_board_proves_each_command() {
    let _guard = init().await;
    let (_, _, row) = scan_row(&tmp("aijob"), true).await;
    // the program is in a folder the app's own PATH does not have, but one of the usual install folders
    let home = std::env::var("HOME").expect("HOME");
    let tools = tool(&Path::new(&home).join(".local").join("bin"), "mytool-xyz", "echo from-tool");
    // The fake AI waits until the test has seen the job running and the second ask refused: a job that finished first
    // made the check depend on timing
    let release = Arc::new(tokio::sync::Notify::new());
    let mut asker = FakeAsker::new();
    asker.ai_release = Some(release.clone());
    *asker.ai_answer.lock().expect("lock") = Some(
        json!({
            "commands": {
                "prepare": {"command": "true", "source": "package.json"},
                "test": {"command": "mytool-xyz", "source": "package.json › scripts.test", "note": ""},
                "lint": {"command": "echo 'lint failed'; exit 2", "source": "ci.yml"},
                "build": {"command": "", "source": ""},
            },
            "notes": "One app at the root.",
        })
        .to_string(),
    );
    let asker = asker.install();
    let started = start_ai_job(&row, "ai", &[], None).await;
    assert_eq!(kb_ai_scan::to_dict(&started)["job"]["state"], "running");
    let session = database::session();
    let again =
        kb_ai_scan::start_job(&session, &row.id, StartOptions { mode: "ai".into(), ..Default::default() }).await;
    assert!(
        matches!(again, Err(Error::JobRunning(m)) if m == "The commands are already being set up."),
        "one job at a time"
    );
    // the wizard reads a job that runs: its steps wait for the AI
    assert!(kb_ai_scan::running(&row.id));
    release.notify_one();
    let scan = until_done(&row.id).await;
    assert_eq!(scan["job"]["state"], "done", "{}", scan["job"]);
    let (prompt, cwd) = asker.seen.lock().expect("lock")[0].clone();
    assert!(prompt.contains("The person says: the app is at the root"));
    assert_ne!(cwd, row.folder, "the AI reads a temporary copy");
    assert_eq!(scan["proposal"]["commands"]["test"]["source"], "package.json › scripts.test");
    assert_eq!(
        scan["proposal"]["env_path"],
        json!([{"path": tools.to_string_lossy(), "by": "ai", "why": "mytool-xyz was found here"}])
    );
    let trial = &scan["trial"];
    assert_eq!(trial["prepare"]["status"], "works");
    // proven by the board itself, with the folder the AI's step found in front of the PATH
    assert_eq!(trial["test"]["status"], "works");
    assert_eq!(trial["test"]["tail"], json!(["from-tool"]));
    assert_eq!(trial["lint"]["status"], "fails");
    assert_eq!(trial["build"], Value::Null);
    let log: Vec<&str> = scan["job"]["log"].as_array().expect("log").iter().filter_map(Value::as_str).collect();
    assert!(log.iter().any(|l| l.contains("Read package.json")), "{log:?}");
    assert!(log.iter().any(|l| l.starts_with("board$ /bin/sh -c \"mytool-xyz\"")), "{log:?}");
    let keys: Vec<&str> =
        scan["job"]["steps"].as_array().expect("steps").iter().map(|s| s["key"].as_str().expect("key")).collect();
    assert_eq!(keys, ["ai", "path", "prepare", "test", "lint", "build"]);
    let steps = scan["job"]["steps"].as_array().expect("steps");
    assert_eq!(steps[0]["label"], "The AI proposed the commands");
    assert!(
        steps[0]["detail"]
            .as_str()
            .expect("detail")
            .starts_with("3 of 4 · from ci.yml, package.json · One app at the root.")
    );
    assert!(steps[1]["detail"].as_str().expect("detail").contains("mytool-xyz is not on the app’s PATH. Found in"));
    let latest = kb_ai_scan::latest(&database::session(), &row.project_id).await.expect("latest").expect("a scan");
    assert_eq!(latest.id, row.id);
    kb_ai_scan::seams::set_asker(None);
}

#[tokio::test]
async fn the_ai_answer_that_cannot_be_read_falls_back_to_the_boards_scan() {
    let _guard = init().await;
    let (_, _, row) = scan_row(&tmp("fallback"), true).await;
    let asker = FakeAsker::new();
    *asker.ai_answer.lock().expect("lock") = Some("sorry, no JSON".into());
    asker.install();
    let session = database::session();
    kb_ai_scan::start_job(
        &session,
        &row.id,
        StartOptions {
            mode: "ai".into(),
            keep: Some(vec!["prepare".into(), "lint".into(), "bogus".into()]),
            commands: Some(commands(&[("prepare", "true"), ("lint", "echo mine")])),
            // only the lint check runs: the board's own `npm test` would reach for a real npm
            only: Some(vec!["lint".into()]),
            ..Default::default()
        },
    )
    .await
    .expect("start");
    let scan = until_done(&row.id).await;
    assert_eq!(scan["job"]["state"], "done", "{}", scan["job"]);
    let log: Vec<&str> = scan["job"]["log"].as_array().expect("log").iter().filter_map(Value::as_str).collect();
    assert!(log.contains(&"The AI's answer could not be read; the board's own scan is used."), "{log:?}");
    assert_eq!(
        scan["proposal"]["commands"]["lint"],
        json!({"command": "echo mine", "source": "typed by you", "note": ""})
    );
    assert_eq!(scan["proposal"]["commands"]["test"]["source"], "the board's scan");
    assert_eq!(scan["trial"]["prepare"]["status"], "works", "{}", scan["trial"]);
    assert_eq!(scan["trial"]["lint"]["tail"], json!(["mine"]));
    assert_eq!(scan["trial"]["test"], Value::Null, "not asked to run");
    kb_ai_scan::seams::set_asker(None);
}

#[tokio::test]
async fn test_the_ai_is_refused_when_claude_code_is_not_there() {
    let _guard = init().await;
    let (_, _, row) = scan_row(&tmp("refused"), true).await;
    let mut asker = FakeAsker::new();
    asker.status = json!({"available": false, "why": "Claude Code is not signed in on this computer."});
    asker.install();
    let session = database::session();
    let refused =
        kb_ai_scan::start_job(&session, &row.id, StartOptions { mode: "ai".into(), ..Default::default() }).await;
    assert!(matches!(&refused, Err(Error::Value(m)) if m.contains("not signed in")), "{refused:?}");
    let scan = kb_ai_scan::to_api(&session, &row).await.expect("to_api");
    assert_eq!(scan["ai_available"], false);
    assert!(scan["ai_unavailable_why"].as_str().expect("why").starts_with("Claude Code is not signed in"));
    kb_ai_scan::seams::set_asker(None);
}

#[tokio::test]
async fn the_status_of_the_ai_comes_from_the_cli_and_is_kept_for_fifteen_seconds() {
    let _guard = init().await;
    claude_reset();
    common::clear::<ai_account::Entity>().await;
    let session = database::session();
    kb_ai_scan::job::forget_ai_status();
    let ok = kb_ai_scan::ai_status(&session, true).await.expect("status");
    assert_eq!(ok, json!({"available": true, "why": null}));
    claude_set("auth.json", r#"{"loggedIn": false}"#);
    let cached = kb_ai_scan::ai_status(&session, false).await.expect("status");
    assert_eq!(cached, ok, "cached for 15 s, since the wizard polls");
    let out = kb_ai_scan::ai_status(&session, true).await.expect("status");
    assert_eq!(
        out,
        json!({"available": false, "why": "Claude Code is not signed in on this computer. The AI needs it to read the repository."})
    );
    claude_reset();
    kb_ai_scan::job::forget_ai_status();
}

#[tokio::test]
async fn the_ai_reads_the_repository_through_the_cli_and_may_only_read() {
    let _guard = init().await;
    claude_reset();
    let root = tmp("ask");
    let lines = [
        json!({"type": "system", "subtype": "init"}),
        json!({"type": "assistant", "message": {"content": [
            {"type": "tool_use", "name": "Read", "input": {"file_path": format!("{}/package.json", root.display())}},
            {"type": "text", "text": "hm"},
            {"type": "tool_use", "name": "Glob", "input": {"pattern": "**/*.yml"}}]}}),
        json!("not an event"),
        json!({"type": "result", "is_error": false, "result": "{\"commands\": {}}"}),
    ];
    let stream = lines.iter().map(Value::to_string).collect::<Vec<_>>();
    claude_set("stream.jsonl", &format!("{}\nnot json at all\n", stream[..2].join("\n")));
    let seen = std::sync::Mutex::new(Vec::<String>::new());
    let on_line = |text: &str| seen.lock().expect("lock").push(text.to_string());
    let cancel = kb_ai_scan::cancel::Cancel::new();
    let answer = kb_ai_scan::job::ask_ai_real("PROMPT TEXT", &root.to_string_lossy(), None, &on_line, &cancel).await;
    // an answer with no result line: nothing, and the CLI exited 0
    assert!(matches!(answer, Ok(None)), "{answer:?}");
    assert_eq!(*seen.lock().expect("lock"), ["Read package.json", "Looked for **/*.yml"]);
    claude_set("stream.jsonl", &format!("{}\n", stream[3]));
    let answer = kb_ai_scan::job::ask_ai_real("PROMPT TEXT", &root.to_string_lossy(), None, &on_line, &cancel).await;
    assert_eq!(answer.expect("answer").as_deref(), Some("{\"commands\": {}}"));
    let calls = claude_calls();
    let call = calls.iter().find(|c| c.contains("PROMPT TEXT")).expect("a call");
    assert!(call.starts_with(&format!("{}|", root.display())), "run in the folder given: {call}");
    for part in [
        "--model sonnet",
        "--output-format stream-json",
        "--verbose",
        "--permission-mode dontAsk",
        "--allowedTools Read,Glob,Grep,LS",
        "--disallowedTools Bash,Edit,Write,MultiEdit,NotebookEdit,WebFetch,WebSearch,Task",
        "--strict-mcp-config",
        "--mcp-config {\"mcpServers\": {}}",
    ] {
        assert!(call.contains(part), "{part} in {call}");
    }
    claude_reset();
}

#[tokio::test]
async fn the_ai_run_that_fails_says_why() {
    let _guard = init().await;
    claude_reset();
    let root = tmp("askfail");
    let on_line = |_: &str| {};
    let cancel = kb_ai_scan::cancel::Cancel::new();
    claude_set("stream.jsonl", &json!({"type": "result", "is_error": true, "result": "x".repeat(400)}).to_string());
    let err = kb_ai_scan::job::ask_ai_real("p", &root.to_string_lossy(), None, &on_line, &cancel)
        .await
        .expect_err("an error");
    assert!(matches!(&err, kb_ai_scan::seams::AskError::Failed(m) if m == &"x".repeat(300)), "{err:?}");
    claude_set("stream.jsonl", &json!({"type": "result", "is_error": true}).to_string());
    let err = kb_ai_scan::job::ask_ai_real("p", &root.to_string_lossy(), None, &on_line, &cancel)
        .await
        .expect_err("an error");
    assert!(matches!(&err, kb_ai_scan::seams::AskError::Failed(m) if m == "The AI run failed."), "{err:?}");
    claude_set("stream.jsonl", "");
    claude_set("stderr", "warming up\nCould not reach the model\n");
    claude_set("rc", "3");
    let err = kb_ai_scan::job::ask_ai_real("p", &root.to_string_lossy(), None, &on_line, &cancel)
        .await
        .expect_err("an error");
    assert!(matches!(&err, kb_ai_scan::seams::AskError::Failed(m) if m == "Could not reach the model"), "{err:?}");
    claude_reset();
}

#[tokio::test]
async fn cancelling_the_ai_kills_the_cli() {
    let _guard = init().await;
    claude_reset();
    claude_set("sleep", "60");
    let root = tmp("askcancel");
    let cancel = Arc::new(kb_ai_scan::cancel::Cancel::new());
    let stopper = {
        let cancel = cancel.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(700)).await;
            cancel.cancel(kb_ai_scan::cancel::Reason::Cancelled);
        })
    };
    let started = std::time::Instant::now();
    let on_line = |_: &str| {};
    let err = kb_ai_scan::job::ask_ai_real("p", &root.to_string_lossy(), None, &on_line, &cancel)
        .await
        .expect_err("cancelled");
    assert!(matches!(err, kb_ai_scan::seams::AskError::Cancelled));
    assert!(started.elapsed() < Duration::from_secs(20));
    stopper.await.expect("stopper");
    claude_reset();
}

#[tokio::test]
async fn test_cancel_stops_a_running_trial() {
    let _guard = init().await;
    let root = tmp("cancel");
    let (_, _, row) = scan_row(&root, true).await;
    let pid_file = root.join("pid");
    let sleeper = format!("sleep 30 & echo $! > {}; wait", pid_file.display());
    let started = start_ai_job(&row, "try", &[("prepare", ""), ("test", &sleeper)], None).await;
    assert_eq!(kb_ai_scan::to_dict(&started)["job"]["state"], "running");
    for _ in 0..100 {
        let scan = until_status(&row.id, "test", "running").await;
        if scan {
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    for _ in 0..100 {
        if pid_file.exists() && !std::fs::read_to_string(&pid_file).unwrap_or_default().trim().is_empty() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    let scan = kb_ai_scan::to_dict(&cancel_job(&database::session(), &row.id).await.expect("cancel"));
    assert_eq!(scan["job"]["state"], "cancelled");
    assert!(scan["job"]["elapsed_s"].as_i64().expect("elapsed") < 20);
    assert_eq!(scan["trial"]["test"]["status"], "not_run");
    assert_eq!(scan["trial"]["test"]["reason"], "Cancelled.");
    assert!(!kb_ai_scan::running(&row.id));
    let pid: u32 = std::fs::read_to_string(&pid_file).expect("pid file").trim().parse().expect("a pid");
    assert!(process_gone(pid), "what the command started is killed");
    let log: Vec<&str> = scan["job"]["log"].as_array().expect("log").iter().filter_map(Value::as_str).collect();
    assert!(log.contains(&"Cancelled."));
    // the scratch copy is gone too
    let leftovers = std::fs::read_dir(std::env::temp_dir())
        .expect("temp")
        .flatten()
        .filter(|e| {
            e.file_name().to_string_lossy().starts_with("kanban-trial-")
                && e.path().join("wt").join("package.json").exists()
        })
        .count();
    assert_eq!(leftovers, 0);
    // a scan nobody runs a job for cannot be cancelled into anything: the row comes back as it is
    let again = cancel_job(&database::session(), &row.id).await.expect("cancel");
    assert_eq!(kb_ai_scan::to_dict(&again)["job"]["state"], "cancelled");
    assert!(
        matches!(cancel_job(&database::session(), "scn_nope").await, Err(Error::Lookup(m)) if m == "Scan not found.")
    );
}

async fn until_status(scan_id: &str, name: &str, status: &str) -> bool {
    let row = ai_repo_scan::Entity::find_by_id(scan_id).one(&database::session()).await.expect("read").expect("scan");
    let scan = kb_ai_scan::to_dict(&row);
    scan["trial"][name]["status"] == status
}

#[tokio::test]
async fn a_job_that_runs_too_long_is_stopped_and_says_so() {
    let _guard = init().await;
    let (_, _, row) = scan_row(&tmp("limit"), true).await;
    kb_ai_scan::job::set_job_limit(1.5);
    start_ai_job(&row, "try", &[("test", "sleep 30")], None).await;
    let scan = until_done(&row.id).await;
    kb_ai_scan::job::set_job_limit(kb_ai_scan::JOB_LIMIT_S as f64);
    assert_eq!(scan["job"]["state"], "timeout");
    assert_eq!(scan["job"]["error"], "The AI stopped after 10 minutes.");
    assert_eq!(scan["trial"]["test"]["status"], "not_run");
    assert_eq!(scan["trial"]["test"]["reason"], "The AI stopped after 10 minutes.");
    let log: Vec<&str> = scan["job"]["log"].as_array().expect("log").iter().filter_map(Value::as_str).collect();
    assert!(log.contains(&"Stopped after 10 minutes."));
}

#[tokio::test]
async fn a_job_that_fails_is_shown_failed_never_left_running() {
    let _guard = init().await;
    let (_, _, row) = scan_row(&tmp("failed"), true).await;
    // the folder of the scan is gone: the board cannot copy it
    std::fs::remove_dir_all(&row.folder).expect("remove");
    start_ai_job(&row, "try", &[("test", "true")], None).await;
    let scan = until_done(&row.id).await;
    assert_eq!(scan["job"]["state"], "failed");
    let error = scan["job"]["error"].as_str().expect("error");
    assert!(!error.is_empty(), "{scan}");
    let log: Vec<&str> = scan["job"]["log"].as_array().expect("log").iter().filter_map(Value::as_str).collect();
    assert!(log.iter().any(|l| l.starts_with("Failed: ")), "{log:?}");
    assert!(
        scan["job"]["steps"]
            .as_array()
            .expect("steps")
            .iter()
            .all(|s| s["state"] != "running" && s["state"] != "waiting")
    );
}

#[tokio::test]
async fn test_one_rows_run_keeps_the_others_results() {
    let _guard = init().await;
    let (_, _, row) = scan_row(&tmp("keeps"), true).await;
    start_ai_job(&row, "try", &[("test", "true"), ("lint", "exit 1")], None).await;
    let first = until_done(&row.id).await;
    assert_eq!(first["trial"]["lint"]["status"], "fails");
    start_ai_job(&row, "try", &[("test", "true"), ("lint", "true")], Some(vec!["lint".into()])).await;
    let second = until_done(&row.id).await;
    assert_eq!(second["trial"]["lint"]["status"], "works");
    assert_eq!(second["trial"]["test"]["status"], "works", "kept from the first run");
}

#[tokio::test]
async fn a_job_marks_what_has_no_command_as_skipped() {
    let _guard = init().await;
    let (_, _, row) = scan_row(&tmp("skipped"), true).await;
    start_ai_job(&row, "try", &[("test", "echo ok")], None).await;
    let scan = until_done(&row.id).await;
    let steps = scan["job"]["steps"].as_array().expect("steps");
    let state = |key: &str| steps.iter().find(|s| s["key"] == key).map(|s| (s["state"].clone(), s["detail"].clone()));
    assert_eq!(state("prepare"), Some((json!("skipped"), json!("No command."))));
    assert_eq!(state("lint"), Some((json!("skipped"), json!("No command."))));
    assert_eq!(state("test").map(|s| s.0), Some(json!("done")));
    assert!(state("test").expect("test").1.as_str().expect("detail").starts_with("works · "));
    assert_eq!(scan["trial"]["lint"], Value::Null);
    assert_eq!(scan["proposal"]["env_path"], json!([]));
}

#[tokio::test]
async fn the_job_a_restart_left_behind_is_shown_as_stopped() {
    let _guard = init().await;
    let (_, _, row) = scan_row(&tmp("restart"), true).await;
    let session = database::session();
    let mut active: ai_repo_scan::ActiveModel = row.clone().into();
    active.job =
        Set(json!({"mode": "ai", "state": "running", "started_at": kb_base::time::now_iso(), "error": null})
            .to_string());
    let row = active.update(&session).await.expect("update");
    session.commit().await.expect("commit");
    kb_ai_scan::seams::set_asker(Some(Arc::new(FakeAsker::new())));
    let out = kb_ai_scan::to_api(&session, &row).await.expect("to_api");
    assert_eq!(out["job"]["state"], "failed");
    assert_eq!(out["job"]["error"], "The app restarted while it ran. Run it again.");
    assert_eq!(out["ai_available"], true);
    assert_eq!(out["ai_unavailable_why"], Value::Null);
    kb_ai_scan::seams::set_asker(None);
}

// --------------------------------------------------------------------------- the scan itself

#[tokio::test]
async fn test_try_again_tries_the_commands_the_person_edited() {
    // The wizard's "Try again" (and Next after an edit) sends the edited commands: those run, not the suggestion.
    let _guard = init().await;
    let (project_id, _) = common::project().await;
    let repo = common::repo("tryagain");
    let session = database::session();
    let row = kb_ai_scan::run_scan(
        &session,
        &project_id,
        &repo.to_string_lossy(),
        ScanOptions { trial: true, refine: false, prepare: Some("echo mine"), test: Some("") },
    )
    .await
    .expect("scan");
    let trial: Value = serde_json::from_str(&row.trial).expect("trial");
    assert_eq!(trial["prepare"]["command"], "echo mine");
    assert!(trial["prepare"]["ok"] == true && trial["prepare"]["tail"] == json!(["mine"]));
    assert_eq!(trial["test"], Value::Null, "cleared by the person: nothing to try");
    assert!(row.id.starts_with("scn_"));
    assert_eq!(row.folder, repo.to_string_lossy());
    assert_eq!(row.job, "{}");
}

#[tokio::test]
async fn test_a_plain_pip_library_gets_no_global_install_and_no_browser_plugins() {
    let _guard = init().await;
    let root = tmp("pip");
    common::write_files(
        &root,
        &[
            ("pyproject.toml", "[project]\nname = \"calc\"\nversion = \"0.1.0\"\n"),
            ("tests/test_calc.py", "def test_x():\n    assert True\n"),
        ],
    );
    let s = kb_ai_scan::suggest(&kb_ai_scan::scan(&root.to_string_lossy()).await.expect("scan")).expect("suggest");
    // it would install into the person's own Python
    assert!(!s["prepare"].as_str().expect("prepare").contains("pip install"));
    let plugins: Vec<&str> = s["plugins"].as_array().expect("plugins").iter().filter_map(Value::as_str).collect();
    for key in ["webapp-testing", "chrome-devtools", "playwright"] {
        assert!(!plugins.contains(&key), "{key}");
    }
}

#[tokio::test]
async fn test_a_folder_the_members_could_not_work_in_is_refused_at_step_one() {
    // Create would skip every member made for it (services/ai/paths.py), so the scan says so first.
    let _guard = init().await;
    let (project_id, _) = common::project().await;
    let outside = std::env::temp_dir().join(format!("kb-scan-outside-{}", &kb_base::time::uuid4_hex()[..8]));
    let repo = node_repo(&outside.join("r"), true);
    let session = database::session();
    let refused = kb_ai_scan::run_scan(
        &session,
        &project_id,
        &repo.to_string_lossy(),
        ScanOptions { trial: false, ..Default::default() },
    )
    .await;
    let _ = std::fs::remove_dir_all(&outside);
    match refused {
        Err(Error::Value(text)) => {
            assert!(text.starts_with(
                "The AI team can only work in a folder inside your home folder, or one listed in KANBAN_AI_ROOTS. "
            ));
            assert!(text.contains("inside your home folder"));
            assert!(text.contains("Move the repository there, or add its parent folder to KANBAN_AI_ROOTS: "));
            assert!(text.ends_with(&repo.to_string_lossy().to_string()), "{text}");
        }
        other => panic!("{other:?}"),
    }
    let ok = node_repo(&tmp("inside").join("r"), true);
    let row = kb_ai_scan::run_scan(
        &session,
        &project_id,
        &ok.to_string_lossy(),
        ScanOptions { trial: false, ..Default::default() },
    )
    .await
    .expect("a folder inside the roots");
    assert_eq!(row.trial, "{}");
}

#[tokio::test]
async fn a_folder_that_does_not_exist_is_refused_in_the_words_of_the_scan() {
    let _guard = init().await;
    let (project_id, _) = common::project().await;
    let missing = tmp("missing").join("nope");
    let refused =
        kb_ai_scan::run_scan(&database::session(), &project_id, &missing.to_string_lossy(), ScanOptions::default())
            .await;
    assert!(
        matches!(&refused, Err(Error::Value(m)) if m == &format!("No such folder: {}", missing.display())),
        "{refused:?}"
    );
}

#[tokio::test]
async fn the_scan_stores_what_it_found_as_python_writes_json() {
    let _guard = init().await;
    let (_, _, row) = scan_row(&tmp("stored"), true).await;
    let found = found_of(&row);
    assert_eq!(row.found, kb_base::pyjson::dumps(&found));
    assert!(row.found.contains(", \"") && row.found.contains("\": "), "Python's separators: {}", row.found);
    assert_eq!(row.suggested, kb_base::pyjson::dumps(&serde_json::from_str::<Value>(&row.suggested).expect("json")));
    assert_eq!((row.trial.as_str(), row.job.as_str(), row.proposal.as_str()), ("{}", "{}", "{}"));
    assert!(row.applied_at.is_none());
    let dict = kb_ai_scan::to_dict(&row);
    assert_eq!(dict["base_path"], std::env::var("PATH").expect("PATH"));
    assert_eq!(dict["found"], found);
    let keys: Vec<&String> = dict.as_object().expect("object").keys().collect();
    assert_eq!(
        keys,
        [
            "id",
            "project_id",
            "folder",
            "found",
            "suggested",
            "trial",
            "job",
            "proposal",
            "base_path",
            "applied_at",
            "created_at"
        ]
    );
}

#[tokio::test]
async fn the_latest_scan_is_the_newest_one_not_applied_from_the_last_day() {
    let _guard = init().await;
    let root = tmp("latest");
    let (project_id, _) = common::project().await;
    let repo = node_repo(&root.join("r"), true);
    let session = database::session();
    let make = || async {
        kb_ai_scan::run_scan(
            &session,
            &project_id,
            &repo.to_string_lossy(),
            ScanOptions { trial: false, ..Default::default() },
        )
        .await
        .expect("scan")
    };
    assert!(kb_ai_scan::latest(&session, &project_id).await.expect("latest").is_none());
    let first = make().await;
    let second = make().await;
    assert_eq!(kb_ai_scan::latest(&session, &project_id).await.expect("latest").expect("a scan").id, second.id);
    // applied: not offered again
    let mut applied: ai_repo_scan::ActiveModel = second.clone().into();
    applied.applied_at = Set(Some(kb_base::time::now_iso()));
    applied.update(&session).await.expect("update");
    session.commit().await.expect("commit");
    assert_eq!(kb_ai_scan::latest(&session, &project_id).await.expect("latest").expect("a scan").id, first.id);
    // older than a day: not offered
    let mut old: ai_repo_scan::ActiveModel = first.clone().into();
    old.created_at = Set(kb_base::time::iso(&(chrono::Utc::now() - chrono::Duration::days(2))));
    old.update(&session).await.expect("update");
    session.commit().await.expect("commit");
    assert!(kb_ai_scan::latest(&session, &project_id).await.expect("latest").is_none());
}
