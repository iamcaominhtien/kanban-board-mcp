"""The ticket branch tool."""

from .routing import Op, dispatch, params_of
from pydantic import Field
from typing import Annotated, Literal
from .. import operations as ops
from ..common import BranchStatus, TicketId


BranchRef = Annotated[
    str | None,
    Field(
        description="Existing branch: id (UUID) or branch name, from the ticket's `branches` list."
    ),
]

BranchAction = Literal["add", "update", "delete", "checkout"]

BRANCH_OPS = {
    "add": Op(
        ops.add_branch,
        ("ticket_id", "name"),
        (
            "branch_from",
            "status",
            "pr_url",
            "commit_hash",
            "linked_ticket_id",
            "ahead_count",
            "behind_count",
            "create_worktree",
            "worktree_path",
        ),
    ),
    "update": Op(
        ops.update_branch,
        ("ticket_id", "branch"),
        (
            "name",
            "status",
            "branch_from",
            "pr_url",
            "commit_hash",
            "linked_ticket_id",
            "ahead_count",
            "behind_count",
        ),
        rename={"branch": "branch_id"},
    ),
    "delete": Op(
        ops.delete_branch,
        ("ticket_id", "branch"),
        ("remove_worktree", "delete_git_branch", "force"),
        rename={"branch": "branch_id"},
    ),
    "checkout": Op(
        ops.checkout_branch, ("ticket_id", "branch"), rename={"branch": "branch_id"}
    ),
}


async def ticket_branches(
    ticket_id: TicketId,
    action: Annotated[
        BranchAction, Field(description="What to do; see the tool description.")
    ],
    branch: BranchRef = None,
    name: Annotated[
        str | None,
        Field(
            description="add: branch name, e.g. 'feat/IAM-12-login-fix'. update: the new name (renames the git branch too when a repo is linked)."
        ),
    ] = None,
    branch_from: Annotated[
        str | None, Field(description="Base branch name (default 'main').")
    ] = None,
    status: Annotated[
        BranchStatus | None,
        Field(
            description="Default 'open'. With a linked repo, 'merged' is refused while the branch still has commits not in its base."
        ),
    ] = None,
    pr_url: Annotated[str | None, Field(description="Pull request URL.")] = None,
    commit_hash: Annotated[
        str | None,
        Field(
            description="Latest commit. Ignored when a git repo is linked (read from git)."
        ),
    ] = None,
    linked_ticket_id: Annotated[
        str | None, Field(description="Another ticket's ID this branch also serves.")
    ] = None,
    ahead_count: Annotated[
        int | None,
        Field(
            ge=0,
            description="Commits ahead of the base. Ignored when a git repo is linked.",
        ),
    ] = None,
    behind_count: Annotated[
        int | None,
        Field(
            ge=0,
            description="Commits behind the base. Ignored when a git repo is linked.",
        ),
    ] = None,
    create_worktree: Annotated[
        bool | None,
        Field(
            description="add: also create a git worktree for the branch (needs a linked repo)."
        ),
    ] = None,
    worktree_path: Annotated[
        str | None,
        Field(
            description="add: worktree location or template; implies create_worktree. Default: the project's worktree_template."
        ),
    ] = None,
    remove_worktree: Annotated[
        bool | None,
        Field(
            description="delete: also remove the branch's git worktree (linked repo only)."
        ),
    ] = None,
    delete_git_branch: Annotated[
        bool | None,
        Field(
            description="delete: also delete the real git branch (linked repo only). Refused if it has unmerged commits unless force=true."
        ),
    ] = None,
    force: Annotated[
        bool | None,
        Field(
            description="delete: allow deleting a git branch that is not fully merged. DESTROYS unmerged commits."
        ),
    ] = None,
) -> dict:
    """Branches of a ticket. If the project (update via manage_project's repo_path) or the ticket has a linked git repo, the
    real git branch is created / renamed / deleted and commit, ahead and behind come from git; otherwise only the board
    record changes. Returns the updated ticket (without its activity log). `action`:
    - add: ticket_id, name [, branch_from, status, pr_url, commit_hash, linked_ticket_id, ahead_count, behind_count, create_worktree, worktree_path]. Creates the git branch from branch_from.
    - update: ticket_id, branch [, name, status, branch_from, pr_url, commit_hash, linked_ticket_id, ahead_count, behind_count]. Omitted fields are unchanged.
    - delete: ticket_id, branch [, remove_worktree, delete_git_branch, force]. By default only the board record is removed and git is left alone.
    - checkout: ticket_id, branch. Runs `git checkout` in the linked repository's main working tree (fails if uncommitted changes conflict)."""
    return await dispatch("ticket_branches", BRANCH_OPS, action, params_of(locals()))
