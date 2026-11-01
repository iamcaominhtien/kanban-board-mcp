"""@mentions of AI members: what a mention means (Ask, Do the work, Just notify) and the chain limits between AI
members (design/components/ai-ticket-work.md, B and H5; design/screens/ai-safety-cost.md, G)."""

import re

from sqlmodel import col, select

import database
import services.tickets as svc_tickets
from models import AiMember, Member, Ticket, TicketUpdate

from . import audit
from .context import RunContext
from .store import get_settings, loads

_MENTION = re.compile(r"@\[([^\][\n]{1,100})\]\(member:([\w.-]{1,64})\)")
BOARD_AUTHOR = "Board"
INTENTS = ("ask", "work", "notify")


def plain(text: str) -> str:
    """Mention pills written as plain @Name."""
    return _MENTION.sub(lambda m: f"@{m.group(1)}", text or "")


async def mentioned_ai(
    session, project_id: str, text: str, *, plain_names: bool = False
) -> list[Member]:
    """AI members mentioned in a text, in order. With `plain_names` an AI member's exact name after an @ counts too
    (an AI writes `@BA Bao`, it has no pill to click)."""
    ids = list(dict.fromkeys(m.group(2) for m in _MENTION.finditer(text or "")))
    if plain_names:
        everyone = (
            await session.exec(
                select(Member).where(
                    Member.project_id == project_id, Member.kind == "ai"
                )
            )
        ).all()
        bare = _MENTION.sub("", text or "")
        found = []
        for m in sorted(everyone, key=lambda m: -len(m.name)):
            at = re.search(
                rf"(?<![\w@])@{re.escape(m.name)}(?!\w)", bare, re.IGNORECASE
            )
            if at:
                found.append((at.start(), m.id))
                # a longer name used these characters: a shorter one inside it is not a second mention
                bare = (
                    bare[: at.start()]
                    + " " * (at.end() - at.start())
                    + bare[at.end() :]
                )
        ids += [i for _, i in sorted(found) if i not in ids]
    if not ids:
        return []
    rows = (
        await session.exec(
            select(Member).where(
                col(Member.id).in_(ids),
                Member.project_id == project_id,
                Member.kind == "ai",
            )
        )
    ).all()
    by_id = {m.id: m for m in rows}
    return [by_id[i] for i in ids if i in by_id]


async def _board_note(ticket_id: str, text: str) -> None:
    async with database.async_session() as session:
        await svc_tickets.add_comment(
            session, ticket_id, text, author=BOARD_AUTHOR, meta={"board_note": True}
        )


async def deliver(
    ticket_id: str,
    text: str,
    *,
    by: str,
    intent: str = "ask",
    source_comment_id: str | None = None,
    source: str = "comment",
) -> list[dict]:
    """Act on a person's mentions of AI members. Returns what happened per member."""
    from . import runs

    if intent not in INTENTS:
        intent = "ask"
    out: list[dict] = []
    async with database.async_session() as session:
        ticket = await session.get(Ticket, ticket_id)
        if ticket is None:
            return out
        targets = await mentioned_ai(session, ticket.project_id, text)
        if not targets:
            return out
        settings = await get_settings(session, ticket.project_id)
        if not settings.ai_enabled:
            # AI is off for the project: an old mention is plain text; nothing runs and nobody is told
            return [
                {"member_id": m.id, "result": "not_delivered", "reason": "AI is off"}
                for m in targets
            ]
        if intent == "notify":
            return [{"member_id": m.id, "result": "notified"} for m in targets]
        from .assist.drafts import role_of

        if await role_of(session, ticket.project_id, by) == "viewer":
            await _board_note(
                ticket_id,
                "Mention not delivered: only members can ask an AI. A viewer can read the answers.",
            )
            return [
                {"member_id": m.id, "result": "not_delivered", "reason": "viewer"}
                for m in targets
            ]
        if settings.paused_all:
            await _board_note(
                ticket_id,
                "Mention not delivered: AI is paused for this project. "
                "@mention again after AI is resumed.",
            )
            return [
                {"member_id": m.id, "result": "not_delivered", "reason": "AI paused"}
                for m in targets
            ]
        instruction = plain(text)
        if source == "test_case":
            instruction = f"(From a test case note) {instruction}"
        for m in targets:
            try:
                if intent == "work":
                    if ticket.assignee != m.id:
                        await svc_tickets.update_ticket(
                            session, ticket_id, TicketUpdate(assignee=m.id)
                        )
                    run = await runs.create_run(
                        session,
                        ticket_id=ticket_id,
                        member_id=m.id,
                        mode="work",
                        trigger="mention",
                        started_by=by,
                        instruction=instruction,
                        source_comment_id=source_comment_id,
                    )
                else:
                    run = await runs.create_run(
                        session,
                        ticket_id=ticket_id,
                        member_id=m.id,
                        mode="ask",
                        trigger="ask",
                        started_by=by,
                        instruction=instruction,
                        source_comment_id=source_comment_id,
                    )
                out.append(
                    {
                        "member_id": m.id,
                        "result": "run",
                        "run_id": run.id,
                        "mode": run.mode,
                    }
                )
            except runs.RunError as exc:
                out.append({"member_id": m.id, "result": "refused", "reason": str(exc)})
                await _board_note(
                    ticket_id, f"Mention of {m.name} not delivered: {exc}"
                )
    return out


async def _cooldown_left(session, ticket_id: str, cooldown_s: int) -> int:
    """Seconds left of the cooldown between AI-to-AI mentions on a ticket (so replies cannot ping-pong), or 0."""
    if cooldown_s <= 0:
        return 0
    from datetime import UTC, datetime

    from models import AiRun

    from .store import parse_iso

    runs = (
        await session.exec(
            select(AiRun)
            .where(AiRun.ticket_id == ticket_id, AiRun.trigger == "mention")
            .order_by(col(AiRun.queued_at).desc())
            .limit(5)
        )
    ).all()
    last = next((r for r in runs if loads(r.chain, [])), None)
    queued = parse_iso(last.queued_at) if last else None
    if queued is None:
        return 0
    left = cooldown_s - (datetime.now(UTC) - queued).total_seconds()
    return int(left) + 1 if left > 0 else 0


async def from_ai_comment(ctx: RunContext, ticket_id: str, comment: dict) -> None:
    """An AI member mentioned other AI members: each mention is one chain hop, answered as an Ask. For a target that
    is billed by the call (an API-key member), past the maximum depth, when it is already in the chain or inside the
    cooldown, the mention is not delivered and a note says why. A target that runs on a person's own CLI (Claude Code,
    Antigravity) is not held back by those: only the project's AI pause stops it."""
    from . import runs

    text = comment.get("text") or ""
    async with database.async_session() as session:
        targets = [
            m
            for m in await mentioned_ai(session, ctx.project_id, text, plain_names=True)
            if m.id != ctx.member_id
        ]
        if not targets:
            return
        settings = await get_settings(session, ctx.project_id)
        chain = [*ctx.chain, ctx.member_id]
        names = {
            m.id: m.name
            for m in (
                await session.exec(select(Member).where(col(Member.id).in_(chain)))
            ).all()
        }
        cooling = await _cooldown_left(session, ticket_id, settings.loop_cooldown_s)
        for m in targets:
            path = " → ".join([ctx.on_behalf_of, *[names.get(i, "AI") for i in chain]])
            target = await session.get(AiMember, m.id)
            own_cli = target is not None and target.connection != "api_key"
            repeats = m.id in chain and settings.no_repeat_chain and not own_cli
            deep = len(chain) >= settings.max_chain_depth and not own_cli
            waiting = cooling if not own_cli else 0
            if repeats or deep or settings.paused_all or waiting:
                why = (
                    "AI is paused for this project"
                    if settings.paused_all
                    else f"{m.name} is already in it"
                    if repeats
                    else f"it is at depth {len(chain)} of {settings.max_chain_depth}"
                    if deep
                    else f"the cooldown between AI mentions on this ticket has {waiting} s left"
                )
                await _board_note(
                    ticket_id,
                    f"Mention not delivered. The chain {path} → {m.name}: {why}. @mention again yourself to continue.",
                )
                await audit.record(
                    ctx.project_id,
                    "mention",
                    "blocked",
                    member_id=ctx.member_id,
                    member_name=ctx.member_name,
                    on_behalf_of=ctx.on_behalf_of,
                    run_id=ctx.run_id,
                    target=ticket_id,
                    detail={"to": m.name, "reason": why, "chain": chain},
                )
                continue
            try:
                await runs.create_run(
                    session,
                    ticket_id=ticket_id,
                    member_id=m.id,
                    mode="ask",
                    trigger="mention",
                    started_by=ctx.on_behalf_of,
                    instruction=plain(text),
                    source_comment_id=comment.get("id"),
                    chain=chain,
                )
            except runs.RunError as exc:
                await _board_note(
                    ticket_id, f"Mention of {m.name} not delivered: {exc}"
                )


def chain_of(run) -> list[str]:
    """Member ids in a run's mention chain."""
    return loads(run.chain, [])


async def deliver_reply(
    ticket_id: str, text: str, *, by: str, reply_to: str, source_comment_id: str
) -> dict | None:
    """Replying under an AI's comment asks that AI again (design C2, “Reply asks again”): an ask run, no dialog and
    no @mention needed. Returns what happened, or None when the comment is not an AI's (or the AI is already
    mentioned in the reply, which delivers it)."""
    from . import runs

    async with database.async_session() as session:
        ticket = await session.get(Ticket, ticket_id)
        if ticket is None:
            return None
        target = next(
            (c for c in loads(ticket.comments, []) if c.get("id") == reply_to), None
        )
        member_id = ((target or {}).get("ai") or {}).get("member_id")
        if not member_id:
            return None
        mentioned = await mentioned_ai(session, ticket.project_id, text)
        if any(m.id == member_id for m in mentioned):
            return None
        member = await session.get(Member, member_id)
        if member is None or member.kind != "ai":
            return None
        settings = await get_settings(session, ticket.project_id)
        if settings.paused_all:
            await _board_note(
                ticket_id,
                "Reply not delivered: AI is paused for this project. Reply again after AI is resumed.",
            )
            return {"member_id": member_id, "result": "not_delivered"}
        try:
            run = await runs.create_run(
                session,
                ticket_id=ticket_id,
                member_id=member_id,
                mode="ask",
                trigger="reply",
                started_by=by,
                instruction=plain(text),
                source_comment_id=source_comment_id,
            )
        except runs.RunError as exc:
            await _board_note(ticket_id, f"Reply to {member.name} not delivered: {exc}")
            return {"member_id": member_id, "result": "refused", "reason": str(exc)}
        return {
            "member_id": member_id,
            "result": "run",
            "run_id": run.id,
            "mode": "ask",
        }
