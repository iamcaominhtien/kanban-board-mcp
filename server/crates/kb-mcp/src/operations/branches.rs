//! Ticket branches, backed by real git when a repo is linked.

use kb_board::tickets::{self as svc_tickets, BranchChanges, NewBranch};

use crate::common::{ToolError, ToolResult, edit_ticket, notify_on_success};

/// Attach a branch to a ticket. If the project/ticket has a linked git repo (project `repo_path`, see
/// update_project), this CREATES the real git branch from `branch_from` and takes commit/ahead/behind from git (with
/// `adopt`, a branch that already exists is recorded as it is, not created); otherwise it only records the branch on
/// the board. Returns the updated ticket.
#[allow(clippy::too_many_arguments)]
pub async fn add_branch(
    ticket_id: &str,
    name: &str,
    branch_from: &str,
    status: &str,
    pr_url: Option<&str>,
    commit_hash: Option<&str>,
    linked_ticket_id: Option<&str>,
    ahead_count: i64,
    behind_count: i64,
    create_worktree: bool,
    worktree_path: Option<&str>,
    adopt: bool,
) -> ToolResult {
    notify_on_success(edit_ticket(ticket_id, None, |s, _| async move {
        let new = NewBranch {
            branch_from,
            status,
            pr_url,
            commit_hash,
            linked_ticket_id,
            ahead_count,
            behind_count,
            create_worktree,
            worktree_path,
            adopt,
            ..NewBranch::new(name)
        };
        svc_tickets::add_branch(&s, ticket_id, new).await.map_err(ToolError::from)
    }))
    .await
}

/// Update a ticket's branch record (and rename the real git branch when a repo is linked). Omitted fields are
/// unchanged. Returns the updated ticket.
#[allow(clippy::too_many_arguments)]
pub async fn update_branch(
    ticket_id: &str,
    branch_id: &str,
    name: Option<&str>,
    status: Option<&str>,
    branch_from: Option<&str>,
    pr_url: Option<&str>,
    commit_hash: Option<&str>,
    linked_ticket_id: Option<&str>,
    ahead_count: Option<i64>,
    behind_count: Option<i64>,
) -> ToolResult {
    notify_on_success(edit_ticket(ticket_id, Some(("branch", branch_id)), |s, bid| async move {
        let changes = BranchChanges {
            name,
            status,
            branch_from,
            pr_url,
            commit_hash,
            linked_ticket_id,
            ahead_count,
            behind_count,
            ..BranchChanges::default()
        };
        svc_tickets::update_branch(&s, ticket_id, &bid.unwrap_or_default(), changes).await.map_err(ToolError::from)
    }))
    .await
}

/// Remove a branch from the ticket. By default only the board record is removed and git is left alone; the flags
/// also clean up git. Returns the updated ticket.
pub async fn delete_branch(
    ticket_id: &str,
    branch_id: &str,
    remove_worktree: bool,
    delete_git_branch: bool,
    force: bool,
) -> ToolResult {
    notify_on_success(edit_ticket(ticket_id, Some(("branch", branch_id)), |s, bid| async move {
        svc_tickets::delete_branch(&s, ticket_id, &bid.unwrap_or_default(), remove_worktree, delete_git_branch, force)
            .await
            .map_err(ToolError::from)
    }))
    .await
}

/// Run `git checkout` of this branch in the linked repository's main working tree (it fails if uncommitted changes
/// conflict). Needs a repo linked to the project (update_project) or ticket (update_ticket repo_path).
/// Returns the updated ticket.
pub async fn checkout_branch(ticket_id: &str, branch_id: &str) -> ToolResult {
    notify_on_success(edit_ticket(ticket_id, Some(("branch", branch_id)), |s, bid| async move {
        svc_tickets::checkout_branch(&s, ticket_id, &bid.unwrap_or_default()).await.map_err(ToolError::from)
    }))
    .await
}
