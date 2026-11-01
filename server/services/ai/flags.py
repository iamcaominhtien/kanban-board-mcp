"""Open conditions on a ticket that wait for someone: a merge conflict, an arbitration, a workflow that stopped going
round (no progress, board fault, quota cap). One row per ticket and kind while open; resolving it closes its
Needs you row by itself (services/notifications.py, `_why_flag_closed`)."""

import json
from datetime import UTC, datetime

from sqlmodel import col, select

from models import AiTicketFlag

KINDS = (
    "merge_conflict",
    "arbitration",
    "no_progress",
    "board_fault",
    "quota_cap",
    "no_member",
)


def _now() -> str:
    return datetime.now(UTC).isoformat()


async def open_flag(
    session, ticket_id: str, project_id: str, kind: str, data: dict | None = None
) -> AiTicketFlag:
    """Raise a flag (or refresh an open one of the same kind)."""
    if kind not in KINDS:
        raise ValueError(f"Unknown flag: {kind}")
    row = await current(session, ticket_id, kind)
    if row is None:
        row = AiTicketFlag(ticket_id=ticket_id, project_id=project_id, kind=kind)
    row.data = json.dumps(data or {})
    row.updated_at = _now()
    session.add(row)
    await session.commit()
    await session.refresh(row)
    return row


async def current(session, ticket_id: str, kind: str) -> AiTicketFlag | None:
    """The open flag of a kind on a ticket, or None."""
    return (
        await session.exec(
            select(AiTicketFlag).where(
                AiTicketFlag.ticket_id == ticket_id,
                AiTicketFlag.kind == kind,
                col(AiTicketFlag.resolved_at).is_(None),
            )
        )
    ).first()


async def is_open(session, ticket_id: str, kind: str) -> bool:
    """Whether the ticket still carries the flag."""
    return await current(session, ticket_id, kind) is not None


async def resolve(
    session, ticket_id: str, kind: str, *, by: str, how: str
) -> AiTicketFlag | None:
    """Close the open flag, saying who and how."""
    row = await current(session, ticket_id, kind)
    if row is None:
        return None
    row.resolved_at = _now()
    row.resolved_by = by
    row.resolution = how[:400]
    session.add(row)
    await session.commit()
    await session.refresh(row)
    return row


async def for_ticket(session, ticket_id: str) -> list[dict]:
    """Every flag of a ticket, newest first."""
    rows = (
        await session.exec(
            select(AiTicketFlag)
            .where(AiTicketFlag.ticket_id == ticket_id)
            .order_by(col(AiTicketFlag.created_at).desc())
        )
    ).all()
    return [to_dict(r) for r in rows]


def to_dict(row: AiTicketFlag) -> dict:
    """A flag for the API."""
    try:
        data = json.loads(row.data or "{}")
    except ValueError:
        data = {}
    return {
        "id": row.id,
        "ticket_id": row.ticket_id,
        "kind": row.kind,
        "data": data,
        "open": row.resolved_at is None,
        "created_at": row.created_at,
        "resolved_at": row.resolved_at,
        "resolved_by": row.resolved_by,
        "resolution": row.resolution,
    }
