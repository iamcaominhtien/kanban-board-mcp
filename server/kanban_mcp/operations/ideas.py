"""Idea Space operations for AI agents: read ideas and their assumptions, and add to the Inbox.

An AI member can only suggest: it cannot move, edit, merge, archive, delete or promote an idea. A person does
that in the app (design: "AI only suggests").
"""

from typing import Annotated, Literal

from pydantic import Field

from services import activity as svc_activity
import services.idea_space as svc_space
import services.idea_tickets as svc_idea_tickets
from models import idea_readiness
from .. import common
from ..common import (
    _idea_ticket_to_dict,
    _missing_idea,
    notify_on_success,
)

IdeaId = Annotated[str, Field(description="Idea ID such as 'IDEA-3'.")]
IdeaStage = Literal[
    "inbox", "exploring", "ready", "building", "parked", "shipped", "archived"
]


async def list_idea_tickets(
    project_id: Annotated[
        str | None,
        Field(
            description="Only this project's ideas. Omit for ideas of every project and of no project."
        ),
    ] = None,
    stage: Annotated[
        IdeaStage | None, Field(description="Only ideas in this stage.")
    ] = None,
    q: Annotated[
        str | None, Field(description="Words that must all appear in the idea.")
    ] = None,
) -> list[dict]:
    """List ideas (Idea Space), the ones closest to ready first. Ideas go through the stages inbox, exploring, ready,
    building, parked, shipped and archived; only people move them."""
    async with common.async_session() as session:
        ideas = await svc_space.list_ideas(
            session,
            project_id=project_id,
            scope="project" if project_id else "all",
            stages=[stage] if stage else None,
            q=q,
        )
        return [_idea_ticket_to_dict(i) for i in ideas]


async def get_idea_ticket(ticket_id: IdeaId) -> dict:
    """Get one idea in full: its page text, stage, votes, readiness and assumptions with their impact, status
    and evidence. Its change history is separate: get_idea_activity_trail."""
    async with common.async_session() as session:
        idea = await svc_idea_tickets.get_idea_ticket(session, ticket_id)
        if idea is None:
            raise _missing_idea(ticket_id)
        return _idea_ticket_to_dict(idea)


async def list_idea_assumptions(ticket_id: IdeaId) -> dict:
    """The assumptions of an idea ("what must be true") with impact if wrong (low/medium/high), status (untested,
    testing, validated, disproved), evidence and test ticket, and the idea's readiness."""
    async with common.async_session() as session:
        idea = await svc_idea_tickets.get_idea_ticket(session, ticket_id)
        if idea is None:
            raise _missing_idea(ticket_id)
        data = _idea_ticket_to_dict(idea)
        return {
            "idea": idea.id,
            "readiness": idea_readiness(idea.assumption_records),
            "assumptions": data["assumptions"],
        }


@notify_on_success
async def create_idea_ticket(
    title: Annotated[str, Field(description="Short idea title.")],
    description: Annotated[
        str,
        Field(
            description="Markdown: what the idea is and why. Quote what prompted it."
        ),
    ] = "",
    project_id: Annotated[
        str | None,
        Field(
            description="Project UUID from get_projects. Omit if you do not know: the idea then belongs to no project."
        ),
    ] = None,
    why: Annotated[
        str | None,
        Field(
            description="One line: why you are suggesting this (shown to people next to your name)."
        ),
    ] = None,
    ticket_id: Annotated[
        str | None,
        Field(description="The ticket you were working on when you thought of it."),
    ] = None,
    tags: Annotated[list[str] | None, Field(description="Free-form labels.")] = None,
) -> dict:
    """Suggest an idea: it lands in the Inbox of the Idea Space for a person to sort (keep, park, merge or archive).
    Use it instead of widening a ticket's scope. It is marked as suggested by AI with your reason; you cannot move,
    edit or archive ideas afterwards. Returns the idea (id 'IDEA-<n>')."""
    author = svc_activity.current_actor()
    ref = {"kind": "ai", "by": author, "why": why or ""}
    if ticket_id:
        ref.update({"kind": "ticket", "id": ticket_id, "label": ticket_id})
    async with common.async_session() as session:
        idea = await svc_idea_tickets.create_idea_ticket(
            session,
            project_id=project_id,
            title=title,
            description=description,
            tags=tags or [],
            source="ai",
            source_ref=ref,
            author=author,
        )
        return _idea_ticket_to_dict(idea)


async def get_idea_activity_trail(ticket_id: IdeaId) -> list[dict]:
    """The idea's change history (stage moves, assumptions, evidence, edits; who did it), newest first."""
    async with common.async_session() as session:
        idea = await svc_idea_tickets.get_idea_ticket(session, ticket_id)
        if idea is None:
            raise _missing_idea(ticket_id)
        return svc_space.activity(idea)
