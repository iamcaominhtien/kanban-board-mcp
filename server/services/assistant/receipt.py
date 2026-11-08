"""The receipt of a Board AI answer: what the turn changed on tickets, and putting it back (AI v2,
design/screens/ai-board-wave3.md, B and G).

The Board AI acts through the board's own tools with the asker's rights, so every change it makes is already in the
Activity of its ticket, marked with the id of the turn's run. The receipt is read from there, kept on the answer
(`context.receipt`) and, on "Undo all", each change is put back unless something else changed the same field since.
"""

import json
from typing import Any

from sqlalchemy import String, cast
from sqlmodel import col, select
from sqlmodel.ext.asyncio.session import AsyncSession

from models import Member, Ticket, TicketUpdate
from services import tickets as svc_tickets
from services.activity import clip

# Activity fields a turn can set that are put back by writing the old value again.
FIELDS = (
    "status",
    "assignee",
    "priority",
    "estimate",
    "due_date",
    "start_date",
    "title",
    "tags",
    "type",
)
# Other things a turn does that are listed in the receipt (and undone where there is a way back).
OTHER = ("created", "comment", "sub_task", "acceptance_criterion", "branch", "link")
MAX_CHANGES = 60


def _loads(raw: str | None, default: Any) -> Any:
    try:
        return json.loads(raw) if raw else default
    except ValueError:
        return default


async def _names(session: AsyncSession, ids: set[str]) -> dict[str, str]:
    """Member ids to names, for the assignee lines."""
    if not ids:
        return {}
    rows = (await session.exec(select(Member).where(col(Member.id).in_(ids)))).all()
    return {m.id: m.name for m in rows}


async def collect(
    session: AsyncSession, project_id: str, run_id: str
) -> list[dict[str, Any]]:
    """The changes the turn `run_id` made on tickets of the project, oldest first.

    Each change is `{op, ticket, before, after, ref?, at, undo}` where `undo` says whether the board can put it back.
    """
    rows = (
        await session.exec(
            select(Ticket).where(
                Ticket.project_id == project_id,
                cast(col(Ticket.activity_log), String).contains(run_id),
            )
        )
    ).all()
    changes: list[dict[str, Any]] = []
    for t in rows:
        for e in _loads(t.activity_log, []):
            if e.get("run_id") != run_id:
                continue
            field = str(e.get("field") or "")
            if field not in FIELDS and field not in OTHER:
                continue
            change: dict[str, Any] = {
                "op": field if field != "created" else "create",
                "ticket": t.id,
                "before": e.get("from"),
                "after": e.get("to"),
                "at": e.get("at"),
                "undo": field in FIELDS or field in ("created", "comment"),
            }
            if e.get("ref"):
                change["ref"] = e["ref"]
            if field == "created":
                change["created"] = t.id
                change["type"] = t.type
                change["title"] = e.get("ref") or t.title
            changes.append(change)
    changes.sort(key=lambda c: str(c.get("at") or ""))
    changes = changes[:MAX_CHANGES]
    names = await _names(
        session,
        {
            str(v)
            for c in changes
            if c["op"] == "assignee"
            for v in (c["before"], c["after"])
            if v
        },
    )
    for c in changes:
        if c["op"] == "assignee":
            for k in ("before", "after"):
                if c[k]:
                    c[k] = names.get(str(c[k]), c[k])
    return changes


def summary(changes: list[dict[str, Any]]) -> dict[str, Any]:
    """The receipt as it is kept on the answer."""
    return {"applied": changes, "count": len(changes), "status": "done"}


async def _current(session: AsyncSession, ticket_id: str, field: str) -> Any:
    t = await session.get(Ticket, ticket_id)
    if t is None:
        return None
    value = getattr(t, field, None)
    if field == "tags":
        return _loads(value, []) if isinstance(value, str) else (value or [])
    return value


def _same(a: Any, b: Any) -> bool:
    """Equal as the Activity keeps them (clipped text, no tags is None)."""
    if isinstance(a, list) or isinstance(b, list):
        return list(a or []) == list(b or [])
    return clip(a) == clip(b) if isinstance(a, str) or isinstance(b, str) else a == b


async def _overwritten_by(
    session: AsyncSession, ticket_id: str, field: str, after_at: str | None
) -> str:
    """Who changed `field` after the turn did, and when ("Hoa Mai at 10:51")."""
    t = await session.get(Ticket, ticket_id)
    for e in reversed(_loads(t.activity_log if t else None, [])):
        if e.get("field") == field and str(e.get("at") or "") > str(after_at or ""):
            who = e.get("actor") or "someone"
            when = str(e.get("at") or "")[11:16]
            return f"{who} at {when}" if when else str(who)
    return "someone else"


async def undo(session: AsyncSession, applied: list[dict[str, Any]]) -> dict[str, Any]:
    """Put the changes back, newest first. A change is left alone when the field was changed by someone else since.

    Returns:
        `{undone: n, skipped: [text, …]}`: each skipped line names the ticket, the field and what overwrote it.
    """
    done = 0
    skipped: list[str] = []
    for c in reversed(applied):
        ticket_id, op = str(c.get("ticket")), str(c.get("op"))
        if not c.get("undo"):
            skipped.append(f"{ticket_id} {op.replace('_', ' ')}: it cannot be put back")
            continue
        try:
            if op == "create":
                if await svc_tickets.delete_ticket(session, ticket_id):
                    done += 1
                continue
            if op == "comment":
                if await svc_tickets.delete_comment(
                    session, ticket_id, str(c.get("ref"))
                ):
                    done += 1
                continue
            current = await _current(session, ticket_id, op)
            raw_after = c.get("after")
            if op == "assignee":
                # the receipt shows the name; compare through the ticket's own member
                t = await session.get(Ticket, ticket_id)
                m = await session.get(Member, t.assignee) if t and t.assignee else None
                current, raw_after = (m.name if m else None), raw_after
            if not _same(current, raw_after):
                who = await _overwritten_by(session, ticket_id, op, c.get("at"))
                skipped.append(f"{ticket_id} {op.replace('_', ' ')} (now set by {who})")
                continue
            before = c.get("before")
            if op == "assignee" and before:
                m = (
                    await session.exec(select(Member).where(Member.name == before))
                ).first()
                before = m.id if m else before
            if op == "tags":
                before = list(before or [])
            await svc_tickets.update_ticket(
                session, ticket_id, TicketUpdate(**{op: before})
            )
            done += 1
        except ValueError as exc:
            skipped.append(f"{ticket_id} {op.replace('_', ' ')}: {exc}")
    return {"undone": done, "skipped": skipped}
