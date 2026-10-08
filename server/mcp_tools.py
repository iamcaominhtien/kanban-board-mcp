"""Kanban MCP tools.

Conventions (kept in sync with the server `instructions` in main.py):
- Errors are raised (the client sees `isError: true` plus a message that says how to fix the call);
  tools never return `None` or `{"error": ...}` for a failure.
- Tools that change a ticket return the updated ticket *without* its activity log.
- Every changing tool is attributed to the AI agent in the Activity tab (`notify_on_success`).
"""

import json
import os
import re
from datetime import datetime, timezone
from functools import wraps
from typing import Annotated, Any, Awaitable, Callable, Literal

import events as board_events
from mcp.server.fastmcp import FastMCP
from mcp.types import ToolAnnotations
from pydantic import Field, ValidationError
from sqlalchemy.exc import NoResultFound

import services.docs as svc_docs
import services.idea_tickets as svc_idea_tickets
import services.members as svc_members
import services.projects as svc_projects
import services.activity as svc_activity
import services.tickets as svc_tickets
import services.workspace as svc_workspace
from database import async_session
from uploads import resolve_upload_path
from models import (
    IDEA_COLORS,
    IDEA_STATUSES,
    IdeaTicketRead,
    MemberRead,
    ProjectCreate,
    ProjectRead,
    ProjectUpdate,
    Ticket,
    TicketRead,
    TicketUpdate,
)

_UNSET = object()
_VALID_IDEA_STATUSES = frozenset(IDEA_STATUSES)
_VALID_IDEA_COLORS = frozenset(IDEA_COLORS)

# ---------------------------------------------------------------------------
# Shared parameter types (the descriptions are what the AI reads in the schema)
# ---------------------------------------------------------------------------

ProjectId = Annotated[
    str, Field(description="Project UUID from list_projects (not the prefix).")
]
TicketId = Annotated[str, Field(description="Ticket ID such as 'IAM-12' (not a UUID).")]
IdeaId = Annotated[str, Field(description="Idea ticket ID such as 'IDEA-3'.")]
CommentId = Annotated[
    str, Field(description="Comment id (UUID) from the ticket's `comments` list.")
]
CriterionId = Annotated[
    str,
    Field(
        description="Acceptance criterion id (UUID) from the ticket's `acceptance_criteria` list."
    ),
]
SubTaskId = Annotated[
    str, Field(description="Sub-task id (UUID) from the ticket's `sub_tasks` list.")
]
WorkLogId = Annotated[
    str,
    Field(description="Work log entry id (UUID) from the ticket's `work_log` list."),
]
TestCaseRef = Annotated[
    str,
    Field(
        description="Test case id (UUID) or its code such as 'TC-2' (from the ticket's `test_cases` list)."
    ),
]
BranchRef = Annotated[
    str,
    Field(
        description="Branch id (UUID) or branch name (from the ticket's `branches` list)."
    ),
]
MemberId = Annotated[str, Field(description="Member id (UUID) from list_members.")]

TicketType = Literal["bug", "feature", "task", "chore"]
Priority = Literal["low", "medium", "high", "critical"]
Status = Literal[
    "backlog", "todo", "in-progress", "review", "testing", "done", "wont_do"
]
WorkLogKind = Literal[
    "investigation", "fix_attempt", "root_cause", "blocked", "resolved"
]
WorkLogRole = Literal["PM", "Developer", "BA", "Tester", "Designer", "Other"]
TestCaseStatus = Literal["pending", "running", "pass", "fail"]
BranchStatus = Literal["baseline", "open", "merged", "stale", "archived"]
RelationType = Literal[
    "relates_to", "causes", "caused_by", "duplicates", "duplicated_by"
]
IdeaStatus = Literal["draft", "in_review", "approved", "dropped"]
IdeaColor = Literal["yellow", "orange", "lime", "pink", "blue", "purple", "teal"]
IdeaEnergy = Literal["seed", "concept", "hot", "big_bet"]
AssumptionStatus = Literal["untested", "validated", "invalidated"]

# ---------------------------------------------------------------------------
# Output shaping and errors
# ---------------------------------------------------------------------------

_CAMEL = re.compile(r"(?<=[a-z0-9])([A-Z])")


def _snake(key: str) -> str:
    return _CAMEL.sub(lambda m: "_" + m.group(1).lower(), key)


def _drop_camel_twins(items: list) -> list:
    """Stored sub-items carry both snake_case and camelCase copies of each key (for the web UI).
    The AI only needs one of them."""
    out = []
    for item in items:
        if isinstance(item, dict):
            item = {
                k: v
                for k, v in item.items()
                if not (k != _snake(k) and _snake(k) in item)
            }
        out.append(item)
    return out


_SUB_ITEM_FIELDS = ("branches", "test_cases", "work_log", "comments", "links")


def _ticket_to_dict(ticket: Ticket, *, include_activity: bool = False) -> dict:
    """Serialize a ticket. The activity log is ~80% of a typical ticket's size, so it is opt-in."""
    data = TicketRead.from_ticket(ticket).model_dump()
    if not include_activity:
        data.pop("activity_log", None)
    for field in _SUB_ITEM_FIELDS:
        if isinstance(data.get(field), list):
            data[field] = _drop_camel_twins(data[field])
    return data


def _idea_ticket_to_dict(ticket) -> dict:
    """Serialize an idea ticket (its activity trail has its own tool: get_idea_activity_trail)."""
    data = IdeaTicketRead.from_idea_ticket(ticket).model_dump()
    data.pop("activity_trail", None)
    return data


def _loads(value: Any) -> list:
    if isinstance(value, list):
        return value
    try:
        parsed = json.loads(value) if value else []
    except (TypeError, ValueError):
        return []
    return parsed if isinstance(parsed, list) else []


def _ticket_summary(ticket: Ticket) -> dict:
    """The few fields needed to triage a list of tickets."""
    acs = _loads(ticket.acceptance_criteria)
    tcs = _loads(ticket.test_cases)
    return {
        "id": ticket.id,
        "title": ticket.title,
        "type": ticket.type,
        "status": ticket.status,
        "priority": ticket.priority,
        "assignee": ticket.assignee,
        "parent_id": ticket.parent_id,
        "tags": _loads(ticket.tags),
        "estimate": ticket.estimate,
        "start_date": ticket.start_date,
        "due_date": ticket.due_date,
        "blocked_by": _loads(ticket.blocked_by),
        "acceptance_criteria": {
            "done": sum(1 for a in acs if a.get("done")),
            "total": len(acs),
        },
        "test_cases": {
            "passed": sum(1 for t in tcs if t.get("status") == "pass"),
            "total": len(tcs),
        },
        "comments": len(_loads(ticket.comments)),
        "branches": len(_loads(ticket.branches)),
        "updated_at": ticket.updated_at,
    }


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _missing_ticket(ticket_id: str) -> ValueError:
    return ValueError(
        f"Ticket '{ticket_id}' not found. Ticket IDs look like 'IAM-12' (project prefix + number); "
        "use list_tickets to see the IDs of a project."
    )


def _missing_idea(ticket_id: str) -> ValueError:
    return ValueError(
        f"Idea ticket '{ticket_id}' not found. Idea IDs look like 'IDEA-3'; use list_idea_tickets to see them."
    )


# For each sub-item list: the ticket column, a label for messages, and which keys may identify an item
_ITEM_KINDS: dict[str, tuple[str, str, tuple[str, ...]]] = {
    "comment": ("comments", "Comment", ("id",)),
    "criterion": ("acceptance_criteria", "Acceptance criterion", ("id",)),
    "sub_task": ("sub_tasks", "Sub-task", ("id",)),
    "work_log": ("work_log", "Work log entry", ("id",)),
    "test_case": ("test_cases", "Test case", ("id", "code")),
    "branch": ("branches", "Branch", ("id", "name")),
}


async def _resolve_item(session, ticket_id: str, kind: str, ref: str) -> str:
    """Check that `ref` names an existing sub-item of the ticket and return its real id.
    Lets the call fail with the list of valid ids instead of silently doing nothing."""
    column, label, keys = _ITEM_KINDS[kind]
    ticket = await svc_tickets.get_ticket(session, ticket_id)
    if ticket is None:
        raise _missing_ticket(ticket_id)
    items = _loads(getattr(ticket, column))
    for item in items:
        if any(item.get(k) == ref for k in keys):
            return item["id"]
    existing = [
        item.get(keys[-1]) if kind in ("test_case", "branch") else item.get("id")
        for item in items
    ]
    shown = ", ".join(str(e) for e in existing[:20]) or "none"
    raise ValueError(
        f"{label} '{ref}' not found on {ticket_id}. Existing: {shown}. "
        f"Call get_ticket('{ticket_id}') to see the ids."
    )


async def _edit_ticket(
    ticket_id: str,
    op: Callable[..., Awaitable[Ticket | None]],
    item: tuple[str, str] | None = None,
) -> dict:
    """Run a service call that returns the updated ticket and serialize it.
    `item=(kind, ref)` first verifies and resolves a sub-item reference; `op(session, item_id)` then gets its id."""
    try:
        async with async_session() as session:
            if item is not None:
                item_id = await _resolve_item(session, ticket_id, *item)
                ticket = await op(session, item_id)
            else:
                ticket = await op(session)
            if ticket is None:
                raise _missing_ticket(ticket_id)
            return _ticket_to_dict(ticket)
    except ValidationError as exc:
        raise ValueError(str(exc)) from exc


def notify_on_success(func):
    """Attribute the change to the AI agent and publish an SSE invalidation after a successful mutation."""

    @wraps(func)
    async def wrapper(*args, **kwargs):
        # Changes made through MCP tools are attributed to the AI agent
        token = svc_activity.set_actor(svc_activity.AGENT_ACTOR)
        try:
            result = await func(*args, **kwargs)
        finally:
            svc_activity.reset_actor(token)
        if result is not None:
            await board_events.publish(board_events.INVALIDATE)
        return result

    return wrapper


# ---------------------------------------------------------------------------
# Projects
# ---------------------------------------------------------------------------


async def list_projects() -> list[dict]:
    """List all projects (boards). Start here: most other tools need a project's `id` (a UUID).
    Each project has a `prefix` that starts its ticket IDs (prefix 'IAM' -> tickets 'IAM-1', 'IAM-2'),
    and may have a linked git `repo_path` (needed by the branch tools)."""
    async with async_session() as session:
        projects = await svc_projects.list_projects(session)
        return [ProjectRead.model_validate(p).model_dump() for p in projects]


@notify_on_success
async def create_project(
    name: Annotated[str, Field(description="Display name, e.g. 'My App'.")],
    prefix: Annotated[
        str,
        Field(
            description="Ticket-ID prefix: uppercase letters/digits, at most 6 chars, unique (e.g. 'MYAPP'). Lower-case input is upper-cased."
        ),
    ],
    color: Annotated[
        str, Field(description="Hex accent color, e.g. '#6366f1'.")
    ] = "#6366f1",
) -> dict:
    """Create a project (board). A member named 'Admin' is created with it. Returns the project with its `id` (UUID)."""
    async with async_session() as session:
        data = ProjectCreate(name=name, prefix=prefix.upper(), color=color)
        project = await svc_projects.create_project(session, data)
        return ProjectRead.model_validate(project).model_dump()


@notify_on_success
async def update_project(
    project_id: ProjectId,
    name: Annotated[str | None, Field(description="New display name.")] = None,
    color: Annotated[str | None, Field(description="New hex accent color.")] = None,
    repo_path: Annotated[
        str | None,
        Field(
            description="Absolute path of a local git repository to link to this project (required before add_branch can create real git branches). Empty string unlinks it."
        ),
    ] = None,
    worktree_template: Annotated[
        str | None,
        Field(
            description="Default path template for git worktrees, e.g. '../worktrees/{project}/{ticket_id}-{branch}'."
        ),
    ] = None,
    worktree_by_default: Annotated[
        bool | None, Field(description="Create a worktree by default for new branches.")
    ] = None,
) -> dict:
    """Change a project's name, color or git settings. Only the fields you pass change. Returns the project."""
    fields = {
        "name": name,
        "color": color,
        "repo_path": repo_path,
        "worktree_template": worktree_template,
        "worktree_by_default": worktree_by_default,
    }
    data = ProjectUpdate(**{k: v for k, v in fields.items() if v is not None})
    async with async_session() as session:
        project = await svc_projects.update_project(session, project_id, data)
        if project is None:
            raise ValueError(
                f"Project '{project_id}' not found. Use list_projects to see project ids."
            )
        return ProjectRead.model_validate(project).model_dump()


# ---------------------------------------------------------------------------
# Tickets
# ---------------------------------------------------------------------------


async def list_tickets(
    project_id: ProjectId,
    status: Annotated[
        Status | None, Field(description="Only tickets in this status.")
    ] = None,
    priority: Annotated[
        Priority | None, Field(description="Only tickets with this priority.")
    ] = None,
    q: Annotated[
        str | None,
        Field(
            description="Fuzzy text search over ticket id, title, description and tags."
        ),
    ] = None,
    include_wont_do: Annotated[
        bool,
        Field(
            description="Include tickets with status 'wont_do' (the board's recycle bin)."
        ),
    ] = True,
    detail: Annotated[
        bool,
        Field(
            description="Return full ticket objects instead of summaries. Large: prefer get_ticket for one ticket."
        ),
    ] = False,
    limit: Annotated[int, Field(ge=1, le=500, description="Page size.")] = 100,
    offset: Annotated[
        int,
        Field(
            ge=0,
            description="Number of tickets to skip (use the previous response's `offset + count`).",
        ),
    ] = 0,
) -> dict:
    """List a project's tickets as compact summaries (id, title, type, status, priority, assignee, parent_id, tags,
    estimate, dates, blocked_by, and counts of acceptance criteria / test cases / comments / branches).
    Call get_ticket for the description, comments, work log and the rest.
    Returns {total, count, offset, has_more, tickets}: when has_more is true, call again with offset=offset+count."""
    async with async_session() as session:
        tickets = await svc_tickets.list_tickets(
            session,
            project_id,
            status=status,
            priority=priority,
            q=q,
            include_wont_do=include_wont_do,
        )
    page = tickets[offset : offset + limit]
    convert = _ticket_to_dict if detail else _ticket_summary
    return {
        "total": len(tickets),
        "count": len(page),
        "offset": offset,
        "has_more": offset + len(page) < len(tickets),
        "tickets": [convert(t) for t in page],
    }


@notify_on_success
async def create_ticket(
    project_id: ProjectId,
    title: Annotated[str, Field(description="Short title (max 300 chars).")],
    type: Annotated[TicketType, Field(description="Kind of work.")] = "task",
    priority: Priority = "medium",
    status: Annotated[
        Literal["backlog", "todo", "in-progress", "review", "testing", "done"],
        Field(description="Starting column of the board."),
    ] = "backlog",
    description: Annotated[
        str,
        Field(description="Markdown description: context, steps to reproduce, scope."),
    ] = "",
    parent_id: Annotated[
        str | None,
        Field(
            description="Make this a sub-ticket of this ticket ID (same project; only one level deep). Same as create_child_ticket."
        ),
    ] = None,
    estimate: Annotated[
        float | None, Field(description="Story points, e.g. 1, 2, 3, 5, 8 (0-100000).")
    ] = None,
    due_date: Annotated[str | None, Field(description="ISO date 'YYYY-MM-DD'.")] = None,
    tags: Annotated[
        list[str] | None,
        Field(
            description="Free-form labels (max 30, each up to 50 chars; duplicates ignored)."
        ),
    ] = None,
    start_date: Annotated[
        str | None,
        Field(description="ISO date 'YYYY-MM-DD'; must not be after due_date."),
    ] = None,
    assignee: Annotated[
        str | None,
        Field(
            description="Member id (UUID) of the project member who owns it; see list_members."
        ),
    ] = None,
) -> dict:
    """Create a ticket. Its ID is generated from the project prefix (e.g. 'IAM-5'). Returns the created ticket."""
    try:
        async with async_session() as session:
            ticket = await svc_tickets.create_ticket(
                session,
                project_id=project_id,
                title=title,
                type=type,
                priority=priority,
                status=status,
                description=description,
                parent_id=parent_id,
                estimate=estimate,
                due_date=due_date,
                start_date=start_date,
                tags=tags or [],
                assignee=assignee,
            )
            return _ticket_to_dict(ticket)
    except NoResultFound:
        raise ValueError(
            f"Project not found: {project_id}. Use list_projects to see project ids."
        )


def _parse_since(value: str) -> datetime:
    try:
        moment = datetime.fromisoformat(value.strip().replace("Z", "+00:00"))
    except ValueError:
        raise ValueError(
            f"activity_since must be an ISO date or time such as '2026-10-05T08:00:00Z' (got '{value}')."
        ) from None
    return moment if moment.tzinfo else moment.replace(tzinfo=timezone.utc)


def _entry_time(entry: dict) -> datetime | None:
    try:
        moment = datetime.fromisoformat(str(entry.get("at", "")).replace("Z", "+00:00"))
    except ValueError:
        return None
    return moment if moment.tzinfo else moment.replace(tzinfo=timezone.utc)


DEFAULT_ACTIVITY_ENTRIES = 10
_ACTIVITY_TEXT_CLIP = 300


def _clip_activity(entries: list[dict]) -> list[dict]:
    """Description edits store the whole old and new text; for a quick look the start of each is enough."""
    out = []
    for entry in entries:
        entry = dict(entry)
        for key in ("from", "to"):
            value = entry.get(key)
            if isinstance(value, str) and len(value) > _ACTIVITY_TEXT_CLIP:
                entry[key] = (
                    value[:_ACTIVITY_TEXT_CLIP]
                    + f"… [{len(value) - _ACTIVITY_TEXT_CLIP} more chars]"
                )
        out.append(entry)
    return out


_UPLOAD_URL = re.compile(r"/uploads/[^\s)\"'\]<>\\|?#]{1,300}")


def _upload_files(data: dict) -> list[dict]:
    """Every /uploads/ file the ticket mentions (description, comments, work log, attachments) with its absolute path on disk."""
    out: list[dict] = []
    seen: set[str] = set()
    for url in _UPLOAD_URL.findall(json.dumps(data, default=str)):
        if url in seen:
            continue
        seen.add(url)
        resolved = resolve_upload_path(url[len("/uploads/") :])
        out.append(
            {
                "url": url,
                "path": str(resolved) if resolved else None,
                "exists": bool(resolved and resolved.is_file()),
            }
        )
    return out


async def get_ticket(
    ticket_id: TicketId,
    activity_limit: Annotated[
        int | None,
        Field(
            le=1000,
            description=f"How many of the most recent activity entries to return (oldest first). Default {DEFAULT_ACTIVITY_ENTRIES}, long texts shortened; 0 = none; a negative number (e.g. -1) = the WHOLE history, full texts (large).",
        ),
    ] = None,
    activity_since: Annotated[
        str | None,
        Field(
            description="Only activity entries after this ISO date/time, e.g. '2026-10-05T08:00:00Z' ('what changed since I last looked'). Combine with activity_limit to cap how many."
        ),
    ] = None,
) -> dict:
    """Get one ticket in full: Markdown description, acceptance criteria, test cases, comments, work log (debug notes),
    branches, relations (blocks / blocked_by / links) and `workspace_path` when the Workspace feature is on.
    `files`: uploaded images/files the ticket mentions, with absolute `path` on disk to read.
    Sub-item ids (comment, test case, branch, ...) used by the other tools come from here.
    `activity_log` holds the most recent changes (who changed what and when); `activity_total` is how many entries the
    ticket has in all, so you can tell when more exist (widen with activity_limit or narrow with activity_since)."""
    since = _parse_since(activity_since) if activity_since else None
    async with async_session() as session:
        ticket = await svc_tickets.get_ticket(session, ticket_id)
        if ticket is None:
            raise _missing_ticket(ticket_id)
        data = _ticket_to_dict(ticket, include_activity=True)
        files = _upload_files(data)
        if files:
            data["files"] = files
        info = await svc_workspace.get_workspace_path(session, ticket_id, create=False)
        if info is not None and info["enabled"]:
            data["workspace_path"] = info["path"]
    log = data.get("activity_log") or []
    data["activity_total"] = len(log)
    if since is not None:
        log = [e for e in log if (_entry_time(e) or since) > since]
    if activity_limit is not None and activity_limit < 0:
        data["activity_log"] = log  # everything (after `since`, if given), full texts
        return data
    limit = activity_limit
    if limit is None and since is None:
        limit = DEFAULT_ACTIVITY_ENTRIES
    if limit is not None:
        log = log[-limit:] if limit > 0 else []
    data["activity_log"] = _clip_activity(log)
    return data


async def get_ticket_workspace_path(ticket_id: TicketId) -> dict:
    """Get (and create if missing) the ticket's local scratch folder. Read and write files there directly with your own
    file tools: logs, repro scripts, screenshots, drafts. Nothing needs to go through MCP.
    Returns {enabled, path, exists}. If `enabled` is false the Workspace feature is turned off: do not use it."""
    async with async_session() as session:
        info = await svc_workspace.get_workspace_path(session, ticket_id, create=True)
        if info is None:
            raise _missing_ticket(ticket_id)
        return info


@notify_on_success
async def update_ticket_status(
    ticket_id: TicketId,
    status: Annotated[Status, Field(description="Target column.")],
    wont_do_reason: Annotated[
        str | None,
        Field(
            description="Why it will not be done. Required when status is 'wont_do'."
        ),
    ] = None,
) -> dict:
    """Move a ticket to another status; the usual way to start ('in-progress') or finish ('done') work.
    Moving to 'done' is refused when the ticket's "Done requires" guards are on and its acceptance criteria / test cases
    are not all passed (the error says which). 'wont_do' needs a reason and is not allowed for sub-tickets.
    Returns the updated ticket."""
    data: dict = {"status": status}
    if wont_do_reason is not None:
        data["wont_do_reason"] = wont_do_reason
    return await _edit_ticket(
        ticket_id,
        lambda s: svc_tickets.update_ticket(s, ticket_id, TicketUpdate(**data)),
    )


_CLEARABLE_FIELDS = frozenset(
    {
        "estimate",
        "due_date",
        "start_date",
        "parent_id",
        "assignee",
        "repo_path",
        "wont_do_reason",
    }
)


@notify_on_success
async def update_ticket(
    ticket_id: TicketId,
    title: Annotated[
        str | None, Field(description="New title (max 300 chars).")
    ] = None,
    description: Annotated[
        str | None,
        Field(
            description="New Markdown description. REPLACES the whole text: read it with get_ticket first if you only want to append."
        ),
    ] = None,
    type: TicketType | None = None,
    priority: Priority | None = None,
    status: Annotated[
        Status | None,
        Field(description="New status. Same rules as update_ticket_status."),
    ] = None,
    estimate: Annotated[
        float | None, Field(description="Story points (0-100000).")
    ] = None,
    due_date: Annotated[str | None, Field(description="ISO date 'YYYY-MM-DD'.")] = None,
    start_date: Annotated[
        str | None,
        Field(description="ISO date 'YYYY-MM-DD'; must not be after due_date."),
    ] = None,
    parent_id: Annotated[
        str | None,
        Field(
            description="Make this a sub-ticket of this ticket ID (same project, one level deep, the new parent must not itself be a child)."
        ),
    ] = None,
    tags: Annotated[
        list[str] | None, Field(description="REPLACES the whole tag list (max 30).")
    ] = None,
    assignee: Annotated[
        str | None,
        Field(
            description="Member id (UUID) from list_members; must belong to the ticket's project."
        ),
    ] = None,
    repo_path: Annotated[
        str | None,
        Field(
            description="Absolute path of a git repo to use for THIS ticket's branches instead of the project's."
        ),
    ] = None,
    wont_do_reason: Annotated[
        str | None, Field(description="Required together with status='wont_do'.")
    ] = None,
    block_done_if_acs_incomplete: Annotated[
        bool | None,
        Field(
            description="true: refuse status 'done' until every acceptance criterion is checked."
        ),
    ] = None,
    block_done_if_tcs_incomplete: Annotated[
        bool | None,
        Field(
            description="true: refuse status 'done' until there is at least one test case and all pass."
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
            description="Fields to EMPTY. Needed because passing null/omitting a field means 'leave unchanged'."
        ),
    ] = None,
) -> dict:
    """Change one or more fields of a ticket; omitted fields are untouched. Use update_ticket_status for plain status moves
    and the dedicated tools for comments, criteria, test cases, work log and branches. To empty a nullable field
    (e.g. unassign), name it in `clear_fields`. Returns the updated ticket."""
    fields = {
        "title": title,
        "description": description,
        "type": type,
        "priority": priority,
        "status": status,
        "estimate": estimate,
        "due_date": due_date,
        "start_date": start_date,
        "parent_id": parent_id,
        "tags": tags,
        "assignee": assignee,
        "repo_path": repo_path,
        "wont_do_reason": wont_do_reason,
        "block_done_if_acs_incomplete": block_done_if_acs_incomplete,
        "block_done_if_tcs_incomplete": block_done_if_tcs_incomplete,
    }
    update_data = {k: v for k, v in fields.items() if v is not None}
    for name in clear_fields or []:
        if name not in _CLEARABLE_FIELDS:
            raise ValueError(
                f"Cannot clear '{name}'. Clearable fields: {sorted(_CLEARABLE_FIELDS)}"
            )
        if name in update_data:
            raise ValueError(f"'{name}' was both set and listed in clear_fields")
        update_data[name] = None
    return await _edit_ticket(
        ticket_id,
        lambda s: svc_tickets.update_ticket(s, ticket_id, TicketUpdate(**update_data)),
    )


@notify_on_success
async def create_child_ticket(
    parent_ticket_id: Annotated[
        str,
        Field(
            description="ID of the parent ticket, e.g. 'IAM-12'. It must not itself be a child."
        ),
    ],
    title: Annotated[str, Field(description="Short title (max 300 chars).")],
    type: TicketType = "task",
    priority: Priority = "medium",
    description: Annotated[str, Field(description="Markdown description.")] = "",
) -> dict:
    """Create a sub-ticket under an existing ticket, in the same project (starts in 'backlog'). Only one level of
    nesting is allowed. Returns the new ticket."""
    async with async_session() as session:
        parent = await svc_tickets.get_ticket(session, parent_ticket_id)
        if parent is None:
            raise _missing_ticket(parent_ticket_id)
        ticket = await svc_tickets.create_ticket(
            session,
            project_id=parent.project_id,
            parent_id=parent_ticket_id,
            title=title,
            type=type,
            priority=priority,
            description=description,
        )
        return _ticket_to_dict(ticket)


@notify_on_success
async def delete_ticket(ticket_id: TicketId) -> dict:
    """PERMANENTLY delete a ticket (cannot be undone). Its sub-tickets are detached (kept), block/link references on other
    tickets are removed, and its workspace folder is deleted. To retire a ticket but keep its history use
    update_ticket_status(status='wont_do', wont_do_reason=...) instead. Returns {"deleted": ticket_id}."""
    async with async_session() as session:
        found = await svc_tickets.delete_ticket(session, ticket_id)
    if not found:
        raise _missing_ticket(ticket_id)
    return {"deleted": ticket_id}


# ---------------------------------------------------------------------------
# Relations between tickets
# ---------------------------------------------------------------------------


@notify_on_success
async def block_ticket(
    blocker_id: Annotated[
        str, Field(description="Ticket ID that must be finished first, e.g. 'IAM-3'.")
    ],
    blocked_id: Annotated[
        str, Field(description="Ticket ID that has to wait, e.g. 'IAM-4'.")
    ],
) -> dict:
    """Record that `blocker_id` blocks `blocked_id` ('IAM-4 cannot proceed until IAM-3 is done'); the blocked ticket shows
    a lock on the board. Both tickets must be in the same project; circular chains are refused. Statuses do not change.
    Returns {blocker, blocked} (both updated tickets)."""
    async with async_session() as session:
        result = await svc_tickets.link_block(session, blocker_id, blocked_id)
        if result is None:
            raise ValueError(
                f"Ticket '{blocker_id}' or '{blocked_id}' not found. Use list_tickets to see ticket IDs."
            )
        blocker, blocked = result
        return {
            "blocker": _ticket_to_dict(blocker),
            "blocked": _ticket_to_dict(blocked),
        }


@notify_on_success
async def unblock_ticket(
    blocker_id: Annotated[str, Field(description="Ticket ID that was blocking.")],
    blocked_id: Annotated[str, Field(description="Ticket ID that was blocked.")],
) -> dict:
    """Remove a block created by block_ticket (e.g. because the dependency no longer applies). Returns {blocker, blocked}."""
    async with async_session() as session:
        result = await svc_tickets.unlink_block(session, blocker_id, blocked_id)
        if result is None:
            raise ValueError(
                f"Ticket '{blocker_id}' or '{blocked_id}' not found. Use list_tickets to see ticket IDs."
            )
        blocker, blocked = result
        return {
            "blocker": _ticket_to_dict(blocker),
            "blocked": _ticket_to_dict(blocked),
        }


@notify_on_success
async def link_tickets(
    ticket_id: TicketId,
    target_id: Annotated[
        str, Field(description="The other ticket's ID (same project).")
    ],
    relation_type: Annotated[
        RelationType,
        Field(
            description="How `ticket_id` relates to `target_id`: relates_to, causes, caused_by, duplicates, duplicated_by. The inverse is added on the target automatically."
        ),
    ],
) -> dict:
    """Create a non-blocking relation between two tickets (use block_ticket for dependencies).
    Returns {id, target_id, relation_type}; keep `id` if you may need unlink_tickets later."""
    async with async_session() as session:
        return await svc_tickets.add_ticket_link(
            session, ticket_id, target_id, relation_type
        )


@notify_on_success
async def unlink_tickets(
    ticket_id: Annotated[
        str,
        Field(
            description="The SAME ticket you passed as `ticket_id` to link_tickets (a link has a different id on each of the two tickets)."
        ),
    ],
    link_id: Annotated[
        str,
        Field(
            description="Link id returned by link_tickets, or from that ticket's `links` list in get_ticket."
        ),
    ],
) -> dict:
    """Remove a relation made by link_tickets (and its inverse on the other ticket). Returns {"removed": link_id}."""
    async with async_session() as session:
        ticket = await svc_tickets.get_ticket(session, ticket_id)
        if ticket is None:
            raise _missing_ticket(ticket_id)
        removed = await svc_tickets.remove_ticket_link(session, ticket_id, link_id)
    if not removed:
        raise ValueError(
            f"Link '{link_id}' not found on {ticket_id}. A link has a different id on each of its two tickets: use the "
            f"ticket you gave to link_tickets, or read the ids from get_ticket('{ticket_id}').links."
        )
    return {"removed": link_id}


# ---------------------------------------------------------------------------
# Comments
# ---------------------------------------------------------------------------


@notify_on_success
async def add_comment(
    ticket_id: TicketId,
    text: Annotated[
        str,
        Field(
            description="Markdown (headings, lists, tables, code blocks, links, images). Max 50,000 chars."
        ),
    ],
    author: Annotated[
        str,
        Field(
            description="Name shown next to the comment: use your agent name (e.g. 'Claude')."
        ),
    ],
) -> dict:
    """Post a comment on a ticket: progress reports, findings, questions for the humans. Returns the updated ticket
    (the new comment is last in `comments`)."""
    return await _edit_ticket(
        ticket_id,
        lambda s: svc_tickets.add_comment(s, ticket_id, text=text, author=author),
    )


@notify_on_success
async def update_comment(
    ticket_id: TicketId,
    comment_id: CommentId,
    text: Annotated[
        str, Field(description="New Markdown text; replaces the old text.")
    ],
) -> dict:
    """Edit the text of an existing comment. Returns the updated ticket."""
    return await _edit_ticket(
        ticket_id,
        lambda s, cid: svc_tickets.update_comment(s, ticket_id, cid, text),
        ("comment", comment_id),
    )


@notify_on_success
async def delete_comment(ticket_id: TicketId, comment_id: CommentId) -> dict:
    """Delete a comment (hidden everywhere; `restore_comment` brings it back). Returns the updated ticket."""
    return await _edit_ticket(
        ticket_id,
        lambda s, cid: svc_tickets.delete_comment(s, ticket_id, cid),
        ("comment", comment_id),
    )


@notify_on_success
async def restore_comment(ticket_id: TicketId, comment_id: CommentId) -> dict:
    """Undo `delete_comment`: put a deleted comment back in the thread. Returns the updated ticket."""
    return await _edit_ticket(
        ticket_id, lambda s: svc_tickets.restore_comment(s, ticket_id, comment_id)
    )


async def list_comments(ticket_id: TicketId) -> dict:
    """Read a ticket's comment thread, oldest first: id, author, text (Markdown), time, `edited_at` and who was
    notified. Cheaper than `get_ticket` when you only need the discussion."""
    async with async_session() as session:
        ticket = await svc_tickets.get_ticket(session, ticket_id)
        if ticket is None:
            raise _missing_ticket(ticket_id)
        rows = json.loads(ticket.comments or "[]")
    comments = [
        {
            "id": c.get("id"),
            "author": c.get("author"),
            "text": c.get("text"),
            "at": c.get("at"),
            "edited_at": c.get("edited_at"),
            "notified": [n.get("name") for n in c.get("notified") or []],
        }
        for c in rows
        if isinstance(c, dict) and not c.get("deleted_at")
    ]
    return {"ticket_id": ticket_id, "count": len(comments), "comments": comments}


# ---------------------------------------------------------------------------
# Work log (the "Debug Space" tab)
# ---------------------------------------------------------------------------


@notify_on_success
async def add_work_log(
    ticket_id: TicketId,
    author: Annotated[str, Field(description="Who wrote it: use your agent name.")],
    role: Annotated[WorkLogRole, Field(description="The author's role on this work.")],
    note: Annotated[str, Field(description="Markdown, max 20,000 chars.")],
    kind: Annotated[
        WorkLogKind,
        Field(
            description="investigation: what you looked at; fix_attempt: something you tried; root_cause: the cause you found; blocked: stuck (shows a red dot on the ticket until a later 'resolved' entry); resolved: fixed."
        ),
    ] = "investigation",
    pinned: Annotated[
        bool, Field(description="Keep this entry at the top of the list.")
    ] = False,
    linked_branch: Annotated[
        str | None,
        Field(
            description="NAME of an existing branch of this ticket this entry is about."
        ),
    ] = None,
    linked_test_case: Annotated[
        str | None,
        Field(
            description="Code ('TC-2') or id of an existing test case of this ticket."
        ),
    ] = None,
) -> dict:
    """Append an entry to the ticket's debug journal (the Debug Space tab): keep a running record of what you investigated,
    tried and found, so humans (and later sessions) can follow along. Returns the updated ticket."""
    return await _edit_ticket(
        ticket_id,
        lambda s: svc_tickets.add_work_log(
            s,
            ticket_id,
            author=author,
            role=role,
            note=note,
            kind=kind,
            pinned=pinned,
            linked_branch=linked_branch,
            linked_test_case=linked_test_case,
        ),
    )


@notify_on_success
async def update_work_log(
    ticket_id: TicketId,
    log_id: WorkLogId,
    note: Annotated[
        str | None, Field(description="New Markdown note; replaces the old one.")
    ] = None,
    kind: WorkLogKind | None = None,
    pinned: bool | None = None,
    linked_branch: Annotated[
        str | None,
        Field(description="Branch NAME to link; an empty string '' removes the link."),
    ] = None,
    linked_test_case: Annotated[
        str | None,
        Field(
            description="Test case code/id to link; an empty string '' removes the link."
        ),
    ] = None,
) -> dict:
    """Correct or extend a work log entry. To record that a problem is fixed, add a new entry with kind 'resolved'
    instead of editing the old one (that keeps the history). Omitted fields are unchanged. Returns the updated ticket."""
    return await _edit_ticket(
        ticket_id,
        lambda s, lid: svc_tickets.update_work_log(
            s,
            ticket_id,
            lid,
            note=note,
            kind=kind,
            pinned=pinned,
            linked_branch=linked_branch,
            linked_test_case=linked_test_case,
        ),
        ("work_log", log_id),
    )


@notify_on_success
async def delete_work_log(ticket_id: TicketId, log_id: WorkLogId) -> dict:
    """Delete a work log entry permanently. Returns the updated ticket."""
    return await _edit_ticket(
        ticket_id,
        lambda s, lid: svc_tickets.delete_work_log(s, ticket_id, lid),
        ("work_log", log_id),
    )


# ---------------------------------------------------------------------------
# Test cases
# ---------------------------------------------------------------------------


@notify_on_success
async def add_test_case(
    ticket_id: TicketId,
    title: Annotated[str, Field(description="What is being verified (max 300 chars).")],
    status: Annotated[
        TestCaseStatus, Field(description="pending (not run), running, pass or fail.")
    ] = "pending",
    description: Annotated[
        str | None, Field(description="Markdown: steps / setup.")
    ] = None,
    expected_result: Annotated[
        str | None, Field(description="Markdown: what should happen.")
    ] = None,
    notes: Annotated[str | None, Field(description="Markdown: observations.")] = None,
    proof: Annotated[
        str | None,
        Field(description="Evidence such as a log excerpt, URL or file path."),
    ] = None,
    note: Annotated[
        str | None, Field(description="Deprecated alias of `notes`; use `notes`.")
    ] = None,
    assignee: Annotated[
        str | None, Field(description="Member id (UUID) who runs it; see list_members.")
    ] = None,
) -> dict:
    """Add a test case to a ticket to track verification. It gets a code 'TC-<n>' (shown in the returned `test_cases`).
    With the ticket's "Done requires: all test cases passed" guard on, the ticket cannot move to 'done' until every
    test case has status 'pass'. Returns the updated ticket."""
    return await _edit_ticket(
        ticket_id,
        lambda s: svc_tickets.add_test_case(
            s,
            ticket_id,
            title=title,
            status=status,
            proof=proof,
            note=note,
            description=description,
            expected_result=expected_result,
            notes=notes,
            assignee=assignee,
        ),
    )


@notify_on_success
async def update_test_case(
    ticket_id: TicketId,
    test_case_id: TestCaseRef,
    title: str | None = None,
    status: Annotated[
        TestCaseStatus | None,
        Field(
            description="Set to 'pass' or 'fail' after running it; 'running' starts its timer."
        ),
    ] = None,
    description: str | None = None,
    expected_result: str | None = None,
    notes: str | None = None,
    proof: Annotated[
        str | None,
        Field(description="Evidence such as a log excerpt, URL or file path."),
    ] = None,
    note: Annotated[
        str | None, Field(description="Deprecated alias of `notes`; use `notes`.")
    ] = None,
    assignee: Annotated[str | None, Field(description="Member id (UUID).")] = None,
) -> dict:
    """Update a test case, typically its `status` after running it (and `proof`). Omitted fields are unchanged.
    Returns the updated ticket."""
    return await _edit_ticket(
        ticket_id,
        lambda s, tid: svc_tickets.update_test_case(
            s,
            ticket_id,
            tid,
            title=title,
            status=status,
            proof=proof,
            note=note,
            description=description,
            expected_result=expected_result,
            notes=notes,
            assignee=assignee,
        ),
        ("test_case", test_case_id),
    )


@notify_on_success
async def delete_test_case(ticket_id: TicketId, test_case_id: TestCaseRef) -> dict:
    """Delete a test case permanently (its work-log links are not changed). Returns the updated ticket."""
    return await _edit_ticket(
        ticket_id,
        lambda s, tid: svc_tickets.delete_test_case(s, ticket_id, tid),
        ("test_case", test_case_id),
    )


# ---------------------------------------------------------------------------
# Branches
# ---------------------------------------------------------------------------


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


# ---------------------------------------------------------------------------
# Acceptance criteria
# ---------------------------------------------------------------------------


@notify_on_success
async def add_acceptance_criterion(
    ticket_id: TicketId,
    description: Annotated[
        str,
        Field(
            description="One checkable condition, e.g. 'Login fails with a clear message on a wrong password' (max 1,000 chars)."
        ),
    ],
) -> dict:
    """Add an acceptance criterion: one checklist item that defines when the ticket is done (starts unchecked).
    Returns the updated ticket."""
    return await _edit_ticket(
        ticket_id,
        lambda s: svc_tickets.add_acceptance_criterion(s, ticket_id, text=description),
    )


@notify_on_success
async def toggle_acceptance_criterion(
    ticket_id: TicketId, criterion_id: CriterionId
) -> dict:
    """Flip a criterion between not-done and done (call it again to undo). Check the current state in the returned
    ticket's `acceptance_criteria[].done`. Returns the updated ticket."""
    return await _edit_ticket(
        ticket_id,
        lambda s, cid: svc_tickets.toggle_acceptance_criterion(s, ticket_id, cid),
        ("criterion", criterion_id),
    )


@notify_on_success
async def delete_acceptance_criterion(
    ticket_id: TicketId, criterion_id: CriterionId
) -> dict:
    """Delete a criterion permanently. Returns the updated ticket."""
    return await _edit_ticket(
        ticket_id,
        lambda s, cid: svc_tickets.delete_acceptance_criterion(s, ticket_id, cid),
        ("criterion", criterion_id),
    )


# ---------------------------------------------------------------------------
# Sub-tasks
# ---------------------------------------------------------------------------


@notify_on_success
async def add_sub_task(
    ticket_id: TicketId,
    text: Annotated[
        str,
        Field(
            description="One small step, e.g. 'Confirm spec with design' (max 500 chars)."
        ),
    ],
) -> dict:
    """Add a sub-task: a checklist step inside this ticket (not a ticket; for real child tickets use parent_id).
    Returns the updated ticket."""
    return await _edit_ticket(
        ticket_id, lambda s: svc_tickets.add_sub_task(s, ticket_id, text=text)
    )


@notify_on_success
async def toggle_sub_task(ticket_id: TicketId, sub_task_id: SubTaskId) -> dict:
    """Flip a sub-task between not-done and done. Returns the updated ticket."""
    return await _edit_ticket(
        ticket_id,
        lambda s, sid: svc_tickets.toggle_sub_task(s, ticket_id, sid),
        ("sub_task", sub_task_id),
    )


@notify_on_success
async def delete_sub_task(ticket_id: TicketId, sub_task_id: SubTaskId) -> dict:
    """Delete a sub-task. Returns the updated ticket."""
    return await _edit_ticket(
        ticket_id,
        lambda s, sid: svc_tickets.delete_sub_task(s, ticket_id, sid),
        ("sub_task", sub_task_id),
    )


# ---------------------------------------------------------------------------
# Members
# ---------------------------------------------------------------------------


async def list_members(project_id: ProjectId) -> list[dict]:
    """List a project's members: {id, name, color, project_id, created_at}. Use a member `id` as `assignee`."""
    async with async_session() as session:
        members = await svc_members.list_members(session, project_id)
        return [MemberRead.model_validate(m).model_dump() for m in members]


@notify_on_success
async def add_member(
    project_id: ProjectId,
    name: Annotated[str, Field(description="Display name.")],
    color: Annotated[
        str | None, Field(description="Hex avatar color; auto-assigned when omitted.")
    ] = None,
) -> dict:
    """Add a member to a project so tickets can be assigned to them. Returns the member (with its `id`)."""
    async with async_session() as session:
        member = await svc_members.create_member(session, project_id, name, color)
        return MemberRead.model_validate(member).model_dump()


@notify_on_success
async def remove_member(project_id: ProjectId, member_id: MemberId) -> dict:
    """Remove a member from a project. Their assigned tickets become unassigned first; refused when the member created
    tickets. Returns {"ok": true}."""
    async with async_session() as session:
        removed = await svc_members.remove_member(session, project_id, member_id)
    if not removed:
        raise ValueError(
            f"Member '{member_id}' not found in this project. Use list_members to see member ids."
        )
    return {"ok": True}


# ---------------------------------------------------------------------------
# Idea Space (separate from tickets: rough ideas that can be promoted to a ticket)
# ---------------------------------------------------------------------------


async def list_idea_tickets(
    project_id: ProjectId,
    idea_status: Annotated[
        IdeaStatus | None, Field(description="Only ideas in this status.")
    ] = None,
    q: Annotated[
        str | None, Field(description="Substring search over title and description.")
    ] = None,
) -> list[dict]:
    """List a project's ideas (Idea Space), most recently touched first. Ideas move draft -> in_review -> approved and an
    approved idea can be promoted to a real ticket (promote_idea_to_ticket)."""
    async with async_session() as session:
        tickets = await svc_idea_tickets.list_idea_tickets(
            session, project_id=project_id, idea_status=idea_status, q=q
        )
        return [_idea_ticket_to_dict(t) for t in tickets]


@notify_on_success
async def create_idea_ticket(
    project_id: ProjectId,
    title: Annotated[str, Field(description="Short idea title.")],
    description: Annotated[str, Field(description="Markdown description.")] = "",
    idea_color: Annotated[IdeaColor, Field(description="Card color.")] = "yellow",
    idea_emoji: Annotated[str, Field(description="One emoji for the card.")] = "💡",
    idea_energy: Annotated[
        IdeaEnergy | None,
        Field(
            description="How mature/big the idea is: seed (just a spark), concept, hot (ready to push), big_bet."
        ),
    ] = None,
    tags: Annotated[list[str] | None, Field(description="Free-form labels.")] = None,
    problem_statement: Annotated[
        str | None,
        Field(
            description="Markdown: the problem this solves. REQUIRED later to promote the idea."
        ),
    ] = None,
) -> dict:
    """Capture a new idea in the Idea Space (status 'draft'). Its ID is 'IDEA-<n>' (one counter shared by all projects).
    Returns the idea."""
    async with async_session() as session:
        ticket = await svc_idea_tickets.create_idea_ticket(
            session,
            project_id=project_id,
            title=title,
            description=description,
            idea_color=idea_color,
            idea_emoji=idea_emoji,
            idea_energy=idea_energy,
            tags=tags or [],
            problem_statement=problem_statement,
        )
        return _idea_ticket_to_dict(ticket)


async def get_idea_ticket(ticket_id: IdeaId) -> dict:
    """Get one idea in full (description, problem statement, ICE scores, assumptions, microthoughts, promotion info).
    Its change history is separate: get_idea_activity_trail."""
    async with async_session() as session:
        ticket = await svc_idea_tickets.get_idea_ticket(session, ticket_id)
        if ticket is None:
            raise _missing_idea(ticket_id)
        return _idea_ticket_to_dict(ticket)


@notify_on_success
async def update_idea_ticket(
    ticket_id: IdeaId,
    title: str | None = None,
    description: Annotated[
        str | None, Field(description="New Markdown description; replaces the old one.")
    ] = None,
    idea_color: IdeaColor | None = None,
    idea_emoji: str | None = None,
    idea_energy: Annotated[
        IdeaEnergy | None, Field(description="Omit = unchanged; explicit null = clear.")
    ] = _UNSET,  # type: ignore[assignment]
    tags: Annotated[
        list[str] | None, Field(description="REPLACES the whole tag list.")
    ] = None,
    problem_statement: Annotated[
        str | None, Field(description="Omit = unchanged; explicit null = clear.")
    ] = _UNSET,  # type: ignore[assignment]
    ice_impact: Annotated[
        int | None, Field(description="ICE score 1-5 (clamped): expected impact.")
    ] = None,
    ice_effort: Annotated[
        int | None,
        Field(
            description="ICE score 1-5 (clamped): effort needed (higher = more work)."
        ),
    ] = None,
    ice_confidence: Annotated[
        int | None,
        Field(description="ICE score 1-5 (clamped): confidence in the estimate."),
    ] = None,
    revisit_date: Annotated[
        str | None,
        Field(
            description="ISO date to look at this idea again. Omit = unchanged; explicit null = clear."
        ),
    ] = _UNSET,  # type: ignore[assignment]
) -> dict:
    """Edit an idea. Omitted fields are unchanged; `idea_energy`, `problem_statement` and `revisit_date` can be cleared by
    passing an explicit null. Use update_idea_status to change its status. Returns the updated idea."""
    _nullable = {"idea_energy", "problem_statement", "revisit_date"}
    fields = {
        "title": title,
        "description": description,
        "idea_color": idea_color,
        "idea_emoji": idea_emoji,
        "idea_energy": idea_energy,
        "tags": tags,
        "problem_statement": problem_statement,
        "ice_impact": ice_impact,
        "ice_effort": ice_effort,
        "ice_confidence": ice_confidence,
        "revisit_date": revisit_date,
    }
    update_data = {
        k: v
        for k, v in fields.items()
        if v is not _UNSET and (v is not None or k in _nullable)
    }
    async with async_session() as session:
        ticket = await svc_idea_tickets.update_idea_ticket(
            session, ticket_id, **update_data
        )
        if ticket is None:
            raise _missing_idea(ticket_id)
        return _idea_ticket_to_dict(ticket)


@notify_on_success
async def delete_idea_ticket(ticket_id: IdeaId) -> dict:
    """PERMANENTLY delete an idea (cannot be undone). A Kanban ticket it was promoted to is NOT deleted.
    To shelve an idea instead use update_idea_status(new_status='dropped'). Returns {"deleted": true}."""
    async with async_session() as session:
        deleted = await svc_idea_tickets.delete_idea_ticket(session, ticket_id)
    if not deleted:
        raise _missing_idea(ticket_id)
    return {"deleted": True}


@notify_on_success
async def update_idea_status(
    ticket_id: IdeaId,
    new_status: Annotated[
        IdeaStatus,
        Field(
            description="Allowed moves: draft -> in_review | dropped; in_review -> approved | draft | dropped; approved -> dropped; dropped -> draft."
        ),
    ],
    reason: Annotated[
        str | None, Field(description="Why (recorded in the idea's activity trail).")
    ] = None,
) -> dict:
    """Move an idea through its workflow (draft -> in_review -> approved). An invalid move is refused with the allowed
    ones. An 'approved' idea can then be promoted with promote_idea_to_ticket. Returns the updated idea."""
    async with async_session() as session:
        ticket = await svc_idea_tickets.update_idea_status(
            session, ticket_id, new_status=new_status, reason=reason
        )
        return _idea_ticket_to_dict(ticket)


@notify_on_success
async def promote_idea_to_ticket(
    idea_ticket_id: IdeaId,
    project_id: Annotated[
        str, Field(description="Project UUID that will receive the new ticket.")
    ],
    title: Annotated[
        str | None, Field(description="Ticket title; defaults to the idea's title.")
    ] = None,
    type_: Annotated[
        TicketType,
        Field(
            description="Type of the new ticket (parameter name has a trailing underscore)."
        ),
    ] = "feature",
    priority: Priority = "medium",
) -> dict:
    """Turn an APPROVED idea into a real ticket (in 'backlog'). Requires idea_status 'approved', a non-empty
    problem_statement, and that it was not promoted before; the error says which is missing.
    Returns the new ticket (not the idea)."""
    async with async_session() as session:
        new_ticket = await svc_idea_tickets.promote_idea_to_ticket(
            session,
            idea_ticket_id=idea_ticket_id,
            project_id=project_id,
            title=title,
            type_=type_,
            priority=priority,
        )
        return _ticket_to_dict(new_ticket)


@notify_on_success
async def add_assumption(
    ticket_id: IdeaId,
    text: Annotated[
        str,
        Field(
            description="A belief the idea depends on, e.g. 'Users want to export to CSV' (max 500 chars)."
        ),
    ],
) -> dict:
    """Record an assumption the idea relies on (starts 'untested'; test it, then update_assumption_status).
    Returns the updated idea."""
    if not text or not text.strip():
        raise ValueError("text must not be empty")
    async with async_session() as session:
        ticket = await svc_idea_tickets.add_assumption(session, ticket_id, text)
        return _idea_ticket_to_dict(ticket)


@notify_on_success
async def update_assumption_status(
    ticket_id: IdeaId,
    assumption_id: Annotated[
        str,
        Field(description="Assumption id (UUID) from the idea's `assumptions` list."),
    ],
    status: Annotated[
        AssumptionStatus,
        Field(
            description="untested, validated (confirmed) or invalidated (disproved)."
        ),
    ],
) -> dict:
    """Set the outcome of an assumption after testing it. Returns the updated idea."""
    async with async_session() as session:
        ticket = await svc_idea_tickets.update_assumption_status(
            session, ticket_id, assumption_id, status
        )
        return _idea_ticket_to_dict(ticket)


@notify_on_success
async def delete_assumption(
    ticket_id: IdeaId,
    assumption_id: Annotated[
        str,
        Field(description="Assumption id (UUID) from the idea's `assumptions` list."),
    ],
) -> dict:
    """Delete an assumption permanently. Returns the updated idea."""
    async with async_session() as session:
        ticket = await svc_idea_tickets.delete_assumption(
            session, ticket_id, assumption_id
        )
        return _idea_ticket_to_dict(ticket)


@notify_on_success
async def add_microthought(
    ticket_id: IdeaId,
    text: Annotated[
        str,
        Field(description="A quick thought or note about the idea (max 500 chars)."),
    ],
) -> dict:
    """Jot a quick thought on an idea (a short timestamped note, lighter than editing its description).
    Returns the updated idea."""
    async with async_session() as session:
        ticket = await svc_idea_tickets.add_microthought(session, ticket_id, text)
        return _idea_ticket_to_dict(ticket)


@notify_on_success
async def delete_microthought(
    ticket_id: IdeaId,
    microthought_id: Annotated[
        str,
        Field(
            description="Microthought id (UUID) from the idea's `microthoughts` list."
        ),
    ],
) -> dict:
    """Delete a microthought permanently. Returns the updated idea."""
    async with async_session() as session:
        ticket = await svc_idea_tickets.delete_microthought(
            session, ticket_id, microthought_id
        )
        return _idea_ticket_to_dict(ticket)


async def get_idea_activity_trail(ticket_id: IdeaId) -> list[dict]:
    """The idea's change history (status moves with reasons, edits, promotion), newest first: [{id, label, at}]."""
    async with async_session() as session:
        ticket = await svc_idea_tickets.get_idea_ticket(session, ticket_id)
        if ticket is None:
            raise _missing_idea(ticket_id)
        read = IdeaTicketRead.from_idea_ticket(ticket)
        return list(reversed(read.activity_trail))


# ---------------------------------------------------------------------------
# Docs (wiki-like pages per project)
# ---------------------------------------------------------------------------

DocsPageId = Annotated[
    str, Field(description="Docs page id (UUID) from list_docs_pages.")
]


def _docs_error(exc: "svc_docs.DocsError") -> ValueError:
    hint = (
        " Call get_docs_page again, re-apply your edit on the new version, and retry."
        if exc.code == "conflict"
        else ""
    )
    return ValueError(f"{exc.message}.{hint}")


async def list_docs_pages(project_id: ProjectId) -> list[dict]:
    """List a project's Docs pages as a flat tree: [{id, parent_id, position, title, slug, status, version}]."""
    async with async_session() as session:
        try:
            tree = await svc_docs.list_tree(session, project_id)
        except svc_docs.DocsError as exc:
            raise _docs_error(exc) from exc
        return [
            {
                k: n[k]
                for k in (
                    "id",
                    "parent_id",
                    "position",
                    "title",
                    "slug",
                    "status",
                    "version",
                )
            }
            for n in tree
        ]


async def get_docs_page(page_id: DocsPageId) -> dict:
    """Read a Docs page: {title, markdown (latest published), version, headings, referenced_by}. Pass `version` to update_docs_page as `base_version`."""
    async with async_session() as session:
        try:
            page = await svc_docs.page_detail(session, page_id)
            links = await svc_docs.backlinks(session, page_id)
        except svc_docs.DocsError as exc:
            raise _docs_error(exc) from exc
        keep = (
            "id",
            "project_id",
            "parent_id",
            "title",
            "slug",
            "status",
            "version",
            "markdown",
            "headings",
            "updated_by",
            "updated_at",
        )
        return {k: page[k] for k in keep} | {"referenced_by": links}


@notify_on_success
async def create_docs_page(
    project_id: ProjectId,
    title: Annotated[
        str, Field(description="Page title; body headings start at '##'.")
    ],
    markdown: Annotated[str, Field(description="Initial Markdown body.")] = "",
    parent_id: Annotated[
        str | None, Field(description="Parent page id; omit for a top-level page.")
    ] = None,
) -> dict:
    """Create a Docs page and publish it as v1. Returns {id, title, slug, status, version}."""
    async with async_session() as session:
        try:
            page = await svc_docs.create_page(
                session, project_id, title, parent_id=parent_id, markdown=markdown
            )
            page = await svc_docs.publish_page(
                session, page["id"], base_version=0, note="Created via MCP"
            )
        except svc_docs.DocsError as exc:
            raise _docs_error(exc) from exc
        return {k: page[k] for k in ("id", "title", "slug", "status", "version")}


@notify_on_success
async def update_docs_page(
    page_id: DocsPageId,
    markdown: Annotated[
        str, Field(description="The full new Markdown body (not a patch).")
    ],
    base_version: Annotated[
        int,
        Field(description="`version` from get_docs_page; a stale value is rejected."),
    ],
    note: Annotated[
        str | None, Field(description="Change note for the page history.")
    ] = None,
    publish: Annotated[
        bool,
        Field(
            description="Publish a new version (default). False only saves an agent draft nobody else sees."
        ),
    ] = True,
    title: Annotated[
        str | None,
        Field(
            description="New page title (renames the page; links to it are rewritten)."
        ),
    ] = None,
) -> dict:
    """Replace a Docs page's Markdown and optionally rename it. Returns {id, title, version, published}."""
    async with async_session() as session:
        try:
            if title is not None:
                current = await svc_docs.page_detail(session, page_id)
                if title.strip() != current["title"]:
                    await svc_docs.rename_page(
                        session, page_id, title, rewrite_links=True
                    )
            if publish:
                page = await svc_docs.publish_page(
                    session,
                    page_id,
                    base_version=base_version,
                    note=note,
                    markdown=markdown,
                )
            else:
                page = await svc_docs.save_draft(
                    session, page_id, markdown=markdown, base_version=base_version
                )
        except svc_docs.DocsError as exc:
            raise _docs_error(exc) from exc
        return {
            "id": page["id"],
            "title": page["title"],
            "version": page["version"],
            "published": publish,
        }


@notify_on_success
async def move_docs_page(
    page_id: DocsPageId,
    parent_id: Annotated[
        str | None,
        Field(description="New parent page id; omit or null for the top level."),
    ] = None,
    after_id: Annotated[
        str | None,
        Field(description="Sibling to place it after; omit to append at the end."),
    ] = None,
) -> dict:
    """Move a Docs page under another page (or to the top level). Moving into itself or its own sub-pages is rejected."""
    async with async_session() as session:
        try:
            page = await svc_docs.move_page(
                session, page_id, parent_id=parent_id, after_id=after_id
            )
        except svc_docs.DocsError as exc:
            raise _docs_error(exc) from exc
        return {
            "id": page["id"],
            "title": page["title"],
            "parent_id": page["parent_id"],
        }


@notify_on_success
async def duplicate_docs_page(
    page_id: DocsPageId,
    include_children: Annotated[
        bool, Field(description="Also copy the sub-pages.")
    ] = False,
    title: Annotated[
        str | None, Field(description="Title of the copy; default '<title> (copy)'.")
    ] = None,
) -> dict:
    """Copy a Docs page as a new draft (no history). Returns the copy {id, title, slug, status}."""
    async with async_session() as session:
        try:
            page = await svc_docs.duplicate_page(
                session, page_id, title=title, include_children=include_children
            )
        except svc_docs.DocsError as exc:
            raise _docs_error(exc) from exc
        return {k: page[k] for k in ("id", "title", "slug", "status")}


@notify_on_success
async def delete_docs_page(page_id: DocsPageId) -> dict:
    """Soft-delete a Docs page and its sub-pages into the Recycle Bin (kept 30 days; restore_docs_page undoes it)."""
    async with async_session() as session:
        try:
            return await svc_docs.delete_page(session, page_id)
        except svc_docs.DocsError as exc:
            raise _docs_error(exc) from exc


@notify_on_success
async def restore_docs_page(page_id: DocsPageId) -> dict:
    """Restore a deleted Docs page (with the sub-pages deleted together with it) from the Recycle Bin."""
    async with async_session() as session:
        try:
            return await svc_docs.restore_page(session, page_id)
        except svc_docs.DocsError as exc:
            raise _docs_error(exc) from exc


async def list_docs_recycle_bin(project_id: ProjectId) -> list[dict]:
    """List deleted Docs pages still in the Recycle Bin: [{id, title, page_count, deleted_at, deleted_by, days_left}]."""
    async with async_session() as session:
        try:
            return await svc_docs.list_deleted(session, project_id)
        except svc_docs.DocsError as exc:
            raise _docs_error(exc) from exc


async def list_docs_versions(page_id: DocsPageId) -> list[dict]:
    """List a Docs page's published versions, newest first: [{version, author, note, created_at, words}]."""
    async with async_session() as session:
        try:
            return await svc_docs.list_versions(session, page_id)
        except svc_docs.DocsError as exc:
            raise _docs_error(exc) from exc


async def get_docs_version(
    page_id: DocsPageId,
    version: Annotated[
        int, Field(description="Version number from list_docs_versions.")
    ],
    compare_to: Annotated[
        int | None,
        Field(
            description="Another version number: returns a line diff `version` -> `compare_to` instead."
        ),
    ] = None,
) -> dict:
    """Read one old version of a Docs page (markdown), or a line diff between two versions."""
    async with async_session() as session:
        try:
            if compare_to is not None:
                return await svc_docs.diff_versions(
                    session, page_id, version, compare_to
                )
            return await svc_docs.get_version(session, page_id, version)
        except svc_docs.DocsError as exc:
            raise _docs_error(exc) from exc


@notify_on_success
async def restore_docs_version(
    page_id: DocsPageId,
    version: Annotated[int, Field(description="Version number to restore.")],
) -> dict:
    """Publish an old version of a Docs page again as a new version (history is kept). Returns {id, title, version}."""
    async with async_session() as session:
        try:
            page = await svc_docs.restore_version(session, page_id, version)
        except svc_docs.DocsError as exc:
            raise _docs_error(exc) from exc
        return {"id": page["id"], "title": page["title"], "version": page["version"]}


async def resolve_docs_links(
    project_id: ProjectId,
    refs: Annotated[
        list[str],
        Field(
            description="References to check: '[[Page]]', '[[Page#Section]]' or a ticket key like 'IAM-12'."
        ),
    ],
) -> list[dict]:
    """Check whether [[page]] / ticket references resolve: status ok, missing, section_missing, in_bin or ambiguous."""
    from services.docs import parse_references

    parsed: list[dict] = []
    for ref in refs:
        found = parse_references(ref if ref.startswith("[[") else f"{ref}")
        if not found:
            raise ValueError(f"'{ref}' is not a [[Page]] link or a ticket key")
        item = found[0]
        parsed.append(
            {"kind": "page", "title": item["title"], "anchor": item["anchor"]}
            if item["kind"] == "page"
            else {"kind": "ticket", "key": item["key"]}
        )
    async with async_session() as session:
        try:
            return await svc_docs.resolve_refs(session, project_id, parsed)
        except svc_docs.DocsError as exc:
            raise _docs_error(exc) from exc


async def search_docs(
    project_id: ProjectId,
    query: Annotated[
        str,
        Field(
            description='Words are AND-ed; "a b" is a phrase; -word excludes; a ticket key finds pages mentioning it.'
        ),
    ],
    scope: Annotated[
        Literal["space", "all", "tickets"],
        Field(
            description="This project's docs, docs of all projects, or tickets only."
        ),
    ] = "space",
    limit: Annotated[int, Field(description="Max results (default 10).")] = 10,
) -> dict:
    """Full-text search over Docs pages (title, headings, body) with snippets. Returns {total, pages, tickets}."""
    from services import docs_search

    async with async_session() as session:
        try:
            res = await docs_search.search(
                session, project_id, query, scope=scope, limit=limit
            )
        except svc_docs.DocsError as exc:
            raise _docs_error(exc) from exc
        return {k: res[k] for k in ("total", "pages", "tickets") if k in res}


@notify_on_success
async def import_docs(
    project_id: ProjectId,
    path: Annotated[
        str,
        Field(
            description="Absolute path of a .md/.markdown file or a folder (folders become a page tree)."
        ),
    ],
    parent_id: Annotated[
        str | None, Field(description="Parent page id; omit for the top level.")
    ] = None,
) -> dict:
    """Import local Markdown files as new Docs pages (drafts), keeping folders as a tree. Returns {created, failed}."""
    from pathlib import Path

    from services import docs_import

    root = Path(path).expanduser()
    if not root.exists():
        raise ValueError(f"Path not found: {path}")
    files: list[tuple[str, bytes]] = []
    candidates = [root] if root.is_file() else sorted(root.rglob("*"))
    for f in candidates:
        if f.is_file() and f.suffix.lower() in {".md", ".markdown"}:
            rel = f.name if root.is_file() else str(f.relative_to(root))
            files.append((rel, f.read_bytes()[: docs_import.MAX_FILE_BYTES + 1]))
    if not files:
        raise ValueError("No .md or .markdown files found at that path")
    async with async_session() as session:
        try:
            return await docs_import.run_import(
                session, project_id, files, parent_id=parent_id
            )
        except svc_docs.DocsError as exc:
            raise _docs_error(exc) from exc


@notify_on_success
async def link_ticket_doc(ticket_id: TicketId, page_id: DocsPageId) -> dict:
    """Link a Docs page to a ticket manually (shown under 'Linked docs' on the ticket)."""
    async with async_session() as session:
        try:
            return await svc_docs.link_ticket_doc(session, ticket_id, page_id)
        except svc_docs.DocsError as exc:
            raise _docs_error(exc) from exc


@notify_on_success
async def unlink_ticket_doc(ticket_id: TicketId, page_id: DocsPageId) -> dict:
    """Remove a manual link between a Docs page and a ticket."""
    async with async_session() as session:
        try:
            return await svc_docs.unlink_ticket_doc(session, ticket_id, page_id)
        except svc_docs.DocsError as exc:
            raise _docs_error(exc) from exc


def ideas_enabled() -> bool:
    """Whether the Idea Space tools are exposed over MCP (off by default)."""
    return os.environ.get("KANBAN_MCP_IDEA_TOOLS", "").strip().lower() in {
        "1",
        "true",
        "yes",
        "on",
    }


_INSTRUCTIONS_HEAD = """\
Kanban board for software projects. Typical flow: list_projects -> list_tickets -> get_ticket -> \
update_ticket_status('in-progress') -> keep add_work_log (debug journal) / add_comment updated while you work -> \
add_test_case / toggle_acceptance_criterion -> update_ticket_status('done').

Concepts
- Project: has a UUID `id` and a `prefix`. Ticket: id 'PREFIX-N' (e.g. 'IAM-12'); statuses backlog, todo, in-progress, \
review, testing, done, wont_do. A ticket owns acceptance criteria, sub-tasks (checklist steps), test cases, comments, a work log, branches and \
relations (blocks / links); sub-items are addressed by the UUIDs (or test-case code / branch name) shown in get_ticket.
"""
_INSTRUCTIONS_IDEAS = """\
- Idea Space is separate: ideas have ids 'IDEA-N' and can be promoted to a ticket once approved.
"""
_INSTRUCTIONS_TAIL = """\
- Docs: each project has a page tree of Markdown pages: read with list_docs_pages / get_docs_page / search_docs, write with \
create_docs_page / update_docs_page (send the `version` you read as base_version; a stale one is rejected, so re-read and retry), \
organise with move/duplicate/delete/restore_docs_page and the *_docs_version tools. Link pages with [[Title#Section]] and tickets by key (IAM-12).
- Each ticket has a scratch folder: get_ticket_workspace_path, then use your own file tools there.

Conventions
- Failures come back as tool errors whose message says how to fix the call; read it and retry.
- Tools that change a ticket return it without its activity log; get_ticket returns the 10 most recent activity entries (activity_limit / activity_since narrow or widen that; activity_limit=-1 gives all).
- Omitted optional arguments mean "unchanged". To empty a field use update_ticket's clear_fields{ideas_null}.
- Text fields are Markdown. Dates are ISO 'YYYY-MM-DD'.
- File attachments and images use standard root-relative path '/uploads/{{filename}}' (e.g. '[report.pdf](/uploads/report.pdf)' or '![screenshot](/uploads/screenshot.png)'). Optional image width: '![screenshot|640px](/uploads/screenshot.png)'.
- Everything you change is attributed to the AI agent in the board's Activity tab; humans watch it live.
- delete_* tools are permanent; prefer status 'wont_do'{ideas_drop} to retire things.
"""


def build_instructions(include_ideas: bool | None = None) -> str:
    """The server instructions sent on connect (they only mention the Idea Space when its tools are exposed)."""
    if include_ideas is None:
        include_ideas = ideas_enabled()
    tail = _INSTRUCTIONS_TAIL.format(
        ideas_null=" (idea tools: explicit null)" if include_ideas else "",
        ideas_drop=" / idea status 'dropped'" if include_ideas else "",
    )
    return _INSTRUCTIONS_HEAD + (_INSTRUCTIONS_IDEAS if include_ideas else "") + tail


MCP_INSTRUCTIONS = build_instructions()


# ---------------------------------------------------------------------------
# Registration: every tool with its MCP annotations
# ---------------------------------------------------------------------------

_READ = ToolAnnotations(readOnlyHint=True, openWorldHint=False)
_WRITE = ToolAnnotations(
    readOnlyHint=False, destructiveHint=False, idempotentHint=False, openWorldHint=False
)
_UPDATE = ToolAnnotations(
    readOnlyHint=False, destructiveHint=False, idempotentHint=True, openWorldHint=False
)
_DELETE = ToolAnnotations(
    readOnlyHint=False, destructiveHint=True, idempotentHint=False, openWorldHint=False
)

CORE_TOOL_TABLE: list[tuple[Callable, ToolAnnotations]] = [
    # projects & members
    (list_projects, _READ),
    (create_project, _WRITE),
    (update_project, _UPDATE),
    (list_members, _READ),
    (add_member, _WRITE),
    (remove_member, _DELETE),
    # tickets
    (list_tickets, _READ),
    (get_ticket, _READ),
    (get_ticket_workspace_path, _UPDATE),  # creates the folder on first call
    (create_ticket, _WRITE),
    (create_child_ticket, _WRITE),
    (update_ticket, _UPDATE),
    (update_ticket_status, _UPDATE),
    (delete_ticket, _DELETE),
    # relations
    (block_ticket, _UPDATE),
    (unblock_ticket, _UPDATE),
    (link_tickets, _WRITE),
    (unlink_tickets, _DELETE),
    # comments, work log, test cases, criteria, branches
    (add_comment, _WRITE),
    (update_comment, _UPDATE),
    (list_comments, _READ),
    (restore_comment, _UPDATE),
    (delete_comment, _DELETE),
    (add_work_log, _WRITE),
    (update_work_log, _UPDATE),
    (delete_work_log, _DELETE),
    (add_test_case, _WRITE),
    (update_test_case, _UPDATE),
    (delete_test_case, _DELETE),
    (add_acceptance_criterion, _WRITE),
    (toggle_acceptance_criterion, _WRITE),
    (delete_acceptance_criterion, _DELETE),
    (add_sub_task, _WRITE),
    (toggle_sub_task, _WRITE),
    (delete_sub_task, _DELETE),
    (add_branch, _WRITE),
    (update_branch, _UPDATE),
    (delete_branch, _DELETE),
    (checkout_branch, _UPDATE),
    # docs
    (list_docs_pages, _READ),
    (get_docs_page, _READ),
    (create_docs_page, _WRITE),
    (update_docs_page, _UPDATE),
    (search_docs, _READ),
    (move_docs_page, _UPDATE),
    (duplicate_docs_page, _WRITE),
    (delete_docs_page, _DELETE),
    (restore_docs_page, _UPDATE),
    (list_docs_recycle_bin, _READ),
    (list_docs_versions, _READ),
    (get_docs_version, _READ),
    (restore_docs_version, _UPDATE),
    (resolve_docs_links, _READ),
    (import_docs, _WRITE),
    (link_ticket_doc, _WRITE),
    (unlink_ticket_doc, _DELETE),
]

# The Idea Space tools are hidden from the MCP tool list for now (about a quarter of its size). They are fully
# implemented: set KANBAN_MCP_IDEA_TOOLS=1 to expose them again.
IDEA_TOOL_TABLE: list[tuple[Callable, ToolAnnotations]] = [
    (list_idea_tickets, _READ),
    (get_idea_ticket, _READ),
    (get_idea_activity_trail, _READ),
    (create_idea_ticket, _WRITE),
    (update_idea_ticket, _UPDATE),
    (update_idea_status, _UPDATE),
    (promote_idea_to_ticket, _WRITE),
    (delete_idea_ticket, _DELETE),
    (add_assumption, _WRITE),
    (update_assumption_status, _UPDATE),
    (delete_assumption, _DELETE),
    (add_microthought, _WRITE),
    (delete_microthought, _DELETE),
]


def _strip_titles(node: Any) -> Any:
    """Pydantic adds a redundant "title" (a prettified copy of the name) to every parameter; the AI reads the whole
    schema on each session, so drop them. Only schema keywords are touched, never a property that is itself named "title"."""
    if isinstance(node, dict):
        out = {}
        for key, value in node.items():
            if key == "title" and isinstance(value, str):
                continue
            out[key] = (
                _strip_properties(value)
                if key == "properties"
                else _strip_titles(value)
            )
        return out
    if isinstance(node, list):
        return [_strip_titles(item) for item in node]
    return node


def _strip_properties(props: Any) -> Any:
    # keys of "properties" are parameter names (one may be called "title"); only recurse into the values
    if not isinstance(props, dict):
        return props
    return {name: _strip_titles(sub) for name, sub in props.items()}


TOOL_TABLE = CORE_TOOL_TABLE + IDEA_TOOL_TABLE


def register(mcp: FastMCP, include_ideas: bool | None = None) -> None:
    """Register the Kanban MCP tools with the given FastMCP instance.
    `include_ideas` defaults to the KANBAN_MCP_IDEA_TOOLS environment variable (off)."""
    if include_ideas is None:
        include_ideas = ideas_enabled()
    for func, annotations in CORE_TOOL_TABLE + (
        IDEA_TOOL_TABLE if include_ideas else []
    ):
        mcp.tool(annotations=annotations)(func)
    for tool in mcp._tool_manager.list_tools():
        tool.parameters = _strip_titles(tool.parameters)
