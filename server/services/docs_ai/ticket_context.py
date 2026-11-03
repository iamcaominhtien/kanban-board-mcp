"""The tickets a page links, for the Docs AI (#268): an answer about a page knows the work it points to.

A page names tickets by key (KAN-12) or a person links one by hand; both are `DocsLink` rows with a
`target_ticket_id`. The Docs AI reads them as data (fenced), next to the page: their title, status, a short
description and the open criteria, so "is this done?" and "what does KAN-12 say?" are answered from the board.
"""

import json

from sqlmodel import col, select
from sqlmodel.ext.asyncio.session import AsyncSession

from models import DocsLink, Ticket

from . import engine

MAX_TICKETS = 6
DESCRIPTION_CHARS = 600


async def linked_tickets(
    session: AsyncSession,
    project_id: str,
    page_ids: list[str],
    *,
    first: list[str] | None = None,
    limit: int = MAX_TICKETS,
) -> list[Ticket]:
    """Tickets of `project_id` the pages link (`first`: keys to put ahead, e.g. those named in a thread)."""
    keys: list[str] = list(first or [])
    if page_ids:
        rows = (
            await session.exec(
                select(DocsLink.target_ticket_id)
                .where(
                    col(DocsLink.source_page_id).in_(page_ids),
                    col(DocsLink.target_ticket_id).is_not(None),
                )
                .order_by(col(DocsLink.id))
            )
        ).all()
        keys += [k for k in rows if k]
    out: list[Ticket] = []
    for key in dict.fromkeys(keys):
        t = await session.get(Ticket, key)
        if t is not None and t.project_id == project_id:
            out.append(t)
        if len(out) >= limit:
            break
    return out


def _open_criteria(t: Ticket) -> list[str]:
    try:
        acs = json.loads(t.acceptance_criteria or "[]")
    except ValueError:
        return []
    return [
        str(a.get("text", "")) for a in acs if isinstance(a, dict) and not a.get("done")
    ][:5]


def tickets_block(tickets: list[Ticket], heading: str) -> str:
    """The tickets as fenced data blocks under `heading` ("" when there are none)."""
    if not tickets:
        return ""
    parts = []
    for t in tickets:
        body = f"{t.id} · {t.title} · status {t.status}"
        desc = (t.description or "").strip()
        if desc:
            body += (
                "\n"
                + desc[:DESCRIPTION_CHARS]
                + ("…" if len(desc) > DESCRIPTION_CHARS else "")
            )
        todo = _open_criteria(t)
        if todo:
            body += "\nOpen criteria:\n" + "\n".join(f"- [ ] {c}" for c in todo)
        parts.append(engine.fenced(f"ticket {t.id}", body))
    return heading + "\n" + "\n".join(parts)
