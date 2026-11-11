//! `setup_logging_in` installs process-wide state (subscriber, panic hook), so it is tested once, in its own process.

use kb_log::{LOG_FILE_NAME, critical, iter_records_in, setup_logging_in};

#[test]
fn setup_logs_events_panics_and_is_safe_twice() {
    let dir = tempfile::tempdir().unwrap();
    let log = dir.path().join("logs");
    assert!(setup_logging_in(&log, false));
    assert!(setup_logging_in(&log, false));
    tracing::error!(target: "kanban.http", "hello {}", "world");
    tracing::debug!("below the root level");
    critical("t", "fatal");
    let result = std::panic::catch_unwind(|| panic!("kaboom"));
    assert!(result.is_err());
    let text = std::fs::read_to_string(log.join(LOG_FILE_NAME)).unwrap();
    assert!(text.contains(" ERROR kanban.http hello world\n"), "{text}");
    assert!(!text.contains("below the root level"));
    assert!(text.contains(" CRITICAL t fatal\n"));
    assert!(
        text.contains(" CRITICAL uncaught Uncaught exception"),
        "{text}"
    );
    assert!(text.contains("kaboom") && text.contains("setup.rs"));
    assert_eq!(
        iter_records_in(&log, None, None, "CRITICAL")
            .unwrap()
            .count(),
        2
    );
}

#[test]
fn an_unwritable_folder_is_not_fatal() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("file");
    std::fs::write(&file, "x").unwrap();
    // runs before or after the test above; either way a folder below a file cannot be created
    let ok = setup_logging_in(&file.join("logs"), false);
    let _ = ok;
}
