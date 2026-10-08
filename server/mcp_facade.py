"""The Kanban MCP tool list: 9 tools, each one a family of related operations picked with `action`.

The operations themselves are the functions in `mcp_tools` (one per verb, unchanged behaviour). A tool here only
routes `action` (and `item` for ticket sub-items) to one of them, after checking that exactly the parameters that
operation understands were passed. A wrong call fails with a message that lists what the operation accepts, the same
"fix-it" style as the rest of the server.

Why so few tools: an agent pays for every tool description and schema on every session. Grouping by noun keeps all the
capabilities while the tool list shrinks to a fraction of its size.
"""

from collections.abc import Callable
from dataclasses import dataclass, field
from functools import cache
from typing import Annotated, Any, Literal

from mcp.types import ToolAnnotations
from pydantic import Field, ValidationError, validate_call

import mcp_tools as ops
from mcp_tools import (
    BranchStatus,
    Priority,
    RelationType,
    Status,
    TestCaseStatus,
    TicketId,
    TicketType,
    WorkLogKind,
    WorkLogRole,
)
from models import MemberRead

# ---------------------------------------------------------------------------
# Routing
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class Op:
    """One operation behind a tool: the function, the parameters it needs and may take, and renames
    (tool parameter -> function parameter) where a shared name is clearer for the agent."""

    impl: Callable
    required: tuple[str, ...] = ()
    optional: tuple[str, ...] = ()
    rename: dict[str, str] = field(default_factory=dict)

    def usage(self) -> str:
        """What the operation takes, for error messages."""
        need = ", ".join(self.required) or "nothing else"
        take = f"; optional: {', '.join(self.optional)}" if self.optional else ""
        return f"requires {need}{take}"


@cache
def _validated(impl: Callable) -> Callable:
    """The operation with its parameter constraints (enums, ranges, lengths) enforced, as FastMCP would do for it."""
    return validate_call(impl)


def _short(exc: ValidationError) -> str:
    return "; ".join(
        f"{'.'.join(str(p) for p in e['loc'])}: {e['msg']}" for e in exc.errors()
    )


async def _route(label: str, op: Op, given: dict[str, Any]) -> Any:
    passed = {k: v for k, v in given.items() if v is not None}
    missing = [p for p in op.required if p not in passed]
    if missing:
        raise ValueError(f"{label} {op.usage()}. Missing: {', '.join(missing)}.")
    allowed = set(op.required) | set(op.optional)
    extra = [p for p in passed if p not in allowed]
    if extra:
        raise ValueError(f"{label} does not use: {', '.join(extra)}. It {op.usage()}.")
    kwargs = {op.rename.get(k, k): v for k, v in passed.items()}
    try:
        return await _validated(op.impl)(**kwargs)
    except ValidationError as exc:
        raise ValueError(f"{label}: {_short(exc)}") from exc


async def _dispatch(
    tool: str, table: dict[str, Op], action: str, given: dict[str, Any]
) -> Any:
    return await _route(f"{tool}(action='{action}')", table[action], given)


def _locals(values: dict[str, Any]) -> dict[str, Any]:
    values = dict(values)
    for key in ("action", "item"):
        values.pop(key, None)
    return values


# ---------------------------------------------------------------------------
# Shared parameter descriptions
# ---------------------------------------------------------------------------

PageId = Annotated[
    str | None, Field(description="Docs page id (UUID) from docs_read(action='list').")
]
ItemId = Annotated[
    str | None,
    Field(
        description="Id of the existing sub-item: comment / work log entry / criterion / sub-task id (UUID) or test case "
        "id or code 'TC-2', all listed in get_ticket."
    ),
]
BranchRef = Annotated[
    str | None,
    Field(
        description="Existing branch: id (UUID) or branch name, from the ticket's `branches` list."
    ),
]

# ---------------------------------------------------------------------------
# get_projects (read)
# ---------------------------------------------------------------------------


async def get_projects(
    project_id: Annotated[
        str | None,
        Field(
            description="Omit to list every project. A project UUID returns that project with its members."
        ),
    ] = None,
) -> list[dict] | dict:
    """Start here: list the projects (boards). Most other tools need a project's `id` (a UUID). Each project has a
    `prefix` that starts its ticket IDs (prefix 'IAM' -> 'IAM-1', 'IAM-2') and may have a linked git `repo_path`
    (needed by real git branches). With `project_id` you get that project plus `members` [{id, name, color}]; use a
    member `id` as a ticket `assignee`."""
    projects = await ops.list_projects()
    if project_id is None:
        return projects
    for project in projects:
        if project["id"] == project_id:
            async with ops.async_session() as session:
                members = await ops.svc_members.list_members(session, project_id)
            return project | {
                "members": [MemberRead.model_validate(m).model_dump() for m in members]
            }
    shown = ", ".join(f"{p['prefix']}={p['id']}" for p in projects[:20]) or "none"
    raise ValueError(
        f"Project '{project_id}' not found. Pass a project UUID (not the prefix). Existing: {shown}."
    )


# ---------------------------------------------------------------------------
# manage_project
# ---------------------------------------------------------------------------

ProjectAction = Literal["create", "update", "add_member", "remove_member"]

_PROJECT_OPS = {
    "create": Op(ops.create_project, ("name", "prefix"), ("color",)),
    "update": Op(
        ops.update_project,
        ("project_id",),
        ("name", "color", "repo_path", "worktree_template", "worktree_by_default"),
    ),
    "add_member": Op(ops.add_member, ("project_id", "name"), ("color",)),
    "remove_member": Op(ops.remove_member, ("project_id", "member_id")),
}


async def manage_project(
    action: Annotated[
        ProjectAction, Field(description="What to do; see the tool description.")
    ],
    project_id: Annotated[
        str | None,
        Field(
            description="Project UUID from get_projects (update, add_member, remove_member)."
        ),
    ] = None,
    name: Annotated[
        str | None,
        Field(description="Project name (create, update) or member name (add_member)."),
    ] = None,
    prefix: Annotated[
        str | None,
        Field(
            description="create: ticket-ID prefix, uppercase letters/digits, at most 6 chars, unique (e.g. 'MYAPP'); lower case is upper-cased."
        ),
    ] = None,
    color: Annotated[
        str | None,
        Field(
            description="Hex color such as '#6366f1': the project accent, or a member's avatar (auto-picked when omitted)."
        ),
    ] = None,
    repo_path: Annotated[
        str | None,
        Field(
            description="update: absolute path of a local git repository to link (needed before ticket_branches can create real git branches). '' unlinks it."
        ),
    ] = None,
    worktree_template: Annotated[
        str | None,
        Field(
            description="update: default path template for git worktrees, e.g. '../worktrees/{project}/{ticket_id}-{branch}'."
        ),
    ] = None,
    worktree_by_default: Annotated[
        bool | None,
        Field(description="update: create a worktree by default for new branches."),
    ] = None,
    member_id: Annotated[
        str | None,
        Field(
            description="remove_member: member id (UUID) from get_projects(project_id)."
        ),
    ] = None,
) -> dict:
    """Create or change a project and its members. `action`:
    - create: name, prefix [, color]. A member 'Admin' is created with it. Returns the project (`id` is a UUID).
    - update: project_id [, name, color, repo_path, worktree_template, worktree_by_default]. Only the fields you pass change. Returns the project.
    - add_member: project_id, name [, color]. Returns the member; its `id` is what tickets use as `assignee`.
    - remove_member: project_id, member_id. Refused (with the reason) while the member has open assigned tickets (reassign them first) or created tickets; closed tickets are unassigned. Returns {"ok": true}."""
    return await _dispatch("manage_project", _PROJECT_OPS, action, _locals(locals()))


# ---------------------------------------------------------------------------
# manage_ticket
# ---------------------------------------------------------------------------

TicketAction = Literal[
    "create",
    "update",
    "delete",
    "workspace",
    "block",
    "unblock",
    "link",
    "unlink",
    "link_doc",
    "unlink_doc",
]

_TICKET_FIELDS = (
    "title",
    "description",
    "type",
    "priority",
    "status",
    "estimate",
    "due_date",
    "start_date",
    "parent_id",
    "tags",
    "assignee",
)

_TICKET_OPS = {
    "create": Op(
        ops.create_ticket,
        ("project_id", "title"),
        tuple(f for f in _TICKET_FIELDS if f != "title"),
    ),
    "update": Op(
        ops.update_ticket,
        ("ticket_id",),
        _TICKET_FIELDS
        + (
            "repo_path",
            "wont_do_reason",
            "block_done_if_acs_incomplete",
            "block_done_if_tcs_incomplete",
            "clear_fields",
        ),
    ),
    "delete": Op(ops.delete_ticket, ("ticket_id",)),
    "workspace": Op(ops.get_ticket_workspace_path, ("ticket_id",)),
    "block": Op(
        ops.block_ticket,
        ("ticket_id", "target_id"),
        rename={"ticket_id": "blocked_id", "target_id": "blocker_id"},
    ),
    "unblock": Op(
        ops.unblock_ticket,
        ("ticket_id", "target_id"),
        rename={"ticket_id": "blocked_id", "target_id": "blocker_id"},
    ),
    "link": Op(ops.link_tickets, ("ticket_id", "target_id", "relation_type")),
    "unlink": Op(ops.unlink_tickets, ("ticket_id", "link_id")),
    "link_doc": Op(ops.link_ticket_doc, ("ticket_id", "page_id")),
    "unlink_doc": Op(ops.unlink_ticket_doc, ("ticket_id", "page_id")),
}


async def manage_ticket(
    action: Annotated[
        TicketAction, Field(description="What to do; see the tool description.")
    ],
    project_id: Annotated[
        str | None, Field(description="create: project UUID from get_projects.")
    ] = None,
    ticket_id: Annotated[
        str | None,
        Field(
            description="Ticket ID such as 'IAM-12' (not a UUID). Every action except create."
        ),
    ] = None,
    title: Annotated[
        str | None, Field(description="Short title (max 300 chars).")
    ] = None,
    description: Annotated[
        str | None,
        Field(
            description="Markdown: context, steps to reproduce, scope. On update it REPLACES the whole text: read it with get_ticket first if you only want to append."
        ),
    ] = None,
    type: Annotated[
        TicketType | None, Field(description="Kind of work (default 'task').")
    ] = None,
    priority: Annotated[Priority | None, Field(description="Default 'medium'.")] = None,
    status: Annotated[
        Status | None,
        Field(
            description="create: starting column (default 'backlog', not 'wont_do'). update: the move; 'done' is refused while the ticket's Done-requires guards are not met."
        ),
    ] = None,
    estimate: Annotated[
        float | None, Field(description="Story points, 0-100000.")
    ] = None,
    due_date: Annotated[str | None, Field(description="ISO date 'YYYY-MM-DD'.")] = None,
    start_date: Annotated[
        str | None,
        Field(description="ISO date 'YYYY-MM-DD'; must not be after due_date."),
    ] = None,
    parent_id: Annotated[
        str | None,
        Field(
            description="Make this a sub-ticket of this ticket ID (same project, one level deep: the parent must not itself be a child)."
        ),
    ] = None,
    tags: Annotated[
        list[str] | None,
        Field(
            description="Free-form labels (max 30, each up to 50 chars). On update it REPLACES the whole list."
        ),
    ] = None,
    assignee: Annotated[
        str | None,
        Field(
            description="Member id (UUID) of a member of the ticket's project; see get_projects(project_id)."
        ),
    ] = None,
    repo_path: Annotated[
        str | None,
        Field(
            description="update: absolute path of a git repo to use for THIS ticket's branches instead of the project's."
        ),
    ] = None,
    wont_do_reason: Annotated[
        str | None,
        Field(
            description="update: why it will not be done; required together with status='wont_do'."
        ),
    ] = None,
    block_done_if_acs_incomplete: Annotated[
        bool | None,
        Field(
            description="update: true refuses status 'done' until every acceptance criterion is checked."
        ),
    ] = None,
    block_done_if_tcs_incomplete: Annotated[
        bool | None,
        Field(
            description="update: true refuses status 'done' until there is a test case and all pass."
        ),
    ] = None,
    clear_fields: Annotated[
        list[
            Literal[
                "estimate",
                "due_date",
                "start_date",
                "parent_id",
                "assignee",
                "repo_path",
                "wont_do_reason",
            ]
        ]
        | None,
        Field(
            description="update: fields to EMPTY (e.g. unassign). Needed because omitting a field means 'leave unchanged'."
        ),
    ] = None,
    target_id: Annotated[
        str | None,
        Field(
            description="The other ticket's ID (same project): block/unblock: the ticket that must be finished first; link: the ticket to relate to."
        ),
    ] = None,
    relation_type: Annotated[
        RelationType | None,
        Field(
            description="link: how `ticket_id` relates to `target_id`; the inverse is added on the target automatically."
        ),
    ] = None,
    link_id: Annotated[
        str | None,
        Field(
            description="unlink: link id returned by `link` or listed in the `links` of get_ticket. A link has a different id on each of its two tickets: pass it with the ticket it belongs to."
        ),
    ] = None,
    page_id: Annotated[
        str | None,
        Field(
            description="link_doc / unlink_doc: Docs page id (UUID) from docs_read(action='list')."
        ),
    ] = None,
) -> dict:
    """Create, change, relate or delete a ticket (a ticket's checklists, comments, work log and branches have their own
    tools). `action`:
    - create: project_id, title [, description, type, priority, status, parent_id, estimate, due_date, start_date, tags, assignee]. The ID comes from the project prefix ('IAM-5'). With parent_id it is a sub-ticket. Returns the ticket.
    - update: ticket_id plus any fields to change; omitted fields are untouched, so a plain status move is just (ticket_id, status). To empty a nullable field name it in clear_fields. 'wont_do' needs wont_do_reason and is not allowed for sub-tickets. Also takes repo_path, block_done_if_acs_incomplete, block_done_if_tcs_incomplete. Returns the ticket.
    - delete: ticket_id. PERMANENT. Sub-tickets are detached and kept; block/link references to it are removed; its workspace folder is deleted. To retire a ticket but keep its history use update with status='wont_do'.
    - workspace: ticket_id. Gets (and creates if missing) the ticket's local scratch folder: {enabled, path, exists}. Read and write files there with your own file tools (logs, repro scripts, drafts); nothing goes through MCP. If `enabled` is false, do not use it.
    - block / unblock: ticket_id, target_id. ticket_id cannot proceed until target_id is done (it shows a lock on the board); same project, no circular chains, statuses do not change. Returns {blocker, blocked}.
    - link: ticket_id, target_id, relation_type. A non-blocking relation (use block for dependencies). Returns {id, target_id, relation_type}; keep `id` for unlink.
    - unlink: ticket_id, link_id. Removes the relation and its inverse. Returns {"removed": link_id}.
    - link_doc / unlink_doc: ticket_id, page_id. Manually link a Docs page to the ticket ('Linked docs')."""
    return await _dispatch("manage_ticket", _TICKET_OPS, action, _locals(locals()))


# ---------------------------------------------------------------------------
# ticket_items: comments, work log, acceptance criteria, sub-tasks, test cases
# ---------------------------------------------------------------------------

ItemKind = Literal["comment", "work_log", "criterion", "sub_task", "test_case"]
ItemAction = Literal["add", "update", "delete", "toggle", "restore"]

_TEST_CASE_FIELDS = (
    "status",
    "description",
    "expected_result",
    "notes",
    "proof",
    "assignee",
)

_ITEM_OPS: dict[tuple[str, str], Op] = {
    ("comment", "add"): Op(ops.add_comment, ("ticket_id", "text", "author")),
    ("comment", "update"): Op(
        ops.update_comment,
        ("ticket_id", "item_id", "text"),
        rename={"item_id": "comment_id"},
    ),
    ("comment", "delete"): Op(
        ops.delete_comment, ("ticket_id", "item_id"), rename={"item_id": "comment_id"}
    ),
    ("comment", "restore"): Op(
        ops.restore_comment, ("ticket_id", "item_id"), rename={"item_id": "comment_id"}
    ),
    ("work_log", "add"): Op(
        ops.add_work_log,
        ("ticket_id", "author", "role", "note"),
        ("log_kind", "pinned", "linked_branch", "linked_test_case"),
        rename={"log_kind": "kind"},
    ),
    ("work_log", "update"): Op(
        ops.update_work_log,
        ("ticket_id", "item_id"),
        ("note", "log_kind", "pinned", "linked_branch", "linked_test_case"),
        rename={"item_id": "log_id", "log_kind": "kind"},
    ),
    ("work_log", "delete"): Op(
        ops.delete_work_log, ("ticket_id", "item_id"), rename={"item_id": "log_id"}
    ),
    ("criterion", "add"): Op(
        ops.add_acceptance_criterion,
        ("ticket_id", "text"),
        rename={"text": "description"},
    ),
    ("criterion", "toggle"): Op(
        ops.toggle_acceptance_criterion,
        ("ticket_id", "item_id"),
        rename={"item_id": "criterion_id"},
    ),
    ("criterion", "delete"): Op(
        ops.delete_acceptance_criterion,
        ("ticket_id", "item_id"),
        rename={"item_id": "criterion_id"},
    ),
    ("sub_task", "add"): Op(ops.add_sub_task, ("ticket_id", "text")),
    ("sub_task", "toggle"): Op(
        ops.toggle_sub_task, ("ticket_id", "item_id"), rename={"item_id": "sub_task_id"}
    ),
    ("sub_task", "delete"): Op(
        ops.delete_sub_task, ("ticket_id", "item_id"), rename={"item_id": "sub_task_id"}
    ),
    ("test_case", "add"): Op(
        ops.add_test_case, ("ticket_id", "title"), _TEST_CASE_FIELDS
    ),
    ("test_case", "update"): Op(
        ops.update_test_case,
        ("ticket_id", "item_id"),
        ("title",) + _TEST_CASE_FIELDS,
        rename={"item_id": "test_case_id"},
    ),
    ("test_case", "delete"): Op(
        ops.delete_test_case,
        ("ticket_id", "item_id"),
        rename={"item_id": "test_case_id"},
    ),
}


def _item_op(item: str, action: str) -> Op:
    op = _ITEM_OPS.get((item, action))
    if op is None:
        valid = ", ".join(a for (i, a) in _ITEM_OPS if i == item)
        raise ValueError(
            f"ticket_items: a {item} cannot be '{action}'. Valid actions for {item}: {valid}."
        )
    return op


async def ticket_items(
    ticket_id: TicketId,
    item: Annotated[
        ItemKind, Field(description="Which list of the ticket to work on.")
    ],
    action: Annotated[
        ItemAction,
        Field(
            description="add, update, delete, toggle (criterion, sub_task) or restore (comment)."
        ),
    ],
    item_id: ItemId = None,
    text: Annotated[
        str | None,
        Field(
            description="comment: Markdown, max 50,000 chars. criterion: one checkable condition, max 1,000 chars (e.g. 'Login fails with a clear message on a wrong password'). sub_task: one small step, max 500 chars."
        ),
    ] = None,
    author: Annotated[
        str | None,
        Field(
            description="comment, work_log (add): who wrote it; use your agent name (e.g. 'Claude')."
        ),
    ] = None,
    role: Annotated[
        WorkLogRole | None,
        Field(description="work_log add: the author's role on this work."),
    ] = None,
    note: Annotated[
        str | None,
        Field(
            description="work_log: Markdown, max 20,000 chars. On update it replaces the old note."
        ),
    ] = None,
    log_kind: Annotated[
        WorkLogKind | None,
        Field(
            description="work_log: investigation (default; what you looked at), fix_attempt (something you tried), root_cause (the cause you found), blocked (stuck; shows a red dot), resolved (the problem is fixed)."
        ),
    ] = None,
    pinned: Annotated[
        bool | None,
        Field(description="work_log: keep this entry at the top of the list."),
    ] = None,
    linked_branch: Annotated[
        str | None,
        Field(
            description="work_log: NAME of an existing branch of this ticket; on update '' removes the link."
        ),
    ] = None,
    linked_test_case: Annotated[
        str | None,
        Field(
            description="work_log: code ('TC-2') or id of an existing test case; on update '' removes the link."
        ),
    ] = None,
    title: Annotated[
        str | None,
        Field(description="test_case: what is being verified (max 300 chars)."),
    ] = None,
    status: Annotated[
        TestCaseStatus | None,
        Field(
            description="test_case: pending (default, not run), running (starts its timer), pass or fail. Set pass/fail after running it."
        ),
    ] = None,
    description: Annotated[
        str | None, Field(description="test_case: Markdown steps / setup.")
    ] = None,
    expected_result: Annotated[
        str | None, Field(description="test_case: Markdown, what should happen.")
    ] = None,
    notes: Annotated[
        str | None, Field(description="test_case: Markdown observations.")
    ] = None,
    proof: Annotated[
        str | None,
        Field(
            description="test_case: evidence such as a log excerpt, URL or file path."
        ),
    ] = None,
    assignee: Annotated[
        str | None,
        Field(
            description="test_case: member id (UUID) who runs it; see get_projects(project_id)."
        ),
    ] = None,
) -> dict:
    """Work on the lists inside a ticket. Pick `item`, then `action`; each combination takes only the parameters shown.
    Returns the updated ticket (without its activity log); new sub-item ids are in its lists.
    - comment: add (text, author): progress reports, findings, questions for the humans | update (item_id, text) | delete (item_id; hidden everywhere) | restore (item_id; brings a deleted one back).
    - work_log, the ticket's debug journal (Debug Space tab): keep a running record of what you investigated, tried and found so humans and later sessions can follow. add (author, role, note [, log_kind, pinned, linked_branch, linked_test_case]) | update (item_id [, note, log_kind, pinned, linked_branch, linked_test_case]; to record a fix add a new 'resolved' entry rather than editing an old one) | delete (item_id, permanent).
    - criterion, acceptance criteria (the ticket's definition of done): add (text) | toggle (item_id; flips done/not done, see `acceptance_criteria[].done` in the result) | delete (item_id).
    - sub_task, small checklist steps inside the ticket (not tickets; for real child tickets use manage_ticket with parent_id): add (text) | toggle (item_id) | delete (item_id).
    - test_case: add (title [, status, description, expected_result, notes, proof, assignee]) gets a code 'TC-<n>' | update (item_id [, same fields + title]; typically status and proof after running it) | delete (item_id). With the ticket's 'Done requires: all test cases passed' guard on, it cannot move to 'done' until every test case is 'pass'."""
    given = _locals(locals())
    op = _item_op(item, action)
    return await _route(f"ticket_items(item='{item}', action='{action}')", op, given)


# ---------------------------------------------------------------------------
# ticket_branches
# ---------------------------------------------------------------------------

BranchAction = Literal["add", "update", "delete", "checkout"]

_BRANCH_OPS = {
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
    return await _dispatch("ticket_branches", _BRANCH_OPS, action, _locals(locals()))


# ---------------------------------------------------------------------------
# docs_read / docs_write
# ---------------------------------------------------------------------------

DocsReadAction = Literal[
    "list", "get", "search", "versions", "version", "recycle_bin", "check_links"
]

_DOCS_READ_OPS = {
    "list": Op(ops.list_docs_pages, ("project_id",)),
    "get": Op(ops.get_docs_page, ("page_id",)),
    "search": Op(ops.search_docs, ("project_id", "query"), ("scope", "limit")),
    "versions": Op(ops.list_docs_versions, ("page_id",)),
    "version": Op(ops.get_docs_version, ("page_id", "version"), ("compare_to",)),
    "recycle_bin": Op(ops.list_docs_recycle_bin, ("project_id",)),
    "check_links": Op(ops.resolve_docs_links, ("project_id", "refs")),
}


async def docs_read(
    action: Annotated[
        DocsReadAction, Field(description="What to read; see the tool description.")
    ],
    project_id: Annotated[
        str | None,
        Field(
            description="Project UUID from get_projects (list, search, recycle_bin, check_links)."
        ),
    ] = None,
    page_id: PageId = None,
    query: Annotated[
        str | None,
        Field(
            description='search: words are AND-ed; "a b" is a phrase; -word excludes; a ticket key finds pages that mention it.'
        ),
    ] = None,
    scope: Annotated[
        Literal["space", "all", "tickets"] | None,
        Field(
            description="search: this project's docs (default), docs of all projects, or tickets only."
        ),
    ] = None,
    limit: Annotated[
        int | None, Field(description="search: max results (default 10).")
    ] = None,
    version: Annotated[
        int | None,
        Field(description="version: version number from the `versions` action."),
    ] = None,
    compare_to: Annotated[
        int | None,
        Field(
            description="version: another version number; returns a line diff `version` -> `compare_to` instead."
        ),
    ] = None,
    refs: Annotated[
        list[str] | None,
        Field(
            description="check_links: references to check: '[[Page]]', '[[Page#Section]]' or a ticket key like 'IAM-12'."
        ),
    ] = None,
) -> dict | list[dict]:
    """Read a project's Docs: a tree of Markdown pages. `action`:
    - list: project_id. The flat page tree [{id, parent_id, position, title, slug, status, version}].
    - get: page_id. {title, markdown (latest published), version, headings, referenced_by}. Pass its `version` to docs_write(update) as base_version.
    - search: project_id, query [, scope, limit]. Full-text search over titles, headings and bodies with snippets: {total, pages, tickets}.
    - versions: page_id. Published versions, newest first: [{version, author, note, created_at, words}].
    - version: page_id, version [, compare_to]. One old version's markdown, or a line diff between two versions.
    - recycle_bin: project_id. Deleted pages still restorable (30 days): [{id, title, page_count, deleted_at, deleted_by, days_left}].
    - check_links: project_id, refs. Whether [[page]] / ticket references resolve: ok, missing, section_missing, in_bin or ambiguous."""
    return await _dispatch("docs_read", _DOCS_READ_OPS, action, _locals(locals()))


DocsWriteAction = Literal[
    "create",
    "update",
    "move",
    "duplicate",
    "delete",
    "restore",
    "restore_version",
    "import",
]

_DOCS_WRITE_OPS = {
    "create": Op(
        ops.create_docs_page, ("project_id", "title"), ("markdown", "parent_id")
    ),
    "update": Op(
        ops.update_docs_page,
        ("page_id", "markdown", "base_version"),
        ("note", "publish", "title"),
    ),
    "move": Op(ops.move_docs_page, ("page_id",), ("parent_id", "after_id")),
    "duplicate": Op(
        ops.duplicate_docs_page, ("page_id",), ("include_children", "title")
    ),
    "delete": Op(ops.delete_docs_page, ("page_id",)),
    "restore": Op(ops.restore_docs_page, ("page_id",)),
    "restore_version": Op(ops.restore_docs_version, ("page_id", "version")),
    "import": Op(ops.import_docs, ("project_id", "path"), ("parent_id",)),
}


async def docs_write(
    action: Annotated[
        DocsWriteAction, Field(description="What to do; see the tool description.")
    ],
    project_id: Annotated[
        str | None,
        Field(description="Project UUID from get_projects (create, import)."),
    ] = None,
    page_id: PageId = None,
    title: Annotated[
        str | None,
        Field(
            description="create: page title (body headings start at '##'). update: new title (renames the page; links to it are rewritten). duplicate: title of the copy (default '<title> (copy)')."
        ),
    ] = None,
    markdown: Annotated[
        str | None,
        Field(
            description="create: initial body. update: the FULL new Markdown body (not a patch)."
        ),
    ] = None,
    parent_id: Annotated[
        str | None,
        Field(
            description="create, import: parent page id (omit for the top level). move: new parent (omit for the top level)."
        ),
    ] = None,
    after_id: Annotated[
        str | None,
        Field(
            description="move: sibling page id to place it after (omit to append at the end)."
        ),
    ] = None,
    base_version: Annotated[
        int | None,
        Field(
            description="update: the `version` you read with docs_read(get); a stale value is rejected, so re-read and retry."
        ),
    ] = None,
    note: Annotated[
        str | None, Field(description="update: change note for the page history.")
    ] = None,
    publish: Annotated[
        bool | None,
        Field(
            description="update: publish a new version (default true). false only saves an agent draft nobody else sees."
        ),
    ] = None,
    include_children: Annotated[
        bool | None, Field(description="duplicate: also copy the sub-pages.")
    ] = None,
    version: Annotated[
        int | None,
        Field(
            description="restore_version: version number to publish again (from docs_read(versions))."
        ),
    ] = None,
    path: Annotated[
        str | None,
        Field(
            description="import: absolute path of a .md/.markdown file or a folder (folders become a page tree)."
        ),
    ] = None,
) -> dict:
    """Write a project's Docs. `action`:
    - create: project_id, title [, markdown, parent_id]. Published as v1. Returns {id, title, slug, status, version}.
    - update: page_id, markdown, base_version [, note, publish, title]. Replaces the whole body and optionally renames. Returns {id, title, version, published}.
    - move: page_id [, parent_id, after_id]. Under another page or to the top level; into itself or its own sub-pages is rejected.
    - duplicate: page_id [, include_children, title]. A new draft copy without history. Returns {id, title, slug, status}.
    - delete: page_id. Soft-delete of the page and its sub-pages into the Recycle Bin (kept 30 days).
    - restore: page_id. Brings a deleted page (with the sub-pages deleted with it) back.
    - restore_version: page_id, version. Publishes an old version again as a new one (history is kept). Returns {id, title, version}.
    - import: project_id, path [, parent_id]. Local Markdown files become new draft pages, folders a tree. Returns {created, failed}.
    Link pages with [[Title#Section]] and tickets by key (IAM-12) in the Markdown."""
    return await _dispatch("docs_write", _DOCS_WRITE_OPS, action, _locals(locals()))


# ---------------------------------------------------------------------------
# The tool list. Annotations are per tool, so a tool that can delete is marked destructive as a whole.
# ---------------------------------------------------------------------------

_READ = ToolAnnotations(readOnlyHint=True, openWorldHint=False)
_WRITE = ToolAnnotations(
    readOnlyHint=False, destructiveHint=False, idempotentHint=False, openWorldHint=False
)
_DESTRUCTIVE = ToolAnnotations(
    readOnlyHint=False, destructiveHint=True, idempotentHint=False, openWorldHint=False
)

CORE_TOOL_TABLE: list[tuple[Callable, ToolAnnotations]] = [
    (get_projects, _READ),
    (ops.list_tickets, _READ),
    (ops.get_ticket, _READ),
    (docs_read, _READ),
    (manage_project, _DESTRUCTIVE),  # remove_member
    (manage_ticket, _DESTRUCTIVE),  # delete, unlink
    (ticket_items, _DESTRUCTIVE),  # delete
    (ticket_branches, _DESTRUCTIVE),  # delete (optionally the git branch)
    (docs_write, _DESTRUCTIVE),  # delete
]
