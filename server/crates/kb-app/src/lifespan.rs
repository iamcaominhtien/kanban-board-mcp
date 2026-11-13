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
    rescans: JoinHandle<()>,
}

/// Bring the database up and start the background work.
pub async fn startup() -> Result<Running, DatabaseError> {
    crate::hooks::install();
    // the programs this one does not start (the stdio MCP of an editor) must read the same key store
    kb_base::secrets::record_store();
    database::setup().await?;
    database::init_db_or_wait().await?;
    let follow = tokio::spawn(database::follow_settings(Duration::from_secs(2)));
    tracing::info!(target: "kanban.http", "Server started (version {})", kb_base::version::APP_VERSION);
    let sweeper = tokio::spawn(kb_board::workspace::sweep_loop());
    let db_watcher =
        tokio::spawn(database::watch_database(None, Duration::from_millis(400), Duration::from_millis(150)));
    if database::unreachable().is_some() {
        // A database server that does not answer must not stop the app: the person has to be able to open it, and
        // to switch to another board from Settings. What needs the database starts when it answers.
        tracing::warn!(
            target: "kanban.http",
            "The database cannot be reached: the AI runs, jobs and notifications start when it answers"
        );
        let rescans = tokio::spawn(async {
            while database::unreachable().is_some() {
                tokio::time::sleep(Duration::from_secs(2)).await;
            }
            if let Err(err) = start_database_work().await {
                tracing::error!(target: "kanban.http", "The background work could not start: {err}");
            }
            rescan_loop().await;
        });
        return Ok(Running { follow, sweeper, db_watcher, rescans });
    }
    start_database_work().await?;
    let rescans = tokio::spawn(rescan_loop());
    Ok(Running { follow, sweeper, db_watcher, rescans })
}

/// The background work that reads the database: recover what the last start left, and start the AI runs, the
/// schedules, the notifications and the GitHub sync.
async fn start_database_work() -> Result<(), DatabaseError> {
    // the AI runs: recover what the last start left and start the scheduler (or, with KANBAN_RUNNER=process, the
    // runner process, which does both)
    kb_ai_run::runs::start_scheduler().await.map_err(DatabaseError::from)?;
    // (as in `main.py`, a failure of either stops the start)
    kb_assist::docs_ai::jobs::recover().await.map_err(DatabaseError::from)?;
    kb_assist::assistant::chat::recover().await.map_err(DatabaseError::from)?;
    kb_ai_run::schedules::start_scheduler();
    kb_notify::start();
    kb_ai_work::github::start();
    Ok(())
}

const RESCAN_EVERY: Duration = Duration::from_secs(30 * 60);

/// Scan a project's repository again when its CI or packages changed; a person still applies it.
async fn rescan_loop() {
    loop {
        tokio::time::sleep(RESCAN_EVERY).await;
        // a scan that fails waits for the next round
        if let Err(err) = kb_ai_scan::sweep(database::session).await {
            tracing::error!(target: "kanban.http", "The repository rescan failed: {err}");
        }
    }
}

/// Stop the background work, in the reverse order of `startup`.
pub async fn shutdown(running: Running) {
    kb_ai_work::github::stop().await;
    running.rescans.abort();
    kb_notify::stop().await;
    // No CLI process outlives the board: cancel the AI runs and kill their process trees
    kb_ai_run::schedules::stop_scheduler().await;
    kb_ai_run::runs::stop_scheduler().await;
    kb_ai_run::signin::stop_all().await;
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

/// The runner process (`kanban-server --runner`, `runner/main.py`): the hooks between the areas and the database
/// pool as in the server, then the runner itself; it never brings the database up to date (the API did before it
/// started the runner). Returns the exit code of the process.
pub async fn runner() -> i32 {
    crate::hooks::install();
    if let Err(err) = database::setup().await {
        tracing::error!(target: "kanban.runner", "The AI runner cannot open the database: {err}");
        return 1;
    }
    kb_ai_run::runner::main().await
}
