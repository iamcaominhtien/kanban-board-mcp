import json
import uuid
from datetime import datetime, timezone
from typing import Any

from sqlalchemy import text
from sqlmodel import select
from sqlmodel.ext.asyncio.session import AsyncSession

from models import IDEA_STATUSES, IdeaTicket, Ticket

UTC = timezone.utc


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
    idea_color: str = "#F5C518",
    idea_emoji: str = "💡",
    idea_energy: str | None = None,
    tags: list | None = None,
    problem_statement: str | None = None,
) -> IdeaTicket:
    idea_emoji = _validate_idea_emoji(idea_emoji)

    if tags is None:
        tags = []

    ticket_id = await _next_idea_id(session)
    now = _now_iso()

    activity_trail = [{"id": str(uuid.uuid4()), "label": "Idea created", "at": now}]

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
        last_touched_at=now,
        activity_trail=_dumps(activity_trail),
        created_at=now,
        updated_at=now,
    )
    session.add(ticket)
    await session.commit()
    await session.refresh(ticket)
    return ticket


async def get_idea_ticket(session: AsyncSession, ticket_id: str) -> IdeaTicket | None:
    return await session.get(IdeaTicket, ticket_id)


async def list_idea_tickets(
    session: AsyncSession,
    project_id: str,
    idea_status: str | None = None,
    q: str | None = None,
) -> list[IdeaTicket]:
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
    **fields: Any,
) -> IdeaTicket | None:
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

    if changed_field_names:
        trail = _safe_json(ticket.activity_trail)
        trail.append(
            {
                "id": str(uuid.uuid4()),
                "label": f"Fields updated: {', '.join(changed_field_names)}",
                "at": now,
            }
        )
        ticket.activity_trail = _dumps(trail)
        ticket.updated_at = now

    ticket.last_touched_at = now

    session.add(ticket)
    await session.commit()
    await session.refresh(ticket)
    return ticket


async def delete_idea_ticket(session: AsyncSession, ticket_id: str) -> bool:
    ticket = await session.get(IdeaTicket, ticket_id)
    if ticket is None:
        return False
    await session.delete(ticket)
    await session.commit()
    return True


ALLOWED_TRANSITIONS: dict[str, set[str]] = {
    "raw": {"brewing", "dropped"},
    "brewing": {"validated", "raw", "dropped"},
    "validated": {"approved", "brewing", "dropped"},
    "approved": {"dropped"},
    "dropped": {"raw"},
}


async def update_idea_status(
    session: AsyncSession,
    ticket_id: str,
    new_status: str,
    reason: str | None = None,
) -> IdeaTicket:
    ticket = await session.get(IdeaTicket, ticket_id)
    if ticket is None:
        raise ValueError(f"Idea ticket '{ticket_id}' not found")
    if new_status not in IDEA_STATUSES:
        raise ValueError(f"Invalid status '{new_status}'. Must be one of: {', '.join(IDEA_STATUSES)}")
    old_status = ticket.idea_status
    allowed = ALLOWED_TRANSITIONS.get(old_status, set())
    if new_status not in allowed:
        raise ValueError(f"Cannot transition from {old_status} to {new_status}")

    now = _now_iso()
    ticket.idea_status = new_status
    ticket.updated_at = now
    ticket.last_touched_at = now

    trail = _safe_json(ticket.activity_trail)
    label = f"Status changed: {old_status} → {new_status}"
    if reason:
        label += f" ({reason})"
    trail.append({"id": str(uuid.uuid4()), "label": label, "at": now})
    ticket.activity_trail = _dumps(trail)

    session.add(ticket)
    await session.commit()
    await session.refresh(ticket)
    return ticket


async def promote_idea_to_ticket(
    session: AsyncSession,
    idea_ticket_id: str,
    project_id: str,
    title: str | None = None,
    type_: str = "feature",
    priority: str = "medium",
) -> Ticket:
    from services.tickets import create_ticket as svc_create_ticket

    ticket = await session.get(IdeaTicket, idea_ticket_id)
    if ticket is None:
        raise ValueError(f"Idea ticket '{idea_ticket_id}' not found")
    if ticket.idea_status != "approved":
        raise ValueError("Only approved ideas can be promoted")
    if not ticket.problem_statement or not ticket.problem_statement.strip():
        raise ValueError("Problem statement is required to promote")
    if ticket.promoted_to_ticket_id is not None:
        raise ValueError(f"Idea already promoted to {ticket.promoted_to_ticket_id}")

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
    ticket.updated_at = now
    ticket.last_touched_at = now

    trail = _safe_json(ticket.activity_trail)
    trail.append(
        {"id": str(uuid.uuid4()), "label": f"Promoted to ticket {new_ticket.id}", "at": now}
    )
    ticket.activity_trail = _dumps(trail)

    session.add(ticket)
    await session.commit()
    return new_ticket
