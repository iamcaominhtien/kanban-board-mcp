//! Plugins installed from a source (`services/ai/plugins.py`). The Python suite has no test of the install path (its
//! `conftest.py` replaces `packs.install_plugins` so no test reaches a marketplace); these tests are new. Every source is
//! a git repository or a folder the test makes in a temporary folder; `git` runs for real, nothing reaches the network and
//! no `claude` or `npx` runs. The catalogue's own sources (GitHub) are therefore never installed here:
//! `packs::install_plugins` is tested only for what it does without them.

mod common;

use std::path::{Path, PathBuf};
use std::time::Duration;

use kb_ai_know::plugins::{self, Error, InstallOpts};
use kb_db::database;
use kb_db::entities::{ai_plugin, ai_skill_use};
use kb_db::sea_orm::ActiveValue::Set;
use kb_db::sea_orm::{ActiveModelTrait, EntityTrait};
use serde_json::{Value, json};

const PLUGIN_JSON: &str = r#"{"name": "My Plugin", "version": "1.0", "description": "Does things."}"#;
const SKILL_A: &str = "---\nname: a\ndescription: Use a.\n---\n\nBody A.\n";
const SKILL_B: &str = "---\nname: b\ndescription: Use b.\n---\n\nBody B.\n";

fn git_source(root: &Path) -> String {
    root.to_string_lossy().into_owned()
}

fn opts<'a>(source_kind: &'a str, source: &'a str) -> InstallOpts<'a> {
    InstallOpts { source_kind, source, by: "An", ..Default::default() }
}

fn plugin_repo(tmp: &Path) -> (PathBuf, String) {
    let root = tmp.join("my-plugin");
    let commit = common::git_repo(
        &root,
        &[
            (".claude-plugin/plugin.json", PLUGIN_JSON),
            ("skills/a/SKILL.md", SKILL_A),
            ("skills/b/SKILL.md", SKILL_B),
            ("hooks/hooks.json", r#"{"hooks": {"Stop": [{}, {}]}}"#),
        ],
    );
    (root, commit)
}

fn cache_of(row: &ai_plugin::Model) -> PathBuf {
    kb_db::database::get_data_dir().join("plugin-cache").join(&row.id)
}

#[tokio::test]
async fn a_plugin_is_installed_from_a_git_repository_into_the_cache() {
    let _guard = common::init().await;
    let tmp = tempfile::tempdir().expect("temp");
    let (repo, commit) = plugin_repo(tmp.path());
    let (pid, _an) = common::project().await;
    let session = database::session();
    let row = plugins::install(
        &session,
        &pid,
        InstallOpts { roles: Some(vec!["dev".into()]), default_on: true, ..opts("git", &git_source(&repo)) },
    )
    .await
    .expect("installed");
    assert_eq!(
        (row.name.as_str(), row.version.as_deref(), row.description.as_deref()),
        ("My Plugin", Some("1.0"), Some("Does things."))
    );
    assert_eq!(row.commit.as_deref(), Some(commit.as_str()));
    assert_eq!(serde_json::from_str::<Value>(&row.skills).expect("skills"), json!(["a", "b"]));
    assert_eq!((row.hooks, row.mcp, row.pinned, row.default_on), (2, 0, false, true));
    assert_eq!(serde_json::from_str::<Value>(&row.roles).expect("roles"), json!(["dev"]));
    assert_eq!(row.installed_by.as_deref(), Some("An"));
    let dest = cache_of(&row).join(&commit);
    assert_eq!(row.path.as_deref(), Some(dest.to_str().expect("path")));
    assert!(dest.join("skills").join("a").join("SKILL.md").is_file());
    assert!(!dest.join(".git").exists());
    assert_eq!(
        std::fs::read_to_string(dest.join(".claude-plugin").join("plugin.json")).expect("manifest"),
        PLUGIN_JSON
    );
    // no child process is left and the temporary checkout is gone
    let again = plugins::install(&session, &pid, opts("git", &git_source(&repo))).await;
    assert!(matches!(again, Err(Error::Plugin(text)) if text == "My Plugin is already installed on this project."));
    // the stored row reads back as the API shows it
    let shown = plugins::to_dict(&row, None);
    assert_eq!(shown["skills"], json!(["a", "b"]));
    assert_eq!(shown["used"], json!({"uses": 0, "by_member": [], "last": null}));
    plugins::remove(&session, row.clone()).await.expect("removed");
    assert!(!cache_of(&row).exists());
    assert!(ai_plugin::Entity::find_by_id(row.id.clone()).one(&session).await.expect("row").is_none());
}

#[tokio::test]
async fn a_marketplace_entry_and_a_subset_of_its_skills_install() {
    let _guard = common::init().await;
    let tmp = tempfile::tempdir().expect("temp");
    let repo = tmp.path().join("market");
    common::git_repo(
        &repo,
        &[
            (
                ".claude-plugin/marketplace.json",
                r#"{"plugins": [{"name": "example-skills", "source": "./", "skills": ["./skills/a", "./skills/b"]}, {"name": "other", "source": "./other"}]}"#,
            ),
            ("skills/a/SKILL.md", SKILL_A),
            ("skills/b/SKILL.md", SKILL_B),
            ("other/skills/o/SKILL.md", "---\nname: o\ndescription: Use o.\n---\n\nO.\n"),
        ],
    );
    let (pid, _an) = common::project().await;
    let session = database::session();
    // no entry picked: the caller is told to pick
    let none = plugins::install(&session, &pid, opts("marketplace", &git_source(&repo))).await;
    assert!(matches!(none, Err(Error::Plugin(text)) if text == "This is a marketplace: pick which plugin to install."));
    let preview = plugins::preview("marketplace", &git_source(&repo), None, None, None).await.expect("preview");
    assert_eq!(
        preview["choices"],
        json!([{"name": "example-skills", "description": null}, {"name": "other", "description": null}])
    );
    assert!(preview["commit"].as_str().is_some_and(|c| c.len() == 40));
    // a subset of one skill: named after it
    let row = plugins::install(
        &session,
        &pid,
        InstallOpts {
            plugin: Some("example-skills"),
            skills: Some(vec!["b".into()]),
            ..opts("marketplace", &git_source(&repo))
        },
    )
    .await
    .expect("installed");
    assert_eq!(row.name, "b");
    assert_eq!(serde_json::from_str::<Value>(&row.skills).expect("skills"), json!(["b"]));
    assert_eq!(serde_json::from_str::<Value>(&row.skills_wanted).expect("wanted"), json!(["b"]));
    let dest = PathBuf::from(row.path.as_deref().expect("path"));
    assert!(dest.join("skills").join("b").join("SKILL.md").is_file() && !dest.join("skills").join("a").exists());
    // a marketplace entry that is a folder
    let other = plugins::install(
        &session,
        &pid,
        InstallOpts { plugin: Some("other"), ..opts("marketplace", &git_source(&repo)) },
    )
    .await
    .expect("installed");
    assert_eq!(other.name, "other");
    // an entry the marketplace does not have
    let missing = plugins::install(
        &session,
        &pid,
        InstallOpts { plugin: Some("nope"), ..opts("marketplace", &git_source(&repo)) },
    )
    .await;
    assert!(
        matches!(missing, Err(Error::Plugin(text)) if text == "The marketplace has no plugin called nope. It has: example-skills, other")
    );
}

#[tokio::test]
async fn an_update_keeps_the_previous_version_and_one_call_puts_it_back() {
    let _guard = common::init().await;
    let tmp = tempfile::tempdir().expect("temp");
    let (repo, first) = plugin_repo(tmp.path());
    let (pid, _an) = common::project().await;
    let session = database::session();
    let row = plugins::install(&session, &pid, opts("git", &git_source(&repo))).await.expect("installed");
    let nothing = plugins::check_update(&row).await.expect("check");
    assert_eq!(nothing, json!({"update": false, "latest": first, "current": first}));
    std::fs::remove_file(repo.join("skills").join("b").join("SKILL.md")).expect("removed");
    let second = common::git_commit(
        &repo,
        &[
            ("skills/a/SKILL.md", "---\nname: a\ndescription: Use a.\n---\n\nBody A, changed.\n"),
            ("skills/c/SKILL.md", "---\nname: c\ndescription: Use c.\n---\n\nC.\n"),
        ],
        "second",
    );
    assert_eq!(plugins::latest_commit(&row).await.expect("latest").as_deref(), Some(second.as_str()));
    let check = plugins::check_update(&row).await.expect("check");
    assert_eq!(check, json!({"update": true, "latest": second, "current": first}));
    let changes = plugins::changes(&row).await.expect("changes");
    assert_eq!(changes["commit"], json!(second));
    assert_eq!(changes["added"], json!(["skills/c/SKILL.md"]));
    assert_eq!(changes["removed"], json!(["skills/b/SKILL.md"]));
    assert_eq!(changes["changed"], json!(["skills/a/SKILL.md"]));
    let old_path = row.path.clone().expect("path");
    let updated = plugins::update(&session, row.clone()).await.expect("updated");
    assert_eq!(updated.commit.as_deref(), Some(second.as_str()));
    assert_eq!(serde_json::from_str::<Value>(&updated.skills).expect("skills"), json!(["a", "c"]));
    assert_ne!(updated.path.as_deref(), Some(old_path.as_str()));
    assert!(Path::new(&old_path).is_dir(), "the previous copy is kept");
    let previous: Value = serde_json::from_str(updated.previous.as_deref().expect("previous")).expect("json");
    assert_eq!(previous["commit"], json!(first));
    assert_eq!(previous["skills"], json!(["a", "b"]));
    assert_eq!(plugins::to_dict(&updated, None)["has_previous"], json!(true));
    // one call puts the previous version back, and the current one becomes the previous
    let back = plugins::rollback(&session, updated.clone()).await.expect("rolled back");
    assert_eq!((back.commit.as_deref(), back.path.as_deref()), (Some(first.as_str()), Some(old_path.as_str())));
    assert_eq!(serde_json::from_str::<Value>(&back.skills).expect("skills"), json!(["a", "b"]));
    let again: Value = serde_json::from_str(back.previous.as_deref().expect("previous")).expect("json");
    assert_eq!(again["commit"], json!(second));
    // reload reads the recorded commit again, dropping a change made in the cache
    std::fs::write(Path::new(&old_path).join("skills").join("a").join("SKILL.md"), "tampered").expect("tamper");
    let reloaded = plugins::reload(&session, back).await.expect("reloaded");
    assert_eq!(reloaded.commit.as_deref(), Some(first.as_str()));
    let text = std::fs::read_to_string(
        Path::new(reloaded.path.as_deref().expect("path")).join("skills").join("a").join("SKILL.md"),
    )
    .expect("file");
    assert_eq!(text, SKILL_A);
    // without a previous version there is nothing to put back
    let (other_project, _an) = common::project().await;
    let fresh =
        plugins::install(&session, &other_project, opts("folder", &git_source(&repo))).await.expect("installed");
    assert!(
        matches!(plugins::rollback(&session, fresh).await, Err(Error::Plugin(t)) if t == "There is no previous version to put back.")
    );
}

#[tokio::test]
async fn a_ref_by_commit_pins_the_plugin_and_a_pinned_plugin_is_never_updated() {
    let _guard = common::init().await;
    let tmp = tempfile::tempdir().expect("temp");
    let (repo, first) = plugin_repo(tmp.path());
    common::git_commit(&repo, &[("README.md", "second")], "second");
    let (pid, _an) = common::project().await;
    let session = database::session();
    let row = plugins::install(&session, &pid, InstallOpts { ref_: Some(&first), ..opts("git", &git_source(&repo)) })
        .await
        .expect("installed");
    assert!(row.pinned);
    assert_eq!(row.commit.as_deref(), Some(first.as_str()), "the commit asked for is checked out");
    assert_eq!(plugins::check_update(&row).await.expect("check"), json!({"update": false, "pinned": true}));
    assert!(matches!(
        plugins::update(&session, row.clone()).await,
        Err(Error::Plugin(t)) if t == "My Plugin is pinned: unpin it to update."
    ));
    let unpinned = plugins::pin(&session, row, false).await.expect("unpinned");
    assert!(!unpinned.pinned);
    assert_eq!(unpinned.r#ref, None, "a pinned commit is no ref any more");
    let pinned = plugins::pin(&session, unpinned, true).await.expect("pinned");
    assert!(pinned.pinned);
    assert_eq!(pinned.r#ref.as_deref(), Some(first.as_str()));
    // a branch that does not exist is a plugin error with git's words
    let bad = plugins::preview("git", &git_source(&repo), Some("no-such-branch"), None, None).await;
    match bad {
        Err(Error::Plugin(text)) => {
            assert!(text.starts_with(&format!("Could not get {}@no-such-branch: ", repo.display())), "{text}")
        }
        other => panic!("{other:?}"),
    }
}

#[tokio::test]
async fn a_folder_source_installs_its_current_files_and_reload_rereads_them() {
    let _guard = common::init().await;
    let tmp = tempfile::tempdir().expect("temp");
    let folder = tmp.path().join("skills-folder");
    common::write_files(&folder, &[("skills/one/SKILL.md", SKILL_A)]);
    let (pid, _an) = common::project().await;
    let session = database::session();
    let row = plugins::install(&session, &pid, opts("folder", &git_source(&folder))).await.expect("installed");
    assert_eq!(row.name, "skills-folder");
    assert_eq!(row.commit, None, "a plain folder has no commit");
    assert!(row.path.as_deref().is_some_and(|p| p.ends_with("/folder")));
    assert_eq!(plugins::latest_commit(&row).await.expect("latest"), None);
    assert_eq!(
        plugins::check_update(&row).await.expect("check"),
        json!({"update": false, "latest": null, "current": null})
    );
    common::write_files(&folder, &[("skills/two/SKILL.md", SKILL_B)]);
    let reloaded = plugins::reload(&session, row.clone()).await.expect("reloaded");
    assert_eq!(serde_json::from_str::<Value>(&reloaded.skills).expect("skills"), json!(["one", "two"]));
    assert!(reloaded.path.as_deref().is_some_and(|p| p.contains("/folder-")), "{:?}", reloaded.path);
    assert!(!Path::new(row.path.as_deref().expect("path")).exists(), "the copy it replaced is removed");
    // a folder that is not there, and a source kind that is not one
    let gone = plugins::install(&session, &pid, opts("folder", "/no/such/folder")).await;
    assert!(matches!(gone, Err(Error::Plugin(t)) if t == "No such folder: /no/such/folder"));
    let kind = plugins::install(&session, &pid, opts("ftp", "x")).await;
    assert!(matches!(kind, Err(Error::Plugin(t)) if t == "A source is a git URL, a marketplace or a folder."));
    let nothing = tmp.path().join("nothing");
    common::write_files(&nothing, &[("README.md", "x")]);
    let empty = plugins::install(&session, &pid, opts("folder", &git_source(&nothing))).await;
    assert!(matches!(empty, Err(Error::Plugin(t)) if t == "No plugin, marketplace or skill was found there."));
}

#[tokio::test]
async fn a_member_s_own_switch_wins_and_usage_counts_the_skills_a_run_opened() {
    let _guard = common::init().await;
    let tmp = tempfile::tempdir().expect("temp");
    let (pid, _an) = common::project().await;
    let (m, team) = common::team(&pid, "Claude Code · Backend", Default::default()).await;
    let row = common::plugin_row(&pid, &tmp.path().join("p"), "p", &["dev"], |_| {}).await;
    let session = database::session();
    let keys: std::collections::HashSet<String> = ["dev".to_string()].into_iter().collect();
    assert!(plugins::on_for(&row, &team, Some(&keys)));
    let off = plugins::set_member(&session, row.clone(), &m.id, Some(false)).await.expect("switch");
    assert!(!plugins::on_for(&off, &team, Some(&keys)));
    assert_eq!(plugins::to_dict(&off, None)["members"], json!([{"member_id": m.id, "on": false}]));
    let follow = plugins::set_member(&session, off, &m.id, None).await.expect("switch");
    assert!(plugins::on_for(&follow, &team, Some(&keys)));
    assert_eq!(plugins::to_dict(&follow, None)["members"], json!([]));
    for (name, plugin, member, at) in [
        ("a", Some("p"), Some("m1"), "2026-01-01T00:00:00"),
        ("b", Some("p"), Some("m2"), "2026-03-01T00:00:00"),
        ("c", Some("p"), Some("m1"), "2026-02-01T00:00:00"),
        ("board-skill", None, None, "2026-01-05T00:00:00"),
    ] {
        let mut u = ai_skill_use::new();
        u.run_id = Set("run".into());
        u.project_id = Set(pid.clone());
        u.member_id = Set(member.map(str::to_string));
        u.name = Set(name.into());
        u.plugin = Set(plugin.map(str::to_string));
        u.at = Set(at.into());
        u.insert(&session).await.expect("use");
    }
    session.commit().await.expect("commit");
    let used = plugins::usage(&session, &pid).await.expect("usage");
    assert_eq!(
        Value::Object(used.clone()),
        json!({
            "p": {"uses": 3, "by_member": {"m1": 2, "m2": 1}, "last": "2026-03-01T00:00:00"},
            "board-skill": {"uses": 1, "by_member": {}, "last": "2026-01-05T00:00:00"},
        })
    );
    let shown = plugins::to_dict(&follow, used.get("p"));
    assert_eq!(
        shown["used"],
        json!({"uses": 3, "by_member": [{"member_id": "m1", "uses": 2}, {"member_id": "m2", "uses": 1}], "last": "2026-03-01T00:00:00"})
    );
}

#[tokio::test]
async fn a_background_install_is_waited_for_before_a_run_lists_its_plugins() {
    let _guard = common::init().await;
    let flag = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    assert!(plugins::settled("P-bg", Duration::from_millis(50)).await, "nothing pending");
    let seen = flag.clone();
    plugins::installing("P-bg", async move {
        tokio::time::sleep(Duration::from_millis(300)).await;
        seen.store(true, std::sync::atomic::Ordering::SeqCst);
        Ok(())
    });
    assert!(!plugins::settled("P-bg", Duration::from_millis(20)).await, "still running: not settled");
    assert!(!flag.load(std::sync::atomic::Ordering::SeqCst));
    assert!(plugins::settled("P-bg", Duration::from_secs(10)).await);
    assert!(flag.load(std::sync::atomic::Ordering::SeqCst));
    // a failure is logged, never raised, and the project is settled afterwards
    plugins::installing("P-bg", async { Err(Error::Plugin("boom".into())) });
    assert!(plugins::settled("P-bg", Duration::from_secs(10)).await);
}

#[tokio::test]
async fn a_pack_with_nothing_to_install_installs_nothing() {
    let _guard = common::init().await;
    let (pid, _an) = common::project().await;
    let session = database::session();
    // the QA, BA and Reviewer packs name no plugin; an MCP server of the catalogue is no plugin
    for key in ["qa", "ba", "reviewer"] {
        let pack = kb_ai_know::packs::builtin(key).expect("pack");
        let out = kb_ai_know::packs::install_plugins(&session, &pid, &pack, "An").await.expect("install");
        assert_eq!(out, json!({"installed": [], "failed": []}), "{key}");
    }
    let mut pack = kb_ai_know::packs::builtin("pm").expect("pack");
    pack.insert("plugins".into(), json!(["playwright", "no-such-key", 5]));
    let out = kb_ai_know::packs::install_plugins(&session, &pid, &pack, "An").await.expect("install");
    assert_eq!(out, json!({"installed": [], "failed": []}));
    // a plugin already installed under the catalogue name is left alone
    let tmp = tempfile::tempdir().expect("temp");
    common::plugin_row(&pid, &tmp.path().join("tufte-data-viz"), "tufte-data-viz", &[], |_| {}).await;
    let mut pack = kb_ai_know::packs::builtin("data_analyst").expect("pack");
    pack.insert("plugins".into(), json!(["tufte-data-viz"]));
    let out = kb_ai_know::packs::install_plugins(&session, &pid, &pack, "An").await.expect("install");
    assert_eq!(out, json!({"installed": [], "failed": []}));
}
