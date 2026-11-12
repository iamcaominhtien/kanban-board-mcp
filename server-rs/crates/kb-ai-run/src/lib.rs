//! Running the AI team: the Claude Code CLI and its stream, accounts and sign-in, resources, launching, teams,
//! runs, schedules and the runner process (`services/ai/{cli,stream,accounts,signin,resources,launch,teams,runs,
//! repo_scan,schedules,compact,messaging,session_history,touches,health}.py`, `runner/`). Built on `kb-ai`,
//! `kb-ai-know` and `kb-ai-work`.
//!
//! Ported so far: part 1, `cli` (finding and starting the CLI, stopping process trees), `stream` (its stream-json as
//! step rows), `resources` (the RAM and CPU monitor), `accounts` (one login per account) and `signin` (the sign-in
//! terminal); part 2a, `teams` (AI teams: making, editing, pausing, removing, checking and describing them) and
//! `launch` (what a run's CLI is started with); part 2b, `runs` (queueing, starting, reading and ending the runs of the
//! teams), `messaging` (a note to a ticket's team or a page's assistant) and `runner` (the process that owns the CLIs
//! with `KANBAN_RUNNER=process`). `seams` lists what waits for the modules of part 3 and the assistant.

pub mod accounts;
pub mod cli;
pub mod launch;
pub mod messaging;
pub mod resources;
pub mod runner;
pub mod runs;
pub mod seams;
pub mod signin;
pub mod stream;
pub mod teams;

/// Fill the slots of lower crates that this crate's modules back (once, at startup; a later call replaces the
/// earlier one, except the hooks of the board and of the canvases, which keep the first):
///
/// - `kb_ai::seams::RunsRuntime`, whose `looks_like_cli` is `cli::looks_like_cli` and whose other calls are `runs.RT`
///   (`seams::RunProcs`, filled here with `seams::RunsSeam`);
/// - `kb_ai_know::seams::Cli` (`cli.find_cli`, `cli.child_env`, `cli.kill_tree`, `accounts.env_for`: the light model
///   of the knowledge base);
/// - `kb_board::hooks::AiTeamsHook` (`teams.check_name`: a person cannot take the name of a team);
/// - `seams::Runs` of `teams` (`runs.cancel`, `runs.RT.wake.set()`);
/// - `kb_ai::seams::TicketRuns` (`runs.before_ticket_change`, `note_person_edit`, `wake_new_assignee`; its
///   `on_status` is `kb_ai_work::worktrees::on_status`, called directly, so the order in which this crate and
///   `kb_ai_work` register does not matter: see `seams::TicketSeam`);
/// - `kb_ai_work::seams::Runs` (`runs.deliver_to_ticket` for the GitHub watcher);
/// - `kb_draw::hooks::CanvasDelivery` (`messaging.deliver_to_ticket`, `messaging.deliver_to_page`);
/// - `resources::MON.set_on_breach` (`resources.MON.on_breach = _memory_breach`; Python sets no `on_child_breach`).
pub fn register() {
    use std::sync::Arc;
    kb_ai::seams::set_runs_runtime(Some(Arc::new(seams::Runtime)));
    kb_ai_know::seams::set_cli(Some(Arc::new(seams::KnowCli)));
    kb_board::hooks::set_ai_teams_hook(Box::new(seams::TeamNames));
    seams::set_run_procs(Some(Arc::new(seams::RunsSeam)));
    seams::set_runs(Some(Arc::new(seams::RunsSeam)));
    kb_ai::seams::set_ticket_runs(Some(Arc::new(seams::TicketSeam)));
    kb_ai_work::seams::set_runs(Some(Arc::new(seams::WorkRuns)));
    kb_draw::hooks::set_canvas_delivery(Box::new(seams::CanvasNotes));
    resources::MON.set_on_breach(Some(Arc::new(|run_id: String, rss_mb: f64, limit_mb: i64| {
        Box::pin(async move { runs::memory_breach(&run_id, rss_mb, limit_mb).await })
    })));
}
