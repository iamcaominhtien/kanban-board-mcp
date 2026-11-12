"""Work around a Docs page (#268): the tickets tied to it, what the AIs on them are doing, and giving a page to an AI.

A page is tied to a ticket in three ways: the page names it (KAN-12), a person linked them by hand, or the ticket
mentions the page ([[Page]]). `work_on_page` lists those tickets with their state and, for each, the AI run that is
working on it now (or the last one) with what it is doing in one sentence, so a person reading the page sees "Reviewer
is reviewing this page: Read the ticket" without opening the ticket.

Giving a page to an AI member to write or review is a ticket, as every piece of AI work on the board is: the ticket
names the page, is linked to it, is assigned to the member and starts its work run. The run reads the page through
MCP (the guide says how to edit a part of it safely) and reports on the ticket; its progress shows on the page.
"""

from typing import Any

from sqlmodel import col, select
from sqlmodel.ext.asyncio.session import AsyncSession

from models import AiRun, DocsLink, Member, Ticket, TicketUpdate
from services import docs as svc_docs

LIVE = ("queued", "starting", "running", "needs_input")
KINDS = {
    "write": ("Write the page “{title}”", "Write"),
    "review": ("Review the page “{title}”", "Review"),
}


async def _doing(session: AsyncSession, run: AiRun) -> str | None:
    """The run's latest step, as its title ("Edited api/export.py", "Asked reviewer: …")."""
    from models import AiRunStep

    step = (
        await session.exec(
            select(AiRunStep)
            .where(AiRunStep.run_id == run.id, col(AiRunStep.kind) != "hook")
            .order_by(col(AiRunStep.seq).desc())
            .limit(1)
        )
    ).first()
    return step.title if step is not None and step.title else None


async def _ticket_ids(session: AsyncSession, page_id: str) -> list[str]:
    page = await svc_docs.get_page(session, page_id)
    ids: list[str] = []
    # only the tickets: the pages half of the backlinks reads and parses every page that links here
    ids += [t["ticket_id"] for t in await svc_docs.ticket_backlinks(session, page)]
    out = (
        await session.exec(
            select(DocsLink.target_ticket_id).where(
                DocsLink.source_page_id == page.id,
                col(DocsLink.target_ticket_id).is_not(None),
            )
        )
    ).all()
    ids += [k for k in out if k]
    return list(dict.fromkeys(ids))


async def work_on_page(session: AsyncSession, page_id: str) -> dict[str, Any]:
    """The tickets tied to a page and the AI work on them: {tickets: [{id, title, status, assignee, run}], active}.

    `run` is the live run on the ticket (or the latest one): {id, member, mode, state, doing, started_at, ended_at}.
    `active` counts the live runs."""
    ids = await _ticket_ids(session, page_id)
    tickets: list[dict[str, Any]] = []
    active = 0
    names: dict[str, str] = {}
    for key in ids[:40]:
        t = await session.get(Ticket, key)
        if t is None:
            continue
        runs = (
            await session.exec(
                select(AiRun)
                .where(AiRun.ticket_id == t.id)
                .order_by(col(AiRun.queued_at).desc())
                .limit(5)
            )
        ).all()
        live = next((r for r in runs if r.state in LIVE), None)
        run = live or (runs[0] if runs else None)
        row: dict[str, Any] = {
            "id": t.id,
            "title": t.title,
            "status": t.status,
            "assignee": None,
            "run": None,
        }
        if t.assignee:
            if t.assignee not in names:
                m = await session.get(Member, t.assignee)
                names[t.assignee] = m.name if m else ""
            row["assignee"] = names[t.assignee] or None
        if run is not None:
            if run.member_id not in names:
                m = await session.get(Member, run.member_id)
                names[run.member_id] = m.name if m else ""
            row["run"] = {
                "id": run.id,
                "member_id": run.member_id,
                "member": names[run.member_id],
                "mode": run.mode,
                "state": run.state,
                "doing": await _doing(session, run),
                "started_at": run.started_at or run.queued_at,
                "ended_at": run.ended_at,
            }
            if live is not None:
                active += 1
        tickets.append(row)
    # live work first, then the rest as they were found
    tickets.sort(key=lambda r: 0 if r["run"] and r["run"]["state"] in LIVE else 1)
    return {"tickets": tickets, "active": active}


def assignment_ticket(kind: str, title: str, instruction: str | None) -> dict[str, str]:
    """Title and description of the ticket that gives a page to an AI member."""
    if kind not in KINDS:
        raise ValueError("kind: write or review.")
    name, verb = KINDS[kind]
    ask = (instruction or "").strip()
    if kind == "write":
        steps = (
            "Write the page on Docs (docs_read(action='docs_guide') says how): read what it links first, keep what a "
            "person already wrote, change it part by part with docs_write(action='edit'), link the tickets and pages "
            "it is about, and say on this ticket what you wrote and what is still open."
        )
    else:
        steps = (
            "Review the page on Docs (docs_read(action='docs_guide') says how): read it and what it links, comment on "
            "the passages that are wrong, unclear or missing with docs_write(action='comment', quote=...), one point "
            "per comment, and sum up on this ticket: what must change and what is fine. Do not rewrite the page."
        )
    body = f"{verb} [[{title}]].\n\n"
    if ask:
        body += "What is asked:\n\n> " + "\n> ".join(ask.splitlines()) + "\n\n"
    body += steps
    return {"title": name.format(title=title)[:200], "description": body}


async def assign_page(
    session: AsyncSession,
    page_id: str,
    member_id: str,
    kind: str,
    instruction: str | None,
    *,
    created_by: str | None = None,
) -> dict[str, Any]:
    """A person (or an agent, through docs_write(assign)) gives a page to an AI team: a ticket linked to the page,
    assigned to the team, whose lead starts on it (AI v2)."""
    from services import tickets as svc_tickets
    from services.ai import runs as ai_runs

    page = await svc_docs.get_page(session, page_id)
    member = await session.get(Member, member_id)
    if member is None or member.kind != "ai" or member.project_id != page.project_id:
        raise ValueError("Pick an AI team of this project.")
    spec = assignment_ticket(kind, page.title, instruction)
    ticket = await svc_tickets.create_ticket(
        session,
        project_id=page.project_id,
        title=spec["title"],
        type="task",
        status="todo",
        description=spec["description"],
        created_by=created_by,
    )
    await svc_docs.link_ticket_doc(session, ticket.id, page.id)
    ticket_id, ticket_title = ticket.id, ticket.title
    await svc_tickets.update_ticket(
        session, ticket_id, TicketUpdate(assignee=member_id)
    )
    run = await ai_runs.wake_new_assignee(
        ticket_id, member_id, by=created_by, instruction=(instruction or "").strip()
    )
    out: dict[str, Any] = {
        "ticket": {"id": ticket_id, "title": ticket_title},
        "run": {"id": run.id, "state": run.state} if run else None,
    }
    if run is None:
        out["note"] = (
            f"{ticket_id} is assigned to {member.name}, but nothing started: the team is paused or at its limits."
        )
    return out
