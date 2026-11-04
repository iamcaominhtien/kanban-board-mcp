"""Where an AI is and who else is on the work (the scope card), and how a run reaches a teammate.

Every AI answers from one conversation: a run's on its ticket, a chat's, its own on a Docs page. What happened in its
other conversations, or in a teammate's, is not in its memory. The scope card says so in every prompt, names the AIs on
the same work with what they are doing now, and says how to get what is missing: read the board, contact the teammate
who has it, ask a person for a person's call.

A run contacts a teammate with ai_run(contact): the message reaches the teammate's run when it is on that ticket now,
else it starts an ask run in the teammate's conversation on that ticket, and the answer comes back (a message to the
asking run while it works, else a comment on its ticket). Contacts count toward the project's chain depth, like AI
mentions, so two AIs cannot ping-pong. No AI asks a teammate to do what it was refused itself.
"""

from __future__ import annotations

from typing import Any

from sqlmodel import col, select
from sqlmodel.ext.asyncio.session import AsyncSession

import database
from models import AiMember, AiRun, DocsLink, Member, Ticket

from .context import RunContext
from .store import get_settings, loads

TRIGGER = "contact"
MAX_TEAM_LINES = 12

# what each surface's conversation holds, and how an AI there reaches a teammate
_WHERE = {
    "run": "You are in your conversation on {ticket}: it holds what you did and were told on {ticket} only.",
    "ticket_chat": (
        "You are answering in a chat about {ticket}, in your conversation on {ticket} (the one your runs there use; "
        "while one of your runs holds it, a chat answer comes from a side conversation)."
    ),
    "board_chat": "You are the Board AI in a chat with a person about the whole project: this chat is your conversation.",
    "docs_chat": "You are answering in a chat about the Docs page {page}: this chat is your conversation.",
    "docs_ask": (
        "You are answering a question from the project's Docs pages: what you know here is what those pages and "
        "the tickets they link say."
    ),
    "docs": (
        "You are answering on the Docs page {page}, in your conversation on that page: it holds what was asked of you "
        "on this page only."
    ),
}
_REACH_RUN = (
    "- What you need is in another conversation or a teammate's work: read the board first (the ticket, its comments, "
    "work log and handoff notes, the Docs pages it links). Not written down: ask the AI who did it with "
    "ai_run(action='contact', member, ticket, instruction). It reaches them where they are (their run on that ticket now, "
    "else a short run in their conversation there), and the answer comes back to you. See who is on what with "
    "ai_run(action='team').\n"
    "- Work that belongs to a teammate: hand it over with ai_run(action='handoff').\n"
)
_REACH_ELSEWHERE = (
    "- What you need is in another conversation or a teammate's work: read the board first (the ticket, its comments, "
    "work log and handoff notes, the Docs pages it links). You cannot message a teammate or start their work from "
    "here: say who should do it (the AI and the ticket), so the person can send it to them.\n"
)
_REACH_DOCS = (
    "- What you need is in another conversation or a teammate's work: read the board with your tools first (get_ticket "
    "shows a ticket's comments, work log and handoff notes). Not written down: do not guess. Ask the AI who did it with an ASK line (your task says how): the board sends "
    "them the thread and they answer there, from their own conversation on that ticket.\n"
)
_ALWAYS = (
    "- You lack a permission or a tool refused you: never ask a teammate to do it for you, and never route around the "
    "refusal; ask the person.\n"
    "- A person's call (money, something that cannot be undone, taste between good options): ask the person."
)


async def _profiles(session: AsyncSession, project_id: str) -> dict[str, AiMember]:
    rows = (
        await session.exec(select(AiMember).where(AiMember.project_id == project_id))
    ).all()
    return {p.id: p for p in rows}


async def team_on(
    session: AsyncSession, project_id: str, ticket_ids: list[str]
) -> list[dict[str, Any]]:
    """Each AI of the project with its role, what it is doing now (runs on any ticket) and which of `ticket_ids` it
    worked on or is assigned to; the ones on these tickets first."""
    from . import packs
    from . import plugins as ai_plugins
    from .runs import ACTIVE

    ais = (
        await session.exec(
            select(Member).where(Member.project_id == project_id, Member.kind == "ai")
        )
    ).all()
    profiles = await _profiles(session, project_id)
    active = (
        await session.exec(
            select(AiRun)
            .where(AiRun.project_id == project_id, col(AiRun.state).in_(list(ACTIVE)))
            .order_by(col(AiRun.queued_at))
        )
    ).all()
    ran = (
        (
            await session.exec(
                select(AiRun.member_id, AiRun.ticket_id).where(
                    col(AiRun.ticket_id).in_(ticket_ids)
                )
            )
        ).all()
        if ticket_ids
        else []
    )
    assigned = (
        (
            await session.exec(
                select(Ticket.id, Ticket.assignee).where(col(Ticket.id).in_(ticket_ids))
            )
        ).all()
        if ticket_ids
        else []
    )
    out = []
    for m in ais:
        p = profiles.get(m.id)
        role = ai_plugins.role_of(p) if p else None
        now = [
            {
                "ticket_id": r.ticket_id,
                "state": r.state,
                "mode": r.mode,
                "run_number": r.number,
            }
            for r in active
            if r.member_id == m.id
        ]
        worked = sorted({t for mid, t in ran if mid == m.id})
        owns = sorted({t for t, a in assigned if a == m.id})
        out.append(
            {
                "id": m.id,
                "name": m.name,
                "role": packs.role_name(role) if role else None,
                "paused": bool(p and p.paused),
                "now": now,
                "worked_on": worked,
                "assigned": owns,
                "here": bool(
                    worked or owns or any(n["ticket_id"] in ticket_ids for n in now)
                ),
            }
        )
    out.sort(key=lambda a: (not a["here"], a["name"].casefold()))
    return out


def _team_line(a: dict[str, Any], me: str | None) -> str:
    who = (
        a["name"]
        + (f" ({a['role']})" if a["role"] else "")
        + (" — you" if a["id"] == me else "")
    )
    if a["paused"]:
        doing = "paused"
    elif a["now"]:
        doing = ", ".join(
            f"{'working on' if n['state'] in ('starting', 'running') else n['state'].replace('_', ' ') + ' on'} "
            f"{n['ticket_id']}{' (a question)' if n['mode'] == 'ask' else ''}"
            for n in a["now"][:3]
        )
    else:
        doing = "free"
    bits = [doing]
    if a["assigned"]:
        bits.append("assigned " + ", ".join(a["assigned"][:4]))
    if a["worked_on"]:
        bits.append("worked on " + ", ".join(a["worked_on"][:4]))
    return f"- {who}: " + "; ".join(bits)


async def _tickets_of(
    session: AsyncSession, ticket_id: str | None, page_id: str | None
) -> list[str]:
    """The tickets the work is about: the ticket with its parent and children, or the tickets a page names."""
    ids: list[str] = []
    if ticket_id:
        ids.append(ticket_id)
        t = await session.get(Ticket, ticket_id)
        if t is not None and t.parent_id:
            ids.append(t.parent_id)
        kids = (
            await session.exec(select(Ticket.id).where(Ticket.parent_id == ticket_id))
        ).all()
        ids += list(kids)[:10]
    if page_id:
        named = (
            await session.exec(
                select(DocsLink.target_ticket_id).where(
                    DocsLink.source_page_id == page_id,
                    col(DocsLink.target_ticket_id).is_not(None),
                )
            )
        ).all()
        ids += [t for t in named if t]
    return list(dict.fromkeys(ids))[:12]


async def card(
    session: AsyncSession,
    *,
    project_id: str,
    member_id: str | None,
    surface: str,
    ticket_id: str | None = None,
    page_id: str | None = None,
    page_title: str | None = None,
) -> str:
    """The scope card for a prompt: where this AI is, what its conversation holds and does not, the AIs on the same
    work and what they do now, and how to get what it lacks."""
    tickets = await _tickets_of(session, ticket_id, page_id)
    team = await team_on(session, project_id, tickets)
    where = _WHERE.get(surface, _WHERE["run"]).format(
        ticket=ticket_id or "this ticket", page=f'"{page_title}"' if page_title else ""
    )
    lines = [
        "## Where you are and who else is on it",
        where,
        "Your other conversations (on other tickets, other Docs pages, other chats) and your teammates' are separate: "
        "what happened there is not in your memory.",
    ]
    if tickets:
        lines.append("The work this is about: " + ", ".join(tickets) + ".")
    shown = [a for a in team if a["here"] or a["id"] == member_id][:MAX_TEAM_LINES]
    others = [a for a in team if a not in shown]
    if shown:
        lines.append("The AIs on it:")
        lines += [_team_line(a, member_id) for a in shown]
    if others:
        lines.append(
            "Other AIs of the project: "
            + ", ".join(
                a["name"] + (f" ({a['role']})" if a["role"] else "")
                for a in others[:10]
            )
            + "."
        )
    lines.append("When you lack something:")
    reach = {"run": _REACH_RUN, "docs": _REACH_DOCS}.get(surface, _REACH_ELSEWHERE)
    lines.append(reach + _ALWAYS)
    return "\n".join(lines)


async def card_for(**kw: Any) -> str:
    """The scope card in a session of its own (for callers that hold none)."""
    async with database.async_session() as session:
        return await card(session, **kw)


# ---------------------------------------------------------------------------
# Inside a run: who is on what, and contacting a teammate
# ---------------------------------------------------------------------------


async def team_for_run(ctx: RunContext, ticket_ref: str | None) -> dict[str, Any]:
    """ai_run(team): the AIs of the project, what each does now, and who worked on this ticket (or `ticket_ref`)."""
    async with database.async_session() as session:
        ticket_id = (ticket_ref or ctx.ticket_id).strip()
        ticket = await session.get(Ticket, ticket_id)
        if ticket is None or ticket.project_id != ctx.project_id:
            raise ValueError(f"Ticket {ticket_id} was not found in this project.")
        tickets = await _tickets_of(session, ticket_id, None)
        return {
            "ticket_id": ticket_id,
            "tickets": tickets,
            "team": await team_on(session, ctx.project_id, tickets),
        }


async def contact(
    ctx: RunContext, member_ref: str, ticket_ref: str | None, text: str
) -> dict[str, Any]:
    """ai_run(contact): reach a teammate AI about a ticket. A run of theirs on that ticket gets it as a message; else
    an ask run starts in their conversation there, and its answer comes back to this run (or to its ticket)."""
    from . import runs

    if ctx.narrow:
        raise ValueError(
            "Autopilot cannot contact teammates; say in your answer who should be asked."
        )
    text = (text or "").strip()
    if not text:
        raise ValueError("ai_run(action='contact') needs `instruction`: your question.")
    ref = (member_ref or "").strip()
    if not ref:
        raise ValueError(
            "ai_run(action='contact') needs `member` (the teammate's exact name)."
        )
    ticket_id = (ticket_ref or ctx.ticket_id).strip()
    async with database.async_session() as session:
        ticket = await session.get(Ticket, ticket_id)
        if ticket is None or ticket.project_id != ctx.project_id:
            raise ValueError(f"Ticket {ticket_id} was not found in this project.")
        rows = (
            await session.exec(
                select(Member).where(
                    Member.project_id == ctx.project_id, Member.kind == "ai"
                )
            )
        ).all()
        target = next(
            (m for m in rows if m.id == ref or m.name.casefold() == ref.casefold()),
            None,
        )
        if target is None:
            names = ", ".join(m.name for m in rows if m.id != ctx.member_id)
            raise ValueError(
                f"No AI teammate named {ref!r}. The team: {names or 'nobody else'}."
            )
        if target.id == ctx.member_id:
            raise ValueError(
                "That is you. Read the board for what your other conversations did."
            )
        settings = await get_settings(session, ctx.project_id)
        chain = [*ctx.chain, ctx.member_id]
        if len(chain) > settings.max_chain_depth:
            raise ValueError(
                f"This is already {len(ctx.chain)} AIs deep (the project allows {settings.max_chain_depth}). "
                "Ask the person instead (ai_run ask), or say it in your report."
            )
        theirs = (
            await session.exec(
                select(AiRun)
                .where(
                    AiRun.ticket_id == ticket_id,
                    AiRun.member_id == target.id,
                    col(AiRun.state).in_(["starting", "running", "needs_input"]),
                )
                .order_by(col(AiRun.queued_at))
            )
        ).first()
        if theirs is not None:
            via = await runs.tell(
                theirs.id,
                f"From your teammate {ctx.member_name}, working on {ctx.ticket_id}:\n{text[:4000]}\n"
                f"If they need an answer, reply with ai_run(action='contact', member='{ctx.member_name}', "
                f"ticket='{ctx.ticket_id}', instruction=...).",
                by=ctx.member_name,
            )
            return {
                "delivered": "message",
                "via": via,
                "member": target.name,
                "ticket_id": ticket_id,
                "run_number": theirs.number,
                "note": f"{target.name} is working on {ticket_id}: your message reaches that run. "
                "They answer with a contact back if they need to; carry on meanwhile.",
            }
        try:
            run = await runs.create_run(
                session,
                ticket_id=ticket_id,
                member_id=target.id,
                mode="ask",
                trigger=TRIGGER,
                started_by=ctx.on_behalf_of,
                instruction=(
                    f"Your teammate {ctx.member_name}, working on {ctx.ticket_id}, asks you about {ticket_id}:\n"
                    f"{text[:4000]}\n\nAnswer them in your final message: it goes back to them. What you do not "
                    "remember, read on the board; what you do not know, say so."
                ),
                chain=chain,
                report_back={
                    "kind": "answer",
                    "member_id": ctx.member_id,
                    "member_name": ctx.member_name,
                    "ticket_id": ctx.ticket_id,
                    "run_id": ctx.run_id,
                },
            )
        except runs.RunError as exc:
            raise ValueError(f"{target.name} cannot be reached now: {exc}") from exc
    return {
        "delivered": "run",
        "member": target.name,
        "ticket_id": ticket_id,
        "run_number": run.number,
        "note": f"{target.name} answers in a short run on {ticket_id}. The answer comes back to you as a message "
        f"while you run, else as a comment on {ctx.ticket_id}. Carry on with what does not depend on it.",
    }


async def answer_back(run: AiRun, state: str, reason: str | None) -> None:
    """A contact's ask run ended: its answer goes to the asking run while it works, else onto the asker's ticket."""
    from . import runs

    back = loads(run.report_back, None)
    if not isinstance(back, dict) or back.get("kind") != "answer":
        return
    async with database.async_session() as session:
        member = await session.get(Member, run.member_id)
        asking = await session.get(AiRun, back.get("run_id") or "")
    name = member.name if member else "Your teammate"
    said = (loads(run.report, {}).get("summary") or run.summary or "").strip()
    if state == "finished" and said:
        text = f"{name} answered you about {run.ticket_id} (run #{run.number}):\n{said[:3000]}"
    else:
        text = (
            f"{name} could not answer you about {run.ticket_id} ({state.replace('_', ' ')}"
            f"{': ' + reason[:300] if reason else ''})."
        )
    if asking is not None and asking.state in ("starting", "running", "needs_input"):
        await runs.tell(asking.id, text, by=name)
        return
    who = back.get("member_name") or "the asker"
    await runs.post_ai_comment(
        back["ticket_id"],
        name,
        f"For {who}: {text}",
        {"board_note": True, "answer_to_run": back.get("run_id")},
    )
