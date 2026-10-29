"""Ticket branches, backed by real git when a repo is linked."""

import services.tickets as svc_tickets
from pydantic import Field
from typing import Annotated
from ..common import BranchRef, BranchStatus, TicketId, _edit_ticket, notify_on_success


@notify_on_success
async def add_branch(
    ticket_id: TicketId,
    name: Annotated[
        str, Field(description="Branch name, e.g. 'feat/IAM-12-login-fix'.")
    ],
    branch_from: Annotated[
        str, Field(description="Base branch, e.g. 'main'.")
    ] = "main",
    status: BranchStatus = "open",
    pr_url: Annotated[
        str | None, Field(description="Pull request URL, if any.")
    ] = None,
    commit_hash: Annotated[
        str | None,
        Field(
            description="Latest commit. Ignored when a git repo is linked (the real value is read from git)."
        ),
    ] = None,
    linked_ticket_id: Annotated[
        str | None, Field(description="Another ticket's ID this branch also serves.")
    ] = None,
    ahead_count: Annotated[
        int,
        Field(
            ge=0,
            description="Commits ahead of the base. Ignored when a git repo is linked.",
        ),
    ] = 0,
    behind_count: Annotated[
        int,
        Field(
            ge=0,
            description="Commits behind the base. Ignored when a git repo is linked.",
        ),
    ] = 0,
    create_worktree: Annotated[
        bool,
        Field(
            description="Also create a git worktree for the branch (needs a linked repo)."
        ),
    ] = False,
    worktree_path: Annotated[
        str | None,
        Field(
            description="Worktree location or template; implies create_worktree. Default comes from the project's worktree_template."
        ),
    ] = None,
) -> dict:
    """Attach a branch to a ticket. If the project/ticket has a linked git repo (project `repo_path`, see update_project),
    this CREATES the real git branch from `branch_from` and takes commit/ahead/behind from git; otherwise it only
    records the branch on the board. Returns the updated ticket."""
    return await _edit_ticket(
        ticket_id,
        lambda s: svc_tickets.add_branch(
            s,
            ticket_id,
            name=name,
            branch_from=branch_from,
            status=status,
            pr_url=pr_url,
            commit_hash=commit_hash,
            linked_ticket_id=linked_ticket_id,
            ahead_count=ahead_count,
            behind_count=behind_count,
            create_worktree=create_worktree,
            worktree_path=worktree_path,
        ),
    )


@notify_on_success
async def update_branch(
    ticket_id: TicketId,
    branch_id: BranchRef,
    name: Annotated[
        str | None,
        Field(
            description="New name (renames the git branch too when a repo is linked)."
        ),
    ] = None,
    status: Annotated[
        BranchStatus | None,
        Field(
            description="With a linked repo, 'merged' is refused while the branch still has commits not in its base."
        ),
    ] = None,
    branch_from: Annotated[str | None, Field(description="Base branch name.")] = None,
    pr_url: Annotated[str | None, Field(description="Pull request URL.")] = None,
    commit_hash: Annotated[str | None, Field(description="Latest commit hash.")] = None,
    linked_ticket_id: Annotated[
        str | None, Field(description="Another ticket's ID this branch also serves.")
    ] = None,
    ahead_count: Annotated[
        int | None, Field(ge=0, description="Commits ahead of the base.")
    ] = None,
    behind_count: Annotated[
        int | None, Field(ge=0, description="Commits behind the base.")
    ] = None,
) -> dict:
    """Update a ticket's branch record (and rename the real git branch when a repo is linked). Omitted fields are
    unchanged. Returns the updated ticket."""
    return await _edit_ticket(
        ticket_id,
        lambda s, bid: svc_tickets.update_branch(
            s,
            ticket_id,
            bid,
            name=name,
            status=status,
            branch_from=branch_from,
            pr_url=pr_url,
            commit_hash=commit_hash,
            linked_ticket_id=linked_ticket_id,
            ahead_count=ahead_count,
            behind_count=behind_count,
        ),
        ("branch", branch_id),
    )


@notify_on_success
async def delete_branch(
    ticket_id: TicketId,
    branch_id: BranchRef,
    remove_worktree: Annotated[
        bool,
        Field(description="Also remove the branch's git worktree (linked repo only)."),
    ] = False,
    delete_git_branch: Annotated[
        bool,
        Field(
            description="Also delete the real git branch (linked repo only). Refused if it has unmerged commits unless force=true."
        ),
    ] = False,
    force: Annotated[
        bool,
        Field(
            description="Allow deleting a git branch that is not fully merged. DESTROYS unmerged commits."
        ),
    ] = False,
) -> dict:
    """Remove a branch from the ticket. By default only the board record is removed and git is left alone; the flags also
    clean up git. Returns the updated ticket."""
    return await _edit_ticket(
        ticket_id,
        lambda s, bid: svc_tickets.delete_branch(
            s,
            ticket_id,
            bid,
            remove_worktree=remove_worktree,
            delete_git_branch=delete_git_branch,
            force=force,
        ),
        ("branch", branch_id),
    )


@notify_on_success
async def checkout_branch(ticket_id: TicketId, branch_id: BranchRef) -> dict:
    """Run `git checkout` of this branch in the linked repository's main working tree (it fails if uncommitted changes
    conflict). Needs a repo linked to the project (update_project) or ticket (update_ticket repo_path).
    Returns the updated ticket."""
    return await _edit_ticket(
        ticket_id,
        lambda s, bid: svc_tickets.checkout_branch(s, ticket_id, bid),
        ("branch", branch_id),
    )
