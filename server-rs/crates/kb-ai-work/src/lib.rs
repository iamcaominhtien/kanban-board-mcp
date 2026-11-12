//! Where the AI team works and what it leaves: project environments, git worktrees and pull requests, the
//! timeline, the flow and the activity of runs (`services/ai/{project_env,worktrees,github,timeline,flow,activity}.py`).
//! Built on `kb-ai`.
//!
//! - `project_env`: the PATH and the setup commands of a project.
//! - `worktrees`: one git worktree per ticket and the hand-over of its code (`git`, `gh`).
//! - `github`: the watcher of the pull requests the board opened (`start`, `stop`, the poll round).
//! - `timeline`, `flow`, `activity`: the read-only views built from the rows of runs.
//! - `seams`: the calls into `runs`, which a later task fills.
//!
//! The app calls `register()` once at startup and `github::start()` / `github::stop().await` in its lifespan (see
//! the report of the task for their place in `server/main.py`'s order).

use std::sync::Arc;

use async_trait::async_trait;
use kb_ai::seams::TicketRuns;
use kb_board::hooks::NewAssignee;

pub mod activity;
pub mod flow;
pub mod github;
pub mod project_env;
pub mod proc;
pub mod seams;
pub mod timeline;
pub mod worktrees;

/// The `kb-ai` ticket seam as this crate fills it: `on_status` is `worktrees.on_status`; the other three calls wait for
/// `runs` and go to whatever was registered before (nothing: they do nothing, as an unset board hook does).
struct WorkTicketRuns {
    previous: Option<Arc<dyn TicketRuns>>,
}

#[async_trait]
impl TicketRuns for WorkTicketRuns {
    async fn before_ticket_change(
        &self,
        ticket_id: &str,
        status: Option<&str>,
        assignee: NewAssignee<'_>,
        deleting: bool,
        by: &str,
    ) -> kb_base::ApiResult<()> {
        match &self.previous {
            Some(p) => p.before_ticket_change(ticket_id, status, assignee, deleting, by).await,
            None => Ok(()),
        }
    }

    async fn note_person_edit(&self, ticket_id: &str, by: &str, what: &str, tell_lead: bool) -> kb_base::ApiResult<()> {
        match &self.previous {
            Some(p) => p.note_person_edit(ticket_id, by, what, tell_lead).await,
            None => Ok(()),
        }
    }

    async fn wake_new_assignee(&self, ticket_id: &str, assignee_id: &str, by: &str) -> kb_base::ApiResult<()> {
        match &self.previous {
            Some(p) => p.wake_new_assignee(ticket_id, assignee_id, by).await,
            None => Ok(()),
        }
    }

    fn on_status(&self, ticket_id: &str, status: &str, previous: &str, by_ai: bool) {
        worktrees::on_status(ticket_id, status, previous, by_ai);
    }
}

/// Fill the `kb-ai` seam this crate backs: `TicketRuns::on_status` is `worktrees.on_status`. The other calls of that
/// seam stay with what was registered before (`kb-ai-run` fills them; its `on_status` must call
/// `worktrees::on_status` when it replaces this object).
pub fn register() {
    let previous = kb_ai::seams::ticket_runs();
    kb_ai::seams::set_ticket_runs(Some(Arc::new(WorkTicketRuns { previous })));
}
