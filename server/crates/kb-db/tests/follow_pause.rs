//! `pause_following`: while a workspace switch changes the settings and re-points the process itself, the follow loop
//! of the same process must stand still (else it re-points on a half-written change). The only test of this process:
//! the folders are set before anything reads them.

use std::path::Path;
use std::time::{Duration, Instant};

use kb_base::config;
use kb_db::database::{self, OnSwitch};

/// Wait until `done` is true (at most 5 s).
async fn until(done: impl Fn() -> bool) -> bool {
    let started = Instant::now();
    while started.elapsed() < Duration::from_secs(5) {
        if done() {
            return true;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    done()
}

fn db_in(folder: &Path) -> bool {
    database::get_db_path() == folder.join("kanban.db") || database::get_db_path().starts_with(folder)
}

#[tokio::test]
#[allow(unsafe_code)]
async fn the_follow_loop_stands_still_while_a_switch_is_paused() {
    let dir = tempfile::tempdir().expect("tmp");
    let (first, second) = (dir.path().join("first"), dir.path().join("second"));
    std::fs::create_dir_all(&first).expect("first");
    std::fs::create_dir_all(&second).expect("second");
    let first = std::fs::canonicalize(first).expect("first path");
    let second = std::fs::canonicalize(second).expect("second path");
    unsafe {
        std::env::set_var("KANBAN_CONFIG_DIR", dir.path().join("config"));
        std::env::set_var("KANBAN_DB_PATH", first.join("kanban.db"));
        std::env::remove_var("KANBAN_DATABASE_URL");
    }
    database::setup().await.expect("setup");
    database::init_db().await.expect("init");
    assert!(db_in(&first));
    let follow = tokio::spawn(database::follow_settings(Duration::from_millis(100), OnSwitch::Follow));
    // let the loop take its first look at the settings before they change (a spawned task starts at the next await)
    tokio::time::sleep(Duration::from_millis(300)).await;

    // two switches overlapping: the loop stays still until both are over
    let outer = database::pause_following();
    let inner = database::pause_following();
    config::set_data_folder(&second).expect("data folder");
    tokio::time::sleep(Duration::from_millis(800)).await;
    assert!(db_in(&first), "the loop re-pointed the process while a switch was paused");
    drop(inner);
    tokio::time::sleep(Duration::from_millis(800)).await;
    assert!(db_in(&first), "the loop re-pointed the process while one switch was still paused");

    // and when the last one is over, what changed meanwhile is followed
    drop(outer);
    let followed = until(|| db_in(&second)).await;
    assert!(
        followed,
        "the loop never followed the change after the pause: db {:?}, data_folder {:?}, loop finished: {}",
        database::get_db_path(),
        config::get_data_folder(),
        follow.is_finished()
    );
    follow.abort();
}
