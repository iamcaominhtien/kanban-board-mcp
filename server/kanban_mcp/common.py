"""Shared by the MCP operations and tools: parameter types, output shaping, errors, and the change hook.

Conventions (kept in sync with the server `instructions` in `instructions.py`):
- Errors are raised (the client sees `isError: true` plus a message that says how to fix the call);
  operations never return `None` or `{"error": ...}` for a failure.
- Operations that change a ticket return the updated ticket *without* its activity log.
- Every changing operation is attributed to the AI agent in the Activity tab (`notify_on_success`).
"""

import json
import re
from datetime import datetime, timezone
from functools import wraps
from typing import Annotated, Any, Awaitable, Callable, Literal

import events as board_events
from pydantic import Field, ValidationError

import services.activity as svc_activity
import services.tickets as svc_tickets
import database
from models import (
    IdeaTicketRead,
    Ticket,
    TicketRead,
)


def async_session():
    """A database session. Looked up on every call so a re-initialised database (and the tests) is picked up."""
    return database.async_session()


# ---------------------------------------------------------------------------
# Shared parameter types (the descriptions are what the AI reads in the schema)
# ---------------------------------------------------------------------------

ProjectId = Annotated[
    str, Field(description="Project UUID from get_projects (not the prefix).")
]
TicketId = Annotated[str, Field(description="Ticket ID such as 'IAM-12' (not a UUID).")]
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
MemberId = Annotated[
    str, Field(description="Member id (UUID) from get_projects(project_id).")
]

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
