//! What runs for the app's lifetime: the database, the loops that follow it, and (as the areas are ported) the
//! background work of each area, started and stopped in the order the Python app used.

use std::time::Duration;

use tokio::task::JoinHandle;

use kb_db::database::{self, DatabaseError};

/// The background tasks to stop at shutdown.
pub struct Running {
    follow: JoinHandle<()>,
    sweeper: JoinHandle<()>,
    db_watcher: JoinHandle<()>,
}

/// Bring the database up and start the background work.
pub async fn startup() -> Result<Running, DatabaseError> {
    crate::hooks::install();
    database::setup().await?;
    database::init_db_or_wait().await?;
    let follow = tokio::spawn(database::follow_settings(Duration::from_secs(2)));
    tracing::info!(target: "kanban.http", "Server started (version {})", kb_base::version::APP_VERSION);
    let sweeper = tokio::spawn(kb_board::workspace::sweep_loop());
    let db_watcher =
        tokio::spawn(database::watch_database(None, Duration::from_millis(400), Duration::from_millis(150)));
    // (the AI run scheduler, the Docs AI and assistant recovery and the AI schedules start here once ported)
    kb_notify::start();
    kb_ai_work::github::start();
    Ok(Running { follow, sweeper, db_watcher })
}

/// Stop the background work, in the reverse order of `startup`.
pub async fn shutdown(running: Running) {
    kb_ai_work::github::stop().await;
    // (the repository rescan stops here once ported)
    kb_notify::stop().await;
    running.sweeper.abort();
    running.db_watcher.abort();
    running.follow.abort();
    let _ = running.sweeper.await;
    let _ = running.db_watcher.await;
    let _ = running.follow.await;
}

/// Resolves when the process is asked to stop (Ctrl-C, or SIGTERM from the desktop app).
pub async fn stop_signal() {
    let ctrl_c = async {
        let _ = tokio::signal::ctrl_c().await;
    };
    #[cfg(unix)]
    let terminate = async {
        match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
            Ok(mut signal) => {
                signal.recv().await;
            }
            Err(_) => std::future::pending::<()>().await,
        }
    };
    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();
    tokio::select! {
        () = ctrl_c => {}
        () = terminate => {}
    }
}
