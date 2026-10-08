"""Ticket operations: list, read, create, update, delete."""

import json
import re
import services.tickets as svc_tickets
import services.workspace as svc_workspace
from datetime import datetime, timezone
from models import TicketUpdate
from pydantic import Field
from sqlalchemy.exc import NoResultFound
from typing import Annotated, Literal
from uploads import resolve_upload_path
from .. import common
from .comments import list_comments
from ..common import (
    Priority,
    ProjectId,
    Status,
    TicketId,
    TicketType,
    _edit_ticket,
    _missing_ticket,
    _ticket_summary,
    _ticket_to_dict,
    notify_on_success,
)


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
    async with common.async_session() as session:
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
        async with common.async_session() as session:
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
            f"Project not found: {project_id}. Use get_projects to see project ids."
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
    view: Annotated[
        Literal["full", "comments"],
        Field(
            description="'full' (default): the whole ticket. 'comments': only the comment thread, cheaper when you just need the discussion."
        ),
    ] = "full",
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
    ticket has in all, so you can tell when more exist (widen with activity_limit or narrow with activity_since).
    view='comments' returns just the comment thread (oldest first: id, author, text, at, edited_at, notified)."""
    if view == "comments":
        if activity_limit is not None or activity_since is not None:
            raise ValueError(
                "activity_limit / activity_since apply to view='full' only; view='comments' returns just the comment thread."
            )
        return await list_comments(ticket_id)
    since = _parse_since(activity_since) if activity_since else None
    async with common.async_session() as session:
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
    async with common.async_session() as session:
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
    async with common.async_session() as session:
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
    async with common.async_session() as session:
        found = await svc_tickets.delete_ticket(session, ticket_id)
    if not found:
        raise _missing_ticket(ticket_id)
    return {"deleted": ticket_id}
