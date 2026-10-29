import json
import uuid
from datetime import datetime, timezone
from typing import Any

from sqlalchemy import text
from sqlmodel import select
from sqlmodel.ext.asyncio.session import AsyncSession

from models import (
    ASSUMPTION_IMPACTS,
    ASSUMPTION_STATUSES,
    IDEA_SOURCES,
    IDEA_STATUSES,
    IdeaAssumption,
    IdeaTicket,
    Project,
    Ticket,
)
from services.tickets import create_ticket as svc_create_ticket

UTC = timezone.utc
DEFAULT_AUTHOR = (
    "user"  # who an activity entry is credited to when the caller does not say
)


def _safe_json(value: str, fallback=None) -> list:
    if fallback is None:
        fallback = []
    try:
        return json.loads(value) if value else fallback
    except (json.JSONDecodeError, TypeError):
        return fallback


def _dumps(value: list) -> str:
    return json.dumps(value)


def _now_iso() -> str:
    return datetime.now(UTC).isoformat()


def _clamp(value: int, lo: int = 1, hi: int = 5) -> int:
    return max(lo, min(hi, value))


async def _get_idea_ticket_or_raise(
    session: AsyncSession, ticket_id: str
) -> IdeaTicket:
    ticket = await session.get(IdeaTicket, ticket_id)
    if ticket is None:
        raise ValueError(f"Idea ticket '{ticket_id}' not found")
    return ticket


async def _reload(session: AsyncSession, ticket_id: str) -> IdeaTicket:
    """Read the idea again, with its assumptions, evidence and votes as they are now."""
    result = await session.exec(
        select(IdeaTicket)
        .where(IdeaTicket.id == ticket_id)
        .execution_options(populate_existing=True)
    )
    return result.one()


def _add_trail(
    ticket: IdeaTicket, label: str, now: str, author: str | None = DEFAULT_AUTHOR
) -> None:
    """Append an activity entry (what happened, when, and who did it)."""
    trail = _safe_json(ticket.activity_trail)
    trail.append({"id": str(uuid.uuid4()), "label": label, "at": now, "author": author})
    ticket.activity_trail = _dumps(trail)


async def _trail_entry_and_save(
    session: AsyncSession,
    ticket: IdeaTicket,
    label: str,
    now: str,
    author: str | None = DEFAULT_AUTHOR,
) -> IdeaTicket:
    _add_trail(ticket, label, now, author)
    ticket.last_touched_at = now
    ticket.updated_at = now
    session.add(ticket)
    await session.commit()
    return await _reload(session, ticket.id)


_SKIP = object()  # sentinel: skip this field update


def _validate_idea_emoji(value: Any) -> str:
    emoji = str(value)
    if len(emoji.strip()) == 0:
        raise ValueError("idea_emoji cannot be empty")
    if len(emoji) > 8:
        raise ValueError("idea_emoji must be a single emoji character")
    return emoji


def _normalize_update_value(field: str, value: Any) -> Any:
    if field == "idea_emoji":
        if value is None:
            return _SKIP
        return _validate_idea_emoji(value)
    if field == "tags":
        return _dumps(value)
    if field in {"ice_impact", "ice_effort", "ice_confidence"}:
        return _clamp(int(value))
    return value


def _page_body(problem: str | None, description: str) -> str:
    """The idea page: the Problem heading, then the description."""
    parts = []
    if problem and problem.strip():
        parts.append(f"## Problem\n\n{problem.strip()}")
    if description and description.strip():
        parts.append(description.strip())
    return "\n\n".join(parts)


async def _next_idea_id(session: AsyncSession) -> str:
    result = await session.execute(
        text(
            "UPDATE idea_counter SET counter = counter + 1 WHERE id = 1 RETURNING counter"
        )
    )
    row = result.one()
    return f"IDEA-{row.counter}"


async def create_idea_ticket(
    session: AsyncSession,
    project_id: str,
    title: str,
    description: str = "",
    idea_color: str = "yellow",
    idea_emoji: str = "💡",
    idea_energy: str | None = None,
    tags: list | None = None,
    problem_statement: str | None = None,
    source: str = "manual",
    author: str | None = DEFAULT_AUTHOR,
) -> IdeaTicket:
    """Create an idea ticket with the next idea number.

    The idea starts in the Inbox. `project_id` may be None: the idea then belongs to no project yet.

    Args:
        project_id: Owning project.
        title: Idea title.
        description: Markdown description.
        idea_color: Card color from the allowed palette.
        idea_emoji: Emoji shown on the card.
        idea_energy: Optional effort/energy level.
        tags: Tag names.
        problem_statement: The problem the idea solves; required before promotion.
        source: Where the idea came from, one of IDEA_SOURCES.
        author: Who is credited for creating it in the activity.

    Returns:
        The created idea ticket.

    Raises:
        ValueError: If the emoji, source or project is not valid.
    """
    idea_emoji = _validate_idea_emoji(idea_emoji)
    if source not in IDEA_SOURCES:
        raise ValueError(
            f"Invalid source '{source}'. Must be one of: {', '.join(IDEA_SOURCES)}"
        )
    if project_id is not None and await session.get(Project, project_id) is None:
        raise ValueError(f"Project '{project_id}' not found")

    if tags is None:
        tags = []

    ticket_id = await _next_idea_id(session)
    now = _now_iso()

    activity_trail = [
        {"id": str(uuid.uuid4()), "label": "Idea created", "at": now, "author": author}
    ]

    ticket = IdeaTicket(
        id=ticket_id,
        project_id=project_id,
        title=title,
        description=description,
        idea_color=idea_color,
        idea_emoji=idea_emoji,
        idea_energy=idea_energy,
        tags=_dumps(tags),
        problem_statement=problem_statement,
        stage="inbox",
        source=source,
        body=_page_body(problem_statement, description),
        last_touched_at=now,
        activity_trail=_dumps(activity_trail),
        created_at=now,
        updated_at=now,
    )
    session.add(ticket)
    await session.commit()
    return await _reload(session, ticket.id)


async def wake_parked_ideas(
    session: AsyncSession, project_id: str | None = None
) -> int:
    """Return Parked ideas whose park-until date has come to the Inbox, once.

    Args:
        project_id: Only look at this project's ideas; None looks at all of them.

    Returns:
        How many ideas were woken.
    """
    today = datetime.now(UTC).date().isoformat()
    stmt = select(IdeaTicket).where(
        IdeaTicket.stage == "parked",
        IdeaTicket.park_until.is_not(None),
        IdeaTicket.park_until <= today,
    )
    if project_id is not None:
        stmt = stmt.where(IdeaTicket.project_id == project_id)
    woken = list((await session.exec(stmt)).all())
    if not woken:
        return 0
    now = _now_iso()
    for idea in woken:
        idea.stage = "inbox"
        idea.park_until = None
        idea.updated_at = now
        _add_trail(
            idea, "Back in the Inbox: the park-until date has come", now, "system"
        )
        session.add(idea)
    await session.commit()
    return len(woken)


async def get_idea_ticket(session: AsyncSession, ticket_id: str) -> IdeaTicket | None:
    """Return an idea ticket by id, or None. A Parked idea whose date has come is woken first."""
    ticket = await session.get(IdeaTicket, ticket_id)
    if ticket is not None and ticket.stage == "parked":
        if await wake_parked_ideas(session, ticket.project_id):
            ticket = await _reload(session, ticket.id)
    return ticket


async def list_idea_tickets(
    session: AsyncSession,
    project_id: str,
    idea_status: str | None = None,
    q: str | None = None,
) -> list[IdeaTicket]:
    """List a project's idea tickets.

    Args:
        project_id: Project to list.
        idea_status: Only ideas in this status.
        q: Case-insensitive text matched against title and description.

    Returns:
        Matching idea tickets.
    """
    await wake_parked_ideas(session, project_id)
    stmt = select(IdeaTicket).where(IdeaTicket.project_id == project_id)
    if idea_status is not None:
        stmt = stmt.where(IdeaTicket.idea_status == idea_status)
    if q is not None:
        escaped = q.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
        stmt = stmt.where(
            IdeaTicket.title.ilike(f"%{escaped}%", escape="\\")
            | IdeaTicket.description.ilike(f"%{escaped}%", escape="\\")
        )
    stmt = stmt.order_by(IdeaTicket.last_touched_at.desc())
    result = await session.exec(stmt)
    return list(result.all())


_UPDATABLE_FIELDS = {
    "title",
    "description",
    "idea_color",
    "idea_emoji",
    "idea_energy",
    "tags",
    "problem_statement",
    "ice_impact",
    "ice_effort",
    "ice_confidence",
    "revisit_date",
}


async def update_idea_ticket(
    session: AsyncSession,
    ticket_id: str,
    author: str | None = DEFAULT_AUTHOR,
    **fields: Any,
) -> IdeaTicket | None:
    """Apply field updates and log them; return None if the ticket is missing."""
    ticket = await session.get(IdeaTicket, ticket_id)
    if ticket is None:
        return None

    now = _now_iso()
    changed_field_names: list[str] = []

    for field, value in fields.items():
        if field not in _UPDATABLE_FIELDS:
            continue
        old_value = getattr(ticket, field)
        new_value = _normalize_update_value(field, value)
        if new_value is _SKIP:
            continue
        if old_value == new_value:
            continue
        changed_field_names.append(field)
        setattr(ticket, field, new_value)

    if {"description", "problem_statement"} & set(changed_field_names):
        ticket.body = _page_body(ticket.problem_statement, ticket.description)
    if changed_field_names:
        _add_trail(
            ticket, f"Fields updated: {', '.join(changed_field_names)}", now, author
        )
        ticket.updated_at = now

    ticket.last_touched_at = now

    session.add(ticket)
    await session.commit()
    return await _reload(session, ticket.id)


async def delete_idea_ticket(session: AsyncSession, ticket_id: str) -> bool:
    """Delete an idea ticket; return False if it does not exist."""
    if await session.get(IdeaTicket, ticket_id) is None:
        return False
    ticket = await _reload(
        session, ticket_id
    )  # delete what is stored, not what was cached
    await session.delete(ticket)
    await session.commit()
    return True


ALLOWED_TRANSITIONS: dict[str, set[str]] = {
    "draft": {"in_review", "dropped"},
    "in_review": {"approved", "draft", "dropped"},
    "approved": {"dropped"},
    "dropped": {"draft"},
}


# The stage an idea moves to when the current Idea board changes its status.
_STAGE_FOR_STATUS = {
    "draft": "exploring",
    "in_review": "exploring",
    "approved": "ready",
    "dropped": "archived",
}


async def update_idea_status(
    session: AsyncSession,
    ticket_id: str,
    new_status: str,
    reason: str | None = None,
    author: str | None = DEFAULT_AUTHOR,
) -> IdeaTicket:
    """Move an idea to a new status, recording the reason.

    Args:
        ticket_id: Idea to move.
        new_status: Target status.
        reason: Why the status changed.
        author: Who is credited for the change in the activity.

    Returns:
        The updated idea ticket.

    Raises:
        ValueError: If the idea does not exist, the status is invalid, the transition is not allowed,
            or the idea is Building and so cannot be dropped.
    """
    ticket = await session.get(IdeaTicket, ticket_id)
    if ticket is None:
        raise ValueError(f"Idea ticket '{ticket_id}' not found")
    if new_status not in IDEA_STATUSES:
        raise ValueError(
            f"Invalid status '{new_status}'. Must be one of: {', '.join(IDEA_STATUSES)}"
        )
    old_status = ticket.idea_status
    allowed = ALLOWED_TRANSITIONS.get(old_status, set())
    if new_status not in allowed:
        raise ValueError(f"Cannot transition from {old_status} to {new_status}")

    if new_status == "dropped" and ticket.stage == "building":
        raise ValueError(
            "Not allowed while the ticket is open. Close or remove the ticket first."
        )

    now = _now_iso()
    ticket.idea_status = new_status
    ticket.stage = _STAGE_FOR_STATUS[new_status]
    ticket.park_until = None
    ticket.archive_reason = (reason or "Dropped") if new_status == "dropped" else None
    ticket.updated_at = now
    ticket.last_touched_at = now

    label = f"Status changed: {old_status} → {new_status}"
    if reason:
        label += f" ({reason})"
    _add_trail(ticket, label, now, author)

    session.add(ticket)
    await session.commit()
    return await _reload(session, ticket.id)


async def promote_idea_to_ticket(
    session: AsyncSession,
    idea_ticket_id: str,
    project_id: str,
    title: str | None = None,
    type_: str = "feature",
    priority: str = "medium",
    author: str | None = DEFAULT_AUTHOR,
) -> Ticket:
    """Turn an approved idea into a regular ticket and link the two.

    Args:
        idea_ticket_id: Idea to promote.
        project_id: Project that will own the new ticket.
        title: Ticket title; defaults to the idea's.
        type_: Ticket type.
        priority: Ticket priority.

    Returns:
        The created ticket.

    Raises:
        ValueError: If the idea or project is missing, the idea is not approved,
            lacks a problem statement, or was already promoted.
    """
    ticket = await session.get(IdeaTicket, idea_ticket_id)
    if ticket is None:
        raise ValueError(f"Idea ticket '{idea_ticket_id}' not found")
    if ticket.idea_status != "approved":
        raise ValueError("Only approved ideas can be promoted")
    if not ticket.problem_statement or not ticket.problem_statement.strip():
        raise ValueError("Problem statement is required to promote")
    if ticket.promoted_to_ticket_id is not None:
        raise ValueError(f"Idea already promoted to {ticket.promoted_to_ticket_id}")

    # Validate project exists before calling svc_create_ticket (which commits internally).
    # NOTE: true atomicity would require svc_create_ticket to use flush instead of commit;
    # the UNIQUE constraint on promoted_to_ticket_id prevents double-promotion at the DB level.
    project = await session.get(Project, project_id)
    if project is None:
        raise ValueError(f"Project '{project_id}' not found")

    tags = _safe_json(ticket.tags)
    new_ticket = await svc_create_ticket(
        session,
        project_id=project_id,
        title=title or ticket.title,
        description=ticket.problem_statement,
        type=type_,
        priority=priority,
        tags=tags,
    )

    now = _now_iso()
    ticket.promoted_to_ticket_id = new_ticket.id
    ticket.promoted_at = now
    ticket.stage = "building"
    ticket.updated_at = now
    ticket.last_touched_at = now
    _add_trail(ticket, f"Promoted to ticket {new_ticket.id}", now, author)

    session.add(ticket)
    await session.commit()
    return new_ticket


# The statuses the current Idea board sends: "invalidated" is now called "disproved".
_LEGACY_ASSUMPTION_STATUSES = {"invalidated": "disproved"}
_VALID_ASSUMPTION_STATUSES = set(ASSUMPTION_STATUSES) | set(_LEGACY_ASSUMPTION_STATUSES)


async def _save_assumption_change(
    session: AsyncSession, ticket: IdeaTicket, label: str, author: str | None
) -> IdeaTicket:
    now = _now_iso()
    _add_trail(ticket, label, now, author)
    ticket.last_touched_at = now
    ticket.updated_at = now
    session.add(ticket)
    await session.commit()
    return await _reload(session, ticket.id)


def _find_assumption(ticket: IdeaTicket, assumption_id: str) -> IdeaAssumption:
    found = next((a for a in ticket.assumption_records if a.id == assumption_id), None)
    if found is None:
        raise ValueError(f"Assumption '{assumption_id}' not found")
    return found


async def add_assumption(
    session: AsyncSession,
    ticket_id: str,
    text: str,
    impact: str = "medium",
    author: str | None = DEFAULT_AUTHOR,
) -> IdeaTicket:
    """Append an assumption (max 500 characters).

    Args:
        ticket_id: Idea to add to.
        text: Text of the new item.
        impact: How much the idea depends on it: low, medium or high.
        author: Who is credited in the activity.

    Returns:
        The updated idea ticket.

    Raises:
        ValueError: If the text is empty or too long, or the impact is not valid.
    """
    text = text.strip()
    if not text:
        raise ValueError("text cannot be empty")
    if len(text) > 500:
        raise ValueError("text must be 500 characters or fewer")
    if impact not in ASSUMPTION_IMPACTS:
        raise ValueError(
            f"Invalid impact '{impact}'. Must be one of: {', '.join(ASSUMPTION_IMPACTS)}"
        )
    ticket = await _get_idea_ticket_or_raise(session, ticket_id)
    now = _now_iso()
    session.add(
        IdeaAssumption(
            idea_id=ticket.id,
            position=len(ticket.assumption_records),
            text=text,
            impact=impact,
            created_at=now,
            updated_at=now,
        )
    )
    return await _save_assumption_change(session, ticket, "Assumption added", author)


async def update_assumption_status(
    session: AsyncSession,
    ticket_id: str,
    assumption_id: str,
    status: str,
    author: str | None = DEFAULT_AUTHOR,
) -> IdeaTicket:
    """Set the status of an assumption.

    Args:
        ticket_id: Idea holding the assumption.
        assumption_id: Assumption to change.
        status: New status: untested, testing, validated or disproved ("invalidated" is accepted
            for disproved).
        author: Who is credited in the activity.

    Returns:
        The updated idea ticket.

    Raises:
        ValueError: If the status is invalid or the assumption does not exist.
    """
    if status not in _VALID_ASSUMPTION_STATUSES:
        raise ValueError(
            f"Invalid status '{status}'. Must be one of: {', '.join(sorted(_VALID_ASSUMPTION_STATUSES))}"
        )
    status = _LEGACY_ASSUMPTION_STATUSES.get(status, status)
    ticket = await _get_idea_ticket_or_raise(session, ticket_id)
    assumption = _find_assumption(ticket, assumption_id)
    assumption.status = status
    assumption.updated_at = _now_iso()
    session.add(assumption)
    return await _save_assumption_change(
        session, ticket, f"Assumption marked as {status}", author
    )


async def update_assumption(
    session: AsyncSession,
    ticket_id: str,
    assumption_id: str,
    text: str | None = None,
    impact: str | None = None,
    test_ticket_id: str | None | object = _SKIP,
    author: str | None = DEFAULT_AUTHOR,
) -> IdeaTicket:
    """Change an assumption's text, impact or test ticket; omitted values stay as they are.

    Args:
        ticket_id: Idea holding the assumption.
        assumption_id: Assumption to change.
        text: New text (max 500 characters).
        impact: New impact: low, medium or high.
        test_ticket_id: A ticket that tests the assumption; None removes the link.
        author: Who is credited in the activity.

    Returns:
        The updated idea ticket.

    Raises:
        ValueError: If a value is invalid, or the assumption or test ticket does not exist.
    """
    ticket = await _get_idea_ticket_or_raise(session, ticket_id)
    assumption = _find_assumption(ticket, assumption_id)
    if text is not None:
        text = text.strip()
        if not text or len(text) > 500:
            raise ValueError("text must be 1 to 500 characters")
        assumption.text = text
    if impact is not None:
        if impact not in ASSUMPTION_IMPACTS:
            raise ValueError(
                f"Invalid impact '{impact}'. Must be one of: {', '.join(ASSUMPTION_IMPACTS)}"
            )
        assumption.impact = impact
    if test_ticket_id is not _SKIP:
        if (
            test_ticket_id is not None
            and await session.get(Ticket, test_ticket_id) is None
        ):
            raise ValueError(f"Ticket '{test_ticket_id}' not found")
        assumption.test_ticket_id = test_ticket_id  # type: ignore[assignment]
    assumption.updated_at = _now_iso()
    session.add(assumption)
    return await _save_assumption_change(session, ticket, "Assumption edited", author)


async def delete_assumption(
    session: AsyncSession,
    ticket_id: str,
    assumption_id: str,
    author: str | None = DEFAULT_AUTHOR,
) -> IdeaTicket:
    """Remove an assumption.

    Args:
        ticket_id: Idea holding the item.
        assumption_id: Item to remove.
        author: Who is credited in the activity.

    Returns:
        The updated idea ticket.

    Raises:
        ValueError: If the item does not exist.
    """
    ticket = await _get_idea_ticket_or_raise(session, ticket_id)
    assumption = _find_assumption(ticket, assumption_id)
    ticket.assumption_records.remove(
        assumption
    )  # the idea owns it: this deletes the row
    await session.flush()
    for position, remaining in enumerate(ticket.assumption_records):
        remaining.position = position
    return await _save_assumption_change(session, ticket, "Assumption deleted", author)


async def add_microthought(
    session: AsyncSession, ticket_id: str, text: str
) -> IdeaTicket:
    """Append a microthought (max 500 characters).

    Args:
        ticket_id: Idea to add to.
        text: Text of the new item.

    Returns:
        The updated idea ticket.

    Raises:
        ValueError: If the text is empty or too long.
    """
    text = text.strip()
    if not text:
        raise ValueError("text cannot be empty")
    if len(text) > 500:
        raise ValueError("text must be 500 characters or fewer")
    ticket = await _get_idea_ticket_or_raise(session, ticket_id)
    now = _now_iso()
    microthoughts = _safe_json(ticket.microthoughts)
    microthoughts.append({"id": str(uuid.uuid4()), "text": text, "at": now})
    ticket.microthoughts = _dumps(microthoughts)
    return await _trail_entry_and_save(session, ticket, "Microthought added", now)


async def delete_microthought(
    session: AsyncSession, ticket_id: str, microthought_id: str
) -> IdeaTicket:
    """Remove a microthought.

    Args:
        ticket_id: Idea holding the item.
        microthought_id: Item to remove.

    Returns:
        The updated idea ticket.

    Raises:
        ValueError: If the item does not exist.
    """
    ticket = await _get_idea_ticket_or_raise(session, ticket_id)
    microthoughts = _safe_json(ticket.microthoughts)
    filtered = [m for m in microthoughts if m.get("id") != microthought_id]
    if len(filtered) == len(microthoughts):
        raise ValueError(f"Microthought '{microthought_id}' not found")
    ticket.microthoughts = _dumps(filtered)
    now = _now_iso()
    return await _trail_entry_and_save(session, ticket, "Microthought deleted", now)
