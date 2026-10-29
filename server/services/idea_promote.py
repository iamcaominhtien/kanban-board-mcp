"""Promote an idea to a ticket, and keep the idea and its ticket in step afterwards.

Design: `design/screens/idea-promote-migration.md`. The idea stays where it is, links to the ticket and follows
its status; the ticket is an ordinary ticket with a small mark (`from_idea_id`).
"""

import json
import uuid
from typing import Any

from sqlmodel import select
from sqlmodel.ext.asyncio.session import AsyncSession

from models import IdeaAssumption, IdeaTicket, Project, Ticket, idea_readiness
from services import idea_space as space
from services.idea_tickets import DEFAULT_AUTHOR, add_trail
from services.tickets import create_ticket as svc_create_ticket

PROMOTABLE_STAGES = ("inbox", "exploring", "ready")
MAX_SUB_TICKETS = 10
TICKET_TYPES = ("bug", "feature", "task", "chore")
PRIORITIES = ("low", "medium", "high", "critical")


def _tags(idea: IdeaTicket) -> list:
    try:
        parsed = json.loads(idea.tags) if idea.tags else []
    except ValueError:
        return []
    return parsed if isinstance(parsed, list) else []


def demand_note(idea: IdeaTicket) -> str | None:
    """ "4 people want this", or None when nobody voted."""
    n = len(idea.vote_records)
    return None if n == 0 else f"{n} {'person wants' if n == 1 else 'people want'} this"


def _split_assumptions(idea: IdeaTicket) -> dict[str, list]:
    groups: dict[str, list] = {"open": [], "validated": [], "disproved": []}
    for a in idea.assumption_records:
        key = "open" if a.status in ("untested", "testing") else a.status
        groups[key].append(a)
    return groups


def build_description(idea: IdeaTicket) -> str:
    """The ticket text built from the idea: its page, what was already confirmed, and where it came from."""
    groups = _split_assumptions(idea)
    parts = [(idea.body or idea.description or idea.title).strip()]
    if groups["validated"]:
        parts.append(
            "### Already confirmed\n\n"
            + "\n".join(f"- ✓ {a.text}" for a in groups["validated"])
        )
    footer = f"From idea {idea.id}"
    if demand_note(idea):
        footer += f" · {demand_note(idea)}"
    parts.append(f"_{footer}_")
    return "\n\n".join(parts)


async def preview(
    session: AsyncSession, idea_id: str, project_id: str | None = None
) -> dict[str, Any]:
    """What Promote would create, before anything is created (nothing is written).

    Args:
        idea_id: The idea.
        project_id: The project to create the ticket in; defaults to the idea's project.

    Returns:
        {can_promote, blockers [codes], already_promoted_ticket, not_ready {readiness} | None, project_id,
        draft {title, type, priority, status, description, checklist [..], confirmed [..], attachments [..],
        demand, split_suggestion []}, carried {…counts}, workspace {…}}.
    """
    idea = await space.get_or_raise(session, idea_id)
    target = project_id or idea.project_id
    groups = _split_assumptions(idea)
    blockers: list[str] = []
    existing = None
    if idea.promoted_to_ticket_id:
        found = await session.get(Ticket, idea.promoted_to_ticket_id)
        if found is not None:
            existing = {"id": found.id, "status": found.status}
            blockers.append("already_promoted")
    if idea.stage not in PROMOTABLE_STAGES and "already_promoted" not in blockers:
        blockers.append(f"stage_{idea.stage}")
    if target is None:
        blockers.append("needs_project")
    elif await session.get(Project, target) is None:
        blockers.append("project_missing")
    readiness = idea_readiness(idea.assumption_records)
    evidence = space.list_evidence(idea)
    attachments = [e for e in evidence if e["kind"] in ("file", "sketch", "diagram")]
    return {
        "can_promote": not blockers,
        "blockers": blockers,
        "already_promoted_ticket": existing,
        "not_ready": readiness if readiness["state"] != "ready" else None,
        "readiness": readiness,
        "project_id": target,
        "draft": {
            "title": idea.title,
            "type": "feature",
            "priority": "medium",
            "status": "backlog",
            "description": build_description(idea),
            "checklist": [
                {
                    "assumption_id": a.id,
                    "text": a.text,
                    "test_ticket_id": a.test_ticket_id,
                    "status": a.status,
                }
                for a in groups["open"]
            ],
            "confirmed": [a.text for a in groups["validated"]],
            "attachments": attachments,
            "demand": demand_note(idea),
            "split_suggestion": [],
        },
        "carried": {
            "open_assumptions": len(groups["open"]),
            "validated_assumptions": len(groups["validated"]),
            "disproved_assumptions": len(groups["disproved"]),
            "evidence": len(evidence),
            "votes": len(idea.vote_records),
            "log_entries": len(idea.log_records),
        },
    }


async def promote(
    session: AsyncSession,
    idea_id: str,
    *,
    project_id: str | None = None,
    title: str | None = None,
    type: str = "feature",
    priority: str = "medium",
    status: str = "backlog",
    description: str | None = None,
    sub_tickets: list[str] | None = None,
    acknowledge_not_ready: bool = False,
    author: str | None = DEFAULT_AUTHOR,
) -> tuple[IdeaTicket, Ticket, list[Ticket]]:
    """Create the ticket (and, for a split, its sub-tickets) from an idea and make the idea Building.

    Open assumptions become the ticket's checklist; validated ones an "Already confirmed" list. The idea is not
    changed otherwise: it keeps its page, log and activity and links to the ticket. An idea with no project gets
    the project the ticket is created in.

    Args:
        project_id: Where to create the ticket; defaults to the idea's project.
        title: Ticket title; defaults to the idea's.
        description: Ticket text; defaults to the one built from the idea.
        sub_tickets: Titles of sub-tickets for "Ticket with sub-tickets" (the ticket becomes their parent).
        acknowledge_not_ready: The person ticked "I understand, promote anyway".
        author: A person; an AI member is never allowed to promote (the MCP tools do not offer it).

    Returns:
        (idea, ticket, sub_tickets).

    Raises:
        IdeaRuleError: With `already_promoted`, `bad_stage`, `needs_project`, `not_ready`, `too_many_sub_tickets`.
        ValueError: If the project does not exist or a value is invalid.
    """
    if type not in TICKET_TYPES:
        raise ValueError(f"type must be one of: {', '.join(TICKET_TYPES)}")
    if priority not in PRIORITIES:
        raise ValueError(f"priority must be one of: {', '.join(PRIORITIES)}")
    sub_tickets = [t.strip() for t in (sub_tickets or []) if t.strip()]
    if len(sub_tickets) > MAX_SUB_TICKETS:
        raise space.IdeaRuleError(
            "too_many_sub_tickets", f"At most {MAX_SUB_TICKETS} sub-tickets"
        )
    idea = await space.get_or_raise(session, idea_id)
    if (
        idea.promoted_to_ticket_id
        and await session.get(Ticket, idea.promoted_to_ticket_id) is not None
    ):
        raise space.IdeaRuleError(
            "already_promoted",
            f"This idea became {idea.promoted_to_ticket_id}. Open it instead.",
            ticket_id=idea.promoted_to_ticket_id,
        )
    if idea.stage not in PROMOTABLE_STAGES:
        raise space.IdeaRuleError(
            "bad_stage", f"An idea that is {idea.stage} cannot be promoted"
        )
    target = project_id or idea.project_id
    if target is None:
        raise space.IdeaRuleError(
            "needs_project", "Choose a project to promote this idea"
        )
    if await session.get(Project, target) is None:
        raise ValueError(f"Project '{target}' not found")
    readiness = idea_readiness(idea.assumption_records)
    if readiness["state"] != "ready" and not acknowledge_not_ready:
        raise space.IdeaRuleError(
            "not_ready",
            "Not every high-impact assumption is validated yet",
            readiness=readiness,
        )

    groups = _split_assumptions(idea)
    ticket = await svc_create_ticket(
        session,
        project_id=target,
        title=(title or idea.title),
        description=description if description is not None else build_description(idea),
        type=type,
        priority=priority,
        status=status,
        tags=[str(t) for t in _tags(idea)],
    )
    ticket = await session.get(Ticket, ticket.id)
    ticket.from_idea_id = idea.id
    checklist = []
    for a in groups["open"]:
        text = a.text + (f" (test {a.test_ticket_id})" if a.test_ticket_id else "")
        checklist.append({"id": str(uuid.uuid4()), "text": text[:300], "done": False})
    ticket.sub_tasks = json.dumps(checklist)
    session.add(ticket)
    children = []
    for child_title in sub_tickets:
        child = await svc_create_ticket(
            session,
            project_id=target,
            title=child_title,
            type=type,
            priority=priority,
            status=status,
            parent_id=ticket.id,
        )
        child = await session.get(Ticket, child.id)
        child.from_idea_id = idea.id
        session.add(child)
        children.append(child)

    idea = await space.get_or_raise(session, idea_id)
    now = space._now()
    before = idea.stage
    if idea.project_id is None:
        idea.project_id = target
        add_trail(
            idea,
            f"Project: no project → {target}",
            now,
            author,
            kind="project",
            meta={"from": None, "to": target},
        )
    idea.promoted_to_ticket_id = ticket.id
    idea.promoted_at = now
    idea.former_ticket_id = None
    idea.stage = "building"
    idea.idea_status = "approved"
    idea.stage_changed_at = now
    idea.park_until = None
    add_trail(
        idea,
        f"Promoted to ticket {ticket.id}",
        now,
        author,
        kind="stage",
        meta={"from": before, "to": "building", "ticket": ticket.id},
    )
    idea = await space._save(session, idea)
    await session.refresh(ticket)
    return idea, ticket, children


# ── keeping the idea and its ticket in step ────────────────────────────────


async def _ideas_of_ticket(session: AsyncSession, ticket_id: str) -> list[IdeaTicket]:
    result = await session.exec(
        select(IdeaTicket).where(IdeaTicket.promoted_to_ticket_id == ticket_id)
    )
    return list(result.all())


async def on_ticket_status_change(
    session: AsyncSession, ticket: Ticket, previous_status: str
) -> None:
    """Follow a ticket's status: Done ships the idea, Won't do returns it to Exploring, reopening restores it.

    Called by the ticket service before it commits; this function does not commit.
    """
    new = ticket.status
    if new == previous_status:
        return
    now = space._now()
    for idea in await _ideas_of_ticket(session, ticket.id):
        if new == "done" and idea.stage == "building":
            idea.stage, idea.idea_status = "shipped", "approved"
            idea.shipped_at = idea.stage_changed_at = now
            add_trail(
                idea,
                f"{ticket.id} is Done: shipped",
                now,
                "system",
                kind="stage",
                meta={"from": "building", "to": "shipped", "ticket": ticket.id},
            )
        elif new == "wont_do" and idea.stage in ("building", "shipped"):
            idea.stage, idea.idea_status = "exploring", "in_review"
            idea.stage_changed_at = now
            idea.former_ticket_id = ticket.id
            idea.promoted_to_ticket_id = None
            idea.promoted_at = None
            add_trail(
                idea,
                f"{ticket.id} was dropped: back to Exploring. Try again, park or archive.",
                now,
                "system",
                kind="stage",
                meta={"from": "building", "to": "exploring", "ticket": ticket.id},
            )
        elif (
            previous_status == "done"
            and new not in ("done", "wont_do")
            and idea.stage == "shipped"
        ):
            idea.stage, idea.idea_status = "building", "approved"
            idea.stage_changed_at = now
            idea.shipped_at = None
            add_trail(
                idea,
                f"{ticket.id} was reopened: building again",
                now,
                "system",
                kind="stage",
                meta={"from": "shipped", "to": "building", "ticket": ticket.id},
            )
        else:
            continue
        idea.updated_at = now
        session.add(idea)
    await _note_test_ticket_closed(session, ticket, now)


async def _note_test_ticket_closed(
    session: AsyncSession, ticket: Ticket, now: str
) -> None:
    """Tell the idea that a ticket testing one of its assumptions was closed, so the UI can ask what it showed."""
    if ticket.status not in ("done", "wont_do"):
        return
    rows = (
        await session.exec(
            select(IdeaAssumption).where(IdeaAssumption.test_ticket_id == ticket.id)
        )
    ).all()
    for a in rows:
        idea = await session.get(IdeaTicket, a.idea_id)
        if idea is None:
            continue
        add_trail(
            idea,
            f"Test ticket {ticket.id} was closed: was “{a.text[:60]}” validated or disproved?",
            now,
            "system",
            kind="assumption",
            meta={"assumption": a.id, "ticket": ticket.id, "asks": True},
        )
        session.add(idea)


async def on_ticket_deleted(session: AsyncSession, ticket: Ticket) -> None:
    """A ticket was deleted: its idea goes back to Ready with the link cleared (it can be promoted again);
    an assumption that was tested by it loses the link. Does not commit."""
    now = space._now()
    for idea in await _ideas_of_ticket(session, ticket.id):
        idea.stage, idea.idea_status = "ready", "approved"
        idea.stage_changed_at = now
        idea.former_ticket_id = ticket.id
        idea.promoted_to_ticket_id = None
        idea.promoted_at = None
        idea.updated_at = now
        add_trail(
            idea,
            f"{ticket.id} was deleted: back to Ready. Promote again if you want.",
            now,
            "system",
            kind="stage",
            meta={"to": "ready", "ticket": ticket.id},
        )
        session.add(idea)
    rows = (
        await session.exec(
            select(IdeaAssumption).where(IdeaAssumption.test_ticket_id == ticket.id)
        )
    ).all()
    for a in rows:
        a.test_ticket_id = None
        if a.status == "testing":
            a.status = "untested"
        session.add(a)
