import json
import random
from datetime import datetime, timezone
from functools import wraps
from typing import Literal

import events as board_events
from mcp.server.fastmcp import FastMCP
from pydantic import ValidationError
from sqlalchemy import text
from sqlalchemy.exc import NoResultFound
from sqlmodel import select

import services.members as svc_members
import services.projects as svc_projects
import services.tickets as svc_tickets
from database import async_session
from models import (
    BoardType,
    IdeaColor,
    IdeaStatus,
    MemberRead,
    Project,
    ProjectCreate,
    ProjectRead,
    Ticket,
    TicketRead,
    TicketUpdate,
)


def _ticket_to_dict(ticket: Ticket) -> dict:
    """Serialize a Ticket to dict, including idea board fields."""
    base = TicketRead.from_ticket(ticket).model_dump()
    base["board"] = ticket.board.value if ticket.board else BoardType.main.value
    base["idea_status"] = ticket.idea_status.value if ticket.idea_status else None
    base["idea_emoji"] = ticket.idea_emoji
    base["idea_color"] = ticket.idea_color.value if ticket.idea_color else None
    base["origin_idea_id"] = ticket.origin_idea_id
    return base


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


VALID_IDEA_TRANSITIONS: dict[IdeaStatus, set[IdeaStatus]] = {
    IdeaStatus.draft: {IdeaStatus.approved, IdeaStatus.dropped},
    IdeaStatus.approved: {IdeaStatus.draft, IdeaStatus.dropped},
    IdeaStatus.dropped: set(),  # terminal
}


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
    board: str | None = None,
    status: str | None = None,
    priority: str | None = None,
    q: str | None = None,
) -> list[dict]:
    """List tickets for a project.

    board: 'main' (default) or 'idea'. Defaults to main-board tickets.
    Optionally filter by status (backlog/todo/in-progress/done),
    priority (low/medium/high/critical), or search text (q matches title).
    Returns list of full ticket objects.
    """
    # Validate board value
    if board is not None and board not in {b.value for b in BoardType}:
        raise ValueError(
            f"Invalid board '{board}'. Must be one of: {[b.value for b in BoardType]}"
        )

    effective_board = board or BoardType.main.value

    async with async_session() as session:
        tickets = await svc_tickets.list_tickets(
            session,
            project_id,
            status=status,
            priority=priority,
            q=q,
            include_wont_do=True,
        )
        # Filter by board (service doesn't support board filter yet)
        tickets = [
            t
            for t in tickets
            if (t.board.value if t.board else BoardType.main.value) == effective_board
        ]
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


async def list_idea_tickets(
    project_id: str,
    status: str | None = None,
) -> list[dict]:
    """List idea-board tickets for a project.

    project_id: The project's UUID.
    status: Optional filter by idea status ('draft', 'approved', 'dropped').
    Returns list of full ticket objects with idea fields.
    """
    async with async_session() as session:
        project = await session.get(Project, project_id)
        if project is None:
            raise ValueError(f"Project not found: {project_id}")

        if status is not None and status not in {s.value for s in IdeaStatus}:
            raise ValueError(
                f"Invalid status '{status}'. Must be one of: {[s.value for s in IdeaStatus]}"
            )

        stmt = select(Ticket).where(
            Ticket.project_id == project_id,
            Ticket.board == BoardType.idea,
        )
        if status is not None:
            stmt = stmt.where(Ticket.idea_status == status)
        result = await session.exec(stmt)
        tickets = list(result.all())
        return [_ticket_to_dict(t) for t in tickets]


async def create_idea_ticket(
    project_id: str,
    title: str,
    description: str = "",
    tags: list[str] | None = None,
    idea_emoji: str | None = None,
    idea_color: str | None = None,
) -> dict | None:
    """Create a new idea-board ticket.

    project_id: The project's UUID.
    title: Required, non-empty, max 255 chars.
    description: Optional markdown description.
    tags: Optional list of tag strings.
    idea_emoji: Optional single emoji (trimmed to first char). Defaults to 💡.
    idea_color: Optional accent color ('yellow','orange','lime','pink','blue','purple','teal').
                Randomly chosen if not provided.
    Returns the created ticket dict.
    """
    async with async_session() as session:
        project = await session.get(Project, project_id)
        if project is None:
            raise ValueError(f"Project not found: {project_id}")

        if not title or not title.strip():
            raise ValueError("title is required and must be non-empty")
        if len(title) > 255:
            raise ValueError("title must be 255 characters or fewer")

        if idea_color is not None and idea_color not in {c.value for c in IdeaColor}:
            raise ValueError(
                f"Invalid idea_color '{idea_color}'. Must be one of: {[c.value for c in IdeaColor]}"
            )

        # Resolve emoji and color
        resolved_emoji = (idea_emoji[0] if idea_emoji else None) or "\U0001f4a1"  # 💡
        resolved_color = (
            IdeaColor(idea_color) if idea_color else random.choice(list(IdeaColor))
        )

        # Increment counter and get ticket ID
        ticket_id = await _next_ticket_id(session, project_id)

        ticket = Ticket(
            id=ticket_id,
            project_id=project_id,
            title=title.strip(),
            description=description,
            tags=json.dumps(tags or []),
            status="backlog",
            board=BoardType.idea,
            idea_status=IdeaStatus.draft,
            idea_emoji=resolved_emoji,
            idea_color=resolved_color,
        )
        session.add(ticket)
        await session.commit()
        await session.refresh(ticket)
        result_dict = _ticket_to_dict(ticket)

    await board_events.publish(board_events.IDEA_TICKET_CREATED)
    return result_dict


async def update_idea_ticket(
    ticket_id: str,
    title: str | None = None,
    description: str | None = None,
    tags: list[str] | None = None,
    idea_emoji: str | None = None,
    idea_color: str | None = None,
    idea_status: str | None = None,
) -> dict | None:
    """Update an idea-board ticket. Only provided (non-None) fields are changed.

    ticket_id: The ticket ID (e.g. 'IAM-5').
    title/description/tags: Content fields — locked when idea_status='approved'.
    idea_emoji: Trimmed to first character.
    idea_color: One of: yellow, orange, lime, pink, blue, purple, teal.
    idea_status: One of: draft, approved, dropped.

    Status transitions: draft→approved, draft→dropped, approved→draft, approved→dropped.
    dropped is terminal (no transitions out).
    Returns the updated ticket dict or None if not found.
    """
    if idea_color is not None and idea_color not in {c.value for c in IdeaColor}:
        raise ValueError(
            f"Invalid idea_color '{idea_color}'. Must be one of: {[c.value for c in IdeaColor]}"
        )
    if idea_status is not None and idea_status not in {s.value for s in IdeaStatus}:
        raise ValueError(
            f"Invalid idea_status '{idea_status}'. Must be one of: {[s.value for s in IdeaStatus]}"
        )

    async with async_session() as session:
        ticket = await session.get(Ticket, ticket_id)
        if ticket is None:
            return None
        if ticket.board != BoardType.idea:
            raise ValueError(f"Ticket '{ticket_id}' is not an idea-board ticket")

        current_status = ticket.idea_status

        # Lock enforcement: approved ideas are locked for content edits
        content_fields_provided = any(v is not None for v in (title, description, tags))
        if current_status == IdeaStatus.approved and content_fields_provided:
            raise ValueError(
                "This idea is approved and locked. Promote it or move it back to draft to edit."
            )

        # Validate status transition
        if idea_status is not None:
            new_status = IdeaStatus(idea_status)
            if new_status not in VALID_IDEA_TRANSITIONS.get(current_status, set()):
                raise ValueError(
                    f"Invalid status transition: {current_status.value} → {new_status.value}"
                )
            ticket.idea_status = new_status

        if title is not None:
            ticket.title = title
        if description is not None:
            ticket.description = description
        if tags is not None:
            ticket.tags = json.dumps(tags)
        if idea_emoji is not None:
            ticket.idea_emoji = idea_emoji[0]
        if idea_color is not None:
            ticket.idea_color = IdeaColor(idea_color)

        ticket.updated_at = _now_iso()

        session.add(ticket)
        await session.commit()
        await session.refresh(ticket)
        result_dict = _ticket_to_dict(ticket)

    await board_events.publish(board_events.IDEA_TICKET_UPDATED)
    return result_dict


async def promote_idea_ticket(ticket_id: str) -> dict:
    """Promote an approved idea to a main-board ticket.

    The idea must be in 'approved' state. Creates a new main-board ticket
    copying title, description, and tags. The idea ticket is then marked
    as 'dropped' (consumed — it is no longer active).
    origin_idea_id on the new ticket records the source idea.

    Returns: {promoted_ticket_id, idea_ticket_id, promoted_ticket}.
    """
    async with async_session() as session:
        try:
            ticket = await session.get(Ticket, ticket_id)
            if ticket is None:
                raise ValueError(f"Ticket not found: {ticket_id}")
            if ticket.board != BoardType.idea:
                raise ValueError(f"Ticket '{ticket_id}' is not an idea-board ticket")
            if ticket.idea_status != IdeaStatus.approved:
                raise ValueError("Idea must be in approved state to promote")

            # Increment counter for new main ticket
            new_ticket_id = await _next_ticket_id(session, ticket.project_id)

            new_ticket = Ticket(
                id=new_ticket_id,
                project_id=ticket.project_id,
                title=ticket.title,
                description=ticket.description,
                tags=ticket.tags,
                status="backlog",
                board=BoardType.main,
                origin_idea_id=ticket_id,
            )
            session.add(new_ticket)

            # Mark idea as dropped (consumed — promoted ideas are no longer active)
            # NOTE: We use 'dropped' here because IdeaStatus has no 'promoted' state.
            # The link back to this idea is preserved via origin_idea_id on the new ticket.
            ticket.idea_status = IdeaStatus.dropped
            ticket.updated_at = _now_iso()
            session.add(ticket)

            await session.commit()
            await session.refresh(new_ticket)
            await session.refresh(ticket)

            result_dict = {
                "promoted_ticket_id": new_ticket_id,
                "idea_ticket_id": ticket_id,
                "promoted_ticket": _ticket_to_dict(new_ticket),
            }
        except Exception:
            await session.rollback()
            raise

    await board_events.publish(board_events.IDEA_TICKET_PROMOTED)
    return result_dict


async def drop_idea_ticket(ticket_id: str) -> dict | None:
    """Drop (discard) an idea-board ticket.

    Rejects if the idea is already dropped.
    Returns the updated ticket dict or None if not found.
    """
    async with async_session() as session:
        ticket = await session.get(Ticket, ticket_id)
        if ticket is None:
            return None
        if ticket.board != BoardType.idea:
            raise ValueError(f"Ticket '{ticket_id}' is not an idea-board ticket")
        if ticket.idea_status == IdeaStatus.dropped:
            raise ValueError("Idea is already dropped")

        ticket.idea_status = IdeaStatus.dropped
        ticket.updated_at = _now_iso()
        session.add(ticket)
        await session.commit()
        await session.refresh(ticket)
        result_dict = _ticket_to_dict(ticket)

    await board_events.publish(board_events.IDEA_TICKET_DROPPED)
    return result_dict


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
    mcp.tool()(list_idea_tickets)
    mcp.tool()(create_idea_ticket)
    mcp.tool()(update_idea_ticket)
    mcp.tool()(promote_idea_ticket)
    mcp.tool()(drop_idea_ticket)
