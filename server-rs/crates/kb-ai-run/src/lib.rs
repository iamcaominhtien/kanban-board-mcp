//! Running the AI team: the Claude Code CLI and its stream, accounts and sign-in, resources, launching, teams,
//! runs, schedules and the runner process (`services/ai/{cli,stream,accounts,signin,resources,launch,teams,runs,
//! repo_scan,schedules,compact,messaging,session_history,touches,health}.py`, `runner/`). Built on `kb-ai`,
//! `kb-ai-know` and `kb-ai-work`.
//!
//! Ported so far (part 1): `cli` (finding and starting the CLI, stopping process trees), `stream` (its stream-json as
//! step rows), `resources` (the RAM and CPU monitor), `accounts` (one login per account) and `signin` (the sign-in
//! terminal). `seams` lists what waits for the modules of part 2.

pub mod accounts;
pub mod cli;
pub mod resources;
pub mod seams;
pub mod signin;
pub mod stream;

/// Fill the slots of lower crates that this crate's modules back (once, at startup; a later call replaces the
/// earlier one): `kb_ai::seams::RunsRuntime`, whose `looks_like_cli` is `cli::looks_like_cli` and whose other calls
/// wait for `runs` (`seams::set_run_procs`).
pub fn register() {
    kb_ai::seams::set_runs_runtime(Some(std::sync::Arc::new(seams::Runtime)));
}
