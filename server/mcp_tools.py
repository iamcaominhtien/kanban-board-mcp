from typing import Literal

from mcp.server.fastmcp import FastMCP
from pydantic import ValidationError
from sqlalchemy.exc import NoResultFound

import services.projects as svc_projects
import services.tickets as svc_tickets
from database import async_session
from models import ProjectCreate, ProjectRead, TicketRead, TicketUpdate


async def list_projects() -> list[dict]:
    """List all projects on the Kanban board. Returns id, name, prefix, color, ticket_counter."""
    async with async_session() as session:
        projects = await svc_projects.list_projects(session)
        return [ProjectRead.model_validate(p).model_dump() for p in projects]


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
        return ProjectRead.model_validate(project).model_dump()


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
            return TicketRead.from_ticket(ticket).model_dump()
    except NoResultFound:
        raise ValueError(f"Project not found: {project_id}")


async def get_ticket(ticket_id: str) -> dict | None:
    """Get the full details of a ticket by its ID (e.g. 'IAM-1').

    Returns the ticket or None if not found.
    """
    async with async_session() as session:
        ticket = await svc_tickets.get_ticket(session, ticket_id)
        if ticket is None:
            return None
        return TicketRead.from_ticket(ticket).model_dump()


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
            return TicketRead.from_ticket(ticket).model_dump()
    except ValidationError as exc:
        raise ValueError(str(exc)) from exc


def register(mcp: FastMCP) -> None:
    """Register all Kanban MCP tools with the given FastMCP instance."""
    mcp.tool()(list_projects)
    mcp.tool()(create_project)
    mcp.tool()(list_tickets)
    mcp.tool()(create_ticket)
    mcp.tool()(get_ticket)
    mcp.tool()(update_ticket_status)
