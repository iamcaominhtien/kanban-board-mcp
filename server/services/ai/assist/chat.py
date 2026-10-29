"""Board AI chat (design/screens/ai-board-assistant.md, B): chats private to the person, answers streamed into the
message row, visible thinking steps, Stop keeps the partial text, rate limits queue with a countdown, suggested actions
become drafts with a preview."""

import asyncio
import json
import logging
import uuid
from datetime import UTC, datetime, timedelta

from sqlmodel import col, delete, func, or_, select
from sqlmodel.ext.asyncio.session import AsyncSession

import database
import events as board_events
import services.tickets as svc_tickets
from models import AiChat, AiChatMessage, AiDraft, Member, Project, Ticket

from .. import budget, llm
from ..providers import cost_of
from ..store import loads, now_iso, parse_iso
from . import context as ctxb
from . import drafts as svc_drafts
from . import prompts, scopes
from . import settings as svc_settings
from .settings import AssistError

log = logging.getLogger(__name__)

KEEP_DAYS = 30
HISTORY = 6
TIMEOUT_S = 120.0
TASKS: dict[str, asyncio.Task] = {}
ACTIVE = ("queued", "thinking", "streaming", "rate_limited")


def _msg(m: AiChatMessage) -> dict:
    return {
        "id": m.id,
        "chat_id": m.chat_id,
        "role": m.role,
        "text": m.text,
        "state": m.state,
        "steps": loads(m.steps, []),
        "context": loads(m.context, {}),
        "actions": loads(m.actions, []),
        "draft_id": m.draft_id,
        "error": loads(m.error, {}),
        "retry_at": m.retry_at,
        "member_id": m.member_id,
        "model": m.model,
        "cost": m.cost,
        "tokens_in": m.tokens_in,
        "tokens_out": m.tokens_out,
        "metered": m.metered,
        "created_at": m.created_at,
        "finished_at": m.finished_at,
        "feedback": loads(getattr(m, "feedback", "{}"), {}) or None,
    }


def _chat(c: AiChat) -> dict:
    return {
        "id": c.id,
        "project_id": c.project_id,
        "owner": c.owner,
        "title": c.title,
        "scope": c.scope,
        "scope_id": c.scope_id,
        "member_id": c.member_id,
        "ticket_id": c.ticket_id,
        "doc_id": c.doc_id,
        "include_docs": loads(c.include_docs, []),
        "cost": c.cost,
        "tokens": c.tokens,
        "applied": c.applied,
        "created_at": c.created_at,
        "updated_at": c.updated_at,
    }


async def _publish() -> None:
    await board_events.publish(board_events.INVALIDATE)


async def purge(session: AsyncSession) -> int:
    """Chats are kept 30 days, then deleted (a chat that applied changes keeps only its Activity lines)."""
    cutoff = (datetime.now(UTC) - timedelta(days=KEEP_DAYS)).isoformat()
    old = (
        await session.exec(select(AiChat).where(col(AiChat.updated_at) < cutoff))
    ).all()
    for c in old:
        await session.exec(delete(AiChatMessage).where(AiChatMessage.chat_id == c.id))
        await session.delete(c)
    if old:
        await session.commit()
    return len(old)


async def list_chats(
    session: AsyncSession, project_id: str, owner: str, q: str | None = None
) -> dict:
    """A person's chats in a project, newest first, with the count and this month's cost (B3)."""
    await purge(session)
    stmt = select(AiChat).where(AiChat.project_id == project_id, AiChat.owner == owner)
    if q and q.strip():
        like = f"%{q.strip()}%"
        ids = (
            await session.exec(
                select(AiChatMessage.chat_id).where(col(AiChatMessage.text).ilike(like))
            )
        ).all()
        stmt = stmt.where(
            or_(col(AiChat.title).ilike(like), col(AiChat.id).in_(list(ids) or [""]))
        )
    chats = (await session.exec(stmt.order_by(col(AiChat.updated_at).desc()))).all()
    month = budget.month_start().isoformat()
    month_cost = (
        await session.exec(
            select(func.coalesce(func.sum(AiChat.cost), 0.0)).where(
                AiChat.owner == owner, col(AiChat.updated_at) >= month
            )
        )
    ).one()
    total = (
        await session.exec(
            select(func.count()).where(
                AiChat.owner == owner, AiChat.project_id == project_id
            )
        )
    ).one()
    return {
        "chats": [_chat(c) for c in chats],
        "count": int(total or 0),
        "month_cost": round(float(month_cost or 0), 4),
        "keep_days": KEEP_DAYS,
    }


def valid_scope(scope: str) -> bool:
    """The board-wide kinds and every registered scope kind."""
    return scope in ("project", "all") or scopes.get(scope) is not None


async def create_chat(
    session: AsyncSession,
    project_id: str,
    owner: str,
    *,
    scope: str = "project",
    ticket_id: str | None = None,
    doc_id: str | None = None,
    scope_id: str | None = None,
    member_id: str | None = None,
) -> AiChat:
    """New chat ("New chat" or the first question)."""
    if not valid_scope(scope):
        raise AssistError(
            "invalid",
            "Scope: this ticket, this project, all projects, this page or another thing that has a chat.",
        )
    if await session.get(Project, project_id) is None:
        raise AssistError("not_found", "Project not found.")
    if scope == "ticket":
        scope_id = scope_id or ticket_id
        ticket_id = ticket_id or scope_id
    elif scope == "doc":
        scope_id = scope_id or doc_id
        doc_id = doc_id or scope_id
    c = AiChat(
        id=str(uuid.uuid4()),
        project_id=project_id,
        owner=owner,
        scope=scope,
        scope_id=scope_id,
        member_id=member_id,
        ticket_id=ticket_id,
        doc_id=doc_id,
        created_at=now_iso(),
        updated_at=now_iso(),
    )
    session.add(c)
    await session.commit()
    await session.refresh(c)
    return c


async def scope_chat(
    session: AsyncSession,
    kind: str,
    scope_id: str,
    owner: str,
    *,
    fresh: bool = False,
    create: bool = True,
) -> AiChat | None:
    """The person's saved chat about one thing (a ticket, a page, an idea…): the newest one, so closing and
    reopening the thing picks the conversation up again. `fresh` starts a new one. Chats are private: only the
    asker's own are ever returned."""
    provider = scopes.get(kind)
    if provider is None:
        raise AssistError("invalid", f"Nothing to chat about called {kind!r}.")
    info = await provider.info(session, scope_id, owner)
    if not fresh:
        row = (
            await session.exec(
                select(AiChat)
                .where(
                    AiChat.owner == owner,
                    AiChat.scope == kind,
                    AiChat.scope_id == scope_id,
                )
                .order_by(col(AiChat.updated_at).desc())
            )
        ).first()
        if row is not None or not create:
            return row
    elif not create:
        return None
    return await create_chat(
        session, info.project_id, owner, scope=kind, scope_id=scope_id
    )


async def get_chat(session: AsyncSession, chat_id: str, owner: str) -> AiChat:
    """A chat of this person (chats are private)."""
    c = await session.get(AiChat, chat_id)
    if c is None or c.owner != owner:
        raise AssistError("not_found", "Chat not found.")
    return c


async def chat_detail(session: AsyncSession, chat_id: str, owner: str) -> dict:
    """The chat with its messages and the drafts they produced."""
    c = await get_chat(session, chat_id, owner)
    msgs = (
        await session.exec(
            select(AiChatMessage)
            .where(AiChatMessage.chat_id == c.id)
            .order_by(col(AiChatMessage.created_at))
        )
    ).all()
    draft_ids = [m.draft_id for m in msgs if m.draft_id]
    drafts = (
        (
            await session.exec(select(AiDraft).where(col(AiDraft.id).in_(draft_ids)))
        ).all()
        if draft_ids
        else []
    )
    return {
        **_chat(c),
        "messages": [_msg(m) for m in msgs],
        "drafts": [svc_drafts.describe(d) for d in drafts],
    }


async def update_chat(
    session: AsyncSession, chat_id: str, owner: str, data: dict
) -> AiChat:
    """Scope switch and "Include for this chat" of a private doc (only its owner may include it)."""
    c = await get_chat(session, chat_id, owner)
    if "scope" in data and data["scope"]:
        if not valid_scope(data["scope"]):
            raise AssistError("invalid", "Unknown scope.")
        c.scope = data["scope"]
    if "ticket_id" in data:
        c.ticket_id = data["ticket_id"]
        if c.scope == "ticket":
            c.scope_id = c.ticket_id
    if "doc_id" in data:
        c.doc_id = data["doc_id"]
        if c.scope == "doc":
            c.scope_id = c.doc_id
    if "member_id" in data:
        c.member_id = data["member_id"] or None
    if "include_doc" in data and data["include_doc"]:
        from models import DocsPage

        page = await session.get(DocsPage, data["include_doc"])
        if page is None:
            raise AssistError("not_found", "Doc not found.")
        if page.created_by not in (owner, "user") and owner != "user":
            raise AssistError(
                "forbidden", "Only the doc's owner can include it for one chat."
            )
        inc = set(loads(c.include_docs, []))
        inc.add(page.id)
        c.include_docs = json.dumps(sorted(inc))
    c.updated_at = now_iso()
    session.add(c)
    await session.commit()
    await session.refresh(c)
    return c


async def delete_chat(session: AsyncSession, chat_id: str, owner: str) -> None:
    """Delete a chat and its messages."""
    c = await get_chat(session, chat_id, owner)
    await session.exec(delete(AiChatMessage).where(AiChatMessage.chat_id == c.id))
    await session.delete(c)
    await session.commit()


def _scoped(c: AiChat) -> bool:
    """Chats about one thing (a ticket, a page, an idea) are asked by members only, with the person's own answerer."""
    return scopes.get(c.scope) is not None and c.scope not in ("project", "all")


async def _member_for(session: AsyncSession, c: AiChat) -> str | None:
    """Who answers: the chat's chosen member; in a chat about one thing, else the ticket's AI assignee, else the
    Board AI, else any AI member that can. The board-wide dock keeps asking the Board AI only."""
    if c.member_id or not _scoped(c):
        return c.member_id
    prefer = None
    if c.scope == "ticket" and c.scope_id:
        t = await session.get(Ticket, c.scope_id)
        prefer = t.assignee if t else None
    return await svc_settings.resolve_member(session, c.project_id, None, prefer)


def _feature(c: AiChat) -> str:
    return "docs" if c.scope in ("doc", "idea") else "chat"


async def send(
    session: AsyncSession,
    chat_id: str,
    owner: str,
    text: str,
    *,
    draft_request: bool = False,
    send_all: bool = False,
    doc_ids: list[str] | None = None,
    filters: dict | None = None,
    mode: str = "ask",
    member_id: str | None = None,
) -> dict:
    """Post the person's message and start the answer (it streams into the AI message).

    `mode` "ask" (the default) only ever answers: nothing is run and nothing changes. "work" starts a run of an AI
    member on the chat's ticket, with the same limits, permissions and approvals as an assignment."""
    c = await get_chat(session, chat_id, owner)
    text = (text or "").strip()
    if not text:
        raise AssistError("invalid", "Write a question first.")
    if mode not in ("ask", "work"):
        raise AssistError("invalid", "Mode: ask only, or do the work.")
    if member_id is not None and member_id != c.member_id:
        c.member_id = member_id or None
    if _scoped(c):
        provider = scopes.get(c.scope)
        await provider.info(
            session, c.scope_id or "", owner
        )  # unknown or not yours: refused here
    if mode == "work":
        return await _send_work(session, c, owner, text)
    feature = _feature(c)
    over: AssistError | None = None
    try:
        info = await svc_settings.guard_request(
            session,
            c.project_id,
            feature,
            person=owner,
            member_id=await _member_for(session, c),
            require_member=_scoped(c),
        )
    except AssistError as exc:
        if exc.code != "over_budget":
            raise
        over, info = exc, None
    user = AiChatMessage(
        id=str(uuid.uuid4()),
        chat_id=c.id,
        role="user",
        text=text[:8000],
        created_at=now_iso(),
    )
    ai = AiChatMessage(
        id=str(uuid.uuid4()),
        chat_id=c.id,
        role="ai",
        state="over_budget" if over else "thinking",
        member_id=info["member"].id if info else c.member_id,
        created_at=now_iso(),
        context=json.dumps(
            {
                "request": {
                    "draft": draft_request,
                    "send_all": send_all,
                    "doc_ids": doc_ids or [],
                    "filters": filters or {},
                    "mode": "ask",
                }
            }
        ),
    )
    if over:
        ai.text = ""
        ai.error = json.dumps(
            {"code": "over_budget", "message": str(over), **over.extra}
        )
        ai.finished_at = now_iso()
    if c.title == "New chat":
        c.title = " ".join(text.split())[:60]
    c.updated_at = now_iso()
    session.add_all([user, ai, c])
    await session.commit()
    if not over:
        _spawn(ai.id)
    await _publish()
    return {"user": _msg(user), "ai": _msg(ai)}


async def _send_work(session: AsyncSession, c: AiChat, owner: str, text: str) -> dict:
    """ "Do the work": the person's message becomes the instruction of a work run on the chat's ticket. The run is
    queued like any other (budgets, slots, permissions, approvals for risky steps, stops at Review)."""
    from models import TicketUpdate

    from .. import runs as ai_runs
    from ..store import get_settings

    if c.scope != "ticket" or not c.scope_id:
        raise AssistError(
            "invalid",
            "Do the work starts a run on a ticket; open the chat on a ticket.",
        )
    # the same gates as a question: AI on, viewer, member usable, caps
    info = await svc_settings.guard_request(
        session,
        c.project_id,
        "chat",
        person=owner,
        member_id=await _member_for(session, c),
        require_member=True,
    )
    member, profile = info["member"], info["profile"]
    if profile.connection == "inbox":
        raise AssistError(
            "unavailable",
            f"{member.name} is an inbox-only client and cannot be started here.",
        )
    project_settings = await get_settings(session, c.project_id)
    if project_settings.paused_all:
        raise AssistError(
            "unavailable",
            "AI is paused for this project. Resume it from the AI page first.",
        )
    ticket = await session.get(Ticket, c.scope_id)
    try:
        if ticket.assignee != member.id:
            await svc_tickets.update_ticket(
                session, ticket.id, TicketUpdate(assignee=member.id)
            )
        run = await ai_runs.create_run(
            session,
            ticket_id=ticket.id,
            member_id=member.id,
            mode="work",
            trigger="chat",
            started_by=owner,
            instruction=text[:8000],
        )
    except ai_runs.RunError as exc:
        raise AssistError("run_refused", str(exc)) from exc
    user = AiChatMessage(
        id=str(uuid.uuid4()),
        chat_id=c.id,
        role="user",
        text=text[:8000],
        created_at=now_iso(),
    )
    ai = AiChatMessage(
        id=str(uuid.uuid4()),
        chat_id=c.id,
        role="ai",
        state="done",
        member_id=member.id,
        text=(
            f"Started run #{run.number} with {member.name} on {ticket.id}. It works through the same limits as an"
            " assignment, stops at Review, and asks you before risky steps."
        ),
        context=json.dumps(
            {
                "request": {"mode": "work"},
                "scope": c.scope,
                "run": {
                    "id": run.id,
                    "number": run.number,
                    "member_id": member.id,
                    "member_name": member.name,
                },
            }
        ),
        created_at=now_iso(),
        finished_at=now_iso(),
        metered=False,
    )
    if c.title == "New chat":
        c.title = " ".join(text.split())[:60]
    c.updated_at = now_iso()
    session.add_all([user, ai, c])
    await session.commit()
    await _publish()
    return {"user": _msg(user), "ai": _msg(ai)}


def _spawn(message_id: str, delay: float = 0.0) -> None:
    task = asyncio.create_task(_answer(message_id, delay))
    TASKS[message_id] = task
    task.add_done_callback(
        lambda _t: TASKS.pop(message_id, None) if TASKS.get(message_id) is _t else None
    )


async def _set(message_id: str, **fields) -> None:
    async with database.async_session() as session:
        m = await session.get(AiChatMessage, message_id)
        if m is None:
            return
        for k, v in fields.items():
            setattr(
                m,
                k,
                json.dumps(v) if k in ("steps", "context", "actions", "error") else v,
            )
        session.add(m)
        await session.commit()


async def _answer(message_id: str, delay: float = 0.0) -> None:
    if delay > 0:
        await asyncio.sleep(delay)
    async with database.async_session() as session:
        m = await session.get(AiChatMessage, message_id)
        if m is None or m.state not in ("thinking", "rate_limited", "queued"):
            return
        c = await session.get(AiChat, m.chat_id)
        req = loads(m.context, {}).get("request") or {}
        history = (
            await session.exec(
                select(AiChatMessage)
                .where(
                    AiChatMessage.chat_id == c.id,
                    AiChatMessage.created_at <= m.created_at,
                )
                .order_by(col(AiChatMessage.created_at).desc())
                .limit(HISTORY * 2 + 2)
            )
        ).all()
        history = list(reversed(history))
        question = next((h.text for h in reversed(history) if h.role == "user"), "")
        try:
            info = await svc_settings.guard_request(
                session,
                c.project_id,
                _feature(c),
                person=c.owner,
                member_id=await _member_for(session, c),
                require_member=_scoped(c),
            )
        except AssistError as exc:
            await _set(
                message_id,
                state="over_budget" if exc.code == "over_budget" else "error",
                error={"code": exc.code, "message": str(exc), **exc.extra},
                finished_at=now_iso(),
            )
            await _publish()
            return
        profile, member = info["profile"], info["member"]
        row = await svc_settings.get(session)
        project = await session.get(Project, c.project_id)
        scope = c.scope
        provider = scopes.get(scope) if scope not in ("project", "all") else None
        scope_info = None
        if provider is not None:
            scope_info = await provider.info(session, c.scope_id or "", c.owner)
            built = await provider.context(
                session,
                info=scope_info,
                person=c.owner,
                question=question,
                send_all=bool(req.get("send_all")),
                include_docs=loads(c.include_docs, []),
                doc_ids=list(req.get("doc_ids") or []),
            )
        else:
            built = await ctxb.build(
                session,
                project_id=c.project_id,
                scope=scope,
                person=c.owner,
                ticket_id=c.ticket_id,
                doc_ids=list(req.get("doc_ids") or []),
                include_docs=loads(c.include_docs, []),
                filters=req.get("filters") or {},
                question=question,
                send_all=bool(req.get("send_all")),
            )
        members = (
            await session.exec(select(Member).where(Member.project_id == c.project_id))
        ).all()
        tickets_state, names = await svc_drafts._ticket_state(session, c.project_id)
    steps = [{"text": s, "at": now_iso()} for s in built.steps]
    steps.append({"text": "Writing the answer", "at": now_iso()})
    await _set(
        message_id,
        state="thinking",
        steps=steps,
        member_id=member.id,
        model=profile.model,
        metered=profile.connection == "api_key",
        context={**built.summary(), "request": req, "scope": scope},
        retry_at=None,
        error={},
    )
    await _publish()

    people = ", ".join(
        f"{x.name}{' (AI member)' if x.kind == 'ai' else ''}"
        for x in members
        if x.kind in ("human", "ai")
    )
    convo = []
    for h in history[:-1]:
        if h.id == message_id:
            continue
        who = "Person" if h.role == "user" else "You"
        convo.append(f"{who}: {h.text[:1500]}")
    if provider is not None and scope_info is not None:
        scope_line = provider.scope_line(scope_info)
    else:
        scope_line = {
            "project": f"Scope: the project {project.name if project else ''}.",
            "all": "Scope: every project the person belongs to.",
        }[scope]
    extra = prompts.CHAT_FORMAT
    if provider is not None and provider.format_extra:
        extra += "\n" + provider.format_extra
    if req.get("draft"):
        extra += "\nThis request is a suggested action: answer in one sentence and put the change in the actions block."
    partial = str(req.get("continue_from") or "")
    if partial:
        extra += (
            "\nYour previous answer was cut short at the length limit. Continue exactly where it stopped,"
            " without repeating anything, and without an actions block unless the earlier part promised one."
        )
    system = prompts.system(member.name, project.name if project else "", row, extra)
    prompt = "\n\n".join(
        [
            scope_line,
            f"Members of the project: {people}",
            "Board context:\n" + built.text,
            ("Earlier in this chat:\n" + "\n".join(convo)) if convo else "",
            "The person asks:\n" + ctxb.fence("question", question),
            ("Your answer so far:\n" + partial[-3000:]) if partial else "",
        ]
    )
    buf: list[str] = [partial] if partial else []
    last_flush = [0.0]
    loop = asyncio.get_running_loop()

    async def on_delta(piece: str) -> None:
        buf.append(piece)
        now = loop.time()
        if now - last_flush[0] > 0.25:
            last_flush[0] = now
            await _set(message_id, state="streaming", text="".join(buf))
            if int(now) % 2 == 0:
                await _publish()

    max_tokens = svc_settings.max_tokens_for(row, profile, 1800)
    try:
        out = await llm.complete(
            profile,
            system=system,
            prompt=prompt,
            max_tokens=max_tokens,
            timeout=TIMEOUT_S,
            on_delta=on_delta,
        )
    except asyncio.CancelledError:
        partial = "".join(buf)
        n = llm.estimate_tokens(partial)
        cost = (
            cost_of(profile.model, llm.estimate_tokens(prompt), n)
            if profile.connection == "api_key"
            else 0.0
        )
        await _set(
            message_id,
            state="stopped",
            text=partial,
            tokens_out=n,
            cost=round(cost, 6),
            finished_at=now_iso(),
        )
        await _account(message_id, cost, n)
        await _publish()
        raise
    except llm.LlmError as exc:
        if exc.kind == "rate":
            wait = float(exc.retry_after or 30.0)
            retry_at = (datetime.now(UTC) + timedelta(seconds=wait)).isoformat()
            await _set(
                message_id,
                state="rate_limited",
                retry_at=retry_at,
                error={
                    "code": "rate",
                    "message": str(exc),
                    "provider": profile.provider,
                },
            )
            await _publish()
            _spawn(message_id, delay=wait)
            return
        await _set(
            message_id,
            state="error",
            text="".join(buf),
            error={
                "code": exc.kind,
                "message": str(exc),
                "status": exc.status,
                "provider": profile.provider,
                "elapsed": None,
            },
            finished_at=now_iso(),
        )
        await _publish()
        return
    except Exception as exc:  # noqa: BLE001 - an answer that fails must say so
        log.exception("Board AI answer %s failed", message_id)
        await _set(
            message_id,
            state="error",
            error={
                "code": "error",
                "message": f"Couldn't get an answer ({type(exc).__name__}).",
            },
            finished_at=now_iso(),
        )
        await _publish()
        return

    raw_text = partial + out.text if partial else out.text
    text, block = prompts.split_actions(raw_text)
    if out.stop_reason == "max_tokens" and not block:
        text = raw_text  # keep the cut exactly, so Continue can pick up mid-sentence
    raw_changes = block.get("changes") or []
    own = [
        ch
        for ch in raw_changes
        if provider is not None
        and isinstance(ch, dict)
        and ch.get("op") not in scopes.CORE_OPS
        and ch.get("op") not in ("status", "priority")
    ]
    core = [ch for ch in raw_changes if ch not in own]
    changes, problems = prompts.check_changes(core, tickets_state, names)
    for ch in own:
        ok = provider.validate_change(ch, scope_info) if scope_info else None
        if ok:
            changes.append({**ok, "scope": scope})
        else:
            problems.append(f"Unknown change {ch.get('op')!r}")
    suggestions = prompts.check_suggestions(block.get("suggestions") or [])
    draft_id = None
    if changes:
        async with database.async_session() as session:
            base = {}
            for ch in changes:
                t = await session.get(Ticket, ch["ticket"])
                if t:
                    base[t.id] = t.updated_at
            d = await svc_drafts.start(
                session,
                project_id=c.project_id,
                kind="changes",
                owner=c.owner,
                payload={
                    "changes": changes,
                    "problems": problems,
                    "intro": "Here is what I would change.",
                },
                chat_message_id=message_id,
                member=member,
            )
            d.base = json.dumps(base)
            session.add(d)
            await session.commit()
            draft_id = d.id
    cut_short = out.stop_reason == "max_tokens"
    await _set(
        message_id,
        state="done",
        text=text or ("Here is what I would change." if changes else out.text),
        actions=suggestions,
        draft_id=draft_id,
        cost=out.cost,
        tokens_in=out.tokens_in,
        tokens_out=out.tokens_out,
        finished_at=now_iso(),
        error={"problems": problems} if problems else {},
        context={
            **built.summary(),
            "request": req,
            "scope": scope,
            **({"cut_short": True} if cut_short else {}),
        },
    )
    async with database.async_session() as session:
        await svc_settings.record_usage(
            session,
            c.project_id,
            _feature(c),
            member.id,
            c.owner,
            out,
        )
    await _account(message_id, out.cost, out.tokens_in + out.tokens_out)
    await _publish()


async def _account(message_id: str, cost: float, tokens: int) -> None:
    async with database.async_session() as session:
        m = await session.get(AiChatMessage, message_id)
        if m is None:
            return
        c = await session.get(AiChat, m.chat_id)
        c.cost = round(c.cost + (cost or 0), 6)
        c.tokens += int(tokens or 0)
        c.updated_at = now_iso()
        session.add(c)
        await session.commit()


async def stop(session: AsyncSession, message_id: str, owner: str) -> dict:
    """Stop an answer; the partial text is kept and tokens used so far are still charged (B4, B5)."""
    m = await session.get(AiChatMessage, message_id)
    if m is None:
        raise AssistError("not_found", "Message not found.")
    await get_chat(session, m.chat_id, owner)
    task = TASKS.get(message_id)
    if task:
        task.cancel()
        try:
            await asyncio.wait_for(asyncio.shield(task), 5)
        except (asyncio.CancelledError, asyncio.TimeoutError, Exception):  # noqa: BLE001
            pass
    async with database.async_session() as s2:
        m = await s2.get(AiChatMessage, message_id)
        if m.state in ACTIVE:
            m.state = "stopped"
            m.finished_at = now_iso()
            s2.add(m)
            await s2.commit()
        await s2.refresh(m)
        out = _msg(m)
    await _publish()
    return out


async def retry(
    session: AsyncSession,
    message_id: str,
    owner: str,
    *,
    send_all: bool = False,
    continue_: bool = False,
) -> dict:
    """Try again ("Try again", "Send now" on a rate limit, "Send all" for a truncated context). With `continue_` an
    answer cut short at the length limit goes on from where it stopped and keeps what it had."""
    m = await session.get(AiChatMessage, message_id)
    if m is None or m.role != "ai":
        raise AssistError("not_found", "Message not found.")
    await get_chat(session, m.chat_id, owner)
    task = TASKS.get(message_id)
    if task:
        task.cancel()
    ctx = loads(m.context, {})
    req = ctx.get("request") or {}
    if send_all:
        req["send_all"] = True
    if continue_:
        req["continue_from"] = m.text
    else:
        req.pop("continue_from", None)
        m.text = ""
    m.state = "thinking"
    m.error = "{}"
    m.retry_at = None
    m.finished_at = None
    m.draft_id = None
    m.context = json.dumps({"request": req})
    session.add(m)
    await session.commit()
    _spawn(message_id)
    await _publish()
    await session.refresh(m)
    return _msg(m)


async def post_as_comment(
    session: AsyncSession, message_id: str, owner: str, text: str | None = None
) -> dict:
    """ "Post as comment": the answer of a ticket chat becomes an ordinary comment the team sees. It is written under
    the AI member's name with the AI badge and says who asked; chats stay private until a person shares an answer.
    Mentions in the text are plain words, so posting can never wake an AI or notify people by accident."""
    from .. import mentions as ai_mentions

    m = await session.get(AiChatMessage, message_id)
    if m is None or m.role != "ai":
        raise AssistError("not_found", "Answer not found.")
    c = await get_chat(session, m.chat_id, owner)
    if c.scope != "ticket" or not c.scope_id:
        raise AssistError(
            "invalid", "Only an answer about a ticket can be posted as a comment."
        )
    if m.state not in ("done", "stopped"):
        raise AssistError("invalid", "Wait for the answer to finish.")
    from .drafts import role_of

    if await role_of(session, c.project_id, owner) == "viewer":
        raise AssistError(
            "viewer", "Only members can post to a ticket. You can still read it."
        )
    body = (text if text is not None else m.text or "").strip()
    if not body:
        raise AssistError("invalid", "There is nothing to post.")
    member = await session.get(Member, m.member_id) if m.member_id else None
    author = member.name if member else "Board AI"
    ticket = await svc_tickets.add_comment(
        session,
        c.scope_id,
        ai_mentions.plain(body),
        author=author,
        meta={
            "ai": {
                "kind": "chat_answer",
                "member_id": m.member_id,
                "model": m.model,
                "cost_usd": m.cost,
                "metered": m.metered,
                "asked_by": owner,
            }
        },
    )
    if ticket is None:
        raise AssistError("not_found", "Ticket not found.")
    comment = (loads(ticket.comments, [])[-1]) or {}
    ctx_now = loads(m.context, {})
    ctx_now["posted"] = {"comment_id": comment.get("id"), "at": now_iso(), "by": owner}
    m.context = json.dumps(ctx_now)
    session.add(m)
    await session.commit()
    await _publish()
    return {"comment_id": comment.get("id"), "ticket_id": c.scope_id}


async def set_feedback(
    session: AsyncSession, message_id: str, owner: str, thumb: str | None, reason: str
) -> dict:
    """Thumbs up / down on an answer, with an optional reason (kept for the project's AI settings and audit)."""
    m = await session.get(AiChatMessage, message_id)
    if m is None or m.role != "ai":
        raise AssistError("not_found", "Answer not found.")
    await get_chat(session, m.chat_id, owner)
    if thumb not in (None, "up", "down"):
        raise AssistError("invalid", "thumb must be up, down or empty.")
    m.feedback = json.dumps(
        {"thumb": thumb, "reason": (reason or "").strip()[:500], "at": now_iso()}
        if thumb
        else {}
    )
    session.add(m)
    await session.commit()
    return _msg(m)


async def get_message(session: AsyncSession, message_id: str, owner: str) -> dict:
    """One message (the dock polls an answer while it streams)."""
    m = await session.get(AiChatMessage, message_id)
    if m is None:
        raise AssistError("not_found", "Message not found.")
    await get_chat(session, m.chat_id, owner)
    out = _msg(m)
    if m.draft_id:
        d = await session.get(AiDraft, m.draft_id)
        out["draft"] = svc_drafts.describe(d) if d else None
    if m.state in ("thinking", "streaming"):
        started = parse_iso(m.created_at)
        out["elapsed_s"] = (
            int((datetime.now(UTC) - started).total_seconds()) if started else 0
        )
    return out


async def recover() -> None:
    """After a restart, answers that were still running are marked as stopped (nothing is left spinning)."""
    async with database.async_session() as session:
        rows = (
            await session.exec(
                select(AiChatMessage).where(col(AiChatMessage.state).in_(list(ACTIVE)))
            )
        ).all()
        for m in rows:
            m.state = "error"
            m.error = json.dumps(
                {
                    "code": "restart",
                    "message": "The board restarted before the answer came back. Try again.",
                }
            )
            m.finished_at = now_iso()
            session.add(m)
        drafts = (
            await session.exec(select(AiDraft).where(AiDraft.status == "pending"))
        ).all()
        for d in drafts:
            d.status = "failed"
            d.result = json.dumps(
                {
                    "error": {
                        "code": "restart",
                        "message": "The board restarted before the draft came back. Try again.",
                    }
                }
            )
            session.add(d)
        await session.commit()
