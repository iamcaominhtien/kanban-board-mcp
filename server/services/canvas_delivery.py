"""A mention of an AI team in a Canvas comment, delivered with what already exists (no new job).

A canvas of a **ticket** sends the note to that ticket's team (``messaging.deliver_to_ticket``: live when its lead runs,
else on its next turn). A canvas that is, or sits in, a **Docs page** sends it to the page (``messaging.deliver_to_page``:
the page's assistant answers when Docs AI is on). Any other canvas (an idea, a comment) cannot deliver. The answer to
the POST says what happened to each team, so the comment panel can show one quiet line; nothing is toasted that did not
run. A comment an AI wrote is never delivered (no loops), and the note carries the hand-off depth the runs count.
"""

import logging
from typing import Any

from sqlmodel import col, select
from sqlmodel.ext.asyncio.session import AsyncSession

from models import AiRun, AiTeam, Member, Ticket

logger = logging.getLogger(__name__)

NOT_ON_TICKET = "This team is not on this ticket."
ONLY_TICKET_OR_PAGE = (
    "A team answers a canvas comment only on a ticket's canvas or a Docs page's canvas."
)
DOCS_AI_OFF = "The page's assistant is not available now (Docs AI is off or not ready): the note is only a comment on the page."


def _page_of(canvas: Any) -> str | None:
    """The Docs page a canvas lives in or on, if any."""
    if canvas.page_id:
        return canvas.page_id
    return canvas.owner_id if canvas.owner_kind in ("doc", "page") else None


async def ticket_team(session: AsyncSession, ticket_id: str) -> str | None:
    """The team a ticket's notes go to: its assignee when that is an AI team, else the team of its latest run (the
    same choice ``runs.deliver_to_ticket`` makes)."""
    ticket = await session.get(Ticket, ticket_id)
    if ticket is None:
        return None
    if ticket.assignee:
        m = await session.get(Member, ticket.assignee)
        if m is not None and m.kind == "ai":
            return m.id
    last = (
        await session.exec(
            select(AiRun)
            .where(AiRun.ticket_id == ticket_id)
            .order_by(col(AiRun.queued_at).desc())
            .limit(1)
        )
    ).first()
    return last.member_id if last else None


async def _status(session: AsyncSession, member: Member) -> tuple[str, str]:
    """(status, note) of an AI team: ``ready``, ``paused`` or ``unavailable`` (no team behind the member)."""
    team = await session.get(AiTeam, member.id)
    if team is None:
        return "unavailable", "Not set up"
    if team.paused:
        return "paused", "Paused"
    return "ready", ""


async def mentionable(session: AsyncSession, canvas: Any) -> list[dict[str, Any]]:
    """The members the ``@`` picker of this canvas offers: the project's people, and its AI teams with whether each can
    be asked here and now (a paused team, a team that is not on the ticket, a canvas that cannot deliver)."""
    if not canvas.project_id:
        return []
    from services.assistant import docs as assistant_docs

    rows = (
        await session.exec(
            select(Member)
            .where(Member.project_id == canvas.project_id)
            .order_by(col(Member.created_at))
        )
    ).all()
    team_of_ticket = (
        await ticket_team(session, canvas.owner_id)
        if canvas.owner_kind == "ticket"
        else None
    )
    page = _page_of(canvas)
    docs_ai = bool(page) and await assistant_docs.docs_ai_on(session, canvas.project_id)
    out: list[dict[str, Any]] = []
    for m in rows:
        if m.kind == "ai_removed":
            continue
        row: dict[str, Any] = {
            "id": m.id,
            "name": m.name,
            "color": m.color,
            "role": m.role,
            "kind": "ai" if m.kind == "ai" else "human",
        }
        if m.kind == "ai":
            status, note = await _status(session, m)
            usable = status == "ready"
            if usable and canvas.owner_kind == "ticket" and m.id != team_of_ticket:
                usable, note = False, "Not on this ticket"
            elif usable and canvas.owner_kind != "ticket" and not page:
                usable, note = False, "Ticket or page canvases only"
            elif usable and page and canvas.owner_kind != "ticket" and not docs_ai:
                usable, note = False, "Docs AI is off"
            row["ai"] = {
                "status": status,
                "usable": usable,
                "note": note,
                "provider": "claude-code",
            }
        out.append(row)
    return out


def _note(canvas: Any, thread: dict[str, Any], comment: dict[str, Any], by: str) -> str:
    """What the team is told: who mentioned it, where, the comment, and how to answer on the same thread."""
    from services.docs_comments import plain_mentions

    where = f"canvas “{canvas.title}” (canvas_id {canvas.id}"
    if thread.get("board_id"):
        where += f", board_id {thread['board_id']}"
    where += f", thread_id {thread['id']})"
    who = "A person on the board" if by.casefold() in ("user", "you", "me") else by
    return (
        f"{who} mentioned you in a comment on the {where}:\n\n"
        f"{plain_mentions(comment.get('body') or '')}\n\n"
        "Read the canvas with docs_read(canvas, canvas_id=…) and answer in that thread with "
        "docs_write(canvas_comment, canvas_id=…, thread_id=…). Change a board only if the comment asks for it."
    )


async def deliver(
    session: AsyncSession, canvas: Any, thread: dict[str, Any], *, by: str
) -> list[dict[str, Any]]:
    """Deliver the AI teams the newest comment of a thread mentions.

    Returns:
        ``[{member_id, name, result: "delivered" | "not_delivered", reason?}]``; empty when no team is mentioned or
        the comment was written by an AI.
    """
    comment = (thread.get("comments") or [{}])[-1]
    if not comment or comment.get("is_ai") or comment.get("ai"):
        return []
    if not canvas.project_id:
        return []
    members = (
        await session.exec(select(Member).where(Member.project_id == canvas.project_id))
    ).all()
    teams = {m.id: m for m in members if m.kind == "ai"}
    if (comment.get("author") or "").casefold() in {
        m.name.casefold() for m in teams.values()
    }:
        return []
    mentioned = [teams[i] for i in comment.get("mentions") or [] if i in teams]
    if not mentioned:
        return []

    def fail(m: Member, reason: str) -> dict[str, Any]:
        return {
            "member_id": m.id,
            "name": m.name,
            "result": "not_delivered",
            "reason": reason,
        }

    note = _note(canvas, thread, comment, by)
    page = _page_of(canvas)
    results: list[dict[str, Any]] = []
    if canvas.owner_kind == "ticket":
        from services.ai import messaging

        team_id = await ticket_team(session, canvas.owner_id)
        sent = False
        for m in mentioned:
            if m.id != team_id:
                results.append(fail(m, NOT_ON_TICKET))
                continue
            status, why = await _status(session, m)
            if status != "ready":
                results.append(fail(m, f"{m.name} is {why.lower()}."))
                continue
            if sent:
                continue
            try:
                await messaging.deliver_to_ticket(canvas.owner_id, note, by=by)
            except Exception as exc:  # noqa: BLE001 - a run that cannot start, a team that waits for a person
                results.append(fail(m, str(exc) or "The note could not be sent."))
                continue
            sent = True
            results.append({"member_id": m.id, "name": m.name, "result": "delivered"})
    elif page:
        from services.ai import messaging

        try:
            sent = await messaging.deliver_to_page(page, note, by=by)
        except Exception as exc:  # noqa: BLE001
            return [
                fail(m, str(exc) or "The note could not be sent.") for m in mentioned
            ]
        answered = sent.get("delivered") == "page_assistant"
        for m in mentioned:
            results.append(
                {"member_id": m.id, "name": m.name, "result": "delivered"}
                if answered
                else fail(m, DOCS_AI_OFF)
            )
    else:
        results = [fail(m, ONLY_TICKET_OR_PAGE) for m in mentioned]
    return results
