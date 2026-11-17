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
    docs_convert: JoinHandle<()>,
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
    // the AI runs: recover what the last start left and start the scheduler (or, with KANBAN_RUNNER=process, the
    // runner process, which does both)
    kb_ai_run::runs::start_scheduler().await.map_err(DatabaseError::from)?;
    // (as in `main.py`, a failure of either stops the start)
    kb_assist::docs_ai::jobs::recover().await.map_err(DatabaseError::from)?;
    kb_assist::assistant::chat::recover().await.map_err(DatabaseError::from)?;
    kb_ai_run::schedules::start_scheduler();
    kb_notify::start();
    kb_ai_work::github::start();
    let rescans = tokio::spawn(rescan_loop());
    let docs_convert = tokio::spawn(docs_convert_loop());
    Ok(Running { follow, sweeper, db_watcher, rescans, docs_convert })
}

const DOCS_CONVERT_EVERY: Duration = Duration::from_secs(5 * 60);

/// Convert the Docs pages still in Markdown to the rich format: at start, then now and then (a database switched to,
/// copied in or written by an older app can bring new ones).
async fn docs_convert_loop() {
    loop {
        let session = database::session();
        match kb_docs::docs_convert::run(&session).await {
            Ok(report) if report.done + report.failed > 0 => {
                tracing::info!(
                    target: "kanban.http",
                    "Docs pages converted to the rich format: {} done, {} could not be converted",
                    report.done,
                    report.failed
                );
                kb_base::events::publish("invalidate", &[]).await;
            }
            Ok(_) => {}
            Err(err) => tracing::error!(target: "kanban.http", "Converting Docs pages failed: {err:?}"),
        }
        tokio::time::sleep(DOCS_CONVERT_EVERY).await;
    }
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
    running.docs_convert.abort();
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
