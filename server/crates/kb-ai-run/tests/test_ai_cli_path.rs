//! `server/tests/test_ai_cli_path.py`: a CLI path the person configured is the only one the board tries: a refused or
//! unusable path means no CLI and a sentence that says why, never another `claude` found on PATH (found when a
//! stand-in path was refused and the board ran the real Claude on the real account's quota).
//!
//! The environment of a test process cannot change, so where the Python test edits `PATH` and `KANBAN_AI_ROOTS` this
//! one uses what `common::init` set: the stand-in CLI is the `claude` on PATH, the temporary folder is an allowed
//! root, and "outside" is another temporary folder. `test_a_run_of_an_ai_with_an_unusable_cli_path_waits_and_says_why`
//! waits for `teams` and `runs`.
#![cfg(unix)]

mod common;

use std::path::{Path, PathBuf};

use kb_ai_run::cli;

fn program(folder: &Path, executable: bool) -> PathBuf {
    common::script(folder, "claude", "echo 1.0", executable)
}

#[tokio::test]
async fn test_a_refused_or_unusable_configured_path_is_not_replaced_by_the_one_on_path() {
    let _lock = common::init().await;
    let tmp_path = common::tmp_path("cli-path");
    let on_path = common::fake_cli();
    // nothing configured: PATH is searched, as before
    assert_eq!(cli::find_cli("claude", None).await.0, Some(on_path.clone()));
    assert_eq!(cli::find_cli("claude", Some("  ")).await.0, Some(on_path));
    assert_eq!(cli::find_cli("claude", None).await.1, ["PATH"]);

    // a path outside the folders the board allows is refused, and PATH is not tried instead
    let elsewhere = tempfile::tempdir().expect("a folder outside the allowed ones");
    let outside = program(&elsewhere.path().join("outside"), true);
    let outside = outside.to_string_lossy();
    let (path, checked) = cli::find_cli("claude", Some(&outside)).await;
    assert!(path.is_none() && !checked.contains(&"PATH".to_string()));
    let said = cli::missing("claude", Some(&outside)).await;
    assert!(said.contains(outside.as_ref()) && said.contains("does not run another claude"));
    assert!(said.contains("home folder"));

    // allowed, but not executable, or not there at all
    let flat = program(&tmp_path.join("flat"), false);
    let flat = flat.to_string_lossy();
    assert_eq!(cli::find_cli("claude", Some(&flat)).await.0, None);
    assert!(cli::missing("claude", Some(&flat)).await.contains("not executable"));
    let nope = tmp_path.join("nope").join("claude");
    let nope = nope.to_string_lossy();
    assert_eq!(cli::find_cli("claude", Some(&nope)).await.0, None);
    assert!(cli::missing("claude", Some(&nope)).await.contains("not a file"));

    // allowed and executable: used
    let good = program(&tmp_path.join("good"), true);
    let good = good.to_string_lossy().into_owned();
    assert_eq!(cli::find_cli("claude", Some(&good)).await.0, Some(good.clone()));
    assert_eq!(cli::missing("claude", None).await, "“claude” was not found on this computer");
    assert_eq!(
        cli::missing("claude", Some(&format!("  {flat} "))).await,
        format!(
            "The CLI set for this AI, {flat}, cannot be used: it cannot be run (not executable). The board does not run \
             another claude instead. Fix the path in the AI's settings, or clear it to use the one on this computer"
        )
    );
}

/// Not in the Python file: without a `claude` on PATH the usual install folders are looked at, in their order.
#[tokio::test]
async fn a_cli_that_is_not_on_path_is_looked_for_in_the_usual_install_folders() {
    let _lock = common::init().await;
    let (path, checked) = cli::find_cli("no-such-cli-anywhere", None).await;
    assert_eq!(path, None);
    let home = common::folder().join("home");
    let home = home.to_string_lossy();
    assert_eq!(
        checked,
        [
            "PATH".to_string(),
            format!("{home}/.local/bin"),
            format!("{home}/.claude/local"),
            format!("{home}/.npm-global/bin"),
            format!("{home}/bin"),
            "/usr/local/bin".to_string(),
            "/opt/homebrew/bin".to_string(),
            "/usr/bin".to_string(),
            format!("{home}/AppData/Roaming/npm"),
        ]
    );
    let installed = common::script(&Path::new(home.as_ref()).join(".npm-global/bin"), "tool-in-home", "echo 1", true);
    assert_eq!(cli::find_cli("tool-in-home", None).await.0, Some(installed.to_string_lossy().into_owned()));
    // what the tests put in place of the search (`monkeypatch.setattr(cli, "find_cli", ...)`)
    cli::set_find_cli_hook(Some(std::sync::Arc::new(|binary, explicit| {
        (binary == "claude" && explicit.is_none()).then(|| (None, Vec::new()))
    })));
    assert_eq!(cli::find_cli("claude", None).await, (None, Vec::new()));
    assert!(cli::find_cli("tool-in-home", None).await.0.is_some());
    cli::set_find_cli_hook(None);
    assert_eq!(cli::find_cli("claude", None).await.0, Some(common::fake_cli()));
}
