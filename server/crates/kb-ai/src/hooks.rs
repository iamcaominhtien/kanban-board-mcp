//! The hooks other crates declare for the AI team, as far as the parts of this crate back them.
//!
//! `register()` fills two of them:
//!
//! - `kb_docs::hooks::AiGuardHook`: `in_run` (`guard.current() is not None`), complete.
//! - `kb_board::hooks::AiRunsHook`: `in_run` is answered from the guard now. `before_ticket_change`, `note_person_edit`,
//!   `wake_new_assignee` (they wait for `runs`) and `on_status` (waits for `worktrees`) go through
//!   `seams::TicketRuns`, which those modules fill; until then they do nothing, which is what an unset board hook does.
//!
//! Not registered: `kb_board::hooks::AiTeamsHook::check_name` (waits for `teams`: it reads the team rows and the AI
//! members' names with `teams` rules, so an answer without it would let a name through that Python refuses), and
//! the AI-guard hook `kb_mcp::hooks::AiGuardHook`, which has its own `RunContext` type: the app adapts it with
//! `guard::resolve_for` / `guard::guarded_for`, which take the `Authorization` header the MCP layer holds.

use async_trait::async_trait;
use kb_base::ApiResult;
use kb_board::hooks::{AiRunsHook, NewAssignee};

use crate::{guard, seams};

/// `guard.current() is not None`.
pub fn in_run() -> bool {
    guard::current().is_some()
}

struct DocsGuard;

impl kb_docs::hooks::AiGuardHook for DocsGuard {
    fn in_run(&self) -> bool {
        in_run()
    }
}

struct BoardRuns;

#[async_trait]
impl AiRunsHook for BoardRuns {
    async fn before_ticket_change(
        &self,
        ticket_id: &str,
        status: Option<&str>,
        assignee: NewAssignee<'_>,
        deleting: bool,
        by: &str,
    ) -> ApiResult<()> {
        match seams::ticket_runs() {
            Some(runs) => runs.before_ticket_change(ticket_id, status, assignee, deleting, by).await,
            None => Ok(()),
        }
    }

    async fn note_person_edit(&self, ticket_id: &str, by: &str, what: &str, tell_lead: bool) -> ApiResult<()> {
        match seams::ticket_runs() {
            Some(runs) => runs.note_person_edit(ticket_id, by, what, tell_lead).await,
            None => Ok(()),
        }
    }

    async fn wake_new_assignee(&self, ticket_id: &str, assignee_id: &str, by: &str) -> ApiResult<()> {
        match seams::ticket_runs() {
            Some(runs) => runs.wake_new_assignee(ticket_id, assignee_id, by).await,
            None => Ok(()),
        }
    }

    fn in_run(&self) -> bool {
        in_run()
    }

    fn on_status(&self, ticket_id: &str, status: &str, previous: &str, by_ai: bool) {
        if let Some(runs) = seams::ticket_runs() {
            runs.on_status(ticket_id, status, previous, by_ai);
        }
    }
}

/// Register the hooks this crate can back (once, at startup; a second call is ignored).
pub fn register() {
    kb_docs::hooks::set_ai_guard_hook(Box::new(DocsGuard));
    kb_board::hooks::set_ai_runs_hook(Box::new(BoardRuns));
}
