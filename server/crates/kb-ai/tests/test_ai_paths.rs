//! Folders and programs a person names for an AI member stay inside the allowed places (`services/ai/paths.py`). The
//! roots come from `KANBAN_AI_ROOTS` in Python (`monkeypatch.setenv`); the process environment is never changed here, so
//! the tests give the roots with `work_roots_with` and call the `_in` forms, which are what `folder` and `program` call.

// Unix only: it starts shell scripts, makes files executable or links them (Windows CI only compiles the tests).
#![cfg(unix)]

mod common;

use std::os::unix::fs::symlink;

use kb_ai::paths::{self, PathRefused};

fn real(path: &std::path::Path) -> String {
    path.canonicalize().expect("real path").to_string_lossy().into_owned()
}

#[tokio::test]
async fn test_a_working_folder_must_sit_inside_an_allowed_root() {
    let _lock = common::init().await;
    let tmp = tempfile::tempdir().expect("temporary folder");
    let tmp_path = tmp.path().canonicalize().expect("real path");
    let home = std::env::var("HOME").expect("HOME is set by common::init");
    let roots = paths::work_roots_with(&home, &tmp_path.to_string_lossy());
    let repo = tmp_path.join("repo");
    std::fs::create_dir(&repo).expect("folder");
    assert_eq!(paths::folder_in(&format!("  {}  ", repo.display()), &roots).await, Ok(real(&repo)));
    for bad in ["/etc", "/", &tmp_path.to_string_lossy()] {
        assert!(matches!(paths::folder_in(bad, &roots).await, Err(PathRefused(_))), "{bad}");
    }
    // the home folder itself is too wide
    assert!(paths::folder_in("~", &roots).await.is_err());
    // the real environment is used by `folder`: the home folder is a root, the temporary folder is not
    assert!(paths::folder("/etc").await.is_err());
    let in_home = std::path::Path::new(&home).join("proj");
    std::fs::create_dir_all(&in_home).expect("folder");
    assert_eq!(paths::folder(&in_home.to_string_lossy()).await, Ok(real(&in_home)));
    assert_eq!(
        paths::folder("/etc").await.expect_err("refused").0,
        "Choose a project folder inside your home folder (or add its parent to KANBAN_AI_ROOTS): /etc"
    );
}

#[tokio::test]
async fn test_a_symlink_out_of_the_roots_is_refused() {
    let _lock = common::init().await;
    let tmp = tempfile::tempdir().expect("temporary folder");
    let tmp_path = tmp.path().canonicalize().expect("real path");
    let roots = paths::work_roots_with("/nonexistent-home", &tmp_path.join("work").to_string_lossy());
    std::fs::create_dir(tmp_path.join("work")).expect("folder");
    symlink("/etc", tmp_path.join("work/etc")).expect("link");
    let link = tmp_path.join("work/etc");
    assert!(paths::folder_in(&link.to_string_lossy(), &roots).await.is_err());
}

#[tokio::test]
async fn test_a_cli_may_live_in_the_usual_install_folders() {
    let _lock = common::init().await;
    let tmp = tempfile::tempdir().expect("temporary folder");
    let tmp_path = tmp.path().canonicalize().expect("real path");
    let roots = paths::program_roots_with(paths::work_roots_with("/nonexistent-home", &tmp_path.to_string_lossy()));
    assert!(paths::program_in("/usr/bin/env", &roots).await.expect("allowed").starts_with("/usr/"));
    assert_eq!(
        paths::program_in("/etc/passwd", &roots).await.expect_err("refused").0,
        "The CLI must be installed in your home folder or a usual install folder: /etc/passwd"
    );
    assert!(paths::program("/usr/bin/env").await.is_ok());
}
