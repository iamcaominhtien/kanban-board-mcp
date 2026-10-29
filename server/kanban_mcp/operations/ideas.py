"""Idea Space operations (separate from tickets: rough ideas that can be promoted to a ticket)."""

import services.idea_tickets as svc_idea_tickets
from models import IDEA_COLORS, IDEA_STATUSES, IdeaTicketRead
from pydantic import Field
from typing import Annotated, Literal
from .. import common
from ..common import (
    Priority,
    ProjectId,
    TicketType,
    _idea_ticket_to_dict,
    _missing_idea,
    _ticket_to_dict,
    notify_on_success,
)


_UNSET = object()
_VALID_IDEA_STATUSES = frozenset(IDEA_STATUSES)
_VALID_IDEA_COLORS = frozenset(IDEA_COLORS)
IdeaId = Annotated[str, Field(description="Idea ticket ID such as 'IDEA-3'.")]
IdeaStatus = Literal["draft", "in_review", "approved", "dropped"]
IdeaColor = Literal["yellow", "orange", "lime", "pink", "blue", "purple", "teal"]
IdeaEnergy = Literal["seed", "concept", "hot", "big_bet"]
AssumptionStatus = Literal["untested", "validated", "invalidated"]


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
    async with common.async_session() as session:
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
    async with common.async_session() as session:
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
    async with common.async_session() as session:
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
    async with common.async_session() as session:
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
    async with common.async_session() as session:
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
    async with common.async_session() as session:
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
    async with common.async_session() as session:
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
    async with common.async_session() as session:
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
    async with common.async_session() as session:
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
    async with common.async_session() as session:
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
    async with common.async_session() as session:
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
    async with common.async_session() as session:
        ticket = await svc_idea_tickets.delete_microthought(
            session, ticket_id, microthought_id
        )
        return _idea_ticket_to_dict(ticket)


async def get_idea_activity_trail(ticket_id: IdeaId) -> list[dict]:
    """The idea's change history (status moves with reasons, edits, promotion), newest first: [{id, label, at}]."""
    async with common.async_session() as session:
        ticket = await svc_idea_tickets.get_idea_ticket(session, ticket_id)
        if ticket is None:
            raise _missing_idea(ticket_id)
        read = IdeaTicketRead.from_idea_ticket(ticket)
        return list(reversed(read.activity_trail))
