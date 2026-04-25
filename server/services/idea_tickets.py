import json
import uuid
from datetime import datetime, timezone
from typing import Any

from sqlalchemy import text
from sqlmodel import select
from sqlmodel.ext.asyncio.session import AsyncSession

from models import IdeaTicket

UTC = timezone.utc


def _loads(value: str) -> list:
    if not value:
        return []
    return json.loads(value)


def _dumps(value: list) -> str:
    return json.dumps(value)


def _now_iso() -> str:
    return datetime.now(UTC).isoformat()


def _clamp(value: int, lo: int = 1, hi: int = 5) -> int:
    return max(lo, min(hi, value))


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
    if len(idea_emoji.strip()) == 0:
        raise ValueError("idea_emoji cannot be empty")
    if len(idea_emoji) > 8:
        raise ValueError("idea_emoji must be a single emoji character")

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


_UPDATABLE_FIELDS = (
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
)


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
        old = getattr(ticket, field)

        if field == "idea_emoji":
            if len(str(value).strip()) == 0:
                raise ValueError("idea_emoji cannot be empty")
            if len(str(value)) > 8:
                raise ValueError("idea_emoji must be a single emoji character")

        if field == "tags":
            serialized = _dumps(value)
            if old != serialized:
                changed_field_names.append(field)
                setattr(ticket, field, serialized)
        elif field in ("ice_impact", "ice_effort", "ice_confidence"):
            clamped = _clamp(int(value))
            if old != clamped:
                changed_field_names.append(field)
                setattr(ticket, field, clamped)
        else:
            if old != value:
                changed_field_names.append(field)
                setattr(ticket, field, value)

    if changed_field_names:
        trail = _loads(ticket.activity_trail)
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
