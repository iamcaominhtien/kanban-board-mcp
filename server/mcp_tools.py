import json
import re
from datetime import datetime, timezone
from functools import wraps
from typing import Literal

import events as board_events
from mcp.server.fastmcp import FastMCP
from pydantic import ValidationError
from sqlalchemy import text
from sqlalchemy.exc import NoResultFound

import services.idea_tickets as svc_idea_tickets
import services.members as svc_members
import services.projects as svc_projects
import services.tickets as svc_tickets
from database import async_session
from models import (
    IDEA_STATUSES,
    IdeaTicketRead,
    MemberRead,
    ProjectCreate,
    ProjectRead,
    Ticket,
    TicketRead,
    TicketUpdate,
)

_UNSET = object()
_VALID_IDEA_STATUSES = frozenset(IDEA_STATUSES)
_HEX_COLOR_RE = re.compile(r"^#[0-9A-Fa-f]{6}$")


def _ticket_to_dict(ticket: Ticket) -> dict:
    """Serialize a Ticket to dict."""
    return TicketRead.from_ticket(ticket).model_dump()


def _idea_ticket_to_dict(ticket) -> dict:
    """Serialize an IdeaTicket to dict."""
    return IdeaTicketRead.from_idea_ticket(ticket).model_dump()


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


async def _next_ticket_id(session, project_id: str) -> str:
    """Increment project ticket_counter and return the next ticket ID (e.g. 'IAM-5')."""
    result = await session.execute(
        text(
            "UPDATE project SET ticket_counter = ticket_counter + 1"
            " WHERE id = :pid RETURNING ticket_counter, prefix"
        ),
        {"pid": project_id},
    )
    row = result.one()
    return f"{row.prefix}-{row.ticket_counter}"


def notify_on_success(func):
    """Decorator that publishes an SSE invalidation event after a successful mutation."""

    @wraps(func)
    async def wrapper(*args, **kwargs):
        result = await func(*args, **kwargs)
        if result is not None:
            await board_events.publish(board_events.INVALIDATE)
        return result

    return wrapper


async def list_projects() -> list[dict]:
    """List all projects on the Kanban board. Returns id, name, prefix, color, ticket_counter."""
    async with async_session() as session:
        projects = await svc_projects.list_projects(session)
        return [ProjectRead.model_validate(p).model_dump() for p in projects]


@notify_on_success
async def create_project(name: str, prefix: str, color: str = "#6366f1") -> dict:
    """Create a new Kanban project.

    Args:
        name: Human-readable project name (e.g. "My App")
        prefix: Short uppercase ticket prefix, max 6 chars (e.g. "MYAPP")
        color: Hex accent color for the project (e.g. "#6366f1")

    Returns the created project.
    """
    async with async_session() as session:
        data = ProjectCreate(name=name, prefix=prefix.upper(), color=color)
        project = await svc_projects.create_project(session, data)
        result = ProjectRead.model_validate(project).model_dump()
    return result


async def list_tickets(
    project_id: str,
    status: str | None = None,
    priority: str | None = None,
    q: str | None = None,
) -> list[dict]:
    """List tickets for a project.

    Optionally filter by status (backlog/todo/in-progress/done),
    priority (low/medium/high/critical), or search text (q matches title).
    Returns list of full ticket objects.
    """
    async with async_session() as session:
        tickets = await svc_tickets.list_tickets(
            session,
            project_id,
            status=status,
            priority=priority,
            q=q,
            include_wont_do=True,
        )
        return [_ticket_to_dict(t) for t in tickets]


@notify_on_success
async def create_ticket(
    project_id: str,
    title: str,
    type: Literal["bug", "feature", "task", "chore"] = "task",
    priority: Literal["low", "medium", "high", "critical"] = "medium",
    status: Literal["backlog", "todo", "in-progress", "done"] = "backlog",
    description: str = "",
    parent_id: str | None = None,
    estimate: float | None = None,
    due_date: str | None = None,
    tags: list[str] | None = None,
) -> dict | None:
    """Create a new ticket in a project. The ticket ID is auto-generated as PREFIX-N (e.g. IAM-5).

    Args:
        project_id: The project's UUID
        title: Ticket title (required)
        type: bug | feature | task | chore (default: task)
        priority: low | medium | high | critical (default: medium)
        status: backlog | todo | in-progress | done (default: backlog)
        description: Markdown description
        parent_id: Optional parent ticket ID for subtasks (max 1 level deep)
        estimate: Story points (e.g. 1, 2, 3, 5, 8)
        due_date: ISO date string (e.g. "2026-04-15")
        tags: List of tag strings

    Returns the created ticket.
    """
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
                tags=tags or [],
            )
            result = TicketRead.from_ticket(ticket).model_dump()
    except NoResultFound:
        raise ValueError(f"Project not found: {project_id}")
    return result


async def get_ticket(ticket_id: str) -> dict | None:
    """Get the full details of a ticket by its ID (e.g. 'IAM-1').

    Returns the ticket or None if not found.
    """
    async with async_session() as session:
        ticket = await svc_tickets.get_ticket(session, ticket_id)
        if ticket is None:
            return None
        return TicketRead.from_ticket(ticket).model_dump()


@notify_on_success
async def update_ticket_status(
    ticket_id: str,
    status: Literal["backlog", "todo", "in-progress", "done"],
) -> dict | None:
    """Update the status of a ticket. Valid statuses: backlog, todo, in-progress, done.

    Automatically appends a status change entry to the ticket's activity log.
    Returns the updated ticket or None if not found.
    """
    try:
        async with async_session() as session:
            ticket = await svc_tickets.update_ticket(
                session, ticket_id, TicketUpdate(status=status)
            )
            if ticket is None:
                return None
            result = TicketRead.from_ticket(ticket).model_dump()
    except ValidationError as exc:
        raise ValueError(str(exc)) from exc
    return result


@notify_on_success
async def update_ticket(
    ticket_id: str,
    title: str | None = None,
    description: str | None = None,
    type: Literal["bug", "feature", "task", "chore"] | None = None,
    priority: Literal["low", "medium", "high", "critical"] | None = None,
    status: Literal["backlog", "todo", "in-progress", "done"] | None = None,
    estimate: float | None = None,
    due_date: str | None = None,
    parent_id: str | None = None,
    tags: list[str] | None = None,
) -> dict | None:
    """Update one or more core fields on a ticket. Only provided (non-None) fields are updated.
    Returns the updated ticket dict, or None if not found.

    Note: nullable fields (estimate, due_date, parent_id) cannot be cleared to None via this tool — passing None is treated as 'do not update'.
    """
    fields = {
        "title": title,
        "description": description,
        "type": type,
        "priority": priority,
        "status": status,
        "estimate": estimate,
        "due_date": due_date,
        "parent_id": parent_id,
        "tags": tags,
    }
    update_data = {k: v for k, v in fields.items() if v is not None}
    try:
        async with async_session() as session:
            ticket = await svc_tickets.update_ticket(
                session, ticket_id, TicketUpdate(**update_data)
            )
            if ticket is None:
                return None
            result = TicketRead.from_ticket(ticket).model_dump()
    except ValidationError as exc:
        raise ValueError(str(exc)) from exc
    return result


@notify_on_success
async def add_comment(ticket_id: str, text: str, author: str) -> dict | None:
    """Add a comment to a ticket. Returns the updated ticket."""
    async with async_session() as session:
        ticket = await svc_tickets.add_comment(
            session, ticket_id, text=text, author=author
        )
        if ticket is None:
            return None
        result = TicketRead.from_ticket(ticket).model_dump()
    return result


@notify_on_success
async def add_work_log(
    ticket_id: str,
    author: str,
    role: Literal["PM", "Developer", "BA", "Tester", "Designer", "Other"],
    note: str,
) -> dict | None:
    """Log work done on a ticket. Returns the updated ticket."""
    async with async_session() as session:
        ticket = await svc_tickets.add_work_log(
            session, ticket_id, author=author, role=role, note=note
        )
        if ticket is None:
            return None
        result = TicketRead.from_ticket(ticket).model_dump()
    return result


@notify_on_success
async def add_test_case(
    ticket_id: str,
    title: str,
    status: Literal["pending", "pass", "fail"] = "pending",
    proof: str | None = None,
    note: str | None = None,
) -> dict | None:
    """Add a test case to a ticket. Returns the updated ticket."""
    async with async_session() as session:
        ticket = await svc_tickets.add_test_case(
            session, ticket_id, title=title, status=status, proof=proof, note=note
        )
        if ticket is None:
            return None
        result = TicketRead.from_ticket(ticket).model_dump()
    return result


@notify_on_success
async def update_test_case(
    ticket_id: str,
    test_case_id: str,
    status: Literal["pending", "pass", "fail"] | None = None,
    proof: str | None = None,
    note: str | None = None,
) -> dict | None:
    """Update a test case's status, proof, or note. Returns the updated ticket."""
    async with async_session() as session:
        ticket = await svc_tickets.get_ticket(session, ticket_id)
        if ticket is None:
            return None
        tcs = json.loads(ticket.test_cases) if ticket.test_cases else []
        current = next((tc for tc in tcs if tc.get("id") == test_case_id), None)
        if current is None:
            return None
        if status is None:
            status = current["status"]
        updated = await svc_tickets.update_test_case(
            session, ticket_id, test_case_id, status=status, proof=proof, note=note
        )
        if updated is None:
            return None
        result = TicketRead.from_ticket(updated).model_dump()
    return result


@notify_on_success
async def create_child_ticket(
    parent_ticket_id: str,
    title: str,
    type: Literal["bug", "feature", "task", "chore"] = "task",
    priority: Literal["low", "medium", "high", "critical"] = "medium",
    description: str = "",
) -> dict | None:
    """Create a child ticket under an existing ticket. Returns the new ticket dict, or None if parent not found."""
    try:
        async with async_session() as session:
            parent = await svc_tickets.get_ticket(session, parent_ticket_id)
            if parent is None:
                return None
            ticket = await svc_tickets.create_ticket(
                session,
                project_id=parent.project_id,
                parent_id=parent_ticket_id,
                title=title,
                type=type,
                priority=priority,
                description=description,
            )
            result = TicketRead.from_ticket(ticket).model_dump()
    except (NoResultFound, ValueError):
        return None
    return result


@notify_on_success
async def add_acceptance_criterion(ticket_id: str, description: str) -> dict | None:
    """Add a new acceptance criterion to a ticket. Returns the updated ticket."""
    async with async_session() as session:
        ticket = await svc_tickets.add_acceptance_criterion(
            session, ticket_id, text=description
        )
        if ticket is None:
            return None
        result = TicketRead.from_ticket(ticket).model_dump()
    return result


@notify_on_success
async def toggle_acceptance_criterion(ticket_id: str, criterion_id: str) -> dict | None:
    """Toggle the done/not-done state of an acceptance criterion. Returns the updated ticket."""
    async with async_session() as session:
        ticket = await svc_tickets.toggle_acceptance_criterion(
            session, ticket_id, criterion_id
        )
        if ticket is None:
            return None
        result = TicketRead.from_ticket(ticket).model_dump()
    return result


@notify_on_success
async def delete_acceptance_criterion(ticket_id: str, criterion_id: str) -> dict | None:
    """Remove an acceptance criterion from a ticket. Returns the updated ticket."""
    async with async_session() as session:
        ticket = await svc_tickets.delete_acceptance_criterion(
            session, ticket_id, criterion_id
        )
        if ticket is None:
            return None
        result = TicketRead.from_ticket(ticket).model_dump()
    return result


async def list_members(project_id: str) -> list[dict]:
    """List all members of a project. Returns id, name, color, project_id, created_at."""
    async with async_session() as session:
        members = await svc_members.list_members(session, project_id)
        return [MemberRead.model_validate(m).model_dump() for m in members]


@notify_on_success
async def add_member(project_id: str, name: str, color: str | None = None) -> dict:
    """Add a member to a project.

    Args:
        project_id: The project UUID
        name: Member's display name
        color: Optional hex color for avatar background (auto-assigned if not provided)

    Returns the created member.
    """
    async with async_session() as session:
        member = await svc_members.create_member(session, project_id, name, color)
        result = MemberRead.model_validate(member).model_dump()
    return result


@notify_on_success
async def remove_member(project_id: str, member_id: str) -> dict:
    """Remove a member from a project.

    Cannot remove if member created any tickets.
    Tickets assigned to the member will be unassigned first.
    Returns a dict {"ok": bool}.
    """
    async with async_session() as session:
        try:
            removed = await svc_members.remove_member(session, project_id, member_id)
        except ValueError as exc:
            return {"ok": False, "error": str(exc)}
        result = {"ok": removed}
    return result


async def list_idea_tickets(
    project_id: str,
    idea_status: str | None = None,
    q: str | None = None,
) -> list[dict]:
    """List idea tickets for a project.

    Args:
        project_id: The project UUID
        idea_status: Optional filter by status (raw | brewing | validated | approved | dropped)
        q: Optional substring search on title and description

    Returns list ordered by last_touched_at descending.
    """
    if idea_status is not None and idea_status not in _VALID_IDEA_STATUSES:
        return {
            "error": f"Invalid idea_status '{idea_status}'. Valid values: raw, brewing, validated, approved, dropped"
        }
    async with async_session() as session:
        tickets = await svc_idea_tickets.list_idea_tickets(
            session, project_id=project_id, idea_status=idea_status, q=q
        )
        return [_idea_ticket_to_dict(t) for t in tickets]


@notify_on_success
async def create_idea_ticket(
    project_id: str,
    title: str,
    description: str = "",
    idea_color: str = "#F5C518",
    idea_emoji: str = "💡",
    idea_energy: str | None = None,
    tags: list[str] | None = None,
    problem_statement: str | None = None,
) -> dict | None:
    """Create a new idea ticket. ID is auto-generated as IDEA-N (global counter).

    Args:
        project_id: The project UUID (required)
        title: Idea title (required)
        description: Markdown description
        idea_color: Hex color string (default #F5C518)
        idea_emoji: Single emoji character (default 💡)
        idea_energy: low | medium | high
        tags: List of tag strings
        problem_statement: Markdown problem statement

    Returns the created idea ticket.
    """
    if not _HEX_COLOR_RE.match(idea_color):
        return {"error": "idea_color must be a 6-digit hex color, e.g. #FF0000"}
    try:
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
            result = _idea_ticket_to_dict(ticket)
    except ValueError as exc:
        return {"error": str(exc)}
    return result


async def get_idea_ticket(ticket_id: str) -> dict | None:
    """Get the full details of an idea ticket by its ID (e.g. 'IDEA-1').

    Returns the idea ticket or None if not found.
    """
    async with async_session() as session:
        ticket = await svc_idea_tickets.get_idea_ticket(session, ticket_id)
        if ticket is None:
            return None
        return _idea_ticket_to_dict(ticket)


@notify_on_success
async def update_idea_ticket(
    ticket_id: str,
    title: str | None = None,
    description: str | None = None,
    idea_color: str | None = None,
    idea_emoji: str | None = None,
    idea_energy: str | None = _UNSET,
    tags: list[str] | None = None,
    problem_statement: str | None = _UNSET,
    ice_impact: int | None = None,
    ice_effort: int | None = None,
    ice_confidence: int | None = None,
    revisit_date: str | None = _UNSET,
) -> dict | None:
    """Update one or more fields on an idea ticket. Only provided (non-None) fields are updated.

    Nullable fields (idea_energy, problem_statement, revisit_date) can be explicitly cleared
    to None by passing null. ICE values are auto-clamped to 1–5.
    Updates last_touched_at and appends to activity_trail.
    Returns the updated idea ticket, or None if not found.
    """
    if idea_color is not None and not _HEX_COLOR_RE.match(idea_color):
        return {"error": "idea_color must be a 6-digit hex color, e.g. #FF0000"}
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
    try:
        async with async_session() as session:
            ticket = await svc_idea_tickets.update_idea_ticket(
                session, ticket_id, **update_data
            )
            if ticket is None:
                return None
            result = _idea_ticket_to_dict(ticket)
    except ValueError as exc:
        return {"error": str(exc)}
    return result


@notify_on_success
async def delete_idea_ticket(ticket_id: str) -> dict | None:
    """Delete an idea ticket by its ID. Returns {"deleted": true} if successful, None if not found.

    If the idea was previously promoted to a Kanban ticket, the linked ticket is NOT deleted.
    """
    async with async_session() as session:
        deleted = await svc_idea_tickets.delete_idea_ticket(session, ticket_id)
        if not deleted:
            return None
        return {"deleted": True}


@notify_on_success
async def update_idea_status(
    ticket_id: str,
    new_status: Literal["raw", "brewing", "validated", "approved", "dropped"],
    reason: str | None = None,
) -> dict | None:
    """Transition an idea ticket to a new status.

    Allowed transitions:
    raw → brewing | dropped
    brewing → validated | raw | dropped
    validated → approved | brewing | dropped
    approved → dropped
    dropped → raw

    Args:
        ticket_id: The idea ticket ID (e.g. 'IDEA-1')
        new_status: Target status
        reason: Optional reason for the transition (appended to activity trail)

    Returns the updated idea ticket, or {"error": ...} if transition is invalid.
    """
    if new_status not in _VALID_IDEA_STATUSES:
        return {
            "error": f"Invalid status '{new_status}'. Must be one of: {', '.join(sorted(_VALID_IDEA_STATUSES))}"
        }
    try:
        async with async_session() as session:
            ticket = await svc_idea_tickets.update_idea_status(
                session, ticket_id, new_status=new_status, reason=reason
            )
            result = _idea_ticket_to_dict(ticket)
    except ValueError as exc:
        return {"error": str(exc)}
    return result


@notify_on_success
async def promote_idea_to_ticket(
    idea_ticket_id: str,
    project_id: str,
    title: str | None = None,
    type_: Literal["bug", "feature", "task", "chore"] = "feature",
    priority: Literal["low", "medium", "high", "critical"] = "medium",
) -> dict | None:
    """Promote an approved idea ticket to a real Kanban ticket.

    Requirements:
    - idea_status must be 'approved'
    - problem_statement must be set and non-empty
    - idea must not have been previously promoted

    Args:
        idea_ticket_id: The idea ticket ID (e.g. 'IDEA-1')
        project_id: The target project UUID
        title: Optional override for the ticket title (defaults to idea title)
        type_: bug | feature | task | chore (default: feature)
        priority: low | medium | high | critical (default: medium)

    Returns the newly created Kanban ticket, or {"error": ...} on failure.
    """
    try:
        async with async_session() as session:
            new_ticket = await svc_idea_tickets.promote_idea_to_ticket(
                session,
                idea_ticket_id=idea_ticket_id,
                project_id=project_id,
                title=title,
                type_=type_,
                priority=priority,
            )
            result = _ticket_to_dict(new_ticket)
    except ValueError as exc:
        return {"error": str(exc)}
    return result


@notify_on_success
async def add_assumption(ticket_id: str, text: str) -> dict | None:
    """Add an assumption to an idea ticket.

    Args:
        ticket_id: The idea ticket ID (e.g. 'IDEA-1')
        text: The assumption text (max 500 chars)

    Returns the updated idea ticket, or {"error": ...} on failure.
    """
    if not text or not text.strip():
        return {"error": "text cannot be empty"}
    try:
        async with async_session() as session:
            ticket = await svc_idea_tickets.add_assumption(session, ticket_id, text)
            result = _idea_ticket_to_dict(ticket)
    except ValueError as exc:
        return {"error": str(exc)}
    return result


@notify_on_success
async def update_assumption_status(
    ticket_id: str,
    assumption_id: str,
    status: Literal["untested", "validated", "invalidated"],
) -> dict | None:
    """Update the status of an assumption on an idea ticket.

    Args:
        ticket_id: The idea ticket ID (e.g. 'IDEA-1')
        assumption_id: The UUID of the assumption to update
        status: New status — untested | validated | invalidated

    Returns the updated idea ticket, or {"error": ...} on failure.
    """
    try:
        async with async_session() as session:
            ticket = await svc_idea_tickets.update_assumption_status(
                session, ticket_id, assumption_id, status
            )
            result = _idea_ticket_to_dict(ticket)
    except ValueError as exc:
        return {"error": str(exc)}
    return result


@notify_on_success
async def delete_assumption(ticket_id: str, assumption_id: str) -> dict | None:
    """Delete an assumption from an idea ticket by its ID.

    Args:
        ticket_id: The idea ticket ID (e.g. 'IDEA-1')
        assumption_id: The UUID of the assumption to delete

    Returns the updated idea ticket, or {"error": ...} on failure.
    """
    try:
        async with async_session() as session:
            ticket = await svc_idea_tickets.delete_assumption(
                session, ticket_id, assumption_id
            )
            result = _idea_ticket_to_dict(ticket)
    except ValueError as exc:
        return {"error": str(exc)}
    return result


def register(mcp: FastMCP) -> None:
    """Register all Kanban MCP tools with the given FastMCP instance."""
    mcp.tool()(list_projects)
    mcp.tool()(create_project)
    mcp.tool()(list_tickets)
    mcp.tool()(create_ticket)
    mcp.tool()(get_ticket)
    mcp.tool()(update_ticket_status)
    mcp.tool()(update_ticket)
    mcp.tool()(add_comment)
    mcp.tool()(add_work_log)
    mcp.tool()(add_test_case)
    mcp.tool()(update_test_case)
    mcp.tool()(create_child_ticket)
    mcp.tool()(add_acceptance_criterion)
    mcp.tool()(toggle_acceptance_criterion)
    mcp.tool()(delete_acceptance_criterion)
    mcp.tool()(list_members)
    mcp.tool()(add_member)
    mcp.tool()(remove_member)
    mcp.tool()(list_idea_tickets)
    mcp.tool()(create_idea_ticket)
    mcp.tool()(get_idea_ticket)
    mcp.tool()(update_idea_ticket)
    mcp.tool()(delete_idea_ticket)
    mcp.tool()(update_idea_status)
    mcp.tool()(promote_idea_to_ticket)
    mcp.tool()(add_assumption)
    mcp.tool()(update_assumption_status)
    mcp.tool()(delete_assumption)
