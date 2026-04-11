import json
from functools import wraps
from typing import Literal

import events as board_events
from mcp.server.fastmcp import FastMCP
from pydantic import ValidationError
from sqlalchemy.exc import NoResultFound

import services.members as svc_members
import services.projects as svc_projects
import services.tickets as svc_tickets
from database import async_session
from models import MemberRead, ProjectCreate, ProjectRead, TicketRead, TicketUpdate


def notify_on_success(func):
    """Decorator that publishes an SSE invalidation event after a successful mutation."""

    @wraps(func)
    async def wrapper(*args, **kwargs):
        result = await func(*args, **kwargs)
        await board_events.publish("invalidate")
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
            session, project_id, status=status, priority=priority, q=q
        )
        return [TicketRead.from_ticket(t).model_dump() for t in tickets]


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
