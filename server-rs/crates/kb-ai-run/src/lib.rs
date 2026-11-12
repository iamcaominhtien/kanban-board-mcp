//! Running the AI team: the Claude Code CLI and its stream, accounts and sign-in, resources, launching, teams,
//! runs, schedules and the runner process (`services/ai/{cli,stream,accounts,signin,resources,launch,teams,runs,
//! repo_scan,schedules,compact,messaging,session_history,touches,health}.py`, `runner/`). Built on `kb-ai`,
//! `kb-ai-know` and `kb-ai-work`.
//!
//! Ported so far: part 1, `cli` (finding and starting the CLI, stopping process trees), `stream` (its stream-json as
//! step rows), `resources` (the RAM and CPU monitor), `accounts` (one login per account) and `signin` (the sign-in
//! terminal); part 2a, `teams` (AI teams: making, editing, pausing, removing, checking and describing them) and
//! `launch` (what a run's CLI is started with). `seams` lists what waits for the modules of parts 2b and 3.

pub mod accounts;
pub mod cli;
pub mod launch;
pub mod resources;
pub mod seams;
pub mod signin;
pub mod stream;
pub mod teams;

/// Fill the slots of lower crates that this crate's modules back (once, at startup; a later call replaces the
/// earlier one, except the board's hook, which keeps the first):
///
/// - `kb_ai::seams::RunsRuntime`, whose `looks_like_cli` is `cli::looks_like_cli` and whose other calls wait for
///   `runs` (`seams::set_run_procs`);
/// - `kb_ai_know::seams::Cli` (`cli.find_cli`, `cli.child_env`, `cli.kill_tree`, `accounts.env_for`: the light model
///   of the knowledge base);
/// - `kb_board::hooks::AiTeamsHook` (`teams.check_name`: a person cannot take the name of a team).
pub fn register() {
    kb_ai::seams::set_runs_runtime(Some(std::sync::Arc::new(seams::Runtime)));
    kb_ai_know::seams::set_cli(Some(std::sync::Arc::new(seams::KnowCli)));
    kb_board::hooks::set_ai_teams_hook(Box::new(seams::TeamNames));
}
