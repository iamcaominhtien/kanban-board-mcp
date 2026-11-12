//! The runner process: `kanban-server --runner` (the API starts it with KANBAN_RUNNER=process) (`runner/main.py`).
//!
//! It owns every Claude Code CLI the board runs: the scheduler of `runs` runs here, steps go to the database from
//! here, and every board event is sent to the API (`POST /internal/ai/events`) so the people's browsers hear it. The
//! API tells it what to do with a run through `ai_run_command`. When the API process is gone the runner stops its
//! CLIs and exits.
//!
//! `main` expects what every process of the server sets up before it runs anything: the logging, the hooks between
//! the areas and the database pool (`kb_app::lifespan::runner` does that and calls it).

use std::collections::BTreeSet;
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use kb_ai::{power, runner_link};
use kb_base::events;
use kb_db::entities::ai_run_command;
use kb_db::sea_orm::{ActiveValue::Set, ColumnTrait, DbErr, EntityTrait, QueryFilter, QueryOrder, QuerySelect};
use kb_db::{changes, database};
use serde_json::{Map, Value, json};

use crate::runs::{self, Event, RunError};

/// Seconds between two looks at the command table.
pub const POLL_S: f64 = 0.5;
/// Seconds between two looks at the API process.
pub const PARENT_CHECK_S: f64 = 3.0;

/// `psutil.pid_exists(pid)`: whether the process that started the runner is still there.
fn parent_alive(pid: i64) -> bool {
    if pid <= 0 {
        return true;
    }
    #[cfg(unix)]
    {
        use nix::errno::Errno;
        let Ok(pid) = i32::try_from(pid) else { return false };
        match nix::sys::signal::kill(nix::unistd::Pid::from_raw(pid), None) {
            Ok(()) => true,
            Err(Errno::ESRCH) => false,
            // it is there and is not ours to signal
            Err(_) => true,
        }
    }
    #[cfg(not(unix))]
    {
        let Ok(pid) = u32::try_from(pid) else { return false };
        let pid = sysinfo::Pid::from_u32(pid);
        let mut system = sysinfo::System::new();
        system.refresh_processes(sysinfo::ProcessesToUpdate::Some(&[pid]), true);
        system.process(pid).is_some()
    }
}

/// How the Forwarder sends one body to the API (`Forwarder._post`; a test gives its own).
pub type Post = Arc<dyn Fn(Value) -> Pin<Box<dyn Future<Output = ()> + Send>> + Send + Sync>;

/// What the commits told since the last post (`_wrote`, `_tickets`), and whether a task is posting them (`_noting`).
#[derive(Default)]
struct Notes {
    wrote: Vec<f64>,
    /// a commit wrote a ticket since the last announcement of it
    tickets: bool,
    noting: bool,
}

/// Posts the board's events to the API, and tells it when this process wrote to the database.
pub struct Forwarder {
    post: Post,
    /// The runtime `note_write` schedules its posts on (`bind`).
    runtime: Mutex<Option<tokio::runtime::Handle>>,
    notes: Mutex<Notes>,
}

/// The HTTP side of the Forwarder: posts to the API, a failure logged (at most every 30 s) and dropped.
struct Http {
    url: String,
    token: String,
    client: reqwest::Client,
    /// When a failure was last logged (None: never, Python's 0.0).
    failed_at: Mutex<Option<Instant>>,
}

impl Http {
    async fn post(&self, body: Value) {
        let sent = self.client.post(&self.url).header("X-Kanban-Internal", &self.token).json(&body).send().await;
        let mut failed_at = self.failed_at.lock().unwrap_or_else(|e| e.into_inner());
        match sent {
            Ok(_) => *failed_at = None,
            // the API may be restarting; the rows are in the database anyway
            Err(err) => {
                if failed_at.is_none_or(|at| at.elapsed() > Duration::from_secs(30)) {
                    tracing::warn!(target: "kanban.runner", "Could not forward an event to the API: {err}");
                    *failed_at = Some(Instant::now());
                }
            }
        }
    }
}

impl Forwarder {
    /// `token` is what the API gave this runner when it started it.
    pub fn new(board_url: &str, token: &str) -> Self {
        // the API is on this computer: never through a proxy
        let client = reqwest::Client::builder()
            .no_proxy()
            .timeout(Duration::from_secs(3))
            .build()
            .unwrap_or_else(|_| reqwest::Client::new());
        let http = Arc::new(Http {
            url: format!("{}/internal/ai/events", board_url.trim_end_matches('/')),
            token: token.to_string(),
            client,
            failed_at: Mutex::new(None),
        });
        Self::with_post(Arc::new(move |body| {
            let http = http.clone();
            Box::pin(async move { http.post(body).await })
        }))
    }

    /// A Forwarder that sends its bodies through `post` (the tests replace `_post`).
    pub fn with_post(post: Post) -> Self {
        Self { post, runtime: Mutex::new(None), notes: Mutex::new(Notes::default()) }
    }

    /// Send one event; a failure is logged (at most every 30 s) and dropped.
    pub async fn send(&self, event: String) {
        (self.post)(json!({"event": event})).await;
    }

    /// The runtime `note_write` schedules its posts on.
    pub fn bind(&self, runtime: tokio::runtime::Handle) {
        *self.runtime.lock().unwrap_or_else(|e| e.into_inner()) = Some(runtime);
    }

    /// A commit of this process wrote (called inside the write, so it only schedules). The API's database watcher
    /// would otherwise take it for another app's change and make every window refetch everything: say it was the
    /// runner's, and when (the watcher matches a commit to its readings by time). Commits while a post is on its way
    /// are told in one more post.
    ///
    /// A commit that wrote a ticket (a run's closing comment, its question, Pending, the work log) is also announced:
    /// the windows refetch the tickets (topic `tickets`), as they do for a change made through the API.
    pub fn note_write(self: &Arc<Self>, tables: Option<&BTreeSet<String>>) {
        let Some(runtime) = self.runtime.lock().unwrap_or_else(|e| e.into_inner()).clone() else { return };
        let ticket = tables.is_none_or(|t| t.is_empty() || t.contains("ticket") || t.contains("*"));
        self.kick(&runtime, kb_base::time::epoch(), ticket);
    }

    fn kick(self: &Arc<Self>, runtime: &tokio::runtime::Handle, at: f64, ticket: bool) {
        let mut notes = self.notes.lock().unwrap_or_else(|e| e.into_inner());
        notes.wrote.push(at);
        notes.tickets = notes.tickets || ticket;
        if !notes.noting {
            notes.noting = true;
            let me = self.clone();
            runtime.spawn(async move { me.send_notes().await });
        }
    }

    async fn send_notes(&self) {
        loop {
            let times = {
                let mut notes = self.notes.lock().unwrap_or_else(|e| e.into_inner());
                if notes.wrote.is_empty() && !notes.tickets {
                    notes.noting = false;
                    return;
                }
                let wrote = std::mem::take(&mut notes.wrote);
                wrote[wrote.len().saturating_sub(500)..].to_vec()
            };
            if !times.is_empty() {
                (self.post)(json!({"own_change": true, "at": times})).await;
            }
            // read after the first post, as Python does: a ticket written meanwhile goes in this round
            let tickets = std::mem::take(&mut self.notes.lock().unwrap_or_else(|e| e.into_inner()).tickets);
            if tickets {
                let event = kb_base::pyjson::dumps(&json!({"type": "invalidate", "topics": ["tickets"]}));
                (self.post)(json!({"event": event})).await;
            }
        }
    }
}

async fn dispatch(row: &ai_run_command::Model) {
    let payload = match serde_json::from_str::<Value>(if row.payload.is_empty() { "{}" } else { &row.payload }) {
        Ok(Value::Object(map)) => map,
        Ok(_) => Map::new(),
        Err(err) => {
            tracing::error!(target: "kanban.runner", "Command {} on {} failed: {err}", row.command, row.run_id);
            return;
        }
    };
    let text = |key: &str| payload.get(key).and_then(Value::as_str).filter(|v| !v.is_empty());
    let by = text("by").unwrap_or("board");
    let done: Result<(), RunError> = async {
        match row.command.as_str() {
            "cancel" => {
                let stop_code = payload.get("stop_code").and_then(Value::as_str);
                runs::cancel(&row.run_id, by, text("reason"), stop_code, false).await?;
            }
            "restart" => {
                runs::restart_run(&row.run_id, by).await?;
            }
            "message" => {
                runs::send_message(&row.run_id, text("text").unwrap_or(""), by, text("peer"), true).await?;
            }
            "answer" => {
                runs::answer(&row.run_id, by, text("text").unwrap_or("")).await?;
            }
            "wake" => {
                let session = database::session();
                power::after_wake(&session).await?;
            }
            "start" => runs::RT.wake.set(),
            other => tracing::warn!(target: "kanban.runner", "Unknown runner command {other}"),
        }
        Ok(())
    }
    .await;
    match done {
        Ok(()) => {}
        Err(err) if err.is_run_error() => {
            tracing::info!(target: "kanban.runner", "Command {} on {} did nothing: {err}", row.command, row.run_id);
        }
        Err(err) => {
            tracing::error!(target: "kanban.runner", "Command {} on {} failed: {err}", row.command, row.run_id);
        }
    }
}

/// Take and run the commands the API left; returns how many.
pub async fn poll_commands(once: bool) -> Result<usize, DbErr> {
    let mut n = 0;
    loop {
        let taken: Vec<ai_run_command::Model> = {
            let session = database::session();
            let rows = ai_run_command::Entity::find()
                .filter(ai_run_command::Column::TakenAt.is_null())
                .order_by_asc(ai_run_command::Column::Id)
                .limit(20)
                .all(&session)
                .await?;
            let mut taken = Vec::new();
            for row in rows {
                let mut active = kb_db::edit(row);
                active.taken_at = Set(Some(kb_ai::store::now_iso()));
                taken.push(active.update(&session).await?);
            }
            session.commit().await?;
            taken
        };
        for row in &taken {
            dispatch(row).await;
            n += 1;
        }
        if once || taken.is_empty() {
            return Ok(n);
        }
    }
}

/// Run until the parent is gone or `stop` is set.
pub async fn serve(board_url: &str, token: &str, parent_pid: i64, stop: Option<Arc<Event>>) {
    runner_link::set_in_runner(Some(true));
    let forwarder = Arc::new(Forwarder::new(board_url, token));
    forwarder.bind(tokio::runtime::Handle::current());
    {
        let forwarder = forwarder.clone();
        events::set_forwarder(move |event| {
            let forwarder = forwarder.clone();
            async move { forwarder.send(event).await }
        });
    }
    changes::on_write_commit("runner_forwarder", move |tables| forwarder.note_write(Some(tables)));
    runs::set_board_url(board_url);
    if let Err(err) = runs::start_scheduler().await {
        // Python lets this end the runner (the API starts it again)
        tracing::error!(target: "kanban.runner", "The AI runner could not start: {err}");
        runs::stop_scheduler().await;
        return;
    }
    tracing::info!(target: "kanban.runner", "AI runner serving for {board_url} (parent {parent_pid})");
    let mut last_parent = Instant::now();
    while !stop.as_ref().is_some_and(|s| s.is_set()) {
        if let Err(err) = poll_commands(false).await {
            tracing::error!(target: "kanban.runner", "Polling the commands failed: {err}");
        }
        if last_parent.elapsed().as_secs_f64() >= PARENT_CHECK_S {
            last_parent = Instant::now();
            if !parent_alive(parent_pid) {
                tracing::info!(target: "kanban.runner", "The API process is gone: stopping");
                break;
            }
        }
        tokio::time::sleep(Duration::from_secs_f64(POLL_S)).await;
    }
    runs::stop_scheduler().await;
}

/// Entry point of `kanban-server --runner`: the exit code of the process.
pub async fn main() -> i32 {
    let env = |name: &str| std::env::var(name).ok().filter(|v| !v.is_empty());
    let board_url = env("KANBAN_BOARD_URL").unwrap_or_else(|| "http://127.0.0.1:8000".to_string());
    let token = env("KANBAN_INTERNAL_TOKEN").unwrap_or_default();
    let parent_pid = match env("KANBAN_PARENT_PID").unwrap_or_else(|| "0".to_string()).trim().parse::<i64>() {
        Ok(pid) => pid,
        Err(err) => {
            // `int(...)` raises: the runner does not start
            tracing::error!(target: "kanban.runner", "KANBAN_PARENT_PID is not a number: {err}");
            return 1;
        }
    };
    let stop = Arc::new(Event::default());
    let on_signal = {
        let stop = stop.clone();
        tokio::spawn(async move {
            stop_signal().await;
            stop.set();
        })
    };
    serve(&board_url, &token, parent_pid, Some(stop)).await;
    on_signal.abort();
    0
}

/// SIGTERM or SIGINT (Ctrl-C).
async fn stop_signal() {
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

/// `socket.gethostname()` (`GET /ai/runner` names the computer the CLIs run on).
pub fn host_name() -> String {
    sysinfo::System::host_name().unwrap_or_default()
}
