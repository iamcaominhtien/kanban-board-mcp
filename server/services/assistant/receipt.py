"""The receipt of a Board AI answer: what the turn changed on tickets, and putting it back (AI v2,
design/screens/ai-board-wave3.md, B and G).

The Board AI acts through the board's own tools with the asker's rights, so every change it makes is already in the
Activity of its ticket, marked with the id of the turn's run. The receipt is read from there, kept on the answer
(`context.receipt`) and, on "Undo all", each change is put back unless something else changed the same field since.

Not in the receipt: edits of a Docs page (they leave no ticket Activity) and what a tool refused.
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
    "description",
    "parent_id",
    "tags",
    "type",
)
# Listed in the receipt; there is no way back for these.
LISTED = ("sub_task", "acceptance_criterion", "branch", "link")
MAX_CHANGES = 200
# Moving a ticket into these hands its work over (a pull request, a merge): that is for a person to do.
HAND_OVER = ("review", "done")


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


def _item_words(field: str, e: dict[str, Any]) -> str:
    """What a sub-task, criterion, branch or link entry says, in a few words."""
    what = {
        "sub_task": "sub-task",
        "acceptance_criterion": "acceptance criterion",
        "branch": "branch",
        "link": "link",
    }[field]
    before, after, ref = e.get("from"), e.get("to"), e.get("ref")
    text = str(ref or after or before or "")
    if field in ("sub_task", "acceptance_criterion"):
        if before is None and after is not None:
            verb = "added"
        elif after is None:
            verb = "removed"
        elif after == "done":
            verb = "ticked"
        else:
            verb = "unticked" if before == "done" else "changed"
    else:
        verb = "removed" if after is None and before is not None else "added"
    return f"{what} {verb}{f': {text[:80]}' if text and field != 'branch' else ''}"


async def collect(
    session: AsyncSession, project_id: str | None, run_id: str
) -> list[dict[str, Any]]:
    """The changes the turn `run_id` made on tickets (of one project, or of every project when `project_id` is None),
    oldest first.

    Each change is `{op, ticket, before, after, at, undo}`; `undo` says whether the board can put it back, `words`
    says a listed one in words.
    """
    stmt = select(Ticket).where(cast(col(Ticket.activity_log), String).contains(run_id))
    if project_id:
        stmt = stmt.where(Ticket.project_id == project_id)
    changes: list[dict[str, Any]] = []
    for t in (await session.exec(stmt)).all():
        log = [e for e in _loads(t.activity_log, []) if e.get("run_id") == run_id]
        born_here = any(e.get("field") == "created" for e in log)
        for e in log:
            field = str(e.get("field") or "")
            if field == "created":
                changes.append(
                    {
                        "op": "create",
                        "ticket": t.id,
                        "created": t.id,
                        "type": t.type,
                        "title": e.get("ref") or t.title,
                        "before": None,
                        "after": None,
                        "at": e.get("at"),
                        "undo": True,
                    }
                )
            elif field == "comment":
                changes.append(
                    {
                        "op": "comment",
                        "ticket": t.id,
                        "before": None,
                        "after": e.get("to"),
                        "ref": e.get("ref"),
                        "at": e.get("at"),
                        "undo": True,
                    }
                )
            elif field in FIELDS:
                if born_here:
                    continue  # the ticket is new: its first values are part of "created"
                changes.append(
                    {
                        "op": field,
                        "ticket": t.id,
                        "before": e.get("from"),
                        "after": e.get("to"),
                        "at": e.get("at"),
                        "undo": True,
                    }
                )
            elif field in LISTED:
                if born_here:
                    continue
                changes.append(
                    {
                        "op": field,
                        "ticket": t.id,
                        "before": e.get("from"),
                        "after": e.get("to"),
                        "words": _item_words(field, e),
                        "at": e.get("at"),
                        "undo": False,
                    }
                )
    changes.sort(key=lambda c: str(c.get("at") or ""))
    changes = changes[:MAX_CHANGES]
    ids = {
        str(v)
        for c in changes
        if c["op"] == "assignee"
        for v in (c["before"], c["after"])
        if v
    }
    names = await _names(session, ids)
    for c in changes:
        if c["op"] == "assignee":
            # the receipt says the name; the id stays beside it for the way back
            c["before_id"], c["after_id"] = c["before"], c["after"]
            for k in ("before", "after"):
                if c[k]:
                    c[k] = names.get(str(c[k]), c[k])
    return changes


def summary(changes: list[dict[str, Any]]) -> dict[str, Any]:
    """The receipt as it is kept on the answer."""
    return {"applied": changes, "count": len(changes), "status": "done"}


def merge(
    old: dict[str, Any] | None, changes: list[dict[str, Any]]
) -> dict[str, Any] | None:
    """The receipt of an answer tried again: what the first try did and was not put back stays in it."""
    kept = (
        list(old.get("applied") or []) if old and old.get("status") != "undone" else []
    )
    both = [*kept, *changes]
    return summary(both) if both else None


def _same(a: Any, b: Any) -> bool:
    """Equal as the Activity keeps them (clipped text, no tags is None)."""
    if isinstance(a, list) or isinstance(b, list):
        return list(a or []) == list(b or [])
    return clip(a) == clip(b) if isinstance(a, str) or isinstance(b, str) else a == b


def _current(t: Ticket, field: str) -> Any:
    value = getattr(t, field, None)
    if field == "tags":
        return _loads(value, []) if isinstance(value, str) else (value or [])
    return value


def _later(t: Ticket, field: str, after_at: str | None) -> str:
    """Who changed `field` after the turn did, and when ("Hoa Mai at 10:51 UTC")."""
    for e in reversed(_loads(t.activity_log, [])):
        if e.get("field") == field and str(e.get("at") or "") > str(after_at or ""):
            who = e.get("actor") or "someone"
            when = str(e.get("at") or "")[11:16]
            return f"{who} at {when} UTC" if when else str(who)
    return "someone else"


async def undo(
    session: AsyncSession, applied: list[dict[str, Any]], runs: list[str]
) -> dict[str, Any]:
    """Put the changes back, newest first. A change is left alone when the field was changed by someone else since.

    Returns:
        `{undone, put_back, skipped, kept}`: `put_back` holds the indexes (in `applied`) that are back; each
        `skipped` line names the ticket, the field and what overwrote it; `kept` names what has no way back.
    """
    put_back: list[int] = []
    skipped: list[str] = []
    kept: list[str] = []
    for i in range(len(applied) - 1, -1, -1):
        c = applied[i]
        ticket_id, op = str(c.get("ticket")), str(c.get("op"))
        label = f"{ticket_id} {op.replace('_', ' ')}"
        if not c.get("undo"):
            kept.append(f"{ticket_id} {c.get('words') or label}")
            continue
        t = await session.get(Ticket, ticket_id)
        if t is None:
            skipped.append(f"{label} (the ticket is gone)")
            continue
        try:
            if op == "create":
                children = (
                    await session.exec(select(Ticket).where(Ticket.parent_id == t.id))
                ).first()
                mine = {
                    str(x.get("ref"))
                    for x in applied
                    if x["op"] == "comment" and x["ticket"] == t.id
                }
                since = [
                    e
                    for e in _loads(t.activity_log, [])
                    if str(e.get("at") or "") > str(c.get("at") or "")
                    and e.get("run_id") not in runs
                ]
                others = [
                    x
                    for x in _loads(t.comments, [])
                    if not x.get("deleted_at") and x.get("id") not in mine
                ]
                if children or since or others:
                    skipped.append(f"{label} (it has been worked on since)")
                    continue
                if await svc_tickets.delete_ticket(session, ticket_id):
                    put_back.append(i)
                continue
            if op == "comment":
                comments = _loads(t.comments, [])
                live = [
                    x
                    for x in comments
                    if x.get("id") == c.get("ref") and not x.get("deleted_at")
                ]
                if not live:
                    skipped.append(f"{label} (it is already gone)")
                    continue
                await svc_tickets.delete_comment(session, ticket_id, str(c.get("ref")))
                put_back.append(i)
                continue
            if not _same(
                _current(t, op),
                c.get("after_id") if op == "assignee" else c.get("after"),
            ):
                skipped.append(f"{label} (now set by {_later(t, op, c.get('at'))})")
                continue
            before = c.get("before_id") if op == "assignee" else c.get("before")
            if op == "tags":
                before = list(before or [])
            if op == "status" and before in HAND_OVER:
                skipped.append(
                    f"{label} (moving it back to {before} hands its work over: do that yourself)"
                )
                continue
            if (
                await svc_tickets.update_ticket(
                    session, ticket_id, TicketUpdate(**{op: before})
                )
                is None
            ):
                skipped.append(f"{label} (the ticket is gone)")
                continue
            put_back.append(i)
        except ValueError as exc:
            skipped.append(f"{label}: {exc}")
    return {
        "undone": len(put_back),
        "put_back": sorted(put_back),
        "skipped": skipped,
        "kept": kept,
    }
