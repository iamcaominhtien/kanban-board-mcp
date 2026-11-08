"""Board AI chat on the assistant engine (AI v2): a chat is one Claude Code conversation (`chat:<id>`), an answer
is one turn with the `board-ask` skill. The assistant reads the board with its tools and acts with the asker's own
rights; there are no drafts to apply any more: it does what was asked, and says what it did."""

import asyncio
import json
import logging
from typing import Any

from sqlmodel import col, func, select
from sqlmodel.ext.asyncio.session import AsyncSession

import database
import events as board_events
from models import AiChat, AiChatMessage, DocsPage, IdeaTicket, Project, Ticket
from services import tickets as svc_tickets
from services.ai.store import loads, now_iso

from . import drafts, engine, receipt, sessions
from . import settings as svc_settings
from .errors import AssistError

logger = logging.getLogger("kanban.assistant.chat")

KEEP_DAYS = 30
MAX_TEXT = 8000
SCOPES = ("ticket", "doc", "idea", "project", "all", "sketch")
ACTIVE = ("queued", "thinking", "streaming")
UNDOING: set[str] = set()
TASKS: dict[str, asyncio.Task] = {}
RUNS: dict[str, str] = {}  # message id -> the run of its turn (for Stop)


def msg_out(m: AiChatMessage) -> dict[str, Any]:
    """A chat message as the API shows it."""
    return {
        "id": m.id,
        "chat_id": m.chat_id,
        "role": m.role,
        "text": m.text,
        "state": m.state,
        "steps": loads(m.steps, []),
        "context": loads(m.context, {}),
        "actions": loads(m.actions, []),
        "draft_id": m.draft_id if m.draft_id in drafts.DRAFTS else None,
        "draft": drafts.DRAFTS.get(m.draft_id or ""),
        "error": loads(m.error, {}),
        "retry_at": m.retry_at,
        "member_id": m.member_id,
        "model": m.model,
        "cost": round(m.cost, 6),
        "tokens_in": m.tokens_in,
        "tokens_out": m.tokens_out,
        "metered": False,
        "created_at": m.created_at,
        "finished_at": m.finished_at,
        "feedback": loads(m.feedback, {}) or None,
    }


def chat_out(c: AiChat) -> dict[str, Any]:
    """A chat as the API shows it."""
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
        "cost": round(c.cost, 6),
        "tokens": c.tokens,
        "applied": c.applied,
        "summary": c.summary,
        "summary_upto": c.summary_upto,
        "compactions": c.compactions,
        "created_at": c.created_at,
        "updated_at": c.updated_at,
    }


async def _chat(session: AsyncSession, chat_id: str, by: str) -> AiChat:
    chat = await session.get(AiChat, chat_id)
    if chat is None or chat.owner != by:
        raise AssistError("not_found", "Chat not found.")
    return chat


async def _message(
    session: AsyncSession, message_id: str, by: str
) -> tuple[AiChatMessage, AiChat]:
    m = await session.get(AiChatMessage, message_id)
    if m is None:
        raise AssistError("not_found", "Message not found.")
    return m, await _chat(session, m.chat_id, by)


async def list_chats(
    session: AsyncSession, project_id: str, by: str, q: str | None = None
) -> dict[str, Any]:
    """The person's chats in a project, newest first, with this month's chat cost."""
    stmt = select(AiChat).where(AiChat.project_id == project_id, AiChat.owner == by)
    if q and q.strip():
        stmt = stmt.where(col(AiChat.title).ilike(f"%{q.strip()}%"))
    rows = (
        await session.exec(stmt.order_by(col(AiChat.updated_at).desc()).limit(200))
    ).all()
    return {
        "chats": [chat_out(c) for c in rows],
        "count": len(rows),
        "month_cost": await svc_settings.month_spend(session, "chat"),
        "keep_days": KEEP_DAYS,
    }


async def _target(
    session: AsyncSession, kind: str, scope_id: str | None
) -> tuple[str | None, str]:
    """(project id, title) of the thing a chat is about."""
    if kind == "ticket":
        t = await session.get(Ticket, scope_id or "")
        if t is None:
            raise AssistError("not_found", "Ticket not found.")
        return t.project_id, f"{t.id} {t.title}"
    if kind == "doc":
        p = await session.get(DocsPage, scope_id or "")
        if p is None:
            raise AssistError("not_found", "Page not found.")
        return p.project_id, p.title
    if kind == "idea":
        i = await session.get(IdeaTicket, scope_id or "")
        if i is None:
            raise AssistError("not_found", "Idea not found.")
        return i.project_id, i.title
    return None, ""


async def create_chat(
    session: AsyncSession,
    project_id: str,
    by: str,
    *,
    scope: str = "project",
    ticket_id: str | None = None,
    doc_id: str | None = None,
    scope_id: str | None = None,
    member_id: str | None = None,
    fresh: bool = False,
) -> AiChat:
    """A new chat, or the person's latest chat about the same thing."""
    if scope not in SCOPES:
        raise AssistError("invalid", "Unknown scope.")
    scope_id = scope_id or ticket_id or doc_id
    title = "New chat"
    if scope in ("ticket", "doc", "idea"):
        _pid, title = await _target(session, scope, scope_id)
        if not fresh:
            old = (
                await session.exec(
                    select(AiChat)
                    .where(
                        AiChat.owner == by,
                        AiChat.scope == scope,
                        AiChat.scope_id == scope_id,
                    )
                    .order_by(col(AiChat.updated_at).desc())
                    .limit(1)
                )
            ).first()
            if old is not None:
                return old
    chat = AiChat(
        project_id=project_id,
        owner=by,
        title=title[:80] or "New chat",
        scope=scope,
        scope_id=scope_id,
        ticket_id=scope_id if scope == "ticket" else ticket_id,
        doc_id=scope_id if scope == "doc" else doc_id,
        member_id=member_id,
    )
    session.add(chat)
    await session.commit()
    await session.refresh(chat)
    return chat


async def scope_chat(
    session: AsyncSession, kind: str, scope_id: str, by: str, *, fresh: bool = False
) -> AiChat:
    """The person's chat about a ticket, a page or an idea (a new one with `fresh`)."""
    project_id, _title = await _target(session, kind, scope_id)
    if project_id is None:
        project = (
            await session.exec(select(Project).order_by(col(Project.name)).limit(1))
        ).first()
        if project is None:
            raise AssistError("not_found", "There is no project to book the chat on.")
        project_id = project.id
    return await create_chat(
        session, project_id, by, scope=kind, scope_id=scope_id, fresh=fresh
    )


async def ticket_team(session: AsyncSession, ticket_id: str) -> dict[str, Any] | None:
    """The AI team that works a ticket: its AI assignee, else the team of its newest run. None: no team yet."""
    from models import AiRun, Member
    from services.ai.store import active_runs

    ticket = await session.get(Ticket, ticket_id)
    if ticket is None:
        return None
    team = None
    if ticket.assignee:
        m = await session.get(Member, ticket.assignee)
        team = m if (m is not None and m.kind == "ai") else None
    if team is None:
        last = (
            await session.exec(
                select(AiRun)
                .where(AiRun.ticket_id == ticket_id)
                .order_by(col(AiRun.queued_at).desc())
                .limit(1)
            )
        ).first()
        team = await session.get(Member, last.member_id) if last else None
    if team is None:
        return None
    working = bool(await active_runs(session, ticket_id=ticket_id))
    return {"id": team.id, "name": team.name, "working": working}


TEAM_NOTE = (
    "{by} writes to you in the ticket chat (chat message {mid}):\n\n{text}\n\n"
    "Do what they ask. Answer them in the chat with ai_run(action='reply', message_id='{mid}', text='…'): short, in "
    "Markdown. Then carry on with what you were doing: this message is not a reason to stop, hand in or change course, "
    "unless {by} tells you to stop. If you were not working on anything, this message is the whole task."
)


async def reply_from_team(
    ticket_id: str, text: str, *, member_id: str, message_id: str | None = None
) -> dict[str, Any]:
    """The lead's answer to a person's message in the ticket chat (`ai_run(action='reply')`): it fills the chat
    message that waits for it (the one named, else the newest on this ticket)."""
    text = (text or "").strip()
    if not text:
        raise ValueError("ai_run(action='reply') needs `text`.")
    async with database.async_session() as session:
        stmt = (
            select(AiChatMessage)
            .join(AiChat, AiChat.id == AiChatMessage.chat_id)
            .where(
                AiChat.scope == "ticket",
                AiChat.scope_id == ticket_id,
                AiChatMessage.role == "ai",
                AiChatMessage.member_id == member_id,
                col(AiChatMessage.state).in_(ACTIVE),
            )
            .order_by(col(AiChatMessage.created_at).desc())
        )
        if message_id:
            stmt = stmt.where(AiChatMessage.id == message_id)
        m = (await session.exec(stmt)).first()
        if m is None:
            raise ValueError(
                "No message in this ticket's chat waits for an answer: write a comment with ticket_items instead."
            )
        m.text = text[:20000]
        m.state = "done"
        m.finished_at = now_iso()
        session.add(m)
        await session.commit()
        mid = m.id
    await board_events.publish(board_events.INVALIDATE)
    return {"replied": True, "message_id": mid}


async def settle_team_messages(session: AsyncSession, chat: AiChat) -> None:
    """A message to the team that nobody answered, and the team has stopped: say so, so the chat does not wait forever."""
    if chat.scope != "ticket" or not chat.scope_id:
        return
    from services.ai.store import active_runs

    waiting = (
        await session.exec(
            select(AiChatMessage).where(
                AiChatMessage.chat_id == chat.id,
                AiChatMessage.role == "ai",
                col(AiChatMessage.state).in_(ACTIVE),
                col(AiChatMessage.member_id).is_not(None),
            )
        )
    ).all()
    if not waiting or await active_runs(session, ticket_id=chat.scope_id):
        return
    for m in waiting:
        m.text = "The team stopped before it answered here. What it did is in its report on the ticket."
        m.state = "done"
        m.finished_at = now_iso()
        session.add(m)
    await session.commit()


async def scope_state(
    session: AsyncSession, kind: str, scope_id: str, by: str
) -> dict[str, Any]:
    """The chat panel's state for a ticket, a page or an idea."""
    project_id, title = await _target(session, kind, scope_id)
    if kind not in ("ticket", "doc", "idea"):
        raise AssistError("not_found", "Nothing to chat about here.")
    info = (
        await engine.ready(project_id)
        if project_id
        else {"state": "ready", "message": "", "member": "Board AI"}
    )
    on = await svc_settings.feature_on(session, "chat")
    availability = (
        {"code": "feature_off", "message": "Ask AI is off in Settings › AI."}
        if not on
        else {"code": "ok"}
        if info["state"] == "ready"
        else {"code": "not_configured", "message": info["message"]}
    )
    chat = (
        await session.exec(
            select(AiChat)
            .where(
                AiChat.owner == by, AiChat.scope == kind, AiChat.scope_id == scope_id
            )
            .order_by(col(AiChat.updated_at).desc())
            .limit(1)
        )
    ).first()
    reading = {
        "ticket": [
            {"kind": "ticket", "label": "This ticket"},
            {"kind": "comments", "label": "Its comments"},
            {"kind": "docs", "label": "Linked pages"},
        ],
        "doc": [
            {"kind": "doc", "label": "This page"},
            {"kind": "docs", "label": "Pages it links"},
        ],
        "idea": [
            {"kind": "idea", "label": "This idea"},
            {"kind": "ideas", "label": "Related ideas"},
        ],
    }[kind]
    starting = {
        "ticket": [
            {
                "label": "Summarise this ticket",
                "request": "Summarise this ticket: what is asked, what is done, what is open.",
            },
            {
                "label": "What is left to do here?",
                "request": "What is left to do on this ticket? List what is open and what is unclear.",
            },
            {
                "label": "Who should review this?",
                "request": "Who should review this ticket, and why? Look at who worked on related tickets.",
            },
        ],
        "doc": [
            {
                "label": "Summarise this page",
                "request": "Summarise this page in five lines.",
            },
            {
                "label": "What is out of date?",
                "request": "What on this page looks out of date compared to the tickets and the code?",
            },
        ],
        "idea": [
            {
                "label": "Challenge this idea",
                "request": "Challenge this idea: the weakest assumptions first.",
            },
            {
                "label": "What is the smallest first step?",
                "request": "What is the smallest first step that would test this idea?",
            },
        ],
    }[kind]
    members: list[dict[str, Any]] = []
    member_id = None
    if kind == "ticket":
        team = await ticket_team(session, scope_id)
        if team:
            member_id = team["id"]
            members = [
                {
                    "id": team["id"],
                    "name": team["name"],
                    "board_ai": False,
                    "provider": "claude-code",
                    "connection": "local",
                    "metered": False,
                    "ready": True,
                    "status_code": None,
                    "status": "Working on this ticket" if team["working"] else "Idle",
                }
            ]
    return {
        "scope": {
            "kind": kind,
            "id": scope_id,
            "project_id": project_id or "",
            "title": title,
            "reading": reading,
            "starting_points": starting,
            "placeholder": "Ask about this "
            + {"ticket": "ticket", "doc": "page", "idea": "idea"}[kind]
            + "…",
            "work": False,
            "draft_kinds": [],
        },
        "availability": availability,
        "board_ai": {
            "name": info.get("member") or "Board AI",
            "provider_label": "Claude Code",
            "ready": info["state"] == "ready",
        },
        "members": members,
        "member_id": member_id,
        "estimate": None,
        "work": {"allowed": False, "estimate": None},
        "chat_id": chat.id if chat else None,
    }


async def detail(session: AsyncSession, chat_id: str, by: str) -> dict[str, Any]:
    """A chat with its messages."""
    chat = await _chat(session, chat_id, by)
    await settle_team_messages(session, chat)
    rows = (
        await session.exec(
            select(AiChatMessage)
            .where(AiChatMessage.chat_id == chat.id)
            .order_by(col(AiChatMessage.created_at))
        )
    ).all()
    return {**chat_out(chat), "messages": [msg_out(m) for m in rows], "drafts": []}


async def update_chat(
    session: AsyncSession, chat_id: str, by: str, data: dict[str, Any]
) -> AiChat:
    """Change what a chat is about, include a page for it, or pick who answers."""
    chat = await _chat(session, chat_id, by)
    if (
        data.get("scope")
        and data["scope"] != chat.scope
        or (data.get("ticket_id") or data.get("doc_id"))
    ):
        scope = data.get("scope") or chat.scope
        if scope not in SCOPES:
            raise AssistError("invalid", "Unknown scope.")
        scope_id = data.get("ticket_id") or data.get("doc_id")
        if scope in ("ticket", "doc", "idea"):
            _pid, title = await _target(session, scope, scope_id)
            session.add(
                AiChatMessage(
                    chat_id=chat.id,
                    role="note",
                    text=f"Now about {title}",
                    state="done",
                    finished_at=now_iso(),
                )
            )
        chat.scope, chat.scope_id = scope, scope_id
        chat.ticket_id = scope_id if scope == "ticket" else None
        chat.doc_id = scope_id if scope == "doc" else None
    if data.get("include_doc"):
        chat.include_docs = json.dumps(
            sorted({*loads(chat.include_docs, []), data["include_doc"]})
        )
    if "member_id" in data:
        chat.member_id = data["member_id"]
    chat.updated_at = now_iso()
    session.add(chat)
    await session.commit()
    return chat


async def mark_seen(session: AsyncSession, chat_id: str, by: str) -> None:
    """The owner has this chat open and in front of them now (the page tells every ~15 s)."""
    chat = await _chat(session, chat_id, by)
    chat.seen_at = now_iso()
    session.add(chat)
    await session.commit()


async def delete_chat(session: AsyncSession, chat_id: str, by: str) -> None:
    """Delete a chat, its messages and its conversation."""
    chat = await _chat(session, chat_id, by)
    for m in (
        await session.exec(
            select(AiChatMessage).where(AiChatMessage.chat_id == chat.id)
        )
    ).all():
        task = TASKS.get(m.id)
        if task is not None:
            task.cancel()
        await session.delete(m)
    await session.delete(chat)
    await session.commit()
    await sessions.forget(sessions.chat_name(chat_id))


async def send(
    session: AsyncSession,
    chat_id: str,
    by: str,
    text: str,
    *,
    doc_ids: list[str] | None = None,
    mode: str = "ask",
    files: list[tuple[str, bytes]] | None = None,
    skill: str = "board-ask",
    extra: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Ask in a chat: the question and an answer that is being written (poll it) come back."""
    chat = await _chat(session, chat_id, by)
    text = (text or "").strip()
    if not text:
        raise AssistError("invalid", "Write a question first.")
    if len(text) > MAX_TEXT:
        raise AssistError("too_large", f"Keep the message under {MAX_TEXT} characters.")
    if not await svc_settings.feature_on(
        session, "sketch" if skill == "sketch-ask" else "chat"
    ):
        raise AssistError("feature_off", "Ask AI is off in Settings › AI.")
    busy = (
        await session.exec(
            select(func.count())
            .select_from(AiChatMessage)
            .where(
                AiChatMessage.chat_id == chat.id, col(AiChatMessage.state).in_(ACTIVE)
            )
        )
    ).one()
    if busy:
        raise AssistError("conflict", "The assistant is still answering in this chat.")
    info = await engine.ready(chat.project_id)
    if info["state"] != "ready":
        raise AssistError("not_configured", info["message"])
    first = (
        await session.exec(
            select(func.count())
            .select_from(AiChatMessage)
            .where(AiChatMessage.chat_id == chat.id, AiChatMessage.role == "user")
        )
    ).one() == 0
    user = AiChatMessage(
        chat_id=chat.id, role="user", text=text, state="done", finished_at=now_iso()
    )
    ai = AiChatMessage(
        chat_id=chat.id,
        role="ai",
        state="thinking",
        context=json.dumps(
            {
                "scope": chat.scope,
                "label": chat.title,
                "request": {
                    "doc_ids": doc_ids or [],
                    "mode": mode,
                    "skill": skill,
                    "extra": extra or {},
                },
            }
        ),
    )
    if first and chat.title in ("New chat", ""):
        chat.title = " ".join(text.split())[:60]
    chat.updated_at = now_iso()
    team = (
        await ticket_team(session, chat.scope_id)
        if chat.scope == "ticket" and chat.scope_id and not files
        else None
    )
    if team:
        ai.member_id = team["id"]  # the team's lead answers, not the board's assistant
    session.add_all([user, ai, chat])
    await session.commit()
    await session.refresh(user)
    await session.refresh(ai)
    if team:
        from services.ai import runs as ai_runs

        sent = await ai_runs.deliver_to_ticket(
            chat.scope_id,
            TEAM_NOTE.format(by=by, mid=ai.id, text=text),
            by=by,
        )
        ai.context = json.dumps(
            {
                "scope": chat.scope,
                "label": chat.title,
                "team": team["name"],
                "delivered": sent,
            }
        )
        session.add(ai)
        await session.commit()
        await session.refresh(ai)
    else:
        spawn(ai.id, by, files=files)
    return {"user": msg_out(user), "ai": msg_out(ai)}


def spawn(
    message_id: str, by: str, *, files: list[tuple[str, bytes]] | None = None
) -> None:
    """Write an answer in the background."""
    task = asyncio.create_task(_answer(message_id, by, files))
    TASKS[message_id] = task
    task.add_done_callback(
        lambda t: TASKS.pop(message_id, None) if TASKS.get(message_id) is t else None
    )


async def _answer(
    message_id: str, by: str, files: list[tuple[str, bytes]] | None
) -> None:
    async with database.async_session() as session:
        ai = await session.get(AiChatMessage, message_id)
        chat = await session.get(AiChat, ai.chat_id) if ai else None
        if ai is None or chat is None:
            return
        question = (
            await session.exec(
                select(AiChatMessage)
                .where(
                    AiChatMessage.chat_id == chat.id,
                    AiChatMessage.role == "user",
                    col(AiChatMessage.created_at) <= ai.created_at,
                )
                .order_by(col(AiChatMessage.created_at).desc())
                .limit(1)
            )
        ).first()
        request = loads(ai.context, {}).get("request") or {}
        skill = request.get("skill") or "board-ask"
        inputs: dict[str, Any] = {
            "question": question.text if question else "",
            "project_id": chat.project_id,
            "scope": chat.scope,
            "ticket_id": chat.ticket_id,
            "page_id": chat.doc_id,
            "idea_id": chat.scope_id if chat.scope == "idea" else None,
            "sketch_id": chat.scope_id if chat.scope == "sketch" else None,
            "also_read_pages": [
                *loads(chat.include_docs, []),
                *(request.get("doc_ids") or []),
            ]
            or None,
            **(request.get("extra") or {}),
        }
        project_id, chat_id, ticket_id = chat.project_id, chat.id, chat.ticket_id
    state, error = "done", {}
    out: engine.Turn | None = None
    started = now_iso()
    try:
        out = await engine.turn(
            project_id,
            name=sessions.chat_name(chat_id),
            skill=skill,
            inputs=inputs,
            by=by,
            feature="sketch" if skill == "sketch-ask" else "chat",
            schema=True if skill == "sketch-ask" else None,
            ticket_id=ticket_id,
            files=files,
            on_run=lambda run_id: RUNS.__setitem__(message_id, run_id),
        )
        if out.state == "cancelled":
            state = "stopped"
        elif out.state != "finished":
            state, error = (
                "error",
                {
                    "code": "unavailable",
                    "message": out.error or "Claude Code did not answer.",
                },
            )
    except asyncio.CancelledError:
        state = "stopped"
    except AssistError as exc:
        state, error = "error", {"code": exc.code, "message": str(exc)}
    except Exception as exc:  # noqa: BLE001 - an answer that fails says so in the chat
        logger.exception("chat answer %s failed", message_id)
        state, error = (
            "error",
            {"code": "error", "message": f"Couldn't answer ({type(exc).__name__})."},
        )
    finally:
        RUNS.pop(message_id, None)
    async with database.async_session() as session:
        ai = await session.get(AiChatMessage, message_id)
        if ai is None:
            return
        ai.state, ai.error, ai.finished_at = state, json.dumps(error), now_iso()
        if out is not None:
            data = out.data() if skill == "sketch-ask" else {}
            ai.text = (data.get("answer") if data else None) or out.text or ai.text
            ai.cost, ai.tokens_in, ai.tokens_out, ai.model, ai.metered = (
                out.cost,
                out.tokens_in,
                out.tokens_out,
                out.model,
                False,
            )
            ctx = loads(ai.context, {})
            try:
                changes = await receipt.collect(
                    session, None, out.run_id, since=started
                )
                merged = receipt.merge(ctx.get("receipt"), changes, out.run_id)
            except Exception:  # noqa: BLE001 - a receipt that cannot be read must not lose the answer
                logger.exception("receipt of %s could not be read", message_id)
                merged = ctx.get("receipt")
            if merged:
                ctx["receipt"] = merged
            else:
                ctx.pop("receipt", None)
            ai.context = json.dumps(ctx)
            ideas = [str(i) for i in (data.get("ideas") or []) if str(i).strip()][:8]
            if ideas and state == "done":
                turn_info = (request.get("extra") or {}).get("canvas") or {}
                draft = drafts.new(
                    project_id,
                    "sketch",
                    by,
                    {
                        "result": {
                            "kind": "proposal",
                            "ops": [],
                            "dropped": 0,
                            "note": "",
                            "layer": "AI",
                            "width": turn_info.get("w") or 1,
                            "height": turn_info.get("h") or 1,
                            "ideas": ideas,
                            "added": [],
                        }
                    },
                    chat_message_id=ai.id,
                    member_name=out.member,
                )
                draft["status"] = "open"
                ai.draft_id = draft["id"]
            if out.files and question is not None:
                asked = await session.get(AiChatMessage, question.id)
                if asked is not None:
                    qctx = loads(asked.context, {})
                    from pathlib import Path

                    names = [Path(f).name for f in out.files]
                    canvas = (request.get("extra") or {}).get("canvas") or {}
                    qctx["turn"] = {
                        "id": out.run_id,
                        "canvas": {
                            "w": canvas.get("w") or 1,
                            "h": canvas.get("h") or 1,
                            "title": canvas.get("title") or "",
                        },
                        "picture": {
                            "width": 0,
                            "height": 0,
                            "bytes": 0,
                            "file": "canvas.png",
                        }
                        if "canvas.png" in names
                        else None,
                        "attachments": [
                            {
                                "id": n,
                                "name": n,
                                "kind": "image"
                                if n.lower().endswith(
                                    (".png", ".jpg", ".jpeg", ".webp", ".gif")
                                )
                                else "text",
                                "mime": "",
                                "file": n,
                                "bytes": 0,
                                "width": 0,
                                "height": 0,
                                "chars": 0,
                            }
                            for n in names
                            if n != "canvas.png"
                        ],
                    }
                    asked.context = json.dumps(qctx)
                    session.add(asked)
            chat = await session.get(AiChat, ai.chat_id)
            if chat is not None:
                chat.cost = round(chat.cost + out.cost, 6)
                chat.tokens += out.tokens_in + out.tokens_out
                chat.session_id = out.session_id or chat.session_id
                chat.updated_at = now_iso()
                session.add(chat)
        session.add(ai)
        await session.commit()
    await board_events.publish(board_events.INVALIDATE)


async def get_message(
    session: AsyncSession, message_id: str, by: str
) -> dict[str, Any]:
    """One message of the person's own chat."""
    m, _chat_row = await _message(session, message_id, by)
    return msg_out(m)


async def undo_receipt(
    session: AsyncSession, message_id: str, by: str
) -> dict[str, Any]:
    """Put back what an answer changed ("Undo all"): the changes of its receipt, newest first. A change someone else
    has since overwritten is left as it is and named in `receipt.undo.skipped`."""
    m, _chat_row = await _message(session, message_id, by)
    ctx = loads(m.context, {})
    rec = ctx.get("receipt")
    if not rec or not rec.get("applied"):
        raise AssistError("not_found", "This answer changed nothing.")
    before = rec.get("undo") or {}
    if rec.get("status") == "undone" and not before.get("skipped"):
        raise AssistError("conflict", "These changes were already put back.")
    if m.id in UNDOING:
        raise AssistError("conflict", "Undo is already running.")
    UNDOING.add(m.id)
    try:
        already = set(before.get("put_back") or [])
        result = await receipt.undo(
            session, rec["applied"], rec.get("runs") or [], already
        )
    finally:
        UNDOING.discard(m.id)
    result["put_back"] = sorted(already | set(result["put_back"]))
    result["undone"] = len(result["put_back"])
    rec["status"] = "undone" if result["undone"] else "done"
    rec["undo"] = result
    ctx["receipt"] = rec
    m.context = json.dumps(ctx)
    session.add(m)
    await session.commit()
    await board_events.publish(board_events.INVALIDATE)
    return msg_out(m)


async def set_feedback(
    session: AsyncSession, message_id: str, by: str, thumb: str | None, reason: str
) -> dict[str, Any]:
    """Keep (or clear) the asker's thumbs up or down on an answer."""
    m, _chat_row = await _message(session, message_id, by)
    if thumb not in (None, "up", "down"):
        raise AssistError("invalid", "Thumbs up or down.")
    m.feedback = json.dumps(
        {"thumb": thumb, "reason": (reason or "")[:500], "at": now_iso()}
        if thumb
        else {}
    )
    session.add(m)
    await session.commit()
    return msg_out(m)


async def stop(session: AsyncSession, message_id: str, by: str) -> dict[str, Any]:
    """Stop an answer that is being written."""
    m, _chat_row = await _message(session, message_id, by)
    if m.state in ACTIVE:
        run_id = RUNS.get(message_id)
        if run_id:
            engine.cancel(run_id)
        else:
            task = TASKS.get(message_id)
            if task is not None:
                task.cancel()
        m.state, m.finished_at = "stopped", now_iso()
        session.add(m)
        await session.commit()
    return msg_out(m)


async def retry(
    session: AsyncSession, message_id: str, by: str, *, continue_: bool = False
) -> dict[str, Any]:
    """Try again: the same question is answered again into this message."""
    m, _chat_row = await _message(session, message_id, by)
    if m.role != "ai":
        raise AssistError("invalid", "Only an answer can be tried again.")
    if m.state in ACTIVE:
        return msg_out(m)
    info = await engine.ready(_chat_row.project_id)
    if info["state"] != "ready":
        raise AssistError("not_configured", info["message"])
    m.state, m.error, m.finished_at = "thinking", "{}", None
    if not continue_:
        m.text = ""
    session.add(m)
    await session.commit()
    spawn(m.id, by)
    return msg_out(m)


async def post_as_comment(
    session: AsyncSession, message_id: str, by: str, text: str | None = None
) -> dict[str, Any]:
    """ "Post as comment": share a ticket chat's answer with the team, as a comment with the AI badge."""
    m, chat = await _message(session, message_id, by)
    if m.role != "ai" or m.state != "done":
        raise AssistError("invalid", "Only a finished answer can be posted.")
    if not chat.ticket_id:
        raise AssistError("invalid", "This chat is not about a ticket.")
    body = (text or m.text or "").strip()
    if not body:
        raise AssistError("invalid", "There is nothing to post.")
    ticket = await svc_tickets.add_comment(
        session,
        chat.ticket_id,
        body,
        author=by,
        meta={"ai": {"member": "Board AI", "chat_message_id": m.id, "posted_by": by}},
    )
    if ticket is None:
        raise AssistError("not_found", "Ticket not found.")
    comment_id = (loads(ticket.comments, []) or [{}])[-1].get("id")
    ctx = loads(m.context, {})
    ctx["posted"] = {"comment_id": comment_id, "at": now_iso(), "by": by}
    m.context = json.dumps(ctx)
    session.add(m)
    await session.commit()
    await board_events.publish(board_events.INVALIDATE)
    return {"comment_id": comment_id, "ticket_id": chat.ticket_id}


async def recover() -> None:
    """At start: answers that were being written when the board stopped are marked so (Try again answers them)."""
    async with database.async_session() as session:
        rows = (
            await session.exec(
                select(AiChatMessage).where(col(AiChatMessage.state).in_(ACTIVE))
            )
        ).all()
        for m in rows:
            m.state, m.finished_at = "error", now_iso()
            m.error = json.dumps(
                {
                    "code": "unavailable",
                    "message": "The board restarted while this was being written. Try again.",
                }
            )
            session.add(m)
        if rows:
            await session.commit()
